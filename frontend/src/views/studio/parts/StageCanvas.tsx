// The designer's canvas: one horizontal lane per stage (left → right = execution order), each with
// its steps top → bottom. Stages reorder with arrows or drag; steps reorder with arrows or drag
// (across stages too). "+ Add step" opens the palette of the 10 step types.
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Copy, GitBranch, GripVertical, Plus, Rows3, Trash2,
} from 'lucide-react';
import { useRef, useState } from 'react';
import type { DragEvent, RefObject } from 'react';
import { StepIcon } from '../../../components/StepIcon';
import { Badge, IconButton, Popover, TONE, Tooltip, cls, toneOf } from '../../../components/ui';
import { STEP_TYPES, STEP_TYPE_ORDER } from '../../../types';
import type { Blueprint, StepType } from '../../../types';
import type { StepRef } from './model';

export type Selection = { kind: 'step'; ref: StepRef } | { kind: 'stage'; stage: number } | null;

type Drag = { kind: 'step'; ref: StepRef } | { kind: 'stage'; stage: number };

export function StepPalette({ onPick, anchor, open, onClose }: {
  onPick: (type: StepType) => void;
  anchor: RefObject<HTMLElement | null>;
  open: boolean;
  onClose: () => void;
}) {
  return (
    <Popover anchor={anchor} open={open} onClose={onClose} width={360}>
      <div className="max-h-[26rem] overflow-y-auto p-1.5">
        <div className="label-xs px-2 pb-1.5 pt-1">Add a step</div>
        {STEP_TYPE_ORDER.map((type) => {
          const meta = STEP_TYPES[type];
          return (
            <button key={type} type="button" onClick={() => { onPick(type); onClose(); }}
              className="flex w-full items-start gap-2.5 rounded-lg px-2 py-2 text-left hover:bg-zinc-100 dark:hover:bg-ink-600">
              <StepIcon type={type} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="flex items-center gap-1.5 text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                  {meta.label}
                  <Badge size="xs" tone={meta.automated ? 'violet' : 'sky'}>{meta.automated ? 'automated' : 'human'}</Badge>
                </span>
                <span className="mt-0.5 block text-[11px] leading-snug text-muted">{meta.description}</span>
              </span>
            </button>
          );
        })}
      </div>
    </Popover>
  );
}

function AddStepButton({ onPick }: { onPick: (type: StepType) => void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={anchor} type="button" onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-zinc-300 py-2 text-xs font-semibold text-muted transition hover:border-brand-500 hover:bg-brand-500/5 hover:text-brand-600 dark:border-ink-400 dark:hover:text-brand-400">
        <Plus size={13} /> Add step
      </button>
      <StepPalette anchor={anchor} open={open} onClose={() => setOpen(false)} onPick={onPick} />
    </>
  );
}

export function StageCanvas({ bp, selection, onSelect, issues, onAddStep, onMoveStage, onMoveStep, onDuplicateStep, onDeleteStep, onDeleteStage, onAddStage }: {
  bp: Blueprint;
  selection: Selection;
  onSelect: (sel: Selection) => void;
  /** step id → counts of validation errors / warnings. */
  issues: Record<string, { errors: number; warnings: number }>;
  onAddStep: (stage: number, type: StepType) => void;
  onMoveStage: (from: number, to: number) => void;
  onMoveStep: (from: StepRef, toStage: number, toIndex: number) => void;
  onDuplicateStep: (ref: StepRef) => void;
  onDeleteStep: (ref: StepRef) => void;
  onDeleteStage: (stage: number) => void;
  onAddStage: () => void;
}) {
  const [drag, setDrag] = useState<Drag | null>(null);
  const [over, setOver] = useState<string>('');

  const allow = (e: DragEvent, key: string) => {
    if (!drag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (over !== key) setOver(key);
  };
  const end = () => { setDrag(null); setOver(''); };

  return (
    <div className="flex min-h-[28rem] items-stretch gap-3 overflow-x-auto pb-3 scroll-thin">
      {bp.stages.map((stage, si) => {
        const tone = toneOf(stage.color);
        const stageSelected = selection?.kind === 'stage' && selection.stage === si;
        const stageKey = `stage:${si}`;
        return (
          <div key={si} className="flex items-stretch">
            {si > 0 && (
              <div className="flex w-5 shrink-0 items-center justify-center" aria-hidden>
                <svg width="20" height="12" viewBox="0 0 20 12" className="text-zinc-300 dark:text-ink-400">
                  <path d="M0 6h15" stroke="currentColor" strokeWidth="1.5" strokeDasharray="3 3" className="animate-flow" />
                  <path d="M13 2l5 4-5 4" fill="none" stroke="currentColor" strokeWidth="1.5" />
                </svg>
              </div>
            )}
            <section
              onDragOver={(e) => drag?.kind === 'stage' && allow(e, stageKey)}
              onDrop={(e) => {
                if (drag?.kind !== 'stage') return;
                e.preventDefault();
                onMoveStage(drag.stage, si);
                end();
              }}
              className={cls('flex w-72 shrink-0 flex-col rounded-xl border bg-zinc-50/80 transition dark:bg-ink-900/60',
                stageSelected ? `${TONE[tone].border} ring-2 ${TONE[tone].ring}` : 'hairline',
                over === stageKey && drag?.kind === 'stage' && 'ring-2 ring-brand-500/40',
                drag?.kind === 'stage' && drag.stage === si && 'opacity-50')}
            >
              <header className="group relative overflow-hidden rounded-t-xl border-b hairline bg-white px-2.5 pb-2 pt-3 dark:bg-ink-800">
                <span className={cls('absolute inset-x-0 top-0 h-1', TONE[tone].dot)} />
                <div className="flex items-center gap-1">
                  <span draggable onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', stageKey); setDrag({ kind: 'stage', stage: si }); }}
                    onDragEnd={end} className="cursor-grab text-faint hover:text-zinc-600 active:cursor-grabbing dark:hover:text-zinc-300" title="Drag to reorder">
                    <GripVertical size={14} />
                  </span>
                  <button type="button" onClick={() => onSelect({ kind: 'stage', stage: si })} className="min-w-0 flex-1 text-left">
                    <div className="label-xs">Stage {si + 1}</div>
                    <div className="truncate text-sm font-bold text-zinc-900 dark:text-white">{stage.name || <span className="italic text-faint">Untitled</span>}</div>
                  </button>
                  <div className="flex shrink-0 items-center opacity-60 transition group-hover:opacity-100">
                    <IconButton icon={ArrowLeft} label="Move stage left" size="xs" disabled={si === 0} onClick={() => onMoveStage(si, si - 1)} />
                    <IconButton icon={ArrowRight} label="Move stage right" size="xs" disabled={si === bp.stages.length - 1} onClick={() => onMoveStage(si, si + 1)} />
                    <IconButton icon={Trash2} label="Delete stage" size="xs" onClick={() => onDeleteStage(si)} />
                  </div>
                </div>
                <div className="mt-1.5 flex items-center gap-1.5 pl-5 text-[11px] text-muted">
                  <span className="num">{stage.steps.length} step{stage.steps.length === 1 ? '' : 's'}</span>
                  <span className="text-faint">·</span>
                  {stage.parallel
                    ? <span className="inline-flex items-center gap-1 font-semibold text-indigo-600 dark:text-indigo-400"><GitBranch size={11} />parallel</span>
                    : <span className="inline-flex items-center gap-1"><Rows3 size={11} />sequential</span>}
                </div>
              </header>

              <ol className="flex flex-1 flex-col gap-1.5 p-2"
                onDragOver={(e) => drag?.kind === 'step' && allow(e, `end:${si}`)}
                onDrop={(e) => {
                  if (drag?.kind !== 'step') return;
                  e.preventDefault();
                  onMoveStep(drag.ref, si, stage.steps.length);
                  end();
                }}>
                {stage.steps.map((step, ti) => {
                  const ref = { stage: si, step: ti };
                  const selected = selection?.kind === 'step' && selection.ref.stage === si && selection.ref.step === ti;
                  const counts = issues[step.id];
                  const meta = STEP_TYPES[step.type];
                  const key = `step:${si}:${ti}`;
                  return (
                    <li key={`${step.id}-${ti}`}
                      draggable
                      onDragStart={(e) => { e.stopPropagation(); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', key); setDrag({ kind: 'step', ref }); }}
                      onDragEnd={end}
                      onDragOver={(e) => { if (drag?.kind === 'step') { e.stopPropagation(); allow(e, key); } }}
                      onDrop={(e) => {
                        if (drag?.kind !== 'step') return;
                        e.preventDefault();
                        e.stopPropagation();
                        onMoveStep(drag.ref, si, ti);
                        end();
                      }}
                      className={cls('group relative', over === key && drag?.kind === 'step' && 'before:absolute before:-top-1 before:inset-x-1 before:h-0.5 before:rounded-full before:bg-brand-500')}
                    >
                      <div role="button" tabIndex={0}
                        onClick={() => onSelect({ kind: 'step', ref })}
                        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSelect({ kind: 'step', ref }); } }}
                        className={cls('flex cursor-pointer items-center gap-2 rounded-lg border bg-white px-2 py-2 shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition dark:bg-ink-800',
                          selected ? 'border-brand-500 ring-2 ring-brand-500/25' : 'hairline hover:border-zinc-300 dark:hover:border-ink-400',
                          counts?.errors ? 'border-rose-400 dark:border-rose-500/60' : '',
                          drag?.kind === 'step' && drag.ref.stage === si && drag.ref.step === ti && 'opacity-40')}>
                        <StepIcon type={step.type} size="sm" />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-[13px] font-semibold text-zinc-800 dark:text-zinc-100">{step.name || <span className="italic text-faint">Untitled</span>}</div>
                          <div className="flex items-center gap-1 truncate text-[10.5px] text-faint">
                            <code className="truncate font-mono">{step.id}</code>
                            <span>·</span>
                            <span className="truncate">{meta?.label ?? step.type}</span>
                          </div>
                        </div>
                        {(counts?.errors || counts?.warnings) ? (
                          <Tooltip content={`${counts.errors} error(s), ${counts.warnings} warning(s) — select to see them`}>
                            <span className={cls('grid h-5 min-w-5 place-items-center rounded-full px-1 text-[10px] font-bold text-white', counts.errors ? 'bg-rose-500' : 'bg-amber-500')}>
                              {counts.errors || counts.warnings}
                            </span>
                          </Tooltip>
                        ) : null}
                        {step.when && <Tooltip content={<>Conditional: <code className="font-mono">{step.when}</code></>}><span className="text-[10px] font-bold text-sky-600 dark:text-sky-400">if</span></Tooltip>}
                      </div>
                      <div className="absolute right-1.5 top-1/2 z-10 hidden -translate-y-1/2 items-center rounded-md border hairline bg-white p-0.5 shadow-pop group-focus-within:flex group-hover:flex dark:bg-ink-800">
                        <IconButton icon={ArrowUp} label="Move up" size="xs" disabled={ti === 0} onClick={() => onMoveStep(ref, si, ti - 1)} />
                        <IconButton icon={ArrowDown} label="Move down" size="xs" disabled={ti === stage.steps.length - 1} onClick={() => onMoveStep(ref, si, ti + 2)} />
                        <IconButton icon={Copy} label="Duplicate" size="xs" onClick={() => onDuplicateStep(ref)} />
                        <IconButton icon={Trash2} label="Delete" size="xs" onClick={() => onDeleteStep(ref)} />
                      </div>
                    </li>
                  );
                })}
                {stage.steps.length === 0 && (
                  <li className={cls('rounded-lg border border-dashed px-3 py-4 text-center text-[11px] text-faint', over === `end:${si}` ? 'border-brand-500' : 'hairline')}>
                    Empty stage — completes immediately
                  </li>
                )}
                <li className={cls('mt-auto pt-1', over === `end:${si}` && stage.steps.length > 0 && 'border-t-2 border-brand-500')}>
                  <AddStepButton onPick={(type) => onAddStep(si, type)} />
                </li>
              </ol>
            </section>
          </div>
        );
      })}
      <div className="flex items-stretch pl-2">
        <button type="button" onClick={onAddStage}
          className="flex w-40 shrink-0 flex-col items-center justify-center gap-1.5 rounded-xl border-2 border-dashed border-zinc-300 text-xs font-semibold text-muted transition hover:border-brand-500 hover:bg-brand-500/5 hover:text-brand-600 dark:border-ink-400 dark:hover:text-brand-400">
          <Plus size={18} /> Add stage
        </button>
      </div>
    </div>
  );
}
