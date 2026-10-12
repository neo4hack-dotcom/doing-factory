"""Risk radar: the deterministic score, its levels and its plain-English reasons."""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

from app.models import Risk
from app.risk import compute_risk, level_for
from app.util import to_iso

NOW = datetime(2026, 10, 12, 12, 0, tzinfo=timezone.utc)


def ago(**kw) -> str:
    return to_iso(NOW - timedelta(**kw))


def ahead(**kw) -> str:
    return to_iso(NOW + timedelta(**kw))


def step(id: str, status: str = "pending", type: str = "ai_task", **kw) -> dict:
    return {"id": id, "name": kw.pop("name", id.replace("_", " ").title()), "type": type, "status": status, **kw}


def project(*steps: dict, status: str = "active", **kw) -> dict:
    return {"id": "prj_1", "key": "UC-0001", "status": status,
            "stages": [{"id": "s1", "name": "Stage", "status": "active", "steps": list(steps)}], **kw}


def test_clean_and_finished_projects_score_zero():
    healthy = compute_risk(project(step("a", "done"), step("b", "waiting_human", started_at=ago(hours=1))), NOW)
    assert healthy == {"score": 0, "level": "low", "reasons": [], "computed_at": to_iso(NOW)}
    for status in ("done", "cancelled"):
        finished = compute_risk(project(step("a", "failed"), status=status), NOW)
        assert finished["score"] == 0 and finished["reasons"] == []
    Risk.model_validate(healthy)


def test_levels_follow_the_thresholds():
    assert [level_for(s) for s in (0, 29, 30, 59, 60, 100)] == ["low", "low", "medium", "medium", "high", "high"]


def test_failed_steps_and_blocked_project():
    one = compute_risk(project(step("jira_epic", "failed", name="Jira epic"), status="blocked"), NOW)
    assert one["score"] == 30 and one["level"] == "medium"
    assert one["reasons"] == ["Step 'Jira epic' failed"]          # blocked is explained by the failure

    two = compute_risk(project(step("a", "failed"), step("b", "failed")), NOW)
    assert two["score"] == 40 and two["reasons"][0].startswith("2 steps failed")

    blocked = compute_risk(project(step("a", "waiting_human"), status="blocked"), NOW)
    assert blocked["reasons"] == ["The project is blocked"] and blocked["score"] == 25

    failed = compute_risk(project(step("a", "rejected"), status="failed"), NOW)
    assert failed["level"] == "high" and "The project has failed" in failed["reasons"]


def test_sla_breaches_and_steps_close_to_their_sla():
    p = project(
        step("a", "waiting_approval", due_at=ago(hours=2), started_at=ago(hours=30)),
        step("b", "waiting_human", sla_breached=True, due_at=ago(hours=1), started_at=ago(hours=20)),
        step("c", "waiting_human", started_at=ago(hours=9), due_at=ahead(hours=1)),    # 90 % of its SLA used
        step("d", "done", due_at=ago(days=3), sla_breached=True),                      # finished: not open
    )
    risk = compute_risk(p, NOW)
    assert risk["reasons"][0] == "2 steps past SLA (A, B)"
    assert "1 step close to its SLA" in risk["reasons"]
    assert risk["score"] == 30 + 5

    capped = compute_risk(project(*[step(f"s{i}", "waiting_human", due_at=ago(hours=1)) for i in range(6)]), NOW)
    assert capped["score"] == 35                                               # per-signal cap


def test_due_date_pressure():
    nine_left = [step(f"s{i}") for i in range(9)]
    soon = compute_risk(project(*nine_left, due_date=ahead(days=3, hours=1)), NOW)
    assert soon["reasons"] == ["Due in 3 days with 9 steps remaining"] and soon["score"] == 20

    late = compute_risk(project(step("a"), step("b", "done"), due_date=to_iso(NOW - timedelta(days=2))), NOW)
    assert late["reasons"] == ["Past its due date by 2 days with 1 step remaining"] and late["score"] == 30

    # A plain date means "by the end of that day": due today, one step left, a relaxed pace.
    today = compute_risk(project(step("a"), due_date=NOW.date().isoformat()), NOW)
    assert today["reasons"] == ["Due today with 1 step remaining"]

    relaxed = compute_risk(project(step("a"), due_date=ahead(days=30)), NOW)
    assert relaxed["score"] == 0
    everything_done = compute_risk(project(step("a", "done"), due_date=ago(days=5)), NOW)
    assert everything_done["score"] == 0


def test_rejections_counted_once_across_approvals_and_trace():
    rejected = {"user_id": "usr_1", "role": "sponsor", "decision": "rejected", "at": ago(hours=1)}
    trace = [{"kind": "human", "text": "Alice rejected: scope unclear", "data": {"decision": "rejected"}},
             {"kind": "human", "text": "Paul approved"},
             {"kind": "info", "text": "Reopened after rejection", "data": {"decision": "rejected"}}]
    p = project(step("signoff", "waiting_approval", type="approval", approvals=[rejected], trace=trace))
    risk = compute_risk(p, NOW)
    assert "Rejected twice at approval" in risk["reasons"]      # max(1 listed, 2 traced)
    assert risk["score"] == 20

    # A rejection mentioned in the trace of a non-approval step is not an approval rejection.
    other = project(step("spec", "waiting_human", type="human_form", trace=[{"kind": "human", "text": "rejected"}]))
    assert compute_risk(other, NOW)["score"] == 0


def test_stale_waits_without_sla():
    p = project(step("a", "waiting_human", started_at=ago(days=6)), step("b", "waiting_human", started_at=ago(days=1)))
    assert compute_risk(p, NOW)["reasons"] == ["1 step waiting on people for over 5 days"]


def test_children_from_fan_out_output_or_explicit_list():
    fan = step("deliver", "waiting_children", type="fan_out",
               output={"children": [{"id": "c1", "key": "MCP-0001", "status": "blocked"},
                                    {"id": "c2", "key": "MCP-0002", "status": "active"}]})
    risk = compute_risk(project(fan), NOW)
    assert risk["reasons"] == ["1 child project blocked or failed (MCP-0001)"] and risk["score"] == 15

    explicit = [{"key": "MCP-0001", "status": "active", "risk": {"level": "high"}},
                {"key": "MCP-0002", "status": "done", "risk": {"level": "high"}}]
    risk = compute_risk(project(fan), NOW, children=explicit)
    assert risk["reasons"] == ["1 child project at high risk (MCP-0001)"]


def test_score_is_capped_and_reasons_are_heaviest_first():
    p = project(step("a", "failed"), step("b", "failed"), step("c", "failed"),
                step("d", "waiting_human", due_at=ago(hours=1)), step("e", "waiting_human", due_at=ago(hours=1)),
                step("f", "waiting_human", due_at=ago(hours=1)), status="failed", due_date=ago(days=4))
    risk = compute_risk(p, NOW.replace(tzinfo=None))   # a naive `now` is taken as UTC
    assert risk["score"] == 100 and risk["level"] == "high"
    assert risk["reasons"][0] == "The project has failed"
    assert risk["computed_at"] == to_iso(NOW)
