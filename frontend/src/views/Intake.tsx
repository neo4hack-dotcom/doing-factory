// Intake (#/intake): what the watchers detected, with the AI's triage suggestion. Accept starts a
// project (the suggestion pre-fills editable overrides), Dismiss records a reason. The watcher strip
// on top shows each watcher's last/next run with "Run now"; with a sandbox connector installed, a
// sponsor can be simulated end to end (the LLM registers a use case in the sandbox DOINg.AI, then
// the watcher detects it). Live: `intake.updated` and `watcher.updated` patch the lists.
import {
  AlertTriangle, Braces, CheckCircle2, ChevronDown, ExternalLink, FolderOpen, Play, Radar, RefreshCw, Search,
  Settings2, Sparkles, Wand2, X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react';
import { api } from '../api';
import {
  Avatar, Badge, Button, Card, EmptyState, Field, IconButton, Input, Popover, Select, Skeleton, StatusBadge, Tabs,
  Tooltip, useBusy, useConfirmReason, useToast,
} from '../components/ui';
import { cls } from '../lib/cls';
import { formatDateTime, plural, timeAgo } from '../lib/format';
import { usePageTitle } from '../lib/pageTitle';
import { Link, navigate, paths } from '../lib/router';
import { PRIORITY } from '../lib/status';
import { useApp, useLive } from '../lib/store';
import type { IntakeItem, IntakeStatus, Priority, Tone, Watcher } from '../types';

const TAB_ORDER: IntakeStatus[] = ['new', 'accepted', 'dismissed'];
const CONFIDENCE_TONE: Record<string, Tone> = { high: 'emerald', medium: 'amber', low: 'rose' };

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id);
  if (i === -1) return [item, ...list];
  const next = list.slice();
  next[i] = item;
  return next;
}

export default function Intake() {
  usePageTitle('Intake');
  const { connectors, operations } = useApp();
  const toast = useToast();
  const [busy, run] = useBusy();
  const [items, setItems] = useState<IntakeItem[] | null>(null);
  const [watchers, setWatchers] = useState<Watcher[] | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<IntakeStatus>('new');
  const [query, setQuery] = useState('');

  const loadItems = useCallback(async () => {
    try {
      setItems(await api.intake.list());
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);
  const loadWatchers = useCallback(async () => {
    try {
      setWatchers(await api.watchers.list());
    } catch {
      setWatchers((w) => w ?? []);
    }
  }, []);
  useEffect(() => {
    void loadItems();
    void loadWatchers();
  }, [loadItems, loadWatchers]);

  useLive('intake.updated', (e) => setItems((cur) => (cur ? upsert(cur, e.item) : cur)));
  useLive('watcher.updated', (e) => setWatchers((cur) => (cur ? upsert(cur, e.watcher) : cur)));

  const counts = useMemo(() => {
    const c: Record<IntakeStatus, number> = { new: 0, accepted: 0, dismissed: 0 };
    (items ?? []).forEach((i) => { c[i.status] += 1; });
    return c;
  }, [items]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (items ?? []).filter((i) => i.status === tab
      && (!q || `${i.title} ${i.external_id} ${i.watcher_name} ${i.suggestion?.summary ?? ''}`.toLowerCase().includes(q)));
  }, [items, tab, query]);

  // A sandbox portfolio connector makes the "simulate a sponsor" demo possible.
  const sandbox = connectors.find((c) => c.sandbox && c.kind === 'portfolio') ?? null;
  const sandboxWatchers = (watchers ?? []).filter((w) => {
    const op = operations.find((o) => o.key === w.operation_key);
    return w.enabled && !!sandbox && op?.connector_id === sandbox.id;
  });

  const runWatcher = async (w: Watcher) => {
    const res = await api.watchers.run(w.id);
    if (!res.ok) throw new Error(`${w.name}: ${res.error || 'the run failed'}`);
    return res;
  };

  const runNow = (w: Watcher) => run(`run:${w.id}`, async () => {
    const res = await runWatcher(w);
    toast[res.new ? 'success' : 'info'](`${w.name}: ${plural(res.new, 'new item')} (${res.total} scanned)`);
    setTab('new');
    await Promise.all([loadItems(), loadWatchers()]);
  });

  const simulate = () => run('simulate', async () => {
    const res = await api.admin.simulateUseCase();
    const name = String(res.use_case.name ?? res.use_case.title ?? 'A new use case');
    if (sandboxWatchers.length === 0) {
      toast.warn(`“${name}” was created in the DOINg.AI sandbox, but no enabled watcher polls it — enable one in Settings › Watchers.`);
      return;
    }
    let fresh = 0;
    for (const w of sandboxWatchers) fresh += (await runWatcher(w)).new;
    toast.success(`“${name}” registered by its sponsor in the DOINg.AI sandbox — ${plural(fresh, 'new item')} detected.`);
    setTab('new');
    await Promise.all([loadItems(), loadWatchers()]);
  });

  return (
    <>
      <div className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="label-xs mb-1.5 flex items-center gap-1.5"><Radar size={12} className="text-brand-500" /> Intake</div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900 sm:text-[1.7rem] sm:leading-tight dark:text-white">Detected items</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted">
            Use cases found by the watchers, triaged by the AI — accept to start a project with one click, or dismiss with a reason.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {sandbox && (
            <Tooltip content="The local LLM invents a realistic use case and registers it in the sandbox DOINg.AI, as a sponsor would; the watcher then detects it.">
              <Button variant="ai" icon={Wand2} busy={busy === 'simulate'} onClick={simulate}>
                {busy === 'simulate' ? 'Simulating a sponsor…' : 'Simulate a sponsor creating a use case'}
              </Button>
            </Tooltip>
          )}
          <IconButton icon={RefreshCw} label="Refresh" variant="outline" onClick={() => { void loadItems(); void loadWatchers(); }} />
        </div>
      </div>

      <WatcherStrip watchers={watchers} busy={busy} onRun={runNow} />

      <div className="mt-6 flex flex-wrap items-end justify-between gap-3">
        <Tabs
          value={tab}
          onChange={setTab}
          tabs={TAB_ORDER.map((s) => ({ key: s, label: s === 'new' ? 'New' : s === 'accepted' ? 'Accepted' : 'Dismissed', count: counts[s] }))}
        />
        <Input icon={Search} placeholder="Filter detected items…" value={query} onChange={(e) => setQuery(e.target.value)} className="w-64 max-w-full" />
      </div>

      <div className="mt-4 space-y-3">
        {error && !items && (
          <EmptyState icon={AlertTriangle} title="Intake could not load" description={error} action={<Button onClick={() => void loadItems()}>Retry</Button>} />
        )}
        {!items && !error && [0, 1, 2].map((i) => <Skeleton key={i} className="h-40 w-full rounded-xl" />)}
        {items && shown.length === 0 && (
          <EmptyState
            icon={Radar}
            title={query ? 'No item matches this filter' : tab === 'new' ? 'Nothing waiting for triage' : `No ${tab} item yet`}
            description={tab === 'new' && !query
              ? (watchers && watchers.length === 0
                ? 'No watcher is configured. A watcher polls an MCP operation (e.g. DOINg.AI “new use cases”) and lands what it finds here.'
                : 'Watchers poll on their schedule — run one now to check immediately.')
              : undefined}
            action={tab === 'new' && !query ? (
              <>
                {sandbox && <Button variant="ai" icon={Wand2} busy={busy === 'simulate'} onClick={simulate}>Simulate a sponsor</Button>}
                <Button variant="outline" icon={Settings2} onClick={() => navigate(paths.settings('watchers'))}>Configure watchers</Button>
              </>
            ) : undefined}
          />
        )}
        {shown.map((item) => (
          <IntakeCard key={item.id} item={item} onChange={(next) => setItems((cur) => (cur ? upsert(cur, next) : cur))} />
        ))}
      </div>
    </>
  );
}

// ---- Watchers strip ---------------------------------------------------------------------------

function scheduleLabel(w: Watcher): string {
  const s = w.schedule;
  const every = s.every_minutes >= 60 && s.every_minutes % 60 === 0 ? `every ${s.every_minutes / 60} h` : `every ${s.every_minutes} min`;
  const hours = s.active_hours_start !== null && s.active_hours_start !== undefined && s.active_hours_end !== null && s.active_hours_end !== undefined
    ? ` · ${s.active_hours_start}:00–${s.active_hours_end}:00` : '';
  const days = s.days.length && s.days.length < 7 ? ` · ${s.days.map((d) => ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'][d] ?? d).join(' ')}` : '';
  return `${every}${hours}${days}`;
}

function WatcherStrip({ watchers, busy, onRun }: { watchers: Watcher[] | null; busy: string | null; onRun: (w: Watcher) => void }) {
  if (!watchers) return <Skeleton className="h-24 w-full rounded-xl" />;
  if (watchers.length === 0) {
    return (
      <Card padding="sm" className="flex flex-wrap items-center justify-between gap-3">
        <span className="flex items-center gap-2 text-sm text-muted"><Radar size={15} className="text-brand-500" /> No watcher yet — nothing is polled for new use cases.</span>
        <Link to={paths.settings('watchers')} className="text-sm font-semibold text-brand-600 hover:underline dark:text-brand-400">Add a watcher →</Link>
      </Card>
    );
  }
  return (
    <div className="no-scrollbar -mx-1 flex gap-3 overflow-x-auto px-1 pb-1">
      {watchers.map((w) => {
        const st = w.state;
        const failed = st.last_status === 'error';
        return (
          <Card key={w.id} padding="none" className={cls('w-[300px] shrink-0', !w.enabled && 'opacity-70')}>
            <div className="flex items-start justify-between gap-2 px-3.5 pt-3">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="relative flex h-2 w-2 shrink-0">
                    {w.enabled && !failed && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand-500 opacity-50" />}
                    <span className={cls('relative inline-flex h-2 w-2 rounded-full', !w.enabled ? 'bg-zinc-400' : failed ? 'bg-rose-500' : 'bg-brand-500')} />
                  </span>
                  <span className="truncate text-sm font-semibold text-zinc-900 dark:text-white">{w.name}</span>
                </div>
                <div className="mt-0.5 truncate text-[11px] text-muted">{w.enabled ? scheduleLabel(w) : 'Paused'} · {w.action === 'auto_start' ? 'auto-start' : 'to intake'}</div>
              </div>
              {st.last_new > 0 && <Badge tone="brand" size="xs"><span className="num">+{st.last_new}</span> new</Badge>}
            </div>
            <div className="grid grid-cols-3 gap-2 px-3.5 py-2.5 text-[11px]">
              <div>
                <div className="label-xs">Last run</div>
                <Tooltip content={failed ? st.last_error : st.last_run_at ? formatDateTime(st.last_run_at) : 'Never ran'}>
                  <span className={cls('mt-0.5 flex items-center gap-1 font-semibold', failed ? 'text-rose-600 dark:text-rose-400' : 'text-zinc-700 dark:text-zinc-200')}>
                    {failed ? <AlertTriangle size={11} /> : st.last_status === 'ok' ? <CheckCircle2 size={11} className="text-emerald-500" /> : null}
                    {st.last_run_at ? timeAgo(st.last_run_at) : 'never'}
                  </span>
                </Tooltip>
              </div>
              <div>
                <div className="label-xs">Next run</div>
                <div className="mt-0.5 font-semibold text-zinc-700 dark:text-zinc-200">{w.enabled && st.next_run_at ? timeAgo(st.next_run_at) : '—'}</div>
              </div>
              <div>
                <div className="label-xs">Detected</div>
                <div className="num mt-0.5 font-semibold text-zinc-700 dark:text-zinc-200">{st.new_total}</div>
              </div>
            </div>
            <div className="flex items-center justify-between gap-2 border-t hairline px-3.5 py-2">
              <Link to={paths.settings('watchers')} className="text-[11px] font-semibold text-muted hover:text-brand-600 dark:hover:text-brand-400">Configure</Link>
              <Button size="xs" variant="outline" icon={Play} busy={busy === `run:${w.id}`} onClick={() => onRun(w)}>Run now</Button>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ---- Intake card ------------------------------------------------------------------------------

function IntakeCard({ item, onChange }: { item: IntakeItem; onChange: (item: IntakeItem) => void }) {
  const { userById, userId } = useApp();
  const toast = useToast();
  const askReason = useConfirmReason();
  const [busy, run] = useBusy();
  const [raw, setRaw] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const acceptRef = useRef<HTMLButtonElement>(null);
  const s = item.suggestion;
  const decider = userById(item.decided_by);

  const analyze = () => run('analyze', async () => {
    onChange({ ...item, ai_busy: true, ai_error: '' });
    try {
      onChange(await api.intake.analyze(item.id));
    } catch (err) {
      onChange({ ...item, ai_busy: false });
      throw err;
    }
  });

  const dismiss = async () => {
    const reason = await askReason({
      title: `Dismiss “${item.title}”?`,
      message: 'The item leaves the intake queue; the watcher will not detect it again.',
      tone: 'warning',
      confirmLabel: 'Dismiss',
      reasonLabel: 'Reason',
      reasonPlaceholder: 'Duplicate of UC-0004, out of scope, not an AI use case…',
    });
    if (reason === null) return;
    await run('dismiss', async () => {
      onChange(await api.intake.dismiss(item.id, userId, reason));
      toast.info(`“${item.title}” dismissed.`);
    });
  };

  return (
    <Card padding="none" className="animate-fade-in overflow-hidden">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 pt-3.5">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted">
            <Badge tone="brand" size="xs" icon={Radar}>{item.watcher_name || 'Watcher'}</Badge>
            {item.external_id && <span className="num rounded bg-zinc-100 px-1.5 py-px font-semibold dark:bg-ink-600">{item.external_id}</span>}
            <Tooltip content={formatDateTime(item.detected_at)}><span>detected {timeAgo(item.detected_at)}</span></Tooltip>
            {item.status !== 'new' && <StatusBadge kind="intake" value={item.status} size="xs" />}
          </div>
          <h3 className="mt-1 text-base font-semibold leading-snug text-zinc-900 dark:text-white">{item.title}</h3>
        </div>
        {item.status === 'new' && (
          <div className="flex shrink-0 items-center gap-2">
            <Button variant="ghost" size="sm" icon={X} busy={busy === 'dismiss'} onClick={() => void dismiss()}>Dismiss</Button>
            <Button ref={acceptRef} size="sm" icon={CheckCircle2} disabled={!userId} title={userId ? undefined : 'Choose who you are acting as first'} onClick={() => setAccepting(true)}>
              Accept
            </Button>
            <AcceptPopover item={item} anchor={acceptRef} open={accepting} onClose={() => setAccepting(false)} />
          </div>
        )}
        {item.status === 'accepted' && item.project_id && (
          <Button size="sm" variant="outline" icon={FolderOpen} onClick={() => navigate(paths.project(item.project_id))}>Open project</Button>
        )}
      </div>

      {/* AI triage */}
      <div className="px-4 py-3">
        {item.ai_busy ? (
          <div className="rounded-lg border border-violet-500/20 bg-violet-50/50 p-3 dark:bg-violet-500/5">
            <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-violet-700 dark:text-violet-300">
              <Sparkles size={13} className="animate-pulse" /> The AI is triaging this use case…
            </div>
            <Skeleton lines={3} />
          </div>
        ) : s ? (
          <Suggestion item={item} onReanalyze={item.status === 'new' ? analyze : undefined} reanalyzing={busy === 'analyze'} />
        ) : item.status === 'new' ? (
          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-zinc-300 px-3 py-2.5 dark:border-ink-500">
            <span className="flex-1 text-xs text-muted">No triage yet — the AI can suggest a blueprint, priority, team, sponsor and the capabilities needed.</span>
            <Button variant="ai" size="sm" icon={Sparkles} busy={busy === 'analyze'} onClick={analyze}>Analyze with AI</Button>
          </div>
        ) : null}
        {item.ai_error && !item.ai_busy && (
          <div className="mt-2 flex items-start gap-2 rounded-lg border border-rose-500/25 bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
            <AlertTriangle size={14} className="mt-px shrink-0" />
            <span className="flex-1">AI triage failed: {item.ai_error}</span>
            {item.status === 'new' && <button type="button" onClick={analyze} className="shrink-0 font-semibold underline">Retry</button>}
          </div>
        )}
        {item.status === 'dismissed' && (
          <p className="mt-2 text-xs text-muted">
            Dismissed {decider ? `by ${decider.name} ` : ''}{timeAgo(item.decided_at)}{item.dismiss_reason ? ` — “${item.dismiss_reason}”` : ''}
          </p>
        )}
        {item.status === 'accepted' && (
          <p className="mt-2 text-xs text-muted">
            Accepted {decider ? `by ${decider.name} ` : ''}{timeAgo(item.decided_at)}
            {item.project_id && <> → <Link to={paths.project(item.project_id)} className="font-semibold text-brand-600 hover:underline dark:text-brand-400">project</Link></>}
          </p>
        )}
      </div>

      {/* Raw record */}
      <div className="border-t hairline">
        <button
          type="button"
          onClick={() => setRaw(!raw)}
          aria-expanded={raw}
          className="flex w-full items-center gap-1.5 px-4 py-2 text-[11px] font-semibold text-muted hover:text-zinc-800 dark:hover:text-zinc-200"
        >
          <Braces size={12} /> Raw record
          <ChevronDown size={12} className={cls('transition-transform', raw && 'rotate-180')} />
          {typeof item.raw.url === 'string' && /^https?:\/\//.test(item.raw.url) && (
            <a href={item.raw.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()} className="ml-auto inline-flex items-center gap-1 text-brand-600 hover:underline dark:text-brand-400">
              Source <ExternalLink size={11} />
            </a>
          )}
        </button>
        {raw && (
          <pre className="max-h-72 overflow-auto border-t hairline bg-zinc-50 px-4 py-3 font-mono text-[11px] leading-relaxed text-zinc-700 dark:bg-ink-900 dark:text-zinc-300">
            {JSON.stringify(item.raw, null, 2)}
          </pre>
        )}
      </div>
    </Card>
  );
}

function Suggestion({ item, onReanalyze, reanalyzing }: { item: IntakeItem; onReanalyze?: () => void; reanalyzing: boolean }) {
  const { userById, teamById, blueprintById } = useApp();
  const s = item.suggestion!;
  const bp = blueprintById(s.blueprint_id);
  const team = teamById(s.team_id);
  const sponsor = userById(s.sponsor_id);
  const owner = userById(s.owner_id);
  const priority = (s.priority in PRIORITY ? s.priority : '') as Priority | '';

  return (
    <div className="rounded-lg p-3 ring-ai">
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="flex items-center gap-1.5 text-xs font-semibold">
          <Sparkles size={13} className="text-violet-500" /> <span className="text-ai">AI triage</span>
          {s.confidence && <Badge tone={CONFIDENCE_TONE[s.confidence] ?? 'zinc'} size="xs">{s.confidence} confidence</Badge>}
        </span>
        {onReanalyze && <IconButton icon={RefreshCw} label="Analyze again" size="xs" busy={reanalyzing} onClick={onReanalyze} />}
      </div>
      {s.summary && <p className="text-sm leading-relaxed text-zinc-700 dark:text-zinc-200">{s.summary}</p>}
      <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2.5 text-xs sm:grid-cols-4">
        <Fact label="Blueprint">{bp ? bp.name : s.blueprint_id ? <span className="text-muted">{s.blueprint_id}</span> : '—'}</Fact>
        <Fact label="Priority">{priority ? <StatusBadge kind="priority" value={priority} size="xs" /> : '—'}</Fact>
        <Fact label="Team">{team?.name ?? '—'}</Fact>
        <Fact label="Sponsor">
          {sponsor ? <span className="flex items-center gap-1.5"><Avatar user={sponsor} size={18} />{sponsor.name}</span> : '—'}
        </Fact>
        {owner && (
          <Fact label="Owner"><span className="flex items-center gap-1.5"><Avatar user={owner} size={18} />{owner.name}</span></Fact>
        )}
      </dl>
      {s.required_capabilities.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-1">
          <span className="label-xs mr-1">Capabilities</span>
          {s.required_capabilities.map((c) => <Badge key={c} tone="violet" size="xs">{c}</Badge>)}
        </div>
      )}
      {s.rationale && <p className="mt-2.5 border-t hairline pt-2 text-xs italic leading-relaxed text-muted">{s.rationale}</p>}
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="label-xs">{label}</dt>
      <dd className="mt-0.5 truncate font-medium text-zinc-800 dark:text-zinc-100">{children}</dd>
    </div>
  );
}

// ---- Accept popover ---------------------------------------------------------------------------

function AcceptPopover({ item, anchor, open, onClose }: {
  item: IntakeItem; anchor: RefObject<HTMLButtonElement | null>; open: boolean; onClose: () => void;
}) {
  const { blueprints, users, teams, userId } = useApp();
  const toast = useToast();
  const [busy, run] = useBusy();
  const s = item.suggestion;
  const initial = useCallback(() => ({
    blueprint_id: s?.blueprint_id && blueprints.some((b) => b.id === s.blueprint_id) ? s.blueprint_id : '',
    title: item.title,
    priority: (s?.priority && s.priority in PRIORITY ? s.priority : '') as Priority | '',
    sponsor_id: s?.sponsor_id ?? '',
    owner_id: s?.owner_id ?? '',
    team_id: s?.team_id ?? '',
  }), [s, item.title, blueprints]);
  const [form, setForm] = useState(initial);
  useEffect(() => { if (open) setForm(initial()); }, [open, initial]);
  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) => setForm((f) => ({ ...f, [k]: v }));

  const people = users.filter((u) => u.active).map((u) => ({ value: u.id, label: u.title ? `${u.name} — ${u.title}` : u.name }));
  const accept = () => run('accept', async () => {
    const project = await api.intake.accept(item.id, userId, {
      blueprint_id: form.blueprint_id || undefined,
      title: form.title.trim() || undefined,
      priority: form.priority || undefined,
      sponsor_id: form.sponsor_id || undefined,
      owner_id: form.owner_id || undefined,
      team_id: form.team_id || undefined,
    });
    toast.success(`${project.key} started — ${project.title}`);
    onClose();
    navigate(paths.project(project.id));
  });

  return (
    <Popover anchor={anchor} open={open} onClose={onClose} align="right" width={380} className="p-0">
      <div className="border-b hairline px-4 py-3">
        <div className="text-sm font-semibold text-zinc-900 dark:text-white">Start a project</div>
        <div className="text-xs text-muted">{s ? 'Pre-filled from the AI suggestion — adjust anything.' : 'Empty fields fall back to the watcher’s mapping.'}</div>
      </div>
      <div className="space-y-3 px-4 py-3">
        <Field label="Blueprint" htmlFor={`bp-${item.id}`}>
          <Select
            id={`bp-${item.id}`}
            value={form.blueprint_id}
            onChange={(e) => set('blueprint_id', e.target.value)}
            placeholder="Watcher default"
            options={blueprints.filter((b) => b.status === 'active').map((b) => ({ value: b.id, label: b.name }))}
          />
        </Field>
        <Field label="Title" htmlFor={`title-${item.id}`}>
          <Input id={`title-${item.id}`} value={form.title} onChange={(e) => set('title', e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Priority">
            <Select
              value={form.priority}
              onChange={(e) => set('priority', e.target.value as Priority | '')}
              placeholder="From the record"
              options={(Object.keys(PRIORITY) as Priority[]).map((p) => ({ value: p, label: PRIORITY[p].label }))}
            />
          </Field>
          <Field label="Team">
            <Select value={form.team_id} onChange={(e) => set('team_id', e.target.value)} placeholder="None" options={teams.map((t) => ({ value: t.id, label: t.name }))} />
          </Field>
        </div>
        <Field label="Sponsor">
          <Select value={form.sponsor_id} onChange={(e) => set('sponsor_id', e.target.value)} placeholder="From the record" options={people} />
        </Field>
        <Field label="Owner">
          <Select value={form.owner_id} onChange={(e) => set('owner_id', e.target.value)} placeholder="Me (if I am a product manager)" options={people} />
        </Field>
      </div>
      <div className="flex items-center justify-end gap-2 border-t hairline px-4 py-2.5">
        <Button variant="ghost" size="sm" onClick={onClose}>Cancel</Button>
        <Button size="sm" icon={CheckCircle2} busy={busy === 'accept'} onClick={accept}>Accept & start</Button>
      </div>
    </Popover>
  );
}
