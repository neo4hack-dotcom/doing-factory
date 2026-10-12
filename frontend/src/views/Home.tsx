// Home — the command center of the acting persona: who I am, what the AI thinks matters today,
// what needs me (with the primary action inline, so most work is one click from here), the
// portfolio pulse (KPI strip → filtered views), the factory flow per blueprint, live activity and
// new intake. While the Factory is not set up yet, a setup checklist replaces the empty widgets.
// Every number comes from the API; nothing is invented while loading (skeletons instead).
import {
  ArrowRight, Bot, CheckCircle2, ChevronRight, Circle, Clock3, Factory, FolderKanban, Gauge, Inbox as InboxIcon,
  PlayCircle, Plug, Plus, Radar, RefreshCw, ShieldAlert, Sparkles, ThumbsUp, Timer, Users, Wand2, Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { Markdown } from '../components/Markdown';
import { iconByName } from '../components/StepIcon';
import {
  Badge, Button, Card, CardHeader, EmptyState, IconButton, Skeleton, Stat, TONE, Tooltip, toneOf, useToast,
} from '../components/ui';
import { cls } from '../lib/cls';
import { dueLabel, formatDate, formatDateTime, formatNumber, plural, timeAgo } from '../lib/format';
import { usePageTitle } from '../lib/pageTitle';
import { Link, navigate, paths } from '../lib/router';
import { RISK } from '../lib/status';
import { useApp, useLive } from '../lib/store';
import type { Briefing, Event, InboxItem, IntakeItem, Kpis, ProjectSummary } from '../types';
import { upsertSummary } from './project/model';
import { AiChip, ActorName } from './task/common';
import { factoryFlow, greeting } from './task/logic';
import type { FlowRow } from './task/logic';
import { activityMeta, INBOX_KIND } from './task/meta';

const NEEDS_YOU_MAX = 6;
const ACTIVITY_MAX = 15;

export default function Home() {
  usePageTitle('Home');
  const app = useApp();
  const { me, userId, onboarding, counts, refreshCounts, blueprints, roleByKey } = app;
  const toast = useToast();

  // ---- Data (each widget degrades on its own: one failing endpoint never blanks the page) -----
  const [inbox, setInbox] = useState<InboxItem[] | null>(null);
  const [inboxError, setInboxError] = useState('');
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [kpiError, setKpiError] = useState('');
  const [projects, setProjects] = useState<ProjectSummary[] | null>(null);
  const [events, setEvents] = useState<Event[] | null>(null);
  const [intake, setIntake] = useState<IntakeItem[] | null>(null);

  const loadInbox = useCallback(async () => {
    if (!userId) {
      setInbox([]);
      return;
    }
    try {
      setInbox(await api.inbox.list(userId));
      setInboxError('');
    } catch (err) {
      setInboxError(errorMessage(err));
    }
  }, [userId]);
  const loadKpis = useCallback(async () => {
    try {
      setKpis(await api.kpis(30));
      setKpiError('');
    } catch (err) {
      setKpiError(errorMessage(err));
    }
  }, []);
  const loadProjects = useCallback(async () => {
    try {
      setProjects(await api.projects.list());
    } catch {
      setProjects((prev) => prev ?? []);
    }
  }, []);
  const loadEvents = useCallback(async () => {
    try {
      setEvents(await api.events.list({ limit: ACTIVITY_MAX }));
    } catch {
      setEvents((prev) => prev ?? []);
    }
  }, []);
  const loadIntake = useCallback(async () => {
    try {
      setIntake(await api.intake.list('new'));
    } catch {
      setIntake((prev) => prev ?? []);
    }
  }, []);

  useEffect(() => {
    setInbox(null);
    void loadInbox();
  }, [loadInbox]);
  useEffect(() => {
    void loadKpis();
    void loadProjects();
    void loadEvents();
    void loadIntake();
  }, [loadKpis, loadProjects, loadEvents, loadIntake]);

  // ---- Live: patch what the event carries, debounce what needs a refetch ----------------------
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const scheduleRefresh = useCallback(() => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      void loadInbox();
      void loadKpis();
    }, 800);
  }, [loadInbox, loadKpis]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useLive('project.updated', (e) => {
    if (e.summary) setProjects((prev) => (prev ? upsertSummary(prev, e.summary) : prev));
    scheduleRefresh();
  });
  useLive('project.deleted', (e) => {
    setProjects((prev) => prev?.filter((p) => p.id !== e.project_id) ?? prev);
    scheduleRefresh();
  });
  useLive('notification', () => scheduleRefresh());
  useLive('intake.updated', (e) => {
    setIntake((prev) => {
      if (!prev || !e.item) return prev;
      const rest = prev.filter((i) => i.id !== e.item.id);
      return e.item.status === 'new' ? [e.item, ...rest] : rest;
    });
    scheduleRefresh();
  });
  useLive('activity', (e) => {
    if (!e.event) return;
    setEvents((prev) => [e.event, ...(prev ?? []).filter((x) => x.id !== e.event.id)].slice(0, ACTIVITY_MAX));
  });

  // ---- Setup state ------------------------------------------------------------------------------
  const setupIncomplete = !!onboarding && (!onboarding.llm_configured || !onboarding.has_connectors || !onboarding.has_users);
  const kpiTotal = kpis ? kpis.totals.active + kpis.totals.waiting + kpis.totals.blocked + kpis.totals.done_period : 0;
  const nothingYet = projects !== null && projects.length === 0 && (inbox?.length ?? 0) === 0 && kpiTotal === 0 && (intake?.length ?? 0) === 0;
  const flow = useMemo(() => factoryFlow(projects ?? [], blueprints), [projects, blueprints]);

  const afterInlineAction = () => {
    void loadInbox();
    refreshCounts();
  };

  // ---- Quick actions ----------------------------------------------------------------------------
  const [runningWatchers, setRunningWatchers] = useState(false);
  const runWatchers = async () => {
    setRunningWatchers(true);
    try {
      const watchers = (await api.watchers.list()).filter((w) => w.enabled);
      if (watchers.length === 0) {
        toast.info('No enabled watcher yet — add one to detect new use cases automatically.', {
          action: { label: 'Open watchers', onClick: () => navigate(paths.settings('watchers')) },
        });
        return;
      }
      const results = await Promise.allSettled(watchers.map((w) => api.watchers.run(w.id)));
      const ok = results.flatMap((r) => (r.status === 'fulfilled' && r.value.ok ? [r.value] : []));
      const fresh = ok.reduce((n, r) => n + r.new, 0);
      const failed = results.length - ok.length;
      const msg = `${plural(watchers.length, 'watcher')} ran · ${plural(fresh, 'new item')}${failed ? ` · ${failed} failed` : ''}`;
      if (failed) toast.warn(msg, { action: { label: 'Open watchers', onClick: () => navigate(paths.settings('watchers')) } });
      else toast.success(msg, fresh ? { action: { label: 'Review intake', onClick: () => navigate(paths.intake()) } } : undefined);
      void loadIntake();
    } catch (err) {
      toast.error(err);
    } finally {
      setRunningWatchers(false);
    }
  };

  const firstName = me?.name.split(' ')[0] ?? '';

  return (
    <div className="space-y-6">
      {/* ---- Hero ---------------------------------------------------------------------------- */}
      <section className="card relative overflow-hidden px-5 py-5 sm:px-6">
        <div className="grid-bg pointer-events-none absolute inset-0 opacity-60" aria-hidden />
        <div className="pointer-events-none absolute -right-16 -top-24 h-64 w-64 rounded-full bg-brand-500/15 blur-3xl" aria-hidden />
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div className="min-w-0">
            <div className="label-xs">{formatDate(new Date().toISOString())}</div>
            <h1 className="mt-1 text-2xl font-bold tracking-tight text-zinc-900 sm:text-[1.7rem] dark:text-white">
              {greeting()}{firstName ? `, ${firstName}` : ''}
            </h1>
            <div className="mt-2 flex flex-wrap items-center gap-1.5">
              {me?.title && <span className="mr-1 text-sm text-muted">{me.title}</span>}
              {(me?.roles ?? []).map((r) => {
                const role = roleByKey(r);
                return <Badge key={r} tone={toneOf(role?.color)} size="xs" title={role?.description}>{role?.label ?? r}</Badge>;
              })}
              {!me && <span className="text-sm text-muted">Choose who you are acting as (top right) to see your work.</span>}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" icon={Radar} busy={runningWatchers} onClick={() => void runWatchers()}>Run watchers</Button>
            <Button variant="ai" size="sm" icon={Sparkles} onClick={() => app.openCopilot()}>Ask Factory</Button>
            <Button size="sm" icon={Plus} onClick={() => navigate(paths.newProject())}>New project</Button>
          </div>
        </div>
      </section>

      {setupIncomplete && <SetupChecklist />}

      {!(setupIncomplete && nothingYet) && (
        <>
          {/* ---- KPI strip ------------------------------------------------------------------- */}
          {kpiError ? (
            <Card padding="sm" className="text-sm text-muted">KPIs unavailable: {kpiError}</Card>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
              <Stat label="Active" icon={FolderKanban} tone="sky" loading={!kpis} value={formatNumber(kpis?.totals.active)}
                sub={kpis ? `${kpis.totals.waiting} waiting · ${kpis.totals.blocked} blocked` : undefined}
                onClick={() => navigate(paths.projects({ status: 'open' }))} />
              <Stat label="Waiting on me" icon={InboxIcon} tone="amber" value={formatNumber(counts.total)}
                sub={counts.approvals ? plural(counts.approvals, 'approval') : 'in your inbox'}
                onClick={() => navigate(paths.inbox())} />
              <Stat label="At risk" icon={ShieldAlert} tone="rose" loading={!kpis} value={formatNumber(kpis?.totals.at_risk)}
                sub="medium or high risk" onClick={() => navigate(paths.projects({ risk: 'at_risk', status: 'open' }))} />
              <Stat label="Done · 30 days" icon={CheckCircle2} tone="emerald" loading={!kpis} value={formatNumber(kpis?.totals.done_period)}
                trend={kpis?.throughput.map((w) => w.completed)}
                onClick={() => navigate(paths.projects({ status: 'done' }))} />
              <Stat label="Hours saved" icon={Timer} tone="violet" loading={!kpis} value={kpis ? savedHours(kpis.automation.hours_saved) : '—'}
                sub={kpis ? `${plural(kpis.automation.ai_steps, 'AI step')}` : undefined}
                onClick={() => navigate(paths.kpis())} />
            </div>
          )}

          <div className="grid gap-6 lg:grid-cols-[minmax(0,1.65fr)_minmax(0,1fr)]">
            <div className="min-w-0 space-y-6">
              <NeedsYou items={inbox} error={inboxError} total={counts.total} onActed={afterInlineAction} />
              <FlowCard rows={flow} loading={projects === null} />
            </div>
            <div className="min-w-0 space-y-6">
              <BriefingCard />
              <IntakeTeaser items={intake} />
              <ActivityFeed events={events} />
            </div>
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Setup checklist (shown until an LLM, connectors and people exist)
// ---------------------------------------------------------------------------------------------

function SetupChecklist() {
  const { onboarding, reload, isAdmin } = useApp();
  const toast = useToast();
  const [installing, setInstalling] = useState(false);
  if (!onboarding) return null;

  const installDemo = async () => {
    setInstalling(true);
    try {
      const res = await api.admin.installDemo();
      await reload();
      const c = res.created;
      toast.success(`Demo environment installed — ${plural(c.users, 'person', 'people')}, ${plural(c.connectors, 'connector')}, ${plural(c.operations, 'operation')}, ${plural(c.watchers, 'watcher')}.`);
    } catch (err) {
      toast.error(err);
    } finally {
      setInstalling(false);
    }
  };

  const items: Array<{ done: boolean; title: string; text: string; icon: LucideIcon; action: ReactNode }> = [
    {
      done: onboarding.llm_configured,
      title: 'Connect an AI model',
      text: 'A local model (Ollama) drafts forms, briefs approvers, estimates and runs agentic steps.',
      icon: Bot,
      action: <Button size="sm" variant={onboarding.llm_configured ? 'ghost' : 'primary'} iconRight={ArrowRight} onClick={() => navigate(paths.settings('ai'))}>{onboarding.llm_configured ? 'Review' : 'Connect'}</Button>,
    },
    {
      done: onboarding.has_connectors,
      title: 'Connect your tools',
      text: 'Install the sandbox (DOINg.AI catalog, Jira, notifications, git — all simulated) or add your own MCP connectors.',
      icon: Plug,
      action: (
        <div className="flex flex-wrap justify-end gap-2">
          {!onboarding.demo_installed && (
            <Tooltip content={isAdmin ? 'Idempotent — safe to run twice' : 'Requires the admin role'}>
              <Button size="sm" variant={onboarding.has_connectors ? 'outline' : 'primary'} icon={Wand2} busy={installing} onClick={() => void installDemo()}>Install demo</Button>
            </Tooltip>
          )}
          <Button size="sm" variant="ghost" onClick={() => navigate(paths.settings('connectors'))}>Add connectors</Button>
        </div>
      ),
    },
    {
      done: onboarding.has_users,
      title: 'Add the people',
      text: 'Sponsors, PMs, developers, IT, security and compliance — with their roles, so every step reaches the right inbox.',
      icon: Users,
      action: <Button size="sm" variant={onboarding.has_users ? 'ghost' : 'outline'} iconRight={ArrowRight} onClick={() => navigate(paths.settings('people'))}>{onboarding.has_users ? 'Review' : 'Add people'}</Button>,
    },
  ];
  const done = items.filter((i) => i.done).length;

  return (
    <Card padding="none" tone="accent">
      <CardHeader
        eyebrow="Get started"
        title="Set up your factory"
        subtitle={`${done} of ${items.length} done — a few minutes and the whole flow runs end to end.`}
        icon={Factory}
      />
      <ol className="divide-y hairline">
        {items.map((it) => (
          <li key={it.title} className="flex flex-wrap items-center gap-3 px-4 py-3.5 sm:flex-nowrap">
            {it.done
              ? <CheckCircle2 size={20} className="shrink-0 text-emerald-500" aria-label="Done" />
              : <Circle size={20} className="shrink-0 text-zinc-300 dark:text-ink-400" aria-label="To do" />}
            <span className={cls('grid h-9 w-9 shrink-0 place-items-center rounded-lg', TONE.brand.icon)}><it.icon size={16} /></span>
            <div className="min-w-0 flex-1">
              <div className={cls('text-sm font-semibold', it.done ? 'text-muted line-through decoration-zinc-300' : 'text-zinc-900 dark:text-white')}>{it.title}</div>
              <p className="text-xs text-muted">{it.text}</p>
            </div>
            <div className="ml-auto shrink-0">{it.action}</div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Briefing
// ---------------------------------------------------------------------------------------------

function BriefingCard() {
  const { userId } = useApp();
  const [briefing, setBriefing] = useState<Briefing | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState(false);

  const load = useCallback(async (refresh: boolean) => {
    if (!userId) return;
    setBusy(true);
    try {
      setBriefing(await api.briefing(userId, refresh));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }, [userId]);

  useEffect(() => {
    setBriefing(null);
    void load(false);
  }, [load]);

  const long = (briefing?.markdown.length ?? 0) > 900;

  return (
    <Card padding="none" tone={briefing?.ai ? 'ai' : 'default'}>
      <CardHeader
        eyebrow={briefing ? `Generated ${timeAgo(briefing.generated_at)}` : 'Today'}
        title={<span className="inline-flex items-center gap-2">Your briefing {briefing?.ai && <AiChip />}</span>}
        icon={Sparkles}
        iconTone="violet"
        actions={<IconButton icon={RefreshCw} label="Regenerate the briefing" size="sm" busy={busy && !!briefing} disabled={busy || !userId} onClick={() => void load(true)} />}
      />
      <div className="px-4 py-3.5">
        {!userId ? (
          <p className="text-sm text-muted">Choose a persona to get a briefing.</p>
        ) : error ? (
          <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
        ) : !briefing ? (
          <div className="space-y-2" aria-busy>
            <div className="shimmer h-3 w-4/5 rounded" />
            <div className="shimmer h-3 w-full rounded" />
            <div className="shimmer h-3 w-3/5 rounded" />
            <div className="shimmer h-3 w-11/12 rounded" />
          </div>
        ) : (
          <>
            <div className={cls('relative', long && !expanded && 'max-h-72 overflow-hidden')}>
              <Markdown content={briefing.markdown} size="xs" />
              {long && !expanded && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-gradient-to-t from-white dark:from-ink-800" />}
            </div>
            {long && (
              <button type="button" className="mt-2 text-xs font-semibold text-brand-600 hover:underline dark:text-brand-400" onClick={() => setExpanded((v) => !v)}>
                {expanded ? 'Show less' : 'Show more'}
              </button>
            )}
            {!briefing.ai && (
              <p className="mt-3 flex items-start gap-1.5 border-t hairline pt-2.5 text-[11px] text-muted">
                <Bot size={12} className="mt-px shrink-0" />
                <span>Deterministic summary — <Link to={paths.settings('ai')} className="font-semibold text-brand-600 hover:underline dark:text-brand-400">connect an LLM</Link> for an AI briefing.</span>
              </p>
            )}
          </>
        )}
      </div>
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Needs you
// ---------------------------------------------------------------------------------------------

function NeedsYou({ items, error, total, onActed }: { items: InboxItem[] | null; error: string; total: number; onActed: () => void }) {
  const shown = (items ?? []).slice(0, NEEDS_YOU_MAX);
  const count = items?.length ?? total;
  return (
    <Card padding="none">
      <CardHeader
        title="Needs you"
        subtitle={items ? (count ? `${plural(count, 'item')} waiting for your action` : 'Nothing is waiting for you') : 'Loading your inbox…'}
        icon={Zap}
        iconTone="amber"
        actions={<Link to={paths.inbox()} className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:underline dark:text-brand-400">Open inbox <ArrowRight size={12} /></Link>}
      />
      {error ? (
        <p className="px-4 py-4 text-sm text-rose-600 dark:text-rose-400">{error}</p>
      ) : items === null ? (
        <div className="space-y-3 px-4 py-4">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
      ) : shown.length === 0 ? (
        <EmptyState compact icon={CheckCircle2} title="Inbox zero" description="No approval, form or review is waiting for you. New work shows up here the moment it does." />
      ) : (
        <ul className="divide-y hairline">
          {shown.map((item) => <NeedsYouRow key={item.id} item={item} onActed={onActed} />)}
          {count > shown.length && (
            <li className="px-4 py-2.5 text-center">
              <Link to={paths.inbox()} className="text-xs font-semibold text-brand-600 hover:underline dark:text-brand-400">
                {plural(count - shown.length, 'more item')} in your inbox
              </Link>
            </li>
          )}
        </ul>
      )}
    </Card>
  );
}

function NeedsYouRow({ item, onActed }: { item: InboxItem; onActed: () => void }) {
  const { userId } = useApp();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const meta = INBOX_KIND[item.kind] ?? INBOX_KIND.form;
  const due = dueLabel(item.due_at);
  const open = () => navigate(paths.inbox(item.id));

  const act = async (kind: 'approve' | 'start') => {
    setBusy(true);
    try {
      const p = kind === 'approve'
        ? await api.steps.decide(item.project_id, item.step_id, userId, 'approved')
        : await api.steps.start(item.project_id, item.step_id, userId);
      toast.success(kind === 'approve' ? `Approved “${item.step_name}” on ${p.key}` : `Started “${item.step_name}” on ${p.key}`, {
        action: { label: 'Open project', onClick: () => navigate(paths.project(p.id)) },
      });
      onActed();
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(false);
    }
  };

  let primary: ReactNode;
  if (item.kind === 'approval') primary = <Button size="xs" icon={ThumbsUp} busy={busy} onClick={() => void act('approve')}>Approve</Button>;
  else if (item.kind === 'start') primary = <Button size="xs" icon={PlayCircle} busy={busy} onClick={() => void act('start')}>Start</Button>;
  else primary = <Button size="xs" variant="outline" onClick={open}>{meta.verb}</Button>;

  return (
    <li className="group flex items-center gap-3 px-4 py-2.5 transition-colors hover:bg-zinc-50 dark:hover:bg-ink-700/30">
      <span className={cls('grid h-8 w-8 shrink-0 place-items-center rounded-lg', TONE[meta.tone].icon)} title={meta.label}>
        <meta.icon size={15} />
      </span>
      <Link to={paths.inbox(item.id)} className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
          {item.project_key && <span className="font-mono font-semibold text-zinc-600 dark:text-zinc-300">{item.project_key}</span>}
          {item.step_name && <span className="truncate">{item.step_name}</span>}
          {item.risk_level && item.risk_level !== 'low' && (
            <span className={cls('h-1.5 w-1.5 shrink-0 rounded-full', TONE[RISK[item.risk_level].tone].dot)} title={RISK[item.risk_level].label} />
          )}
        </div>
        <div className="truncate text-sm font-semibold text-zinc-900 group-hover:text-brand-700 dark:text-zinc-100 dark:group-hover:text-brand-300">{item.title}</div>
      </Link>
      <div className="hidden shrink-0 items-center gap-1.5 sm:flex">
        {(item.priority === 'high' || item.priority === 'critical') && <Badge tone={item.priority === 'critical' ? 'rose' : 'amber'} size="xs">{item.priority === 'critical' ? 'Critical' : 'High'}</Badge>}
        {item.overdue
          ? <Badge tone="rose" variant="solid" size="xs" icon={Clock3}>Overdue</Badge>
          : due.label && <Badge tone={due.soon ? 'amber' : 'zinc'} size="xs" title={formatDateTime(item.due_at)}>{due.label}</Badge>}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {primary}
        {(item.kind === 'approval' || item.kind === 'start') && (
          <IconButton icon={ChevronRight} label="Open" size="sm" onClick={open} />
        )}
      </div>
    </li>
  );
}

// ---------------------------------------------------------------------------------------------
// Factory flow
// ---------------------------------------------------------------------------------------------

function FlowCard({ rows, loading }: { rows: FlowRow[]; loading: boolean }) {
  return (
    <Card padding="none">
      <CardHeader
        title="Factory flow"
        subtitle="Projects in flight per blueprint, by current stage"
        icon={Gauge}
        iconTone="sky"
        actions={<Link to={paths.floor()} className="inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:underline dark:text-brand-400">Open the floor <ArrowRight size={12} /></Link>}
      />
      {loading ? (
        <div className="space-y-3 px-4 py-4"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
      ) : rows.length === 0 ? (
        <EmptyState compact icon={Factory} title="Nothing in flight" description="Start a project or accept an intake item — it appears here, moving stage by stage."
          action={<Button size="sm" icon={Plus} onClick={() => navigate(paths.newProject())}>New project</Button>} />
      ) : (
        <ul className="divide-y hairline">
          {rows.map((row) => {
            const Icon = iconByName(row.icon);
            const tone = toneOf(row.color);
            return (
              <li key={row.blueprintId}>
                <button
                  type="button"
                  onClick={() => navigate(paths.projects({ blueprint: row.blueprintId, view: 'board' }))}
                  className="flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-ink-700/30"
                >
                  <span className={cls('grid h-8 w-8 shrink-0 place-items-center rounded-lg', TONE[tone].icon)}><Icon size={15} /></span>
                  <div className="w-32 shrink-0 sm:w-40">
                    <div className="truncate text-sm font-semibold text-zinc-900 dark:text-zinc-100">{row.name}</div>
                    <div className="text-[11px] text-muted">{plural(row.total, 'project')}</div>
                  </div>
                  <div className="no-scrollbar flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
                    {row.stages.map((s, i) => (
                      <div key={s.id} className="flex shrink-0 items-center gap-1">
                        {i > 0 && <ChevronRight size={12} className="text-zinc-300 dark:text-ink-400" />}
                        <span
                          title={`${s.name}: ${plural(s.count, 'project')}${s.attention ? ` · ${s.attention} waiting on people` : ''}${s.blocked ? ` · ${s.blocked} blocked` : ''}`}
                          className={cls(
                            'inline-flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px]',
                            s.count > 0 ? cls(TONE[tone].border, TONE[tone].soft, 'font-semibold') : 'hairline text-faint',
                          )}
                        >
                          <span className="max-w-[7.5rem] truncate">{s.name}</span>
                          <span className="num">{s.count}</span>
                          {s.blocked > 0 && <span className={cls('h-1.5 w-1.5 rounded-full', TONE.rose.dot)} />}
                          {s.blocked === 0 && s.attention > 0 && <span className={cls('h-1.5 w-1.5 rounded-full', TONE.amber.dot)} />}
                        </span>
                      </div>
                    ))}
                  </div>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------------------------------------
// Intake teaser & activity
// ---------------------------------------------------------------------------------------------

function IntakeTeaser({ items }: { items: IntakeItem[] | null }) {
  const n = items?.length ?? 0;
  return (
    <Card padding="none">
      <CardHeader
        title="New intake"
        subtitle={items === null ? 'Checking…' : n ? `${plural(n, 'use case')} detected, waiting for triage` : 'No new use case detected'}
        icon={Radar}
        iconTone="brand"
        actions={n > 0 ? <Button size="xs" iconRight={ArrowRight} onClick={() => navigate(paths.intake())}>Review</Button> : undefined}
        divider={n > 0}
      />
      {n > 0 && (
        <ul className="divide-y hairline">
          {(items ?? []).slice(0, 3).map((i) => (
            <li key={i.id}>
              <Link to={paths.inbox(`intake:${i.id}`)} className="flex items-center gap-2 px-4 py-2 text-sm hover:bg-zinc-50 dark:hover:bg-ink-700/30">
                <span className="min-w-0 flex-1 truncate font-medium">{i.title}</span>
                {i.suggestion && <Sparkles size={12} className="shrink-0 text-violet-500" aria-label="AI triage available" />}
                <span className="shrink-0 text-[11px] text-faint">{timeAgo(i.detected_at)}</span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function ActivityFeed({ events }: { events: Event[] | null }) {
  return (
    <Card padding="none">
      <CardHeader title="Live activity" subtitle="Everything the Factory and the team do, as it happens" icon={Zap} iconTone="emerald" />
      {events === null ? (
        <div className="space-y-3 px-4 py-4">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-7 w-full" />)}</div>
      ) : events.length === 0 ? (
        <EmptyState compact icon={Zap} title="No activity yet" description="Actions on projects, intake and settings stream in here live." />
      ) : (
        <ol className="max-h-[26rem] overflow-y-auto px-4 py-2">
          {events.map((e) => {
            const m = activityMeta(e.kind);
            const body = (
              <>
                <span className={cls('mt-0.5 grid h-6 w-6 shrink-0 place-items-center rounded-full', TONE[m.tone].icon)}><m.icon size={12} /></span>
                <div className="min-w-0 flex-1">
                  <p className="text-[13px] leading-snug text-zinc-700 dark:text-zinc-200">{e.message}</p>
                  <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-faint">
                    <ActorName id={e.actor} size={14} className="text-muted" />
                    <span>·</span>
                    <span title={formatDateTime(e.ts)}>{timeAgo(e.ts)}</span>
                  </div>
                </div>
              </>
            );
            return (
              <li key={e.id} className="animate-fade-in">
                {e.project_id ? (
                  <Link to={paths.project(e.project_id, e.step_id || undefined)} className="-mx-2 flex items-start gap-2.5 rounded-lg px-2 py-2 hover:bg-zinc-50 dark:hover:bg-ink-700/30">{body}</Link>
                ) : (
                  <div className="flex items-start gap-2.5 py-2">{body}</div>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </Card>
  );
}

/** Hours saved as a plain amount ("12.5 h"): a saving reads better in hours than as a duration. */
function savedHours(hours: number): string {
  return `${formatNumber(hours, hours > 0 && hours < 10 ? 1 : 0)} h`;
}
