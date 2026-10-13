"""The DOINg.AI MCP server (`mcp_servers/doing_ai_mcp.py`, real) and the mcp-atlassian test
double, spoken to exactly as the Factory does: a subprocess per session, newline-delimited
JSON-RPC 2.0 on stdio (initialize → initialized → tools/…). The DOINg.AI server talks HTTP to
`FakeDoingAI`, a double of the DOINg.AI backend with its exact write semantics."""
from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from tests.fixtures.fake_doing_ai import FakeDoingAI

DOING_AI = Path(__file__).resolve().parents[1] / "mcp_servers" / "doing_ai_mcp.py"
FAKE_JIRA = Path(__file__).resolve().parent / "fixtures" / "fake_jira_mcp.py"


class Session:
    """A minimal MCP client over a subprocess (the protocol, not the Factory's client)."""

    def __init__(self, script: Path, env: dict[str, str]) -> None:
        self.proc = subprocess.Popen([sys.executable, str(script)], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                     stderr=subprocess.PIPE, text=True, encoding="utf-8",
                                     env={**os.environ, "PYTHONUTF8": "1", **env})
        self.lines: queue.Queue[str] = queue.Queue()
        threading.Thread(target=self._pump, daemon=True).start()
        self.next_id = 0
        self.init = self.request("initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                                                "clientInfo": {"name": "pytest", "version": "1"}})
        self.notify("notifications/initialized")

    def _pump(self) -> None:
        for line in self.proc.stdout:
            self.lines.put(line)

    def send(self, message: dict) -> None:
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def notify(self, method: str) -> None:
        self.send({"jsonrpc": "2.0", "method": method})

    def request(self, method: str, params: dict | None = None) -> dict:
        self.next_id += 1
        self.send({"jsonrpc": "2.0", "id": self.next_id, "method": method, "params": params or {}})
        reply = json.loads(self.lines.get(timeout=15))
        assert reply["id"] == self.next_id
        assert "error" not in reply, reply
        return reply["result"]

    def tools(self) -> dict[str, dict]:
        return {t["name"]: t for t in self.request("tools/list")["tools"]}

    def call(self, tool: str, **args) -> tuple[dict, bool]:
        result = self.request("tools/call", {"name": tool, "arguments": args})
        text = result["content"][0]["text"]
        data = json.loads(text)
        if not result["isError"]:
            assert result["structuredContent"] == data
        return data, result["isError"]

    def ok(self, tool: str, **args) -> dict:
        data, is_error = self.call(tool, **args)
        assert not is_error, data
        return data

    def fail(self, tool: str, **args) -> dict:
        data, is_error = self.call(tool, **args)
        assert is_error, data
        assert data["error"]
        return data

    def close(self) -> None:
        self.proc.stdin.close()
        self.proc.wait(timeout=10)
        self.proc.stdout.close()
        self.proc.stderr.close()


@pytest.fixture
def doing_ai():
    with FakeDoingAI() as fake:
        yield fake


@pytest.fixture
def portfolio(doing_ai):
    """Sessions of the real DOINg.AI MCP server; by default against the `doing_ai` double."""
    sessions = []

    def open_session(**env: str) -> Session:
        s = Session(DOING_AI, {"DOING_AI_URL": doing_ai.url, **env})
        sessions.append(s)
        return s

    yield open_session
    for s in sessions:
        s.close()


@pytest.fixture
def jira(tmp_path):
    sessions = []

    def open_session() -> Session:
        s = Session(FAKE_JIRA, {"FAKE_JIRA_STATE": str(tmp_path / "jira.json")})
        sessions.append(s)
        return s

    yield open_session
    for s in sessions:
        s.close()


def _without(doc: dict, *keys: str) -> dict:
    return {k: v for k, v in doc.items() if k not in keys}


# ---------------------------------------------------------------------------
# Protocol
# ---------------------------------------------------------------------------

def test_handshake_tool_list_and_annotations(portfolio, jira):
    p = portfolio()
    assert p.init["protocolVersion"] == "2025-06-18"
    assert p.init["serverInfo"]["title"] == "DOINg.AI"
    assert p.init["capabilities"] == {"tools": {"listChanged": False}}
    tools = p.tools()
    reads = {"list_projects", "get_project", "list_users", "list_wishes", "list_mcp_servers", "search_mcp_servers"}
    writes = {"update_project_status", "register_mcp_server"}
    assert set(tools) == reads | writes   # no create_project: use cases are created by people, in DOINg.AI
    for name in reads:
        assert tools[name]["annotations"]["readOnlyHint"] is True
    for name in writes:
        assert tools[name]["annotations"] == {**tools[name]["annotations"], "readOnlyHint": False, "destructiveHint": False}
    assert all(t["inputSchema"]["type"] == "object" for t in tools.values())

    jt = jira().tools()
    assert {"jira_search", "jira_get_issue", "jira_create_issue", "jira_batch_create_issues", "jira_transition_issue",
            "jira_add_comment"} <= set(jt)
    assert jt["jira_create_issue"]["inputSchema"]["required"] == ["project_key", "summary", "issue_type"]
    assert jt["jira_batch_create_issues"]["inputSchema"]["properties"]["issues"]["type"] == "string"


def test_protocol_edges(portfolio):
    p = portfolio()
    assert p.request("ping") == {}
    p.send({"jsonrpc": "2.0", "id": 99, "method": "resources/list"})
    assert json.loads(p.lines.get(timeout=10))["error"]["code"] == -32601
    unknown = p.fail("no_such_tool")
    assert "list_projects" in unknown["available_tools"]
    bad = p.fail("get_project", projectId="x")
    assert "Accepted: project_id" in bad["error"] and "Required: project_id" in bad["error"]


def test_older_protocol_version_is_echoed(portfolio):
    p = portfolio()
    assert p.request("initialize", {"protocolVersion": "2025-03-26"})["protocolVersion"] == "2025-03-26"
    assert p.request("initialize", {"protocolVersion": "1999-01-01"})["protocolVersion"] == "2025-06-18"


# ---------------------------------------------------------------------------
# DOINg.AI MCP server — configuration
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("env, fragment", [
    ({}, "DOING_AI_URL is not set"),
    ({"DOING_AI_URL": "localhost:3001"}, "must start with http"),
    ({"DOING_AI_URL": "http://127.0.0.1:9", "DOING_AI_TIMEOUT": "3"}, "Cannot reach DOINg.AI at http://127.0.0.1:9"),
])
def test_refuses_to_start_without_a_doing_ai(env, fragment):
    clean = {k: v for k, v in os.environ.items() if not k.startswith("DOING_AI_")}
    proc = subprocess.run([sys.executable, str(DOING_AI)], input="", capture_output=True, text=True, timeout=20,
                          env={**clean, **env})
    assert proc.returncode == 2 and proc.stdout == ""
    assert fragment in proc.stderr and "not started" in proc.stderr


def test_doing_ai_going_down_after_start_is_actionable(portfolio, doing_ai):
    p = portfolio(DOING_AI_TIMEOUT="3")
    assert p.ok("list_users")["count"] == 8
    doing_ai.httpd.shutdown()
    doing_ai.httpd.server_close()
    error = p.fail("list_projects")["error"]
    assert f"Cannot reach DOINg.AI at {doing_ai.url}" in error and "DOING_AI_URL" in error


# ---------------------------------------------------------------------------
# DOINg.AI MCP server — reads
# ---------------------------------------------------------------------------

def test_reads_the_portfolio(portfolio):
    p = portfolio()
    projects = p.ok("list_projects")
    assert projects["count"] == 6
    planning = p.ok("list_projects", status="planning")["projects"]
    assert {x["name"] for x in planning} == {"Intraday Liquidity Forecasting Agent", "Corporate Loan Covenant Monitoring"}
    covenant = next(x for x in planning if x["id"] == "prj-1006")
    assert covenant["sponsor"] == {"id": "u-alice", "name": "Alice Martin", "email": "alice.martin@doing.ai"}
    assert covenant["businessUnit"] == "Global Banking"
    assert "Loan IQ" in covenant["context"] and "tasks" not in covenant and covenant["taskStats"] == {"total": 0, "done": 0}

    users = p.ok("list_users")["users"]
    assert len(users) == 8 and all("password" not in json.dumps(u).lower() for u in users)
    assert {u["email"] for u in users} >= {"alice.martin@doing.ai", "paul.durand@doing.ai", "ines.garcia@doing.ai"}

    servers = p.ok("list_mcp_servers")["mcp_servers"]
    assert len(servers) == 10 and {s["deployStatus"] for s in servers} == {"production", "uat", "dev"}
    referenced = {sid for x in projects["projects"] for sid in x["mcpServerIds"]}
    assert referenced <= {s["id"] for s in servers}
    assert p.ok("list_wishes", category="mcp")["wishes"][0]["sponsor"]["name"] == "Alice Martin"
    full = p.ok("get_project", project_id="prj-1003")
    assert {s["name"] for s in full["mcpServers"]} >= {"Credit Risk Limits MCP", "Client 360 MCP"}
    assert full["members"][0]["name"] == "Paul Durand"
    assert p.ok("get_project", project_id="corporate loan covenant monitoring")["id"] == "prj-1006"
    assert any(k["id"] == "prj-1001" for k in p.fail("get_project", project_id="prj-404")["known_projects"])


def test_filters_validate_their_values(portfolio):
    p = portfolio()
    assert "Planning" in p.fail("list_projects", status="Started")["allowed_status_values"]
    assert p.fail("list_mcp_servers", deploy_status="prod")["allowed_deploy_status_values"] == ["dev", "uat", "production"]
    assert p.ok("list_mcp_servers", deploy_status="UAT")["count"] == 1
    assert p.ok("list_projects", updated_since="2026-10-01")["count"] == 3
    assert "ISO date" in p.fail("list_projects", updated_since="last week")["error"]


def test_search_ranks_plausibly(portfolio):
    p = portfolio()

    def top(capability: str) -> dict:
        return p.ok("search_mcp_servers", capability=capability, limit=3)["matches"][0]

    assert top("FX spot rates")["server"]["name"] == "Market Data MCP"
    assert top("intraday payment flows per currency")["server"]["name"] == "Payments Hub MCP"
    assert top("internal rating, limits and exposure")["server"]["name"] == "Credit Risk Limits MCP"
    assert top("facility agreements and clauses in documents")["server"]["name"] == "Document Vault MCP"
    assert top("client golden record and group structure")["server"]["name"] == "Client 360 MCP"
    best = top("FX spot rates")
    assert best["score"] >= 0.6 and set(best["matched_terms"]) == {"fx", "spot", "rate"}
    for capability in ("nostro account balances at correspondent banks",
                       "borrower spread financial statements",
                       "Loan IQ covenant definitions and test dates"):
        matches = p.ok("search_mcp_servers", capability=capability)["matches"]
        assert not matches or matches[0]["score"] < 0.4, (capability, matches[0])
    assert p.ok("search_mcp_servers", capability="fx", limit="2")["count"] <= 2   # coerced from "2"
    assert "distinctive" in p.fail("search_mcp_servers", capability="the data of the MCP server")["error"]


LIVE_STATE = {
    "users": [{"id": "u1", "uid": "jdoe", "firstName": "Jane", "lastName": "Doe", "email": "jane.doe@bank.example",
               "role": "manager", "password": "plain", "passwordHash": "h", "passwordSalt": "s", "createdAt": "2026-01-01"}],
    "projects": [{"id": "p1", "name": "Live use case", "description": "d", "status": "Planning", "sponsorId": "u1",
                  "managerId": "u1", "businessUnitId": "b1", "members": [], "tasks": [{"id": "t", "status": "Done"}],
                  "tags": [], "auditLog": [{"id": "a"}], "mcpServerIds": ["m1"],
                  "telemetry": [{"id": "tm", "label": "Calls", "source": "api",
                                 "apiUrl": "https://metrics.bank.example/v1?api_key=k-should-never-leave&q=calls",
                                 "apiHeaders": '{"Authorization": "Bearer bearer-should-never-leave"}'}],
                  "createdAt": "2026-10-01T00:00:00Z", "updatedAt": "2026-10-02T00:00:00Z"}],
    "mcpServers": [{"id": "m1", "name": "Live FX MCP", "description": "FX rates", "tools": [{"name": "get_fx_rate", "description": "rate"}],
                    "tags": ["fx"], "isActive": True, "deployStatus": "production", "token": "secret-token",
                    "url": "https://svc:hunter2@mcp.bank.example/mcp", "createdAt": "x", "updatedAt": "x"}],
    "wishes": [], "businessUnits": [{"id": "b1", "name": "Markets", "createdAt": "x"}],
    "llmConfig": {"apiKey": "sk-should-never-leave"},
    "lastUpdated": 1790000000000,
}
SECRETS = ("plain", "passwordHash", "passwordSalt", "secret-token", "hunter2", "sk-should-never-leave",
           "k-should-never-leave", "bearer-should-never-leave")


def test_reads_never_leak_secrets_and_writes_never_drop_them():
    with FakeDoingAI(LIVE_STATE) as live:
        p = Session(DOING_AI, {"DOING_AI_URL": live.url + "/", "DOING_AI_TOKEN": "proxy-token"})
        try:
            users = p.ok("list_users")
            servers = p.ok("list_mcp_servers")
            project = p.ok("list_projects", status="Planning")["projects"][0]
            full = p.ok("get_project", project_id="p1")
            updated = p.ok("update_project_status", project_id="p1", status="Active")
            registered = p.ok("register_mcp_server", name="Live FX MCP", description="FX rates v2")
        finally:
            p.close()
        blob = json.dumps([users, servers, project, full, updated, registered])
        for secret in SECRETS:
            assert secret not in blob
        assert users["users"][0]["name"] == "Jane Doe"
        assert servers["mcp_servers"][0]["url"] == "https://svc:••••@mcp.bank.example/mcp"
        assert full["telemetry"][0]["apiUrl"] == "https://metrics.bank.example/v1?api_key=••••&q=calls"
        assert project["sponsor"]["email"] == "jane.doe@bank.example" and project["businessUnit"] == "Markets"
        assert project["taskStats"] == {"total": 1, "done": 1} and "auditLog" not in project
        assert full["mcpServers"] == [{"id": "m1", "name": "Live FX MCP", "deployStatus": "production"}]
        # The secrets went back to DOINg.AI untouched: a write sends the whole document as read.
        stored = live.state
        assert stored["users"] == LIVE_STATE["users"] and stored["llmConfig"] == LIVE_STATE["llmConfig"]
        assert stored["mcpServers"][0]["token"] == "secret-token"
        assert stored["mcpServers"][0]["url"] == "https://svc:hunter2@mcp.bank.example/mcp"
        assert stored["projects"][0]["telemetry"] == LIVE_STATE["projects"][0]["telemetry"]
        assert {post["authorization"] for post in live.posts} == {"Bearer proxy-token"}


# ---------------------------------------------------------------------------
# DOINg.AI MCP server — writes (read-modify-write of the whole document)
# ---------------------------------------------------------------------------

def test_update_status_writes_only_the_project(portfolio, doing_ai):
    before = json.loads(json.dumps(doing_ai.state))
    p = portfolio()
    assert "Nothing to update" in p.fail("update_project_status", project_id="prj-1005")["error"]
    assert p.fail("update_project_status", project_id="prj-1005", status="Live")["allowed_status_values"]
    assert doing_ai.posts == []   # validation errors never write
    updated = p.ok("update_project_status", project_id="prj-1005", status="active", dev_status="dev", note="Kick-off done.")
    assert updated["project"]["status"] == "Active" and updated["project"]["devStatus"] == "dev"
    assert updated["changes"] and "Kick-off done." in updated["project"]["notes"] and updated["merged"] is False
    assert updated["project"]["auditLog"][-1]["action"] == "Status updated"

    (post,) = doing_ai.posts
    assert post["base"] == str(before["lastUpdated"])   # optimistic concurrency on the version read
    after = doing_ai.state
    assert after["lastUpdated"] > before["lastUpdated"]
    assert _without(after, "projects", "lastUpdated") == _without(before, "projects", "lastUpdated")
    assert [x["id"] for x in after["projects"]] == [x["id"] for x in before["projects"]]
    assert [x["id"] for x, y in zip(after["projects"], before["projects"]) if x != y] == ["prj-1005"]
    project = next(x for x in after["projects"] if x["id"] == "prj-1005")
    assert project["auditLog"][-1]["userName"] == "DOINg.AI Factory" and project["updatedAt"].endswith("Z")
    assert len(project["auditLog"][-1]["id"]) == 36   # a UUID, as DOINg.AI's own ids
    assert p.ok("get_project", project_id="prj-1005")["status"] == "Active"   # read back from DOINg.AI


def test_register_server_creates_then_updates(portfolio, doing_ai):
    p = portfolio()
    reg = p.ok("register_mcp_server", name="Nostro Balances MCP", description="Nostro account balances at correspondents.",
               tools=["get_nostro_balances — balance per account", {"name": "list_nostro_accounts", "description": "accounts"}],
               tags=["treasury"], team_it="Payments", deploy_status="production", data_source="MT950")
    server = reg["server"]
    assert reg["created"] is True and server["deployStatus"] == "production" and server["dataSourceUsed"] == "MT950"
    assert server["tools"][0] == {"name": "get_nostro_balances", "description": "balance per account"}
    top = p.ok("search_mcp_servers", capability="nostro account balances")["matches"][0]
    assert top["server"]["id"] == server["id"] and top["score"] >= 0.6
    again = p.ok("register_mcp_server", name="nostro balances mcp", description="v2", deploy_status="uat")
    assert again["created"] is False and again["server"]["id"] == server["id"]
    assert again["server"]["deployStatus"] == "uat" and again["server"]["tools"] == server["tools"]   # unset = kept
    assert p.ok("list_mcp_servers")["count"] == 11 and len(doing_ai.state["mcpServers"]) == 11


def test_a_stale_version_is_retried_once_then_reported(portfolio, doing_ai):
    p = portfolio()
    doing_ai.conflicts = 1
    assert p.ok("update_project_status", project_id="prj-1003", note="Retried.")["project"]["notes"].endswith("Retried.")
    assert len(doing_ai.posts) == 2   # 409, then a fresh read and a second write

    before = json.loads(json.dumps(doing_ai.state))
    doing_ai.conflicts = 2
    error = p.fail("update_project_status", project_id="prj-1003", status="Paused")["error"]
    assert "refused the write twice" in error and "Nothing was changed" in error
    assert doing_ai.state == before and len(doing_ai.posts) == 4


def test_a_concurrent_write_is_merged_not_lost(portfolio, doing_ai):
    """Another DOINg.AI user saves between our read and our write: DOINg.AI merges by id, and
    both changes survive (theirs on other entities, ours on the project we touched)."""
    def someone_else(state: dict) -> None:
        state["projects"].append({"id": "prj-new", "name": "Created meanwhile", "status": "Planning",
                                  "createdAt": "2026-10-12T08:00:00.000Z", "updatedAt": "2026-10-12T08:00:00.000Z"})
        other = next(x for x in state["projects"] if x["id"] == "prj-1001")
        other.update(notes="Edited meanwhile.", updatedAt="2026-10-12T08:00:00.000Z")

    doing_ai.before_write = someone_else
    result = portfolio().ok("update_project_status", project_id="prj-1005", status="Active")
    assert result["merged"] is True
    projects = {x["id"]: x for x in doing_ai.state["projects"]}
    assert projects["prj-new"]["name"] == "Created meanwhile" and projects["prj-1001"]["notes"] == "Edited meanwhile."
    assert projects["prj-1005"]["status"] == "Active"


def test_never_writes_a_document_that_is_not_doing_ai_state(portfolio, doing_ai):
    doing_ai.state = {"projects": [{"id": "p", "name": "x", "status": "Planning"}]}   # no lastUpdated: not DOINg.AI
    error = portfolio().fail("register_mcp_server", name="X", description="d")["error"]
    assert "refuses to write" in error and doing_ai.posts == []


# ---------------------------------------------------------------------------
# The mcp-atlassian test double (it must answer like the real server for the tests to mean anything)
# ---------------------------------------------------------------------------

def test_fake_jira_search_shapes(jira):
    j = jira()
    epics = j.ok("jira_search", jql="project = DATA AND issuetype = Epic")
    assert set(epics) == {"total", "start_at", "max_results", "issues"}
    epic = epics["issues"][0]
    assert epic["key"] == "DATA-7" and epic["status"] == {"name": "Done", "category": "Done"}
    assert epic["browse_url"] == "https://jira.example.test/browse/DATA-7" and "/rest/api/2/issue/" in epic["url"]
    nostro = j.ok("jira_search", jql='summary ~ "Nostro Balance MCP" AND issuetype = epic')["issues"]
    assert [i["key"] for i in nostro] == ["PAY-31"]
    assert j.ok("jira_search", jql="project = MCPF", limit="2")["total"] == 5
    assert "OR is not supported" in j.fail("jira_search", jql="project = MCPF OR project = DATA")["error"]


def test_fake_jira_writes_take_mcp_atlassian_arguments(jira):
    j = jira()
    epic = j.ok("jira_create_issue", project_key="MCPF", summary="MCP — Treasury Liquidity History MCP",
                issue_type="Epic", additional_fields='{"labels": ["mcp", "treasury data"]}')
    assert epic["message"] == "Issue created successfully"
    assert epic["issue"]["key"] == "MCPF-12" and epic["issue"]["labels"] == ["mcp", "treasury-data"]
    batch = j.ok("jira_batch_create_issues", issues=json.dumps([
        {"project_key": "MCPF", "summary": "Implement get_history", "issue_type": "Story", "Epic Link": "MCPF-12",
         "Story Points": 5, "parent": "MCPF-12"},
        {"project_key": "MCPF", "summary": "Add audit logging", "issue_type": "Story", "parent": "MCPF-12"}]))
    assert [i["key"] for i in batch["issues"]] == ["MCPF-13", "MCPF-14"]
    assert batch["issues"][0]["epic_key"] == "MCPF-12" and "parent" not in batch["issues"][1]   # batch ignores parent
    assert "issues[1]" in j.fail("jira_batch_create_issues", issues=json.dumps([
        {"project_key": "MCPF", "summary": "ok", "issue_type": "Task"}, {"project_key": "NOPE", "summary": "x", "issue_type": "Task"}]))["error"]
    assert j.ok("jira_search", jql="project = MCPF")["total"] == 8   # nothing from the failed batch
    moved = j.ok("jira_transition_issue", issue_key="MCPF-13", transition_id="31")
    assert moved["issue"]["status"]["category"] == "Done"
    assert j.ok("jira_add_comment", issue_key="MCPF-14", body="Blocked.")["body"] == "Blocked."
    assert "valid JSON" in j.fail("jira_create_issue", project_key="MCPF", summary="x", issue_type="Task",
                                  additional_fields="{not json")["error"]
