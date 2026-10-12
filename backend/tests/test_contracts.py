"""SPEC §12 is the contract every backend module codes against. Most of it is still stubbed
when the foundation lands, and different builders replace the stubs in parallel; this test
pins the names, the sync/async split and the parameter names, so a renamed argument fails here
rather than as a TypeError three calls deep in a running workflow."""
from __future__ import annotations

import importlib
import inspect

import pytest

ASYNC, SYNC = True, False

# (module, attribute path, async?, parameter names the callers pass — beyond self)
CONTRACT: list[tuple[str, str, bool, list[str]]] = [
    # deps / events / store
    ("app.deps", "Container.app_settings", SYNC, []),
    ("app.deps", "Container.save_app_settings", SYNC, ["patch"]),
    ("app.deps", "Container.rebuild_llm", SYNC, []),
    ("app.deps", "Container.users", SYNC, []),
    ("app.deps", "Container.get_user", SYNC, ["id"]),
    ("app.deps", "Container.user_by_email", SYNC, ["email"]),
    ("app.deps", "Container.teams", SYNC, []),
    ("app.deps", "Container.get_team", SYNC, ["id"]),
    ("app.deps", "Container.roles", SYNC, []),
    ("app.deps", "Container.get_operation_by_key", SYNC, ["key"]),
    ("app.deps", "Container.get_blueprint", SYNC, ["id"]),
    ("app.deps", "Container.get_blueprint_by_key", SYNC, ["key"]),
    ("app.deps", "Container.record_event", SYNC, ["kind", "message", "actor", "project_id", "step_id", "data"]),
    ("app.events", "EventBus.subscribe", SYNC, []),
    ("app.events", "EventBus.unsubscribe", SYNC, ["q"]),
    ("app.events", "EventBus.emit", SYNC, ["type"]),
    ("app.store", "Store.get", SYNC, ["coll", "id"]),
    ("app.store", "Store.list", SYNC, ["coll"]),
    ("app.store", "Store.put", SYNC, ["coll", "doc"]),
    ("app.store", "Store.delete", SYNC, ["coll", "id"]),
    ("app.store", "Store.get_singleton", SYNC, ["coll", "default"]),
    ("app.store", "Store.put_singleton", SYNC, ["coll", "doc"]),
    ("app.store", "Store.add_event", SYNC, ["ev"]),
    ("app.store", "Store.verify_events", SYNC, []),
    ("app.store", "Store.llm_stats", SYNC, ["project_id"]),
    ("app.store", "Store.list_events", SYNC, ["project_id", "kinds", "limit", "before"]),
    ("app.store", "Store.add_llm_call", SYNC, ["call"]),
    ("app.store", "Store.list_llm_calls", SYNC, ["since"]),
    ("app.store", "Store.next_seq", SYNC, ["name"]),
    # LLM
    ("app.llm.client", "make_llm", SYNC, ["cfg"]),
    ("app.llm.client", "LLMClient.is_remote", SYNC, ["model"]),
    ("app.llm.client", "LLMClient.chat", ASYNC, ["messages", "model", "temperature", "json_mode", "json_schema",
                                                 "tools", "max_tokens", "timeout_s"]),
    ("app.llm.client", "LLMClient.supports_tools", ASYNC, ["model"]),
    ("app.llm.client", "LLMClient.list_models", ASYNC, []),
    ("app.llm.client", "LLMClient.test", ASYNC, []),
    ("app.llm.runtime", "AIRuntime.prompt", SYNC, ["key"]),
    ("app.llm.runtime", "AIRuntime.ask", ASYNC, ["role", "user", "prompt_key", "system", "json", "json_schema", "fast",
                                                 "temperature", "max_tokens", "project_id", "step_id"]),
    ("app.llm.runtime", "AIRuntime.chat", ASYNC, ["role", "messages", "tools", "fast", "temperature", "project_id",
                                                  "step_id"]),
    # MCP
    ("app.mcp.manager", "MCPManager.test", ASYNC, ["connector_id"]),
    ("app.mcp.manager", "MCPManager.list_tools", ASYNC, ["connector_id", "refresh"]),
    ("app.mcp.manager", "MCPManager.call_tool", ASYNC, ["connector_id", "tool", "args", "timeout_s"]),
    ("app.mcp.manager", "MCPManager.tool_index", SYNC, ["connector_ids"]),
    ("app.mcp.manager", "MCPManager.resolve", SYNC, ["qualified"]),
    ("app.mcp.manager", "MCPManager.disconnect", ASYNC, ["connector_id"]),
    ("app.mcp.manager", "MCPManager.close_all", ASYNC, []),
    ("app.mcp.operations", "OperationExecutor.run", ASYNC, ["op", "input", "ctx", "project_id", "step_id",
                                                            "args_override", "prepare_only", "agent_state",
                                                            "autonomy", "trace"]),
    ("app.mcp.agent", "run_agent", ASYNC, ["container", "goal", "connector_ids", "allowed_tools", "max_actions",
                                           "timeout_s", "output_schema", "autonomy", "context", "state", "confirmed",
                                           "project_id", "step_id", "trace"]),
    # engine
    ("app.engine.templating", "render", SYNC, ["template", "ctx"]),
    ("app.engine.templating", "render_obj", SYNC, ["obj", "ctx"]),
    ("app.engine.templating", "evaluate", SYNC, ["expr", "ctx"]),
    ("app.engine.templating", "condition", SYNC, ["expr", "ctx"]),
    *[("app.engine.executors_ai", name, ASYNC, ["sc", *extra]) for name, extra in [
        ("exec_ai_task", []), ("exec_mcp_operation", []), ("exec_agent_task", []), ("exec_quality_gate", []),
        ("resolve_confirmation", ["approve", "payload"]), ("regenerate_ai_task", ["instructions"]),
        ("rerun_gate", ["rule_ids"]), ("draft_form", ["instructions"]), ("suggest_estimate", []),
        ("approval_brief", []), ("critic_advice", ["error"]), ("compose_notification", ["cfg"])]],
    ("app.engine.engine", "WorkflowEngine.recover", ASYNC, []),
    ("app.engine.engine", "WorkflowEngine.create_project", ASYNC, [
        "blueprint_id", "title", "description", "inputs", "priority", "sponsor_id", "owner_id", "team_id", "tags",
        "due_date", "source", "parent_id", "parent_step_id", "created_by"]),
    ("app.engine.engine", "WorkflowEngine.kick", SYNC, ["project_id"]),
    ("app.engine.engine", "WorkflowEngine.advance", ASYNC, ["project_id"]),
    ("app.engine.engine", "WorkflowEngine.get", SYNC, ["project_id"]),
    ("app.engine.engine", "WorkflowEngine.summary", SYNC, ["project"]),
    ("app.engine.engine", "WorkflowEngine.list_summaries", SYNC, ["status", "blueprint_id", "q", "parent_id",
                                                                  "user_id"]),
    ("app.engine.engine", "WorkflowEngine.can_act", SYNC, ["project", "step", "user_id"]),
    *[("app.engine.engine", f"WorkflowEngine.{name}", ASYNC, ["pid", "sid", "user_id", *extra]) for name, extra in [
        ("start_step", []), ("save_form", ["form"]), ("complete_step", ["form", "output"]),
        ("request_ai_draft", ["instructions"]), ("decide", ["decision", "comment"]),
        ("submit_estimate", ["estimate"]), ("confirm", ["approve", "payload"]),
        ("gate_action", ["action", "comment", "rule_ids", "goto_step"]), ("retry_step", []),
        ("skip_step", ["reason"]), ("reopen_step", ["reason"]), ("reassign_step", ["user_ids"])]],
    ("app.engine.engine", "WorkflowEngine.cancel_project", ASYNC, ["pid", "user_id", "reason"]),
    ("app.engine.engine", "WorkflowEngine.update_project", ASYNC, ["pid", "user_id", "patch"]),
    ("app.engine.engine", "WorkflowEngine.update_artifact", ASYNC, ["pid", "artifact_id", "user_id", "content"]),
    ("app.engine.engine", "WorkflowEngine.add_comment", ASYNC, ["pid", "user_id", "text"]),
    ("app.engine.engine", "WorkflowEngine.add_link", ASYNC, ["pid", "user_id", "link"]),
    ("app.engine.engine", "WorkflowEngine.delete_project", ASYNC, ["pid"]),
    ("app.engine.engine", "WorkflowEngine.poll_wait_step", ASYNC, ["pid", "sid"]),
    ("app.engine.engine", "WorkflowEngine.flag_sla", ASYNC, ["pid", "sid"]),
    ("app.engine.engine", "WorkflowEngine.refresh_risk", ASYNC, ["pid"]),
    # services
    ("app.notify", "Notifier.notify", ASYNC, ["user_ids", "kind", "title", "body", "project_id", "step_id",
                                              "external"]),
    ("app.notify", "Notifier.list", SYNC, ["user_id", "unread_only", "limit"]),
    ("app.notify", "Notifier.mark_read", SYNC, ["user_id", "ids", "all"]),
    ("app.watchers", "WatcherService.run", ASYNC, ["watcher_id"]),
    ("app.watchers", "WatcherService.analyze_intake", ASYNC, ["intake_id"]),
    ("app.watchers", "WatcherService.accept_intake", ASYNC, ["intake_id", "user_id", "overrides"]),
    ("app.watchers", "WatcherService.dismiss_intake", ASYNC, ["intake_id", "user_id", "reason"]),
    ("app.watchers", "WatcherService.due", SYNC, ["now"]),
    ("app.scheduler", "Scheduler.start", SYNC, []),
    ("app.scheduler", "Scheduler.stop", ASYNC, []),
    ("app.risk", "compute_risk", SYNC, ["project", "now"]),
    ("app.kpis", "compute_kpis", SYNC, ["container", "days"]),
    ("app.inbox", "inbox_for", SYNC, ["container", "user_id"]),
    ("app.inbox", "inbox_counts", SYNC, ["container", "user_id"]),
    ("app.copilot", "chat", ASYNC, ["container", "user_id", "message", "chat_id", "project_id"]),
    # every ai_utils helper takes the container first
    ("app.ai_utils", "rewrite", ASYNC, ["container", "text", "style", "instructions"]),
    ("app.ai_utils", "briefing", ASYNC, ["container", "user_id"]),
    ("app.ai_utils", "project_report", ASYNC, ["container", "pid", "audience"]),
    ("app.ai_utils", "explain_risk", ASYNC, ["container", "pid"]),
    ("app.ai_utils", "summarize_project", ASYNC, ["container", "pid"]),
    ("app.ai_utils", "generate_blueprint", ASYNC, ["container", "description"]),
    ("app.ai_utils", "suggest_operation", ASYNC, ["container", "connector_id", "intent"]),
    ("app.ai_utils", "simulate_use_case", ASYNC, ["container", "hint"]),
]


def _resolve(module: str, path: str):
    obj = importlib.import_module(module)
    for part in path.split("."):
        obj = getattr(obj, part)
    return obj


@pytest.mark.parametrize("module,path,is_async,params", CONTRACT, ids=[f"{m}:{p}" for m, p, *_ in CONTRACT])
def test_spec_interface(module: str, path: str, is_async: bool, params: list[str]) -> None:
    fn = _resolve(module, path)
    assert inspect.iscoroutinefunction(fn) is is_async, f"{module}.{path} must be {'async' if is_async else 'sync'}"
    accepted = inspect.signature(fn).parameters
    takes_kwargs = any(p.kind is p.VAR_KEYWORD for p in accepted.values())
    missing = [name for name in params if name not in accepted and not takes_kwargs]
    assert not missing, f"{module}.{path} lost parameter(s) {missing} that SPEC §12 callers pass"


def test_container_exposes_every_subsystem(container) -> None:
    for name in ("settings", "store", "bus", "llm", "ai", "mcp", "ops", "engine", "notifier", "watchers", "scheduler"):
        assert getattr(container, name) is not None, f"Container.{name} missing"
    llm = container.llm
    for attr in ("configured", "provider", "model", "fast_model"):
        assert hasattr(llm, attr), f"LLMClient.{attr} missing"
    assert hasattr(container.scheduler, "running") and hasattr(container.scheduler, "last_tick_at")
    assert hasattr(importlib.import_module("app.factory_mcp"), "router")
