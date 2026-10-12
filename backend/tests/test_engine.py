"""WorkflowEngine (SPEC §5, §5b, §12, §14) driven through the REAL builtin blueprints
(mcp_delivery, use_case_onboarding) with deterministic fakes in place of the AI/MCP executors.

No LLM and no MCP server is involved: every executors_ai entry point is replaced by a fake
that returns what a well-behaved model / tool would. The flow executors (notify, fan_out,
human steps), the notifier, the store, risk and the inbox are the real ones.
"""
from __future__ import annotations

import asyncio
import copy
from types import SimpleNamespace
from typing import Any

import pytest

from app import inbox
from app.engine import executors_ai
from app.engine.context import StepCtx, StepOutcome, fail, ok
from app.errors import EngineError, Forbidden, LLMNotConfigured
from app.models import OperationResult, QualityGateConfig, User
from app.seed.demo import install_demo
from app.util import new_id, now_iso

EPIC = {"key": "MCPF-7", "url": "https://jira.sandbox.local/browse/MCPF-7", "created": True, "project_key": "MCPF"}
SPEC_DRAFT = {
    "summary": "Read-only server exposing nostro balances.", "tools": ["get_balance — balance of an account"],
    "data_source": "Treasury DWH (Oracle)", "data_classification": "Confidential", "contains_pii": False,
    "auth_model": "Service account (read-only)", "consumers": "Liquidity agent", "nfr": "p95 < 2 s",
    "acceptance_criteria": "Returns the balance of a known account", "target_date": "2026-12-01",
}


# ---------------------------------------------------------------------------------- fakes

class Fakes:
    """Deterministic stand-ins for executors_ai. `ai_outputs[step_id]` overrides an ai_task
    output; `failures[step_id]` is a list of errors returned (one per attempt) before success."""

    def __init__(self, env: SimpleNamespace) -> None:
        self.env = env
        self.calls: list[tuple[str, str]] = []
        self.ai_outputs: dict[str, Any] = {}
        self.failures: dict[str, list[tuple[str, bool]]] = {}
        self.missing: list[dict] = []
        self.gate_blocks = False
        self.critic = "Return valid JSON only."

    def _maybe_fail(self, sid: str) -> StepOutcome | None:
        queue = self.failures.get(sid)
        if queue:
            error, retryable = queue.pop(0)
            return fail(error, retryable=retryable)
        return None

    async def exec_ai_task(self, sc: StepCtx) -> StepOutcome:
        sid = sc.step["id"]
        self.calls.append(("ai_task", sid))
        if (failed := self._maybe_fail(sid)) is not None:
            return failed
        cfg = sc.step["config"]
        default = {"team_routing": {"team_id": self.env.squad, "team_name": "MCP Factory Squad",
                                    "jira_project_key": "MCPF", "rationale": "Owns MCP servers"},
                   "jira_backlog": {"issues": [{"project_key": "MCPF", "summary": "Build get_balance",
                                               "description": "d", "issue_type": "Story", "parent_key": "MCPF-7",
                                               "story_points": 3, "labels": ["mcp"]}]},
                   "qualify": {"summary": "Good", "recommendation": "go"}}.get(sid)
        if cfg.get("output") == "json":
            output = self.ai_outputs.get(sid, default or {"summary": sid})
            artifact = {"title": cfg.get("artifact_title") or sid, "kind": "json", "content": str(output), "data": output}
        else:
            text = self.ai_outputs.get(sid, f"# {sid}\nfeedback: {sc.tctx['feedback']}")
            output = {"markdown": text}
            artifact = {"title": cfg.get("artifact_title") or sid, "kind": "markdown", "content": text}
        if cfg.get("review") or sc.autonomy == "supervised":
            return StepOutcome(status="waiting_human", output=output, summary="Draft ready", artifact=artifact,
                               pending_action={"kind": "ai_review", "title": f"Review {sid}",
                                               "payload": {"output": output}})
        return ok(output, f"{sid} done", artifact=artifact)

    async def exec_mcp_operation(self, sc: StepCtx) -> StepOutcome:
        sid = sc.step["id"]
        self.calls.append(("mcp_operation", sid))
        if (failed := self._maybe_fail(sid)) is not None:
            return failed
        key = sc.step["config"]["operation_key"]
        op = sc.container.get_operation_by_key(key)
        if op and op.get("sensitive") and sc.autonomy != "full":
            return StepOutcome(status="waiting_human", summary=f"Waiting for confirmation: {key}",
                               pending_action={"kind": "confirm_operation", "title": f"Confirm: {key}",
                                               "payload": {"operation_key": key, "tool": "t", "args": {"a": 1}}})
        return ok({"done": key}, f"{key} done")

    async def resolve_confirmation(self, sc: StepCtx, approve: bool, payload: dict | None) -> StepOutcome:
        pending = sc.step.get("pending_action") or {}
        self.calls.append(("confirm", sc.step["id"]))
        if pending.get("kind") == "ai_review":
            if approve:
                return ok((payload or {}).get("output", sc.step.get("output")), "Approved")
            return await self.exec_ai_task(sc)
        if not approve:
            return fail("Rejected by a reviewer", retryable=False, ai=False)
        key = pending["payload"]["operation_key"]
        if key == "jira.ensure_epic":
            return ok(dict(EPIC), "Epic MCPF-7", links=[{"kind": "jira", "label": "Epic MCPF-7", "url": EPIC["url"],
                                                          "external_id": "MCPF-7", "step_id": sc.step["id"]}])
        return ok({"done": key}, f"{key} done")

    async def exec_agent_task(self, sc: StepCtx) -> StepOutcome:
        self.calls.append(("agent_task", sc.step["id"]))
        output = {"required": [{"name": m["name"], "capability": m["capability"], "exists": False}
                               for m in self.missing], "missing": copy.deepcopy(self.missing)}
        return ok(output, f"{len(self.missing)} missing", artifact={"title": "Dependency analysis", "kind": "markdown",
                                                                    "content": "analysis", "data": output})

    async def exec_quality_gate(self, sc: StepCtx) -> StepOutcome:
        self.calls.append(("quality_gate", sc.step["id"]))
        status = "fail" if self.gate_blocks else "pass"
        checks = [{"rule_id": "rule_sec01", "code": "SEC-01", "title": "Auth", "severity": "high", "status": status,
                   "evidence": "", "recommendation": "", "overridden_by": "", "override_comment": ""}]
        return executors_ai._gate_verdict(QualityGateConfig.model_validate(sc.step["config"]), checks)

    async def rerun_gate(self, sc: StepCtx, rule_ids: list[str] | None) -> StepOutcome:
        return await self.exec_quality_gate(sc)

    async def draft_form(self, sc: StepCtx, instructions: str = "") -> dict:
        self.calls.append(("draft_form", sc.step["id"]))
        if sc.step["id"] == "spec":
            return dict(SPEC_DRAFT)
        return {"tests_total": 12, "tests_passed": 12, "open_defects": 0, "report": "All green",
                "ready_for_release": True}

    async def suggest_estimate(self, sc: StepCtx) -> dict:
        return {"value": 8, "unit": "days", "confidence": "medium", "breakdown": [{"item": "build", "value": 8}],
                "rationale": "Similar servers took 8 days"}

    async def approval_brief(self, sc: StepCtx) -> str:
        return f"Brief for {sc.step['id']}"

    async def critic_advice(self, sc: StepCtx, error: str) -> str:
        return self.critic

    async def compose_notification(self, sc: StepCtx, cfg: dict) -> tuple[str, str]:
        return cfg.get("subject") or "Subject", "Body"

    def install(self, monkeypatch: pytest.MonkeyPatch) -> None:
        for name in ("exec_ai_task", "exec_mcp_operation", "resolve_confirmation", "exec_agent_task",
                     "exec_quality_gate", "rerun_gate", "draft_form", "suggest_estimate", "approval_brief",
                     "critic_advice", "compose_notification"):
            monkeypatch.setattr(executors_ai, name, getattr(self, name))


@pytest.fixture
def env(container, tmp_path, monkeypatch):
    monkeypatch.setattr(container.settings, "data_dir", str(tmp_path / "data"))
    install_demo(container)
    monkeypatch.setattr(type(container.ai), "configured", property(lambda self: True))
    engine = container.engine
    monkeypatch.setattr(engine, "flush_delay_s", 0)
    by_email = {u["email"].split(".")[0].split("@")[0]: u["id"] for u in container.users()}
    teams = {t["name"]: t["id"] for t in container.teams()}
    ns = SimpleNamespace(c=container, e=engine, u=by_email, squad=teams["MCP Factory Squad"], teams=teams)
    ns.fakes = Fakes(ns)
    ns.fakes.install(monkeypatch)
    yield ns


def run(coro):
    return asyncio.run(coro)


def step(project: dict, sid: str) -> dict:
    return next(s for st in project["stages"] for s in st["steps"] if s["id"] == sid)


async def settle(env) -> None:
    await env.e.wait_idle(10)


async def new_mcp(env, **kw) -> dict:
    inputs = {"mcp_name": "Nostro Balances MCP", "purpose": "Balances for the liquidity agent",
              "capability": "nostro balances"}
    project = await env.e.create_project(
        "bp_mcp_delivery", title="Nostro Balances MCP", inputs=inputs, sponsor_id=env.u["alice"],
        owner_id=env.u["paul"], source={"type": "manual"}, created_by=env.u["paul"], **kw)
    await settle(env)
    return env.e.get(project["id"])


async def to_signoff(env) -> dict:
    """mcp_delivery up to the spec sign-off (spec submitted, epic confirmed)."""
    e, u = env.e, env.u
    p = await new_mcp(env)
    await e.complete_step(p["id"], "spec", u["paul"], form={})
    await settle(env)
    await e.confirm(p["id"], "jira_epic", u["paul"], True)
    await settle(env)
    return e.get(p["id"])


def notes(env, user_key: str) -> list[dict]:
    return env.c.notifier.list(env.u[user_key])


# ---------------------------------------------------------------------------------- mcp_delivery

def test_mcp_delivery_specification_stage(env):
    async def scenario():
        e, u = env.e, env.u
        p = await new_mcp(env)
        assert p["key"].startswith("MCP-") and p["status"] == "waiting"
        assert p["current_stage_id"] == "specification"
        spec = step(p, "spec")
        assert spec["status"] == "waiting_human" and spec["ai_busy"] is False
        assert spec["ai_draft"]["data_source"] == "Treasury DWH (Oracle)"
        assert spec["form"]["auth_model"] == "Service account (read-only)"      # empty fields filled by the draft
        assert u["paul"] in spec["assignee_user_ids"] and spec["due_at"]
        assert any(n["step_id"] == "spec" for n in notes(env, "paul"))
        assert p["metrics"]["hours_saved"] == 2                                 # human_form_ai_draft

        assert not e.can_act(p, spec, u["karim"]) and e.can_act(p, spec, u["paul"]) and e.can_act(p, spec, u["admin"])
        with pytest.raises(Forbidden, match="Product Manager|product manager|owner"):
            await e.complete_step(p["id"], "spec", u["karim"], form={})
        with pytest.raises(EngineError, match="Data classification"):
            await e.complete_step(p["id"], "spec", u["paul"], form={"data_classification": "Top secret"})

        p = await e.complete_step(p["id"], "spec", u["paul"], form={"nfr": "p95 < 1 s"})
        assert step(p, "spec")["status"] == "done" and p["vars"]["spec"]["nfr"] == "p95 < 1 s"
        assert any(a["step_id"] == "spec" and "Purpose & scope" in a["content"] for a in p["artifacts"])
        await settle(env)
        p = e.get(p["id"])
        assert step(p, "team_routing")["status"] == "done" and step(p, "team_routing")["completed_by"] == "ai"
        assert p["team_id"] == env.squad                                        # §14 implicit team update
        epic = step(p, "jira_epic")
        assert epic["status"] == "waiting_human" and epic["pending_action"]["kind"] == "confirm_operation"
        assert e.can_act(p, epic, u["paul"]) and not e.can_act(p, epic, u["karim"])   # unassigned → owner

        p = await e.confirm(p["id"], "jira_epic", u["paul"], True)
        assert step(p, "jira_epic")["status"] == "running"                       # executes in the background
        await settle(env)
        p = e.get(p["id"])
        assert step(p, "jira_epic")["status"] == "done" and p["vars"]["epic"]["key"] == "MCPF-7"
        assert [l["external_id"] for l in p["links"]] == ["MCPF-7"]
        signoff = step(p, "spec_signoff")
        assert signoff["status"] == "waiting_approval" and signoff["brief"] == "Brief for spec_signoff"
        assert {u["alice"], u["sofia"]} <= set(signoff["assignee_user_ids"])
        kinds = {ev["kind"] for ev in env.c.store.list_events(project_id=p["id"])}
        assert {"project.created", "stage.started", "step.started", "step.completed", "form.submitted",
                "operation.executed", "link.added"} <= kinds
    run(scenario())


def test_signoff_needs_sponsor_and_dev_lead(env):
    async def scenario():
        e, u = env.e, env.u
        p = await to_signoff(env)
        other_sponsor = env.c.store.put("users", User(id=new_id("usr"), name="Other Sponsor", email="o@x.io",
                                                      roles=["sponsor"], created_at=now_iso()).model_dump())
        for intruder in (u["karim"], u["paul"], u["emma"], other_sponsor["id"]):
            assert not e.can_act(p, step(p, "spec_signoff"), intruder)
            with pytest.raises(Forbidden, match="approve"):
                await e.decide(p["id"], "spec_signoff", intruder, "approved")
        p = await e.decide(p["id"], "spec_signoff", u["sofia"], "approved", "Looks right")
        signoff = step(p, "spec_signoff")
        assert signoff["status"] == "waiting_approval" and [a["role"] for a in signoff["approvals"]] == ["dev_lead"]
        assert "Business sponsor" in signoff["output_summary"]
        with pytest.raises(Forbidden):                     # Sofia's role is approved; only the sponsor is pending
            await e.decide(p["id"], "spec_signoff", u["sofia"], "approved")
        p = await e.decide(p["id"], "spec_signoff", u["alice"], "approved")
        assert step(p, "spec_signoff")["status"] == "done"
        assert p["vars"]["spec_signoff"]["decision"] == "approved"
        assert len(p["vars"]["spec_signoff"]["approvals"]) == 2
        assert p["current_stage_id"] == "planning"
        await settle(env)
        p = e.get(p["id"])
        est = step(p, "estimate")
        assert est["status"] == "waiting_human" and est["estimate"]["ai_suggestion"]["value"] == 8
        events = env.c.store.list_events(project_id=p["id"], kinds=["approval.approved"])
        assert {ev["data"]["role"] for ev in events} == {"sponsor", "dev_lead"}
    run(scenario())


def test_rejection_reopens_the_spec_with_feedback(env):
    async def scenario():
        e, u = env.e, env.u
        p = await to_signoff(env)
        with pytest.raises(EngineError, match="why"):
            await e.decide(p["id"], "spec_signoff", u["alice"], "rejected", "")
        await e.decide(p["id"], "spec_signoff", u["sofia"], "approved")
        p = await e.decide(p["id"], "spec_signoff", u["alice"], "rejected", "Add the PII classification")
        await settle(env)
        p = e.get(p["id"])
        spec = step(p, "spec")
        assert spec["status"] == "waiting_human" and "Add the PII classification" in spec["feedback"]
        assert spec["form"]["data_source"]                                     # the previous submission is kept
        assert "spec" not in p["vars"] and "epic" not in p["vars"]
        for sid in ("team_routing", "jira_epic", "spec_signoff"):
            assert step(p, sid)["status"] == "pending"
        assert step(p, "spec_signoff")["approvals"] == []
        assert any((t.get("data") or {}).get("decision") == "rejected" for t in step(p, "spec_signoff")["trace"])
        assert p["current_stage_id"] == "specification" and p["status"] == "waiting"
        assert any("Changes requested" in n["title"] for n in notes(env, "paul"))
        assert p["risk"]["score"] > 0 and any("Rejected" in r for r in p["risk"]["reasons"])

        await e.complete_step(p["id"], "spec", u["paul"], form={"contains_pii": False})
        await settle(env)
        await e.confirm(p["id"], "jira_epic", u["paul"], True)
        await settle(env)
        p = e.get(p["id"])
        assert step(p, "spec_signoff")["status"] == "waiting_approval"
        await e.decide(p["id"], "spec_signoff", u["alice"], "approved")
        p = await e.decide(p["id"], "spec_signoff", u["sofia"], "approved")
        assert step(p, "spec_signoff")["status"] == "done"
    run(scenario())


def test_mcp_delivery_runs_to_completion(env):
    async def scenario():
        e, u = env.e, env.u
        p = await to_signoff(env)
        pid = p["id"]
        await e.decide(pid, "spec_signoff", u["alice"], "approved")
        await e.decide(pid, "spec_signoff", u["sofia"], "approved")
        await settle(env)
        with pytest.raises(EngineError, match="breakdown"):
            await e.submit_estimate(pid, "estimate", u["sofia"], {"value": 10, "unit": "days"})
        p = await e.submit_estimate(pid, "estimate", u["sofia"], {"value": 10, "unit": "days", "confidence": "high",
                                                                 "breakdown": [{"item": "build", "value": 10}]})
        assert p["vars"]["estimate"]["value"] == 10 and p["vars"]["estimate"]["ai_suggestion"]["value"] == 8
        await settle(env)
        p = e.get(pid)
        assert step(p, "jira_backlog")["pending_action"]["kind"] == "ai_review"
        p = await e.confirm(pid, "jira_backlog", u["sofia"], True)            # ai_review approve: inline
        assert step(p, "jira_backlog")["status"] == "done"
        await settle(env)
        await e.confirm(pid, "create_stories", u["paul"], True)
        await settle(env)
        p = e.get(pid)
        assert step(p, "test_plan")["status"] == "done"                          # parallel stage
        dev = step(p, "development")
        assert dev["status"] == "waiting_external" and dev["next_poll_at"]
        await e.complete_step(pid, "development", u["karim"], output={"status": "Done"})
        await settle(env)
        p = e.get(pid)
        assert step(p, "compliance_gate")["status"] == "done" and p["vars"]["gate"]["passed"] is True
        assert step(p, "test_report")["form"]["tests_total"] == 12
        await e.complete_step(pid, "test_report", u["karim"], form={})
        await settle(env)
        await e.confirm(pid, "change_ticket", u["paul"], True)
        await settle(env)
        for who in ("emma", "alice", "lucas"):
            p = await e.decide(pid, "release_approval", u[who], "approved")
        await settle(env)
        await e.confirm(pid, "register_mcp", u["paul"], True)
        await settle(env)
        p = e.get(pid)
        assert p["status"] == "done" and p["completed_at"] and all(st["status"] == "done" for st in p["stages"])
        assert p["vars"]["delivered"]["recipients"]
        assert e.summary(p)["progress"] == 1.0
        assert p["metrics"]["ai_steps"] >= 8 and p["metrics"]["human_steps"] >= 5 and p["metrics"]["hours_saved"] > 0
        assert any("completed" in n["title"] for n in notes(env, "alice"))
        assert any("completed" in n["title"] for n in notes(env, "paul"))
        assert p["risk"]["score"] == 0
    run(scenario())


# ---------------------------------------------------------------------------------- use_case_onboarding

async def new_use_case(env, missing: list[dict]) -> dict:
    env.fakes.missing = missing
    project = await env.e.create_project(
        "bp_use_case_onboarding", title="Liquidity copilot", inputs={"context": "Needs nostro balances"},
        sponsor_id=env.u["alice"], owner_id=env.u["paul"], priority="high", source={"type": "manual"})
    await settle(env)
    return env.e.get(project["id"])


def test_fan_out_children_and_parent_completion(env):
    async def scenario():
        e, u = env.e, env.u
        p = await new_use_case(env, [{"name": "Nostro MCP", "capability": "nostro balances", "purpose": "p"},
                                     {"name": "FX MCP", "capability": "fx rates", "purpose": "q"}])
        assert step(p, "qualify")["status"] == "done" and step(p, "kickoff")["status"] == "done"
        assert set(p["vars"]["kickoff"]["recipients"]) >= {u["alice"], u["paul"]}
        assert step(p, "analysis_review")["status"] == "waiting_approval"
        p = await e.decide(p["id"], "analysis_review", u["paul"], "approved")
        await settle(env)
        p = e.get(p["id"])
        fan = step(p, "deliver_mcps")
        assert fan["status"] == "waiting_children" and len(fan["child_ids"]) == 2 and p["status"] == "waiting"
        children = [e.get(cid) for cid in fan["child_ids"]]
        assert {c["inputs"]["mcp_name"] for c in children} == {"Nostro MCP", "FX MCP"}
        for child in children:
            assert child["parent_id"] == p["id"] and child["source"]["type"] == "fan_out"
            assert (child["sponsor_id"], child["owner_id"], child["priority"]) == (u["alice"], u["paul"], "high")
            assert child["inputs"]["parent_use_case"].startswith(p["key"])
        assert set(p["child_ids"]) == set(fan["child_ids"])
        assert [s["id"] for s in e.list_summaries(parent_id=p["id"])] != []
        assert e.summary(e.get(p["id"]))["child_count"] == 2

        await e.cancel_project(children[0]["id"], u["paul"], "Covered by an existing server")
        await settle(env)
        assert step(e.get(p["id"]), "deliver_mcps")["status"] == "waiting_children"
        await e.cancel_project(children[1]["id"], u["admin"], "Descoped")
        await settle(env)
        p = e.get(p["id"])
        fan = step(p, "deliver_mcps")
        assert fan["status"] == "done" and len(p["vars"]["mcp_children"]["children"]) == 2
        assert step(p, "readiness")["pending_action"]["kind"] == "ai_review"

        await e.confirm(p["id"], "readiness", u["paul"], True)
        await e.decide(p["id"], "golive_approval", u["alice"], "approved")
        p = await e.decide(p["id"], "golive_approval", u["emma"], "approved")
        await settle(env)
        p = e.get(p["id"])
        assert step(p, "portfolio_update")["status"] == "skipped"              # no doing_ai_id input
        assert p["status"] == "done"
    run(scenario())


def test_fan_out_is_skipped_when_nothing_is_missing(env):
    async def scenario():
        e, u = env.e, env.u
        p = await new_use_case(env, [])
        await e.decide(p["id"], "analysis_review", u["paul"], "approved")
        await settle(env)
        p = e.get(p["id"])
        fan = step(p, "deliver_mcps")
        assert fan["status"] == "skipped" and "condition" in fan["output_summary"]
        assert p["child_ids"] == [] and step(p, "readiness")["status"] == "waiting_human"
    run(scenario())


def test_child_completion_kicks_the_parent(env):
    async def scenario():
        e, u = env.e, env.u
        p = await new_use_case(env, [{"name": "Nostro MCP", "capability": "nostro balances"}])
        await e.decide(p["id"], "analysis_review", u["paul"], "approved")
        await settle(env)
        child_id = step(e.get(p["id"]), "deliver_mcps")["child_ids"][0]
        # Finish the child by skipping every open step as its owner.
        for _ in range(40):
            child = e.get(child_id)
            if child["status"] == "done":
                break
            open_step = next(s for st in child["stages"] for s in st["steps"] if s["status"] not in ("done", "skipped"))
            await e.skip_step(child_id, open_step["id"], u["paul"], "test shortcut")
            await settle(env)
        assert e.get(child_id)["status"] == "done"
        p = e.get(p["id"])
        assert step(p, "deliver_mcps")["status"] == "done"
        assert p["vars"]["mcp_children"]["children"][0]["status"] == "done"
    run(scenario())


# ---------------------------------------------------------------------------------- failures

def test_failure_retries_with_critic_then_blocks_and_retry_recovers(env, monkeypatch):
    async def scenario():
        e, u = env.e, env.u
        env.fakes.failures["team_routing"] = [("LLM returned invalid JSON (attempt 1)", True),
                                              ("LLM returned invalid JSON (attempt 2)", True)]
        p = await new_mcp(env)
        await e.complete_step(p["id"], "spec", u["paul"], form={})
        await settle(env)
        p = e.get(p["id"])
        routing = step(p, "team_routing")
        # Same kind of error twice → the LoopGuard stops before max_retries (2) is used up.
        assert routing["status"] == "failed" and routing["attempts"] == 2
        assert routing["heal_hint"] == "Return valid JSON only." and "automatic retries stopped" in routing["error"]
        assert p["status"] == "blocked"
        assert any(n["kind"] == "warning" and n["step_id"] == "team_routing" for n in notes(env, "paul"))
        assert any(n["step_id"] == "team_routing" for n in notes(env, "admin"))
        items = inbox.inbox_for(env.c, u["paul"])
        assert any(i["kind"] == "failure" and i["step_id"] == "team_routing" for i in items)
        assert not e.can_act(p, routing, u["karim"]) and e.can_act(p, routing, u["paul"])

        p = await e.retry_step(p["id"], "team_routing", u["paul"])
        await settle(env)
        p = e.get(p["id"])
        assert step(p, "team_routing")["status"] == "done" and p["status"] == "waiting"
        kinds = [ev["kind"] for ev in env.c.store.list_events(project_id=p["id"])]
        assert "step.failed" in kinds and "project.blocked" in kinds and kinds.count("step.retried") == 2
    run(scenario())


def test_distinct_errors_use_every_retry_and_non_retryable_fails_at_once(env):
    async def scenario():
        e, u = env.e, env.u
        env.fakes.failures["team_routing"] = [("timeout", True), ("connection reset", True), ("bad gateway", True)]
        p = await new_mcp(env)
        await e.complete_step(p["id"], "spec", u["paul"], form={})
        await settle(env)
        routing = step(e.get(p["id"]), "team_routing")
        assert routing["status"] == "failed" and routing["attempts"] == 3 and routing["error"] == "bad gateway"

        env.fakes.failures["team_routing"] = [("Operation not configured", False)]
        await e.retry_step(p["id"], "team_routing", u["admin"])
        await settle(env)
        routing = step(e.get(p["id"]), "team_routing")
        assert routing["status"] == "failed" and routing["attempts"] == 4    # one attempt, no retry

        p = await e.complete_step(p["id"], "team_routing", u["paul"],
                                  output={"team_id": env.teams["Payments"], "team_name": "Payments"})
        assert step(p, "team_routing")["status"] == "done" and p["team_id"] == env.teams["Payments"]
    run(scenario())


def test_rejected_confirmation_fails_the_step(env):
    async def scenario():
        e, u = env.e, env.u
        p = await new_mcp(env)
        await e.complete_step(p["id"], "spec", u["paul"], form={})
        await settle(env)
        p = await e.confirm(p["id"], "jira_epic", u["paul"], False, {"comment": "wrong project"})
        epic = step(p, "jira_epic")
        assert epic["status"] == "failed" and p["status"] == "blocked"
        with pytest.raises(EngineError, match="not waiting for a confirmation"):
            await e.confirm(p["id"], "jira_epic", u["paul"], True)
        p = await e.skip_step(p["id"], "jira_epic", u["paul"], "Epic created by hand")
        assert step(p, "jira_epic")["status"] == "skipped"
        assert step(p, "spec_signoff")["status"] == "waiting_approval" and p["status"] == "waiting"
        with pytest.raises(Forbidden, match="owner or an admin"):
            await e.skip_step(p["id"], "spec_signoff", u["sofia"], "no")
    run(scenario())


# ---------------------------------------------------------------------------------- gates

def test_quality_gate_override_and_send_back(env):
    async def scenario():
        e, u = env.e, env.u
        env.fakes.gate_blocks = True
        p = await to_signoff(env)
        pid = p["id"]
        await e.decide(pid, "spec_signoff", u["alice"], "approved")
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
        p = e.get(pid)
        gate = step(p, "compliance_gate")
        assert gate["status"] == "waiting_human" and gate["pending_action"]["kind"] == "gate_review"
        assert env.c.store.list_events(project_id=pid, kinds=["gate.failed"])
        assert e.can_act(p, gate, u["chloe"]) and e.can_act(p, gate, u["lucas"])
        with pytest.raises(Forbidden, match="Security"):
            await e.gate_action(pid, "compliance_gate", u["paul"], "override", "fine")
        with pytest.raises(EngineError, match="justification"):
            await e.gate_action(pid, "compliance_gate", u["chloe"], "override", "")

        p = await e.gate_action(pid, "compliance_gate", u["chloe"], "send_back", "Tests miss auth cases",
                                goto_step="test_plan")
        assert step(p, "compliance_gate")["status"] == "pending"
        await settle(env)
        p = e.get(pid)
        assert "Tests miss auth cases" in step(p, "test_plan")["feedback"]
        assert step(p, "development")["status"] == "waiting_external"         # reset too: every step up to the gate
        await e.complete_step(pid, "development", u["karim"])
        await settle(env)
        p = e.get(pid)
        assert step(p, "compliance_gate")["status"] == "waiting_human"        # ran again, still blocking
        p = await e.gate_action(pid, "compliance_gate", u["chloe"], "override", "Compensating control in place")
        gate = step(p, "compliance_gate")
        assert gate["status"] == "done" and gate["checks"][0]["overridden_by"] == u["chloe"]
        assert p["vars"]["gate"]["overridden"] is True and p["vars"]["gate"]["passed"] is True
        assert env.c.store.list_events(project_id=pid, kinds=["gate.overridden"])
    run(scenario())


# ---------------------------------------------------------------------------------- recovery

def test_recover_reruns_side_effect_free_steps_and_fails_the_others(env):
    async def scenario():
        e, u = env.e, env.u
        p = await new_mcp(env)
        await e.complete_step(p["id"], "spec", u["paul"], form={})
        await settle(env)
        doc = env.c.store.get("projects", p["id"])
        step(doc, "spec")["ai_busy"] = True
        step(doc, "team_routing").update(status="running")
        step(doc, "jira_epic").update(status="running", pending_action=None)
        env.c.store.put("projects", doc)
        await e.recover()
        await settle(env)
        p = e.get(p["id"])
        assert step(p, "spec")["ai_busy"] is False
        assert step(p, "team_routing")["status"] == "done"                   # re-run
        epic = step(p, "jira_epic")
        assert epic["status"] == "failed" and "server restart" in epic["error"] and p["status"] == "blocked"
    run(scenario())


# ---------------------------------------------------------------------------------- misc actions

def test_listing_permissions_and_project_edits(env):
    async def scenario():
        e, u = env.e, env.u
        p = await new_mcp(env)
        other = await e.create_project("bp_change_request", title="Firewall change", source={"type": "manual"},
                                       owner_id=u["emma"],
                                       inputs={k["key"]: "x" for k in (env.c.get_blueprint("bp_change_request")
                                                                       or {}).get("inputs", []) if k.get("required")})
        await settle(env)
        assert {s["id"] for s in e.list_summaries()} == {p["id"], other["id"]}
        assert [s["id"] for s in e.list_summaries(user_id=u["alice"])] == [p["id"]]
        assert [s["id"] for s in e.list_summaries(q="nostro")] == [p["id"]]
        assert [s["id"] for s in e.list_summaries(blueprint_id="bp_change_request")] == [other["id"]]
        assert e.list_summaries(status="done") == []
        summary = e.summary(p)
        assert summary["open_step_names"] == ["Specify the MCP server"] and summary["current_stage_name"]

        with pytest.raises(Forbidden):
            await e.update_project(p["id"], u["karim"], {"title": "Hijacked"})
        p = await e.update_project(p["id"], u["paul"], {"priority": "critical", "stakeholder_ids": [u["lucas"]]})
        assert p["priority"] == "critical" and [s["id"] for s in e.list_summaries(user_id=u["lucas"])] == [p["id"]]
        p = await e.update_project(p["id"], "ai", {"ai_summary": "On track"})
        assert p["ai_summary"] == "On track"
        with pytest.raises(Forbidden):
            await e.update_project(p["id"], "ai", {"title": "x"})

        p = await e.reassign_step(p["id"], "spec", u["paul"], [u["karim"]])
        assert step(p, "spec")["assignee_user_ids"] == [u["karim"]] and e.can_act(p, step(p, "spec"), u["karim"])

        p = await e.add_link(p["id"], u["paul"], {"kind": "url", "label": "Design", "url": "https://x.io/d"})
        assert p["links"][0]["id"].startswith("lnk_")
        event = await e.add_comment(p["id"], u["sofia"], "Looks good")
        assert event["kind"] == "comment.added" and event["actor"] == u["sofia"]

        await e.complete_step(p["id"], "spec", u["karim"], form={})
        await settle(env)
        p = e.get(p["id"])
        art = next(a for a in p["artifacts"] if a["step_id"] == "spec")
        p2 = await e.update_artifact(p["id"], art["id"], u["paul"], "Edited spec")
        art2 = next(a for a in p2["artifacts"] if a["id"] == art["id"])
        assert art2["version"] == 2 and art2["history"][0]["content"] == art["content"]
        routing_art = next(a for a in p2["artifacts"] if a["step_id"] == "team_routing")
        with pytest.raises(EngineError, match="valid JSON"):
            await e.update_artifact(p["id"], routing_art["id"], u["paul"], "{not json")

        with pytest.raises(Forbidden):
            await e.cancel_project(p["id"], u["karim"], "no")
        with pytest.raises(LLMNotConfigured):
            type(env.c.ai).configured = property(lambda self: False)
            await e.request_ai_draft(p["id"], "spec", u["paul"])
    run(scenario())


def test_request_ai_draft_and_reopen(env):
    async def scenario():
        e, u = env.e, env.u
        p = await new_mcp(env)
        await e.save_form(p["id"], "spec", u["paul"], {"summary": "My own summary"})
        p = await e.request_ai_draft(p["id"], "spec", u["paul"], "shorter")
        assert step(p, "spec")["ai_busy"] is True
        await settle(env)
        p = e.get(p["id"])
        assert step(p, "spec")["form"]["summary"] == "My own summary"          # never overwrites typed values
        assert env.fakes.calls.count(("draft_form", "spec")) == 2
        await e.complete_step(p["id"], "spec", u["paul"])
        await settle(env)
        p = await e.reopen_step(p["id"], "spec", u["paul"], "Scope changed")
        assert step(p, "spec")["status"] == "waiting_human" and "Scope changed" in step(p, "spec")["feedback"]
        assert step(p, "team_routing")["status"] == "pending" and step(p, "jira_epic")["status"] == "pending"
    run(scenario())


def test_delete_project_unlinks_parent_and_children(env):
    async def scenario():
        e, u = env.e, env.u
        p = await new_use_case(env, [{"name": "A", "capability": "a"}, {"name": "B", "capability": "b"}])
        await e.decide(p["id"], "analysis_review", u["paul"], "approved")
        await settle(env)
        a, b = step(e.get(p["id"]), "deliver_mcps")["child_ids"]
        await e.delete_project(a)
        await settle(env)
        p = e.get(p["id"])
        assert p["child_ids"] == [b] and step(p, "deliver_mcps")["child_ids"] == [b]
        await e.delete_project(p["id"])
        assert e.get(b)["parent_id"] == ""
    run(scenario())


def test_poll_wait_step_completes_on_condition(env, monkeypatch):
    async def scenario():
        e, u = env.e, env.u
        p = await to_signoff(env)
        pid = p["id"]
        await e.decide(pid, "spec_signoff", u["alice"], "approved")
        await e.decide(pid, "spec_signoff", u["sofia"], "approved")
        await settle(env)
        await e.submit_estimate(pid, "estimate", u["sofia"], {"value": 5, "breakdown": [{"item": "x", "value": 5}]})
        await settle(env)
        await e.confirm(pid, "jira_backlog", u["sofia"], True)
        await settle(env)
        await e.confirm(pid, "create_stories", u["paul"], True)
        await settle(env)
        statuses = iter(["In Progress", "Done"])

        async def fake_run(op, data, **kw):
            assert data == {"issue_key": "MCPF-7"}
            return OperationResult(ok=True, output={"key": "MCPF-7", "status": next(statuses)})
        monkeypatch.setattr(env.c.ops, "run", fake_run)
        await e.poll_wait_step(pid, "development")
        dev = step(e.get(pid), "development")
        assert dev["status"] == "waiting_external" and dev["output"]["status"] == "In Progress"
        await e.poll_wait_step(pid, "development")
        await settle(env)
        p = e.get(pid)
        assert step(p, "development")["status"] == "done" and p["vars"]["development"]["status"] == "Done"
    run(scenario())


def test_flag_sla_and_refresh_risk(env):
    async def scenario():
        e, u = env.e, env.u
        p = await new_mcp(env)
        doc = env.c.store.get("projects", p["id"])
        step(doc, "spec")["due_at"] = "2020-01-01T00:00:00Z"
        env.c.store.put("projects", doc)
        await e.flag_sla(p["id"], "spec")
        await settle(env)
        p = e.get(p["id"])
        assert step(p, "spec")["sla_breached"] is True
        assert any("Overdue" in n["title"] for n in notes(env, "paul"))
        await e.flag_sla(p["id"], "spec")                                      # once only
        await settle(env)
        assert sum("Overdue" in n["title"] for n in notes(env, "paul")) == 1
        await e.refresh_risk(p["id"])
        assert e.get(p["id"])["risk"]["score"] > 0
    run(scenario())


def test_create_project_validates_inputs_and_people(env):
    async def scenario():
        e, u = env.e, env.u
        with pytest.raises(EngineError, match="MCP server name is required"):
            await e.create_project("bp_mcp_delivery", title="x", inputs={}, source={"type": "manual"})
        with pytest.raises(EngineError, match="Unknown sponsor"):
            await e.create_project("bp_mcp_delivery", title="x", inputs={"mcp_name": "a", "purpose": "b"},
                                   sponsor_id="usr_nope")
        # Automated sources are lenient: missing required inputs do not block the intake.
        p = await e.create_project("mcp_delivery", title="From a watcher", inputs={}, source={"type": "watcher"})
        assert p["source"]["type"] == "watcher" and p["inputs"]["mcp_name"] == ""
        await settle(env)
    run(scenario())


def test_supervised_autonomy_forces_review(env, monkeypatch):
    async def scenario():
        e, u = env.e, env.u
        env.c.save_app_settings({"engine": {"autonomy": "supervised"}})
        p = await new_mcp(env)
        await e.complete_step(p["id"], "spec", u["paul"], form={})
        await settle(env)
        routing = step(e.get(p["id"]), "team_routing")
        assert routing["status"] == "waiting_human" and routing["pending_action"]["kind"] == "ai_review"
        items = inbox.inbox_for(env.c, u["paul"])
        assert any(i["kind"] == "review" and i["step_id"] == "team_routing" for i in items)
    run(scenario())
