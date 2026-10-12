"""Blueprint validation and instantiation (SPEC §1, §3.4): validate_blueprint(), stage/step
instantiation for a new project, assignee resolution.

Validation is the gate between the Blueprint Designer and running projects: an *error* means a
project started from it would get stuck or misbehave (an approval nobody can give, a reject
target that does not exist, a template that does not compile), a *warning* means something
probably unintended (an operation not installed yet, an unknown config key that would be
silently ignored). The engine refuses to start a project from a blueprint with errors.
"""
from __future__ import annotations

import copy
import re
from typing import TYPE_CHECKING, Any, Iterator

from pydantic import ValidationError

from app.engine import templating
from app.errors import TemplateError
from app.models import STEP_CONFIG_MODELS, Assignee, Blueprint, StageRun, StepRun
from app.util import validation_message

if TYPE_CHECKING:  # pragma: no cover
    from app.deps import Container

# Ids become Jinja names (`vars.<store_as or id>`) and URL segments: lowercase, no hyphen.
_ID = re.compile(r"^[a-z][a-z0-9_]{0,63}$")
STEP_TYPES = tuple(STEP_CONFIG_MODELS)

# Which config strings are Jinja templates and which are bare expressions, per step type.
_TEMPLATE_FIELDS: dict[str, tuple[str, ...]] = {
    "ai_task": ("prompt",), "human_form": ("ai_prefill",), "approval": ("brief_prompt",),
    "estimation": ("prompt",), "agent_task": ("goal",), "fan_out": ("title",),
    "notify": ("subject", "prompt", "body"),
}
_TEMPLATE_TREES = ("input", "inputs", "create_link")      # dicts whose every string is a template
_EXPRESSION_FIELDS = ("items", "until")


def _strings(value: Any) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from _strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from _strings(v)


def step_templates(step: dict) -> list[tuple[str, str, str]]:
    """(where, kind, text) for every Jinja string of a step; kind is "template" or "expression"."""
    cfg = step.get("config") or {}
    out: list[tuple[str, str, str]] = []
    if step.get("when"):
        out.append(("when", "expression", step["when"]))
    for name in _TEMPLATE_FIELDS.get(step.get("type", ""), ()):
        if isinstance(cfg.get(name), str) and cfg[name]:
            out.append((f"config.{name}", "template", cfg[name]))
    for name in _TEMPLATE_TREES:
        for text in _strings(cfg.get(name)):
            out.append((f"config.{name}", "template", text))
    for name in _EXPRESSION_FIELDS:
        if isinstance(cfg.get(name), str) and cfg[name]:
            out.append((f"config.{name}", "expression", cfg[name]))
    return out


def iter_steps(blueprint: dict) -> Iterator[tuple[dict, dict]]:
    for stage in blueprint.get("stages") or []:
        for step in stage.get("steps") or []:
            yield stage, step


# ---------------------------------------------------------------------------
# Validation
# ---------------------------------------------------------------------------

def validate_blueprint(container: "Container", blueprint: dict) -> dict:
    """→ {"ok": bool, "errors": [str], "warnings": [str]} — messages name the stage/step."""
    errors: list[str] = []
    warnings: list[str] = []
    bp = blueprint or {}

    # Step types first, with a readable message (the model would only say "Input should be …").
    for stage, step in iter_steps(bp):
        if step.get("type") not in STEP_TYPES:
            errors.append(f"Step '{step.get('id') or step.get('name') or '?'}': unknown type "
                          f"'{step.get('type')}' — expected one of {', '.join(STEP_TYPES)}")
    if errors:
        return {"ok": False, "errors": errors, "warnings": warnings}
    try:
        Blueprint.model_validate(bp)
    except ValidationError as exc:
        return {"ok": False, "errors": [f"Invalid blueprint — {validation_message(exc, limit=5)}"], "warnings": []}

    if not (bp.get("name") or "").strip():
        errors.append("The blueprint needs a name")
    key = bp.get("key") or ""
    if not _ID.match(key):
        errors.append(f"Blueprint key '{key}' must be a lowercase slug (letters, digits, underscores; "
                      "starting with a letter)")
    else:
        clash = next((b for b in container.store.list("blueprints")
                      if b.get("key") == key and b.get("id") != bp.get("id")), None)
        if clash is not None:
            errors.append(f"Another blueprint ('{clash.get('name')}') already uses the key '{key}'")

    input_keys = [f.get("key") for f in bp.get("inputs") or []]
    for k in input_keys:
        if not _ID.match(k or ""):
            errors.append(f"Input key '{k}' must be a lowercase slug (it is read as inputs.{k})")
    for k in {k for k in input_keys if input_keys.count(k) > 1}:
        errors.append(f"Two inputs use the key '{k}'")

    stages = bp.get("stages") or []
    if not stages:
        errors.append("The blueprint has no stage")
    role_keys = {r.get("key") for r in container.roles()}
    role_check = bool(role_keys)
    if not role_check:
        warnings.append("No roles are defined — role assignments cannot be checked (Settings › People & Teams)")

    def check_role(where: str, role: str) -> None:
        if role_check and role and role not in role_keys:
            errors.append(f"{where}: unknown role '{role}' — define it in Settings › People & Teams")

    stage_ids: list[str] = []
    order: list[str] = []          # step ids in execution order
    var_names: dict[str, str] = {}  # store_as or id → step id
    for stage in stages:
        sid = stage.get("id") or ""
        if not _ID.match(sid):
            errors.append(f"Stage id '{sid}' must be a lowercase slug (letters, digits, underscores)")
        if sid in stage_ids:
            errors.append(f"Two stages use the id '{sid}'")
        stage_ids.append(sid)
        if not stage.get("steps"):
            warnings.append(f"Stage '{stage.get('name') or sid}' has no step (it completes immediately)")
        for step in stage.get("steps") or []:
            step_id = step.get("id") or ""
            where = f"Step '{step_id or step.get('name') or '?'}'"
            if not _ID.match(step_id):
                errors.append(f"{where}: the id must be a lowercase slug (letters, digits, underscores)")
            if step_id in order:
                errors.append(f"Two steps use the id '{step_id}'")
            order.append(step_id)
            var = step.get("store_as") or step_id
            if step.get("store_as") and not _ID.match(step["store_as"]):
                errors.append(f"{where}: store_as '{step['store_as']}' must be a lowercase slug (read as vars.<name>)")
            if var in var_names:
                errors.append(f"{where}: stores its output in vars.{var}, already written by step '{var_names[var]}'")
            var_names.setdefault(var, step_id)
            if (step.get("sla_hours") or 0) < 0:
                errors.append(f"{where}: the SLA cannot be negative")
            assignee = step.get("assignee") or {}
            for role in assignee.get("roles") or []:
                check_role(where, role)
            for uid in assignee.get("user_ids") or []:
                if container.get_user(uid) is None:
                    warnings.append(f"{where}: assigned user {uid} does not exist")
            _validate_config(container, step, where, errors, warnings, check_role)
            for place, kind, text in step_templates(step):
                try:
                    (templating.check_expression if kind == "expression" else templating.check_template)(text)
                except TemplateError as exc:
                    errors.append(f"{where} {place}: {exc.message}")

    # Reject targets must exist and come before the approval (or gate) that sends work back.
    for _, step in iter_steps(bp):
        if step.get("type") != "approval":
            continue
        target = ((step.get("config") or {}).get("on_reject") or {}).get("goto_step") or ""
        if target and step.get("id") in order:
            if target not in order:
                errors.append(f"Step '{step['id']}': on_reject.goto_step '{target}' does not exist")
            elif order.index(target) >= order.index(step["id"]):
                errors.append(f"Step '{step['id']}': on_reject.goto_step '{target}' must come before the approval")
    return {"ok": not errors, "errors": errors, "warnings": warnings}


def _validate_config(container: "Container", step: dict, where: str, errors: list[str], warnings: list[str],
                     check_role) -> None:
    kind = step.get("type", "")
    model = STEP_CONFIG_MODELS[kind]
    cfg = step.get("config") or {}
    unknown = sorted(set(cfg) - set(model.model_fields))
    if unknown:
        warnings.append(f"{where}: unknown config key(s) {', '.join(unknown)} — ignored by a {kind} step")
    try:
        parsed = model.model_validate(cfg)
    except ValidationError as exc:
        errors.append(f"{where}: invalid {kind} config — {validation_message(exc)}")
        return

    if kind == "ai_task" and not parsed.prompt.strip():
        errors.append(f"{where}: an AI task needs a prompt")
    elif kind == "agent_task" and not parsed.goal.strip():
        errors.append(f"{where}: an agent task needs a goal")
    elif kind == "human_form":
        keys = [f.key for f in parsed.fields]
        if not keys:
            warnings.append(f"{where}: the form has no field")
        for k in {k for k in keys if keys.count(k) > 1}:
            errors.append(f"{where}: two form fields use the key '{k}'")
    elif kind == "approval":
        if not parsed.approvers:
            errors.append(f"{where}: an approval needs at least one approver role")
        for approver in parsed.approvers:
            check_role(where, approver.role)
        if parsed.policy == "quorum" and parsed.quorum < 1:
            errors.append(f"{where}: the quorum must be at least 1")
    elif kind in ("mcp_operation", "wait_for"):
        if not parsed.operation_key:
            errors.append(f"{where}: choose the operation to run")
        elif container.get_operation_by_key(parsed.operation_key) is None:
            warnings.append(f"{where}: operation '{parsed.operation_key}' does not exist yet "
                            "(Studio › Operations, or install the sandbox demo)")
        if kind == "wait_for" and not parsed.until.strip() and not parsed.manual_complete:
            warnings.append(f"{where}: no 'until' condition — the step completes at the first poll")
    elif kind == "quality_gate":
        for role in parsed.override_roles:
            check_role(where, role)
    elif kind == "fan_out":
        if not parsed.items.strip():
            errors.append(f"{where}: a fan-out needs an 'items' expression")
        if not parsed.blueprint_key:
            errors.append(f"{where}: choose the blueprint of the child projects")
        elif (container.get_blueprint_by_key(parsed.blueprint_key) is None
              and container.get_blueprint(parsed.blueprint_key) is None):
            errors.append(f"{where}: child blueprint '{parsed.blueprint_key}' does not exist")
    elif kind == "notify":
        if not parsed.audience:
            warnings.append(f"{where}: the notification has no audience")
        for target in parsed.audience:
            check_role(where, target.role)
        if not parsed.prompt and not parsed.body:
            warnings.append(f"{where}: neither a prompt (AI-written body) nor a body is set")


# ---------------------------------------------------------------------------
# Instantiation
# ---------------------------------------------------------------------------

def instantiate_stages(blueprint: dict) -> list[dict]:
    """Blueprint stages/steps → fresh StageRun dicts for a new project (configs deep-copied, so
    editing the blueprint later never changes a running project)."""
    stages = []
    for stage in blueprint.get("stages") or []:
        steps = []
        for step in stage.get("steps") or []:
            steps.append(StepRun.model_validate({
                "id": step["id"], "name": step.get("name") or step["id"], "type": step.get("type", "ai_task"),
                "description": step.get("description", ""), "config": copy.deepcopy(step.get("config") or {}),
                "assignee": copy.deepcopy(step.get("assignee") or {}), "when": step.get("when", ""),
                "store_as": step.get("store_as", ""), "sla_hours": step.get("sla_hours"),
                "auto_start": step.get("auto_start", True),
            }).model_dump())
        stages.append(StageRun.model_validate({
            "id": stage["id"], "name": stage.get("name") or stage["id"], "description": stage.get("description", ""),
            "color": stage.get("color", "indigo"), "parallel": bool(stage.get("parallel")), "steps": steps,
        }).model_dump())
    return stages


# ---------------------------------------------------------------------------
# Assignees
# ---------------------------------------------------------------------------

def team_member_ids(container: "Container", team_id: str) -> list[str]:
    """Members of a team, as recorded on either side (team.member_ids or user.team_ids)."""
    if not team_id:
        return []
    team = container.get_team(team_id) or {}
    ids = list(team.get("member_ids") or [])
    ids += [u["id"] for u in container.users() if team_id in (u.get("team_ids") or []) and u["id"] not in ids]
    return ids


def project_role_users(container: "Container", project: dict, project_role: str) -> list[str]:
    if project_role == "sponsor":
        return [project["sponsor_id"]] if project.get("sponsor_id") else []
    if project_role == "owner":
        return [project["owner_id"]] if project.get("owner_id") else []
    if project_role == "team_lead":
        lead = (container.get_team(project.get("team_id", "")) or {}).get("lead_user_id")
        return [lead] if lead else []
    if project_role == "team":
        return team_member_ids(container, project.get("team_id", ""))
    return []


def role_holders(container: "Container", project: dict, role: str, *, prefer_team: bool = True) -> list[str]:
    """Active users holding `role`. The `sponsor` role means *this project's* sponsor when one is
    set (SPEC §12 permission model). When the project has a team and some holders belong to it,
    only those: a dev lead of the delivering team, not every dev lead of the bank."""
    if role == "sponsor" and project.get("sponsor_id"):
        return [project["sponsor_id"]]
    holders = [u["id"] for u in container.users() if u.get("active", True) and role in (u.get("roles") or [])]
    if prefer_team and project.get("team_id"):
        members = set(team_member_ids(container, project["team_id"]))
        in_team = [uid for uid in holders if uid in members]
        if in_team:
            return in_team
    return holders


def resolve_assignees(container: "Container", project: dict, step: dict) -> list[str]:
    """Step assignee (explicit users + role holders + project role) → concrete active user ids,
    in that order, without duplicates."""
    assignee = Assignee.model_validate(step.get("assignee") or {})
    ids: list[str] = list(assignee.user_ids)
    for role in assignee.roles:
        ids += role_holders(container, project, role)
    ids += project_role_users(container, project, assignee.project_role)
    out: list[str] = []
    for uid in ids:
        user = container.get_user(uid) if uid else None
        if user is not None and user.get("active", True) and uid not in out:
            out.append(uid)
    return out
