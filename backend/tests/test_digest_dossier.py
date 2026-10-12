"""Daily digest (app/digest.py + the scheduler's digest job) and the project dossier
(app/dossier.py, GET /api/projects/{id}/dossier), on real projects driven through the engine
with the deterministic fakes of test_engine (no LLM, no MCP server)."""
from __future__ import annotations

from datetime import datetime, timezone

from fastapi.testclient import TestClient

from app import digest, dossier
from app.scheduler import Scheduler
from app.util import new_id
from test_engine import env, new_mcp, run, settle, step, to_signoff  # noqa: F401 — `env` is a fixture

MONDAY_0930_PARIS = datetime(2026, 10, 12, 7, 30, tzinfo=timezone.utc)     # CEST = UTC+2
MONDAY_0830_PARIS = datetime(2026, 10, 12, 6, 30, tzinfo=timezone.utc)
MONDAY_1900_PARIS = datetime(2026, 10, 12, 17, 0, tzinfo=timezone.utc)
TUESDAY_0915_PARIS = datetime(2026, 10, 13, 7, 15, tzinfo=timezone.utc)
SATURDAY_1000_PARIS = datetime(2026, 10, 10, 8, 0, tzinfo=timezone.utc)


def configure(c, **notifications) -> None:
    stored = c.store.get_singleton("settings", {})
    c.store.put_singleton("settings", {
        **stored,
        "notifications": {**(stored.get("notifications") or {}), "digest_enabled": True, **notifications},
        "scheduler": {**(stored.get("scheduler") or {}), "timezone": "Europe/Paris",
                      "business_hours_start": 9, "business_hours_end": 18},
    })


def digests(env, user_key: str) -> list[dict]:
    return [n for n in env.c.notifier.list(env.u[user_key]) if n["title"] == digest.TITLE]


# ---------------------------------------------------------------------------------- digest

def test_digest_is_due_on_business_days_within_business_hours(env):
    c = env.c
    assert digest.due_day(c, MONDAY_0930_PARIS) is None                     # off by default
    configure(c)
    assert str(digest.due_day(c, MONDAY_0930_PARIS)) == "2026-10-12"
    assert digest.due_day(c, MONDAY_0830_PARIS) is None                     # before business hours
    assert digest.due_day(c, MONDAY_1900_PARIS) is None                     # after: not a "morning" digest
    assert digest.due_day(c, SATURDAY_1000_PARIS) is None                   # weekend
    assert str(digest.due_day(c, datetime(2026, 10, 12, 9, 30))) == "2026-10-12"   # naive = UTC (11:30 Paris)


def test_digest_sends_once_per_day_and_skips_people_with_nothing_pending(env):
    async def scenario():
        c = env.c
        p = await new_mcp(env)                                              # Paul: the spec form waits on him
        configure(c)
        assert await digest.send_due_digests(c, MONDAY_0830_PARIS) == []   # not yet
        assert await digest.send_due_digests(c, SATURDAY_1000_PARIS) == []
        assert not digests(env, "paul")

        sent = await digest.send_due_digests(c, MONDAY_0930_PARIS)
        assert env.u["paul"] in sent
        assert env.u["karim"] not in sent and not digests(env, "karim")    # nothing pending → nothing sent
        [note] = digests(env, "paul")
        assert note["kind"] == "info" and note["read"] is False
        assert "1 action waiting for you" in note["body"] and "1 form to complete" in note["body"]
        assert "overdue" not in note["body"].split("\n")[0]

        # Same day, later tick, or a restarted scheduler: never a second digest.
        assert await digest.send_due_digests(c, MONDAY_0930_PARIS.replace(hour=12)) == []
        tasks = Scheduler(c)._dispatch_digest(MONDAY_0930_PARIS.replace(hour=13))
        for task in tasks:
            await task
        assert len(digests(env, "paul")) == 1
        assert c.store.get_singleton(digest.STATE, {})["last_run"] == "2026-10-12"

        # The next business day brings the next digest, through the scheduler's job. (Read the
        # first one: the notifier folds identical unread bells sent within minutes of each other.)
        c.notifier.mark_read(env.u["paul"], all=True)
        tasks = Scheduler(c)._dispatch_digest(TUESDAY_0915_PARIS)
        assert len(tasks) == 1
        await tasks[0]
        assert len(digests(env, "paul")) == 2
        assert step(c.engine.get(p["id"]), "spec")["status"] == "waiting_human"
    run(scenario())


def test_digest_disabled_or_weekend_dispatches_nothing(env):
    async def scenario():
        c = env.c
        await new_mcp(env)
        assert Scheduler(c)._dispatch_digest(MONDAY_0930_PARIS) == []      # digest_enabled is False
        configure(c)
        assert Scheduler(c)._dispatch_digest(SATURDAY_1000_PARIS) == []
        assert not digests(env, "paul")
    run(scenario())


def test_digest_lists_overdue_items_high_risk_projects_and_intake(env, monkeypatch):
    async def scenario():
        c = env.c
        p = await new_mcp(env)
        doc = c.store.get("projects", p["id"])
        spec = step(doc, "spec")
        spec["due_at"] = "2026-10-01T09:00:00Z"
        doc["risk"] = {"score": 80, "level": "high", "reasons": ["Spec overdue by 11 days"], "computed_at": None}
        c.store.put("projects", doc)
        c.store.put("intake", {"id": new_id("int"), "title": "Payments copilot", "status": "new",
                               "detected_at": "2026-10-11T08:00:00Z"})

        sent: list[dict] = []

        async def fake_run(key, payload, **kw):
            sent.append({"key": key, **payload})
            return {"ok": True}

        monkeypatch.setattr(c.ops, "run", fake_run)
        configure(c, channel_operation_key="notify.email")
        delivered = await digest.send_due_digests(c, MONDAY_0930_PARIS)

        body = digests(env, "paul")[0]["body"]
        first = body.split("\n")[0]
        assert "1 overdue" in first and "1 of your projects at high risk" in first and "1 intake item waiting" in first
        assert f"— {p['key']} Nostro Balances MCP" in body                  # the overdue item, with its project
        assert "Spec overdue by 11 days" in body and "1 intake item to triage" in body
        # Alice sponsors the risky project but has no inbox item: she still hears about it.
        assert env.u["alice"] in delivered
        alice = digests(env, "alice")[0]["body"]
        assert "high risk" in alice and "Your inbox" not in alice
        assert env.u["karim"] not in delivered
        # One external message per recipient, same subject, to their own address.
        assert {s["key"] for s in sent} == {"notify.email"}
        assert all(s["subject"] == digest.TITLE and len(s["to"]) == 1 for s in sent)
        assert ["paul.durand@doing.ai"] in [s["to"] for s in sent]
    run(scenario())


# ---------------------------------------------------------------------------------- dossier

def test_dossier_assembles_the_audit_pack_from_real_data(env):
    async def scenario():
        e, u = env.e, env.u
        env.fakes.gate_blocks = True
        p = await to_signoff(env)
        pid = p["id"]
        await e.decide(pid, "spec_signoff", u["alice"], "approved", "Good to go")
        await e.decide(pid, "spec_signoff", u["sofia"], "approved")
        await settle(env)
        await e.submit_estimate(pid, "estimate", u["sofia"], {"value": 5, "breakdown": [{"item": "x", "value": 5}]})
        await settle(env)
        await e.confirm(pid, "jira_backlog", u["sofia"], True)
        await settle(env)
        await e.confirm(pid, "create_stories", u["paul"], True)
        await settle(env)
        await e.complete_step(pid, "development", u["karim"])
        await settle(env)
        await e.gate_action(pid, "compliance_gate", u["chloe"], "override", "Compensating control in place")
        await settle(env)
        return e.get(pid)

    project = run(scenario())
    c = env.c
    md = dossier.build_dossier(c, project, generated_at="2026-10-12T09:00:00Z")
    assert md == dossier.build_dossier(c, project, generated_at="2026-10-12T09:00:00Z")   # deterministic
    assert md.startswith(f"# Project dossier — {project['key']} · Nostro Balances MCP\n")
    for section in ("## Summary", "## Description and inputs", "## Step log", "## Artifacts", "## Approvals trail",
                    "## Quality-gate checks", "## Links", "## Child projects", "## Audit trail"):
        assert section in md, section
    assert "| Sponsor | Alice Martin |" in md and "| Owner | Paul Durand |" in md
    assert "| Team | MCP Factory Squad |" in md
    assert "| mcp_name | Nostro Balances MCP |" in md
    assert "completed by Paul Durand at" in md                               # who completed the spec form
    assert "Form · nfr: p95 < 2 s" in md
    assert "| Alice Martin | approved | Good to go |" in md
    assert "Chloé Bernard: Compensating control in place" in md
    assert "| jira | " in md and "MCPF-7" in md
    assert "Hash-chain verification: **intact**" in md
    events = c.store.list_events(project_id=project["id"], limit=None)
    assert f"{len(events)} events for this project, oldest first." in md
    assert "gate.overridden" in md and "approval.approved" in md
    assert "Version 1 (1 version in total)" in md
    # Embedded artifact headings are pushed below the dossier's own sections.
    assert "\n# " not in md.split("\n", 1)[1]
    assert dossier.dossier_filename(project) == f"{project['key']}-dossier.md"

    # Tampering with the audit log shows up in the pack.
    victim = events[-1]["id"]
    with c.store.lock:
        c.store._conn().execute("UPDATE events SET actor = 'mallory' WHERE id = ?", (victim,))
    tampered = dossier.build_dossier(c, project, generated_at="2026-10-12T09:00:00Z")
    assert f"Hash-chain verification: **BROKEN** at event `{victim}`" in tampered
    assert "belongs to this project" in tampered


def test_dossier_endpoint(env):
    async def scenario():
        return await new_mcp(env)

    project = run(scenario())
    from app.main import app

    api = TestClient(app)                     # no lifespan: the env fixture already set the container up
    res = api.get(f"/api/projects/{project['id']}/dossier")
    assert res.status_code == 200
    body = res.json()
    assert body["filename"] == f"{project['key']}-dossier.md"
    assert body["markdown"].startswith(f"# Project dossier — {project['key']}")
    assert "_No approval decisions recorded._" in body["markdown"] and "_No child projects._" in body["markdown"]
    assert api.get("/api/projects/prj_missing/dossier").status_code == 404
