// Compact stage progress: one segment per stage, coloured by state, with the current stage named.
// Works from a full Project (exact stage/step states) or a ProjectSummary (list views: stages come
// from the blueprint, the current stage from the summary).
import { useApp } from '../lib/store';
import { cls } from '../lib/cls';
import { formatPercent } from '../lib/format';
import type { Project, ProjectSummary, StageRun, StepStatus, Tone } from '../types';
import { TONE, Tooltip } from './ui';

interface Segment {
  id: string;
  name: string;
  tone: Tone | 'pending' | 'skipped';
  /** 0-1 fill of the segment (partial for the active stage). */
  fill: number;
  detail: string;
}

/** Tone of an in-flight stage from its open step statuses: failure > needs a person > running. */
export function activeTone(statuses: StepStatus[]): Tone {
  if (statuses.some((s) => s === 'failed' || s === 'rejected')) return 'rose';
  if (statuses.some((s) => s === 'waiting_human' || s === 'waiting_approval')) return 'amber';
  return 'sky';
}

function fromStages(stages: StageRun[], projectDone: boolean): Segment[] {
  return stages.map((st) => {
    const total = st.steps.length;
    const finished = st.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
    const detail = `${finished}/${total} steps`;
    if (st.status === 'done' || projectDone) return { id: st.id, name: st.name, tone: 'emerald', fill: 1, detail: `Done · ${detail}` };
    if (st.status === 'skipped') return { id: st.id, name: st.name, tone: 'skipped', fill: 1, detail: 'Skipped' };
    if (st.status === 'active') {
      const tone = activeTone(st.steps.map((s) => s.status));
      const label = tone === 'rose' ? 'Needs attention' : tone === 'amber' ? 'Waiting for people' : 'In progress';
      return { id: st.id, name: st.name, tone, fill: total ? Math.max(0.15, finished / total) : 0.5, detail: `${label} · ${detail}` };
    }
    return { id: st.id, name: st.name, tone: 'pending', fill: 0, detail: `Not started · ${total} steps` };
  });
}

export function PipelineStrip({ project, summary, showLabel = true, size = 'md', className }: {
  project?: Project | null;
  summary?: ProjectSummary | null;
  /** Current stage name + percentage under the bar. */
  showLabel?: boolean;
  size?: 'sm' | 'md';
  className?: string;
}) {
  const { blueprintById } = useApp();
  const status = project?.status ?? summary?.status;
  const done = status === 'done';
  const inactive = status === 'cancelled';
  let segments: Segment[] = [];
  let currentName = '';
  let progress = 0;

  if (project) {
    segments = fromStages(project.stages, done);
    const steps = project.stages.flatMap((s) => s.steps);
    progress = steps.length ? steps.filter((s) => s.status === 'done' || s.status === 'skipped').length / steps.length : 0;
    currentName = project.stages.find((s) => s.id === project.current_stage_id)?.name ?? '';
  } else if (summary) {
    progress = summary.progress;
    currentName = summary.current_stage_name;
    const stages = blueprintById(summary.blueprint_id)?.stages ?? [];
    const current = stages.findIndex((s) => s.id === summary.current_stage_id);
    segments = stages.map((st, i) => {
      if (done || (current >= 0 && i < current)) return { id: st.id, name: st.name, tone: 'emerald', fill: 1, detail: 'Done' };
      if (i === current) {
        const tone = activeTone(summary.open_step_statuses);
        return { id: st.id, name: st.name, tone, fill: 0.5, detail: summary.open_step_names.join(', ') || 'In progress' };
      }
      return { id: st.id, name: st.name, tone: 'pending', fill: 0, detail: 'Not started' };
    });
  }

  const label = done ? 'Delivered' : inactive ? 'Cancelled' : currentName || (segments.length ? 'Not started' : '');
  const height = size === 'sm' ? 'h-1.5' : 'h-2';

  return (
    <div className={cls('min-w-0', inactive && 'opacity-50', className)}>
      {segments.length > 0 ? (
        <div className="flex gap-0.5">
          {segments.map((seg) => (
            <Tooltip key={seg.id} className="min-w-0 flex-1" content={<><b>{seg.name}</b> · {seg.detail}</>}>
              <span className={cls('relative block w-full overflow-hidden rounded-full bg-zinc-200 dark:bg-ink-500', height, seg.tone === 'skipped' && 'hatched')}>
                {seg.tone !== 'pending' && seg.tone !== 'skipped' && (
                  <span
                    className={cls('absolute inset-y-0 left-0 rounded-full', TONE[seg.tone].dot, seg.tone === 'sky' && 'stripes animate-progress-stripes')}
                    style={{ width: `${Math.round(seg.fill * 100)}%` }}
                  />
                )}
              </span>
            </Tooltip>
          ))}
        </div>
      ) : (
        <div className={cls('overflow-hidden rounded-full bg-zinc-200 dark:bg-ink-500', height)}>
          <div className="h-full rounded-full bg-brand-500" style={{ width: `${Math.round(progress * 100)}%` }} />
        </div>
      )}
      {showLabel && (
        <div className="mt-1.5 flex items-center justify-between gap-2 text-[11px]">
          <span className="truncate font-medium text-zinc-600 dark:text-zinc-300">{label}</span>
          <span className="num shrink-0 text-faint">{formatPercent(progress)}</span>
        </div>
      )}
    </div>
  );
}
