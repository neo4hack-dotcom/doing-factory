// Portfolio: every project in one place, as a table, a status board or the fan-out tree.
//
// The URL is the state (#/projects?view=board&group=people&blueprint=…&mine=1), so any filtered
// view can be bookmarked or linked from a KPI tile; filter changes replace the history entry.
// The list is fetched with the server-side filters (blueprint, search, "mine") and every filter is
// re-applied client-side, so a live `project.updated` patch that no longer matches drops out.
import {
  ArrowDownWideNarrow, ArrowUpNarrowWide, FolderKanban, FolderTree, KanbanSquare, Plus, Radar, RefreshCw, Rows3, Search,
  ServerCrash, SlidersHorizontal, UserRound, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { Button, EmptyState, IconButton, Input, Select, Skeleton, TONE, Tooltip } from '../components/ui';
import { cls } from '../lib/cls';
import { plural } from '../lib/format';
import { navigate, paths } from '../lib/router';
import { PRIORITY } from '../lib/status';
import { readStorage, writeStorage } from '../lib/storage';
import { useApp, useLive } from '../lib/store';
import type { ProjectSummary } from '../types';
import {
  activeFilterCount, GROUP_META, GROUP_ORDER, matchesPortfolio, NATURAL_DIR, parsePortfolioQuery,
  portfolioQueryToParams, sortSummaries, statusGroup, upsertSummary,
} from './project/model';
import type { PortfolioQuery, PortfolioView, SortKey } from './project/model';
import { PortfolioBoard } from './project/PortfolioBoard';
import { PortfolioTable } from './project/PortfolioTable';
import { PortfolioTree } from './project/PortfolioTree';

export interface ProjectsProps {
  /** URL query filters (#/projects?status=active&blueprint_id=…). */
  query: Record<string, string>;
}

/** The last view used, remembered per browser when the URL does not name one. */
const VIEW_STORAGE_KEY = 'factory.projects.view';

const VIEW_TABS: Array<{ key: PortfolioView; label: string; icon: LucideIcon }> = [
  { key: 'table', label: 'Table', icon: Rows3 },
  { key: 'board', label: 'Board', icon: KanbanSquare },
  { key: 'tree', label: 'Tree', icon: FolderTree },
];

const SORT_LABELS: Record<SortKey, string> = {
  updated: 'Last updated', created: 'Newest', priority: 'Priority', risk: 'Risk score', due: 'Due date',
  progress: 'Progress', key: 'Key', title: 'Title',
};

const STATUS_OPTIONS = [
  { value: 'open', label: 'Open (not finished)' },
  { value: 'active', label: 'Active' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'blocked', label: 'Blocked' },
  { value: 'failed', label: 'Failed' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
];

const RISK_OPTIONS = [
  { value: 'at_risk', label: 'At risk (medium + high)' },
  { value: 'high', label: 'High risk' },
  { value: 'medium', label: 'Medium risk' },
  { value: 'low', label: 'Low risk' },
];

export default function Projects({ query }: ProjectsProps) {
  const { blueprints, blueprintById, userId } = useApp();
  const storedView = readStorage(VIEW_STORAGE_KEY);
  const q = parsePortfolioQuery(query, storedView === 'board' || storedView === 'tree' ? storedView : 'table');

  const setQuery = useCallback((patch: Partial<PortfolioQuery>) => {
    const next = { ...parsePortfolioQuery(query, q.view), ...patch };
    navigate(paths.projects(portfolioQueryToParams(next)), { replace: true });
  }, [query, q.view]);

  // ---- Search box: typed locally, pushed to the URL after a short pause -------------------------
  const [search, setSearch] = useState(q.q);
  useEffect(() => setSearch(q.q), [q.q]);
  useEffect(() => {
    if (search === q.q) return;
    const t = setTimeout(() => setQuery({ q: search }), 280);
    return () => clearTimeout(t);
  }, [search, q.q, setQuery]);

  // ---- Data -------------------------------------------------------------------------------------
  const serverFilters = useMemo(() => ({
    blueprint_id: q.blueprint || undefined,
    q: q.q.trim() || undefined,
    user_id: q.mine ? userId : undefined,
  }), [q.blueprint, q.q, q.mine, userId]);
  const [list, setList] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState('');
  const [reloading, setReloading] = useState(false);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    setReloading(true);
    try {
      const rows = await api.projects.list(serverFilters);
      if (seq !== loadSeq.current) return;   // a newer filter won the race
      setList(rows);
      setError('');
    } catch (err) {
      if (seq === loadSeq.current) setError(errorMessage(err));
    } finally {
      if (seq === loadSeq.current) setReloading(false);
    }
  }, [serverFilters]);

  useEffect(() => {
    void load();
  }, [load]);

  // A project we do not know yet, while a server-side filter we cannot re-check (search, mine) is
  // active, means a refetch; otherwise the event's summary is enough.
  const refetchTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(refetchTimer.current), []);
  useLive('project.updated', (e) => {
    if (!e.summary) return;
    setList((prev) => {
      if (!prev) return prev;
      const known = prev.some((s) => s.id === e.project_id);
      if (!known && (serverFilters.q || serverFilters.user_id)) {
        clearTimeout(refetchTimer.current);
        refetchTimer.current = setTimeout(() => void load(), 600);
        return prev;
      }
      return upsertSummary(prev, e.summary);
    });
  });
  useLive('project.deleted', (e) => setList((prev) => prev?.filter((s) => s.id !== e.project_id) ?? prev));

  // ---- Derived ----------------------------------------------------------------------------------
  // The text search already ran on the server (which also searches descriptions): not re-applied.
  const clientQuery = useMemo(() => ({ ...q, q: '' }), [q]);
  const visible = useMemo(
    () => sortSummaries((list ?? []).filter((s) => matchesPortfolio(s, clientQuery)), q.sort, q.dir),
    [list, clientQuery, q.sort, q.dir],
  );
  const groupCounts = useMemo(() => {
    const base = (list ?? []).filter((s) => matchesPortfolio(s, { ...clientQuery, group: '' }));
    const counts = { all: base.length, active: 0, people: 0, blocked: 0, done: 0 };
    for (const s of base) counts[statusGroup(s)] += 1;
    return counts;
  }, [list, clientQuery]);

  const filterCount = activeFilterCount(q);
  const selectedBlueprint = q.blueprint ? blueprintById(q.blueprint) : null;
  const activeBlueprints = blueprints.filter((b) => b.status !== 'archived' || b.id === q.blueprint);

  const setView = (view: PortfolioView) => {
    writeStorage(VIEW_STORAGE_KEY, view);
    setQuery({ view });
  };
  const onSort = (key: SortKey) => {
    setQuery(q.sort === key ? { sort: key, dir: q.dir === 'asc' ? 'desc' : 'asc' } : { sort: key, dir: NATURAL_DIR[key] });
  };
  const clearFilters = () => {
    setSearch('');
    navigate(paths.projects(portfolioQueryToParams({ ...parsePortfolioQuery({}, q.view), view: q.view })), { replace: true });
  };

  const total = list?.length ?? 0;
  const inFlight = groupCounts.active + groupCounts.people + groupCounts.blocked;

  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <div className="label-xs mb-1.5 flex items-center gap-1.5"><FolderKanban size={12} className="text-brand-500" />Projects</div>
          <h1 className="text-2xl font-bold tracking-tight text-zinc-900 sm:text-[1.7rem] sm:leading-tight dark:text-white">Portfolio</h1>
          <p className="mt-1.5 max-w-2xl text-sm text-muted">
            {list === null ? 'Loading the portfolio…' : total === 0 && !filterCount && !q.q
              ? 'Every use case and delivery the Factory runs, from detection to go-live.'
              : `${plural(visible.length, 'project')} shown · ${inFlight} in flight · ${groupCounts.people} waiting on people · ${groupCounts.blocked} blocked`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <IconButton icon={RefreshCw} label="Refresh" variant="outline" busy={reloading && list !== null} onClick={() => void load()} />
          <Button icon={Plus} onClick={() => navigate(paths.newProject(q.blueprint || undefined))}>New project</Button>
        </div>
      </div>

      {/* Filters */}
      <div className="card mb-4 p-3">
        <div className="flex flex-wrap items-center gap-2">
          <Input
            icon={Search}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape' && search) {
                e.stopPropagation();
                setSearch('');
              }
            }}
            placeholder="Search key, title, tag…"
            aria-label="Search projects"
            className="w-full sm:w-60"
          />
          <Select aria-label="Status" value={q.status} placeholder="Any status" options={STATUS_OPTIONS}
            onChange={(e) => setQuery({ status: e.target.value as PortfolioQuery['status'] })} className="w-auto min-w-[9.5rem]" />
          <Select aria-label="Blueprint" value={q.blueprint} placeholder="All blueprints"
            options={activeBlueprints.map((b) => ({ value: b.id, label: b.name }))}
            onChange={(e) => setQuery({ blueprint: e.target.value })} className="w-auto min-w-[10rem]" />
          <Select aria-label="Priority" value={q.priority} placeholder="Any priority"
            options={(Object.keys(PRIORITY) as Array<keyof typeof PRIORITY>).reverse().map((p) => ({ value: p, label: `${PRIORITY[p].label} priority` }))}
            onChange={(e) => setQuery({ priority: e.target.value })} className="w-auto min-w-[9rem]" />
          <Select aria-label="Risk" value={q.risk} placeholder="Any risk" options={RISK_OPTIONS}
            onChange={(e) => setQuery({ risk: e.target.value as PortfolioQuery['risk'] })} className="w-auto min-w-[8.5rem]" />
          <button
            type="button"
            aria-pressed={q.mine}
            onClick={() => setQuery({ mine: !q.mine })}
            className={cls(
              'inline-flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-colors',
              q.mine ? 'border-brand-500 bg-brand-500/10 text-brand-700 dark:text-brand-300'
                : 'border-zinc-300 text-zinc-600 hover:border-zinc-400 dark:border-ink-500 dark:text-zinc-300',
            )}
            title="Projects I sponsor, own, or have a step assigned to"
          >
            <UserRound size={14} /> Mine
          </button>
          <div className="flex items-center gap-1">
            <Select aria-label="Sort by" value={q.sort} onChange={(e) => {
              const key = e.target.value as SortKey;
              setQuery({ sort: key, dir: NATURAL_DIR[key] });
            }} options={(Object.keys(SORT_LABELS) as SortKey[]).map((k) => ({ value: k, label: `Sort: ${SORT_LABELS[k]}` }))} className="w-auto min-w-[10rem]" />
            <IconButton icon={q.dir === 'asc' ? ArrowUpNarrowWide : ArrowDownWideNarrow} label={q.dir === 'asc' ? 'Ascending — click for descending' : 'Descending — click for ascending'}
              variant="outline" onClick={() => setQuery({ dir: q.dir === 'asc' ? 'desc' : 'asc' })} />
          </div>
          <div className="ml-auto flex rounded-lg border border-zinc-300 p-0.5 dark:border-ink-500" role="tablist" aria-label="View">
            {VIEW_TABS.map(({ key, label, icon: Icon }) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={q.view === key}
                onClick={() => setView(key)}
                className={cls(
                  'inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold transition-colors',
                  q.view === key ? 'bg-zinc-900 text-white dark:bg-white dark:text-ink-900' : 'text-zinc-600 hover:text-zinc-900 dark:text-zinc-300 dark:hover:text-white',
                )}
              >
                <Icon size={13} />{label}
              </button>
            ))}
          </div>
        </div>

        {/* Quick status groups with counts */}
        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t hairline pt-3">
          <GroupChip label="All" count={groupCounts.all} active={!q.group} onClick={() => setQuery({ group: '' })} />
          {GROUP_ORDER.map((g) => (
            <Tooltip key={g} content={GROUP_META[g].hint}>
              <GroupChip label={GROUP_META[g].label} count={groupCounts[g]} tone={GROUP_META[g].tone} active={q.group === g}
                onClick={() => setQuery({ group: q.group === g ? '' : g })} />
            </Tooltip>
          ))}
          {(filterCount > 0 || q.q) && (
            <button type="button" onClick={clearFilters} className="ml-auto inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:underline dark:text-brand-400">
              <X size={12} /> Clear filters{filterCount > 0 ? ` (${filterCount + (q.q ? 1 : 0)})` : ''}
            </button>
          )}
        </div>
      </div>

      {/* Body */}
      {error && list === null ? (
        <EmptyState icon={ServerCrash} title="The portfolio could not be loaded" description={error}
          action={<Button variant="outline" icon={RefreshCw} onClick={() => void load()}>Retry</Button>} />
      ) : list === null ? (
        <PortfolioSkeleton />
      ) : total === 0 && filterCount === 0 && !q.q ? (
        <EmptyState
          icon={FolderKanban}
          title="No projects yet"
          description="Start one from a blueprint, or accept a use case the watchers detected in DOINg.AI."
          action={<>
            <Button icon={Plus} onClick={() => navigate(paths.newProject())}>New project</Button>
            <Button variant="outline" icon={Radar} onClick={() => navigate(paths.intake())}>Open Intake</Button>
          </>}
        />
      ) : visible.length === 0 ? (
        <EmptyState compact icon={SlidersHorizontal} title="No project matches these filters"
          description={q.mine ? 'Nothing is assigned to, sponsored or owned by the current persona with these filters.' : 'Loosen a filter or clear them all.'}
          action={<Button variant="outline" size="sm" icon={X} onClick={clearFilters}>Clear filters</Button>} />
      ) : (
        <div className="animate-fade-in">
          {error && <p className="mb-2 text-xs text-rose-600 dark:text-rose-400">Refresh failed: {error}</p>}
          {q.view === 'board' ? (
            <PortfolioBoard items={visible} blueprint={selectedBlueprint} />
          ) : q.view === 'tree' ? (
            <PortfolioTree items={visible} />
          ) : (
            <>
              <PortfolioTable items={visible} sort={q.sort} dir={q.dir} onSort={onSort} />
              <p className="mt-2 hidden text-right text-[11px] text-faint sm:block">
                <kbd className="font-sans font-semibold">j</kbd>/<kbd className="font-sans font-semibold">k</kbd> to move · Enter to open
              </p>
            </>
          )}
        </div>
      )}
    </>
  );
}

function GroupChip({ label, count, active, tone, onClick }: {
  label: string; count: number; active: boolean; tone?: 'sky' | 'amber' | 'rose' | 'emerald'; onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={cls(
        'inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs font-semibold transition-colors',
        active ? 'border-zinc-900 bg-zinc-900 text-white dark:border-white dark:bg-white dark:text-ink-900'
          : 'border-zinc-200 text-zinc-600 hover:border-zinc-400 dark:border-ink-500 dark:text-zinc-300 dark:hover:border-ink-400',
      )}
    >
      {tone && <span className={cls('h-1.5 w-1.5 rounded-full', TONE[tone].dot)} />}
      {label}
      <span className={cls('num rounded-full px-1.5 text-[10px]', active ? 'bg-white/20 dark:bg-ink-900/10' : 'bg-zinc-100 dark:bg-ink-600')}>{count}</span>
    </button>
  );
}

function PortfolioSkeleton() {
  return (
    <div className="card divide-y divide-zinc-100 dark:divide-ink-600">
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex items-center gap-4 px-4 py-3.5">
          <Skeleton className="h-4 w-16" />
          <div className="flex-1 space-y-2"><Skeleton className="h-4 w-1/2" /><Skeleton className="h-3 w-1/4" /></div>
          <Skeleton className="h-2 w-40" />
          <Skeleton className="h-5 w-14" />
        </div>
      ))}
    </div>
  );
}
