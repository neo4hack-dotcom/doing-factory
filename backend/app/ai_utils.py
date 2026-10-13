"""One-shot AI utilities behind /api/ai/*, /api/briefing and the project/admin AI actions
(SPEC §9, §12). Every function takes the container first.

Each one builds its facts deterministically from the store, hands them to the LLM with a
library prompt, and returns the model's text or a validated draft. Grounding is the rule:
the facts block is all the model knows, and a draft the model produces (blueprint,
operation) is normalised and checked against what really exists (roles, tools, operations)
before anyone sees it.

Only the morning briefing has a no-LLM answer, because Home must render without a model: a
deterministic summary of the same facts, returned with `ai: false` and labelled as such.
Everything else raises LLMNotConfigured / LLMError, which the API turns into a 424 / 502
with a message that names the fix.
"""
from __future__ import annotations

import json
import logging
import re
import time
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from pydantic import ValidationError

from app import inbox as inbox_mod
from app import risk as risk_mod
from app.engine import blueprint as blueprint_engine
from app.errors import FactoryError, LLMError, NotConfigured, NotFound
from app.models import STEP_CONFIG_MODELS, Blueprint, FieldDef, Operation, ReportAudience, RewriteStyle
from app.util import now_iso, slugify, truncate, validation_message

if TYPE_CHECKING:  # pragma: no cover
    from app.deps import Container

log = logging.getLogger("factory.ai_utils")

REWRITE_STYLES: tuple[str, ...] = RewriteStyle.__args__   # type: ignore[attr-defined]
AUDIENCES: tuple[str, ...] = ReportAudience.__args__       # type: ignore[attr-defined]
MAX_REWRITE_CHARS = 20_000
BRIEFING_TTL_S = 600
STEP_TYPES: tuple[str, ...] = tuple(STEP_CONFIG_MODELS)
TONES = {"zinc", "brand", "emerald", "sky", "amber", "rose", "violet", "indigo", "cyan", "fuchsia", "pink",
         "orange", "teal"}
FIELD_TYPES = {"text", "textarea", "markdown", "number", "select", "multiselect", "date", "user", "users", "team",
               "checkbox", "list", "url"}
PROJECT_ROLES = {"", "sponsor", "owner", "team_lead", "team"}
# Words a model uses for a step type it should have spelled exactly.
_TYPE_ALIASES = {"ai": "ai_task", "llm": "ai_task", "task": "ai_task", "form": "human_form", "human": "human_form",
                 "approve": "approval", "signoff": "approval", "sign_off": "approval", "estimate": "estimation",
                 "mcp": "mcp_operation", "operation": "mcp_operation", "agent": "agent_task", "gate": "quality_gate",
                 "compliance": "quality_gate", "fanout": "fan_out", "notification": "notify", "email": "notify",
                 "wait": "wait_for"}
_FENCED = re.compile(r"^```[a-zA-Z]*\n(.*)\n```$", re.DOTALL)

# Morning briefings, per (database, user): an LLM call per Home visit would make Home slow.
_briefings: dict[tuple[str, str], tuple[float, dict]] = {}


# =====================================================================================
# Facts
# =====================================================================================

def _project(c: "Container", pid: str) -> dict:
    project = c.store.get("projects", pid) if pid else None
    if project is None:
        raise NotFound(f"Project {pid} not found")
    return project


def _names(c: "Container") -> dict[str, str]:
    return {u["id"]: u.get("name") or u["id"] for u in c.users()}


def project_facts(c: "Container", project: dict, *, limit: int | None = None) -> str:
    """Everything a report or an explanation may say about a project, as plain text: identity,
    people, every stage and step with status and result, approvals, links, risk, recent
    activity. Capped at `engine.context_chars` × 2 so it fits a small model's window."""
    names = _names(c)
    teams = {t["id"]: t.get("name") or t["id"] for t in c.teams()}
    risk = project.get("risk") or {}
    steps = [s for st in project.get("stages") or [] for s in st.get("steps") or []]
    finished = sum(s.get("status") in ("done", "skipped") for s in steps)
    current = next((s.get("name") for s in project.get("stages") or []
                    if s.get("id") == project.get("current_stage_id")), "")
    lines = [
        f"Project {project.get('key') or project.get('id')} — {project.get('title')}",
        f"Status: {project.get('status')} · priority {project.get('priority')} · blueprint "
        f"{project.get('blueprint_name') or '?'} · current stage: {current or 'n/a'} · "
        f"progress {finished}/{len(steps)} steps",
        f"Sponsor: {names.get(project.get('sponsor_id') or '', 'not set')} · Owner: "
        f"{names.get(project.get('owner_id') or '', 'not set')} · Team: {teams.get(project.get('team_id') or '', 'not set')}",
        f"Created {(project.get('created_at') or '')[:10]} · due {project.get('due_date') or 'not set'}"
        + (f" · completed {project['completed_at'][:10]}" if project.get("completed_at") else ""),
    ]
    if project.get("description"):
        lines.append(f"Description: {truncate(project['description'], 800)}")
    lines.append(f"Risk: score {risk.get('score', 0)}/100 ({risk.get('level') or 'low'})"
                 + (": " + "; ".join(risk.get("reasons") or []) if risk.get("reasons") else ""))
    lines.append("Stages:")
    for stage in project.get("stages") or []:
        lines.append(f"- {stage.get('name')} [{stage.get('status')}]")
        for step in stage.get("steps") or []:
            bits = [f"  - {step.get('name')} ({step.get('type')}): {step.get('status')}"]
            if step.get("assignee_user_ids"):
                bits.append("assigned to " + ", ".join(names.get(u, u) for u in step["assignee_user_ids"]))
            if step.get("due_at") and step.get("status") not in ("done", "skipped"):
                bits.append(f"due {step['due_at'][:16]}" + (" (SLA breached)" if step.get("sla_breached") else ""))
            if step.get("output_summary"):
                bits.append(f"result: {truncate(step['output_summary'], 160)}")
            if step.get("error"):
                bits.append(f"error: {truncate(step['error'], 160)}")
            for approval in step.get("approvals") or []:
                bits.append(f"{approval.get('decision')} by {names.get(approval.get('user_id'), approval.get('user_id'))}"
                            f" ({approval.get('role')})"
                            + (f": {truncate(approval.get('comment'), 100)}" if approval.get("comment") else ""))
            if step.get("estimate") and (step["estimate"] or {}).get("value") is not None:
                est = step["estimate"]
                bits.append(f"estimate {est.get('value')} {est.get('unit')} ({est.get('confidence')} confidence)")
            lines.append(" · ".join(bits))
    if project.get("links"):
        lines.append("Links: " + "; ".join(f"{l.get('label') or l.get('external_id')} {l.get('url') or ''}".strip()
                                           for l in project["links"]))
    if project.get("child_ids"):
        children = [c.store.get("projects", cid) for cid in project["child_ids"]]
        lines.append("Child projects: " + "; ".join(f"{ch.get('key')} {ch.get('title')} [{ch.get('status')}]"
                                                    for ch in children if ch))
    events = c.store.list_events(project_id=project.get("id"), limit=12)
    if events:
        lines.append("Recent activity (newest first):")
        lines += [f"- {e.get('ts', '')[:16]} {truncate(e.get('message'), 160)}" for e in events]
    cap = limit or max(2000, c.app_settings().engine.context_chars * 2)
    return truncate("\n".join(lines), cap)


def _strip_wrapping(text: str, original: str) -> str:
    """A model sometimes fences or quotes its whole answer; the original text was neither."""
    out = text.strip()
    match = _FENCED.match(out)
    if match and not original.strip().startswith("```"):
        out = match.group(1).strip()
    if len(out) > 1 and out[0] == out[-1] and out[0] in "\"'" and original.strip()[:1] not in "\"'":
        out = out[1:-1].strip()
    return out


# =====================================================================================
# Rewrite, reports, risk, summary
# =====================================================================================

async def rewrite(container: "Container", text: str, style: str, instructions: str = "") -> str:
    """The ✨ menu: `text` rewritten in `style` (see the `rewriter` prompt), facts untouched."""
    source = text or ""
    if not source.strip():
        raise FactoryError("Nothing to rewrite — the text is empty.", 422)
    if len(source) > MAX_REWRITE_CHARS:
        raise FactoryError(f"The text is too long to rewrite ({len(source)} characters, max {MAX_REWRITE_CHARS}).", 422)
    if style not in REWRITE_STYLES:
        raise FactoryError(f"Unknown style '{style}'. Use one of: {', '.join(REWRITE_STYLES)}.", 422)
    request = f"Style: {style}\n"
    if (instructions or "").strip():
        request += f"Extra instructions: {instructions.strip()}\n"
    request += f"\nText to rewrite:\n{source}"
    result = await container.ai.ask("rewriter", request, prompt_key="rewriter", fast=True)
    return _strip_wrapping(str(result), source)


async def project_report(container: "Container", pid: str, audience: str) -> str:
    if audience not in AUDIENCES:
        raise FactoryError(f"Unknown audience '{audience}'. Use one of: {', '.join(AUDIENCES)}.", 422)
    project = _project(container, pid)
    request = (f"Audience: {audience}\nToday: {now_iso()[:10]}\n\nWrite the status report for this project.\n\n"
               f"{project_facts(container, project)}")
    return str(await container.ai.ask("status_reporter", request, prompt_key="status_reporter", project_id=pid))


async def explain_risk(container: "Container", pid: str) -> str:
    """The deterministic score is recomputed first (when the risk module is available) so the
    explanation never describes a stale score."""
    project = _project(container, pid)
    risk = project.get("risk") or {}
    try:
        risk = risk_mod.compute_risk(project, datetime.now(timezone.utc)) or risk
    except FactoryError as exc:   # not implemented / not computable: explain the stored score
        log.info("Risk recompute unavailable for %s: %s", pid, exc.message)
    reasons = "\n".join(f"- {r}" for r in risk.get("reasons") or []) or "- (no risk factor detected)"
    request = (f"Risk score: {risk.get('score', 0)}/100 — level {risk.get('level') or 'low'}\nReasons:\n{reasons}\n\n"
               f"Project facts:\n{project_facts(container, project)}")
    return str(await container.ai.ask("risk_explainer", request, prompt_key="risk_explainer", project_id=pid))


async def summarize_project(container: "Container", pid: str) -> str:
    """A 2-3 sentence summary, stored as project.ai_summary through the engine (the only
    writer of projects). If the engine refuses the write, the summary is still returned."""
    project = _project(container, pid)
    request = ("Summarise this project in 2-3 sentences (max 60 words): where it stands, what is next, and the "
               "main risk if any. Plain text, no headings, no bullets.\n\n" + project_facts(container, project))
    summary = str(await container.ai.ask("summarizer", request, prompt_key="writer", fast=True, project_id=pid)).strip()
    try:
        await container.engine.update_project(pid, "ai", {"ai_summary": summary})
    except FactoryError as exc:
        log.warning("Could not store the AI summary of %s: %s", pid, exc.message)
    return summary


# =====================================================================================
# Morning briefing
# =====================================================================================

def _briefing_facts(c: "Container", user: dict) -> dict:
    uid = user["id"]
    items = inbox_mod.inbox_for(c, uid)
    team_ids = set(user.get("team_ids") or [])
    watch = []
    for p in c.store.list("projects"):
        if p.get("status") not in ("active", "waiting", "blocked", "failed"):
            continue
        involved = (uid in (p.get("sponsor_id"), p.get("owner_id")) or uid in (p.get("stakeholder_ids") or [])
                    or (p.get("team_id") and p.get("team_id") in team_ids))
        risk = p.get("risk") or {}
        if involved and (p.get("status") in ("blocked", "failed") or risk.get("level") in ("high", "medium")):
            watch.append({"key": p.get("key"), "title": p.get("title"), "status": p.get("status"),
                          "risk": f"{risk.get('level') or 'low'} ({risk.get('score') or 0})",
                          "reasons": (risk.get("reasons") or [])[:3]})
    watch.sort(key=lambda w: w["status"] not in ("blocked", "failed"))
    return {"items": items, "watch": watch[:10]}


def _item_line(item: dict) -> str:
    when = ""
    if item.get("due_at"):
        when = f" — {'overdue since' if item.get('overdue') else 'due'} {item['due_at'][:10]}"
    where = f"**{item['project_key']}** — " if item.get("project_key") else ""
    what = item.get("title") or item.get("step_name") or item.get("kind")
    return f"- {where}{what}{when}"


def _plain_briefing(user: dict, facts: dict, note: str) -> str:
    items, watch = facts["items"], facts["watch"]
    first = (user.get("name") or "").split(" ")[0] or "there"
    if not items and not watch:
        return f"Good morning {first} — nothing needs you today. Your inbox is empty and none of your projects is flagged."
    urgent = sorted(items, key=lambda i: (not i.get("overdue"), {"critical": 0, "high": 1, "medium": 2, "low": 3}
                                          .get(i.get("priority") or "medium", 2), i.get("due_at") or "9999"))
    lines = []
    if note:
        lines += [f"_{note}_", ""]
    lines.append("### Today's focus")
    lines += [_item_line(i) for i in urgent[:3]] or ["- Nothing urgent."]
    rest = urgent[3:]
    if rest:
        lines += ["", "### Waiting on you"] + [_item_line(i) for i in rest[:12]]
        if len(rest) > 12:
            lines.append(f"- …and {len(rest) - 12} more in your Inbox.")
    lines += ["", "### Watch list"]
    lines += [f"- **{w['key']}** — {w['title']}: {w['status']}, risk {w['risk']}" for w in watch] or ["- Nothing to flag."]
    return "\n".join(lines)


async def briefing(container: "Container", user_id: str, *, refresh: bool = False) -> dict:
    """{markdown, generated_at, ai}. AI-written and cached 10 minutes per user; without an
    LLM (or when it fails) a deterministic summary of the same facts with `ai: false`."""
    c = container
    if not (user_id or "").strip():
        raise FactoryError("Pick who you are acting as to get a briefing.", 422)
    user = c.get_user(user_id)
    if user is None:
        raise NotFound(f"User {user_id} not found")
    cache_key = (str(c.store.path), user_id)
    cached = _briefings.get(cache_key)
    if cached and not refresh and time.monotonic() - cached[0] < BRIEFING_TTL_S:
        return cached[1]
    facts = _briefing_facts(c, user)
    if not facts["items"] and not facts["watch"]:
        return {"markdown": _plain_briefing(user, facts, ""), "generated_at": now_iso(), "ai": False}
    if not c.ai.configured:
        return {"markdown": _plain_briefing(user, facts, "Plain summary — connect an AI model in Settings › AI Model "
                                                         "for a written briefing."),
                "generated_at": now_iso(), "ai": False}
    rows = [{k: i.get(k) for k in ("kind", "project_key", "project_title", "step_name", "title", "priority",
                                   "due_at", "overdue") if i.get(k) not in (None, "")} for i in facts["items"][:25]]
    request = (f"Person: {user.get('name')} — roles: {', '.join(user.get('roles') or []) or 'none'}\n"
               f"Today: {now_iso()[:10]}\n\nPending items ({len(facts['items'])}):\n"
               f"{json.dumps(rows, ensure_ascii=False, indent=1)}\n\n"
               f"Watch list (their at-risk or blocked projects):\n{json.dumps(facts['watch'], ensure_ascii=False, indent=1)}")
    try:
        markdown = str(await c.ai.ask("briefing", request, prompt_key="briefing"))
    except FactoryError as exc:
        log.warning("AI briefing failed for %s: %s", user_id, exc.message)
        return {"markdown": _plain_briefing(user, facts, f"Plain summary — the AI briefing failed: "
                                                         f"{truncate(exc.message, 200)}"),
                "generated_at": now_iso(), "ai": False}
    result = {"markdown": markdown, "generated_at": now_iso(), "ai": True}
    _briefings[cache_key] = (time.monotonic(), result)
    return result


# =====================================================================================
# Blueprint generation
# =====================================================================================

def _unique(base: str, taken: set[str], fallback: str) -> str:
    slug = base or fallback
    out, n = slug, 2
    while out in taken:
        out, n = f"{slug}_{n}", n + 1
    taken.add(out)
    return out


def _field(raw: Any, taken: set[str], warnings: list[str], where: str) -> dict | None:
    if not isinstance(raw, dict):
        return None
    key = _unique(slugify(raw.get("key") or raw.get("label")), taken, "")
    if not key:
        warnings.append(f"{where}: dropped a field without a key or label.")
        return None
    ftype = raw.get("type") if raw.get("type") in FIELD_TYPES else "text"
    try:
        return FieldDef.model_validate({**raw, "key": key, "type": ftype,
                                        "label": raw.get("label") or key.replace("_", " ").title()}).model_dump()
    except ValidationError as exc:
        warnings.append(f"{where}: field '{key}' dropped ({validation_message(exc)}).")
        return None


def normalise_blueprint(c: "Container", data: dict) -> tuple[dict, list[str]]:
    """An LLM-drafted blueprint made structurally sound: unique snake_case ids, closed
    vocabularies respected (step types, field types, roles, colours), typed step configs.
    What cannot be repaired is dropped and reported — never silently invented."""
    warnings: list[str] = []
    if isinstance(data.get("blueprint"), dict):
        data = data["blueprint"]
    role_keys = {r.get("key") for r in c.roles()}
    name = str(data.get("name") or "").strip() or "Generated blueprint"
    keys = {b.get("key") for b in c.store.list("blueprints")}
    key = _unique(slugify(data.get("key") or name), set(keys), "generated_blueprint")
    prefix = re.sub(r"[^A-Z]", "", str(data.get("key_prefix") or "").upper())[:4]
    if len(prefix) < 2:
        prefix = "".join(w[0] for w in re.findall(r"[A-Za-z]+", name)).upper()[:4] or "PRJ"
        prefix = prefix if len(prefix) >= 2 else "PRJ"
    input_keys: set[str] = set()
    inputs = [f for f in (_field(raw, input_keys, warnings, "Inputs") for raw in data.get("inputs") or []) if f]

    stage_ids: set[str] = set()
    step_ids: set[str] = set()
    store_names: set[str] = set()
    stages = []
    for s_index, raw_stage in enumerate(data.get("stages") or []):
        if not isinstance(raw_stage, dict):
            continue
        stage_name = str(raw_stage.get("name") or f"Stage {s_index + 1}")
        stage_id = _unique(slugify(raw_stage.get("id") or stage_name), stage_ids, f"stage_{s_index + 1}")
        steps = []
        for t_index, raw_step in enumerate(raw_stage.get("steps") or []):
            if not isinstance(raw_step, dict):
                continue
            step_name = str(raw_step.get("name") or f"Step {t_index + 1}")
            raw_type = slugify(raw_step.get("type") or "")
            step_type = raw_type if raw_type in STEP_TYPES else _TYPE_ALIASES.get(raw_type.replace("_", ""), _TYPE_ALIASES.get(raw_type))
            if step_type not in STEP_TYPES:
                warnings.append(f"Step '{step_name}' dropped: unknown step type '{raw_step.get('type')}'.")
                continue
            step_id = _unique(slugify(raw_step.get("id") or step_name), step_ids, f"step_{len(step_ids) + 1}")
            store_as = _unique(slugify(raw_step.get("store_as") or step_id), store_names, step_id)
            raw_assignee = raw_step.get("assignee") if isinstance(raw_step.get("assignee"), dict) else {}
            roles = [r for r in raw_assignee.get("roles") or [] if isinstance(r, str)]
            unknown = [r for r in roles if r not in role_keys]
            if unknown:
                warnings.append(f"Step '{step_name}': unknown role(s) {', '.join(unknown)} removed.")
            project_role = raw_assignee.get("project_role") if raw_assignee.get("project_role") in PROJECT_ROLES else ""
            config = raw_step.get("config") if isinstance(raw_step.get("config"), dict) else {}
            if step_type == "human_form" and isinstance(config.get("fields"), list):
                field_keys: set[str] = set()
                config = {**config, "fields": [f for f in (_field(raw, field_keys, warnings, f"Step '{step_name}'")
                                                           for raw in config["fields"]) if f]}
            if step_type == "approval" and isinstance(config.get("approvers"), list):
                approvers = [a for a in config["approvers"] if isinstance(a, dict) and a.get("role") in role_keys]
                if len(approvers) < len(config["approvers"]):
                    warnings.append(f"Step '{step_name}': approvers with unknown roles removed.")
                config = {**config, "approvers": approvers}
            try:
                config = STEP_CONFIG_MODELS[step_type].model_validate(config).model_dump()
            except ValidationError as exc:
                warnings.append(f"Step '{step_name}': its {step_type} configuration was invalid "
                                f"({validation_message(exc)}) and was reset — complete it in the designer.")
                config = STEP_CONFIG_MODELS[step_type]().model_dump()
            sla = raw_step.get("sla_hours")
            steps.append({
                "id": step_id, "name": step_name, "type": step_type,
                "description": str(raw_step.get("description") or ""),
                "assignee": {"roles": [r for r in roles if r in role_keys], "user_ids": [], "project_role": project_role},
                "sla_hours": float(sla) if isinstance(sla, (int, float)) and not isinstance(sla, bool) and sla > 0 else None,
                "when": str(raw_step.get("when") or ""), "store_as": store_as,
                "auto_start": raw_step.get("auto_start") is not False, "config": config,
            })
        if not steps:
            warnings.append(f"Stage '{stage_name}' dropped: it has no usable step.")
            continue
        stages.append({"id": stage_id, "name": stage_name, "description": str(raw_stage.get("description") or ""),
                       "color": raw_stage.get("color") if raw_stage.get("color") in TONES else "indigo",
                       "parallel": bool(raw_stage.get("parallel")), "steps": steps})
    if not stages:
        raise LLMError("The model did not produce any usable stage — rephrase the description or try a larger model.")
    draft = Blueprint.model_validate({
        "id": "", "key": key, "name": name, "description": str(data.get("description") or ""),
        "kind": slugify(data.get("kind")) or "custom", "icon": str(data.get("icon") or "Workflow"),
        "color": data.get("color") if data.get("color") in TONES else "indigo", "key_prefix": prefix,
        "version": 1, "status": "draft", "autonomy": "", "inputs": inputs, "stages": stages, "builtin": False,
    }).model_dump()
    return draft, warnings


def validation_report(c: "Container", blueprint: dict) -> dict:
    """validate_blueprint() with its failure turned into a report rather than an exception."""
    try:
        report = blueprint_engine.validate_blueprint(c, blueprint)
    except FactoryError as exc:
        return {"ok": False, "errors": [], "warnings": [f"Validation unavailable: {exc.message}"]}
    return {"ok": bool(report.get("ok")), "errors": list(report.get("errors") or []),
            "warnings": list(report.get("warnings") or [])}


async def generate_blueprint(container: "Container", description: str) -> dict:
    """An unsaved draft Blueprint (status draft) from a plain-language description, with its
    validation report under `validation` (normalisation warnings included)."""
    c = container
    text = (description or "").strip()
    if len(text) < 10:
        raise FactoryError("Describe the process in a sentence or two (what happens, who decides).", 422)
    ops = [f"- {o.get('key')}: {truncate(o.get('description') or o.get('name'), 120)}"
           for o in c.store.list("operations") if o.get("key")]
    blueprints = [f"- {b.get('key')}: {b.get('name')}" for b in c.store.list("blueprints")
                  if b.get("key") and b.get("status") != "archived"]
    roles = ", ".join(r.get("key") for r in c.roles() if r.get("key"))
    request = (f"Design a blueprint for this process:\n{text}\n\n"
               f"Role keys you may use: {roles or 'none defined'}\n"
               f"Operation keys available (for mcp_operation / wait_for):\n{chr(10).join(ops) or '- none'}\n"
               f"Existing blueprint keys (for fan_out):\n{chr(10).join(blueprints) or '- none'}")
    data = await c.ai.ask("blueprint_designer", request, prompt_key="blueprint_designer", json=True)
    if not isinstance(data, dict):
        raise LLMError("The model returned a list instead of one blueprint object — try again.")
    draft, warnings = normalise_blueprint(c, data)
    report = validation_report(c, draft)
    report["warnings"] = warnings + report["warnings"]
    return {**draft, "validation": report}


# =====================================================================================
# Operation suggestion
# =====================================================================================

async def suggest_operation(container: "Container", connector_id: str, intent: str) -> dict:
    """An unsaved Operation draft for `connector_id` that does what `intent` says: the LLM
    picks one of the connector's real tools (enforced by a JSON-schema enum), a mode and the
    argument template. The draft's `sensitive` flag comes from the tool, not from the model."""
    c = container
    connector = c.store.get("connectors", connector_id) if connector_id else None
    if connector is None:
        raise NotFound(f"Connector {connector_id} not found")
    goal = (intent or "").strip()
    if not goal:
        raise FactoryError("Say what the operation should do (e.g. 'list the open epics of a Jira project').", 422)
    tools = await c.mcp.list_tools(connector_id)
    if not tools:
        raise NotConfigured(f"Connector '{connector.get('name')}' exposes no tools — test it in Settings › Connectors.")
    by_name = {t["name"]: t for t in tools}
    catalogue = "\n".join(f"- {t['name']}{' [writes]' if t.get('sensitive') else ''}: "
                          f"{truncate(t.get('description'), 200)}\n  input schema: "
                          f"{truncate(json.dumps(t.get('input_schema') or {}, ensure_ascii=False), 600)}"
                          for t in tools[:60])
    schema = {"type": "object", "required": ["name", "mode", "tool"], "properties": {
        "name": {"type": "string"}, "description": {"type": "string"},
        "mode": {"type": "string", "enum": ["direct", "llm", "agent"]},
        "tool": {"type": "string", "enum": sorted(by_name)},
        "args_template": {"type": "object"}, "prompt": {"type": "string"},
        "allowed_tools": {"type": "array", "items": {"type": "string"}},
        "inputs": {"type": "array", "items": {"type": "object"}},
        "extract": {"type": "string"}, "rationale": {"type": "string"}}}
    request = (
        f"Design one reusable operation (a named binding to an MCP tool) for the connector "
        f"'{connector.get('name')}'.\nWhat it must do: {goal}\n\nTools of this connector:\n{catalogue}\n\n"
        "Rules:\n"
        "- mode 'direct' (preferred): one tool call whose arguments come from args_template, a JSON object whose "
        "string values may be Jinja templates over the operation input, e.g. {\"project_key\": \"{{ input.project_key }}\"}.\n"
        "- mode 'llm': one tool call whose arguments an LLM builds from `prompt` and the input — only when the "
        "arguments need judgement.\n"
        "- mode 'agent': several calls toward a goal written in `prompt`, limited to `allowed_tools` — only when "
        "one call is not enough (e.g. search then create).\n"
        "- `tool` is the main tool (for agent mode: the first one it should use).\n"
        "- inputs: the fields a caller provides, as [{\"key\": \"snake_case\", \"label\": \"Label\", \"type\": "
        "\"text\", \"required\": true}]; every {{ input.x }} used must be declared.\n"
        "- extract: optional Jinja expression over `result` that selects the useful part of the tool output "
        "(e.g. \"result.issues\"); \"\" keeps the whole result.\n"
        "- name: short title; description: one sentence; rationale: one sentence on the choices.")
    data = await c.ai.ask("operation_designer", request, prompt_key="orchestrator", json_schema=schema)
    tool = by_name[data["tool"]]
    mode = data.get("mode") if data.get("mode") in ("direct", "llm", "agent") else "direct"
    field_keys: set[str] = set()
    warnings: list[str] = []
    inputs = [f for f in (_field(raw, field_keys, warnings, "Inputs") for raw in data.get("inputs") or []) if f]
    allowed = [t for t in data.get("allowed_tools") or [] if t in by_name] if mode == "agent" else []
    if mode == "agent" and tool["name"] not in allowed:
        allowed.insert(0, tool["name"])
    slug = connector.get("slug") or slugify(connector.get("name")) or "connector"
    taken = {o.get("key") for o in c.store.list("operations")}
    key = _unique(f"{slug}.{slugify(data.get('name') or tool['name'])}", set(taken), f"{slug}.{tool['name']}")
    sensitive = bool(tool.get("sensitive")) or any(by_name[t].get("sensitive") for t in allowed)
    draft = Operation.model_validate({
        "id": "", "key": key, "name": str(data.get("name") or tool["name"]),
        "description": str(data.get("description") or ""), "connector_id": connector_id, "mode": mode,
        "tool": tool["name"],
        "args_template": data.get("args_template") if isinstance(data.get("args_template"), dict) and mode == "direct" else {},
        "prompt": str(data.get("prompt") or "") if mode != "direct" else "",
        "allowed_tools": allowed, "output": {"extract": str(data.get("extract") or "")},
        "sensitive": sensitive, "inputs": inputs, "test_input": {},
    }).model_dump()
    draft["rationale"] = str(data.get("rationale") or "")
    if warnings:
        draft["warnings"] = warnings
    return draft


def clear_briefing_cache() -> None:
    """Tests and a backup import start from a clean slate."""
    _briefings.clear()
