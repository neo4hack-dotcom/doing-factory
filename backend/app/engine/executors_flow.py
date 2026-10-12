"""Flow step executors (SPEC §5): human_form, approval, estimation, fan_out, notify, wait_for.

Like the AI executors, everything here takes a StepCtx and returns a StepOutcome (or a plain
value for the helpers); none of it writes the project document — the engine applies outcomes
under the project lock. Human steps have two halves:

- `activate(sc)` (sync) says which waiting state the step enters;
- `assist(sc)` (async, run by the engine in the background) asks the AI for the step's helper
  — a form draft, an estimate suggestion, an approver brief — whose result the engine merges
  without overwriting what a person typed meanwhile.

Field coercion lives here too: the same FieldDef rules type form submissions, AI drafts and a
blueprint's project inputs.
"""
from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any

from pydantic import ValidationError

from app.engine import executors_ai
from app.engine.blueprint import project_role_users, role_holders
from app.engine.context import StepCtx, StepOutcome, fail, ok
from app.engine.templating import condition, evaluate, render, render_obj
from app.errors import FactoryError, TemplateError
from app.models import (Estimate, FanOutConfig, FieldDef, HumanFormConfig, NotifyConfig, OperationResult,
                        WaitForConfig)
from app.util import now_iso, parse_iso, truncate

if TYPE_CHECKING:  # pragma: no cover
    from app.deps import Container

HUMAN_TYPES = ("human_form", "approval", "estimation", "wait_for")
CLOSED_PROJECT = ("done", "cancelled")
TROUBLED_PROJECT = ("failed", "blocked")

# ---------------------------------------------------------------------------
# Field values (FieldDef typing)
# ---------------------------------------------------------------------------

_TRUE = {"true", "yes", "y", "1", "on", "x", "checked"}
_FALSE = {"false", "no", "n", "0", "off", "", "unchecked"}
_LIST_MARKER = re.compile(r"^\s*(?:[-*•]|\d+[.)])\s+")
_NUMBER = re.compile(r"-?\d+(?:[.,]\d+)?")
_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}")


def is_empty(value: Any) -> bool:
    if value is None:
        return True
    if isinstance(value, str):
        return not value.strip()
    if isinstance(value, (list, tuple, dict, set)):
        return len(value) == 0
    return False


def empty_value(field_type: str) -> Any:
    if field_type in ("list", "multiselect", "users"):
        return []
    if field_type == "checkbox":
        return False
    if field_type == "number":
        return None
    return ""


def _lines(value: Any, *, commas: bool = False) -> list[str]:
    if isinstance(value, (list, tuple, set)):
        items = [json.dumps(v, ensure_ascii=False) if isinstance(v, (dict, list)) else str(v) for v in value]
    else:
        text = str(value)
        items = re.split(r"[\n,;]" if commas else r"\n", text)
    return [_LIST_MARKER.sub("", item).strip() for item in items if _LIST_MARKER.sub("", item).strip()]


def _find_user(container: "Container", value: Any) -> str:
    wanted = str(value or "").strip()
    if not wanted:
        return ""
    if container.get_user(wanted) is not None:
        return wanted
    by_email = container.user_by_email(wanted)
    if by_email is not None:
        return by_email["id"]
    lowered = wanted.lower()
    return next((u["id"] for u in container.users() if (u.get("name") or "").strip().lower() == lowered), "")


def _find_team(container: "Container", value: Any) -> str:
    wanted = str(value or "").strip()
    if not wanted:
        return ""
    if container.get_team(wanted) is not None:
        return wanted
    lowered = wanted.lower()
    return next((t["id"] for t in container.teams() if (t.get("name") or "").strip().lower() == lowered), "")


def coerce_field(container: "Container", field: FieldDef | dict, value: Any, *, strict: bool = True) -> Any:
    """Type `value` for `field`. strict (human input): an invalid value raises ValueError with a
    message for the person. Lenient (AI drafts): an invalid value becomes the field's empty value."""
    f = field if isinstance(field, FieldDef) else FieldDef.model_validate(field)
    kind = f.type

    def bad(message: str) -> Any:
        if strict:
            raise ValueError(message)
        return empty_value(kind)

    if value is None:
        return empty_value(kind)
    if kind == "number":
        if isinstance(value, bool):
            return bad("expects a number")
        if isinstance(value, (int, float)):
            number = float(value)
        else:
            text = str(value).strip()
            if not text:
                return None
            try:
                number = float(text.replace(",", "."))
            except ValueError:
                match = None if strict else _NUMBER.search(text)
                if match is None:
                    return bad(f"expects a number, got '{truncate(text, 40)}'")
                number = float(match.group(0).replace(",", "."))
        return int(number) if number.is_integer() else number
    if kind == "checkbox":
        if isinstance(value, bool):
            return value
        if isinstance(value, (int, float)):
            return bool(value)
        text = str(value).strip().lower()
        if text in _TRUE:
            return True
        if text in _FALSE:
            return False
        return bad(f"expects yes or no, got '{truncate(str(value), 40)}'")
    if kind == "list":
        return _lines(value) if not isinstance(value, dict) else [json.dumps(value, ensure_ascii=False)]
    if kind == "multiselect":
        items = _lines(value, commas=True) if not isinstance(value, dict) else []
        if f.options:
            by_lower = {o.lower(): o for o in f.options}
            unknown = [i for i in items if i.lower() not in by_lower]
            if unknown and strict:
                raise ValueError(f"'{unknown[0]}' is not one of the options")
            items = [by_lower[i.lower()] for i in items if i.lower() in by_lower]
        return items
    if kind == "users":
        ids = []
        for item in _lines(value, commas=True):
            uid = _find_user(container, item)
            if not uid:
                if strict:
                    raise ValueError(f"unknown user '{item}'")
                continue
            if uid not in ids:
                ids.append(uid)
        return ids
    if kind == "user":
        uid = _find_user(container, value)
        return uid if uid or not str(value).strip() else bad(f"unknown user '{value}'")
    if kind == "team":
        tid = _find_team(container, value)
        return tid if tid or not str(value).strip() else bad(f"unknown team '{value}'")

    # text-like: text, textarea, markdown, select, date, url
    if isinstance(value, (list, tuple)):
        text = "\n".join(f"- {v}" for v in value) if kind in ("textarea", "markdown") else ", ".join(map(str, value))
    elif isinstance(value, dict):
        text = json.dumps(value, ensure_ascii=False)
    elif isinstance(value, bool):
        text = "Yes" if value else "No"
    else:
        text = str(value)
    text = text.strip()
    if not text:
        return ""
    if kind == "select" and f.options and text not in f.options:
        match = next((o for o in f.options if o.lower() == text.lower()), None)
        return match if match is not None else bad(f"'{truncate(text, 40)}' is not one of: {', '.join(f.options)}")
    if kind == "date":
        return text[:10] if _DATE.match(text) else bad(f"expects a date (YYYY-MM-DD), got '{truncate(text, 40)}'")
    if kind == "url" and not re.match(r"^https?://", text, re.I):
        return bad("expects an http(s) link")
    return text


def collect_values(container: "Container", fields: list[dict] | list[FieldDef], values: dict | None, *,
                   require: bool = True, keep_extra: bool = False) -> tuple[dict, list[str]]:
    """Every field typed (absent → its default, else its empty value), plus the list of problems
    ("Purpose & scope is required", "Tests executed: expects a number"). With `keep_extra`,
    keys that are not fields are kept as given (watcher-mapped project inputs)."""
    values = dict(values or {})
    out: dict[str, Any] = {}
    errors: list[str] = []
    known = set()
    for raw_field in fields:
        f = raw_field if isinstance(raw_field, FieldDef) else FieldDef.model_validate(raw_field)
        known.add(f.key)
        label = f.label or f.key
        raw = values[f.key] if f.key in values else f.default
        try:
            value = coerce_field(container, f, raw, strict=True)
        except ValueError as exc:
            errors.append(f"{label}: {exc}")
            continue
        if require and f.required and is_empty(value):
            errors.append(f"{label} is required")
        out[f.key] = value
    if keep_extra:
        out.update({k: v for k, v in values.items() if k not in known})
    return out, errors


def form_markdown(container: "Container", fields: list[dict], values: dict) -> str:
    """The submitted form as a readable Markdown artifact (labels, users by name)."""
    parts: list[str] = []
    for raw_field in fields:
        f = FieldDef.model_validate(raw_field)
        value = values.get(f.key)
        if f.type in ("user", "users"):
            ids = value if isinstance(value, list) else [value] if value else []
            value = ", ".join((container.get_user(i) or {}).get("name", i) for i in ids)
        elif f.type == "team" and value:
            value = (container.get_team(value) or {}).get("name", value)
        if f.type == "checkbox":
            shown = "Yes" if value else "No"
        elif isinstance(value, list):
            shown = "\n".join(f"- {v}" for v in value) or "—"
        elif is_empty(value):
            shown = "—"
        else:
            shown = str(value)
        multiline = f.type in ("textarea", "markdown", "list", "multiselect") or "\n" in shown
        parts.append(f"### {f.label or f.key}\n{shown}" if multiline else f"**{f.label or f.key}:** {shown}")
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# Human steps: activation and background AI assistance
# ---------------------------------------------------------------------------

def activate(sc: StepCtx) -> StepOutcome:
    """The waiting state a human step enters when the engine reaches it."""
    kind = sc.step.get("type")
    if kind == "human_form":
        return StepOutcome(status="waiting_human", summary="Waiting for the form to be completed", ai=False)
    if kind == "approval":
        return StepOutcome(status="waiting_approval", summary="Waiting for approval", ai=False)
    if kind == "estimation":
        unit = (sc.step.get("config") or {}).get("unit") or "days"
        current = sc.step.get("estimate") or {}
        return StepOutcome(status="waiting_human", summary="Waiting for an estimate", ai=False,
                           estimate={**current, "unit": current.get("unit") or unit})
    if kind == "wait_for":
        return StepOutcome(status="waiting_external", summary="Waiting for the external condition", ai=False)
    raise FactoryError(f"Step type {kind} is not a human or waiting step")


def assist_kind(step: dict) -> str:
    """The AI helper a human step runs in the background when it activates ("" = none)."""
    cfg = step.get("config") or {}
    kind = step.get("type")
    if kind == "human_form" and (cfg.get("ai_prefill") or "").strip():
        return "draft_form"
    if kind == "approval":
        return "approval_brief"
    if kind == "estimation" and cfg.get("ai_suggest", True):
        return "suggest_estimate"
    return ""


async def assist(sc: StepCtx, instructions: str = "") -> StepOutcome:
    """Run the step's AI helper. The outcome carries only the helper's fields (ai_draft + form
    candidates, estimate.ai_suggestion, brief); errors propagate to the engine, which records
    them on the step without failing it — a human step works without its AI helper."""
    kind = sc.step.get("type")
    status = sc.step.get("status") or "waiting_human"
    if kind == "human_form":
        draft = await executors_ai.draft_form(sc, instructions)
        if not isinstance(draft, dict):
            raise FactoryError("The AI draft is not a set of field values")
        fields = HumanFormConfig.model_validate(sc.step.get("config") or {}).fields
        typed = {f.key: coerce_field(sc.container, f, draft[f.key], strict=False) for f in fields if f.key in draft}
        typed = {k: v for k, v in typed.items() if not is_empty(v) or isinstance(v, bool)}
        return StepOutcome(status=status, ai_draft=typed, form=typed, summary=f"AI drafted {len(typed)} field(s)")
    if kind == "estimation":
        suggestion = await executors_ai.suggest_estimate(sc)
        try:
            parsed = Estimate.model_validate(suggestion or {})
        except ValidationError as exc:
            raise FactoryError(f"The AI estimate is not usable ({exc.errors()[0].get('msg', 'invalid')})") from exc
        if parsed.value is None:
            raise FactoryError("The AI estimate has no value")
        data = parsed.model_dump(exclude={"ai_suggestion", "submitted_by"})
        return StepOutcome(status=status, estimate={"ai_suggestion": data},
                           summary=f"AI suggests {data['value']:g} {data['unit']}")
    if kind == "approval":
        brief = await executors_ai.approval_brief(sc)
        if not isinstance(brief, str) or not brief.strip():
            raise FactoryError("The AI brief came back empty")
        return StepOutcome(status=status, brief=brief.strip(), summary="AI decision brief ready")
    raise FactoryError(f"No AI helper for a {kind} step")


# ---------------------------------------------------------------------------
# Audiences
# ---------------------------------------------------------------------------

def resolve_audience(container: "Container", project: dict, audience: list[dict]) -> list[str]:
    """[{role} | {project_role} | {user_id}] → active user ids (a role means every holder; the
    `sponsor` role means this project's sponsor when one is set)."""
    ids: list[str] = []
    for target in audience or []:
        target = target or {}
        if target.get("user_id"):
            ids.append(target["user_id"])
        if target.get("role"):
            ids += role_holders(container, project, target["role"], prefer_team=False)
        if target.get("project_role"):
            ids += project_role_users(container, project, target["project_role"])
    out: list[str] = []
    for uid in ids:
        user = container.get_user(uid)
        if user is not None and user.get("active", True) and uid not in out:
            out.append(uid)
    return out


# ---------------------------------------------------------------------------
# notify
# ---------------------------------------------------------------------------

async def exec_notify(sc: StepCtx) -> StepOutcome:
    """Resolve the audience, write the message (LLM when `prompt` is set, else the `body`
    template), send it in-app (+ the external channel when asked)."""
    cfg = NotifyConfig.model_validate(sc.step.get("config") or {})
    recipients = resolve_audience(sc.container, sc.project, [a.model_dump() for a in cfg.audience])
    if not recipients:
        sc.trace("The audience resolved to no active user — nothing was sent", kind="error")
        return ok({"subject": render(cfg.subject, sc.tctx).strip(), "recipients": []},
                  summary="Nobody to notify: the audience resolved to no active user")
    if cfg.prompt.strip():
        sc.trace(f"Writing the message for {len(recipients)} recipient(s)", kind="ai")
        subject, body = await executors_ai.compose_notification(sc, cfg.model_dump())
    else:
        subject, body = render(cfg.subject, sc.tctx), render(cfg.body, sc.tctx)
    subject = (subject or "").strip() or f"{sc.project.get('key', '')} · {sc.step.get('name', '')}".strip(" ·")
    external = cfg.channel in ("external", "both")
    await sc.container.notifier.notify(recipients, "info", subject, (body or "").strip(),
                                       project_id=sc.project.get("id", ""), step_id=sc.step.get("id", ""),
                                       external=external)
    names = [(sc.container.get_user(u) or {}).get("name", u) for u in recipients]
    sc.trace(f"Sent \"{subject}\" to {', '.join(names)}", kind="result", data={"recipients": recipients})
    return ok({"subject": subject, "recipients": recipients}, summary=f"Notified {len(recipients)}: {subject}")


# ---------------------------------------------------------------------------
# fan_out
# ---------------------------------------------------------------------------

def children_status(container: "Container", child_ids: list[str]) -> dict:
    """Live state of child projects: {children: [{id,key,title,status}], closed, troubled}.
    `closed` = every child done or cancelled (a deleted child no longer counts)."""
    children = []
    for cid in child_ids or []:
        child = container.store.get("projects", cid)
        if child is not None:
            children.append({"id": cid, "key": child.get("key", ""), "title": child.get("title", ""),
                             "status": child.get("status", "active")})
    return {"children": children,
            "closed": all(c["status"] in CLOSED_PROJECT for c in children),
            "troubled": [c for c in children if c["status"] in TROUBLED_PROJECT]}


async def exec_fan_out(sc: StepCtx) -> StepOutcome:
    """One child project per item. Idempotent: a child already started for an item (an earlier
    attempt, or a reopened step) is reused, never duplicated."""
    container, project, step = sc.container, sc.project, sc.step
    cfg = FanOutConfig.model_validate(step.get("config") or {})
    items = evaluate(cfg.items, sc.tctx, strict=True)
    if items is None:
        items = []
    if isinstance(items, (str, bytes, dict)) or not isinstance(items, (list, tuple)):
        return fail(f"Fan-out items must be a list — `{cfg.items}` gave {type(items).__name__}", retryable=False)
    if not items:
        sc.trace("No items — no child project to start", kind="result")
        return ok({"children": []}, summary="No items — nothing to start")
    blueprint = container.get_blueprint_by_key(cfg.blueprint_key) or container.get_blueprint(cfg.blueprint_key)
    if blueprint is None:
        return fail(f"Child blueprint '{cfg.blueprint_key}' not found — fix the fan-out step or restore the "
                    "blueprint in Studio › Blueprints", retryable=False)

    existing = {(p.get("source") or {}).get("external_id"): p for p in container.store.list("projects")
                if p.get("parent_id") == project["id"] and p.get("parent_step_id") == step["id"]}
    inherit = set(cfg.inherit)
    children = []
    for index, item in enumerate(items):
        ref = f"{step['id']}:{index}"
        child = existing.get(ref)
        if child is None:
            ctx = {**sc.tctx, "item": item}
            title = render(cfg.title, ctx).strip() if cfg.title else ""
            title = title or f"{blueprint.get('name', 'Child')} {index + 1}"
            inputs = render_obj(cfg.inputs, ctx)
            child = await container.engine.create_project(
                blueprint["id"], title=title,
                description=f"Started by {project.get('key', '')} — {project.get('title', '')} ({step.get('name', '')}).",
                inputs=inputs,
                priority=project.get("priority", "medium") if "priority" in inherit else "medium",
                sponsor_id=project.get("sponsor_id", "") if "sponsor" in inherit else "",
                owner_id=project.get("owner_id", "") if "owner" in inherit else "",
                team_id=project.get("team_id", "") if "team" in inherit else "",
                source={"type": "fan_out", "external_id": ref,
                        "raw": item if isinstance(item, dict) else {"value": item}},
                parent_id=project["id"], parent_step_id=step["id"], created_by=sc.user_id)
            sc.trace(f"Started {child.get('key')} · {title}", kind="result", data={"project_id": child["id"]})
        children.append({"id": child["id"], "key": child.get("key", ""), "title": child.get("title", ""),
                         "status": child.get("status", "active")})
    output = {"children": children}
    if cfg.wait == "none":
        return ok(output, summary=f"Started {len(children)} child project(s)")
    return StepOutcome(status="waiting_children", output=output,
                       summary=f"Waiting for {len(children)} child project(s)")


# ---------------------------------------------------------------------------
# wait_for
# ---------------------------------------------------------------------------

def _timed_out(step: dict, hours: float, now: datetime) -> bool:
    started = parse_iso(step.get("started_at"))
    return bool(hours and hours > 0 and started is not None and now >= started + timedelta(hours=hours))


async def poll_wait_for(sc: StepCtx) -> StepOutcome:
    """One poll: run the operation, test `until` over its output. → done (condition met),
    waiting_external (not yet / transient error, recorded on the step) or failed (timeout,
    misconfiguration)."""
    cfg = WaitForConfig.model_validate(sc.step.get("config") or {})
    now = datetime.now(timezone.utc)
    timed_out = _timed_out(sc.step, cfg.timeout_hours, now)
    op = sc.container.get_operation_by_key(cfg.operation_key)
    if op is None:
        return fail(f"Operation '{cfg.operation_key}' not found — create it in Studio › Operations (or install the "
                    "sandbox demo), then press Retry", retryable=False)
    try:
        op_input = render_obj(cfg.input, sc.tctx)
    except TemplateError as exc:
        return fail(exc.message, retryable=False)
    error, output = "", None
    try:
        result = await sc.container.ops.run(op, op_input, ctx=sc.tctx, project_id=sc.project.get("id", ""),
                                            step_id=sc.step.get("id", ""), autonomy=sc.autonomy, trace=sc.trace)
        res = result if isinstance(result, OperationResult) else OperationResult.model_validate(result or {})
        if res.ok and res.summary == "needs_confirmation":
            error = f"Operation '{cfg.operation_key}' asks for a confirmation — a wait step needs a read-only operation"
        elif res.ok:
            output = res.output
        else:
            error = res.error or f"Operation '{cfg.operation_key}' failed"
    except FactoryError as exc:
        error = exc.message
    if error:
        if timed_out:
            return fail(f"Timed out after {cfg.timeout_hours:g} h; last check failed: {error}", retryable=False)
        return StepOutcome(status="waiting_external", error=error, summary=f"Last check failed: {truncate(error, 160)}")
    try:
        met = condition(cfg.until, {**sc.tctx, "output": output})
    except TemplateError as exc:
        return fail(exc.message, retryable=False)
    if met:
        return ok(output, summary=f"Condition met: {cfg.until}" if cfg.until else "Checked")
    if timed_out:
        return fail(f"Timed out after {cfg.timeout_hours:g} h — `{cfg.until}` never became true", retryable=False)
    return StepOutcome(status="waiting_external", output=output, summary=f"Waiting until {cfg.until} (checked {now_iso()})")
