"""KPI computation (SPEC §10): every figure derived from what the store really holds —
projects (stage/step runs, approvals, checks, links, metrics), the audit events, the LLM
call log and the intake queue. Nothing is estimated or padded: a ratio or an average with
no data behind it is None (the UI shows "—"), never 0 % or 0 days.

Units: `*_days` / `*_hours` / `*_ms` as named; `sla.on_time_pct` is a percentage (0-100);
`*_rate` and `*_share` are fractions (0-1). "In the period" means within the last `days`
days; status counters (active, waiting, blocked, open tasks…) are the current state.

Approvals and quality gates read the audit events first, because a reopen clears a step's
approvals and a re-run replaces its checks; the step documents fill in what no event
recorded (so the figures stay right even for history written before an event existed).
"""
from __future__ import annotations

import math
import statistics
from collections import Counter, defaultdict
from datetime import date, datetime, timedelta, timezone
from typing import TYPE_CHECKING, Any, Callable, Iterator

from app.inbox import IN_FLIGHT, OpenAction, items_for_user, new_intake, open_actions
from app.models import (KpiApprovalRole, KpiApprovals, KpiAutomation, KpiFunnel, KpiJira, KpiLeadTime,
                        KpiLeadTimeByBlueprint, KpiLlm, KpiLlmDay, KpiLlmRole, KpiQuality, KpiRuleFail, Kpis, KpiSla,
                        KpiStage, KpiTotals, KpiTypeCount, KpiWeek, KpiWorkload)
from app.util import parse_iso, to_iso

if TYPE_CHECKING:  # pragma: no cover
    from app.deps import Container

MAX_DAYS = 365
THROUGHPUT_WEEKS = 12
TOP_RULES = 5
# Step types that are automation (AI, MCP, orchestration) — the rest is human work.
AI_TYPES = frozenset({"ai_task", "mcp_operation", "agent_task", "quality_gate", "notify", "fan_out", "wait_for"})
HUMAN_TYPES = frozenset({"human_form", "approval", "estimation"})
SLA_OPEN = frozenset({"running", "waiting_human", "waiting_approval", "waiting_children", "waiting_external"})

InPeriod = Callable[[Any], bool]


def compute_kpis(container: "Container", days: int = 30) -> dict:
    days = max(1, min(int(days or 30), MAX_DAYS))
    now = datetime.now(timezone.utc)
    since = now - timedelta(days=days)

    def in_period(ts: Any) -> bool:
        moment = parse_iso(ts)
        return moment is not None and since <= moment <= now + timedelta(minutes=5)

    projects = container.store.list("projects")
    intake = container.store.list("intake")
    actions = open_actions(container, projects)
    kpis = Kpis(
        generated_at=to_iso(now), days=days,
        totals=_totals(projects, intake, actions, in_period),
        lead_time=_lead_time(projects, in_period),
        throughput=_throughput(projects, now),
        stages=_stages(projects, in_period),
        sla=_sla(projects, now, in_period),
        approvals=_approvals(container, projects, in_period),
        automation=_automation(projects, in_period),
        quality=_quality(container, projects, in_period),
        jira=KpiJira(issues_created=sum(1 for p in projects for link in p.get("links") or []
                                        if link.get("kind") == "jira" and in_period(link.get("created_at")))),
        llm=_llm(container, since, now),
        funnel=_funnel(projects, intake, in_period),
        workload=_workload(container, actions),
    )
    return kpis.model_dump()


# ---------------------------------------------------------------------------------- sections

def _totals(projects: list[dict], intake: list[dict], actions: list[OpenAction], in_period: InPeriod) -> KpiTotals:
    status = Counter(p.get("status") for p in projects)
    return KpiTotals(
        active=status["active"], waiting=status["waiting"], blocked=status["blocked"],
        done_period=sum(1 for p in projects if p.get("status") == "done" and in_period(p.get("completed_at"))),
        cancelled=sum(1 for p in projects if p.get("status") == "cancelled"
                      and in_period(p.get("completed_at") or p.get("updated_at"))),
        at_risk=sum(1 for p in projects if p.get("status") in IN_FLIGHT and (p.get("risk") or {}).get("level") == "high"),
        intake_new=sum(1 for i in intake if i.get("status") == "new"),
        open_tasks=len(actions),
        pending_approvals=sum(1 for a in actions if a.kind == "approval"),
        children_in_flight=sum(1 for p in projects if p.get("parent_id") and p.get("status") in IN_FLIGHT),
    )


def _lead_time(projects: list[dict], in_period: InPeriod) -> KpiLeadTime:
    """Created → completed, for projects finished in the period."""
    by_blueprint: dict[str, list[float]] = defaultdict(list)
    values: list[float] = []
    for p in projects:
        if p.get("status") != "done" or not in_period(p.get("completed_at")):
            continue
        hours = _hours(p.get("created_at") or p.get("started_at"), p.get("completed_at"))
        if hours is None:
            continue
        values.append(hours / 24)
        by_blueprint[p.get("blueprint_name") or p.get("blueprint_id") or "Unknown"].append(hours / 24)
    if not values:
        return KpiLeadTime()
    rows = [KpiLeadTimeByBlueprint(blueprint=name, avg_days=_r(statistics.fmean(v)), count=len(v))
            for name, v in by_blueprint.items()]
    rows.sort(key=lambda r: (-r.count, r.blueprint))
    return KpiLeadTime(avg_days=_r(statistics.fmean(values)), median_days=_r(statistics.median(values)),
                       p90_days=_r(_percentile(values, 0.9)), by_blueprint=rows)


def _throughput(projects: list[dict], now: datetime) -> list[KpiWeek]:
    """Projects created / completed per ISO week, the last 12 weeks (oldest first)."""
    if not projects:
        return []
    this_monday = now.date() - timedelta(days=now.weekday())
    mondays = [this_monday - timedelta(weeks=i) for i in range(THROUGHPUT_WEEKS - 1, -1, -1)]
    created: Counter[date] = Counter()
    completed: Counter[date] = Counter()
    for p in projects:
        if (moment := parse_iso(p.get("created_at"))) is not None:
            created[_monday(moment)] += 1
        if p.get("status") == "done" and (moment := parse_iso(p.get("completed_at"))) is not None:
            completed[_monday(moment)] += 1
    return [KpiWeek(week=_week_label(m), created=created[m], completed=completed[m]) for m in mondays]


def _stages(projects: list[dict], in_period: InPeriod) -> list[KpiStage]:
    """Average duration of stage runs finished in the period, and the part of it spent
    waiting on people (human steps, started → completed) — the bottleneck heatmap."""
    runs: dict[tuple[str, str], list[tuple[float, float]]] = {}
    for p in projects:
        blueprint = p.get("blueprint_name") or p.get("blueprint_id") or "Unknown"
        for stage in p.get("stages") or []:
            if stage.get("status") != "done" or not in_period(stage.get("completed_at")):
                continue
            hours = _hours(stage.get("started_at"), stage.get("completed_at"))
            if hours is None:
                continue
            wait = sum(h for s in stage.get("steps") or [] if s.get("type") in HUMAN_TYPES
                       and (h := _hours(s.get("started_at"), s.get("completed_at"))) is not None)
            runs.setdefault((blueprint, stage.get("name") or stage.get("id") or "Stage"), []).append((hours, wait))
    return [KpiStage(blueprint=bp, stage=st, avg_hours=_r(statistics.fmean(h for h, _ in v)),
                     avg_wait_hours=_r(statistics.fmean(w for _, w in v)), count=len(v))
            for (bp, st), v in runs.items()]


def _sla(projects: list[dict], now: datetime, in_period: InPeriod) -> KpiSla:
    on_time = finished = breached_open = breached_done = 0
    for p, step in _all_steps(projects):
        due = parse_iso(step.get("due_at"))
        if due is None:
            continue
        status = step.get("status")
        if status == "done" and in_period(step.get("completed_at")):
            finished += 1
            completed = parse_iso(step.get("completed_at"))
            late = bool(step.get("sla_breached")) or (completed is not None and completed > due)
            on_time += 0 if late else 1
            breached_done += 1 if late else 0
        elif status in SLA_OPEN and p.get("status") in IN_FLIGHT and (step.get("sla_breached") or due < now):
            breached_open += 1
    return KpiSla(on_time_pct=_r(100 * on_time / finished, 1) if finished else None,
                  breached_open=breached_open, breached_total=breached_open + breached_done)


def _approvals(container: "Container", projects: list[dict], in_period: InPeriod) -> KpiApprovals:
    steps = {(p.get("id"), s.get("id")): s for p, s in _all_steps(projects) if s.get("type") == "approval"}
    roles_of = {u.get("id"): set(u.get("roles") or []) for u in container.users()}
    decisions: list[tuple[str, float | None, bool]] = []   # (role, hours, rejected)
    from_events: set[tuple] = set()
    events = container.store.list_events(kinds=["approval.approved", "approval.rejected"], limit=None)
    for ev in events:
        if not in_period(ev.get("ts")):
            continue
        rejected = ev.get("kind") == "approval.rejected"
        data = ev.get("data") or {}
        user = data.get("user_id") or ev.get("actor") or ""
        step = steps.get((ev.get("project_id"), ev.get("step_id"))) or {}
        from_events.add((ev.get("project_id"), ev.get("step_id"), user, "rejected" if rejected else "approved"))
        role = data.get("role") or _approver_role(step, roles_of.get(user, set()))
        hours = data.get("wait_hours") if isinstance(data.get("wait_hours"), (int, float)) \
            else _hours(step.get("started_at"), ev.get("ts"))
        decisions.append((role, hours, rejected))
    for (pid, sid), step in steps.items():
        for approval in step.get("approvals") or []:
            key = (pid, sid, approval.get("user_id") or "", approval.get("decision"))
            if key in from_events or not in_period(approval.get("at")):
                continue
            role = approval.get("role") or _approver_role(step, roles_of.get(approval.get("user_id"), set()))
            decisions.append((role, _hours(step.get("started_at"), approval.get("at")),
                              approval.get("decision") == "rejected"))
    if not decisions:
        return KpiApprovals()
    by_role: dict[str, list[tuple[float | None, bool]]] = defaultdict(list)
    for role, hours, rejected in decisions:
        by_role[role].append((hours, rejected))
    rows = []
    for role, items in by_role.items():
        timed = [h for h, _ in items if h is not None]
        rows.append(KpiApprovalRole(role=role, avg_hours=_r(statistics.fmean(timed)) if timed else 0,
                                    count=len(items), rejected=sum(1 for _, r in items if r)))
    rows.sort(key=lambda r: (-r.count, r.role))
    timed = [h for _, h, _ in decisions if h is not None]
    return KpiApprovals(avg_hours=_r(statistics.fmean(timed)) if timed else None,
                        rejection_rate=_r(sum(1 for *_, r in decisions if r) / len(decisions), 3), by_role=rows)


def _automation(projects: list[dict], in_period: InPeriod) -> KpiAutomation:
    """Steps completed in the period, split AI vs human: completed by "ai", or an
    automation step type (an AI draft a person approved is still AI work)."""
    by_type: dict[str, list[int]] = {}
    ai_steps = human_steps = 0
    for _, step in _all_steps(projects):
        if step.get("status") != "done" or not in_period(step.get("completed_at")):
            continue
        is_ai = step.get("completed_by") == "ai" or step.get("type") in AI_TYPES
        row = by_type.setdefault(step.get("type") or "unknown", [0, 0])
        row[0] += 1
        row[1] += 1 if is_ai else 0
        ai_steps += 1 if is_ai else 0
        human_steps += 0 if is_ai else 1
    total = ai_steps + human_steps
    touched = [p for p in projects if p.get("status") in IN_FLIGHT or in_period(p.get("created_at"))
               or in_period(p.get("completed_at"))]
    hours_saved = sum(float((p.get("metrics") or {}).get("hours_saved") or 0) for p in touched)
    rows = [KpiTypeCount(type=t, count=c, ai=a) for t, (c, a) in by_type.items()]
    rows.sort(key=lambda r: (-r.count, r.type))
    return KpiAutomation(ai_steps=ai_steps, human_steps=human_steps,
                         ai_share=_r(ai_steps / total, 3) if total else None, hours_saved=_r(hours_saved, 1),
                         by_type=rows)


def _quality(container: "Container", projects: list[dict], in_period: InPeriod) -> KpiQuality:
    gates = {(p.get("id"), s.get("id")): s for p, s in _all_steps(projects) if s.get("type") == "quality_gate"}
    events = container.store.list_events(kinds=["gate.passed", "gate.failed"], limit=None)
    events.reverse()   # oldest first: the first evaluation of a gate decides "first pass"
    first: dict[tuple, dict] = {}
    runs = 0
    for ev in events:
        key = (ev.get("project_id"), ev.get("step_id"))
        first.setdefault(key, ev)
        runs += 1 if in_period(ev.get("ts")) else 0
    evaluated = passed = 0
    for ev in first.values():
        if in_period(ev.get("ts")):
            evaluated += 1
            passed += 1 if ev.get("kind") == "gate.passed" else 0
    fails: Counter[str] = Counter()
    titles: dict[str, str] = {}
    for key, step in gates.items():
        if not step.get("checks") or not in_period(step.get("completed_at") or step.get("started_at")):
            continue
        if key not in first:   # evaluated without an event: judge from the step itself
            runs += 1
            evaluated += 1
            output = step.get("output") if isinstance(step.get("output"), dict) else {}
            passed += 1 if (step.get("status") == "done" and output.get("passed") and not output.get("overridden")
                            and int(step.get("attempts") or 0) <= 1) else 0
        for check in step["checks"]:
            if isinstance(check, dict) and check.get("status") == "fail":
                code = check.get("code") or check.get("rule_id") or "?"
                fails[code] += 1
                titles.setdefault(code, check.get("title") or "")
    return KpiQuality(gates_run=runs, first_pass_rate=_r(passed / evaluated, 3) if evaluated else None,
                      top_failing_rules=[KpiRuleFail(code=code, title=titles.get(code, ""), fails=n)
                                         for code, n in sorted(fails.items(), key=lambda kv: (-kv[1], kv[0]))[:TOP_RULES]])


def _llm(container: "Container", since: datetime, now: datetime) -> KpiLlm:
    calls = container.store.list_llm_calls(since=to_iso(since))
    if not calls:
        return KpiLlm()
    by_role: dict[str, list[int]] = defaultdict(list)
    per_day: dict[str, list[int]] = defaultdict(lambda: [0, 0])
    for call in calls:
        by_role[call.get("role") or "unknown"].append(int(call.get("latency_ms") or 0))
        day = (call.get("ts") or "")[:10]
        per_day[day][0] += 1
        per_day[day][1] += int(call.get("tokens_in") or 0) + int(call.get("tokens_out") or 0)
    roles = [KpiLlmRole(role=role, calls=len(lat), avg_latency_ms=_r(statistics.fmean(lat), 0))
             for role, lat in by_role.items()]
    roles.sort(key=lambda r: (-r.calls, r.role))
    days, cursor = [], since.date()
    while cursor <= now.date():
        label = cursor.isoformat()
        days.append(KpiLlmDay(day=label, calls=per_day[label][0], tokens=per_day[label][1]))
        cursor += timedelta(days=1)
    return KpiLlm(calls=len(calls), tokens_in=sum(int(c.get("tokens_in") or 0) for c in calls),
                  tokens_out=sum(int(c.get("tokens_out") or 0) for c in calls),
                  avg_latency_ms=_r(statistics.fmean(int(c.get("latency_ms") or 0) for c in calls), 0),
                  error_rate=_r(sum(1 for c in calls if not c.get("ok")) / len(calls), 3), by_role=roles,
                  by_day=days)


def _funnel(projects: list[dict], intake: list[dict], in_period: InPeriod) -> KpiFunnel:
    """The cohort detected in the period — intake items plus projects a watcher started
    directly — and how far it got: accepted, now in flight, done."""
    cohort = [i for i in intake if in_period(i.get("detected_at"))]
    auto = [p for p in projects if (p.get("source") or {}).get("type") == "watcher"
            and not (p.get("source") or {}).get("intake_id") and in_period(p.get("created_at"))]
    linked = {i.get("project_id") for i in cohort if i.get("status") == "accepted" and i.get("project_id")}
    linked |= {p.get("id") for p in auto}
    status = {p.get("id"): p.get("status") for p in projects}
    return KpiFunnel(detected=len(cohort) + len(auto),
                     accepted=sum(1 for i in cohort if i.get("status") == "accepted") + len(auto),
                     active=sum(1 for pid in linked if status.get(pid) in IN_FLIGHT),
                     done=sum(1 for pid in linked if status.get(pid) == "done"))


def _workload(container: "Container", actions: list[OpenAction]) -> list[KpiWorkload]:
    """Open inbox items per person (same rules as their inbox), busiest first."""
    intake = new_intake(container)
    now = datetime.now(timezone.utc)
    rows = []
    for user in container.users():
        if not user.get("active", True) or not user.get("id"):
            continue
        items = items_for_user(container, user, actions, intake, now)
        if items:
            rows.append(KpiWorkload(user_id=user["id"], open_tasks=len(items),
                                    overdue=sum(1 for i in items if i["overdue"])))
    rows.sort(key=lambda r: (-r.open_tasks, -r.overdue, r.user_id))
    return rows


# ---------------------------------------------------------------------------------- helpers

def _all_steps(projects: list[dict]) -> Iterator[tuple[dict, dict]]:
    for p in projects:
        for stage in p.get("stages") or []:
            for step in stage.get("steps") or []:
                yield p, step


def _approver_role(step: dict, user_roles: set[str]) -> str:
    """The approver slot a decision filled, when the event did not say: the first listed
    approver role the user holds."""
    for approver in (step.get("config") or {}).get("approvers") or []:
        role = (approver or {}).get("role") if isinstance(approver, dict) else None
        if role and role in user_roles:
            return role
    return "unknown"


def _hours(start: Any, end: Any) -> float | None:
    a, b = parse_iso(start), parse_iso(end)
    if a is None or b is None or b < a:
        return None
    return (b - a).total_seconds() / 3600


def _percentile(values: list[float], q: float) -> float:
    """Nearest-rank percentile: always an observed value, never an interpolation."""
    ordered = sorted(values)
    rank = max(1, math.ceil(round(q * len(ordered), 9)))   # round: 0.9 * 10 must be 9, not 9.000000000000002
    return ordered[min(rank, len(ordered)) - 1]


def _monday(moment: datetime) -> date:
    day = moment.astimezone(timezone.utc).date()
    return day - timedelta(days=day.weekday())


def _week_label(monday: date) -> str:
    year, week, _ = monday.isocalendar()
    return f"{year}-W{week:02d}"


def _r(value: float, digits: int = 2) -> float:
    return round(float(value), digits)
