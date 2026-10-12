"""Deterministic project risk score (0-100) with the reasons behind it (SPEC §3.5, "Risk radar").

No LLM here: the number must be reproducible and explainable. The AI "explain risk" action
narrates these reasons; it never invents the score. Each signal adds points up to its own
cap, so a single noisy factor (ten steps a few minutes past SLA) cannot max the score alone.
Reasons are short English sentences the UI shows verbatim, heaviest first.

Signals: failed / blocked work, SLA breaches and steps close to their SLA, long waits on
steps without an SLA, rejections at approval steps, due-date pressure (days left vs steps
remaining), and child projects in trouble.
"""
from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any

from app.models import Risk
from app.util import parse_iso, to_iso

LOW_BELOW = 30          # score < 30 → low
MEDIUM_BELOW = 60       # score < 60 → medium, else high

TERMINAL = frozenset({"done", "cancelled"})
FINISHED_STEP = frozenset({"done", "skipped"})
OPEN_STEP = frozenset({"running", "waiting_human", "waiting_approval", "waiting_children", "waiting_external"})
HUMAN_WAIT = frozenset({"waiting_human", "waiting_approval"})
TROUBLED_PROJECT = frozenset({"blocked", "failed"})

SLA_WARN_RATIO = 0.75           # an open step that used 75 % of its SLA is "close to its SLA"
STALE_WAIT = timedelta(days=5)  # a human wait without SLA this long is a risk signal of its own

_REJECTED = re.compile(r"\breject(ed|ion)\b", re.IGNORECASE)


def level_for(score: int) -> str:
    return "low" if score < LOW_BELOW else "medium" if score < MEDIUM_BELOW else "high"


def compute_risk(project: dict, now: datetime, children: list[dict] | None = None) -> dict:
    """Risk dict (models.Risk) for `project` at `now`.

    `children` (optional) are the child project documents or summaries; without them the
    statuses recorded in the fan-out step outputs are used, so the score still reflects a
    child that failed even when the caller only has the parent at hand."""
    now = _aware(now)
    if project.get("status") in TERMINAL:
        return Risk(score=0, level="low", reasons=[], computed_at=to_iso(now)).model_dump()

    steps = [step for stage in project.get("stages") or [] for step in stage.get("steps") or []]
    factors: list[tuple[int, str]] = []
    for signal in (_failure, _sla, _stale_waits, _rejections):
        factors.extend(signal(project, steps, now))
    factors.extend(_due_date(project, steps, now))
    factors.extend(_children(project, steps, children))

    factors = [f for f in factors if f[0] > 0]
    factors.sort(key=lambda f: -f[0])   # stable: equal weights keep their signal order
    score = min(100, sum(points for points, _ in factors))
    return Risk(score=score, level=level_for(score), reasons=[reason for _, reason in factors],
                computed_at=to_iso(now)).model_dump()


# ---------------------------------------------------------------------------------- signals

def _failure(project: dict, steps: list[dict], now: datetime) -> list[tuple[int, str]]:
    out: list[tuple[int, str]] = []
    if project.get("status") == "failed":
        out.append((60, "The project has failed"))
    failed = [s for s in steps if s.get("status") == "failed"]
    if failed:
        points = min(45, 30 + 10 * (len(failed) - 1))
        if len(failed) == 1:
            out.append((points, f"Step '{_name(failed[0])}' failed"))
        else:
            out.append((points, f"{len(failed)} steps failed ({_names(failed)})"))
    elif project.get("status") == "blocked":
        out.append((25, "The project is blocked"))
    return out


def _sla(project: dict, steps: list[dict], now: datetime) -> list[tuple[int, str]]:
    breached, close = [], []
    for step in steps:
        if step.get("status") not in OPEN_STEP:
            continue
        due = parse_iso(step.get("due_at"))
        if step.get("sla_breached") or (due is not None and due <= now):
            breached.append(step)
            continue
        started = parse_iso(step.get("started_at"))
        if due is not None and started is not None and due > started:
            ratio = (now - started) / (due - started)
            if ratio >= SLA_WARN_RATIO:
                close.append(step)
    out: list[tuple[int, str]] = []
    if breached:
        what = f"'{_name(breached[0])}'" if len(breached) == 1 else f"({_names(breached)})"
        out.append((min(35, 15 * len(breached)), f"{_plural(len(breached), 'step')} past SLA {what}"))
    if close:
        out.append((min(10, 5 * len(close)),
                    f"{_plural(len(close), 'step')} close to {'its' if len(close) == 1 else 'their'} SLA"))
    return out


def _stale_waits(project: dict, steps: list[dict], now: datetime) -> list[tuple[int, str]]:
    stale = [s for s in steps if s.get("status") in HUMAN_WAIT and not s.get("due_at")
             and (started := parse_iso(s.get("started_at"))) is not None and now - started >= STALE_WAIT]
    if not stale:
        return []
    return [(min(10, 5 * len(stale)), f"{_plural(len(stale), 'step')} waiting on people for over "
                                      f"{STALE_WAIT.days} days")]


def _rejections(project: dict, steps: list[dict], now: datetime) -> list[tuple[int, str]]:
    """Rejections survive a reopen only in the step trace (approvals are cleared), so per
    approval step the larger of "rejections still listed" and "rejections traced" counts."""
    total = 0
    for step in steps:
        if step.get("type") != "approval":
            continue
        listed = sum(1 for a in step.get("approvals") or [] if (a or {}).get("decision") == "rejected")
        traced = sum(1 for entry in step.get("trace") or [] if _is_rejection(entry))
        total += max(listed, traced)
    if not total:
        return []
    return [(min(20, 10 * total), f"Rejected {_times(total)} at approval")]


def _is_rejection(entry: Any) -> bool:
    if not isinstance(entry, dict) or entry.get("kind") not in ("human", "info"):
        return False
    data = entry.get("data")
    if isinstance(data, dict) and data.get("decision") in ("approved", "rejected"):
        return data["decision"] == "rejected"
    return entry.get("kind") == "human" and bool(_REJECTED.search(str(entry.get("text") or "")))


def _due_date(project: dict, steps: list[dict], now: datetime) -> list[tuple[int, str]]:
    raw = project.get("due_date")
    due = parse_iso(raw)
    if due is None:
        return []
    if isinstance(raw, str) and len(raw.strip()) == 10:   # a plain date means "by the end of that day"
        due += timedelta(days=1)
    remaining = sum(1 for s in steps if s.get("status") not in FINISHED_STEP)
    if remaining == 0:
        return []
    left_days = (due - now).total_seconds() / 86400
    steps_txt = _plural(remaining, "step")
    if left_days < 0:
        late = max(1, int(-left_days + 0.999))
        return [(30, f"Past its due date by {_plural(late, 'day')} with {steps_txt} remaining")]
    pace = remaining / max(left_days, 0.5)   # steps that must finish per day
    if left_days <= 7:
        points = 20 if pace >= 2 else 12 if pace >= 1 else 6 if left_days <= 2 else 0
    else:
        points = 10 if pace >= 2 else 0
    if not points:
        return []
    whole = int(left_days)
    when = "Due today" if whole == 0 else "Due tomorrow" if whole == 1 else f"Due in {whole} days"
    return [(points, f"{when} with {steps_txt} remaining")]


def _children(project: dict, steps: list[dict], children: list[dict] | None) -> list[tuple[int, str]]:
    if children is None:   # fall back on the statuses the fan-out steps recorded
        children = [c for s in steps if s.get("type") == "fan_out" and isinstance(s.get("output"), dict)
                    for c in s["output"].get("children") or [] if isinstance(c, dict)]
    troubled = [c for c in children if c.get("status") in TROUBLED_PROJECT]
    risky = [c for c in children if c.get("status") not in TROUBLED_PROJECT and c.get("status") not in TERMINAL
             and ((c.get("risk") or {}).get("level") == "high")]
    out: list[tuple[int, str]] = []
    if troubled:
        out.append((min(30, 15 * len(troubled)),
                    f"{_plural(len(troubled), 'child project')} blocked or failed ({_keys(troubled)})"))
    if risky:
        out.append((min(16, 8 * len(risky)), f"{_plural(len(risky), 'child project')} at high risk ({_keys(risky)})"))
    return out


# ---------------------------------------------------------------------------------- helpers

def _aware(now: datetime | None) -> datetime:
    if now is None:
        return datetime.now(timezone.utc)
    return now.replace(tzinfo=timezone.utc) if now.tzinfo is None else now.astimezone(timezone.utc)


def _name(step: dict) -> str:
    return str(step.get("name") or step.get("id") or "step")


def _names(items: list[dict], limit: int = 3) -> str:
    names = [_name(s) for s in items[:limit]]
    return ", ".join(names) + (f" +{len(items) - limit}" if len(items) > limit else "")


def _keys(items: list[dict], limit: int = 3) -> str:
    keys = [str(c.get("key") or c.get("title") or c.get("id") or "?") for c in items[:limit]]
    return ", ".join(keys) + (f" +{len(items) - limit}" if len(items) > limit else "")


def _plural(n: int, noun: str) -> str:
    return f"{n} {noun}" if n == 1 else f"{n} {noun}s"


def _times(n: int) -> str:
    return {1: "once", 2: "twice"}.get(n, f"{n} times")
