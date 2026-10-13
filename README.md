# DOINg.AI Factory

An end-to-end **delivery factory** for AI use cases. It polls external systems — first of all
the **DOINg.AI** portfolio, through its MCP server — detects new projects, and runs them through
configurable multi-stage workflows (**Blueprints**). These coordinate sponsors, product managers,
developers, IT, security and compliance, and a **local LLM** does the drafting, rewording, Jira
writing, estimation hints, test design, compliance QA and agentic steps over **MCP** tools.

Reference scenario, run against your real DOINg.AI and Jira:

1. A sponsor creates a use case in DOINg.AI, and a **watcher** polling the DOINg.AI MCP server detects it.
2. The Factory opens a project from the *Use Case Onboarding* blueprint. An agent finds that the
   use case needs 5 MCP servers, of which 3 exist in the catalog and 2 are missing.
3. A **fan-out** step starts one *MCP Delivery* child project per missing server. Each child runs:
   AI-drafted specification, then a Jira epic and stories, estimation, test sets, an IT-compliance
   quality gate, a change ticket, multi-party approval, catalog registration and stakeholder notification.
4. When every child is delivered, the parent moves on to go-live readiness and closure.

**Starts clean, degrades honestly.** The app boots with nothing configured. Anything that needs
the LLM or an MCP connector fails *at use time* with a message that names the fix ("No LLM
configured — open Settings › AI Model"). Nothing is ever fabricated, and nothing is simulated:
there is no demo data and no sandbox server — every connector points at a real system.

The contract for every contributor is [`docs/SPEC.md`](docs/SPEC.md). The UI is 100 % English.

---

## Features

| Area | What you get |
|---|---|
| **Home** | Command center for the current persona: AI morning briefing, "Needs you" list with one-click actions, KPI strip, factory flow, live activity |
| **Inbox** | Every task waiting for you (forms, approvals, estimates, confirmations, quality gates, failures, intake) with the action panel inline — `j`/`k`, `a` approve, `r` reject |
| **Projects** | Table / board / tree portfolio; project page with stage pipeline, step drawer, artifacts with versions, activity, live agent trace, dependency graph, AI status report, risk explanation, **audit dossier** export (Markdown: step log, artifacts, approvals, gate checks, hash-verified audit trail) |
| **Factory Floor** | Live board: every project as a token in its current stage, AI workers ticker (LLM calls, tool calls, agent thoughts) |
| **Intake** | Items detected by the watchers, triaged by the AI (blueprint, priority, team, sponsor), accepted in one click |
| **KPIs** | Lead time, throughput, stage bottleneck heatmap, SLA, approvals by role, AI automation share & hours saved, quality first-pass rate, LLM usage, intake funnel, workload |
| **Studio** | Visual **Blueprint designer** (10 step types, type-specific forms, variable helper, validation, *Generate with AI*), **Operations** (MCP bindings: direct / LLM-built / agent, with *Try it*), **Prompt library**, **Compliance rules** |
| **Settings** | AI model (presets, model picker, live test), MCP connectors (templates for DOINg.AI, Jira and remote servers, one-click standard setup) + tool bench, watchers (schedules, mappings), people / teams / roles (people imported from DOINg.AI), notifications (+ **daily digest** on business days), engine autonomy & scheduler, hours-saved baselines, tamper-evident audit log, backup / import |
| **Copilot** | "Ask the Factory" chat over the whole portfolio, read-only tools, answers cite projects as clickable chips |
| **User Guide** | In-app guide (menu *User Guide*, the **?** icon in the header, or `g u`): every screen, the 10 step types, configuration, an end-to-end walkthrough, shortcuts and troubleshooting — searchable, with links into the app |
| **Factory MCP** | The Factory itself is an MCP server at `/mcp` (projects, approvals, KPIs) for other agents |

**Step types:** AI task · human form (AI pre-filled) · approval (all / any / quorum, reject → rework) ·
estimation (AI suggestion) · MCP operation (writes need confirmation by default) · agent (bounded
tool-calling loop, pauses before writes) · quality gate (AI compliance audit, override / send back) ·
fan-out (one child project per item) · notify · wait for (polls an external status).

**Business-analysis know-how from DOINg.BA:** test plans come with a UAT table and Gherkin
`Feature/Scenario/Given/When/Then` acceptance scenarios (highlighted in the UI, *Copy .feature*),
estimates follow DOINg.BA's method (Fibonacci points, T-shirt size, complexity, confidence),
Jira stories carry Given/When/Then acceptance criteria and a WSJF-informed priority.

**Look:** brand colour **Pantone 340 C** — RGB (0, 148, 100), `#009464` (Tailwind `brand` scale in
`frontend/tailwind.config.js`), light and dark mode, self-hosted Inter (works offline).

## Status

Everything in the SPEC is implemented: 442 backend tests and the frontend tests pass. The app is
real-only: the end-to-end delivery stages are covered by tests against a DOINg.AI backend double and an
mcp-atlassian double with the real tool shapes. A small local model is slow (10–60 s per AI step on an
8 GB Mac) and sometimes imperfect: every AI output is shown for review, nothing is invented when it fails.

## Getting started in 5 steps

1. Start the API and the UI (below), open http://127.0.0.1:3070.
2. The setup wizard: pick your Ollama model (tool-capable), **Test**, **Save**.
3. **Settings › Connectors › Add from template**:
   - **DOINg.AI** — the URL of your DOINg.AI backend (e.g. `http://localhost:3001`);
   - **Jira** — `sooperset/mcp-atlassian` started with `uvx` ([install uv](https://docs.astral.sh/uv/)): your Jira URL,
     then an e-mail + API token (Cloud) or a personal access token (Server/Data Center).
   Each connector is tested as soon as it is saved. Then run **Standard setup** on each: it creates the operations the
   builtin blueprints call and the *New DOINg.AI use cases* watcher.
4. **Settings › People & Teams**: **Import from DOINg.AI** (sponsors get the Sponsor role), give everyone their
   Factory roles, and create the delivery teams with their Jira project key and skills (routing picks among them).
   Optionally set the *Change Jira project* input of the MCP Delivery blueprint (Studio) to your change project.
5. **Intake › Run now**, then **Accept** a use case: a *Use Case Onboarding* project starts. Switch persona (top right)
   to work the **Inbox**; watch it move on the **Factory Floor** and in **KPIs**.

---

## Quick start (development)

Requires **Python 3.12**, **Node 20+**, and optionally **Ollama** (any model that reports
`tools`; developed against `qwen3.5:4b`).

```bash
# API on http://127.0.0.1:3071
cd backend
python3.12 -m venv .venv && .venv/bin/pip install -r requirements.txt
.venv/bin/uvicorn app.main:app --port 3071 --reload --reload-dir app

# UI on http://127.0.0.1:3070 (proxies /api, the /api/ws WebSocket and /mcp to :3071)
cd frontend
npm install && npm run dev
```

The workspace launch configs `factory-api` and `factory-web` (`/Users/mathieumasson/CLAUDE/.claude/launch.json`)
run the same two commands. Ports 3000–3062 belong to other local apps, so the Factory uses **3070/3071**.

On first open, an onboarding checklist points at what is missing: the AI model, the DOINg.AI and
Jira connectors, their standard setup, and the people.

## Windows

The Factory runs on Windows 10/11 with Python 3.12+ (`py` launcher) and Node 20+:

```bat
install-windows.bat   :: once — venv, pip (incl. tzdata), npm install, long paths, backend\.env
start-windows.bat     :: development — API window on :3071, UI window on :3070, opens the browser
serve-windows.bat     :: production — builds the UI, then one process on :3071 (--no-build to skip)
```

What is specific to Windows, and already handled:

- **No `--reload` for the API.** uvicorn's reloader puts asyncio on the Selector loop, which cannot
  start subprocesses, so no local (stdio) MCP server — including the DOINg.AI MCP server and
  mcp-atlassian — could start. The scripts run `python -m app`; restart the API window after a backend change.
  (If you start it with `--reload` anyway, connectors fail with a message saying exactly that.)
- **Time zones:** Windows has no IANA database, so `tzdata` is installed there; otherwise the scheduler
  timezone (Europe/Paris by default) would silently become UTC.
- **MCP servers:** `.cmd` launchers (`npx`, `uvx`) are resolved through `PATH`, children get UTF-8 pipes
  (`PYTHONUTF8`) and no console window pops up.
- **Batch files keep CRLF** (`.gitattributes`), and every text file is read and written as UTF-8.

`backend/tests/test_windows_compat.py` pins these rules so they are checked on any OS. Not yet
verified on a physical Windows machine.

## Production (single origin)

```bash
cd frontend && npm run build          # → frontend/dist
cd ../backend && .venv/bin/python -m app
```

`python -m app` serves the API **and** the built UI from one process on `FACTORY_HOST:FACTORY_PORT`
(127.0.0.1:3071 by default), so there is no CORS. Unknown `/api/*` paths are JSON 404s, and any
other path falls back to the SPA.

## Configuration

Two layers:

- **Deployment** (machine-level): environment variables prefixed `FACTORY_`, or `backend/.env`.
  None is required; see [`backend/.env.example`](backend/.env.example).

  | Variable | Default | Purpose |
  |---|---|---|
  | `FACTORY_HOST` / `FACTORY_PORT` | `127.0.0.1` / `3071` | where `python -m app` listens |
  | `FACTORY_DATA_DIR` | `data` | runtime data |
  | `FACTORY_DB_PATH` | `data/factory.db` | SQLite document store (WAL) |
  | `FACTORY_STATIC_DIR` | auto: `../frontend/dist` | built UI to serve |
  | `FACTORY_BACKGROUND_JOBS` | `true` | scheduler + boot-time connector check (off for tests/scripts) |
  | `FACTORY_LLM_PROVIDER` / `_BASE_URL` / `_MODEL` / `_API_KEY` | empty | **first boot only**: pre-fills Settings › AI Model |

  Relative paths resolve against `backend/`.
- **Runtime** (admin choices): everything else lives in the database and is edited in the UI,
  under **Settings**:
  - AI Model, Connectors, Watchers, People & Teams;
  - Notifications, Engine (autonomy, retries, agent budget), General;
  - Audit Log, Backup.

  Saving the AI model hot-swaps the client, with no restart needed.

LLM tips:
- For Ollama, use the native provider with `http://127.0.0.1:11434` (no `/v1`); its
  OpenAI-compatible endpoint truncates prompts at 4096 tokens.
- `num_ctx = 0` sizes the context window automatically: the model's maximum, capped at 16k locally.
- Keep *Reasoning* off for thinking models such as `qwen3.5`, which is much faster.
- Models tagged `-cloud` run off the machine, and the UI flags them.

## MCP servers

**DOINg.AI — `backend/mcp_servers/doing_ai_mcp.py`** (stdlib only, MCP `2025-06-18` through `_mcp_stdio.py`,
launched with the Factory's own interpreter). It talks to a running DOINg.AI backend:
- `DOING_AI_URL` (required), optional `DOING_AI_TOKEN` (Bearer, for a protected instance) and `DOING_AI_TIMEOUT`.
  Without a reachable DOINg.AI it refuses to start and the connector test says why.
- Reads: `list_projects`, `get_project`, `list_users`, `list_wishes`, `list_mcp_servers`, `search_mcp_servers`
  (`GET /api/data`; password hashes, tokens, API headers and credentials in URLs never leave the process).
- Writes: `update_project_status` and `register_mcp_server` — read-modify-write of DOINg.AI's document through
  `POST /api/data` with `X-Base-Version` (optimistic concurrency; DOINg.AI merges concurrent edits by id; a 409 is
  retried once), sending everything else back exactly as read.

**Jira — [sooperset/mcp-atlassian](https://github.com/sooperset/mcp-atlassian)** (`uvx mcp-atlassian`). The standard
operations use its tool names and argument shapes (`jira_search`, `jira_get_issue`, `jira_create_issue`,
`jira_batch_create_issues`…). Stories are linked to their epic with the *Epic Link* field and sized with *Story Points*
(Server/Data Center names); on Jira Cloud adapt `jira.create_stories` in Studio › Operations.

Test doubles of both (a DOINg.AI backend, an mcp-atlassian look-alike) live in `backend/tests/fixtures/` and are
used by the tests only.

Any other MCP server (stdio, streamable HTTP or SSE) can be added as a connector. Tools whose
names carry a write verb, or that declare `destructiveHint`, are **sensitive**: under the default
`approve_writes` autonomy, they wait for a human confirmation.

## Architecture

```
 Browser ── React 19 SPA (hash router, Context store, hand-rolled SVG charts)
    │  REST /api/*   WebSocket /api/ws (live events)   /mcp (Factory as an MCP server)
    ▼
 FastAPI app (main.py: lifespan · error mapping · routers · SPA fallback)
    │
 Container (deps.py) ── one instance per subsystem, wired in dependency order
    ├─ Store ............ SQLite document store: docs + hash-chained audit events + LLM call log
    ├─ EventBus ......... in-process pub/sub → WebSocket fan-out
    ├─ LLMClient ........ Ollama native / OpenAI-compatible, rebuilt when settings change
    ├─ AIRuntime ........ prompt library, JSON parsing + one repair round-trip, call metrics
    ├─ MCPManager ....... one persistent connection per connector (stdio · HTTP · SSE), tool index
    ├─ OperationExecutor  named MCP bindings run in direct | llm | agent mode
    ├─ WorkflowEngine ... blueprint → project; step executors; approvals, gates, fan-out, recovery
    ├─ Scheduler ........ watchers, wait_for polling, SLA checks, risk refresh
    └─ Notifier · WatcherService
            │ stdio / HTTP
            ▼
   MCP servers: DOINg.AI Portfolio · Jira · any connector you add
```

```
backend/   app/ (models.py = the data contract) · mcp_servers/ · tests/ · data/ (runtime, gitignored)
frontend/  src/ (api.ts = the one typed client, types.ts mirrors models.py) · tests/
docs/      SPEC.md — product & technical contract
```

## Tests

```bash
cd backend && .venv/bin/python -m pytest -q
cd frontend && npm run typecheck && npm test && npm run build
```

- The backend run includes `frontend/tests/test_types_mirror.py`, which fails when `types.ts`
  drifts from `models.py`.
- Each test gets its own temporary database, with background jobs off.
- `FACTORY_LIVE_LLM=1` adds one opt-in test against a real local Ollama.
