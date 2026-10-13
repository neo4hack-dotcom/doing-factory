"""Connector templates: the real MCP servers the Factory is built to work with, ready to fill
in (GET /api/connectors/templates, POST /api/connectors/from-template — docs/SPEC.md §7, §9).

- doing_ai — the bundled DOINg.AI MCP server (`mcp_servers/doing_ai_mcp.py`), started with the
  Factory's own interpreter, talking to a running DOINg.AI backend (DOING_AI_URL).
- jira — sooperset/mcp-atlassian, started with `uvx mcp-atlassian` (uv must be installed):
  Jira Cloud authenticates with JIRA_USERNAME (the account e-mail) + JIRA_API_TOKEN, Jira
  Server/Data Center with JIRA_PERSONAL_TOKEN.
- http — any MCP server reachable over streamable HTTP, with an optional bearer token.

A template field lands in the connector's environment (stdio) or in its URL / headers (http).
Secret fields are stored as given and masked on every read (util.public_connector).
"""
from __future__ import annotations

import sys
from typing import Any

from app.config import BACKEND_DIR
from app.errors import FactoryError

DOING_AI_SCRIPT = BACKEND_DIR / "mcp_servers" / "doing_ai_mcp.py"


def _field(key: str, label: str, *, secret: bool = False, required: bool = False, placeholder: str = "",
           help: str = "") -> dict[str, Any]:
    return {"key": key, "label": label, "secret": secret, "required": required, "placeholder": placeholder,
            "help": help}


def connector_templates() -> list[dict[str, Any]]:
    """→ [{id, name, kind, description, transport, command, args, env_template, fields, docs_url}]."""
    return [
        {"id": "doing_ai", "name": "DOINg.AI", "kind": "portfolio", "transport": "stdio",
         "description": "The DOINg.AI portfolio (use cases, people, MCP catalog, wishes) through the bundled DOINg.AI "
                        "MCP server. Reads the live instance and writes back project statuses and catalog "
                        "registrations.",
         "command": sys.executable, "args": [str(DOING_AI_SCRIPT)], "env_template": {},
         "fields": [
             _field("DOING_AI_URL", "DOINg.AI URL", required=True, placeholder="http://localhost:3001",
                    help="The DOINg.AI backend (its server.py, port 3001 by default) — not the web UI."),
             _field("DOING_AI_TOKEN", "Access token", secret=True,
                    help="Only when a reverse proxy protects DOINg.AI: sent as 'Authorization: Bearer <token>'."),
         ],
         "docs_url": ""},
        {"id": "jira", "name": "Jira", "kind": "jira", "transport": "stdio",
         "description": "Jira through sooperset/mcp-atlassian (run with uvx — install uv first). Cloud: e-mail + API "
                        "token. Server/Data Center: personal access token.",
         "command": "uvx", "args": ["mcp-atlassian"], "env_template": {},
         "fields": [
             _field("JIRA_URL", "Jira URL", required=True, placeholder="https://your-company.atlassian.net",
                    help="Base URL of the Jira instance."),
             _field("JIRA_USERNAME", "Username (Cloud)", placeholder="you@company.com",
                    help="Jira Cloud: the account e-mail, together with the API token."),
             _field("JIRA_API_TOKEN", "API token (Cloud)", secret=True,
                    help="Jira Cloud: create one at id.atlassian.com › Security › API tokens."),
             _field("JIRA_PERSONAL_TOKEN", "Personal access token (Server/Data Center)", secret=True,
                    help="Jira Server/Data Center: profile › Personal Access Tokens. Replaces username + API token."),
             _field("JIRA_SSL_VERIFY", "Verify SSL", placeholder="true",
                    help="'false' only for an on-premise instance with a self-signed certificate."),
             _field("JIRA_PROJECTS_FILTER", "Projects filter", placeholder="MCPF,DATA,OPS",
                    help="Optional: comma-separated project keys the server may access."),
             _field("READ_ONLY_MODE", "Read-only mode", placeholder="false",
                    help="'true' disables every write tool (the delivery blueprints then cannot create issues)."),
         ],
         "docs_url": "https://github.com/sooperset/mcp-atlassian"},
        {"id": "http", "name": "Remote MCP server", "kind": "other", "transport": "http",
         "description": "Any MCP server reachable over streamable HTTP.",
         "command": "", "args": [], "env_template": {},
         "fields": [
             _field("url", "Server URL", required=True, placeholder="https://mcp.example.com/mcp",
                    help="The MCP endpoint (streamable HTTP)."),
             _field("bearer_token", "Bearer token", secret=True,
                    help="Optional: sent as 'Authorization: Bearer <token>'."),
         ],
         "docs_url": "https://modelcontextprotocol.io/docs/learn/architecture"},
    ]


def template(template_id: str) -> dict[str, Any]:
    found = next((t for t in connector_templates() if t["id"] == template_id), None)
    if found is None:
        known = ", ".join(t["id"] for t in connector_templates())
        raise FactoryError(f"Unknown connector template '{template_id}' (known: {known}).", 422)
    return found


def connector_from_template(template_id: str, values: dict[str, Any], *, name: str = "",
                            kind: str = "") -> dict[str, Any]:
    """The connector fields (not yet saved) a template and its filled values describe. Raises a
    422 FactoryError naming the missing or inconsistent fields."""
    tpl = template(template_id)
    if not isinstance(values, dict):
        raise FactoryError("values must be an object {field: value}.", 422)
    keys = {f["key"] for f in tpl["fields"]}
    unknown = sorted(set(values) - keys)
    if unknown:
        raise FactoryError(f"Unknown field(s) for template '{template_id}': {', '.join(unknown)}.", 422)
    clean = {k: str(v).strip() for k, v in values.items() if v is not None and str(v).strip()}
    missing = [f["label"] for f in tpl["fields"] if f["required"] and not clean.get(f["key"])]
    if missing:
        raise FactoryError(f"Required: {', '.join(missing)}.", 422)
    doc: dict[str, Any] = {"name": (name or "").strip() or tpl["name"], "kind": kind or tpl["kind"],
                           "description": tpl["description"], "transport": tpl["transport"],
                           "command": tpl["command"], "args": list(tpl["args"]), "env": dict(tpl["env_template"]),
                           "url": "", "headers": {}}
    if template_id == "doing_ai":
        if not clean["DOING_AI_URL"].startswith(("http://", "https://")):
            raise FactoryError("DOINg.AI URL must start with http:// or https://.", 422)
        clean["DOING_AI_URL"] = clean["DOING_AI_URL"].rstrip("/")
    if template_id == "jira":
        cloud = bool(clean.get("JIRA_USERNAME") or clean.get("JIRA_API_TOKEN"))
        if clean.get("JIRA_PERSONAL_TOKEN") and cloud:
            raise FactoryError("Give either a personal access token (Server/Data Center) or a username and an API "
                               "token (Cloud), not both.", 422)
        if cloud and not (clean.get("JIRA_USERNAME") and clean.get("JIRA_API_TOKEN")):
            raise FactoryError("Jira Cloud needs both the username (account e-mail) and the API token.", 422)
        if not cloud and not clean.get("JIRA_PERSONAL_TOKEN"):
            raise FactoryError("Jira needs credentials: a username and an API token (Cloud), or a personal access "
                               "token (Server/Data Center).", 422)
    if tpl["transport"] == "stdio":
        doc["env"].update(clean)
    else:
        doc["url"] = clean["url"]
        if clean.get("bearer_token"):
            doc["headers"]["Authorization"] = f"Bearer {clean['bearer_token']}"
    return doc
