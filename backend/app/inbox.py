"""Inbox: the pending actions of one user, derived from projects + intake (never stored).

Two passes. `open_actions` classifies every step that waits on a person (user-agnostic, also
used by the KPIs). `inbox_for` then keeps the ones this user should handle: whoever
`engine.can_act` allows (the same check the action endpoints enforce), so the inbox never
shows a button that would answer 403.

Admins may act on anything, but listing every pending step of the portfolio in their inbox
would bury what is actually theirs. So an admin's inbox holds the steps they are assigned
to (directly, by role or by project role), steps nobody else can act on, every failure,
and new intake items. Ordering (SPEC §9): overdue first, then priority, due date, age.
"""
from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any

from app.models import InboxCounts, InboxItem
from app.util import parse_iso, to_iso, truncate

if TYPE_CHECKING:  # pragma: no cover
    from app.deps import Container

IN_FLIGHT = frozenset({"active", "waiting", "blocked"})
FINISHED_STEP = frozenset({"done", "skipped"})
PRIORITY_RANK = {"critical": 0, "high": 1, "medium": 2, "low": 3}
INTAKE_ROLES = frozenset({"product_manager", "admin"})

# InboxCounts buckets: which kinds each badge counts (every kind counts in `total`).
COUNT_BUCKETS = {
    "approvals": {"approval"},
    "forms": {"form", "estimate", "start", "external"},
    "reviews": {"review", "confirm", "gate"},
    "failures": {"failure"},
    "intake": {"intake"},
}


@dataclass(frozen=True)
class OpenAction:
    """A step waiting on a person, before deciding which person."""
    kind: str
    project: dict
    stage: dict
    step: dict


def step_action(stage: dict, step: dict, its_turn: bool = True) -> str | None:
    """The inbox kind of a step that waits on a person, or None. `its_turn` says whether a
    pending step may start now (all earlier steps of a sequential stage are finished)."""
    status = step.get("status")
    pending = (step.get("pending_action") or {}).get("kind")
    step_type = step.get("type")
    if status == "waiting_human":
        if pending == "ai_review":
            return "review"
        if pending in ("confirm_operation", "agent_tool_call"):
            return "confirm"
        if pending == "gate_review":
            return "gate"
        if step_type == "estimation":
            return "estimate"
        return "review" if step_type == "ai_task" else "form"
    if status == "waiting_approval":
        return "approval"
    if status == "failed":
        return "failure"
    if status == "waiting_external" and step_type == "wait_for" \
            and (step.get("config") or {}).get("manual_complete", True):
        return "external"
    if status == "pending" and step.get("auto_start", True) is False and stage.get("status") == "active" and its_turn:
        return "start"
    return None


def open_actions(container: "Container", projects: list[dict] | None = None) -> list[OpenAction]:
    """Every step of every in-flight project that waits on a person."""
    if projects is None:
        projects = container.store.list("projects")
    out: list[OpenAction] = []
    for project in projects:
        if project.get("status") not in IN_FLIGHT:
            continue
        for stage in project.get("stages") or []:
            earlier_finished = True
            for step in stage.get("steps") or []:
                its_turn = bool(stage.get("parallel")) or earlier_finished
                kind = step_action(stage, step, its_turn)
                if kind:
                    out.append(OpenAction(kind, project, stage, step))
                earlier_finished = earlier_finished and step.get("status") in FINISHED_STEP
    return out


def new_intake(container: "Container") -> list[dict]:
    return [i for i in container.store.list("intake") if i.get("status") == "new"]


def inbox_for(container: "Container", user_id: str) -> list[dict]:
    user = container.get_user(user_id)
    if user is None or not user.get("active", True):
        return []
    return items_for_user(container, user, open_actions(container), new_intake(container))


def inbox_counts(container: "Container", user_id: str) -> dict:
    return counts_of(inbox_for(container, user_id))


def counts_of(items: list[dict]) -> dict:
    counts = InboxCounts(total=len(items))
    for bucket, kinds in COUNT_BUCKETS.items():
        setattr(counts, bucket, sum(1 for item in items if item["kind"] in kinds))
    return counts.model_dump()


def items_for_user(container: "Container", user: dict, actions: list[OpenAction], intake: list[dict],
                   now: datetime | None = None) -> list[dict]:
    """The sorted inbox of `user` from precomputed actions (the KPIs call this per user)."""
    now = now or datetime.now(timezone.utc)
    uid = user.get("id") or ""
    roles = set(user.get("roles") or [])
    is_admin = "admin" in roles
    teams = {t.get("id"): t for t in container.teams()}
    items: list[dict] = []
    for action in actions:
        if _sees(container, action, user, roles, is_admin, teams):
            items.append(_item(action, now))
    if roles & INTAKE_ROLES:
        items.extend(_intake_item(i) for i in intake)
    items.sort(key=_sort_key)
    return items


# ---------------------------------------------------------------------------------- who sees what

def _sees(container: "Container", action: OpenAction, user: dict, roles: set[str], is_admin: bool,
          teams: dict[str, dict]) -> bool:
    project, step, uid = action.project, action.step, user.get("id") or ""
    if action.kind == "failure":   # the owner fixes it; admins always see failures
        if is_admin or (bool(uid) and project.get("owner_id") == uid):
            return True
        if project.get("owner_id"):
            return False
        # No owner: whoever could act on the step is the next best person to unblock it.
    elif action.kind == "approval" and any((a or {}).get("user_id") == uid for a in step.get("approvals") or []):
        return False   # already decided
    try:
        allowed = bool(container.engine.can_act(project, step, uid))
    except Exception:  # noqa: BLE001 — a malformed step must not blank the whole inbox
        return False
    if not allowed:
        return False
    if not is_admin:
        return True
    return _concerned(action, user, roles, teams) or not _has_assignee(action)


def _concerned(action: OpenAction, user: dict, roles: set[str], teams: dict[str, dict]) -> bool:
    """Whether the step names this user, one of their roles, or their project role — the
    "it is really theirs" test applied to admins (who could act on anything)."""
    project, step, uid = action.project, action.step, user.get("id") or ""
    if uid in (step.get("assignee_user_ids") or []):
        return True
    assignee = step.get("assignee") or {}
    if uid in (assignee.get("user_ids") or []) or roles & set(assignee.get("roles") or []):
        return True
    config = step.get("config") or {}
    if action.kind == "approval" and roles & {(a or {}).get("role") for a in config.get("approvers") or []}:
        return True
    if action.kind == "gate" and roles & set(config.get("override_roles") or []):
        return True
    project_role = assignee.get("project_role") or ""
    team = teams.get(project.get("team_id") or "") or {}
    return {
        "sponsor": project.get("sponsor_id") == uid,
        "owner": project.get("owner_id") == uid,
        "team_lead": bool(team) and team.get("lead_user_id") == uid,
        "team": bool(team) and (uid in (team.get("member_ids") or []) or team.get("id") in (user.get("team_ids") or [])),
    }.get(project_role, False)


def _has_assignee(action: OpenAction) -> bool:
    step = action.step
    assignee = step.get("assignee") or {}
    approvers = (step.get("config") or {}).get("approvers") or [] if action.kind == "approval" else []
    return bool(step.get("assignee_user_ids") or assignee.get("user_ids") or assignee.get("roles")
                or assignee.get("project_role") or approvers)


# ---------------------------------------------------------------------------------- items

_TITLES = {
    "form": "Complete {name}",
    "estimate": "Estimate {name}",
    "approval": "Approve {name}",
    "review": "Review AI output: {name}",
    "confirm": "Confirm action: {name}",
    "gate": "Resolve quality gate: {name}",
    "failure": "Failed: {name}",
    "start": "Start {name}",
    "external": "Check external status: {name}",
}


def _item(action: OpenAction, now: datetime) -> dict:
    project, stage, step = action.project, action.stage, action.step
    name = str(step.get("name") or step.get("id") or "step")
    due = parse_iso(step.get("due_at"))
    return InboxItem(
        id=f"{project.get('id')}:{step.get('id')}", kind=action.kind,
        project_id=project.get("id") or "", project_key=project.get("key") or "",
        project_title=project.get("title") or "", step_id=step.get("id") or "", step_name=name,
        title=_TITLES[action.kind].format(name=name), subtitle=_subtitle(action),
        priority=_priority(project.get("priority")), due_at=to_iso(due) if due else None,
        overdue=bool(step.get("sla_breached")) or (due is not None and due < now),
        created_at=step.get("started_at") or project.get("updated_at") or project.get("created_at") or "",
        risk_level=_risk_level(project),
    ).model_dump()


def _subtitle(action: OpenAction) -> str:
    project, stage, step = action.project, action.stage, action.step
    pending = step.get("pending_action") or {}
    if action.kind == "failure":
        return truncate(step.get("error") or "The step failed — retry, skip or complete it manually.", 160)
    if action.kind in ("confirm", "gate", "review") and pending.get("title"):
        return truncate(pending["title"], 160)
    if action.kind == "approval":
        labels = [a.get("label") or a.get("role") for a in (step.get("config") or {}).get("approvers") or []
                  if isinstance(a, dict)]
        if labels:
            return truncate("Approvers: " + ", ".join(str(label) for label in labels if label), 160)
    if action.kind == "external":
        return "Waiting on an external system — mark it complete when it is done."
    where = " · ".join(p for p in (stage.get("name"), project.get("blueprint_name")) if p)
    return truncate(where, 160)


def _intake_item(intake: dict) -> dict:
    suggestion = intake.get("suggestion") or {}
    source = f"Detected by {intake['watcher_name']}" if intake.get("watcher_name") else "Detected by a watcher"
    hint = "AI triage ready" if suggestion else ("AI triage failed" if intake.get("ai_error") else "Awaiting triage")
    return InboxItem(
        id=f"intake:{intake.get('id')}", kind="intake",
        title=f"Triage new use case: {intake.get('title') or intake.get('external_id') or 'untitled'}",
        subtitle=f"{source} · {hint}", priority=_priority(suggestion.get("priority")),
        due_at=None, overdue=False, created_at=intake.get("detected_at") or "", risk_level="",
    ).model_dump()


def _priority(value: Any) -> str:
    return value if value in PRIORITY_RANK else "medium"


def _risk_level(project: dict) -> str:
    level = (project.get("risk") or {}).get("level") or ""
    return level if level in ("low", "medium", "high") else ""


def _sort_key(item: dict) -> tuple:
    return (not item["overdue"], PRIORITY_RANK.get(item["priority"], 2), item["due_at"] or "~",
            item["created_at"] or "~")
