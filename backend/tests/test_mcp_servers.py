"""The bundled sandbox MCP servers, spoken to exactly as the Factory does: a subprocess per
session, newline-delimited JSON-RPC 2.0 on stdio (initialize → initialized → tools/…)."""
from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest

SERVERS = Path(__file__).resolve().parents[1] / "mcp_servers"
DOING_AI = SERVERS / "doing_ai_mcp.py"
JIRA = SERVERS / "jira_mcp.py"


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
def portfolio(tmp_path):
    sessions = []

    def open_session(**env: str) -> Session:
        s = Session(DOING_AI, {"DOING_AI_MODE": "sandbox", "DOING_AI_STATE": str(tmp_path / "doing_ai.json"), **env})
        sessions.append(s)
        return s

    yield open_session
    for s in sessions:
        s.close()


@pytest.fixture
def jira(tmp_path):
    sessions = []

    def open_session() -> Session:
        s = Session(JIRA, {"JIRA_SANDBOX_STATE": str(tmp_path / "jira.json")})
        sessions.append(s)
        return s

    yield open_session
    for s in sessions:
        s.close()


# ---------------------------------------------------------------------------
# Protocol
# ---------------------------------------------------------------------------

def test_handshake_tool_list_and_annotations(portfolio, jira):
    p = portfolio()
    assert p.init["protocolVersion"] == "2025-06-18"
    assert p.init["serverInfo"]["title"] == "DOINg.AI Portfolio"
    assert p.init["capabilities"] == {"tools": {"listChanged": False}}
    tools = p.tools()
    reads = {"list_projects", "get_project", "list_users", "list_wishes", "list_mcp_servers", "search_mcp_servers"}
    writes = {"create_project", "update_project_status", "register_mcp_server"}
    assert set(tools) == reads | writes
    for name in reads:
        assert tools[name]["annotations"]["readOnlyHint"] is True
    for name in writes:
        assert tools[name]["annotations"] == {**tools[name]["annotations"], "readOnlyHint": False, "destructiveHint": False}
    assert all(t["inputSchema"]["type"] == "object" for t in tools.values())

    j = jira()
    jt = j.tools()
    assert set(jt) == {"jira_list_projects", "jira_search", "jira_get_issue", "jira_create_issue",
                       "jira_batch_create_issues", "jira_update_issue", "jira_transition_issue", "jira_add_comment"}
    assert {n for n, t in jt.items() if t["annotations"]["readOnlyHint"]} == {"jira_list_projects", "jira_search", "jira_get_issue"}
    assert all(t["annotations"].get("destructiveHint") is False for t in jt.values() if not t["annotations"]["readOnlyHint"])


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
# DOINg.AI portfolio — sandbox
# ---------------------------------------------------------------------------

def test_seed_portfolio_is_coherent(portfolio):
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
    assert len(servers) == 10
    assert {s["deployStatus"] for s in servers} == {"production", "uat", "dev"}
    assert all(s["tools"] and s["teamIT"] for s in servers)
    referenced = {sid for x in projects["projects"] for sid in x["mcpServerIds"]}
    assert referenced <= {s["id"] for s in servers}

    mcp_wishes = p.ok("list_wishes", category="mcp")["wishes"]
    assert len(mcp_wishes) == 1 and mcp_wishes[0]["sponsor"]["name"] == "Alice Martin"
    assert p.ok("list_wishes")["count"] == 3

    full = p.ok("get_project", project_id="prj-1003")
    assert {s["name"] for s in full["mcpServers"]} >= {"Credit Risk Limits MCP", "Client 360 MCP"}
    assert full["members"][0]["name"] == "Paul Durand"
    assert p.ok("get_project", project_id="corporate loan covenant monitoring")["id"] == "prj-1006"
    missing = p.fail("get_project", project_id="prj-404")
    assert any(k["id"] == "prj-1001" for k in missing["known_projects"])


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
    # Capabilities the catalog lacks only match incidental words.
    for capability in ("nostro account balances at correspondent banks",
                       "borrower spread financial statements",
                       "Loan IQ covenant definitions and test dates"):
        matches = p.ok("search_mcp_servers", capability=capability)["matches"]
        assert not matches or matches[0]["score"] < 0.4, (capability, matches[0])
    assert p.ok("search_mcp_servers", capability="fx", limit="2")["count"] <= 2   # coerced from "2"
    assert "distinctive" in p.fail("search_mcp_servers", capability="the data of the MCP server")["error"]


def test_create_project_then_list_planning(portfolio):
    p = portfolio()
    created = p.ok("create_project", name="Payment Fraud Triage Copilot",
                   description="Triage suspicious outgoing payments.", context="Needs payment flows and sanctions alerts.",
                   sponsor_email="Alice.Martin@doing.ai", business_unit="transaction banking", deadline="2027-06-30",
                   tags="fraud, payments")
    project = created["project"]
    assert project["status"] == "Planning" and project["devStatus"] == "to_start"
    assert project["sponsor"]["email"] == "alice.martin@doing.ai" and project["businessUnit"] == "Transaction Banking"
    assert project["tags"] == ["fraud", "payments"] and project["deadline"] == "2027-06-30"
    assert created["warnings"] == []

    planning = p.ok("list_projects", status="Planning")
    assert planning["count"] == 3 and planning["projects"][0]["id"] == project["id"]   # newest first
    # Another process (the Factory spawns one per call) sees the same world.
    assert portfolio().ok("get_project", project_id=project["id"])["name"] == "Payment Fraud Triage Copilot"

    dup = p.fail("create_project", name="payment fraud triage copilot", description="again")
    assert dup["project_id"] == project["id"]
    warned = p.ok("create_project", name="Orphan", description="d", sponsor_email="nobody@doing.ai", business_unit="Mars")
    assert len(warned["warnings"]) == 2 and warned["project"]["sponsor"] is None
    assert "deadline" in p.fail("create_project", name="X", description="d", deadline="soon")["error"]


def test_update_status_and_register_server(portfolio):
    p = portfolio()
    assert "Nothing to update" in p.fail("update_project_status", project_id="prj-1005")["error"]
    assert p.fail("update_project_status", project_id="prj-1005", status="Live")["allowed_status_values"]
    updated = p.ok("update_project_status", project_id="prj-1005", status="active", dev_status="dev", note="Kick-off done.")
    assert updated["project"]["status"] == "Active" and updated["project"]["devStatus"] == "dev"
    assert updated["changes"] and "Kick-off done." in updated["project"]["notes"]
    assert updated["project"]["auditLog"][-1]["action"] == "Status updated"

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
    assert p.ok("list_mcp_servers")["count"] == 11


def test_unreadable_state_is_reported_not_reseeded(tmp_path, portfolio):
    (tmp_path / "doing_ai.json").write_text("{broken", encoding="utf-8")
    error = portfolio().fail("list_projects")["error"]
    assert "unreadable" in error and "delete it" in error
    assert (tmp_path / "doing_ai.json").read_text(encoding="utf-8") == "{broken"


# ---------------------------------------------------------------------------
# DOINg.AI portfolio — bridge to a live instance (GET /api/data)
# ---------------------------------------------------------------------------

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
}


@pytest.fixture
def live_doing_ai():
    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            body = json.dumps(LIVE_STATE).encode() if self.path == "/api/data" else b"{}"
            self.send_response(200 if self.path == "/api/data" else 404)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *args):
            pass

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)   # ephemeral port, never the user's 30xx range
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    yield f"http://127.0.0.1:{httpd.server_address[1]}"
    httpd.shutdown()
    httpd.server_close()


def test_bridge_reads_live_data_without_secrets(portfolio, live_doing_ai, tmp_path):
    p = portfolio(DOING_AI_MODE="bridge", DOING_AI_URL=live_doing_ai + "/")
    users = p.ok("list_users")
    assert users["users"][0]["name"] == "Jane Doe"
    servers = p.ok("list_mcp_servers")
    project = p.ok("list_projects", status="Planning")["projects"][0]
    full = p.ok("get_project", project_id="p1")
    blob = json.dumps([users, servers, project, full])
    for secret in ("plain", "passwordHash", "passwordSalt", "secret-token", "hunter2", "sk-should-never-leave",
                   "k-should-never-leave", "bearer-should-never-leave"):
        assert secret not in blob
    assert servers["mcp_servers"][0]["url"] == "https://svc:••••@mcp.bank.example/mcp"
    assert full["telemetry"][0]["apiUrl"] == "https://metrics.bank.example/v1?api_key=••••&q=calls"
    assert project["sponsor"]["email"] == "jane.doe@bank.example" and project["businessUnit"] == "Markets"
    assert project["taskStats"] == {"total": 1, "done": 1} and "auditLog" not in project
    assert full["mcpServers"] == [{"id": "m1", "name": "Live FX MCP", "deployStatus": "production"}]
    assert p.ok("search_mcp_servers", capability="fx rates")["matches"][0]["server"]["id"] == "m1"
    for tool, args in (("create_project", {"name": "n", "description": "d"}),
                       ("update_project_status", {"project_id": "p1", "status": "Active"}),
                       ("register_mcp_server", {"name": "n", "description": "d"})):
        assert p.fail(tool, **args)["error"].startswith("read-only bridge")
    assert not (tmp_path / "doing_ai.json").exists()   # the bridge never creates a sandbox world


def test_bridge_unreachable_is_actionable(portfolio):
    error = portfolio(DOING_AI_MODE="bridge", DOING_AI_URL="http://127.0.0.1:9", DOING_AI_TIMEOUT="3").fail("list_projects")["error"]
    assert "Cannot reach DOINg.AI at http://127.0.0.1:9" in error and "DOING_AI_URL" in error
    assert "needs DOING_AI_URL" in portfolio(DOING_AI_MODE="bridge").fail("list_users")["error"]


# ---------------------------------------------------------------------------
# Jira sandbox
# ---------------------------------------------------------------------------

def test_jira_seed_and_search(jira):
    j = jira()
    projects = {p["key"]: p for p in j.ok("jira_list_projects")["projects"]}
    assert set(projects) == {"MCPF", "DATA", "PAY", "SEC", "OPS"}
    assert projects["OPS"]["issue_types"] == ["Change", "Task", "Bug"]
    assert projects["DATA"]["url"] == "https://jira.sandbox.local/projects/DATA"

    data_epics = j.ok("jira_search", jql="project = DATA AND issuetype = Epic")
    assert [i["key"] for i in data_epics["issues"]] == ["DATA-7"] and data_epics["issues"][0]["status"] == "Done"
    nostro = j.ok("jira_search", jql='summary ~ "Nostro Balance MCP" AND issuetype = epic')["issues"]
    assert [i["key"] for i in nostro] == ["PAY-31"]   # word match with plural folding
    assert nostro[0]["url"] == "https://jira.sandbox.local/browse/PAY-31" and "description" not in nostro[0]
    assert j.ok("jira_search", jql='project = MCPF AND status = "in progress"')["total"] == 2
    assert {i["key"] for i in j.ok("jira_search", jql="parent = MCPF-3")["issues"]} == {"MCPF-4"}
    assert j.ok("jira_search", jql="labels = treasury AND project IN (PAY, DATA)")["total"] == 2
    assert j.ok("jira_search", jql="project = SEC AND status != Done")["total"] == 2
    assert j.ok("jira_search", jql="project = MCPF AND parent IS EMPTY")["total"] == 3
    ordered = j.ok("jira_search", jql="project = OPS ORDER BY created ASC")["issues"]
    assert [i["key"] for i in ordered] == ["OPS-40", "OPS-41"]
    assert j.ok("jira_search", jql="project = MCPF", limit="2")["total"] == 5   # total counts beyond the limit
    assert len(j.ok("jira_search", jql="project = MCPF", limit="2")["issues"]) == 2
    assert j.ok("jira_search", jql='text ~ "stack traces"')["issues"][0]["key"] == "SEC-9"


@pytest.mark.parametrize("jql, fragment", [
    ("project = MCPF OR project = DATA", "OR is not supported"),
    ("component = API", "unsupported field 'component'"),
    ("status = Blocked", "Unknown status"),
    ("project ~ MCPF", "~ only applies"),
    ("project = MCPF AND", "AND at the end"),
    ('summary ~ "x" ORDER BY rank', "cannot order by 'rank'"),
    ("status = In Progress", "expected AND or ORDER BY"),
])
def test_jql_errors_explain_the_subset(jira, jql, fragment):
    error = jira().fail("jira_search", jql=jql)
    assert fragment in error["error"]
    assert "status" in error.get("supported", "") or "allowed_values" in error


def test_jira_create_batch_transition_comment(jira):
    j = jira()
    epic = j.ok("jira_create_issue", project_key="mcpf", summary="MCP — Treasury Liquidity History MCP",
                issue_type="epic", labels=["mcp", "treasury data"])["issue"]
    assert epic["key"] == "MCPF-12" and epic["url"] == "https://jira.sandbox.local/browse/MCPF-12"
    assert epic["status"] == "To Do" and epic["issue_type"] == "Epic" and epic["labels"] == ["mcp", "treasury-data"]

    stories = [{"project_key": "MCPF", "summary": "Implement get_liquidity_history tool", "issue_type": "Story",
                "parent_key": epic["key"], "story_points": 5, "labels": ["mcp"], "description": "As an agent developer…"},
               {"project": "MCPF", "summary": "Add audit logging", "type": "Story", "parent": epic["key"],
                "points": "3", "rank": 1}]
    batch = j.ok("jira_batch_create_issues", issues=json.dumps(stories))   # a JSON string is accepted too
    assert batch["keys"] == ["MCPF-13", "MCPF-14"] and batch["count"] == 2
    assert [i["parent_key"] for i in batch["created"]] == ["MCPF-12", "MCPF-12"]
    assert batch["created"][1]["story_points"] == 3 and batch["ignored_fields"] == ["rank"]

    bad = j.fail("jira_batch_create_issues", issues=[{"project_key": "MCPF", "summary": "ok"},
                                                     {"project_key": "NOPE", "summary": "bad"}])
    assert bad["error"].startswith("issues[1]") and "MCPF — MCP Factory Squad" in bad["available_projects"]
    assert j.ok("jira_search", jql="project = MCPF")["total"] == 8   # nothing from the failed batch

    full = j.ok("jira_get_issue", issue_key="mcpf-12")
    assert [c["key"] for c in full["children"]] == ["MCPF-13", "MCPF-14"] and full["progress"] == {"done": 0, "total": 2}
    assert j.ok("jira_get_issue", issue_key="MCPF-13")["parent"]["key"] == "MCPF-12"

    moved = j.ok("jira_transition_issue", issue_key="MCPF-13", status="done")
    assert (moved["from"], moved["to"], moved["issue"]["resolution"]) == ("To Do", "Done", "Done")
    assert j.fail("jira_transition_issue", issue_key="MCPF-13", status="Closed")["allowed_values"] == ["To Do", "In Progress", "Done"]
    j.ok("jira_transition_issue", issue_key="MCPF-12", status="Done")
    assert j.ok("jira_get_issue", issue_key="MCPF-12")["status"] == "Done"

    comment = j.ok("jira_add_comment", issue_key="MCPF-14", comment="Blocked on firewall opening.")
    assert comment["comment"]["body"] == "Blocked on firewall opening."
    assert j.ok("jira_get_issue", issue_key="MCPF-14")["comments"][0]["author"] == "DOINg.AI Factory"

    updated = j.ok("jira_update_issue", issue_key="MCPF-14", fields={"priority": "high", "story_points": 2, "labels": ["mcp", "audit"]})
    assert updated["issue"]["priority"] == "High" and updated["updated_fields"] == ["labels", "priority", "story_points"]
    assert "jira_transition_issue" in j.fail("jira_update_issue", issue_key="MCPF-14", fields={"status": "Done"})["error"]
    assert j.fail("jira_update_issue", issue_key="MCPF-14", fields={"reporter": "x"})["updatable_fields"]

    change = j.ok("jira_create_issue", project_key="OPS", summary="Production release — X v1.0", issue_type="Change")
    assert change["issue"]["key"] == "OPS-42"


def test_jira_validation_messages(jira):
    j = jira()
    wrong_type = j.fail("jira_create_issue", project_key="MCPF", summary="x", issue_type="Change")
    assert "issue type for MCPF" in wrong_type["error"] and wrong_type["allowed_values"] == ["Epic", "Story", "Task", "Bug"]
    assert "must be an Epic" in j.fail("jira_create_issue", project_key="MCPF", summary="x", parent_key="MCPF-4")["error"]
    assert "cannot have a parent" in j.fail("jira_create_issue", project_key="MCPF", summary="x", issue_type="Epic",
                                            parent_key="MCPF-3")["error"]
    assert "Jira allows 255" in j.fail("jira_create_issue", project_key="MCPF", summary="x" * 300)["error"]
    assert "jira_search" in j.fail("jira_get_issue", issue_key="MCPF-999")["hint"]
    assert j.ok("jira_create_issue", project_key="MCPF", summary="Points as text", story_points="")["issue"]["story_points"] is None


def test_concurrent_processes_do_not_lose_writes(jira):
    first, second = jira(), jira()
    a = first.ok("jira_create_issue", project_key="DATA", summary="From process A")["issue"]["key"]
    b = second.ok("jira_create_issue", project_key="DATA", summary="From process B")["issue"]["key"]
    assert (a, b) == ("DATA-24", "DATA-25")
    assert {i["key"] for i in first.ok("jira_search", jql='project = DATA AND summary ~ "from process"')["issues"]} == {a, b}
