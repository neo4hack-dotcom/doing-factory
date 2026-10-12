// Portfolio board: one column per status group, or per stage when a single blueprint is selected.
// Read-only on purpose — a project moves when its workflow moves, never by drag and drop.
import { Inbox } from 'lucide-react';
import { PipelineStrip } from '../../components/PipelineStrip';
import { Badge, TONE, Tooltip, toneOf } from '../../components/ui';
import { cls } from '../../lib/cls';
import { timeAgo } from '../../lib/format';
import { Link, paths } from '../../lib/router';
import type { Blueprint, ProjectSummary } from '../../types';
import { BlueprintChip, ChildMarker, DueChip, OpenSteps, PeoplePair, PriorityFlag, RiskBadge } from './bits';
import { boardColumns } from './model';

export function PortfolioBoard({ items, blueprint }: { items: ProjectSummary[]; blueprint?: Blueprint | null }) {
  const columns = boardColumns(items, blueprint);
  return (
    <div className="no-scrollbar -mx-1 flex gap-3 overflow-x-auto px-1 pb-2">
      {columns.map((col) => {
        const tone = toneOf(col.tone);
        return (
          <section key={col.id} className="flex w-[290px] min-w-[260px] flex-1 shrink-0 flex-col rounded-xl border surface-deep">
            <header className="flex items-center justify-between gap-2 border-b hairline px-3 py-2.5">
              <Tooltip content={col.hint}>
                <span className="flex min-w-0 items-center gap-2">
                  <span className={cls('h-2 w-2 shrink-0 rounded-full', TONE[tone].dot)} />
                  <span className="truncate text-xs font-bold uppercase tracking-[0.12em] text-zinc-700 dark:text-zinc-200">{col.label}</span>
                </span>
              </Tooltip>
              <Badge tone={col.items.length ? tone : 'zinc'} size="xs"><span className="num">{col.items.length}</span></Badge>
            </header>
            <div className="flex max-h-[calc(100vh-300px)] min-h-[120px] flex-col gap-2 overflow-y-auto p-2">
              {col.items.length === 0 ? (
                <div className="flex flex-1 flex-col items-center justify-center gap-1 py-6 text-xs text-faint">
                  <Inbox size={16} className="opacity-60" />
                  Nothing here
                </div>
              ) : col.items.map((p) => <BoardCard key={p.id} p={p} showBlueprint={!blueprint} />)}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function BoardCard({ p, showBlueprint }: { p: ProjectSummary; showBlueprint: boolean }) {
  return (
    <Link
      to={paths.project(p.id)}
      className={cls(
        'card block p-3 transition-all hover:-translate-y-px hover:border-brand-500/60 hover:shadow-sm',
        p.status === 'cancelled' && 'opacity-60',
      )}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5">
          {p.parent_id && <ChildMarker />}
          <span className="num text-[11px] font-bold text-muted">{p.key}</span>
          <PriorityFlag priority={p.priority} />
        </span>
        <RiskBadge risk={p.risk} showScore={false} />
      </div>
      <div className="mt-1 line-clamp-2 text-sm font-semibold leading-snug text-zinc-900 dark:text-zinc-100">{p.title}</div>
      {showBlueprint && <BlueprintChip blueprintId={p.blueprint_id} name={p.blueprint_name} className="mt-1.5" />}
      <PipelineStrip summary={p} size="sm" className="mt-2.5" />
      {p.open_step_names.length > 0 && (
        <div className="mt-2 min-w-0"><OpenSteps names={p.open_step_names} statuses={p.open_step_statuses} /></div>
      )}
      <div className="mt-2.5 flex items-center justify-between gap-2 border-t hairline pt-2">
        <PeoplePair sponsorId={p.sponsor_id} ownerId={p.owner_id} size={20} />
        <span className="flex items-center gap-2">
          {p.child_count > 0 && <span className="num text-[11px] text-muted">{p.children_done}/{p.child_count} children</span>}
          {p.due_date ? <DueChip due={p.due_date} status={p.status} /> : <span className="text-[11px] text-faint">{timeAgo(p.updated_at)}</span>}
        </span>
      </div>
    </Link>
  );
}
