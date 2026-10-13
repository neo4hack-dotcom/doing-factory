"""Core API: system, settings, people, library, WebSocket, error mapping and SPA serving."""
from __future__ import annotations

import importlib
import json
import time
from pathlib import Path

import pytest

SECRET = "sk-test-0123456789abcdef"


def _events(container, section: str) -> list[dict]:
    """settings.updated events of one audited area, newest first ("settings" = PUT /settings)."""
    evs = container.store.list_events(kinds=["settings.updated"])
    if section == "settings":
        return [e for e in evs if "sections" in e["data"]]
    return [e for e in evs if e["data"].get("section") == section]


# ---------------------------------------------------------------------------------- system


def test_health_reports_configuration_without_calling_anything(client, container):
    for i, status in enumerate(["active", "waiting", "done", "blocked", "cancelled"]):
        container.store.put("projects", {"id": f"prj_{i}", "status": status})
    body = client.get("/api/health").json()
    assert body["ok"] is True and body["version"]
    assert body["llm"] == {"configured": False, "model": "", "provider": "ollama"}
    assert body["scheduler_running"] is False                 # FACTORY_BACKGROUND_JOBS=false
    assert body["counts"] == {"projects_active": 3}
    assert client.get("/api/health", params={"user_id": "usr_x"}).json()["counts"]["inbox"] == 0


def test_bootstrap_shape_and_onboarding(client, container):
    body = client.get("/api/bootstrap").json()
    assert set(body) == {"settings", "roles", "users", "teams", "blueprints", "connectors", "operations", "onboarding"}
    assert body["settings"]["llm"]["api_key"] == "" and body["settings"]["has_api_key"] is False
    assert body["onboarding"] == {"llm_configured": False, "has_connectors": False, "has_users": False,
                                  "has_portfolio": False, "has_jira": False, "has_standard_operations": False}

    container.store.put("connectors", {"id": "con_1", "name": "Jira", "kind": "jira", "transport": "stdio",
                                       "env": {"JIRA_API_TOKEN": "abcdefghijklmnopqrstuvwxyz"}})
    container.store.put("users", {"id": "usr_1", "name": "Alice"})
    body = client.get("/api/bootstrap").json()
    assert body["onboarding"] == {"llm_configured": False, "has_connectors": True, "has_users": True,
                                  "has_portfolio": False, "has_jira": True, "has_standard_operations": False}
    assert "sandbox" not in body["connectors"][0]
    connector = body["connectors"][0]
    assert "abcdefghijklmnopqrstuvwxyz" not in json.dumps(connector)
    assert connector["status"] == {"ok": None, "checked_at": None, "error": "", "latency_ms": 0,
                                   "server_name": "", "server_version": "", "tool_count": 0}   # normalised
    assert body["users"][0]["roles"] == [] and "version" not in body["users"][0]


def test_unknown_api_path_is_a_json_404(client):
    for method in ("get", "post", "delete"):
        response = getattr(client, method)("/api/definitely-not-here")
        assert response.status_code == 404
        assert "definitely-not-here" in response.json()["detail"]


# ---------------------------------------------------------------------------------- settings


def test_settings_round_trip_never_returns_the_api_key(client, container):
    response = client.put("/api/settings", json={
        "llm": {"base_url": "http://127.0.0.1:9", "model": "qwen3.5:4b", "api_key": SECRET},
        "engine": {"max_retries": 4}, "user_id": "usr_admin"})
    assert response.status_code == 200
    body = response.json()
    assert body["llm"]["api_key"] == "" and body["has_api_key"] is True
    assert body["llm"]["model"] == "qwen3.5:4b" and body["engine"]["max_retries"] == 4
    assert body["engine"]["autonomy"] == "approve_writes"                    # untouched defaults kept
    assert SECRET not in client.get("/api/settings").text
    assert SECRET not in client.get("/api/bootstrap").text
    assert container.app_settings().llm.api_key == SECRET                   # kept server-side

    for keep in ("", "••••cdef"):                                            # empty / masked = unchanged
        client.put("/api/settings", json={"llm": {"api_key": keep, "temperature": 0.5}})
        assert container.app_settings().llm.api_key == SECRET
    assert client.put("/api/settings", json={"llm": {"api_key": None}}).json()["has_api_key"] is False

    events = _events(container, "settings")
    assert events and all(SECRET not in json.dumps(e) for e in events)
    first = events[-1]
    assert first["actor"] == "usr_admin" and "llm.api_key" in first["data"]["fields"]
    assert first["data"]["sections"] == ["llm", "engine"]


def test_settings_validation_errors_are_readable(client):
    response = client.put("/api/settings", json={"llm": {"provider": "bard"}})
    assert response.status_code == 422 and isinstance(response.json()["detail"], str)
    assert "provider" in response.json()["detail"]
    assert client.put("/api/settings", json={"nonsense": {}}).status_code == 422
    assert client.put("/api/settings", json={"llm": "ollama"}).status_code == 422


def test_unchanged_settings_are_not_audited(client, container):
    client.put("/api/settings", json={"general": {"company": "ACME"}})
    client.put("/api/settings", json={"general": {"company": "ACME"}})
    assert len(_events(container, "settings")) == 1


def test_settings_sections_match_the_model():
    from app.api.routes_settings import SECTION_LABELS
    from app.models import AppSettings
    assert set(SECTION_LABELS) == set(AppSettings.model_fields) - {"has_api_key"}


def test_llm_helpers_degrade_honestly_when_unconfigured(client):
    presets = client.get("/api/llm/presets").json()
    assert presets and {"id", "label", "provider", "base_url"} <= set(presets[0])
    result = client.post("/api/llm/test", json={}).json()
    assert result["ok"] is False and result["error"]
    assert client.post("/api/llm/test").json()["ok"] is False                # body is optional
    models = client.get("/api/llm/models").json()
    assert models["models"] == [] and "error" in models


# ---------------------------------------------------------------------------------- people


@pytest.fixture
def roles(client):
    response = client.put("/api/roles", json=[{"key": "sponsor", "label": "Sponsor"},
                                              {"key": "developer", "label": "Developer"},
                                              {"label": "Dev Lead"}, {"key": "admin", "label": "Admin"}])
    assert response.status_code == 200
    return response.json()


def test_roles_are_normalised_and_validated(client, roles):
    assert [r["key"] for r in roles] == ["sponsor", "developer", "dev_lead", "admin"]
    assert client.get("/api/roles").json() == roles
    assert client.put("/api/roles", json=[{"key": "a"}, {"key": "A"}]).status_code == 422
    assert client.put("/api/roles", json={"roles": "nope"}).status_code == 422


def test_users_crud_with_validation(client, container, roles):
    alice = client.post("/api/users", json={"name": " Alice Martin ", "email": "alice@corp.example",
                                            "roles": ["sponsor", "sponsor"], "user_id": "usr_admin"})
    assert alice.status_code == 200, alice.text
    alice = alice.json()
    assert alice["id"].startswith("usr_") and alice["name"] == "Alice Martin" and alice["roles"] == ["sponsor"]
    assert alice["created_at"].endswith("Z")

    dup = client.post("/api/users", json={"name": "Imposter", "email": "ALICE@corp.example"})
    assert dup.status_code == 409 and "already used" in dup.json()["detail"]
    assert client.post("/api/users", json={"name": "X", "roles": ["wizard"]}).status_code == 422
    assert client.post("/api/users", json={"name": "X", "email": "not-an-email"}).status_code == 422
    assert client.post("/api/users", json={"email": "anon@corp.example"}).status_code == 422
    assert client.post("/api/users", json={"name": "X", "team_ids": ["team_nope"]}).status_code == 422

    updated = client.put(f"/api/users/{alice['id']}", json={"title": "CDO", "email": "alice@corp.example"}).json()
    assert updated["title"] == "CDO" and updated["roles"] == ["sponsor"]              # partial update
    assert client.put("/api/users/usr_missing", json={"name": "x"}).status_code == 404
    assert [u["id"] for u in client.get("/api/users").json()] == [alice["id"]]

    assert client.delete(f"/api/users/{alice['id']}").json() == {"ok": True, "id": alice["id"]}
    assert client.delete(f"/api/users/{alice['id']}").status_code == 404
    actions = [e["data"]["action"] for e in reversed(_events(container, "people"))]
    assert actions == ["user.created", "user.updated", "user.deleted"]
    assert _events(container, "people")[-1]["actor"] == "usr_admin"


def test_role_held_by_a_user_cannot_be_removed(client, roles):
    client.post("/api/users", json={"name": "Dev", "roles": ["developer"]})
    response = client.put("/api/roles", json=[r for r in roles if r["key"] != "developer"])
    assert response.status_code == 409 and "Dev" in response.json()["detail"]


def test_team_membership_stays_in_step_on_both_sides(client, roles):
    team = client.post("/api/teams", json={"name": "MCP Factory Squad", "jira_project_key": "mcpf",
                                           "skills": ["python", "python", "mcp"]}).json()
    assert team["jira_project_key"] == "MCPF" and team["skills"] == ["python", "mcp"]
    assert client.post("/api/teams", json={"name": "mcp factory squad"}).status_code == 409

    sofia = client.post("/api/users", json={"name": "Sofia", "roles": ["dev_lead"], "team_ids": [team["id"]]}).json()
    karim = client.post("/api/users", json={"name": "Karim", "roles": ["developer"]}).json()
    teams = {t["id"]: t for t in client.get("/api/teams").json()}
    assert teams[team["id"]]["member_ids"] == [sofia["id"]]

    # Team side → users: Karim joins (and leads, which implies membership), Sofia leaves.
    team = client.put(f"/api/teams/{team['id']}", json={"member_ids": [], "lead_user_id": karim["id"]}).json()
    assert team["member_ids"] == [karim["id"]]
    users = {u["id"]: u for u in client.get("/api/users").json()}
    assert users[karim["id"]]["team_ids"] == [team["id"]] and users[sofia["id"]]["team_ids"] == []

    # Deleting the lead clears the lead and the membership.
    client.delete(f"/api/users/{karim['id']}")
    team = client.get("/api/teams").json()[0]
    assert team["lead_user_id"] == "" and team["member_ids"] == []

    # Deleting a team removes it from its members.
    client.put(f"/api/users/{sofia['id']}", json={"team_ids": [team["id"]]})
    assert client.delete(f"/api/teams/{team['id']}").json()["ok"] is True
    assert client.get("/api/users").json()[0]["team_ids"] == []
    assert client.put("/api/teams/team_missing", json={"name": "x"}).status_code == 404


# ---------------------------------------------------------------------------------- library


def test_prompts_edit_and_reset(client, container):
    from app.llm.prompts import DEFAULT_PROMPTS

    key = next(iter(DEFAULT_PROMPTS))
    prompts = {p["key"]: p for p in client.get("/api/prompts").json()}
    assert set(prompts) == set(DEFAULT_PROMPTS)
    original = prompts[key]
    assert original["content"] == original["default_content"] and original["name"]

    edited = client.put(f"/api/prompts/{key}", json={"content": "Be brief.", "user_id": "usr_admin"}).json()
    assert edited["content"] == "Be brief." and edited["default_content"] == original["default_content"]
    assert edited["updated_at"].endswith("Z")
    assert {p["key"]: p for p in client.get("/api/prompts").json()}[key]["content"] == "Be brief."

    reset = client.post(f"/api/prompts/{key}/reset").json()
    assert reset["content"] == original["default_content"] and reset["updated_at"] == ""
    assert container.store.get("prompts", key) is None

    assert client.put(f"/api/prompts/{key}", json={"content": "   "}).status_code == 422
    assert client.put("/api/prompts/no_such_prompt", json={"content": "x"}).status_code == 404
    assert client.post("/api/prompts/no_such_prompt/reset").status_code == 404
    actions = [e["data"]["action"] for e in reversed(_events(container, "prompts"))]
    assert actions == ["prompt.updated", "prompt.reset"]


def test_rules_crud(client, container):
    rule = client.post("/api/rules", json={"title": "Secrets never in code", "category": "Security",
                                           "severity": "critical", "tags": ["mcp", "security", "mcp"]}).json()
    assert rule["id"].startswith("rule_") and rule["code"].startswith("RULE-") and rule["tags"] == ["mcp", "security"]
    named = client.post("/api/rules", json={"title": "Auth required", "code": "sec-99"}).json()
    assert named["code"] == "SEC-99"
    assert client.post("/api/rules", json={"title": "Clash", "code": "SEC-99"}).status_code == 409
    assert client.post("/api/rules", json={"title": "Seeded", "code": "sec-01"}).status_code == 409   # builtin rule
    assert client.post("/api/rules", json={"title": "Bad", "severity": "apocalyptic"}).status_code == 422
    assert client.post("/api/rules", json={"code": "X-1"}).status_code == 422

    updated = client.put(f"/api/rules/{rule['id']}", json={"enabled": False}).json()
    assert updated["enabled"] is False and updated["title"] == "Secrets never in code"
    assert client.delete(f"/api/rules/{named['id']}").json()["ok"] is True
    assert [r["id"] for r in client.get("/api/rules").json() if r["id"] in (rule["id"], named["id"])] == [rule["id"]]
    assert len(_events(container, "rules")) == 4


# ---------------------------------------------------------------------------------- websocket


def test_websocket_says_hello_then_streams_bus_events(client, container):
    with client.websocket_connect("/api/ws") as ws:
        hello = ws.receive_json()
        assert hello["type"] == "hello" and hello["version"]
        client.put("/api/settings", json={"general": {"company": "ACME"}})
        received = [ws.receive_json()["type"] for _ in range(2)]
        assert set(received) == {"settings.updated", "activity"}
    deadline = time.time() + 2
    while container.bus._subs and time.time() < deadline:
        time.sleep(0.02)
    assert not container.bus._subs                                         # unsubscribed on close


# ---------------------------------------------------------------------------------- SPA serving


@pytest.fixture
def spa_client(container, tmp_path: Path):
    """The real app re-imported with a built UI present (the SPA routes exist only then)."""
    from fastapi.testclient import TestClient

    import app.main as main

    dist = tmp_path / "dist"
    (dist / "assets").mkdir(parents=True)
    (dist / "index.html").write_text("<!doctype html><title>Factory</title>")
    (dist / "assets" / "app.js").write_text("console.log(1)")
    (dist / "favicon.svg").write_text("<svg/>")
    (tmp_path / "secret.txt").write_text("outside the build")
    saved = container.settings.static_dir
    container.settings.static_dir = str(dist)
    try:
        with TestClient(importlib.reload(main).app) as tc:
            yield tc
    finally:
        container.settings.static_dir = saved
        importlib.reload(main)


def test_spa_serving_never_swallows_api_or_mcp(spa_client):
    assert "<title>Factory</title>" in spa_client.get("/").text
    assert "<title>Factory</title>" in spa_client.get("/projects/prj_1").text     # client-side route
    assert spa_client.get("/assets/app.js").text == "console.log(1)"
    assert spa_client.get("/favicon.svg").text == "<svg/>"
    assert "outside the build" not in spa_client.get("/..%2Fsecret.txt").text
    # JSON, never the SPA page: unknown API routes are 404; GET on the MCP endpoint is 405 (POST only).
    for path, status in (("/api/nope", 404), ("/mcp", 405), ("/mcp/anything", 404)):
        response = spa_client.get(path)
        assert response.status_code == status and response.headers["content-type"].startswith("application/json")
    assert spa_client.get("/api/health").json()["ok"] is True
