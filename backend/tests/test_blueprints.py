"""Seed data (app/seed): roles, compliance rules, builtin blueprints and the demo environment.

The builtin blueprints are the product demo, so they are held to the data contract (models.py),
their templates must compile and render (SPEC §4 semantics, checked with a Jinja environment
of our own so the seed is verified independently of the engine), every value a step reads
must be produced by an earlier step in the shape it reads it, and the operations they call
must work against the bundled sandbox MCP servers for real.
"""
from __future__ import annotations

import asyncio
import json
import re
import sys
from pathlib import Path
from typing import Any, Iterator

import pytest
from jinja2 import ChainableUndefined, StrictUndefined
from jinja2.sandbox import SandboxedEnvironment

from app.llm.prompts import DEFAULT_PROMPTS
from app.models import STEP_CONFIG_MODELS, Blueprint, Connector, Estimate, Operation, RoleDef, Rule, Team, User, Watcher
from app.seed import defaults
from app.seed.defaults import BUILTIN_BLUEPRINTS, PORTFOLIO_AGENT_TOOLS, ROLES, RULES, seed_defaults
from app.seed.demo import (DEMO_TEAMS, DEMO_USERS, JIRA_CONNECTOR, MCP_SERVERS_DIR, PORTFOLIO_CONNECTOR,
                           WATCHER_NAME, demo_operations, demo_watcher, install_demo)

BLUEPRINTS = {bp["key"]: bp for bp in BUILTIN_BLUEPRINTS}
OPERATIONS = {op["key"]: op for op in demo_operations()}
ROLE_KEYS = {r["key"] for r in ROLES}

# ---------------------------------------------------------------------------
# SPEC §4 templating, reproduced for the test
# ---------------------------------------------------------------------------


def _truncate_chars(value: Any, n: int) -> str:
    text = "" if value is None else str(value)
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def _bullets(value: Any) -> str:
    return value if isinstance(value, str) else "\n".join(f"- {v}" for v in value or [])


def _env(undefined: type) -> SandboxedEnvironment:
    env = SandboxedEnvironment(undefined=undefined, autoescape=False)
    env.filters.update(tojson=lambda v: json.dumps(v, ensure_ascii=False, default=str), bullets=_bullets,
                       truncate_chars=_truncate_chars, slug=lambda v: re.sub(r"[^a-z0-9]+", "-", str(v).lower()).strip("-"))
    return env


LENIENT = _env(ChainableUndefined)   # what the engine uses
STRICT = _env(StrictUndefined)       # with a complete context: any misspelt path raises
_ONE_EXPR = re.compile(r"^\{\{(?P<expr>(?:(?!\{\{|\}\}).)*)\}\}$", re.S)


def render(template: str, ctx: dict, env: SandboxedEnvironment = LENIENT) -> str:
    return env.from_string(template).render(**ctx)


def evaluate(expr: str, ctx: dict, env: SandboxedEnvironment = LENIENT) -> Any:
    return env.compile_expression(expr)(**ctx)


def render_obj(obj: Any, ctx: dict, env: SandboxedEnvironment = LENIENT) -> Any:
    """Strings rendered recursively; a string that is exactly one `{{ expr }}` keeps its native value."""
    if isinstance(obj, str):
        match = _ONE_EXPR.match(obj.strip())
        return evaluate(match["expr"], ctx, env) if match else render(obj, ctx, env)
    if isinstance(obj, dict):
        return {k: render_obj(v, ctx, env) for k, v in obj.items()}
    if isinstance(obj, list):
        return [render_obj(v, ctx, env) for v in obj]
    return obj


# ---------------------------------------------------------------------------
# Blueprint walking
# ---------------------------------------------------------------------------

def steps(bp: dict) -> Iterator[tuple[dict, dict]]:
    for stage in bp["stages"]:
        for step in stage["steps"]:
            yield stage, step


def _strings(value: Any) -> Iterator[str]:
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from _strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from _strings(v)


def step_templates(step: dict) -> list[tuple[str, str]]:
    """(kind, text) for every Jinja string of a step: kind "template" or "expression"."""
    cfg, kind = step["config"], step["type"]
    out = [("expression", step["when"])] if step["when"] else []
    fields = {"ai_task": ["prompt"], "human_form": ["ai_prefill"], "approval": ["brief_prompt"],
              "estimation": ["prompt"], "agent_task": ["goal"], "fan_out": ["title"],
              "notify": ["subject", "prompt", "body"]}.get(kind, [])
    out += [("template", cfg[f]) for f in fields if cfg.get(f)]
    for key in ("input", "inputs", "create_link"):
        out += [("template", s) for s in _strings(cfg.get(key))]
    out += [("expression", cfg[f]) for f in ("items", "until") if cfg.get(f)]
    return out


def output_fields(step: dict) -> set[str] | None:
    """Top-level keys of what a step stores in project.vars (SPEC §5b); None = unknown statically."""
    cfg, kind = step["config"], step["type"]
    if kind == "ai_task":
        return set(cfg["json_schema"]["properties"]) if cfg.get("output") == "json" else {"markdown"}
    if kind == "agent_task":
        return set(cfg["output_schema"]["properties"]) if cfg.get("output_schema") else {"final"}
    if kind == "human_form":
        return {f["key"] for f in cfg["fields"]}
    if kind in ("mcp_operation", "wait_for"):
        schema = OPERATIONS[cfg["operation_key"]]["output"].get("json_schema")
        return set(schema["properties"]) if schema else None
    return {"estimation": set(Estimate.model_fields), "approval": {"decision", "approvals"},
            "quality_gate": {"passed", "checks", "failed", "overridden"}, "fan_out": {"children"},
            "notify": {"subject", "recipients"}}[kind]


def var_name(step: dict) -> str:
    return step["store_as"] or step["id"]


# ---------------------------------------------------------------------------
# Contract
# ---------------------------------------------------------------------------

def test_roles_and_rules_validate():
    assert [RoleDef.model_validate(r).key for r in ROLES] == [
        "sponsor", "product_manager", "business_user", "developer", "dev_lead", "it_ops", "security", "compliance", "admin"]
    assert all(r["label"] and r["description"] for r in ROLES)
    codes = [Rule.model_validate(r).code for r in RULES]
    assert len(codes) == len(set(codes)) >= 15
    assert all("mcp" in r["tags"] and r["guidance"] for r in RULES)
    assert {r["category"] for r in RULES} == {"Security", "Data", "Architecture", "Operations", "Quality", "Legal"}
    assert any(r["check"] == "manual" for r in RULES) and any(r["severity"] == "critical" for r in RULES)


@pytest.mark.parametrize("key", list(BLUEPRINTS))
def test_blueprint_matches_the_contract(key):
    bp = BLUEPRINTS[key]
    model = Blueprint.model_validate(bp)
    assert model.id == f"bp_{key}" and model.key_prefix == {"use_case_onboarding": "UC", "mcp_delivery": "MCP",
                                                            "change_request": "CR"}[key]
    stage_ids = [s["id"] for s in bp["stages"]]
    step_ids = [st["id"] for _, st in steps(bp)]
    names = [var_name(st) for _, st in steps(bp)]
    assert len(set(stage_ids)) == len(stage_ids) and len(set(step_ids)) == len(step_ids)
    assert len(set(names)) == len(names), "two steps write the same project.vars key"
    for _, step in steps(bp):
        config_model = STEP_CONFIG_MODELS[step["type"]]
        config_model.model_validate(step["config"])
        # models ignore unknown keys, so a misspelt config key would silently do nothing
        assert set(step["config"]) <= set(config_model.model_fields), (step["id"], set(step["config"]) - set(config_model.model_fields))
        assert set(step["assignee"]["roles"]) <= ROLE_KEYS, step["id"]


@pytest.mark.parametrize("key", list(BLUEPRINTS))
def test_references_resolve(key):
    """Roles, prompt keys, operations, child blueprints and reject targets all exist."""
    bp = BLUEPRINTS[key]
    order = [st["id"] for _, st in steps(bp)]
    input_keys = {f["key"] for f in bp["inputs"]}
    for _, step in steps(bp):
        cfg = step["config"]
        if step["type"] == "ai_task":
            assert cfg["system_prompt"] in DEFAULT_PROMPTS
        if step["type"] == "approval":
            assert {a["role"] for a in cfg["approvers"]} <= ROLE_KEYS
            target = cfg["on_reject"]["goto_step"]
            assert target in order and order.index(target) < order.index(step["id"]), step["id"]
        if step["type"] == "notify":
            assert {a["role"] for a in cfg["audience"] if a.get("role")} <= ROLE_KEYS
        if step["type"] == "quality_gate":
            assert set(cfg["override_roles"]) <= ROLE_KEYS
            assert {r["code"] for r in RULES if set(r["tags"]) & set(cfg["rule_tags"])}, "the gate selects no rule"
        if step["type"] in ("mcp_operation", "wait_for"):
            op = OPERATIONS[cfg["operation_key"]]
            op_inputs = {f["key"] for f in op["inputs"]}
            assert set(cfg["input"]) <= op_inputs, (step["id"], set(cfg["input"]) - op_inputs)
            assert {f["key"] for f in op["inputs"] if f["required"]} <= set(cfg["input"]), step["id"]
        if step["type"] == "fan_out":
            child = BLUEPRINTS[cfg["blueprint_key"]]
            child_inputs = {f["key"] for f in child["inputs"]}
            assert set(cfg["inputs"]) <= child_inputs
            assert {f["key"] for f in child["inputs"] if f["required"]} <= set(cfg["inputs"])
        for _, text in step_templates(step):
            for name in re.findall(r"(?<![\w.])inputs\.(\w+)", text):
                assert name in input_keys, (step["id"], name)


@pytest.mark.parametrize("key", list(BLUEPRINTS))
def test_data_flows_forward(key):
    """Every `vars.X.Y` a step reads is stored by an earlier step (an earlier stage when the
    stage is parallel), and Y is a field of what that step stores."""
    bp = BLUEPRINTS[key]
    produced: dict[str, set[str] | None] = {}
    for stage in bp["stages"]:
        stage_outputs = {}
        for step in stage["steps"]:
            texts = [text for _, text in step_templates(step)]
            reads = set()
            for text in texts:
                reads |= set(re.findall(r"\bvars\.(\w+)(?:\.(\w+))?", text))
            reads |= {(v, "") for v in step["config"].get("show_vars", []) + step["config"].get("evidence", [])}
            for var, field in reads:
                assert var in produced, f"{step['id']} reads vars.{var}, which no earlier step stores"
                fields = produced[var]
                assert not field or fields is None or field in fields, f"{step['id']} reads vars.{var}.{field}; it has {fields}"
            stage_outputs[var_name(step)] = output_fields(step)
            if not stage["parallel"]:
                produced.update(stage_outputs)
        produced.update(stage_outputs)


def test_fan_out_items_feed_the_child_blueprint():
    fan_out = next(st for _, st in steps(BLUEPRINTS["use_case_onboarding"]) if st["type"] == "fan_out")
    missing_item = defaults.DEPENDENCIES_SCHEMA["properties"]["missing"]["items"]["properties"]
    used = {f for text in _strings(fan_out["config"]) for f in re.findall(r"\bitem\.(\w+)", text)}
    assert used <= set(missing_item)
    assert fan_out["config"]["items"] == "vars.dependencies.missing"


def test_jinja_compiles_everywhere():
    for bp in BUILTIN_BLUEPRINTS:
        for _, step in steps(bp):
            for kind, text in step_templates(step):
                assert "[[" not in text, f"unspliced fragment in {step['id']}"
                (LENIENT.compile_expression if kind == "expression" else LENIENT.from_string)(text)
    for op in OPERATIONS.values():
        for text in [*_strings(op["args_template"]), op["prompt"]]:
            LENIENT.from_string(text)
        if op["output"]["extract"]:
            LENIENT.compile_expression(op["output"]["extract"])
    watcher = demo_watcher("bp_x")
    for text in watcher["mapping"].values():
        LENIENT.from_string(text)
    for expr in (watcher["items_expr"], watcher["filter"]):
        LENIENT.compile_expression(expr)


# ---------------------------------------------------------------------------
# Rendering with complete and with empty contexts
# ---------------------------------------------------------------------------

TEAMS = [{"id": f"team_{t['jira_project_key'].lower()}", "name": t["name"], "description": t["description"],
          "skills": t["skills"], "jira_project_key": t["jira_project_key"], "jira_component": ""} for t in DEMO_TEAMS]

SAMPLES: dict[str, dict[str, Any]] = {
    "use_case_onboarding": {
        "inputs": {"doing_ai_id": "prj-1006", "context": "Monitor covenants from Loan IQ and CreditLens.",
                   "business_unit": "Global Banking", "target_date": "2027-04-30",
                   "expected_benefits": "1,500 analyst hours saved per year."},
        "vars": {
            "qualification": {"summary": "Covenant monitoring agent.", "business_value": "1,500 hours a year.",
                              "complexity": "high", "priority": "high",
                              "required_capabilities": ["covenant definitions", "spread financials"],
                              "risks": ["Loan IQ has no API"], "open_questions": ["Pilot scope?"],
                              "recommended_team": "Data Platform", "recommendation": "go"},
            "kickoff": {"subject": "s", "recipients": ["usr_1"]},
            "dependencies": {
                "required": [{"name": "Client 360 MCP", "purpose": "group structure", "capability": "client golden record",
                              "exists": True, "matched_id": "mcp-client-360", "matched_name": "Client 360 MCP",
                              "deploy_status": "production"},
                             {"name": "Loan IQ Covenants MCP", "purpose": "covenant terms", "capability": "covenant definitions",
                              "exists": False, "matched_id": "", "matched_name": "", "deploy_status": ""}],
                "missing": [{"name": "Loan IQ Covenants MCP", "purpose": "covenant terms", "capability": "covenant definitions",
                             "data_source": "Loan IQ (Oracle)", "suggested_team": "Data Platform"}]},
            "analysis_review": {"decision": "approved", "approvals": []},
            "mcp_children": {"children": [{"id": "prj_1", "key": "MCP-0001", "title": "Loan IQ Covenants MCP", "status": "done"}]},
            "readiness": {"markdown": "### Scope\nReady."},
            "golive_approval": {"decision": "approved", "approvals": []},
            "portfolio_update": {"ok": True},
            "closure": {"subject": "s", "recipients": []},
        },
    },
    "mcp_delivery": {
        "inputs": {"mcp_name": "Nostro Balances MCP", "purpose": "Intraday nostro balances for Treasury agents.",
                   "capability": "nostro account balances", "data_source": "MT940/MT950 statements",
                   "suggested_team": "Payments", "parent_use_case": "UC-0001 — Intraday Liquidity Forecasting Agent"},
        "vars": {
            "spec": {"summary": "Read-only nostro balances.", "tools": ["get_nostro_balances — balance per account",
                                                                        "list_nostro_accounts — accounts"],
                     "data_source": "camt.053 feed", "data_classification": "Confidential", "contains_pii": False,
                     "auth_model": "Service account (read-only)", "consumers": "Liquidity agent", "nfr": "p95 < 1 s",
                     "acceptance_criteria": "Balances match the MT950 closing balance", "target_date": "2027-01-31"},
            "routing": {"team_id": "team_pay", "team_name": "Payments", "jira_project_key": "PAY", "rationale": "Owns nostro data."},
            "epic": {"key": "PAY-31", "url": "https://jira.sandbox.local/browse/PAY-31", "created": False, "project_key": "PAY"},
            "spec_signoff": {"decision": "approved", "approvals": []},
            "estimate": {"value": 8, "unit": "days", "confidence": "medium", "breakdown": [{"item": "tools", "value": 8}],
                         "rationale": "r", "submitted_by": "usr_1", "ai_suggestion": None},
            "jira_backlog": {"issues": [
                {"project_key": "PAY", "summary": "Implement get_nostro_balances tool", "issue_type": "Story",
                 "description": "### Context\nAs an agent developer…", "parent_key": "PAY-31", "story_points": 3,
                 "labels": ["mcp", "balances"]},
                {"project_key": "PAY", "summary": "Add audit logging of tool calls", "issue_type": "Story",
                 "description": "### Context\nAs a security officer…", "parent_key": "PAY-31", "story_points": 2,
                 "labels": ["mcp", "audit"]}]},
            "jira_stories": {"ok": True, "count": 2, "keys": ["PAY-32", "PAY-33"], "created": []},
            "test_plan": {"markdown": "### Test cases\n| TC-01 | … |"},
            "development": {"key": "PAY-31", "status": "Done"},
            "gate": {"passed": True, "checks": [], "failed": [], "overridden": False},
            "test_report": {"tests_total": 24, "tests_passed": 24, "open_defects": 0, "report": "All green.",
                            "evidence_url": "https://ci.bank.example/run/1", "ready_for_release": True},
            "release_notes": {"markdown": "### Summary\nv1.0"},
            "change": {"key": "OPS-42", "url": "https://jira.sandbox.local/browse/OPS-42", "summary": "Production release"},
            "release_approval": {"decision": "approved", "approvals": []},
            "registration": {"ok": True, "created": True, "server": {"id": "mcp-1a2b3c4d", "name": "Nostro Balances MCP"}},
            "delivered": {"subject": "s", "recipients": []},
        },
    },
    "change_request": {
        "inputs": {"system": "Payments Hub", "change_summary": "Upgrade to v2.4", "reason": "Security patch",
                   "environment": "Production", "requested_date": "2026-11-07", "downtime_expected": True},
        "vars": {
            "impact": {"summary": "s", "risk_level": "medium", "impacted_systems": ["Payments Hub"], "downtime_minutes": 30,
                       "rollback_plan": "Redeploy v2.3.1", "test_strategy": "Smoke tests", "conditions": ["Outside cut-off"],
                       "recommendation": "approve_with_conditions"},
            "cab_approval": {"decision": "approved", "approvals": []},
            "announcement": {"subject": "s", "recipients": []},
        },
    },
}


def full_context(key: str, feedback: str = "") -> dict[str, Any]:
    sample = SAMPLES[key]
    person = {"id": "usr_1", "name": "Alice Martin", "email": "alice.martin@doing.ai", "title": "Managing Director"}
    return {"project": {"id": "prj_x", "key": "UC-0001", "title": "Corporate Loan Covenant Monitoring",
                        "description": "Monitors covenants.", "priority": "high", "status": "active", "tags": ["lending"],
                        "due_date": "2027-04-30", "kind": key},
            "inputs": sample["inputs"], "vars": sample["vars"], "sponsor": person, "owner": person,
            "team": TEAMS[0], "teams": TEAMS, "step": {"id": "s", "name": "S", "type": "ai_task"},
            "parent": {"id": "prj_p", "key": "UC-0001", "title": "Parent", "vars": {},
                       "inputs": {"context": "Treasury liquidity needs nostro balances."}},
            "feedback": feedback, "now": "2026-10-11T10:00:00Z",
            "item": SAMPLES["use_case_onboarding"]["vars"]["dependencies"]["missing"][0]}


def empty_context() -> dict[str, Any]:
    return {"project": {"id": "prj_x", "key": "CR-0001", "title": "T", "description": "", "priority": "medium",
                        "status": "active", "tags": [], "due_date": None, "kind": "custom"},
            "inputs": {}, "vars": {}, "sponsor": None, "owner": None, "team": None, "teams": [], "parent": None,
            "step": {"id": "s", "name": "S", "type": "ai_task"}, "feedback": "", "now": "2026-10-11T10:00:00Z", "item": {}}


def _render_step(step: dict, ctx: dict, env: SandboxedEnvironment) -> list[str]:
    out = []
    for kind, text in step_templates(step):
        if kind == "expression":
            evaluate(text, {**ctx, "output": {"status": "Done"}}, env)
        else:
            out.append(render(text, {**ctx, "output": ctx["vars"].get(var_name(step), {})}, env))
    return out


@pytest.mark.parametrize("key", list(BLUEPRINTS))
@pytest.mark.parametrize("feedback", ["", "Split the Loan IQ server in two."])
def test_templates_render_with_a_complete_context(key, feedback):
    """StrictUndefined: any path the sample outputs do not have (a typo) raises."""
    ctx = full_context(key, feedback)
    for _, step in steps(BLUEPRINTS[key]):
        for text in _render_step(step, ctx, STRICT):
            assert "None" not in text and "Undefined" not in text, (step["id"], text)


@pytest.mark.parametrize("key", list(BLUEPRINTS))
def test_templates_render_before_any_step_ran(key):
    """A fresh project (no vars, no team, no sponsor) must still render: the engine renders with
    ChainableUndefined, and a step may be retried or run manually out of order."""
    for _, step in steps(BLUEPRINTS[key]):
        for text in _render_step(step, empty_context(), LENIENT):
            assert "Undefined" not in text and "[[" not in text


def test_rendered_prompts_carry_the_facts():
    ctx = full_context("mcp_delivery", feedback="Use PAY stories only.")
    by_id = {st["id"]: st for _, st in steps(BLUEPRINTS["mcp_delivery"])}
    backlog = render(by_id["jira_backlog"]["config"]["prompt"], ctx, STRICT)
    assert 'parent_key "PAY-31"' in backlog and 'project_key "PAY"' in backlog
    assert "- get_nostro_balances — balance per account\n- list_nostro_accounts — accounts\nAcceptance" in backlog
    assert backlog.rstrip().endswith("Use PAY stories only.")
    routing = render(by_id["team_routing"]["config"]["prompt"], ctx, STRICT)
    assert "team_id: team_pay | name: Payments | jira_project_key: PAY" in routing
    assert "only):\n- team_id" in routing and "\n\nThe team that owns" in routing   # list spliced, blank line kept
    tools_as_text = {**ctx, "vars": {**ctx["vars"], "spec": {**ctx["vars"]["spec"], "tools": "get_x — one tool"}}}
    assert "Tools:\n- get_x — one tool\n" in render(by_id["estimate"]["config"]["prompt"], tools_as_text, STRICT)
    assert "Tools: (none specified)" in render(by_id["estimate"]["config"]["prompt"], empty_context())
    signoff = render(by_id["spec_signoff"]["config"]["brief_prompt"], ctx, STRICT)
    assert "PAY-31 (an existing epic was reused)" in signoff

    uc = full_context("use_case_onboarding")
    qualify = next(st for _, st in steps(BLUEPRINTS["use_case_onboarding"]) if st["id"] == "qualify")
    text = render(qualify["config"]["prompt"], uc, STRICT)
    assert "- Data Platform: data warehouse" in text and "Monitor covenants from Loan IQ" in text


def test_conditions():
    uc = BLUEPRINTS["use_case_onboarding"]
    fan_out = next(st for _, st in steps(uc) if st["type"] == "fan_out")
    update = next(st for _, st in steps(uc) if st["id"] == "portfolio_update")
    ctx = full_context("use_case_onboarding")
    assert evaluate(fan_out["when"], ctx) is True
    nothing_missing = {**ctx, "vars": {**ctx["vars"], "dependencies": {"required": [], "missing": []}}}
    assert evaluate(fan_out["when"], nothing_missing) is False
    assert evaluate(update["when"], ctx) and not evaluate(update["when"], empty_context())
    children = render_obj(fan_out["config"]["inputs"], ctx)
    assert children["mcp_name"] == "Loan IQ Covenants MCP" and children["suggested_team"] == "Data Platform"
    assert children["parent_use_case"] == "UC-0001 — Corporate Loan Covenant Monitoring"
    until = next(st for _, st in steps(BLUEPRINTS["mcp_delivery"]) if st["type"] == "wait_for")["config"]["until"]
    assert evaluate(until, {"output": {"status": "Done"}}) and not evaluate(until, {"output": {"status": "In Progress"}})


# ---------------------------------------------------------------------------
# Seeding and the demo installer
# ---------------------------------------------------------------------------

def test_seed_defaults_adds_only_what_is_missing(container):
    store = container.store
    assert seed_defaults(container) == {"roles": True, "rules": len(RULES), "blueprints": 3}
    assert seed_defaults(container) == {"roles": False, "rules": 0, "blueprints": 0}
    stored = {b["key"]: b for b in store.list("blueprints")}
    assert all(b["builtin"] and b["status"] == "active" and b["id"] == f"bp_{k}" for k, b in stored.items())
    assert [r["key"] for r in container.roles()] == [r["key"] for r in ROLES]

    # User edits survive; a deleted builtin comes back; a user copy holding the stable id is never overwritten.
    rule = next(r for r in store.list("rules") if r["code"] == "SEC-01")
    store.put("rules", {**rule, "severity": "low"})
    store.put("blueprints", {**stored["mcp_delivery"], "name": "MCP Delivery (bank edition)"})
    store.put("blueprints", {**stored["change_request"], "key": "change_request_v2"})
    store.delete("blueprints", "bp_use_case_onboarding")
    store.put_singleton("roles", {"roles": [ROLES[0]]})
    assert seed_defaults(container) == {"roles": False, "rules": 0, "blueprints": 2}
    by_key = {b["key"]: b for b in store.list("blueprints")}
    assert by_key["mcp_delivery"]["name"] == "MCP Delivery (bank edition)"
    assert by_key["change_request_v2"]["id"] == "bp_change_request"
    assert by_key["change_request"]["id"].startswith("bp_") and by_key["change_request"]["id"] != "bp_change_request"
    assert by_key["use_case_onboarding"]["id"] == "bp_use_case_onboarding"
    assert next(r for r in store.list("rules") if r["code"] == "SEC-01")["severity"] == "low"
    assert len(container.roles()) == 1


@pytest.fixture
def demo(container, tmp_path, monkeypatch):
    monkeypatch.setattr(container.settings, "data_dir", str(tmp_path / "data"))
    first = install_demo(container)
    yield container, first
    asyncio.run(container.mcp.close_all())


def test_install_demo_is_complete_and_idempotent(demo):
    container, first = demo
    store = container.store
    assert first == {"created": {"users": len(DEMO_USERS), "teams": len(DEMO_TEAMS), "connectors": 2,
                                 "operations": len(OPERATIONS), "watchers": 1}}
    assert install_demo(container) == {"created": {"users": 0, "teams": 0, "connectors": 0, "operations": 0, "watchers": 0}}

    users = {u["email"]: User.model_validate(u) for u in store.list("users")}
    assert set(users) == {u["email"] for u in DEMO_USERS}
    assert {r for u in users.values() for r in u.roles} == ROLE_KEYS - {"business_user"}
    teams = {t["name"]: Team.model_validate(t) for t in store.list("teams")}
    assert {t.jira_project_key for t in teams.values()} == {"MCPF", "DATA", "PAY", "SEC", "OPS"}
    sofia = users["sofia.rossi@doing.ai"]
    assert teams["MCP Factory Squad"].lead_user_id == sofia.id and teams["MCP Factory Squad"].id in sofia.team_ids
    assert all(t.skills and t.lead_user_id and t.member_ids for t in teams.values())

    connectors = {c["name"]: Connector.model_validate(c) for c in store.list("connectors")}
    sandbox_dir = Path(container.settings.data_path) / "sandbox"
    for name, script, kind in ((PORTFOLIO_CONNECTOR, "doing_ai_mcp.py", "portfolio"), (JIRA_CONNECTOR, "jira_mcp.py", "jira")):
        con = connectors[name]
        assert con.transport == "stdio" and con.command == sys.executable and con.sandbox and con.kind == kind
        assert con.args == [str(MCP_SERVERS_DIR / script)] and Path(con.args[0]).is_file()
        assert all(Path(v).parent == sandbox_dir for k, v in con.env.items() if k.endswith("STATE"))
    assert connectors[PORTFOLIO_CONNECTOR].slug == defaults.PORTFOLIO_SANDBOX_SLUG

    ops = {o["key"]: Operation.model_validate(o) for o in store.list("operations")}
    assert set(ops) == set(OPERATIONS)
    sensitive = {k for k, o in ops.items() if o.sensitive}
    assert sensitive == {"portfolio.register_mcp", "portfolio.update_status", "jira.ensure_epic", "jira.create_issue",
                         "jira.create_stories", "jira.create_change"}
    assert ops["jira.ensure_epic"].mode == "agent" and ops["jira.ensure_epic"].output.json_schema["required"] == [
        "key", "url", "created", "project_key"]
    assert ops["portfolio.list_projects"].connector_id == connectors[PORTFOLIO_CONNECTOR].id
    assert ops["jira.create_stories"].connector_id == connectors[JIRA_CONNECTOR].id

    watcher = Watcher.model_validate(next(w for w in store.list("watchers") if w["name"] == WATCHER_NAME))
    assert watcher.operation_key == "portfolio.list_projects" and watcher.input == {"status": "Planning"}
    assert watcher.schedule.every_minutes == 15 and watcher.action == "intake"
    assert watcher.blueprint_id == container.get_blueprint_by_key("use_case_onboarding")["id"]
    assert {k.removeprefix("inputs.") for k in watcher.mapping if k.startswith("inputs.")} <= {
        f["key"] for f in BLUEPRINTS["use_case_onboarding"]["inputs"]}
    assert [e["kind"] for e in store.list_events(kinds=["demo.installed"])] == ["demo.installed"] * 2


def test_demo_operations_work_against_the_sandbox_servers(demo):
    """Every direct operation runs with its own test input through the Factory's MCP client;
    the agent operation's tools exist; the builtin blueprints' data hand-offs hold against the
    real tool outputs (watcher mapping, epic search, story batch, change link, catalog registration)."""
    container, _ = demo
    connectors = {c["name"]: c["id"] for c in container.store.list("connectors")}
    con_of = {"portfolio": connectors[PORTFOLIO_CONNECTOR], "jira": connectors[JIRA_CONNECTOR]}
    by_step = {st["id"]: st for bp in BUILTIN_BLUEPRINTS for _, st in steps(bp)}

    async def run_op(key: str, input: dict) -> Any:
        op = OPERATIONS[key]
        args = render_obj(op["args_template"], {"input": input})
        result = await container.mcp.call_tool(con_of[op["connector"]], op["tool"], args)
        assert result["ok"], (key, args, result["error"])
        extract = op["output"]["extract"]
        return evaluate(extract, {"result": result["data"]}) if extract else result["data"]

    async def scenario() -> None:
        try:
            await exercise()
        finally:   # close the stdio servers in the loop that opened them
            await container.mcp.close_all()

    async def exercise() -> None:
        tools = {}
        for kind, cid in con_of.items():
            connector = await container.mcp.test(cid)
            assert connector["status"]["ok"], connector["status"]
            tools[kind] = {t["name"]: t for t in connector["tools"]}
        assert len(tools["portfolio"]) == 9 and len(tools["jira"]) == 8

        for key, op in OPERATIONS.items():
            if op["mode"] == "agent":
                assert set(op["allowed_tools"]) <= set(tools[op["connector"]])
                continue
            schema = tools[op["connector"]][op["tool"]]["input_schema"]
            assert set(op["args_template"]) <= set(schema["properties"]), key
            assert set(schema.get("required", [])) <= set(op["args_template"]), key
            assert await run_op(key, op["test_input"]) is not None, key
        for name in {t.split("__")[-1] for t in PORTFOLIO_AGENT_TOOLS}:
            assert tools["portfolio"][name]["read_only"] and not tools["portfolio"][name]["sensitive"]
        story_fields = defaults.BACKLOG_SCHEMA["properties"]["issues"]["items"]["properties"]
        assert set(story_fields) <= set(tools["jira"]["jira_create_issue"]["input_schema"]["properties"])

        # Watcher: Planning use cases → intake fields
        watcher = demo_watcher("bp_use_case_onboarding")
        output = await run_op(watcher["operation_key"], watcher["input"])
        items = [i for i in evaluate(watcher["items_expr"], {"result": output}) if evaluate(watcher["filter"], {"item": i})]
        assert {i[watcher["key_field"]] for i in items} == {"prj-1005", "prj-1006"}
        mapped = {i["id"]: render_obj(watcher["mapping"], {"item": i}, STRICT) for i in items}
        assert mapped["prj-1006"]["sponsor_email"] == "alice.martin@doing.ai"
        assert mapped["prj-1006"]["inputs.business_unit"] == "Global Banking"
        assert "Loan IQ" in mapped["prj-1006"]["inputs.context"] and mapped["prj-1006"]["tags"] == ["lending", "covenants", "agent", "credit"]
        assert mapped["prj-1005"]["priority"] == "high" and mapped["prj-1005"]["title"] == "Intraday Liquidity Forecasting Agent"

        # Jira epic: the goal's first search finds the seeded open epic in the routed team project
        ctx = full_context("mcp_delivery")
        epic_input = render_obj(by_step["jira_epic"]["config"]["input"], ctx, STRICT)
        goal = render(OPERATIONS["jira.ensure_epic"]["prompt"], {"input": epic_input}, STRICT)
        jql = re.search(r"jql: (.+)", goal)[1]
        assert jql == 'project = PAY AND issuetype = Epic AND summary ~ "Nostro Balances MCP"'
        assert [i["key"] for i in await run_op("jira.search", {"jql": jql})] == ["PAY-31"]
        assert 'labels ["mcp", "doing-factory"]' in goal
        assert "copied exactly:\nRead-only nostro balances.\n\nRequested by: UC-0001 — Intraday Liquidity" in goal

        # Stories: the backlog shape goes through jira.create_stories unchanged
        stories_input = render_obj(by_step["create_stories"]["config"]["input"], ctx, STRICT)
        assert stories_input == {"issues": SAMPLES["mcp_delivery"]["vars"]["jira_backlog"]["issues"]}
        created = await run_op("jira.create_stories", stories_input)
        assert created["count"] == 2 and all(i["parent_key"] == "PAY-31" for i in created["created"])

        # Development waits on the epic
        until = by_step["development"]["config"]["until"]
        epic_ctx = render_obj(by_step["development"]["config"]["input"], ctx, STRICT)
        assert not evaluate(until, {"output": await run_op("jira.get_issue", epic_ctx)})
        await container.mcp.call_tool(con_of["jira"], "jira_transition_issue", {"issue_key": "PAY-31", "status": "Done"})
        assert evaluate(until, {"output": await run_op("jira.get_issue", epic_ctx)})

        # Change ticket and its link
        change = await run_op("jira.create_change", render_obj(by_step["change_ticket"]["config"]["input"], ctx, STRICT))
        link = render_obj(by_step["change_ticket"]["config"]["create_link"], {**ctx, "output": change}, STRICT)
        assert change["issue_type"] == "Change" and change["priority"] == "High"
        assert link["url"] == f"https://jira.sandbox.local/browse/{change['key']}" and link["external_id"].startswith("OPS-")

        # Catalog registration: the delivered server becomes findable
        registration = await run_op("portfolio.register_mcp", render_obj(by_step["register_mcp"]["config"]["input"], ctx, STRICT))
        assert registration["created"] and registration["server"]["tools"][0]["name"] == "get_nostro_balances"
        link = render_obj(by_step["register_mcp"]["config"]["create_link"], {**ctx, "output": registration}, STRICT)
        assert link["external_id"] == registration["server"]["id"]
        top = (await run_op("portfolio.search_mcp", {"capability": "nostro account balances"}))[0]
        assert top["server"]["id"] == registration["server"]["id"] and top["score"] >= 0.6

        # Go-live: the DOINg.AI use case is marked delivered
        uc_ctx = full_context("use_case_onboarding")
        updated = await run_op("portfolio.update_status", render_obj(by_step["portfolio_update"]["config"]["input"], uc_ctx, STRICT))
        assert (updated["project"]["status"], updated["project"]["devStatus"]) == ("Done", "prod")

    asyncio.run(scenario())
