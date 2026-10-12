// Inbox — every action waiting for the acting persona, two-pane: the grouped list on the left
// (Overdue first, then approvals, forms & reviews, confirmations, failures, starts & external,
// intake), the TaskPanel of the selected item on the right, so work flows item after item without
// leaving the page. Keyboard: j/k move, a approve (accept for intake), r reject (dismiss), Enter on
// a row opens it full page. Acting on an item removes it and selects the next one ("inbox zero").
import { ArrowLeft, CheckCircle2, Clock3, Inbox as InboxIcon, RefreshCw, Search, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent } from 'react';
import { api, errorMessage } from '../api';
import {
  Badge, Button, EmptyState, IconButton, Input, Kbd, Skeleton, TONE, useConfirmReason, useToast,
} from '../components/ui';
import { cls } from '../lib/cls';
import { dueLabel, formatDateTime, plural, timeAgo } from '../lib/format';
import { useHotkeys } from '../lib/hotkeys';
import { usePageTitle } from '../lib/pageTitle';
import { navigate, paths } from '../lib/router';
import { RISK } from '../lib/status';
import { useApp, useLive } from '../lib/store';
import type { InboxItem, InboxKind, Project } from '../types';
import TaskPanel from './TaskPanel';
import { Callout } from './task/common';
import { IntakePane } from './task/IntakePane';
import { filterInbox, groupInbox, nextSelection, parseInboxId } from './task/logic';
import { INBOX_KIND, INBOX_KIND_ORDER } from './task/meta';

export interface InboxProps {
  /** Selected item ("{project_id}:{step_id}" or "intake:{id}") from #/inbox/:itemId. */
  itemId?: string;
}

export default function Inbox({ itemId }: InboxProps) {
  usePageTitle('Inbox');
  const { userId, refreshCounts } = useApp();
  const toast = useToast();
  const confirmReason = useConfirmReason();

  // ---- Data -------------------------------------------------------------------------------------
  const [items, setItems] = useState<InboxItem[] | null>(null);
  const [error, setError] = useState('');
  const [reloading, setReloading] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const mine = ++seq.current;
    if (!userId) {
      setItems([]);
      return;
    }
    setReloading(true);
    try {
      const rows = await api.inbox.list(userId);
      if (mine !== seq.current) return;
      setItems(rows);
      setError('');
    } catch (err) {
      if (mine === seq.current) setError(errorMessage(err));
    } finally {
      if (mine === seq.current) setReloading(false);
    }
  }, [userId]);

  useEffect(() => {
    setItems(null);
    void load();
  }, [load]);

  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const scheduleLoad = useCallback((delay = 400) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void load(), delay);
  }, [load]);
  useEffect(() => () => clearTimeout(timer.current), []);
  useLive('project.updated', () => scheduleLoad());
  useLive('project.deleted', () => scheduleLoad());
  useLive('intake.updated', () => scheduleLoad());
  useLive('notification', () => scheduleLoad());

  // ---- Filters ----------------------------------------------------------------------------------
  const [kind, setKind] = useState<InboxKind | 'all'>('all');
  const [query, setQuery] = useState('');
  const visible = useMemo(() => filterInbox(items ?? [], kind, query), [items, kind, query]);
  const groups = useMemo(() => groupInbox(visible), [visible]);
  const orderedIds = useMemo(() => groups.flatMap((g) => g.items.map((i) => i.id)), [groups]);
  const kindCounts = useMemo(() => {
    const out = new Map<InboxKind, number>();
    for (const i of items ?? []) out.set(i.kind, (out.get(i.kind) ?? 0) + 1);
    return out;
  }, [items]);

  // ---- Selection --------------------------------------------------------------------------------
  // The URL names the selection; without one, the first visible item shows (desktop) without
  // pushing a history entry.
  const selected = itemId || orderedIds[0] || '';
  const select = useCallback((id: string, replace = false) => navigate(paths.inbox(id || undefined), { replace }), []);

  // When the selected item disappears after a reload (acted on here or elsewhere), move to the
  // item that took its place — the "next" one — so the persona keeps flowing.
  // Only a removal from the inbox itself counts (a filter hiding the item does not).
  const previous = useRef<{ all: string[]; ordered: string[] }>({ all: [], ordered: [] });
  useEffect(() => {
    if (items === null) return;
    const all = items.map((i) => i.id);
    const prev = previous.current;
    previous.current = { all, ordered: orderedIds };
    if (itemId && prev.all.includes(itemId) && !all.includes(itemId)) {
      select(nextSelection(prev.ordered, orderedIds, itemId), true);
    }
  }, [items, orderedIds, itemId, select]);

  const rowRefs = useRef(new Map<string, HTMLButtonElement>());
  const move = (delta: 1 | -1) => {
    if (orderedIds.length === 0) return;
    const at = orderedIds.indexOf(selected);
    const next = orderedIds[Math.max(0, Math.min(orderedIds.length - 1, at < 0 ? 0 : at + delta))];
    select(next, true);
    requestAnimationFrame(() => {
      const el = rowRefs.current.get(next);
      el?.focus({ preventScroll: true });
      el?.scrollIntoView({ block: 'nearest' });
    });
  };

  const selectedItem = (items ?? []).find((i) => i.id === selected) ?? null;
  const parsed = selected ? parseInboxId(selected) : null;

  // ---- Right pane project ----------------------------------------------------------------------
  const projectId = parsed && 'projectId' in parsed ? parsed.projectId : '';
  const [project, setProject] = useState<Project | null>(null);
  const [projectError, setProjectError] = useState('');
  useEffect(() => {
    if (!projectId) return;
    let alive = true;
    setProjectError('');
    setProject((cur) => (cur?.id === projectId ? cur : null));
    api.projects.get(projectId)
      .then((p) => alive && setProject(p))
      .catch((err) => alive && setProjectError(errorMessage(err)));
    return () => {
      alive = false;
    };
  }, [projectId]);

  const onProjectChanged = useCallback((p: Project) => {
    setProject(p);
    scheduleLoad(150);
    refreshCounts();
  }, [scheduleLoad, refreshCounts]);

  // ---- Keyboard quick actions ------------------------------------------------------------------
  // A ref, not state: a second key press while the confirm dialog is open must not start another.
  const quickBusy = useRef(false);
  const quick = async (action: 'approve' | 'reject') => {
    const item = selectedItem;
    if (!item || quickBusy.current) return;
    quickBusy.current = true;
    try {
      if (item.kind === 'intake') {
        const intakeId = item.id.slice('intake:'.length);
        if (action === 'approve') {
          const p = await api.intake.accept(intakeId, userId);
          toast.success(`${p.key} started from “${item.title}”`, { action: { label: 'Open project', onClick: () => navigate(paths.project(p.id)) } });
        } else {
          const reason = await confirmReason({ title: `Dismiss “${item.title}”?`, tone: 'warning', confirmLabel: 'Dismiss', reasonPlaceholder: 'Duplicate, out of scope, not ready…' });
          if (reason === null) return;
          await api.intake.dismiss(intakeId, userId, reason);
          toast.success('Dismissed');
        }
      } else if (item.kind === 'approval') {
        let comment = '';
        if (action === 'reject') {
          const reason = await confirmReason({
            title: `Reject “${item.step_name}”?`,
            message: `${item.project_key} · ${item.project_title}`,
            tone: 'danger',
            confirmLabel: 'Reject',
            reasonLabel: 'Comment (required)',
            reasonPlaceholder: 'What must change before you can approve?',
          });
          if (reason === null) return;
          comment = reason;
        }
        const p = await api.steps.decide(item.project_id, item.step_id, userId, action === 'approve' ? 'approved' : 'rejected', comment);
        toast.success(action === 'approve' ? `Approved “${item.step_name}”` : `Rejected “${item.step_name}”`);
        if (p.id === project?.id) setProject(p);
      } else {
        toast.info(`${action === 'approve' ? 'a' : 'r'} works on approvals and intake — this ${INBOX_KIND[item.kind].label.toLowerCase()} is handled in the panel.`);
        return;
      }
      scheduleLoad(100);
      refreshCounts();
    } catch (err) {
      toast.error(err);
    } finally {
      quickBusy.current = false;
    }
  };

  useHotkeys({
    j: () => move(1),
    k: () => move(-1),
    a: () => void quick('approve'),
    r: () => void quick('reject'),
  });

  const openFull = (item: InboxItem) => {
    if (item.kind === 'intake') navigate(paths.intake());
    else navigate(paths.project(item.project_id, item.step_id));
  };
  const onRowKey = (e: KeyboardEvent<HTMLButtonElement>, item: InboxItem) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      openFull(item);
    }
  };

  // ---- Render -----------------------------------------------------------------------------------
  const total = items?.length ?? 0;
  const overdue = (items ?? []).filter((i) => i.overdue).length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold tracking-tight text-zinc-900 dark:text-white">Inbox</h1>
          <p className="mt-0.5 text-sm text-muted">
            {items === null ? 'Loading your pending actions…'
              : total === 0 ? 'Nothing is waiting for you.'
                : <>{plural(total, 'item')} waiting for you{overdue > 0 && <> · <span className="font-semibold text-rose-600 dark:text-rose-400">{overdue} overdue</span></>}</>}
          </p>
        </div>
        <div className="hidden items-center gap-2 text-[11px] text-faint md:flex">
          <Kbd>j</Kbd><Kbd>k</Kbd> move · <Kbd>a</Kbd> approve · <Kbd>r</Kbd> reject · <Kbd>Enter</Kbd> open
          <IconButton icon={RefreshCw} label="Refresh" size="sm" busy={reloading && items !== null} onClick={() => void load()} />
        </div>
      </div>

      {error && items === null ? (
        <Callout tone="rose" icon={X} title="Could not load your inbox">{error}</Callout>
      ) : items !== null && total === 0 && !itemId ? (
        <div className="card py-10">
          <EmptyState
            icon={CheckCircle2}
            title="Inbox zero"
            description="No approval, form, estimate, review or failure is waiting for you. New work appears here — and in the sidebar badge — the moment it does."
            action={<div className="flex gap-2"><Button variant="outline" size="sm" onClick={() => navigate(paths.home())}>Back to Home</Button><Button size="sm" onClick={() => navigate(paths.projects({ mine: '1' }))}>My projects</Button></div>}
          />
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-[minmax(300px,380px)_minmax(0,1fr)]">
          {/* ---- List ------------------------------------------------------------------------ */}
          <aside className={cls('card flex min-w-0 flex-col overflow-hidden lg:sticky lg:top-4 lg:max-h-[calc(100vh-7rem)]', itemId && 'hidden lg:flex')}>
            <div className="space-y-2.5 border-b hairline p-3">
              <Input icon={Search} placeholder="Search title, project, step…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search the inbox" />
              <div className="no-scrollbar -mx-0.5 flex gap-1 overflow-x-auto px-0.5">
                <KindChip active={kind === 'all'} label="All" count={total} onClick={() => setKind('all')} />
                {INBOX_KIND_ORDER.filter((k) => kindCounts.has(k)).map((k) => (
                  <KindChip key={k} kind={k} active={kind === k} label={INBOX_KIND[k].plural} count={kindCounts.get(k) ?? 0} onClick={() => setKind(kind === k ? 'all' : k)} />
                ))}
              </div>
            </div>
            <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
              {items === null ? (
                <div className="space-y-3 p-3">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
              ) : total === 0 ? (
                <EmptyState compact icon={CheckCircle2} title="Inbox zero" description="Nothing else is waiting for you." />
              ) : groups.length === 0 ? (
                <EmptyState compact icon={Search} title="No match" description="No item matches these filters."
                  action={<Button size="xs" variant="outline" onClick={() => { setKind('all'); setQuery(''); }}>Clear filters</Button>} />
              ) : groups.map((g) => (
                <section key={g.key} aria-label={g.label}>
                  <h2 className={cls('label-xs sticky top-0 z-[1] flex items-center justify-between border-b hairline bg-zinc-50/95 px-3 py-1.5 backdrop-blur dark:bg-ink-900/95', g.key === 'overdue' && 'text-rose-600 dark:text-rose-400')}>
                    {g.label}<span className="num">{g.items.length}</span>
                  </h2>
                  <ul>
                    {g.items.map((item) => (
                      <li key={item.id}>
                        <InboxRow
                          item={item}
                          selected={item.id === selected}
                          refCb={(el) => { if (el) rowRefs.current.set(item.id, el); else rowRefs.current.delete(item.id); }}
                          onSelect={() => select(item.id, !!itemId)}
                          onKeyDown={(e) => onRowKey(e, item)}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </aside>

          {/* ---- Detail pane ------------------------------------------------------------------ */}
          <main className={cls('card min-w-0 p-4 sm:p-5', !itemId && 'hidden lg:block')}>
            {itemId && (
              <button type="button" onClick={() => select('')} className="mb-3 inline-flex items-center gap-1 text-xs font-semibold text-muted hover:text-zinc-800 lg:hidden dark:hover:text-zinc-200">
                <ArrowLeft size={13} /> All items
              </button>
            )}
            {!parsed ? (
              items === null
                ? <Skeleton lines={8} />
                : <EmptyState compact icon={InboxIcon} title="Select an item" description="Its context and actions appear here." />
            ) : 'intakeId' in parsed ? (
              <IntakePane key={parsed.intakeId} intakeId={parsed.intakeId} onDecided={() => { scheduleLoad(100); refreshCounts(); }} />
            ) : projectError && project?.id !== parsed.projectId ? (
              <Callout tone="rose" icon={X} title="Could not open this project">{projectError}</Callout>
            ) : project && project.id === parsed.projectId ? (
              <TaskPanel key={selected} project={project} stepId={parsed.stepId} onChanged={onProjectChanged} />
            ) : (
              <div className="space-y-4"><Skeleton className="h-10 w-2/3" /><Skeleton lines={6} /></div>
            )}
          </main>
        </div>
      )}
    </div>
  );
}

function KindChip({ kind, active, label, count, onClick }: { kind?: InboxKind; active: boolean; label: string; count: number; onClick: () => void }) {
  const meta = kind ? INBOX_KIND[kind] : null;
  const Icon = meta?.icon;
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cls(
        'inline-flex shrink-0 items-center gap-1 rounded-full border px-2.5 py-1 text-[11px] font-semibold transition-colors',
        active
          ? 'border-brand-500 bg-brand-500 text-white'
          : 'hairline text-zinc-600 hover:border-zinc-300 hover:text-zinc-900 dark:text-zinc-300 dark:hover:border-ink-400 dark:hover:text-white',
      )}
    >
      {Icon && <Icon size={11} />}
      {label}
      <span className={cls('num', active ? 'text-white/80' : 'text-faint')}>{count}</span>
    </button>
  );
}

function InboxRow({ item, selected, refCb, onSelect, onKeyDown }: {
  item: InboxItem;
  selected: boolean;
  refCb: (el: HTMLButtonElement | null) => void;
  onSelect: () => void;
  onKeyDown: (e: KeyboardEvent<HTMLButtonElement>) => void;
}) {
  const meta = INBOX_KIND[item.kind] ?? INBOX_KIND.form;
  const due = dueLabel(item.due_at);
  const risk = item.risk_level ? RISK[item.risk_level] : null;
  return (
    <button
      ref={refCb}
      type="button"
      onClick={onSelect}
      onKeyDown={onKeyDown}
      aria-current={selected || undefined}
      className={cls(
        'relative flex w-full items-start gap-2.5 border-b hairline px-3 py-2.5 text-left transition-colors focus-visible:outline-none',
        selected ? 'bg-brand-50/70 dark:bg-brand-500/10' : 'hover:bg-zinc-50 focus-visible:bg-zinc-50 dark:hover:bg-ink-700/30 dark:focus-visible:bg-ink-700/30',
      )}
    >
      {selected && <span className="absolute inset-y-0 left-0 w-0.5 bg-brand-500" aria-hidden />}
      <span className={cls('mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg', TONE[meta.tone].icon)} title={meta.label}>
        <meta.icon size={14} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted">
          {item.project_key && <span className="shrink-0 font-mono font-semibold text-zinc-600 dark:text-zinc-300">{item.project_key}</span>}
          <span className="truncate">{item.step_name || meta.label}</span>
          {risk && item.risk_level !== 'low' && <span className={cls('h-1.5 w-1.5 shrink-0 rounded-full', TONE[risk.tone].dot)} title={risk.label} />}
        </div>
        <div className={cls('mt-0.5 line-clamp-2 text-[13px] leading-snug', selected ? 'font-semibold text-zinc-900 dark:text-white' : 'font-medium text-zinc-800 dark:text-zinc-100')}>{item.title}</div>
        <div className="mt-1 flex flex-wrap items-center gap-1">
          {item.overdue
            ? <Badge tone="rose" variant="solid" size="xs" icon={Clock3}>{due.label || 'Overdue'}</Badge>
            : due.label
              ? <Badge tone={due.soon ? 'amber' : 'zinc'} size="xs" title={formatDateTime(item.due_at)}>{due.label}</Badge>
              : <span className="text-[10px] text-faint" title={formatDateTime(item.created_at)}>{timeAgo(item.created_at)}</span>}
          {(item.priority === 'high' || item.priority === 'critical') && (
            <Badge tone={item.priority === 'critical' ? 'rose' : 'amber'} size="xs">{item.priority === 'critical' ? 'Critical' : 'High'}</Badge>
          )}
        </div>
      </div>
    </button>
  );
}

