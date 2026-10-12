// Portfolio table: one dense row per project, sortable headers, j/k + Enter keyboard navigation.
// Rows are links (middle-click opens a new tab); the whole row is clickable for speed.
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { PipelineStrip } from '../../components/PipelineStrip';
import { StatusBadge } from '../../components/ui';
import { cls } from '../../lib/cls';
import { formatDateTime, timeAgo } from '../../lib/format';
import { useHotkeys } from '../../lib/hotkeys';
import { Link, navigate, paths } from '../../lib/router';
import type { ProjectSummary } from '../../types';
import { BlueprintChip, ChildMarker, DueChip, OpenSteps, PeoplePair, PriorityFlag, RiskBadge } from './bits';
import type { SortDir, SortKey } from './model';

export function PortfolioTable({ items, sort, dir, onSort }: {
  items: ProjectSummary[];
  sort: SortKey;
  dir: SortDir;
  onSort: (key: SortKey) => void;
}) {
  const [focus, setFocus] = useState(-1);
  const rows = useRef(new Map<number, HTMLTableRowElement>());

  // Keep the focused row visible while moving with j/k.
  useEffect(() => {
    rows.current.get(focus)?.scrollIntoView({ block: 'nearest' });
  }, [focus]);
  useEffect(() => {
    if (focus >= items.length) setFocus(items.length - 1);
  }, [items.length, focus]);

  useHotkeys({
    j: () => setFocus((i) => Math.min(items.length - 1, i + 1)),
    k: () => setFocus((i) => Math.max(0, i - 1)),
  }, items.length > 0);

  // Enter opens the focused row — only when no control has the focus, so a focused button or link
  // keeps its own Enter behaviour (a bare "enter" hotkey would swallow it).
  const focused = items[focus];
  useEffect(() => {
    if (!focused) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (document.activeElement && document.activeElement !== document.body) return;
      e.preventDefault();
      navigate(paths.project(focused.id));
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [focused]);

  const head = (label: ReactNode, key?: SortKey, className?: string) => (
    <th scope="col" className={cls('px-3 py-2.5 text-left', className)} aria-sort={key && sort === key ? (dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      {key ? (
        <button type="button" onClick={() => onSort(key)} className={cls('label-xs inline-flex items-center gap-1 hover:text-zinc-800 dark:hover:text-zinc-200', sort === key && 'text-brand-600 dark:text-brand-400')}>
          {label}
          {sort === key ? (dir === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />) : <ChevronsUpDown size={11} className="opacity-40" />}
        </button>
      ) : <span className="label-xs">{label}</span>}
    </th>
  );

  return (
    <div className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[1080px] border-collapse text-sm">
          <thead className="border-b hairline bg-zinc-50/80 dark:bg-ink-900/40">
            <tr>
              {head('Key', 'key', 'w-[104px]')}
              {head('Project', 'title')}
              {head('Progress · stage', 'progress', 'w-[190px]')}
              {head('Open steps', undefined, 'w-[190px]')}
              {head('Risk', 'risk', 'w-[92px]')}
              {head('People', undefined, 'w-[72px]')}
              {head('Due', 'due', 'w-[118px]')}
              {head('Updated', 'updated', 'w-[92px]')}
            </tr>
          </thead>
          <tbody>
            {items.map((p, i) => (
              <tr
                key={p.id}
                ref={(el) => {
                  if (el) rows.current.set(i, el);
                  else rows.current.delete(i);
                }}
                onClick={(e) => {
                  if ((e.target as HTMLElement).closest('a,button')) return;
                  navigate(paths.project(p.id));
                }}
                onMouseEnter={() => setFocus(i)}
                className={cls(
                  'cursor-pointer border-b hairline transition-colors last:border-0',
                  focus === i ? 'bg-brand-50/60 dark:bg-brand-500/[0.06]' : 'hover:bg-zinc-50 dark:hover:bg-ink-700/50',
                  p.status === 'cancelled' && 'opacity-60',
                )}
              >
                <td className="px-3 py-2.5 align-top">
                  <div className="flex items-center gap-1.5">
                    {p.parent_id && <ChildMarker />}
                    <span className="num whitespace-nowrap text-xs font-bold text-zinc-700 dark:text-zinc-200">{p.key}</span>
                  </div>
                  <StatusBadge kind="project" value={p.status} size="xs" className="mt-1.5" />
                </td>
                <td className="max-w-0 px-3 py-2.5 align-top">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <PriorityFlag priority={p.priority} />
                    <Link to={paths.project(p.id)} className="truncate font-semibold text-zinc-900 hover:text-brand-600 dark:text-zinc-100 dark:hover:text-brand-400">
                      {p.title}
                    </Link>
                  </div>
                  <div className="mt-1 flex min-w-0 flex-wrap items-center gap-1">
                    <BlueprintChip blueprintId={p.blueprint_id} name={p.blueprint_name} />
                    {p.child_count > 0 && (
                      <span className="num text-[11px] text-muted">
                        · {p.children_done}/{p.child_count} children done
                      </span>
                    )}
                    {p.tags.slice(0, 2).map((t) => (
                      <span key={t} className="rounded bg-zinc-100 px-1.5 py-px text-[10px] font-medium text-zinc-600 dark:bg-ink-600 dark:text-zinc-300">#{t}</span>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2.5 align-top">
                  <PipelineStrip summary={p} size="sm" />
                </td>
                <td className="max-w-0 px-3 py-2.5 align-top">
                  <OpenSteps names={p.open_step_names} statuses={p.open_step_statuses} />
                </td>
                <td className="px-3 py-2.5 align-top"><RiskBadge risk={p.risk} /></td>
                <td className="px-3 py-2.5 align-top"><PeoplePair sponsorId={p.sponsor_id} ownerId={p.owner_id} /></td>
                <td className="px-3 py-2.5 align-top"><DueChip due={p.due_date} status={p.status} /></td>
                <td className="px-3 py-2.5 align-top">
                  <span className="whitespace-nowrap text-xs text-muted" title={formatDateTime(p.updated_at)}>{timeAgo(p.updated_at)}</span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
