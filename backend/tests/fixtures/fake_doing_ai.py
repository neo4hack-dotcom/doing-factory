"""Test double of the DOINg.AI backend (`NEXUS.AI/server.py`): the HTTP surface the DOINg.AI
MCP server talks to, with the same write semantics, served on an ephemeral local port.

    GET  /api/data     → the whole state document
    POST /api/data     → replaces it; header X-Base-Version = the `lastUpdated` the writer read.
                         A stale version is merged by id, exactly as server.py does (newest
                         entity wins field by field, nested {id} arrays unioned, `deletedIds`
                         tombstones reconciled), answering {ok, timestamp, merged, serverData}.
    GET  /api/version  → {lastUpdated}

Test hooks: `conflicts` (answer the next N writes with 409, which the real server never does
but a proxy or a stricter version could), `before_write` (a callable run on the stored state
just before a POST is applied — another user writing in between), `posts` (every POST body
and header received). `seed_state()` is a coherent corporate & investment bank portfolio
whose two 'Planning' use cases need MCP servers the catalog lacks. Users carry password
hashes and the state an LLM API key, as the real store does, so tests can prove that reads
never leak them and writes never drop them.
"""
from __future__ import annotations

import copy
import json
import threading
import time
import unicodedata
from datetime import datetime
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any, Callable

# ---------------------------------------------------------------------------
# server.py's merge, ported verbatim in behaviour
# ---------------------------------------------------------------------------

MERGEABLE_COLLECTIONS = (
    "users", "projects", "projectTemplates", "projectFamilies", "technologies", "repositories", "communications",
    "emailTemplates", "mailingLists", "weeklyCheckIns", "notifications", "hackathons", "workingGroups", "smartTodos",
    "mcpServers", "mcpFamilies", "mcpBestPractices", "agents", "agentFamilies", "dataFeeds", "wishes",
    "pendingProjects", "aiContacts", "aiContactFamilies", "businessUnits",
)
TOMBSTONE_TTL_MS = 30 * 24 * 60 * 60 * 1000


def _iso_to_epoch(s: str) -> float:
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:  # noqa: BLE001
        return 0.0


def _recency(entity: dict) -> float:
    for key in ("updatedAt", "createdAt"):
        v = entity.get(key)
        if isinstance(v, str):
            return _iso_to_epoch(v)
        if isinstance(v, (int, float)):
            return float(v)
    return 0.0


def _recency_ms(e: dict) -> float:
    if not isinstance(e, dict):
        return 0.0
    for key in ("updatedAt", "createdAt"):
        v = e.get(key)
        if isinstance(v, str):
            return _iso_to_epoch(v) * 1000.0
        if isinstance(v, (int, float)):
            return float(v) if v > 1e11 else float(v) * 1000.0
    return 0.0


def _looks_like_entity_list(v: Any) -> bool:
    return isinstance(v, list) and any(isinstance(x, dict) and "id" in x for x in v)


def _merge_entity(a: dict, b: dict) -> dict:
    newer, older = (a, b) if _recency(a) >= _recency(b) else (b, a)
    out = dict(newer)
    for key, older_val in older.items():
        newer_val = newer.get(key)
        if (isinstance(newer_val, list) and isinstance(older_val, list)
                and (_looks_like_entity_list(newer_val) or _looks_like_entity_list(older_val))):
            out[key] = merge_collection(older_val, newer_val)
        elif key not in newer:
            out[key] = older_val
    return out


def merge_collection(current: list, incoming: list) -> list:
    if not isinstance(current, list):
        return incoming
    if not isinstance(incoming, list):
        return current
    cur_by_id = {e.get("id"): e for e in current if isinstance(e, dict) and e.get("id") is not None}
    merged, seen = [], set()
    for e in incoming:
        if not isinstance(e, dict) or e.get("id") is None:
            merged.append(e)
            continue
        seen.add(e["id"])
        other = cur_by_id.get(e["id"])
        merged.append(_merge_entity(other, e) if other is not None else e)
    for e in current:
        if isinstance(e, dict) and e.get("id") is not None and e["id"] not in seen:
            merged.append(e)
    return merged


def merge_states(current: dict, incoming: dict) -> dict:
    merged = dict(incoming)
    for key in MERGEABLE_COLLECTIONS:
        if key in current or key in incoming:
            merged[key] = merge_collection(current.get(key, []) or [], incoming.get(key, []) or [])
    return merged


def reconcile_tombstones(current: dict, incoming: dict) -> dict:
    now_ms = time.time() * 1000.0
    cur_t = current.get("deletedIds") if isinstance(current.get("deletedIds"), dict) else {}
    inc_t = incoming.get("deletedIds") if isinstance(incoming.get("deletedIds"), dict) else {}
    merged_t: dict[str, float] = {}
    for src in (cur_t, inc_t):
        for k, v in src.items():
            if isinstance(v, (int, float)):
                merged_t[k] = max(merged_t.get(k, 0.0), float(v))
    for key in MERGEABLE_COLLECTIONS:
        coll = incoming.get(key)
        if not isinstance(coll, list):
            continue
        kept = []
        for e in coll:
            if isinstance(e, dict) and e.get("id") in merged_t:
                if _recency_ms(e) <= merged_t[e["id"]]:
                    continue
                merged_t.pop(e["id"], None)
            kept.append(e)
        incoming[key] = kept
    cutoff = now_ms - TOMBSTONE_TTL_MS
    incoming["deletedIds"] = {k: v for k, v in merged_t.items() if v >= cutoff}
    return incoming


# ---------------------------------------------------------------------------
# The HTTP double
# ---------------------------------------------------------------------------

class FakeDoingAI:
    def __init__(self, state: dict | None = None) -> None:
        self.state: dict = copy.deepcopy(state) if state is not None else seed_state()
        self.conflicts = 0
        self.before_write: Callable[[dict], None] | None = None
        self.posts: list[dict] = []
        self.lock = threading.Lock()
        fake = self

        class Handler(BaseHTTPRequestHandler):
            def _send(self, code: int, body: Any) -> None:
                data = json.dumps(body, ensure_ascii=False).encode("utf-8")
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self) -> None:
                with fake.lock:
                    if self.path == "/api/data":
                        return self._send(200, fake.state)
                    if self.path == "/api/version":
                        return self._send(200, {"lastUpdated": fake.state.get("lastUpdated", 0)})
                self._send(404, {"detail": "Not Found"})

            def do_POST(self) -> None:
                if self.path != "/api/data":
                    return self._send(404, {"detail": "Not Found"})
                length = int(self.headers.get("Content-Length") or 0)
                body = json.loads(self.rfile.read(length).decode("utf-8"))
                base = self.headers.get("X-Base-Version")
                with fake.lock:
                    fake.posts.append({"base": base, "body": body,
                                       "authorization": self.headers.get("Authorization") or ""})
                    if fake.conflicts > 0:
                        fake.conflicts -= 1
                        return self._send(409, {"detail": "stale version"})
                    if fake.before_write is not None:
                        hook, fake.before_write = fake.before_write, None
                        hook(fake.state)
                        fake.state["lastUpdated"] = int(fake.state.get("lastUpdated") or 0) + 1
                    current = fake.state
                    merged = False
                    if base and base != "force" and str(current.get("lastUpdated", 0)) != str(base):
                        body = merge_states(current, body)
                        merged = True
                    body = reconcile_tombstones(current, body)
                    body["lastUpdated"] = max(int(time.time() * 1000), int(current.get("lastUpdated") or 0) + 1)
                    fake.state = body
                    reply: dict[str, Any] = {"ok": True, "timestamp": body["lastUpdated"]}
                    if merged:
                        reply.update(merged=True, serverData=body)
                self._send(200, reply)

            def log_message(self, *args: Any) -> None:
                pass

        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), Handler)   # ephemeral port, never the user's
        self.url = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        self._thread = threading.Thread(target=self.httpd.serve_forever, daemon=True)

    def __enter__(self) -> "FakeDoingAI":
        self._thread.start()
        return self

    def __exit__(self, *exc: Any) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()

    def bump(self, change: Callable[[dict], None]) -> None:
        """Another DOINg.AI user saves: `change` applied to the state, version moved on."""
        with self.lock:
            change(self.state)
            self.state["lastUpdated"] = int(self.state.get("lastUpdated") or 0) + 1


# ---------------------------------------------------------------------------
# Seed: a coherent corporate & investment bank portfolio
# ---------------------------------------------------------------------------

def _ascii(text: str) -> str:
    return unicodedata.normalize("NFKD", text).encode("ascii", "ignore").decode()


def _user(uid: str, first: str, last: str, team: str, title: str, role: str, color: str, created: str) -> dict:
    handle = _ascii(f"{first}.{last}".lower())   # accents folded, as in the bank's directory
    return {"id": f"u-{uid}", "uid": handle, "firstName": first, "lastName": last, "email": f"{handle}@doing.ai",
            "team": team, "functionTitle": title, "role": role, "avatarColor": color, "createdAt": created,
            "passwordHash": f"pbkdf2-hash-of-{uid}", "passwordSalt": f"salt-of-{uid}"}


def _server(sid: str, name: str, description: str, tools: list[tuple[str, str]], *, category: str, tags: list[str],
            team: str, deploy: str, use_case: str, source: str, data_scope: str, user_teams: list[str],
            created: str, active: bool = True) -> dict:
    return {"id": f"mcp-{sid}", "name": name, "description": description, "source": "declarative",
            "tools": [{"name": n, "description": d} for n, d in tools], "category": category, "tags": tags,
            "isActive": active, "scope": "Internal", "originData": "Internal system", "dataScope": data_scope,
            "dataSourceUsed": source, "useCase": use_case, "teamIT": team, "userTeams": user_teams,
            "deployStatus": deploy, "createdAt": created, "updatedAt": created}


def _project(pid: str, name: str, description: str, context: str, *, status: str, dev: str, bu: str, sponsor: str,
             manager: str, servers: list[str], tags: list[str], start: str, deadline: str, created: str,
             updated: str, notes: str = "", important: bool = False, members: list[tuple[str, str]] = ()) -> dict:
    return {"id": pid, "name": name, "description": description, "context": context, "notes": notes,
            "status": status, "devStatus": dev, "managerId": manager, "sponsorId": sponsor, "businessUnitId": bu,
            "startDate": start, "deadline": deadline, "isImportant": important, "isArchived": False,
            "confidentiality": "internal", "members": [{"userId": u, "role": r} for u, r in members],
            "tasks": [], "milestones": [], "technologyIds": [], "repoIds": [], "mcpServerIds": servers,
            "agentIds": [], "dataFeedIds": [], "tags": tags, "auditLog": [], "dependsOnProjectIds": [],
            "createdAt": created, "updatedAt": updated}


def seed_state() -> dict:
    """The DOINg.AI state the tests start from.

    Built so the Factory's reference flow has something real to find: the two 'Planning' use
    cases describe 6 and 5 data capabilities; the catalog covers some (Payments Hub, Market
    Data, Client 360, Teams Notifier, Credit Risk Limits, Document Vault) and lacks others
    (nostro balances, treasury liquidity history, Loan IQ covenants, financial spreading).
    """
    units = [
        {"id": "bu-gm", "name": "Global Markets", "description": "Sales, trading and research across FX, rates, credit and equities.", "color": "#FF3E00", "createdAt": "2025-01-06T09:00:00Z"},
        {"id": "bu-gb", "name": "Global Banking", "description": "Corporate lending, coverage and advisory.", "color": "#0EA5E9", "createdAt": "2025-01-06T09:00:00Z"},
        {"id": "bu-tb", "name": "Transaction Banking", "description": "Payments, cash management, treasury services and trade finance.", "color": "#10B981", "createdAt": "2025-01-06T09:00:00Z"},
        {"id": "bu-rc", "name": "Risk & Compliance", "description": "Market, credit and liquidity risk; KYC, AML and surveillance.", "color": "#8B5CF6", "createdAt": "2025-01-06T09:00:00Z"},
        {"id": "bu-ot", "name": "Operations & Technology", "description": "Middle and back office, IT and data platforms.", "color": "#F59E0B", "createdAt": "2025-01-06T09:00:00Z"},
    ]
    users = [
        _user("alice", "Alice", "Martin", "Global Banking — Corporate Lending", "Managing Director, Corporate Lending", "manager", "#FF3E00", "2025-02-03T09:00:00Z"),
        _user("paul", "Paul", "Durand", "AI Delivery Office", "AI Product Manager", "manager", "#0EA5E9", "2025-02-03T09:00:00Z"),
        _user("henri", "Henri", "Dubois", "Transaction Banking — Treasury Services", "Head of Liquidity Management", "manager", "#10B981", "2025-03-10T09:00:00Z"),
        _user("julia", "Julia", "Weber", "Risk — Market Risk", "Head of Market Risk Analytics", "manager", "#8B5CF6", "2025-03-10T09:00:00Z"),
        _user("marc", "Marc", "Lefèvre", "Global Markets — Equity Derivatives", "Head of Equity Derivatives Trading", "contributor", "#F43F5E", "2025-04-14T09:00:00Z"),
        _user("nadia", "Nadia", "Haddad", "Operations — Markets Middle Office", "COO, Global Markets Operations", "manager", "#F59E0B", "2025-04-14T09:00:00Z"),
        _user("thomas", "Thomas", "Klein", "AI Delivery Office", "Product Manager, Data & AI", "contributor", "#14B8A6", "2025-05-05T09:00:00Z"),
        _user("ines", "Inès", "Garcia", "Compliance — KYC", "KYC Transformation Lead", "contributor", "#EC4899", "2025-05-05T09:00:00Z"),
    ]
    servers = [
        _server("market-data", "Market Data MCP",
                "Market data for pricing and risk: FX spot and forward rates, interest-rate curves, equity and bond prices, with historical fixings.",
                [("get_fx_rate", "Latest FX spot rate for a currency pair (e.g. EURUSD) with timestamp and source."),
                 ("get_fx_history", "Daily FX fixings for a currency pair over a date range."),
                 ("get_yield_curve", "Interest-rate curve (OIS, government) for a currency and date."),
                 ("get_price", "Latest price of an equity, bond or index by ISIN or ticker.")],
                category="Market Data", tags=["fx", "rates", "prices", "market data", "bloomberg"],
                team="Market Data Engineering", deploy="production",
                use_case="Pricing, risk and treasury agents that need reference market prices.",
                source="Bloomberg B-PIPE, Refinitiv RDP", data_scope="Global",
                user_teams=["Global Markets", "Market Risk", "Treasury"], created="2025-06-02T08:00:00Z"),
        _server("client-360", "Client 360 MCP",
                "Golden record of corporate and institutional clients: legal entity data (LEI), group hierarchy, segment, coverage team and KYC status summary.",
                [("search_clients", "Find clients by name, LEI or internal id."),
                 ("get_client_profile", "Legal entity profile: LEI, country, segment, rating summary, KYC status."),
                 ("get_group_hierarchy", "Parent and subsidiaries of a client group."),
                 ("get_coverage_team", "Relationship manager and coverage bankers of a client.")],
                category="Client Data", tags=["client", "counterparty", "static data", "lei", "golden record", "crm"],
                team="Client Data Platform", deploy="production",
                use_case="Any agent that needs to identify a client and its group.",
                source="Salesforce Financial Services Cloud, MDM golden record", data_scope="Global",
                user_teams=["Global Banking", "Compliance", "Operations"], created="2025-05-12T08:00:00Z"),
        _server("payments-hub", "Payments Hub MCP",
                "Payments processed by the payments hub: individual payment search, status tracking and aggregated intraday flows per currency, account and settlement system (TARGET2, CHAPS, Fedwire).",
                [("search_payments", "Search payments by reference, amount, counterparty or date."),
                 ("get_payment_status", "Status and processing history of one payment (pacs.002)."),
                 ("get_intraday_flows", "Incoming and outgoing payment flows aggregated per currency and settlement system over a time window.")],
                category="Payments", tags=["payments", "swift", "iso 20022", "cash", "settlement"],
                team="Payments IT", deploy="production",
                use_case="Payment investigations and cash-flow monitoring.",
                source="Payments Hub (ISO 20022), SWIFT Alliance Access", data_scope="EMEA, Americas",
                user_teams=["Transaction Banking", "Operations"], created="2025-07-21T08:00:00Z"),
        _server("credit-risk", "Credit Risk Limits MCP",
                "Counterparty credit risk: internal ratings, approved limits, current exposure and limit utilisation per client.",
                [("get_internal_rating", "Internal rating and probability of default of a client, with rating date."),
                 ("get_limits", "Approved credit limits of a client by product and tenor."),
                 ("get_exposure", "Current exposure and limit utilisation of a client."),
                 ("list_limit_breaches", "Open limit breaches, optionally for one client.")],
                category="Risk", tags=["credit", "risk", "limits", "rating", "exposure"],
                team="Risk IT", deploy="production",
                use_case="Credit analysts and lending agents checking headroom before a deal.",
                source="Credit risk engine, internal rating system", data_scope="Global",
                user_teams=["Global Banking", "Credit Risk"], created="2025-08-04T08:00:00Z"),
        _server("doc-vault", "Document Vault MCP",
                "Search and read documents stored in the enterprise content management system: facility agreements, ISDA/CSA, KYC documents and policies, with clause extraction.",
                [("search_documents", "Full-text and metadata search across stored documents."),
                 ("get_document", "Text and metadata of one document."),
                 ("extract_clauses", "Extract named clauses (e.g. governing law, termination events, guarantees) from a document as text.")],
                category="Documents", tags=["documents", "contracts", "ecm", "clauses", "ocr"],
                team="Enterprise Content IT", deploy="production",
                use_case="Agents that need to quote contractual documents.",
                source="OpenText Documentum", data_scope="Global",
                user_teams=["Global Banking", "Legal", "Compliance"], created="2025-06-16T08:00:00Z"),
        _server("kyc-registry", "KYC Registry MCP",
                "Client due-diligence files from the client lifecycle management platform: KYC status, risk rating, ultimate beneficial owners and periodic review due dates.",
                [("get_kyc_file", "KYC file of a client: status, risk rating, documents on file."),
                 ("list_reviews_due", "Clients whose periodic KYC review is due in a period."),
                 ("get_ubo_structure", "Ultimate beneficial owners and ownership chain of a client.")],
                category="Compliance", tags=["kyc", "aml", "ubo", "due diligence", "compliance"],
                team="Compliance IT", deploy="uat",
                use_case="KYC periodic review and onboarding agents.",
                source="Fenergo CLM", data_scope="EMEA", user_teams=["Compliance"], created="2026-02-09T08:00:00Z"),
        _server("sanctions", "Sanctions Screening MCP",
                "Screen names and entities against sanctions and PEP lists (OFAC, EU, UN, HMT) and retrieve screening alerts.",
                [("screen_entity", "Screen a person or company name against sanctions and PEP lists."),
                 ("get_alert", "Details and disposition of one screening alert."),
                 ("list_open_alerts", "Open screening alerts, optionally for one client.")],
                category="Compliance", tags=["sanctions", "pep", "aml", "screening", "compliance"],
                team="Compliance IT", deploy="production",
                use_case="Onboarding, payments and KYC agents.",
                source="Dow Jones Risk & Compliance lists, internal screening engine", data_scope="Global",
                user_teams=["Compliance", "Transaction Banking"], created="2025-09-15T08:00:00Z"),
        _server("trade-repository", "Trade Repository MCP",
                "Booked trades of Global Markets (FX, rates, credit, equity derivatives): trade details, lifecycle events and confirmation status.",
                [("search_trades", "Search trades by counterparty, product, trade date or book."),
                 ("get_trade", "Economic details and lifecycle events of one trade."),
                 ("get_confirmation_status", "Confirmation matching status of a trade.")],
                category="Trading", tags=["trades", "post-trade", "confirmations", "murex"],
                team="Markets IT", deploy="production",
                use_case="Post-trade, risk and client-service agents.",
                source="Murex MX.3 trade store", data_scope="Global",
                user_teams=["Global Markets", "Operations"], created="2025-04-28T08:00:00Z"),
        _server("teams-notifier", "Teams Notifier MCP",
                "Post messages and alerts to Microsoft Teams channels and chats, with adaptive cards and mentions.",
                [("post_channel_message", "Post a message or adaptive card to a Teams channel."),
                 ("send_chat_message", "Send a direct message to a user."),
                 ("list_channels", "Channels of a team the server may post to.")],
                category="Productivity", tags=["teams", "notification", "alerts", "collaboration"],
                team="Workplace IT", deploy="production",
                use_case="Any agent that must alert a desk or a person.",
                source="Microsoft Graph API", data_scope="Global",
                user_teams=["All"], created="2025-03-31T08:00:00Z"),
        _server("research-library", "Research Library MCP",
                "Search the published equity and credit research: reports, analyst recommendations and target prices.",
                [("search_research", "Search published research by issuer, sector or keyword."),
                 ("get_report", "Summary and full text of a research report.")],
                category="Knowledge", tags=["research", "equity", "credit research", "reports"],
                team="Markets IT", deploy="dev",
                use_case="Sales assistants answering client questions on published research.",
                source="Research portal (BlueMatrix)", data_scope="Global",
                user_teams=["Global Markets"], created="2026-08-24T08:00:00Z"),
    ]
    projects = [
        _project("prj-1001", "Trade Confirmation Matching Assistant",
                 "Reads incoming FX and money-market confirmations (SWIFT MT300/MT320 and broker PDFs), matches them against booked trades and drafts the exception e-mail for unmatched fields.",
                 "Middle office matched ~4,000 confirmations a day by hand. The assistant reads confirmations from the document vault, compares economics with the trade repository and posts exceptions to the operations Teams channel.",
                 status="Done", dev="prod", bu="bu-ot", sponsor="u-nadia", manager="u-thomas",
                 servers=["mcp-trade-repository", "mcp-doc-vault", "mcp-teams-notifier"],
                 tags=["operations", "post-trade", "genai"], start="2025-10-06", deadline="2026-03-31",
                 created="2025-10-02T10:12:00Z", updated="2026-04-02T16:40:00Z",
                 notes="Live since March 2026: 72% of confirmations auto-matched, 3 FTE redeployed to exception handling.",
                 members=[("u-thomas", "Owner"), ("u-nadia", "Contributor")]),
        _project("prj-1002", "KYC Periodic Review Copilot",
                 "Prepares the periodic KYC review file of a corporate client: refreshes ownership, screens the group again and drafts the analyst's review note.",
                 "1,200 periodic reviews are overdue in EMEA. The copilot gathers the KYC file, UBO chain, screening alerts and stored documents, then drafts the review for the analyst to validate.",
                 status="Active", dev="uat", bu="bu-rc", sponsor="u-ines", manager="u-thomas",
                 servers=["mcp-kyc-registry", "mcp-sanctions", "mcp-doc-vault", "mcp-client-360"],
                 tags=["kyc", "aml", "compliance", "copilot"], start="2026-02-02", deadline="2026-12-15",
                 created="2026-01-19T09:30:00Z", updated="2026-09-29T14:05:00Z", important=True,
                 notes="UAT with 6 analysts since September; target 40% shorter review time.",
                 members=[("u-thomas", "Owner"), ("u-ines", "Lead")]),
        _project("prj-1003", "Credit Memo Drafting Assistant",
                 "Drafts the first version of the credit memo for a new facility: client profile, group structure, rating and limits, market context.",
                 "Bankers spend two days per memo collecting data from five systems. The assistant assembles client data, internal rating, limits and exposure and recent market data, then drafts the memo sections.",
                 status="Active", dev="dev", bu="bu-gb", sponsor="u-alice", manager="u-paul",
                 servers=["mcp-credit-risk", "mcp-client-360", "mcp-doc-vault", "mcp-market-data"],
                 tags=["lending", "credit", "genai"], start="2026-05-04", deadline="2027-01-29",
                 created="2026-04-21T11:00:00Z", updated="2026-10-02T09:15:00Z",
                 members=[("u-paul", "Owner"), ("u-alice", "Contributor")]),
        _project("prj-1004", "Market Risk Limit Breach Explainer",
                 "Explains overnight market-risk limit breaches in plain English for the desk heads: positions driving the breach, market moves, suggested hedges.",
                 "Each morning risk managers write 10-20 breach explanations. The explainer reads trades and market moves and posts a draft to the risk Teams channel.",
                 status="Done", dev="prod", bu="bu-rc", sponsor="u-julia", manager="u-paul",
                 servers=["mcp-market-data", "mcp-trade-repository", "mcp-teams-notifier"],
                 tags=["market risk", "limits", "genai"], start="2025-09-01", deadline="2026-02-27",
                 created="2025-08-25T08:45:00Z", updated="2026-03-06T17:20:00Z",
                 notes="In production since February 2026; explanations reviewed in 5 minutes instead of 40.",
                 members=[("u-paul", "Owner"), ("u-julia", "Contributor")]),
        _project("prj-1005", "Intraday Liquidity Forecasting Agent",
                 "An agent that forecasts the bank's intraday liquidity position per currency every 15 minutes and alerts the Treasury desk before the liquidity buffer is breached.",
                 "Treasury Services monitors EUR, USD and GBP intraday liquidity by hand today, from four screens and a spreadsheet. The agent must:\n"
                 "- read real-time incoming and outgoing payment flows per currency and settlement system (TARGET2, CHAPS, Fedwire) from the Payments Hub;\n"
                 "- read the current balances of our nostro accounts at correspondent banks — today only available as end-of-day MT940/MT950 statements and a Treasury spreadsheet, with no API;\n"
                 "- convert positions to EUR with live FX spot rates;\n"
                 "- learn intraday patterns from 24 months of historical liquidity positions kept in the Treasury data warehouse (Oracle) — no service exposes them yet;\n"
                 "- identify the counterparties driving the largest outflows from client static data;\n"
                 "- alert the Treasury desk channel in Microsoft Teams when the forecast buffer drops below the internal threshold.\n"
                 "Regulatory driver: BCBS 248 intraday liquidity monitoring; the supervisor expects an improvement plan by Q1 2027.",
                 status="Planning", dev="to_start", bu="bu-tb", sponsor="u-henri", manager="u-paul",
                 servers=[], tags=["treasury", "liquidity", "agent", "regulatory"], start="2026-11-02",
                 deadline="2027-03-31", created="2026-10-08T07:55:00Z", updated="2026-10-08T07:55:00Z",
                 important=True,
                 notes="Expected benefits: 2 FTE of manual monitoring saved; buffer breaches anticipated 60 minutes ahead; evidence for the BCBS 248 remediation plan.",
                 members=[("u-paul", "Owner"), ("u-henri", "Contributor")]),
        _project("prj-1006", "Corporate Loan Covenant Monitoring",
                 "Monitors the financial covenants of the corporate loan book every quarter and drafts a waiver or early-warning memo for the relationship manager when a covenant is at risk.",
                 "About 1,800 bilateral and syndicated facilities carry financial covenants (leverage, interest cover, minimum liquidity). Credit officers check them by hand when borrowers send their quarterly accounts, often weeks late. The agent must:\n"
                 "- retrieve the facility agreements and covenant clauses from the Document Vault (Documentum);\n"
                 "- read the covenant definitions, thresholds and test dates of each facility from Loan IQ, our loan servicing system — no API is exposed to agents yet;\n"
                 "- get the borrower's spread financial statements (EBITDA, net debt, interest expense) from the credit spreading tool, Moody's CreditLens — no MCP server or service is available today;\n"
                 "- check the internal rating, limits and current exposure from the credit risk engine;\n"
                 "- use the client golden record (group structure, relationship manager) from Client 360.\n"
                 "It then computes covenant headroom and drafts the memo. Pilot on the EMEA mid-cap portfolio.",
                 status="Planning", dev="to_start", bu="bu-gb", sponsor="u-alice", manager="u-thomas",
                 servers=[], tags=["lending", "covenants", "agent", "credit"], start="2026-11-16",
                 deadline="2027-04-30", created="2026-10-09T14:20:00Z", updated="2026-10-09T14:20:00Z",
                 notes="Expected benefits: breaches detected at the reporting date instead of 6-8 weeks later; about 1,500 analyst hours saved per year.",
                 members=[("u-thomas", "Owner"), ("u-alice", "Contributor")]),
    ]
    wishes = [
        {"id": "wish-01", "title": "MCP server for Loan IQ facility and covenant data",
         "description": "Credit officers and agents need read access to facility terms, covenant definitions, thresholds and test dates held in Loan IQ.",
         "category": "mcp", "businessJustification": "Covenant data is locked in Loan IQ screens; every credit agent use case needs it.",
         "expectedImpact": "Unblocks covenant monitoring and credit memo automation.",
         "requesterId": "u-thomas", "sponsorId": "u-alice", "relatedProjectId": "prj-1006",
         "status": "under_review", "priority": "high", "wishedDate": "2027-01-31", "comments": [],
         "tags": ["lending", "loan iq", "mcp"], "createdAt": "2026-09-22T10:00:00Z", "updatedAt": "2026-10-01T08:30:00Z"},
        {"id": "wish-02", "title": "Earnings call summariser for equity sales",
         "description": "Summarise earnings calls of covered issuers within an hour of the call, with the questions analysts asked.",
         "category": "agent", "businessJustification": "Sales want faster client follow-ups after results.",
         "expectedImpact": "Same-day client notes on 300 issuers.", "requesterId": "u-marc", "sponsorName": "Equity Sales",
         "status": "submitted", "priority": "medium", "comments": [], "tags": ["equity", "research", "agent"],
         "createdAt": "2026-09-30T15:10:00Z", "updatedAt": "2026-09-30T15:10:00Z"},
        {"id": "wish-03", "title": "Intraday nostro balances feed for Treasury",
         "description": "A feed of nostro account balances at correspondent banks, refreshed during the day, for liquidity monitoring.",
         "category": "datafeed", "businessJustification": "Treasury only sees end-of-day MT950 statements today.",
         "expectedImpact": "Intraday view of cash at correspondents.", "requesterId": "u-henri", "sponsorId": "u-henri",
         "relatedProjectId": "prj-1005", "status": "accepted", "priority": "high", "comments": [],
         "tags": ["treasury", "nostro", "liquidity"], "createdAt": "2026-08-18T09:40:00Z", "updatedAt": "2026-09-12T11:00:00Z"},
    ]
    return {"businessUnits": units, "users": users, "projects": projects, "mcpServers": servers, "wishes": wishes,
            # What the Factory never reads but must never lose on a write.
            "technologies": [{"id": "tech-python", "name": "Python", "createdAt": "2025-01-06T09:00:00Z"}],
            "llmConfig": {"provider": "openai", "baseUrl": "https://llm.bank.example/v1", "apiKey": "sk-live-never-leaves",
                          "model": "gpt-4o"},
            "prompts": {"weekly": "Summarise the week."},
            "deletedIds": {"prj-0999": int(time.time() * 1000) - 3_600_000},   # deleted an hour ago
            "lastUpdated": 1791000000000}
