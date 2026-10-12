// The project's workflow at a glance: one lane per stage (left → right), its steps top → bottom.
// A step node shows its type and status, pulses while running, flags AI contributions, SLA breaches
// and retries, and highlights the steps the current persona can act on. Parallel stages draw their
// steps as one stacked group instead of a sequence. Clicking a node opens the step drawer.
import { AlarmClock, ChevronRight, RotateCcw, Sparkles, Split } from 'lucide-react';
import { StepIcon } from '../../components/StepIcon';
import { AvatarStack, Badge, TONE, Tooltip, toneOf } from '../../components/ui';
import { cls } from '../../lib/cls';
import { dueLabel, formatDuration } from '../../lib/format';
import { STAGE_STATUS, STEP_STATUS } from '../../lib/status';
import { useApp } from '../../lib/store';
import type { Project, StageRun, StepRun } from '../../types';
import { hasAiContribution, stepDurationMs } from './model';

export function PipelineLanes({ project, selectedStepId, onSelect, canAct }: {
  project: Project;
  selectedStepId?: string;
  onSelect: (stepId: string) => void;
  /** Whether the current persona can act on a step now (highlighted as "Your turn"). */
  canAct: (stage: StageRun, step: StepRun) => boolean;
}) {
  const finished = project.status === 'done' || project.status === 'cancelled';
  return (
    <div className="no-scrollbar -mx-1 flex items-stretch gap-1 overflow-x-auto px-1 pb-1">
      {project.stages.map((stage, i) => {
        const current = stage.id === project.current_stage_id && !finished;
        const meta = STAGE_STATUS[stage.status] ?? STAGE_STATUS.pending;
        const tone = toneOf(stage.color);
        const done = stage.steps.filter((s) => s.status === 'done' || s.status === 'skipped').length;
        return (
          <div key={stage.id} className="flex min-w-[218px] flex-1 items-stretch">
            {i > 0 && (
              <div className="flex w-5 shrink-0 items-center justify-center">
                <ChevronRight size={16} className={cls(project.stages[i - 1].status === 'done' || project.stages[i - 1].status === 'skipped' ? 'text-emerald-500' : 'text-zinc-300 dark:text-ink-400')} />
              </div>
            )}
            <section
              aria-label={`Stage ${i + 1}: ${stage.name}`}
              className={cls(
                'flex min-w-0 flex-1 flex-col rounded-xl border transition-colors',
                current ? 'border-brand-500/50 bg-brand-50/40 shadow-sm dark:border-brand-500/40 dark:bg-brand-500/[0.04]' : 'surface-deep',
                stage.status === 'skipped' && 'hatched opacity-70',
              )}
            >
              <header className="px-3 pb-2 pt-2.5">
                <div className={cls('mb-2 h-1 rounded-full', stage.status === 'pending' ? 'bg-zinc-200 dark:bg-ink-500' : TONE[tone].dot)} />
                <div className="flex items-center justify-between gap-2">
                  <span className="label-xs truncate">Stage {i + 1}</span>
                  <span className={cls('num text-[10px] font-semibold', TONE[meta.tone].text)}>{done}/{stage.steps.length}</span>
                </div>
                <div className="mt-0.5 flex items-center gap-1.5">
                  <h3 className="truncate text-sm font-bold text-zinc-900 dark:text-white" title={stage.description || stage.name}>{stage.name}</h3>
                  {stage.parallel && (
                    <Tooltip content="These steps run in parallel">
                      <Split size={13} className="shrink-0 rotate-90 text-violet-500" aria-label="Parallel stage" />
                    </Tooltip>
                  )}
                </div>
              </header>
              <div className={cls('flex flex-1 flex-col px-2 pb-2', stage.parallel ? 'gap-1.5' : 'gap-0')}>
                {stage.parallel && stage.steps.length > 1 ? (
                  <div className="relative rounded-lg border border-dashed border-violet-400/50 p-1.5 pl-2.5 dark:border-violet-400/30">
                    <span className="absolute -top-2 left-2 bg-zinc-50 px-1 text-[9px] font-bold uppercase tracking-[0.14em] text-violet-600 dark:bg-ink-900 dark:text-violet-400">Parallel</span>
                    <div className="flex flex-col gap-1.5 pt-1">
                      {stage.steps.map((step) => (
                        <StepNode key={step.id} step={step} selected={step.id === selectedStepId} mine={canAct(stage, step)} onClick={() => onSelect(step.id)} />
                      ))}
                    </div>
                  </div>
                ) : stage.steps.map((step, j) => (
                  <div key={step.id}>
                    {j > 0 && (
                      <div className="flex h-2.5 justify-center">
                        <span className={cls('w-px', stage.steps[j - 1].status === 'done' || stage.steps[j - 1].status === 'skipped' ? 'bg-emerald-400' : 'bg-zinc-300 dark:bg-ink-400')} />
                      </div>
                    )}
                    <StepNode step={step} selected={step.id === selectedStepId} mine={canAct(stage, step)} onClick={() => onSelect(step.id)} />
                  </div>
                ))}
                {stage.steps.length === 0 && <p className="px-1 py-3 text-center text-[11px] text-faint">No steps</p>}
              </div>
            </section>
          </div>
        );
      })}
    </div>
  );
}

function StepNode({ step, selected, mine, onClick }: { step: StepRun; selected: boolean; mine: boolean; onClick: () => void }) {
  const { userById } = useApp();
  const meta = STEP_STATUS[step.status] ?? STEP_STATUS.pending;
  const running = step.status === 'running' || step.ai_busy;
  const waiting = meta.waiting && step.status !== 'failed';
  const elapsed = stepDurationMs(step);
  const due = step.due_at && !['done', 'skipped'].includes(step.status) ? dueLabel(step.due_at) : null;
  const assignees = waiting ? step.assignee_user_ids.map((id) => userById(id)) : [];
  const ai = hasAiContribution(step);

  let line: string = meta.label;
  if (step.status === 'running' && elapsed !== null) line = `Running · ${formatDuration(elapsed)}`;
  else if ((step.status === 'done' || step.status === 'failed') && elapsed !== null) line = `${meta.label} · ${formatDuration(elapsed)}`;
  else if (step.ai_busy) line = 'AI drafting…';

  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={selected || undefined}
      className={cls(
        'group relative w-full rounded-lg border bg-white px-2.5 py-2 text-left transition-all hover:-translate-y-px hover:shadow-sm dark:bg-ink-800',
        selected ? 'border-brand-500 ring-2 ring-brand-500/25'
          : mine ? 'border-amber-400 dark:border-amber-500/60'
            : 'border-zinc-200 hover:border-zinc-300 dark:border-ink-500 dark:hover:border-ink-400',
        (step.status === 'skipped' || step.status === 'pending') && !selected && 'opacity-75',
      )}
    >
      {running && <span className="pointer-events-none absolute inset-0 rounded-lg ring-ai animate-pulse-slow" aria-hidden />}
      <div className="flex items-start gap-2">
        <StepIcon type={step.type} status={step.status} size="sm" className="mt-px" />
        <div className="min-w-0 flex-1">
          <div className="line-clamp-2 text-xs font-semibold leading-snug text-zinc-900 dark:text-zinc-100">{step.name}</div>
          <div className={cls('mt-0.5 truncate text-[10px] font-medium', TONE[meta.tone].text)}>{line}</div>
        </div>
      </div>
      {(mine || ai || step.sla_breached || step.attempts > 1 || due || assignees.length > 0) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1">
          {mine && <Badge tone="amber" variant="solid" size="xs">Your turn</Badge>}
          {ai && (
            <Tooltip content={step.ai_busy ? 'The AI is drafting' : step.ai_draft ? 'Pre-filled by the AI' : step.brief ? 'AI decision brief available' : 'Produced by the AI'}>
              <span className={cls('inline-flex items-center gap-0.5 text-[10px] font-semibold text-violet-600 dark:text-violet-400', step.ai_busy && 'animate-pulse')}>
                <Sparkles size={10} />AI
              </span>
            </Tooltip>
          )}
          {step.sla_breached && (
            <Tooltip content="SLA breached"><span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-rose-600 dark:text-rose-400"><AlarmClock size={10} />SLA</span></Tooltip>
          )}
          {!step.sla_breached && due && (due.overdue || due.soon) && (
            <span className={cls('text-[10px] font-semibold', due.overdue ? 'text-rose-600 dark:text-rose-400' : 'text-amber-600 dark:text-amber-400')}>{due.label}</span>
          )}
          {step.attempts > 1 && (
            <Tooltip content={`${step.attempts} attempts`}><span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-muted"><RotateCcw size={10} />{step.attempts}</span></Tooltip>
          )}
          {assignees.length > 0 && <AvatarStack users={assignees} size={16} max={3} className="ml-auto" />}
        </div>
      )}
    </button>
  );
}
