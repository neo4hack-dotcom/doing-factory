// Settings › Audit Log — the hash-chained activity trail. The badge re-walks the chain server-side
// (any edited or deleted event breaks it); the table pages backwards with `before` and prepends
// live events that match the filters.
import { Bot, ChevronDown, ChevronRight, Clock, Cog, Filter, RefreshCw, ScrollText, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { Avatar, Badge, Button, Card, EmptyState, IconButton, Select, Skeleton, Tooltip, useToast } from '../../components/ui';
import { cls } from '../../lib/cls';
import { formatDateTime, formatNumber, timeAgo } from '../../lib/format';
import { Link, paths } from '../../lib/router';
import { useApp, useLive } from '../../lib/store';
import type { ChainVerification, Event, ProjectSummary, Tone } from '../../types';
import { prettyJson } from './shared';

const PAGE = 50;

/** Kind filter: families (prefix ending in ".") and the most useful exact kinds. */
const KIND_OPTIONS = [
  { value: 'project.', label: 'Projects (all)' },
  { value: 'stage.', label: 'Stages (all)' },
  { value: 'step.', label: 'Steps (all)' },
  { value: 'approval.', label: 'Approvals' },
  { value: 'gate.', label: 'Quality gates' },
  { value: 'operation.executed', label: 'MCP operations' },
  { value: 'agent.tool_call', label: 'Agent tool calls' },
  { value: 'intake.', label: 'Intake' },
  { value: 'watcher.run', label: 'Watcher runs' },
  { value: 'notification.sent', label: 'Notifications sent' },
  { value: 'artifact.updated', label: 'Artifacts' },
  { value: 'comment.added', label: 'Comments' },
  { value: 'settings.updated', label: 'Settings & configuration' },
  { value: 'connector.tested', label: 'Connector tests' },
  { value: 'blueprint.saved', label: 'Blueprints' },
];

const SYSTEM_ACTORS = [
  { value: 'ai', label: 'AI' },
  { value: 'system', label: 'System' },
  { value: 'scheduler', label: 'Scheduler' },
];

function kindTone(kind: string): Tone {
  if (kind.startsWith('approval.rejected') || kind.endsWith('.failed') || kind === 'project.blocked' || kind === 'gate.failed') return 'rose';
  if (kind.startsWith('approval.') || kind.endsWith('.completed') || kind === 'gate.passed') return 'emerald';
  if (kind.startsWith('gate.')) return 'amber';
  if (kind.startsWith('agent.') || kind.startsWith('operation.')) return 'violet';
  if (kind.startsWith('settings.') || kind.startsWith('connector.') || kind.startsWith('blueprint.')) return 'zinc';
  if (kind.startsWith('intake.') || kind.startsWith('watcher.')) return 'cyan';
  if (kind.startsWith('step.')) return 'sky';
  return 'brand';
}

function matchesKind(kind: string, filter: string): boolean {
  return !filter || (filter.endsWith('.') ? kind.startsWith(filter) : kind === filter);
}

export default function AuditTab() {
  const { userById, users } = useApp();
  const toast = useToast();
  const [kind, setKind] = useState('');
  const [projectId, setProjectId] = useState('');
  const [actor, setActor] = useState('');
  const [events, setEvents] = useState<Event[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [chain, setChain] = useState<ChainVerification | null>(null);
  const [verifying, setVerifying] = useState(false);

  const verify = useCallback(async () => {
    setVerifying(true);
    try {
      setChain(await api.events.verify());
    } catch (err) {
      toast.error(err);
    } finally {
      setVerifying(false);
    }
  }, [toast]);

  useEffect(() => {
    void verify();
    api.projects.list().then(setProjects).catch(() => setProjects([]));
  }, [verify]);

  const load = useCallback(async () => {
    setEvents(null);
    try {
      const page = await api.events.list({ limit: PAGE, kind: kind || undefined, project_id: projectId || undefined });
      setEvents(page);
      setHasMore(page.length === PAGE);
    } catch (err) {
      toast.error(err);
      setEvents([]);
    }
  }, [kind, projectId, toast]);
  useEffect(() => {
    void load();
  }, [load]);

  const loadOlder = async () => {
    const last = events?.[events.length - 1];
    if (!last) return;
    setLoadingMore(true);
    try {
      const page = await api.events.list({ limit: PAGE, kind: kind || undefined, project_id: projectId || undefined, before: last.id });
      setEvents((prev) => [...(prev ?? []), ...page.filter((e) => !prev?.some((p) => p.id === e.id))]);
      setHasMore(page.length === PAGE);
    } catch (err) {
      toast.error(err);
    } finally {
      setLoadingMore(false);
    }
  };

  useLive('activity', (e) => {
    const ev = e.event;
    if (!matchesKind(ev.kind, kind) || (projectId && ev.project_id !== projectId)) return;
    setEvents((prev) => (prev && !prev.some((p) => p.id === ev.id) ? [ev, ...prev] : prev));
    setChain((c) => (c && c.ok ? { ...c, count: c.count + 1 } : c));
  });

  // The API filters by kind and project; the actor filter applies to the loaded pages.
  const shown = useMemo(() => (events ?? []).filter((e) => !actor || e.actor === actor), [events, actor]);
  const projectLabel = useMemo(() => new Map(projects.map((p) => [p.id, p.key || p.title])), [projects]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        {chain === null ? (
          <Skeleton className="h-8 w-64" />
        ) : chain.ok ? (
          <Badge tone="emerald" icon={ShieldCheck} className="!px-3 !py-1.5 !text-xs">
            Audit chain verified · {formatNumber(chain.count)} events
          </Badge>
        ) : (
          <Badge tone="rose" variant="solid" icon={ShieldAlert} className="!px-3 !py-1.5 !text-xs">
            Tampering detected at {chain.broken_at || 'an unknown event'}
          </Badge>
        )}
        <Tooltip content="Re-computes every event's hash from its predecessor">
          <Button size="xs" variant="ghost" icon={RefreshCw} busy={verifying} onClick={() => void verify()}>Verify again</Button>
        </Tooltip>
        <p className="ml-auto text-xs text-muted">Every action — human, AI, scheduler — is chained with SHA-256: an edited or deleted event breaks the chain.</p>
      </div>

      <Card padding="sm" className="flex flex-wrap items-center gap-2">
        <Filter size={14} className="ml-1 text-zinc-400" />
        <Select value={kind} placeholder="All kinds" options={KIND_OPTIONS} onChange={(e) => setKind(e.target.value)} className="h-8 w-auto text-xs" />
        <Select value={projectId} placeholder="All projects" onChange={(e) => setProjectId(e.target.value)} className="h-8 w-auto max-w-xs text-xs"
          options={projects.map((p) => ({ value: p.id, label: `${p.key} · ${p.title}` }))} />
        <Select value={actor} placeholder="Anyone" onChange={(e) => setActor(e.target.value)} className="h-8 w-auto text-xs"
          options={[...SYSTEM_ACTORS, ...users.map((u) => ({ value: u.id, label: u.name }))]} />
        {(kind || projectId || actor) && (
          <Button size="xs" variant="ghost" onClick={() => { setKind(''); setProjectId(''); setActor(''); }}>Clear</Button>
        )}
        <IconButton icon={RefreshCw} label="Reload" size="sm" className="ml-auto" onClick={() => void load()} />
      </Card>

      {events === null ? (
        <Skeleton lines={8} />
      ) : shown.length === 0 ? (
        <EmptyState icon={ScrollText} title="No event" description={events.length ? 'No loaded event matches this actor — load older events or clear the filter.' : 'Nothing has happened with these filters yet.'} compact />
      ) : (
        <Card padding="none" className="overflow-x-auto">
          <table className="w-full min-w-[820px] text-left text-sm">
            <thead className="border-b hairline">
              <tr>
                <th className="w-8" />
                <th className="w-40 px-3 py-2.5 label-xs">Time</th>
                <th className="w-44 px-3 py-2.5 label-xs">Kind</th>
                <th className="w-44 px-3 py-2.5 label-xs">Actor</th>
                <th className="w-28 px-3 py-2.5 label-xs">Project</th>
                <th className="px-3 py-2.5 label-xs">Message</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-ink-600">
              {shown.map((e) => {
                const expanded = open === e.id;
                const hasData = Object.keys(e.data ?? {}).length > 0;
                return (
                  <Fragment key={e.id}>
                    <tr className={cls('align-top animate-fade-in', expanded && 'bg-zinc-50 dark:bg-ink-900/50')}>
                      <td className="pl-2 pt-2">
                        {hasData && (
                          <IconButton icon={expanded ? ChevronDown : ChevronRight} label={expanded ? 'Hide details' : 'Show details'} size="xs"
                            onClick={() => setOpen(expanded ? null : e.id)} />
                        )}
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-xs">
                        <span className="num text-zinc-700 dark:text-zinc-300" title={e.ts}>{formatDateTime(e.ts)}</span>
                        <span className="block text-2xs text-faint">{timeAgo(e.ts)}</span>
                      </td>
                      <td className="px-3 py-2.5"><Badge tone={kindTone(e.kind)} size="xs" className="font-mono">{e.kind}</Badge></td>
                      <td className="px-3 py-2.5"><ActorCell actor={e.actor} name={userById(e.actor)?.name} user={userById(e.actor)} /></td>
                      <td className="px-3 py-2.5 text-xs">
                        {e.project_id ? (
                          <Link to={paths.project(e.project_id, e.step_id || undefined)} className="font-mono font-semibold text-brand-600 hover:underline dark:text-brand-400">
                            {projectLabel.get(e.project_id) ?? e.project_id.slice(0, 10)}
                          </Link>
                        ) : <span className="text-faint">—</span>}
                      </td>
                      <td className="px-3 py-2.5 text-xs text-zinc-700 dark:text-zinc-300">{e.message}</td>
                    </tr>
                    {expanded && (
                      <tr className="bg-zinc-50 dark:bg-ink-900/50">
                        <td />
                        <td colSpan={5} className="px-3 pb-3">
                          <pre className="max-h-64 overflow-auto rounded-lg border bg-white p-3 font-mono text-[11px] text-zinc-700 hairline dark:bg-ink-900 dark:text-zinc-300">{prettyJson(e.data)}</pre>
                          <p className="mt-1.5 font-mono text-2xs text-faint">id {e.id} · hash {e.hash.slice(0, 24)}…</p>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </Card>
      )}
      {events && hasMore && (
        <div className="flex justify-center">
          <Button variant="outline" size="sm" busy={loadingMore} onClick={() => void loadOlder()}>Load older</Button>
        </div>
      )}
    </div>
  );
}

function ActorCell({ actor, name, user }: { actor: string; name?: string; user?: { name: string; avatar_color?: string } }) {
  if (actor === 'ai') return <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-violet-600 dark:text-violet-400"><Bot size={16} /> AI</span>;
  if (actor === 'system') return <span className="inline-flex items-center gap-1.5 text-xs text-muted"><Cog size={16} /> System</span>;
  if (actor === 'scheduler') return <span className="inline-flex items-center gap-1.5 text-xs text-muted"><Clock size={16} /> Scheduler</span>;
  if (!actor) return <span className="text-xs text-faint">—</span>;
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-xs">
      <Avatar user={user} name={name ?? actor} size={20} />
      <span className="truncate">{name ?? actor}</span>
    </span>
  );
}
