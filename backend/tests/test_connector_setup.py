"""Connecting the real systems from the UI: connector templates, creation from a template (saved,
tested, secrets masked), the standard setup of a DOINg.AI / Jira connector, the import of
people from DOINg.AI, and the onboarding flags that follow them (SPEC §7, §9, §13)."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import pytest

from app.seed.standard_ops import WATCHER_NAME, jira_operations, portfolio_operations
from tests.fixtures.fake_doing_ai import FakeDoingAI

TEMPLATE_KEYS = {"id", "name", "kind", "description", "transport", "command", "args", "env_template", "fields", "docs_url"}
FIELD_KEYS = {"key", "label", "secret", "required", "placeholder", "help"}


@pytest.fixture
def doing_ai():
    with FakeDoingAI() as fake:
        yield fake


def _create(client, template_id: str, values: dict, **extra) -> tuple[int, dict]:
    response = client.post("/api/connectors/from-template", json={"template_id": template_id, "values": values, **extra})
    return response.status_code, response.json()


def test_templates_describe_the_real_servers(client):
    templates = {t["id"]: t for t in client.get("/api/connectors/templates").json()}
    assert set(templates) == {"doing_ai", "jira", "http"}
    for t in templates.values():
        assert set(t) == TEMPLATE_KEYS and all(set(f) == FIELD_KEYS for f in t["fields"])
    doing_ai = templates["doing_ai"]
    assert (doing_ai["kind"], doing_ai["transport"], doing_ai["command"]) == ("portfolio", "stdio", sys.executable)
    assert Path(doing_ai["args"][0]).name == "doing_ai_mcp.py" and Path(doing_ai["args"][0]).is_file()
    assert [(f["key"], f["required"], f["secret"]) for f in doing_ai["fields"]] == [
        ("DOING_AI_URL", True, False), ("DOING_AI_TOKEN", False, True)]
    jira = templates["jira"]
    assert (jira["kind"], jira["command"], jira["args"]) == ("jira", "uvx", ["mcp-atlassian"])
    secrets = {f["key"] for f in jira["fields"] if f["secret"]}
    assert secrets == {"JIRA_API_TOKEN", "JIRA_PERSONAL_TOKEN"}
    assert {f["key"] for f in jira["fields"]} >= {"JIRA_URL", "JIRA_USERNAME", "READ_ONLY_MODE", "JIRA_SSL_VERIFY"}
    assert "sooperset/mcp-atlassian" in jira["docs_url"]
    assert templates["http"]["transport"] == "http" and templates["http"]["fields"][0]["key"] == "url"


def test_doing_ai_from_template_is_saved_tested_and_masked(client, container, doing_ai):
    status, connector = _create(client, "doing_ai", {"DOING_AI_URL": doing_ai.url + "/", "DOING_AI_TOKEN": "s3cret-proxy-token"})
    assert status == 200, connector
    assert connector["name"] == "DOINg.AI" and connector["kind"] == "portfolio" and connector["transport"] == "stdio"
    assert connector["status"]["ok"] is True and connector["status"]["tool_count"] == 8, connector["status"]
    assert "s3cret-proxy-token" not in json.dumps(connector)
    stored = container.store.get("connectors", connector["id"])
    assert stored["env"] == {"DOING_AI_URL": doing_ai.url, "DOING_AI_TOKEN": "s3cret-proxy-token"}
    assert "sandbox" not in stored

    # The default name is made unique; a name given twice is refused.
    status, second = _create(client, "doing_ai", {"DOING_AI_URL": doing_ai.url})
    assert status == 200 and second["name"] == "DOINg.AI 2"
    status, clash = _create(client, "doing_ai", {"DOING_AI_URL": doing_ai.url}, name="DOINg.AI")
    assert status == 409 and "already exists" in clash["detail"]


def test_a_failing_connection_is_reported_not_hidden(client):
    status, connector = _create(client, "http", {"url": "http://127.0.0.1:9/mcp", "bearer_token": "tok-abcdefghijkl"})
    assert status == 200
    assert connector["status"]["ok"] is False and connector["status"]["error"]
    assert connector["url"] == "http://127.0.0.1:9/mcp" and "tok-abcdefghijkl" not in json.dumps(connector)
    status, down = _create(client, "doing_ai", {"DOING_AI_URL": "http://127.0.0.1:9"}, name="Down")
    assert status == 200 and down["status"]["ok"] is False
    assert "Cannot reach DOINg.AI at http://127.0.0.1:9" in down["status"]["error"]


@pytest.mark.parametrize("template_id, values, fragment", [
    ("doing_ai", {}, "Required: DOINg.AI URL"),
    ("doing_ai", {"DOING_AI_URL": "localhost:3001"}, "must start with http"),
    ("doing_ai", {"DOING_AI_URL": "http://x", "MODE": "sandbox"}, "Unknown field"),
    ("jira", {"JIRA_URL": "https://jira.example.com"}, "needs credentials"),
    ("jira", {"JIRA_URL": "https://x.atlassian.net", "JIRA_USERNAME": "me@x.com"}, "both the username"),
    ("jira", {"JIRA_URL": "https://x", "JIRA_USERNAME": "me", "JIRA_API_TOKEN": "t", "JIRA_PERSONAL_TOKEN": "p"}, "not both"),
    ("nope", {}, "Unknown connector template"),
])
def test_template_values_are_validated_before_anything_is_saved(client, container, template_id, values, fragment):
    status, body = _create(client, template_id, values)
    assert status == 422 and fragment in body["detail"]
    assert container.store.list("connectors") == []


def test_jira_from_template_maps_fields_to_the_environment(client, container, monkeypatch):
    tested = []

    async def fake_test(connector_id):   # never spawn uvx (and download mcp-atlassian) from a test
        tested.append(connector_id)
        return container.store.get("connectors", connector_id)

    monkeypatch.setattr(container.mcp, "test", fake_test)
    status, connector = _create(client, "jira", {"JIRA_URL": "https://jira.bank.example", "JIRA_PERSONAL_TOKEN": "pat-0123456789",
                                                 "JIRA_SSL_VERIFY": "", "READ_ONLY_MODE": "false"})
    assert status == 200 and tested == [connector["id"]]
    stored = container.store.get("connectors", connector["id"])
    assert (stored["command"], stored["args"], stored["kind"]) == ("uvx", ["mcp-atlassian"], "jira")
    assert stored["env"] == {"JIRA_URL": "https://jira.bank.example", "JIRA_PERSONAL_TOKEN": "pat-0123456789",
                             "READ_ONLY_MODE": "false"}   # empty values are not set
    assert "pat-0123456789" not in json.dumps(connector)


def test_standard_setup_endpoint_and_onboarding_flags(client, container, doing_ai):
    _, portfolio = _create(client, "doing_ai", {"DOING_AI_URL": doing_ai.url})
    onboarding = client.get("/api/bootstrap").json()["onboarding"]
    assert onboarding["has_portfolio"] and not onboarding["has_jira"] and not onboarding["has_standard_operations"]

    first = client.post(f"/api/connectors/{portfolio['id']}/standard-setup").json()
    assert set(first) == {"operations_created", "operations_existing", "watcher_created", "notes"}
    assert first["operations_created"] == [op["key"] for op in portfolio_operations()] and first["watcher_created"]
    again = client.post(f"/api/connectors/{portfolio['id']}/standard-setup").json()
    assert again["operations_created"] == [] and again["watcher_created"] is False
    assert again["operations_existing"] == first["operations_created"]
    assert [w["name"] for w in container.store.list("watchers")] == [WATCHER_NAME]
    assert client.get("/api/bootstrap").json()["onboarding"]["has_standard_operations"] is True

    # A Jira connector arrives: its operations are now missing.
    container.store.put("connectors", {"id": "con_jira", "name": "Jira", "slug": "jira", "kind": "jira",
                                       "transport": "stdio", "command": "uvx", "args": ["mcp-atlassian"]})
    assert client.get("/api/bootstrap").json()["onboarding"]["has_standard_operations"] is False
    jira = client.post("/api/connectors/con_jira/standard-setup").json()
    assert jira["operations_created"] == [op["key"] for op in jira_operations()]
    assert client.get("/api/bootstrap").json()["onboarding"] == {
        "llm_configured": False, "has_connectors": True, "has_users": False, "has_portfolio": True, "has_jira": True,
        "has_standard_operations": True}

    assert client.post("/api/connectors/con_nope/standard-setup").status_code == 404
    container.store.put("connectors", {"id": "con_other", "name": "Other", "slug": "other", "kind": "other",
                                       "transport": "http", "url": "http://127.0.0.1:9/mcp"})
    response = client.post("/api/connectors/con_other/standard-setup")
    assert response.status_code == 422 and "portfolio" in response.json()["detail"]


def test_people_import_from_doing_ai(client, container, doing_ai):
    _, portfolio = _create(client, "doing_ai", {"DOING_AI_URL": doing_ai.url})
    container.store.put("users", {"id": "usr_alice", "name": "Alice (already here)", "email": "Alice.Martin@doing.ai",
                                  "roles": ["admin"]})
    result = client.post("/api/people/import-from-connector", json={"connector_id": portfolio["id"]}).json()
    assert result["created"] == 7 and result["skipped"] == 1
    by_email = {u["email"]: u for u in result["users"]}
    assert by_email["henri.dubois@doing.ai"]["name"] == "Henri Dubois"
    assert by_email["henri.dubois@doing.ai"]["title"] == "Head of Liquidity Management"
    sponsors = {e for e, u in by_email.items() if u["roles"] == ["sponsor"]}
    assert sponsors == {"henri.dubois@doing.ai", "ines.garcia@doing.ai", "julia.weber@doing.ai", "nadia.haddad@doing.ai"}
    assert all(u["roles"] in ([], ["sponsor"]) for u in result["users"])
    assert container.get_user("usr_alice")["roles"] == ["admin"]   # an existing user is never touched
    assert "password" not in json.dumps(result).lower()

    again = client.post("/api/people/import-from-connector", json={"connector_id": portfolio["id"]}).json()
    assert again == {"created": 0, "skipped": 8, "users": []}
    assert len(container.users()) == 8

    assert client.post("/api/people/import-from-connector", json={"connector_id": "con_x"}).status_code == 404
    container.store.put("connectors", {"id": "con_jira", "name": "Jira", "kind": "jira", "transport": "stdio", "command": "uvx"})
    response = client.post("/api/people/import-from-connector", json={"connector_id": "con_jira"})
    assert response.status_code == 422 and "DOINg.AI" in response.json()["detail"]


def test_people_import_reports_an_unreachable_doing_ai(client, container):
    container.store.put("connectors", {
        "id": "con_down", "name": "DOINg.AI", "slug": "doing_ai", "kind": "portfolio", "transport": "stdio",
        "command": sys.executable, "args": [str(Path(__file__).resolve().parents[1] / "mcp_servers" / "doing_ai_mcp.py")],
        "env": {"DOING_AI_URL": "http://127.0.0.1:9", "DOING_AI_TIMEOUT": "3"}})
    response = client.post("/api/people/import-from-connector", json={"connector_id": "con_down"})
    assert response.status_code == 502 and "Cannot reach DOINg.AI" in response.json()["detail"]
    assert container.users() == []
