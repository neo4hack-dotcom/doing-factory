// Top stats bar of the Factory Floor: the six live numbers a delivery lead watches, each a deep
// link to the matching filtered list. LLM calls/min carries a 30-minute sparkline.
import { Ban, CheckCircle2, Hourglass, Layers, Sparkles, Workflow, type LucideIcon } from 'lucide-react';
import { Sparkline } from '../../components/Charts';
import { TONE } from '../../components/ui';
import { cls } from '../../lib/cls';
import { navigate, paths } from '../../lib/router';
import type { Tone } from '../../types';
import type { FloorStats } from './model';

interface Cell {
  label: string;
  value: number;
  icon: LucideIcon;
  tone: Tone;
  hint: string;
  to?: string;
  pulse?: boolean;
}

export function StatsBar({ stats, llmPerMinute, llmTrend }: { stats: FloorStats; llmPerMinute: number; llmTrend: number[] }) {
  const cells: Cell[] = [
    { label: 'In flight', value: stats.inFlight, icon: Layers, tone: 'brand', hint: 'Projects active, waiting or blocked', to: paths.projects({ status: 'open' }) },
    { label: 'Waiting on humans', value: stats.waitingHumans, icon: Hourglass, tone: 'amber', hint: 'A form, estimate or approval is open', to: paths.projects({ group: 'people' }), pulse: stats.waitingHumans > 0 },
    { label: 'AI steps running', value: stats.runningSteps, icon: Workflow, tone: 'violet', hint: 'Automated steps executing right now', pulse: stats.runningSteps > 0 },
    { label: 'Blocked', value: stats.blocked, icon: Ban, tone: 'rose', hint: 'Failed or blocked — needs a decision', to: paths.projects({ group: 'blocked' }) },
    { label: 'Completed today', value: stats.completedToday, icon: CheckCircle2, tone: 'emerald', hint: 'Projects finished since midnight', to: paths.projects({ status: 'done' }) },
  ];
  return (
    <div className="card grid grid-cols-2 divide-zinc-200 overflow-hidden sm:grid-cols-3 lg:grid-cols-6 lg:divide-x dark:divide-ink-600">
      {cells.map((c) => {
        const Icon = c.icon;
        const Tag = c.to ? 'button' : 'div';
        return (
          <Tag
            key={c.label}
            {...(c.to ? { type: 'button' as const, onClick: () => navigate(c.to!) } : {})}
            title={c.hint}
            className={cls('flex min-w-0 items-center gap-3 px-3.5 py-3 text-left', c.to && 'transition-colors hover:bg-zinc-50 dark:hover:bg-ink-700')}
          >
            <span className={cls('relative grid h-9 w-9 shrink-0 place-items-center rounded-lg', TONE[c.tone].icon)}>
              <Icon size={17} />
              {c.pulse && <span className={cls('absolute -right-0.5 -top-0.5 h-2 w-2 animate-pulse rounded-full', TONE[c.tone].dot)} />}
            </span>
            <span className="min-w-0">
              <span className="num block text-2xl font-bold leading-none tracking-tight text-zinc-900 transition-all dark:text-white">{c.value}</span>
              <span className="label-xs mt-1 block leading-tight">{c.label}</span>
            </span>
          </Tag>
        );
      })}
      <div className="relative flex min-w-0 items-center gap-3 px-3.5 py-3" title="LLM calls in the last minute (sparkline: last 30 minutes)">
        <span className="btn-ai grid h-9 w-9 shrink-0 place-items-center rounded-lg shadow-none"><Sparkles size={17} /></span>
        <span className="min-w-0">
          <span className="num block text-2xl font-bold leading-none tracking-tight text-zinc-900 dark:text-white">{llmPerMinute}</span>
          <span className="label-xs mt-1 block leading-tight">LLM calls / min</span>
        </span>
        <Sparkline values={llmTrend} width={56} height={22} className="ml-auto hidden shrink-0 2xl:block" />
      </div>
    </div>
  );
}
