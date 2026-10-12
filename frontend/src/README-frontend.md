# Frontend reference — for feature builders

Everything a view needs is already here: read this instead of every file. The contract for data
shapes is `src/types.ts` (a hand mirror of `backend/app/models.py`), for endpoints `src/api.ts`
(docs/SPEC.md §9), for live events `src/ws.ts` (SPEC §8).

## House rules

- **Never call `fetch`.** Use `api.*` (one method per endpoint). Errors are `ApiError` with the
  backend's readable `{detail}` → `toast.error(err)`.
- **`user_id` is automatic for audit attribution.** The store calls `setActingUser(personaId)`; every
  POST/PUT/PATCH/DELETE without an explicit `user_id` gets `?user_id=<persona>`. Methods whose SPEC
  body names `user_id` (projects, steps, intake, notifications, copilot) still take it explicitly —
  pass `useApp().userId`.
- **Live data:** views own their heavy data (projects, inbox…) and refresh it with
  `useLive('project.updated', e => …)`. Reference data (users, teams, blueprints, connectors,
  operations, settings) lives in `useApp()`; call `reload()` after you mutate it.
- **No fabricated content.** No LLM / connector → show the backend's actionable message, never a
  fake answer. Empty lists → `EmptyState` with the next action.
- **Titles:** `usePageTitle('UC-0007 · Payments MCP')` sets the header + tab title.
- **Colours:** use `Tone` names (`zinc brand emerald sky amber rose violet indigo cyan fuchsia pink
  orange teal`) through components or `TONE[tone].soft|solid|text|dot|icon|border|ring`; never build
  class names dynamically (Tailwind only ships classes written in full). Status colours: emerald
  done, sky running, amber waiting, rose failed/blocked, violet AI; brand→amber gradient = AI only.
- **CSS vocabulary** (index.css): `card`, `surface`, `surface-deep`, `surface-flat`, `surface-glass`,
  `hairline` (border colour), `label-xs` (uppercase micro-label), `text-muted`, `text-faint`, `num`
  (tabular figures), `btn-ai`, `text-ai`, `ring-ai` (AI-drafted highlight), `grid-bg`, `shimmer`,
  `stripes`, `hatched`, `no-scrollbar`, print helpers `no-print` / `print-only` / `print-page` /
  `print-section`. Animations: `animate-fade-in | slide-up | slide-in-right | scale-in | shimmer |
  pulse-slow | flow` (SVG dashed edges: `stroke-dasharray` + `animate-flow`) `| progress-stripes | gradient-x`.

## Views (placeholders to replace — keep the default export and props)

| File | Route | Props |
|---|---|---|
| `views/Home.tsx` | `#/` | — |
| `views/Inbox.tsx` | `#/inbox`, `#/inbox/:itemId` | `{ itemId?: string }` (`"{project_id}:{step_id}"` or `"intake:{id}"`) |
| `views/Projects.tsx` | `#/projects?…` | `{ query: Record<string,string> }` |
| `views/NewProject.tsx` | `#/projects/new?blueprint=` | `{ blueprintId?: string }` |
| `views/ProjectDetail.tsx` | `#/projects/:id[/:stepId]` | `{ id: string; stepId?: string }` |
| `views/Floor.tsx`, `Intake.tsx`, `Kpis.tsx` | `#/floor`, `#/intake`, `#/kpis` | — |
| `views/studio/Blueprints.tsx` | `#/studio/blueprints` | — |
| `views/studio/BlueprintDesigner.tsx` | `#/studio/blueprints/:id` | `{ id: string }` (`'new'` = blank draft) |
| `views/studio/Operations.tsx`, `Prompts.tsx`, `Rules.tsx` | `#/studio/…` | — |
| `views/settings/Settings.tsx` | `#/settings/:tab` | `{ tab: SettingsTab }` (`ai connectors watchers people notifications engine general audit backup`) |

Views are lazy chunks inside a max-width column (`floor` and `blueprint` get full width), wrapped in
an error boundary and `Suspense` (skeleton). `SPEC §11` also names `views/TaskPanel.tsx` and
`components/DependencyGraph.tsx`: create them in the feature phase.

Shell overlays you replace: `components/CopilotPanel.tsx` (`{open, onClose, question, projectId}` —
opened with `useApp().openCopilot({question?, projectId?})`), `components/Onboarding.tsx`
(`{open, onClose}`; shown while `onboarding.llm_configured` is false, dismissible per browser session).

## lib/

**`store.tsx`** — `useApp()` returns:
`status ('loading'|'ready'|'error')`, `error`, `settings`, `users`, `teams`, `roles`, `blueprints`,
`connectors`, `operations`, `onboarding`, `reload()`, `userId`, `me`, `isAdmin`, `setUserId(id)`,
`theme`, `setTheme(t)`, `toggleTheme()`, `live ('connecting'|'open'|'closed')`, `subscribe(fn)`,
`counts: InboxCounts`, `refreshCounts()`, `userById(id)`, `teamById(id)`, `roleByKey(key)`,
`blueprintById(id)`, `connectorById(id)`, `copilot {open, question, projectId}`, `openCopilot(opts)`,
`closeCopilot()`.
`useLive(type | '*', handler)` — typed per event (`useLive('step.trace', e => e.entry)`); the handler
may be an inline closure. Events are batched once per frame; after a reconnect the store reloads
bootstrap + counts (events sent while offline are lost). Counts refresh on `project.updated`,
`project.deleted`, `notification`, `intake.updated`.

**`router.ts`** — `useRoute() → {name, params, query, path}`; `navigate(path, {replace?})`;
`<Link to="/projects/x" …anchorProps>` (modified clicks open new tabs); `href(path)`;
`isActivePath(current, path)`; `paths.home() | inbox(itemId?) | projects(query?) | newProject(bpId?) |
project(id, stepId?) | floor() | intake() | kpis() | blueprints() | blueprint(id) | operations() |
prompts() | rules() | settings(tab?)`; `SETTINGS_TABS`, `SettingsTab`.

**`format.ts`** — `timeAgo(iso)` "3h ago"/"in 2d", `formatDate(iso, short?)` "11 Oct 2026",
`formatDateTime`, `formatTime`, `formatDuration(ms)` "2d 4h", `formatHours(h)`, `formatDays(d)`
"4.5 d", `formatNumber(n, decimals?)`, `formatCompact(n)` "12.9K", `formatPercent(ratio, isRatio?,
decimals?)`, `formatLatency(ms)`, `dueLabel(iso) → {label, overdue, soon}`, `initials(name)`,
`plural(n, word)`, `humanize('waiting_approval')`, `formatBytes`, `truncate(text, max)`, `toMs`.
All return "—" for null/invalid input.

**`status.ts`** — label + tone per vocabulary: `STEP_STATUS` (+`waiting`: a person must act),
`PROJECT_STATUS`, `STAGE_STATUS`, `PRIORITY` (+`rank`), `RISK`, `SEVERITY` (+`rank`), `CHECK_STATUS`,
`INTAKE_STATUS`; `statusMeta(kind, value)` degrades unknown values to a neutral chip.

**`types.ts` extras** — `STEP_TYPES[type] → {label, description, icon, color, automated}`,
`STEP_TYPE_ORDER`, `HUMAN_WAIT_STATUSES`, `STEP_TERMINAL_STATUSES`, `StepConfigMap` (typed
`config` per step type), `DEFAULT_HOURS_SAVED`, API payload types (`Bootstrap`, `Health`, `Briefing`…).

Also: `hotkeys.ts` — `useHotkeys({'j': fn, 'a': fn, 'g h': fn, 'mod+enter': fn}, enabled?)` (bare
keys never fire while typing; `mod+…` always does), `MOD_LABEL` ("⌘"/"Ctrl"). `nav.ts` —
`NAV_ITEMS`, `SETTINGS_NAV`, `ROUTE_TITLES`. `llm.ts` — `llmLocality(settings.llm) →
'none'|'local'|'remote'`, `isCloudModel`. `storage.ts` — `readStorage`/`writeStorage` (never throw),
`STORAGE_KEYS`. `pageTitle.ts` — `usePageTitle(title)`. `cls.ts` — `cls(...parts)`.

## components/ui.tsx

| Component | Props (all accept `className`) |
|---|---|
| `Button` | native button props + `variant: 'primary'\|'outline'\|'ghost'\|'danger'\|'ai'`, `size: 'xs'\|'sm'\|'md'\|'lg'`, `icon`, `iconRight` (LucideIcon), `busy` (spinner + disabled) |
| `IconButton` | `icon`, `label` (required: aria-label + title), `variant: 'ghost'\|'outline'\|'primary'`, `size: 'xs'\|'sm'\|'md'`, `active`, `badge` (count, 99+), `busy` |
| `CopyButton` | `text`, `label?`, `size?`, `variant?` |
| `Card` | div props + `tone: 'default'\|'accent'\|'ai'\|'muted'`, `padding: 'none'\|'sm'\|'md'\|'lg'`, `onClick` (whole card clickable, keyboard too) |
| `CardHeader` | `title`, `subtitle?`, `eyebrow?`, `icon?`, `iconTone?`, `actions?`, `divider = true` — use inside `<Card padding="none">` |
| `SectionHeader` | `eyebrow?`, `title`, `description?`, `actions?`, `icon?`, `size: 'page'\|'section'` |
| `Badge` | `tone`, `variant: 'soft'\|'solid'\|'outline'`, `icon?`, `dot?`, `size: 'xs'\|'sm'`, `title?` |
| `StatusBadge` | `kind: 'step'\|'project'\|'stage'\|'priority'\|'risk'\|'severity'\|'check'\|'intake'`, `value`, `size?` (running steps pulse) |
| `Avatar` | `user?: {name, avatar_color?}`, `name?`, `size = 28` (px); `avatar_color` = hex or tone name, '' = derived from the name |
| `AvatarStack` | `users[]`, `max = 4`, `size = 24` (+N chip with names in its title) |
| `Field` | `label?`, `help?`, `error?`, `required?`, `htmlFor?`, `aside?` (right of the label: AI button…) |
| `Input` | input props + `invalid?`, `icon?` (leading) |
| `Textarea` | textarea props + `invalid?`, `autoGrow = true`, `minRows = 3`, `maxRows = 18` |
| `Select` | select props + `options?: (string \| {value,label,disabled?})[]`, `placeholder?` (empty first option), `invalid?` |
| `Toggle` / `Checkbox` | `checked`, `onChange(bool)`, `label?`, `description?`, `disabled?` (Toggle: `size: 'sm'\|'md'`) |
| `Tabs` | `tabs: {key, label, icon?, count?, disabled?}[]`, `value`, `onChange(key)`, `size?` — underline, ←/→ keys |
| `Modal` | `open`, `onClose`, `title`, `subtitle?`, `icon?`, `iconTone?`, `footer?`, `size: 'sm'\|'md'\|'lg'\|'xl'` (Esc/backdrop close, focuses the first field) |
| `Drawer` | `open`, `onClose`, `title`, `subtitle?`, `icon?`, `actions?`, `footer?`, `width: 'md'\|'lg'\|'xl'` (right side) |
| `Popover` + `MenuItem` | `anchor` (ref), `open`, `onClose`, `align: 'left'\|'right'`, `side`, `width = 260` · `MenuItem {icon?, label, hint?, onClick, active?, danger?, disabled?}` |
| `Tooltip` | `content`, `side: 'top'\|'bottom'`, `delay = 150` (portal, never clipped) |
| `EmptyState` | `icon`, `title`, `description?`, `action?`, `compact?` |
| `Spinner` / `Skeleton` / `Kbd` | `size?` / `className` (give a size) or `lines` / children |
| `ProgressBar` | `value` (0-1), `tone: Tone \| 'ai'`, `size: 'xs'\|'sm'\|'md'`, `striped?`, `label?`, `showValue?` |
| `Stat` | `label`, `value`, `sub?`, `icon?`, `tone?`, `trend?: number[]` (sparkline), `delta?: {value, label?, good?: 'up'\|'down'}`, `onClick?` (deep-link), `loading?` |

Hooks & providers (wired in `main.tsx`): `useToast() → {success, info, warn, error(errOrMsg), push}`
(each takes `opts {action?: {label, onClick}, duration?}`); `useBusy() → [busyKey, run(key, asyncFn)]`
(toasts errors: `busy={busy === 'save'}`); `useConfirm()(opts) → Promise<boolean>` and
`useConfirmReason()(opts) → Promise<string | null>` with `opts {title, message?, tone: 'info'|'warning'|'danger',
confirmLabel?, cancelLabel?, steps?: 1|2|3}` (+ `reasonLabel?, reasonPlaceholder?, reasonRequired = true,
defaultReason?`). Use `steps: 2` for production releases, Jira writes and gate overrides.
`useEscapeLayer(active, fn)` — Esc closes only the topmost overlay. `toneOf(colorName)`,
`toneForName(name)`, `TONE`.

## Other shared components

- **`Markdown`** `{content, size: 'xs'|'sm' = 'sm'}` — safe (React elements only, whitelisted HTML,
  `safeUrl`), GFM tables, task lists, fences with any info string (cannot hang), and ```` ```chart ````
  blocks `{"type": "bar"|"donut"|"kpi", "title"?, "data": [{label, value, color?}]}` drawn as SVG.
  `parseChartSpec(src)`, `safeUrl(url)`.
- **`Charts`** (pure SVG, measure their container, tooltips, dark-mode via `--series-1…8`,
  `--chart-grid|axis|surface`; every chart takes `title?` for its screen-reader table):
  `LineChart {labels, series: {name, values: (number|null)[], color?}[], height = 200, area?, yFormat?, yMin?}` ·
  `BarChart {data: {label, value, color?, hint?}[], orientation: 'vertical'|'horizontal', height?, valueFormat?, color?, onSelect?}` ·
  `StackedBar {categories, series: {name, values, color?}[], orientation?, height?, valueFormat?, normalize?}` ·
  `Donut {data, size = 140, thickness = 18, centerValue?, centerLabel?, legend = true, valueFormat?}` ·
  `Heatmap {rows, cols, values: (number|null)[][], valueFormat?, max?, cellHeight = 34, emptyLabel?}` ·
  `Sparkline {values, width = 120, height = 32, color?, area = true}` ·
  `Funnel {stages: {label, value}[], valueFormat?, onSelect?}` ·
  `Gauge {value, min = 0, max = 100, label?, size = 160, thresholds?: {warn, bad, higherIsBetter?}, format?}` ·
  helpers `Legend`, `seriesColor(i)`, `safeColor`, `niceTicks`. Colours from data must pass `safeColor`.
- **`FormRenderer`** `{fields: FieldDef[], value, onChange(next), readOnly?, disabled?, errors?,
  aiDraft? (step.ai_draft: matching fields get an "AI draft" badge + violet ring), columns: 1|2}` —
  all 13 field types incl. user/users/team pickers from the store, list editor, markdown with
  preview, ✨ on long text. Helpers: `initialFormValue(fields, current)`, `validateForm(fields, value)
  → {key: msg}`, `normalizeFormValue(fields, value)` (call before sending), `isEmptyValue`.
- **`AiRewrite`** `{value, onChange(text), disabled?, size: 'xs'|'sm'}` — ✨ menu of the 9
  `RewriteStyle`s + free instructions; replaces the text with an Undo (inline and in the toast).
- **`StepIcon`** `{type, status?, size: 'sm'|'md'|'lg'}` (type tile + status corner glyph; running =
  `ring-ai`), `StepStatusIcon {status, size?}`, `iconByName(name, fallback?)`, `stepTypeIcon(type)`,
  `ICONS`, `BLUEPRINT_ICONS` (icon picker list for blueprints).
- **`PipelineStrip`** `{project? | summary?, showLabel = true, size: 'sm'|'md'}` — one segment per
  stage (exact from a `Project`; from the blueprint + current stage for a `ProjectSummary`).
  `activeTone(statuses)`: rose failure > amber needs a person > sky running.
- Shell pieces (already mounted, reuse if useful): `Sidebar`, `LogoTile {size}`, `Wordmark`,
  `LiveDot {status}`, `Header`, `NotificationBell`, `PersonaSwitcher {compact?}`, `CommandPalette`.

## Checks

```
npm run typecheck      # strict TS, zero errors
npm run build          # tsc -b && vite build
npm test               # node:test via esbuild — api mapping, lib, markdown liveness, forms
cd ../backend && .venv/bin/python -m pytest ../frontend/tests/test_types_mirror.py -q   # types.ts ⇄ models.py
```
