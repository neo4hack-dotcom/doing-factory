// Factory Floor (#/floor): the live view of the whole factory. One swimlane per blueprint with its
// stages as columns and every project as a token in its current stage; a stats bar on top and a
// "Live AI workers" ticker on the right. Data = the project list, then live `project.updated`
// patches; the ticker is seeded from the LLM-call log and audit events, then streams.
import { Factory, FolderPlus, PackagePlus, Radar } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api';
import { iconByName } from '../components/StepIcon';
import { Button, EmptyState, Skeleton, useBusy, useToast } from '../components/ui';
import { cls } from '../lib/cls';
import { plural } from '../lib/format';
import { usePageTitle } from '../lib/pageTitle';
import { navigate, paths } from '../lib/router';
import { useApp, useLive } from '../lib/store';
import { readStorage, writeStorage } from '../lib/storage';
import type { KpiStage, ProjectSummary } from '../types';
import { LiveDot } from '../components/Sidebar';
import { LiveTicker, TICKER_MAX, fromEvent, fromLlmCall, fromTrace, type TickerItem } from './floor/LiveTicker';
import { buildLanes, callsPerMinute, emptyLane, floorStats, upsertSummary } from './floor/model';
import { StatsBar } from './floor/StatsBar';
import { Swimlane } from './floor/Swimlane';

const BLUEPRINT_KEY = 'factory.floor.blueprint';
/** How long a token that just changed stage keeps its highlight. */
const MOVED_MS = 2600;

export default function Floor() {
  usePageTitle('Factory Floor');
  const { blueprints, onboarding, reload, live } = useApp();
  const toast = useToast();
  const [busy, run] = useBusy();

  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState('');
  const [stageKpis, setStageKpis] = useState<KpiStage[]>([]);
  const [selected, setSelected] = useState(() => readStorage(BLUEPRINT_KEY) ?? '');
  const [ticker, setTicker] = useState<TickerItem[]>([]);
  const [paused, setPaused] = useState(false);
  const buffer = useRef<TickerItem[]>([]);
  const [callTimes, setCallTimes] = useState<number[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const [moved, setMoved] = useState<ReadonlySet<string>>(new Set());
  const stageOf = useRef(new Map<string, string>());
  const traceSeq = useRef(0);

  // ---- Loading ------------------------------------------------------------------------------
  const load = useCallback(async () => {
    try {
      const list = await api.projects.list();
      list.forEach((p) => stageOf.current.set(p.id, columnOf(p)));
      setProjects(list);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void load();
    // Secondary data: the floor works without it (stage timings show "—", the ticker starts empty).
    api.kpis(30).then((k) => setStageKpis(k.stages)).catch(() => undefined);
    Promise.all([
      api.admin.llmCalls(1).catch(() => []),
      api.events.list({ limit: 25 }).catch(() => []),
    ]).then(([calls, events]) => {
      setCallTimes(calls.map((c) => Date.parse(c.ts)).filter(Number.isFinite));
      const recentCalls = [...calls].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 25).map(fromLlmCall);
      const seeded = [...recentCalls, ...events.map(fromEvent)].sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, TICKER_MAX);
      setTicker((cur) => mergeTicker(cur, seeded));
    });
  }, [load]);

  // The "calls / min" figure and the shipped window age with the clock, not only with events.
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 5000);
    return () => clearInterval(t);
  }, []);

  // ---- Live ---------------------------------------------------------------------------------
  const markMoved = useCallback((id: string) => {
    setMoved((cur) => new Set(cur).add(id));
    setTimeout(() => setMoved((cur) => {
      const next = new Set(cur);
      next.delete(id);
      return next;
    }), MOVED_MS);
  }, []);

  useLive('project.updated', (e) => {
    const where = columnOf(e.summary);
    const before = stageOf.current.get(e.project_id);
    stageOf.current.set(e.project_id, where);
    if (before !== undefined && before !== where) markMoved(e.project_id);
    setProjects((cur) => (cur ? upsertSummary(cur, e.summary) : cur));
  });
  useLive('project.deleted', (e) => setProjects((cur) => cur?.filter((p) => p.id !== e.project_id) ?? cur));

  const push = (item: TickerItem) => {
    if (paused) {
      buffer.current = [item, ...buffer.current].slice(0, TICKER_MAX);
      return;
    }
    setTicker((cur) => [item, ...cur.filter((i) => i.id !== item.id)].slice(0, TICKER_MAX));
  };
  useLive('llm.call', (e) => {
    setCallTimes((cur) => [...cur.filter((t) => Date.now() - t < 31 * 60_000), Date.parse(e.call.ts) || Date.now()]);
    push(fromLlmCall(e.call));
  });
  useLive('step.trace', (e) => push(fromTrace(e.project_id, e.step_id, e.entry, ++traceSeq.current)));
  useLive('activity', (e) => push(fromEvent(e.event)));

  const togglePause = () => {
    if (paused && buffer.current.length) {
      const pending = buffer.current;
      buffer.current = [];
      setTicker((cur) => mergeTicker(cur, pending));
    }
    setPaused(!paused);
  };

  // ---- Derived ------------------------------------------------------------------------------
  const lanes = useMemo(() => buildLanes(projects ?? [], blueprints, stageKpis, now), [projects, blueprints, stageKpis, now]);
  const stats = useMemo(() => floorStats(projects ?? []), [projects]);
  const llmTrend = useMemo(() => callsPerMinute(callTimes, now), [callTimes, now]);
  const keyById = useMemo(() => new Map((projects ?? []).map((p) => [p.id, p.key])), [projects]);

  const selectedBp = blueprints.find((b) => b.id === selected) ?? null;
  const visibleLanes = selectedBp
    ? [lanes.find((l) => l.key === selectedBp.id) ?? emptyLane(selectedBp, stageKpis)]
    : lanes;
  const idleBlueprints = blueprints.filter((b) => b.status === 'active' && !lanes.some((l) => l.key === b.id));
  const choose = (id: string) => {
    setSelected(id);
    writeStorage(BLUEPRINT_KEY, id || null);
  };

  const installDemo = () => run('demo', async () => {
    const res = await api.admin.installDemo();
    await reload();
    const c = res.created;
    toast.success(`Demo environment ready — ${plural(c.connectors, 'connector')}, ${plural(c.operations, 'operation')}, ${plural(c.watchers, 'watcher')}.`, {
      action: { label: 'Open Intake', onClick: () => navigate(paths.intake()) },
    });
  });

  // ---- Render -------------------------------------------------------------------------------
  const header = (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div>
        <div className="label-xs mb-1.5 flex items-center gap-1.5"><Factory size={12} className="text-brand-500" /> Live</div>
        <h1 className="flex items-center gap-3 text-2xl font-bold tracking-tight text-zinc-900 sm:text-[1.7rem] dark:text-white">
          <span>Factory Floor</span>
          <span className="flex items-center gap-1.5 rounded-full border hairline px-2 py-0.5 text-[11px] font-semibold text-muted">
            <LiveDot status={live} /> {live === 'open' ? 'Live' : live === 'connecting' ? 'Connecting…' : 'Offline'}
          </span>
        </h1>
        <p className="mt-1.5 max-w-2xl text-sm text-muted">Every project as a token in its current stage — watch work flow, see who it waits on, and what the AI is doing right now.</p>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" size="sm" icon={Radar} onClick={() => navigate(paths.intake())}>Intake</Button>
        <Button size="sm" icon={FolderPlus} onClick={() => navigate(paths.newProject())}>New project</Button>
      </div>
    </div>
  );

  if (error && !projects) {
    return (
      <>
        {header}
        <EmptyState icon={Factory} title="The floor could not load" description={error} action={<Button onClick={() => void load()}>Retry</Button>} />
      </>
    );
  }

  if (projects && projects.length === 0) {
    return (
      <>
        {header}
        <EmptyState
          icon={Factory}
          title="The floor is quiet — no project yet"
          description={onboarding?.demo_installed
            ? 'The demo environment is installed. Accept a detected use case in Intake (or simulate a sponsor creating one) and watch it travel through the stages here.'
            : 'Install the sandbox demo environment (DOINg.AI + Jira MCP servers, a team, operations and a watcher) or start a project by hand.'}
          action={(
            <>
              {!onboarding?.demo_installed && <Button variant="ai" icon={PackagePlus} busy={busy === 'demo'} onClick={installDemo}>Install demo environment</Button>}
              {onboarding?.demo_installed && <Button variant="ai" icon={Radar} onClick={() => navigate(paths.intake())}>Open Intake</Button>}
              <Button variant="outline" icon={FolderPlus} onClick={() => navigate(paths.newProject())}>New project</Button>
            </>
          )}
        />
      </>
    );
  }

  return (
    <>
      {header}
      {projects
        ? <StatsBar stats={stats} llmPerMinute={llmTrend[llmTrend.length - 1] ?? 0} llmTrend={llmTrend} />
        : <Skeleton className="h-[68px] w-full rounded-xl" />}

      <div className="no-scrollbar mt-4 flex items-center gap-1.5 overflow-x-auto pb-1" role="tablist" aria-label="Blueprint">
        <BlueprintPill active={!selectedBp} onClick={() => choose('')} label="All blueprints" count={stats.inFlight} />
        {blueprints.filter((b) => b.status !== 'archived' || lanes.some((l) => l.key === b.id)).map((b) => (
          <BlueprintPill
            key={b.id}
            active={selectedBp?.id === b.id}
            onClick={() => choose(b.id)}
            label={b.name}
            icon={b.icon}
            count={lanes.find((l) => l.key === b.id)?.inFlight ?? 0}
          />
        ))}
      </div>

      <div className="mt-3 grid gap-4 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-4">
          {!projects && [0, 1].map((i) => <Skeleton key={i} className="h-64 w-full rounded-xl" />)}
          {projects && visibleLanes.map((lane) => <Swimlane key={lane.key} lane={lane} moved={moved} />)}
          {projects && !selectedBp && visibleLanes.length === 0 && (
            <EmptyState compact icon={Factory} title="Nothing in flight" description="Every project is finished. Start a new one or accept a detected use case." />
          )}
          {projects && !selectedBp && idleBlueprints.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
              <span className="label-xs mr-1">Idle blueprints</span>
              {idleBlueprints.map((b) => (
                <button key={b.id} type="button" onClick={() => choose(b.id)} className="rounded-md border hairline px-2 py-0.5 font-medium transition-colors hover:border-brand-500/60 hover:text-brand-600 dark:hover:text-brand-400">
                  {b.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <LiveTicker
          items={ticker}
          paused={paused}
          onTogglePause={togglePause}
          projectKey={(id) => keyById.get(id) ?? ''}
          live={live === 'open'}
        />
      </div>
    </>
  );
}

function BlueprintPill({ active, onClick, label, icon, count }: {
  active: boolean; onClick: () => void; label: string; icon?: string; count: number;
}) {
  const Icon = icon ? iconByName(icon) : Factory;
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cls(
        'inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-semibold transition-colors',
        active
          ? 'border-brand-500 bg-brand-500 text-white shadow-brand'
          : 'hairline bg-white text-zinc-600 hover:border-brand-500/60 hover:text-brand-600 dark:bg-ink-800 dark:text-zinc-300 dark:hover:text-brand-400',
      )}
    >
      <Icon size={13} />
      {label}
      <span className={cls('num rounded-full px-1.5 text-[10px]', active ? 'bg-white/25' : 'bg-zinc-100 dark:bg-ink-600')}>{count}</span>
    </button>
  );
}

/** The column a token sits in: its stage, or Shipped once done (a change = a visible move). */
function columnOf(p: ProjectSummary): string {
  return p.status === 'done' ? 'shipped' : p.current_stage_id;
}

/** Merges two newest-first lists without duplicates. */
function mergeTicker(a: TickerItem[], b: TickerItem[]): TickerItem[] {
  const seen = new Set<string>();
  return [...a, ...b]
    .filter((i) => (seen.has(i.id) ? false : (seen.add(i.id), true)))
    .sort((x, y) => y.ts.localeCompare(x.ts))
    .slice(0, TICKER_MAX);
}
