"""Daily digest: one summary notification per person per business day (Settings › Notifications).

When `settings.notifications.digest_enabled` is on, the scheduler calls `send_due_digests`
on every tick. On a business day (Mon-Fri, in `settings.scheduler.timezone`), from
`business_hours_start` until the end of business hours, each active user who has something
pending gets ONE in-app notification "Your daily Factory digest" — and the same text through
the external channel when Settings › Notifications names one.

The text is assembled deterministically from real data, never by an LLM: the user's inbox
(counts by kind, overdue items), the in-flight projects they sponsor / own / work on that are
at high risk, and the intake items waiting for triage. A user with nothing pending gets
nothing.

Idempotency lives in the store (`digest_state` singleton): the day of the last completed run
and, per user, the day of their last digest — so a restart, or a crash in the middle of a run,
never sends anyone a second digest the same day.
"""
from __future__ import annotations

import logging
from datetime import date, datetime, timezone
from typing import TYPE_CHECKING
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from app.inbox import items_for_user, new_intake, open_actions

if TYPE_CHECKING:  # pragma: no cover
    from app.deps import Container

log = logging.getLogger("factory.digest")

STATE = "digest_state"
TITLE = "Your daily Factory digest"
IN_FLIGHT = frozenset({"active", "waiting", "blocked"})
MAX_LISTED = 8

# Inbox kinds in the order and wording of the digest's breakdown.
KIND_LABELS = {
    "approval": ("approval", "approvals"),
    "form": ("form to complete", "forms to complete"),
    "estimate": ("estimate", "estimates"),
    "review": ("AI output to review", "AI outputs to review"),
    "confirm": ("action to confirm", "actions to confirm"),
    "gate": ("quality gate to resolve", "quality gates to resolve"),
    "failure": ("failed step", "failed steps"),
    "start": ("step to start", "steps to start"),
    "external": ("external wait to check", "external waits to check"),
    "intake": ("intake item to triage", "intake items to triage"),
}


def local_now(container: "Container", now: datetime) -> datetime:
    """`now` in the scheduler's timezone (UTC when the setting names an unknown zone)."""
    name = container.app_settings().scheduler.timezone or "UTC"
    try:
        tz: ZoneInfo | timezone = ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        tz = timezone.utc
    aware = now if now.tzinfo else now.replace(tzinfo=timezone.utc)
    return aware.astimezone(tz)


def due_day(container: "Container", now: datetime) -> date | None:
    """The local business day a digest is due for at `now`, or None (digest off, weekend,
    before the start or after the end of business hours)."""
    settings = container.app_settings()
    if not settings.notifications.digest_enabled:
        return None
    local = local_now(container, now)
    if local.weekday() >= 5:
        return None
    start = int(settings.scheduler.business_hours_start)
    end = int(settings.scheduler.business_hours_end)
    if local.hour < start or (end > start and local.hour >= end):
        return None
    return local.date()


def _plural(n: int, words: tuple[str, str]) -> str:
    return f"{n} {words[0] if n == 1 else words[1]}"


def _their_high_risk_projects(container: "Container", user: dict, projects: list[dict]) -> list[dict]:
    uid = user.get("id") or ""
    teams = {t.get("id"): t for t in container.teams()}
    out = []
    for project in projects:
        if project.get("status") not in IN_FLIGHT or (project.get("risk") or {}).get("level") != "high":
            continue
        team = teams.get(project.get("team_id") or "") or {}
        if uid in (project.get("sponsor_id"), project.get("owner_id"), team.get("lead_user_id")) \
                or uid in (team.get("member_ids") or []):
            out.append(project)
    return out


def build_digest(container: "Container", user: dict, *, now: datetime | None = None,
                 actions: list | None = None, intake: list[dict] | None = None,
                 projects: list[dict] | None = None) -> str | None:
    """The digest body for `user` (plain text that reads as Markdown), or None when nothing
    is pending for them. Precomputed `actions` / `intake` / `projects` avoid re-reading the
    store once per user."""
    now = now or datetime.now(timezone.utc)
    if projects is None:
        projects = container.store.list("projects")
    if actions is None:
        actions = open_actions(container, projects)
    if intake is None:
        intake = new_intake(container)
    items = items_for_user(container, user, actions, intake, now)
    risky = _their_high_risk_projects(container, user, projects)
    if not items and not risky:
        return None

    by_kind: dict[str, int] = {}
    for item in items:
        by_kind[item["kind"]] = by_kind.get(item["kind"], 0) + 1
    actions_count = sum(n for kind, n in by_kind.items() if kind != "intake")
    overdue = [i for i in items if i.get("overdue")]

    headline = []
    if actions_count:
        headline.append(_plural(actions_count, ("action waiting for you", "actions waiting for you")))
    if overdue:
        headline.append(f"{len(overdue)} overdue")
    if risky:
        headline.append(_plural(len(risky), ("of your projects at high risk", "of your projects at high risk")))
    if by_kind.get("intake"):
        headline.append(_plural(by_kind["intake"], ("intake item waiting", "intake items waiting")))
    lines = [" · ".join(headline) + "."]

    if items:
        lines += ["", "**Your inbox**"]
        lines += [f"- {_plural(by_kind[k], KIND_LABELS.get(k, (k, k)))}" for k in KIND_LABELS if by_kind.get(k)]
    if overdue:
        lines += ["", "**Overdue**"]
        for item in overdue[:MAX_LISTED]:
            where = " ".join(p for p in (item.get("project_key"), item.get("project_title")) if p)
            lines.append(f"- {item['title']}" + (f" — {where}" if where else ""))
        if len(overdue) > MAX_LISTED:
            lines.append(f"- … and {len(overdue) - MAX_LISTED} more")
    if risky:
        lines += ["", "**Your projects at high risk**"]
        for project in risky[:MAX_LISTED]:
            reasons = [str(r) for r in (project.get("risk") or {}).get("reasons") or [] if r][:2]
            label = " ".join(p for p in (project.get("key"), project.get("title")) if p) or "Untitled project"
            lines.append(f"- {label}" + (f" — {'; '.join(reasons)}" if reasons else ""))
        if len(risky) > MAX_LISTED:
            lines.append(f"- … and {len(risky) - MAX_LISTED} more")
    lines += ["", "Open your inbox in the Factory to act on them."]
    return "\n".join(lines)


async def send_due_digests(container: "Container", now: datetime | None = None) -> list[str]:
    """Send today's digests if they are due and not sent yet. Returns the ids of the users
    who received one during this call."""
    now = now or datetime.now(timezone.utc)
    day = due_day(container, now)
    if day is None:
        return []
    today = day.isoformat()
    state = container.store.get_singleton(STATE, {"last_run": "", "sent": {}})
    if state.get("last_run") == today:
        return []
    sent: dict[str, str] = dict(state.get("sent") or {})

    projects = container.store.list("projects")
    actions = open_actions(container, projects)
    intake = new_intake(container)
    external = bool(container.app_settings().notifications.channel_operation_key.strip())
    delivered: list[str] = []
    for user in container.users():
        uid = user.get("id") or ""
        if not uid or not user.get("active", True) or sent.get(uid) == today:
            continue
        body = build_digest(container, user, now=now, actions=actions, intake=intake, projects=projects)
        if body is None:
            continue
        await container.notifier.notify([uid], "info", TITLE, body, external=external)
        sent[uid] = today
        delivered.append(uid)
        # Saved after each user: a crash mid-run never re-sends to those already served.
        container.store.put_singleton(STATE, {"last_run": state.get("last_run") or "", "sent": sent})

    known = {u.get("id") for u in container.users()}
    container.store.put_singleton(STATE, {"last_run": today,
                                          "sent": {k: v for k, v in sent.items() if k in known}})
    if delivered:
        log.info("Daily digest sent to %d user(s)", len(delivered))
    return delivered
