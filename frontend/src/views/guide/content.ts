// User guide content. Plain data (Markdown bodies + deep links into the app) so the view stays a
// renderer, the search can scan every word, and a test can check that every link still resolves
// to a real route. Write for the people who use the Factory, not for its developers.
import {
  Bell, Bot, BookOpen, ChartColumn, Factory, FolderKanban, HelpCircle, House, Inbox, Keyboard,
  MessageSquareText, Monitor, Plug, Radar, Rocket, Route, Settings, ShieldCheck, Users, Workflow,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { paths } from '../../lib/router';

export interface GuideLink {
  label: string;
  /** App path, e.g. paths.inbox(). */
  to: string;
}

export interface GuideSection {
  id: string;
  title: string;
  icon: LucideIcon;
  /** Table-of-contents group. */
  group: 'Start here' | 'Daily work' | 'Configure the factory' | 'Administration' | 'Reference';
  /** One sentence shown in search results and on the start page. */
  summary: string;
  body: string;
  links?: GuideLink[];
}

export const GUIDE_GROUPS: GuideSection['group'][] = [
  'Start here', 'Daily work', 'Configure the factory', 'Administration', 'Reference',
];

export const GUIDE: GuideSection[] = [
  // ------------------------------------------------------------------ Start here
  {
    id: 'overview',
    title: 'What the Factory does',
    icon: BookOpen,
    group: 'Start here',
    summary: 'An end-to-end delivery factory: from a new use case in DOINg.AI to a released, registered MCP server.',
    body: `
DOINg.AI Factory turns every new project into a **pipeline that runs itself as far as it can** and
asks the right person exactly when a human is needed.

1. **Watchers** poll your systems (first of all the **DOINg.AI** portfolio through its MCP server) on a
   schedule you choose and drop what is new into **Intake**.
2. Accepting an intake item starts a **project** from a **blueprint** — a reusable workflow made of
   stages and steps.
3. Each step is done by the **AI** (drafting, analysis, Jira writing, compliance checks, agents
   calling MCP tools) or by a **person** (forms, approvals, estimates, confirmations). Your **Inbox**
   lists only what waits for you.
4. **KPIs** and the **Factory Floor** show where work flows and where it waits.

The AI is a **local model** (Ollama or any OpenAI-compatible server): prompts and data stay on your
machine. When something is not configured — no model, no connector — the Factory says so plainly
and never invents an answer.

**Reference example.** A sponsor creates a use case in DOINg.AI → the watcher detects it → the
*Use Case Onboarding* blueprint qualifies it and an agent checks which MCP servers it needs against
the DOINg.AI catalog → for each **missing** server, an *MCP Delivery* child project runs: specification,
Jira epic in the right team, spec sign-off, estimation, Jira stories, test plan, compliance gate,
release ticket, approval by IT + sponsor + security, catalog registration and announcement.
`,
    links: [
      { label: 'Open Home', to: paths.home() },
      { label: 'See the walkthrough', to: paths.guide('walkthrough') },
    ],
  },
  {
    id: 'getting-started',
    title: 'Getting started in 5 minutes',
    icon: Rocket,
    group: 'Start here',
    summary: 'Connect the AI model, install the demo environment, pick who you are, run your first use case.',
    body: `
The **setup wizard** opens on first launch (and any time from *Settings › Setup wizard*).

1. **AI model** — the wizard detects Ollama and lists your models. Pick one marked
   **Recommended** (local + tool calling, e.g. \`qwen3.5:4b\` or \`gemma4:e4b\`), press **Test**, then **Save**.
2. **Connect** — choose **Install demo environment** to get, clearly labelled *Sandbox*:
   - a DOINg.AI portfolio MCP server with sample use cases and an MCP catalog,
   - a Jira MCP server with team projects (MCPF, DATA, PAY, SEC, OPS),
   - the demo people and teams, the operations the blueprints call, and the watcher
     *New DOINg.AI use cases*.

   Or connect your own MCP servers in *Settings › Connectors*.
3. **Who are you** — pick a persona (see *People, roles and personas*).
4. Go to **Intake**, press **Run now** on the watcher (or **Simulate a sponsor creating a use case**),
   then **Accept** an item. The project starts and the AI begins working.
5. Switch persona (top right) to play the sponsor, the PM, the dev lead… and clear each **Inbox**.

> On a small laptop a local model takes 10–60 s per AI step. Everything the AI produced is shown for
> review; you can edit, regenerate or reject it.
`,
    links: [
      { label: 'AI model settings', to: paths.settings('ai') },
      { label: 'Intake', to: paths.intake() },
    ],
  },
  {
    id: 'personas',
    title: 'People, roles and personas',
    icon: Users,
    group: 'Start here',
    summary: 'Who can act on what: roles, the project sponsor rule, and the "Acting as" switcher.',
    body: `
Every person has one or more **roles**: Sponsor, Product Manager, Business User, Developer,
Dev Lead, IT Ops, Security, Compliance, Admin (editable in *Settings › People & Teams*).

**Who can act on a step**

| Who | Can act when… |
|---|---|
| An assignee | the step names them, or names one of their roles |
| A role holder | an approval waits for their role (one decision per role) |
| The sponsor | an approval waits for the *Sponsor* role — **only the project's own sponsor** counts |
| An admin | always (use it to unblock, not as a habit) |

Anyone else sees the step with a clear explanation, e.g. *"Waiting for: Security"*.

**Acting as.** The avatar menu at the top right switches the persona you act as. It is how you test
a blueprint end to end on your own, and every action is recorded under that persona in the audit log.

**Teams** map to Jira projects (key, component) and carry skills; the AI uses them to route work
("which team builds this MCP?").
`,
    links: [{ label: 'People & Teams', to: paths.settings('people') }],
  },

  // ------------------------------------------------------------------ Daily work
  {
    id: 'home',
    title: 'Home',
    icon: House,
    group: 'Daily work',
    summary: 'Your command center: AI briefing, what needs you, KPIs at a glance and live activity.',
    body: `
- **Morning briefing** — an AI summary of what needs you today, written from your inbox, your
  projects and their risks. Without a model you get a factual summary instead, labelled as such.
  Press refresh to regenerate it.
- **Needs you** — your most urgent tasks with their primary action right there (**Approve**,
  **Start**, **Open**). Overdue items come first.
- **KPI strip** — active projects, waiting on you, at risk, done in 30 days, hours saved. Each tile
  opens the matching filtered list.
- **Factory flow** — how many projects sit in each stage, per blueprint.
- **Intake** — new items detected by the watchers.
- **Live activity** — every action as it happens.
- Quick actions: **New project**, **Ask Factory**, **Run watchers**.
`,
    links: [{ label: 'Open Home', to: paths.home() }],
  },
  {
    id: 'inbox',
    title: 'Inbox and tasks',
    icon: Inbox,
    group: 'Daily work',
    summary: 'Everything waiting for you, with the action panel inline — forms, approvals, estimates, confirmations, gates, failures.',
    body: `
The Inbox lists only what **you** can act on, grouped: Overdue, Approvals, Forms & reviews,
Confirmations, Failures, Starts & external, Intake. Filter by kind or search; select an item and its
**task panel** opens on the right — no page change.

| Task | What you do |
|---|---|
| **Form** | Fill the fields. When the AI drafted them they are highlighted: review, edit, or *Regenerate with instructions*. **Save draft** or **Submit**. |
| **Approval** | Read the AI **decision brief** and the artifacts, then **Approve** or **Reject** (a comment is required to reject). The approver chips show who already decided. |
| **Estimate** | Start from the AI suggestion (*Use suggestion*) or enter your own value, unit, confidence and breakdown. |
| **Confirm** | The Factory is about to **write** to an external system (create a Jira issue, register an MCP server…). Check and edit the arguments, then **Confirm & run** or **Reject**. For an agent you can also *Approve all remaining writes* of that step. |
| **Quality gate** | Review the compliance checks. **Override** a failure (with a justification, role-restricted), **Send back** to an earlier step, or **Re-run checks**. |
| **AI review** | Edit the AI-written document, *Regenerate with instructions*, or **Approve** it. |
| **Failure** | Read the error and the trace, then **Retry**, **Skip** (with a reason) or **Complete manually**. |
| **Start / External** | Start a step that waits for a go, or mark an external wait (e.g. a Jira epic done) as complete. |

**Rejecting an approval** sends the work back to the step it reviews: that step reopens with your
comment shown as *reviewer feedback*, and the AI takes it into account when it redrafts.

Keyboard: \`j\` / \`k\` move, \`a\` approve (accept for intake), \`r\` reject (dismiss for intake),
\`Enter\` opens the item full page. After an action the next item is selected for you.
`,
    links: [{ label: 'Open Inbox', to: paths.inbox() }],
  },
  {
    id: 'projects',
    title: 'Projects and the project page',
    icon: FolderKanban,
    group: 'Daily work',
    summary: 'The portfolio (table, board, tree) and everything about one project: pipeline, artifacts, activity, dossier.',
    body: `
**Portfolio.** Switch between **Table**, **Board** (by status, or by stage when one blueprint is
selected) and **Tree** (parents with their child projects). Filter by status, blueprint, priority,
risk or *mine*; the filters live in the URL so you can share a view. **New project** starts one by
hand: pick a blueprint, then fill the title, description and the blueprint's inputs.

**Project page.**
- **Header** — status, priority, **risk** (press *Explain* for an AI reading of the risk factors),
  sponsor, owner, team, due date, tags. Actions:
  - **Status report** — an AI report for the sponsor, the team or executives (copy or print);
  - **Summarize** — a short AI summary kept on the project;
  - **Download dossier** — a Markdown audit pack: step log, artifacts, approvals trail, compliance
    checks, links, child projects and the project's audit events with the integrity check of the chain;
  - **Ask Factory** — the copilot, scoped to this project; **Cancel** (with a reason).
- **Pipeline** — every stage and step. Click a step to open its drawer: the task panel when you can
  act, otherwise its details (timings, assignees, output, approvals, checks, live trace).
- Tabs: **Overview** (AI summary, inputs, produced values, links such as Jira issues, child projects
  and the **dependency graph**), **Artifacts** (documents with version history — edit, restore,
  AI rewrite), **Activity** (timeline + comments), **Trace** (what the AI and the agents did, live),
  **Details** (raw data and metrics: LLM calls, tokens, AI vs human steps, hours saved).

**Risk** is computed from facts — steps past their SLA, failures, rejections, time left versus
steps left, children at risk — so you can always see *why* a project is flagged.
`,
    links: [
      { label: 'Projects', to: paths.projects() },
      { label: 'New project', to: paths.newProject() },
    ],
  },
  {
    id: 'intake',
    title: 'Intake and watchers',
    icon: Radar,
    group: 'Daily work',
    summary: 'How new use cases are detected, triaged by the AI and turned into projects in one click.',
    body: `
A **watcher** runs an operation on a schedule (e.g. *list DOINg.AI projects in status Planning*
every 15 minutes, business hours only), compares the result with what it has already seen, and
creates an **intake item** for each new one — or starts a project directly if it is set to
*auto-start*.

For each item the AI proposes a **blueprint, priority, team, sponsor**, a summary and the
capabilities the use case needs, with a confidence level and its rationale. If the AI could not
analyse it (no model, model error) the reason is shown on the card; press **Analyze with AI** to retry.

- **Accept** — check or change the proposal (blueprint, title, priority, sponsor, owner, team) and
  start the project.
- **Dismiss** — with a reason; it will not come back.
- **Run now** on a watcher card polls immediately.
- With the demo environment, **Simulate a sponsor creating a use case** makes the AI invent a
  realistic use case in the sandbox DOINg.AI, then runs the watcher so it lands in Intake.

Watchers are configured in *Settings › Watchers* (schedule, active hours and days, what to read,
which field identifies an item, filters, and how fields map to the project).
`,
    links: [
      { label: 'Open Intake', to: paths.intake() },
      { label: 'Watchers settings', to: paths.settings('watchers') },
    ],
  },
  {
    id: 'floor',
    title: 'Factory Floor',
    icon: Factory,
    group: 'Daily work',
    summary: 'The live board: every project as a token in its current stage, and what the AI is doing right now.',
    body: `
One swimlane per blueprint, one column per stage. Each **token** is a project: progress ring, risk
dot, owner. A shimmering border means an AI step is running, an amber pulse means it waits for a
person, red means blocked. Tokens move between columns as work progresses; the column header shows
how many projects are there and their average time in that stage.

The **Live AI workers** panel streams model calls, agent thoughts, tool calls and every activity —
click an entry to open the project. Use the blueprint filter to focus on one flow.
`,
    links: [{ label: 'Open the Floor', to: paths.floor() }],
  },
  {
    id: 'copilot',
    title: 'Ask the Factory (copilot)',
    icon: MessageSquareText,
    group: 'Daily work',
    summary: 'Ask questions about the whole portfolio in plain English; answers cite the projects they come from.',
    body: `
Open it with **Ask Factory** in the header (or from a project to scope it to that project). The
copilot looks things up with read-only tools — projects, tasks, risks, KPIs, intake, blueprints —
and answers **only from what it found**; the projects it mentions are clickable chips.

Good questions: *What needs my attention?* · *Which projects are at risk and why?* · *Summarize
UC-0001 for its sponsor* · *Where are the bottlenecks this month?*

It never changes anything: approvals and edits stay in the Inbox and on the project page.
`,
  },
  {
    id: 'kpis',
    title: 'KPIs',
    icon: ChartColumn,
    group: 'Daily work',
    summary: 'Lead time, throughput, bottlenecks, SLA, approvals, automation and hours saved — and how each is measured.',
    body: `
Choose a period (7, 30 or 90 days). A value with no data shows "—": nothing is estimated.

| KPI | Measured as |
|---|---|
| **Lead time** | project created → completed (average, median, by blueprint) |
| **Throughput** | projects created vs completed per week |
| **Bottlenecks** | average time per stage, and time waiting on people (heatmap) |
| **SLA on time** | human steps completed before their due time |
| **Approvals** | average decision time and rejection rate, per role |
| **Automation** | share of steps completed by the AI, per step type |
| **Hours saved** | AI-completed steps × the baseline hours per step type (*Settings › General*) |
| **Quality** | compliance gates passed at the first run; the most failed rules |
| **Jira** | issues created through the Factory |
| **LLM usage** | calls, tokens, latency and errors per day and per AI role |
| **Funnel** | detected → accepted → active → done |
| **Workload** | open and overdue tasks per person |

The **AI insights** buttons open the copilot with a prepared question (bottlenecks, approval
latency, automation opportunities, executive summary). **Export** downloads the figures as JSON;
**Print** gives a clean page.
`,
    links: [{ label: 'Open KPIs', to: paths.kpis() }],
  },

  // ------------------------------------------------------------------ Configure
  {
    id: 'blueprints',
    title: 'Blueprints and step types',
    icon: Workflow,
    group: 'Configure the factory',
    summary: 'Design your own workflows: stages, the 10 step types, who acts, deadlines, conditions and AI prompts.',
    body: `
A blueprint is a list of **stages**; each stage holds **steps** that run one after the other, or
together when the stage is marked *parallel*. Three blueprints ship built in — *Use Case
Onboarding*, *MCP Delivery*, *Change Request*. Edit them, or **Duplicate** them to customise safely.
**Generate with AI** drafts a whole blueprint from a description.

| Step type | Done by | What it does |
|---|---|---|
| **AI task** | AI | Writes a document or structured data from a prompt (optionally reviewed by a person) |
| **Human form** | person | Fields to fill; the AI can pre-fill them |
| **Approval** | person(s) | Sign-off by roles: *all*, *any* or a *quorum*; a rejection reopens an earlier step |
| **Estimation** | person | Effort estimate with an AI suggestion and breakdown |
| **MCP operation** | system | Calls an operation on an MCP server (writes ask for confirmation) |
| **Agent** | AI | Works toward a goal by calling MCP tools itself, within a budget; pauses before writes |
| **Quality gate** | AI + person | Checks compliance rules against the project's documents |
| **Fan-out** | system | Starts one child project per item of a list (e.g. per missing MCP server) and waits for them |
| **Notify** | system | Tells people (in-app, and an external channel if configured); the AI can write the message |
| **Wait for** | system | Polls an external status (e.g. Jira epic *Done*) until a condition is met |

For each step you set the **assignees** (roles, people, or *the project's sponsor / owner / team*),
an **SLA** in hours, a **condition** (*when*) to skip it, and where its result is **stored** (*store
as*) so later steps can use it. Prompts and inputs are templates: the **Variables** helper lists what
you can insert — \`project.title\`, \`inputs.<field>\`, \`vars.<earlier result>\`, \`teams\`,
\`sponsor\`, \`feedback\`, \`item\` (in a fan-out)…

**Validate** checks the blueprint before you save; errors are pinned on the steps concerned.
`,
    links: [{ label: 'Open Blueprints', to: paths.blueprints() }],
  },
  {
    id: 'connectors',
    title: 'MCP connectors and operations',
    icon: Plug,
    group: 'Configure the factory',
    summary: 'Connect MCP servers (DOINg.AI, Jira…) and define the named operations blueprints call.',
    body: `
**Connectors** (*Settings › Connectors*) are MCP servers: a local program (**stdio**) or a URL
(**HTTP** / **SSE**), with environment variables or headers for credentials (secrets are masked).
**Test** lists the server's tools; the **tool bench** lets you try any tool with JSON arguments.
Tools that write are marked *Write* and ask for confirmation.

**Your real DOINg.AI.** On the sandbox DOINg.AI connector press **Duplicate as DOINg.AI bridge**
and give your DOINg.AI address (e.g. \`http://localhost:3001\`): the Factory then reads your real
portfolio, users and MCP catalog — **read-only**.

**Operations** (*Studio › Operations*) give a stable name to an action on a connector, so blueprints
never depend on a tool name. Three modes:

| Mode | How the call is built |
|---|---|
| **Direct** | Fixed arguments with template values, e.g. \`{"status": "Planning"}\` |
| **LLM** | The AI builds the arguments from instructions and the tool's schema |
| **Agent** | The AI chains several tool calls toward a goal (e.g. *find the Jira epic, create it if missing*) |

Mark an operation **sensitive** when it writes: under the default autonomy a person confirms each
call. **Try it** runs the operation with its test input and shows the arguments sent, the output and
the trace. **Suggest with AI** proposes an operation from a connector and what you want to do.
`,
    links: [
      { label: 'Connectors', to: paths.settings('connectors') },
      { label: 'Operations', to: paths.operations() },
    ],
  },
  {
    id: 'ai-model',
    title: 'AI model and prompts',
    icon: Bot,
    group: 'Configure the factory',
    summary: 'Choose and tune the local model; edit the system prompts behind every AI role.',
    body: `
*Settings › AI Model* — pick a preset (Ollama, LM Studio, vLLM, llama.cpp, any OpenAI-compatible
server), the base URL, the **model** and optionally a smaller **fast model** for rewording and
short checks. **Test connection** shows the latency, whether the model is local or remote, its
context size and any warning.

- **Context window (num_ctx)** — keep *Auto*. Ollama otherwise uses 4,096 tokens whatever the model,
  which silently truncates long prompts; the Factory asks for the model's real window (capped at
  16k locally).
- **Tool mode** — *Auto* uses native tool calling when the model supports it, else a JSON protocol.
- **Think** — lets reasoning models think before answering: better on hard steps, much slower.
  Off by default.
- With Ollama, use the native URL (\`http://127.0.0.1:11434\`), not its \`/v1\` endpoint.

**Prompts** (*Studio › Prompts*) — the system prompt of every AI role (spec writer, Jira writer,
test designer, estimator, compliance auditor, approval brief, copilot…). Edit one, compare with the
default, reset at any time. Test plans include Gherkin acceptance scenarios (*Copy .feature* on
the document) and estimates follow the DOINg.BA method (points, T-shirt size, complexity, confidence).
`,
    links: [
      { label: 'AI Model', to: paths.settings('ai') },
      { label: 'Prompts', to: paths.prompts() },
    ],
  },
  {
    id: 'compliance',
    title: 'Compliance rules and quality gates',
    icon: ShieldCheck,
    group: 'Configure the factory',
    summary: 'The IT-compliance checks a delivery must pass, and how overrides work.',
    body: `
*Studio › Compliance Rules* holds the rules (security, data, operations, architecture, legal,
quality), each with a severity, tags and guidance. A **quality gate** step selects rules by tag and
the AI checks each one against the project's documents (specification, test plan, release notes…),
returning *pass*, *fail* or *warn* with evidence and a recommendation. **Manual** rules are ticked by
a person.

The gate blocks on failures at or above the severity set on the step (*high* by default). Then a
person with an override role (Compliance, Security or Admin by default) can **Override** with a
justification, **Send back** the work to an earlier step, or **Re-run** the checks after a fix. The
KPIs track the first-pass rate and the most failed rules.
`,
    links: [{ label: 'Compliance Rules', to: paths.rules() }],
  },

  // ------------------------------------------------------------------ Administration
  {
    id: 'notifications',
    title: 'Notifications and the daily digest',
    icon: Bell,
    group: 'Administration',
    summary: 'Who is told what, when — in the app, on an external channel, and once a day.',
    body: `
The bell in the header shows your notifications: a task assigned to you, an approval waiting, a step
that failed on your project, a rejection, a project completed. Click one to open the project.

*Settings › Notifications*:
- **External channel** — pick an operation that sends messages (email, Teams… through an MCP
  server); it receives the recipients, a subject and a body.
- **Daily digest** — once per business day, at the start of business hours, everyone with something
  pending gets one summary: tasks by kind, overdue items, high-risk projects they own or sponsor, and
  intake waiting. People with nothing pending get nothing; it is never sent twice the same day.
`,
    links: [{ label: 'Notifications settings', to: paths.settings('notifications') }],
  },
  {
    id: 'admin',
    title: 'Engine, audit log and backup',
    icon: Settings,
    group: 'Administration',
    summary: 'How much the AI may do alone, the tamper-evident audit trail, and export / import.',
    body: `
**Engine** (*Settings › Engine*) — the **autonomy** level:

| Level | Behaviour |
|---|---|
| **Supervised** | Every AI document is reviewed by a person before the flow moves on |
| **Approve writes** *(recommended)* | The AI works alone, but every write to an external system waits for a confirmation |
| **Full** | Writes run without confirmation — for trusted, well-tested blueprints only |

A blueprint can override it. Also here: automatic retries (a failed AI step is retried with a
critic's advice), the agent budget (actions, timeout) and the **scheduler** (tick, SLA checks,
business hours, time zone).

**Audit log** — every human, AI and system action, chained by hashes: the badge says *Audit chain
verified* or shows where it was tampered with. Filter by kind, project or actor.

**Backup** — **Export** everything as JSON (it contains your connector secrets: store it safely),
**Import** a backup (replaces the current data after a confirmation), install the demo environment.

**General** — app name, company, and the **hours-saved** baseline per step type used by the KPIs.
`,
    links: [
      { label: 'Engine', to: paths.settings('engine') },
      { label: 'Audit log', to: paths.settings('audit') },
      { label: 'Backup', to: paths.settings('backup') },
    ],
  },
  {
    id: 'windows',
    title: 'Install and run (Windows, macOS, Linux)',
    icon: Monitor,
    group: 'Administration',
    summary: 'Start the Factory for development or production, including on Windows.',
    body: `
**Windows** — from the project folder:

| Script | Use |
|---|---|
| \`install-windows.bat\` | once: Python environment, UI dependencies, configuration file |
| \`start-windows.bat\` | development: API on port 3071, UI on port 3070, opens the browser |
| \`serve-windows.bat\` | production: builds the UI, then serves everything from port 3071 |

Do not start the API with \`--reload\` on Windows: local MCP servers (including the bundled DOINg.AI
and Jira ones) could not start. After a backend change, restart the API window.

**macOS / Linux** — API: \`cd backend && .venv/bin/python -m app\` (port 3071); UI in development:
\`cd frontend && npm run dev\` (port 3070). In production the API serves the built UI itself.

Requirements: Python 3.12+, Node 20+, and a local model server such as Ollama.
`,
  },

  // ------------------------------------------------------------------ Reference
  {
    id: 'walkthrough',
    title: 'Walkthrough: a new use case, end to end',
    icon: Route,
    group: 'Reference',
    summary: 'Follow one use case from DOINg.AI to production with the demo environment, persona by persona.',
    body: `
With the demo environment installed and a model configured:

1. **Intake** — *Run now* on *New DOINg.AI use cases*. Two use cases appear with the AI's proposal.
   As **Paul (Product Manager)**, **Accept** *Intraday Liquidity Forecasting Agent*.
2. **Qualification** — the AI qualifies the use case and the sponsor is notified of the kick-off.
3. **Dependency analysis** — an agent lists the MCP capabilities the use case needs and searches the
   DOINg.AI catalog: some exist, some are missing. Paul **approves** the analysis (or rejects it with
   feedback — the agent redoes it).
4. **Fan-out** — one *MCP Delivery* child project starts per missing server (see the
   **dependency graph** on the parent).
5. In each child:
   - **Specification** — Paul reviews the AI-drafted spec and submits it; the AI routes it to the
     right team; the agent finds or creates the **Jira epic** in that team's project — Paul
     **confirms** the creation;
   - **Sign-off** — **Sofia (Dev Lead)** and **Alice/Henri (the sponsor)** approve;
   - **Planning** — Sofia confirms the **estimate** (AI suggestion), reviews the AI **backlog**, the
     stories are created in Jira after confirmation;
   - **Build & test** — the AI writes the **test plan with Gherkin scenarios**; the step *Development*
     waits for the epic to be *Done* (or a developer marks it complete);
   - **Quality & compliance** — the AI checks the compliance rules; **Chloé (Compliance)** handles
     any failure; the developer records test results;
   - **Release** — AI release notes, change ticket in Jira (confirmed), approval by **Emma (IT Ops)**,
     the **sponsor** and **Lucas (Security)**, registration of the new server in the DOINg.AI catalog,
     announcement to stakeholders.
6. When all children are delivered, the parent moves to **go-live** readiness, approval and closure.

Watch it on the **Factory Floor**, then download the **dossier** of a delivered project.
`,
    links: [
      { label: 'Intake', to: paths.intake() },
      { label: 'Factory Floor', to: paths.floor() },
    ],
  },
  {
    id: 'shortcuts',
    title: 'Keyboard shortcuts',
    icon: Keyboard,
    group: 'Reference',
    summary: 'Move around and act without the mouse.',
    body: `
| Keys | Action |
|---|---|
| \`⌘K\` / \`Ctrl K\` | Search projects, views and actions; ask the copilot |
| \`g h\` · \`g i\` · \`g p\` · \`g f\` · \`g k\` · \`g u\` · \`g s\` | Go to Home · Inbox · Projects · Floor · KPIs · User Guide · Settings |
| \`j\` / \`k\` | Next / previous item (Inbox) |
| \`a\` / \`r\` | Approve / reject — accept / dismiss for intake (Inbox) |
| \`Enter\` | Open the selected item |
| \`⌘S\` / \`Ctrl S\` | Save (blueprint designer, prompt editor) |
| \`?\` | Show all shortcuts |

Shortcuts are ignored while you type in a field.
`,
  },
  {
    id: 'troubleshooting',
    title: 'Troubleshooting and FAQ',
    icon: HelpCircle,
    group: 'Reference',
    summary: 'The usual questions: slow or empty AI answers, a step that failed, a connector that does not start.',
    body: `
**"No LLM configured"** — open *Settings › AI Model*, pick a model, **Test**, **Save**.

**AI steps are slow** — a local model on a laptop takes 10–60 s per step. Prefer a smaller model as
*fast model*, keep *Think* off, close other heavy apps. The Floor's AI panel shows each call's latency.

**AI answers are empty or cut** — keep *num_ctx* on *Auto*; with Ollama use its native URL, not
\`/v1\`. The step trace shows what was sent and what came back.

**A step failed** — open it from the Inbox (*Failures*): the error says what to fix. **Retry** after
fixing, **Skip** with a reason, or **Complete manually**. A step interrupted by a server restart that
may have written somewhere is never replayed blindly: it waits for your *Retry*.

**"Operation … is not configured"** — a blueprint calls an operation key that does not exist: create
it in *Studio › Operations*, or install the demo environment.

**A connector does not start** — *Settings › Connectors › Test* shows the server's own error output.
On Windows, make sure the API was not started with \`--reload\`.

**I cannot approve** — the panel says who it waits for. The *Sponsor* role only counts for the
project's own sponsor; switch persona or ask an admin.

**A use case arrived without a sponsor** — its sponsor's e-mail in DOINg.AI matches no person in the
Factory. Add the person in *Settings › People & Teams*, then set the sponsor on the project.
`,
    links: [{ label: 'AI Model', to: paths.settings('ai') }, { label: 'Inbox', to: paths.inbox() }],
  },
];

/** Case-insensitive search over titles, summaries and bodies; title hits rank first. */
export function searchGuide(query: string): GuideSection[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return GUIDE
    .map((s) => {
      const title = s.title.toLowerCase();
      const text = `${title} ${s.summary} ${s.body}`.toLowerCase();
      if (!words.every((w) => text.includes(w))) return null;
      return { s, score: words.filter((w) => title.includes(w)).length };
    })
    .filter((x): x is { s: GuideSection; score: number } => x !== null)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.s);
}
