// Small chips shared by the portfolio (table, board, tree) and the project page, so a blueprint, a
// risk or a due date looks the same wherever a project appears.
import { AlarmClock, CalendarClock, Flag, GitFork } from 'lucide-react';
import { iconByName } from '../../components/StepIcon';
import { Avatar, Badge, TONE, Tooltip, toneOf } from '../../components/ui';
import { cls } from '../../lib/cls';
import { dueLabel, formatDate } from '../../lib/format';
import { PRIORITY, RISK, STEP_STATUS } from '../../lib/status';
import { useApp } from '../../lib/store';
import type { Priority, ProjectStatus, Risk, StepStatus } from '../../types';

/** Blueprint name with its icon and colour (falls back to the name stored on the project). */
export function BlueprintChip({ blueprintId, name, size = 'xs', className }: {
  blueprintId: string; name?: string; size?: 'xs' | 'sm'; className?: string;
}) {
  const { blueprintById } = useApp();
  const bp = blueprintById(blueprintId);
  const Icon = iconByName(bp?.icon);
  return (
    <Badge tone={toneOf(bp?.color ?? 'zinc')} size={size} icon={Icon} className={className} title={bp?.description}>
      {bp?.name ?? name ?? 'Unknown blueprint'}
    </Badge>
  );
}

/** "High · 72" risk chip; the reasons show on hover. */
export function RiskBadge({ risk, size = 'xs', showScore = true, className }: {
  risk: Risk; size?: 'xs' | 'sm'; showScore?: boolean; className?: string;
}) {
  const meta = RISK[risk.level] ?? RISK.low;
  const reasons = risk.reasons?.length ? risk.reasons.join(' · ') : 'No risk signal';
  return (
    <Tooltip content={<><b>{meta.label} · {risk.score}/100</b><br />{reasons}</>}>
      <Badge tone={meta.tone} size={size} dot className={className}>
        {risk.level === 'low' ? 'Low' : risk.level === 'medium' ? 'Medium' : 'High'}
        {showScore && <span className="num ml-0.5 opacity-70">{risk.score}</span>}
      </Badge>
    </Tooltip>
  );
}

/** Flag for high / critical priorities (low and medium stay quiet to keep lists calm). */
export function PriorityFlag({ priority, always, className }: { priority: Priority; always?: boolean; className?: string }) {
  if (!always && priority !== 'high' && priority !== 'critical') return null;
  const meta = PRIORITY[priority];
  return (
    <Tooltip content={`${meta.label} priority`}>
      <Flag size={12} className={cls(TONE[meta.tone].text, 'shrink-0', className)} aria-label={`${meta.label} priority`} />
    </Tooltip>
  );
}

/** Due date with urgency; finished projects show the plain date. */
export function DueChip({ due, status, className }: { due?: string | null; status?: ProjectStatus; className?: string }) {
  if (!due) return <span className={cls('text-xs text-faint', className)}>—</span>;
  const finished = status === 'done' || status === 'cancelled';
  const d = dueLabel(due);
  if (finished || (!d.overdue && !d.soon)) {
    return (
      <span title={`Due ${formatDate(due)}`} className={cls('inline-flex items-center gap-1 whitespace-nowrap text-xs text-muted', className)}>
        <CalendarClock size={12} className="shrink-0 opacity-70" />{formatDate(due, true)}
      </span>
    );
  }
  return (
    <Badge tone={d.overdue ? 'rose' : 'amber'} size="xs" icon={AlarmClock} title={`Due ${formatDate(due)}`} className={className}>
      {d.label}
    </Badge>
  );
}

/** Sponsor and owner avatars with role tooltips. */
export function PeoplePair({ sponsorId, ownerId, size = 22 }: { sponsorId: string; ownerId: string; size?: number }) {
  const { userById } = useApp();
  const sponsor = userById(sponsorId);
  const owner = userById(ownerId);
  if (!sponsor && !owner) return <span className="text-xs text-faint">—</span>;
  return (
    <div className="flex items-center -space-x-1.5">
      {sponsor && <Avatar user={sponsor} size={size} title={`Sponsor · ${sponsor.name}`} className="ring-2 ring-white dark:ring-ink-800" />}
      {owner && owner.id !== sponsor?.id && <Avatar user={owner} size={size} title={`Owner · ${owner.name}`} className="ring-2 ring-white dark:ring-ink-800" />}
    </div>
  );
}

/** First open step with its status colour, "+N" for the others. */
export function OpenSteps({ names, statuses, className }: { names: string[]; statuses: StepStatus[]; className?: string }) {
  if (!names.length) return <span className={cls('text-xs text-faint', className)}>—</span>;
  const first = statuses[0];
  const meta = first ? STEP_STATUS[first] : null;
  return (
    <Tooltip content={names.map((n, i) => (
      <span key={i} className="block">{n}{statuses[i] ? ` · ${STEP_STATUS[statuses[i]]?.label ?? statuses[i]}` : ''}</span>
    ))}>
      <span className={cls('inline-flex min-w-0 max-w-full items-center gap-1.5 text-xs', className)}>
        <span className={cls('h-1.5 w-1.5 shrink-0 rounded-full', meta ? TONE[meta.tone].dot : 'bg-zinc-400', first === 'running' && 'animate-pulse')} />
        <span className="truncate text-zinc-700 dark:text-zinc-300">{names[0]}</span>
        {names.length > 1 && <span className="num shrink-0 text-faint">+{names.length - 1}</span>}
      </span>
    </Tooltip>
  );
}

/** "Child of a fan-out" marker. */
export function ChildMarker({ className }: { className?: string }) {
  return (
    <Tooltip content="Child project started by a fan-out step">
      <GitFork size={12} className={cls('shrink-0 text-indigo-500', className)} aria-label="Child project" />
    </Tooltip>
  );
}
