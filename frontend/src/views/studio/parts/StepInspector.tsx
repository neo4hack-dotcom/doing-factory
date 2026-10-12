// Right-hand inspector of the Blueprint Designer: the selected step's common fields (identity,
// assignment, SLA, condition, output variable) and its type-specific configuration — or, when a
// stage is selected, the stage's own fields.
import { AlertCircle, AlertTriangle, Copy, MousePointerClick, Trash2, X } from 'lucide-react';
import { STEP_TYPES, STEP_TYPE_ORDER } from '../../../types';
import type { StageDef, StepDef, StepType } from '../../../types';
import { StepIcon } from '../../../components/StepIcon';
import {
  Field, IconButton, Input, Select, TONE, Textarea, Toggle, cls, toneOf, useConfirm,
} from '../../../components/ui';
import { ExprInput, MONO, MultiPick, Section } from './editors';
import { PROJECT_ROLES, StepConfigForm, roleOptions } from './StepConfigForms';
import type { ConfigContext } from './StepConfigForms';
import { SLUG_RE, STAGE_TONES } from './model';

export interface StepIssues {
  errors: string[];
  warnings: string[];
}

export function IssueList({ issues }: { issues: StepIssues }) {
  if (!issues.errors.length && !issues.warnings.length) return null;
  return (
    <div className="space-y-1.5">
      {issues.errors.map((m, i) => (
        <p key={`e${i}`} className="flex items-start gap-1.5 rounded-lg bg-rose-50 px-2.5 py-1.5 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
          <AlertCircle size={13} className="mt-0.5 shrink-0" />{m}
        </p>
      ))}
      {issues.warnings.map((m, i) => (
        <p key={`w${i}`} className="flex items-start gap-1.5 rounded-lg bg-amber-50 px-2.5 py-1.5 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
          <AlertTriangle size={13} className="mt-0.5 shrink-0" />{m}
        </p>
      ))}
    </div>
  );
}

export function StepInspector({ ctx, allIds, issues, onPatch, onDuplicate, onDelete, onClose }: {
  ctx: ConfigContext;
  /** Ids of every step in the blueprint (uniqueness check). */
  allIds: string[];
  issues: StepIssues;
  onPatch: (patch: Partial<StepDef>) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const confirm = useConfirm();
  const { step } = ctx;
  const meta = STEP_TYPES[step.type];
  const duplicateId = allIds.filter((id) => id === step.id).length > 1;
  const idError = !step.id ? 'Required' : !SLUG_RE.test(step.id) ? 'Lowercase slug: letters, digits, underscores' : duplicateId ? 'Another step uses this id' : undefined;

  const changeType = async (type: StepType) => {
    if (type === step.type) return;
    const hasConfig = Object.keys(step.config ?? {}).length > 0;
    if (hasConfig && !(await confirm({
      title: `Change to ${STEP_TYPES[type].label}?`,
      message: `The ${meta?.label ?? step.type} configuration of this step will be cleared.`,
      tone: 'warning', confirmLabel: 'Change type',
    }))) return;
    onPatch({ type, config: {} });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start gap-3 border-b hairline px-4 py-3">
        <StepIcon type={step.type} size="lg" />
        <div className="min-w-0 flex-1">
          <div className="label-xs">{meta?.label ?? step.type}</div>
          <div className="truncate text-sm font-bold text-zinc-900 dark:text-white">{step.name || step.id || 'Untitled step'}</div>
          <p className="mt-0.5 line-clamp-2 text-[11px] text-muted">{meta?.description}</p>
        </div>
        <div className="flex shrink-0 items-center">
          <IconButton icon={Copy} label="Duplicate step" size="sm" onClick={onDuplicate} />
          <IconButton icon={Trash2} label="Delete step" size="sm" onClick={onDelete} />
          <IconButton icon={X} label="Close inspector" size="sm" onClick={onClose} />
        </div>
      </div>
      <div className="flex-1 space-y-6 overflow-y-auto px-4 py-4">
        <IssueList issues={issues} />

        <Section title="Step">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" required>
              <Input value={step.name} onChange={(e) => onPatch({ name: e.target.value })} />
            </Field>
            <Field label="Id" required error={idError} help="Unique in the blueprint">
              <Input value={step.id} onChange={(e) => onPatch({ id: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} className={MONO} invalid={!!idError} />
            </Field>
          </div>
          <Field label="Type">
            <Select value={step.type} onChange={(e) => void changeType(e.target.value as StepType)}
              options={STEP_TYPE_ORDER.map((t) => ({ value: t, label: STEP_TYPES[t].label }))} />
          </Field>
          <Field label="Description" help="Shown to assignees and in the project pipeline">
            <Textarea value={step.description} onChange={(e) => onPatch({ description: e.target.value })} minRows={2} />
          </Field>
        </Section>

        <Section title="Assignment & timing" hint={meta?.automated ? 'Automated step: assignees handle confirmations and failures.' : 'The people who act on this step.'}>
          <Field label="Roles">
            <MultiPick value={step.assignee.roles} onChange={(roles) => onPatch({ assignee: { ...step.assignee, roles } })}
              options={roleOptions(ctx.roles)} placeholder="No role" emptyHint="No role defined — Settings › People & Teams." />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="People">
              <MultiPick value={step.assignee.user_ids} onChange={(user_ids) => onPatch({ assignee: { ...step.assignee, user_ids } })}
                options={ctx.users.filter((u) => u.active).map((u) => ({ value: u.id, label: u.name, hint: u.title || u.email }))} placeholder="Nobody specific" />
            </Field>
            <Field label="Project role">
              <Select value={step.assignee.project_role} onChange={(e) => onPatch({ assignee: { ...step.assignee, project_role: e.target.value as StepDef['assignee']['project_role'] } })}
                options={PROJECT_ROLES} />
            </Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="SLA (hours)" help="Empty = no SLA">
              <Input type="number" min={0} step="0.5" value={step.sla_hours ?? ''} placeholder="—"
                onChange={(e) => onPatch({ sla_hours: e.target.value === '' ? null : Math.max(0, Number(e.target.value)) })} />
            </Field>
            <Field label="Store output as" help={`Read as vars.${step.store_as || step.id || '…'}`}
              error={step.store_as && !SLUG_RE.test(step.store_as) ? 'Lowercase slug' : undefined}>
              <Input value={step.store_as} placeholder={step.id} className={MONO}
                onChange={(e) => onPatch({ store_as: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} />
            </Field>
          </div>
          <ExprInput label="Run when" value={step.when} onChange={(when) => onPatch({ when })} vars={ctx.vars}
            placeholder="inputs.needs_security_review" help="Jinja condition; empty = always. False → the step is skipped (and the trace says why)." />
          <Toggle checked={step.auto_start} onChange={(auto_start) => onPatch({ auto_start })} label="Start automatically"
            description="Off: the step waits until someone presses Start." />
        </Section>

        <Section title={`${meta?.label ?? 'Step'} configuration`}>
          <StepConfigForm ctx={ctx} />
        </Section>
      </div>
    </div>
  );
}

export function StageInspector({ stage, allIds, onPatch, onDelete, onClose }: {
  stage: StageDef;
  allIds: string[];
  onPatch: (patch: Partial<StageDef>) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const dup = allIds.filter((id) => id === stage.id).length > 1;
  const idError = !stage.id ? 'Required' : !SLUG_RE.test(stage.id) ? 'Lowercase slug' : dup ? 'Another stage uses this id' : undefined;
  const tone = toneOf(stage.color);
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-start gap-3 border-b hairline px-4 py-3">
        <span className={cls('mt-1 h-8 w-1.5 shrink-0 rounded-full', TONE[tone].dot)} />
        <div className="min-w-0 flex-1">
          <div className="label-xs">Stage</div>
          <div className="truncate text-sm font-bold text-zinc-900 dark:text-white">{stage.name || stage.id}</div>
          <p className="text-[11px] text-muted">{stage.steps.length} step{stage.steps.length === 1 ? '' : 's'} · {stage.parallel ? 'parallel' : 'sequential'}</p>
        </div>
        <IconButton icon={Trash2} label="Delete stage" size="sm" onClick={onDelete} />
        <IconButton icon={X} label="Close inspector" size="sm" onClick={onClose} />
      </div>
      <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name" required><Input value={stage.name} onChange={(e) => onPatch({ name: e.target.value })} /></Field>
          <Field label="Id" required error={idError}>
            <Input value={stage.id} className={MONO} invalid={!!idError} onChange={(e) => onPatch({ id: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} />
          </Field>
        </div>
        <Field label="Description">
          <Textarea value={stage.description} onChange={(e) => onPatch({ description: e.target.value })} minRows={2} />
        </Field>
        <Field label="Colour">
          <ToneSwatches value={stage.color} onChange={(color) => onPatch({ color })} />
        </Field>
        <Toggle checked={stage.parallel} onChange={(parallel) => onPatch({ parallel })} label="Run steps in parallel"
          description="All eligible steps start together (bounded by the engine's parallel limit). Off: one after the other." />
      </div>
    </div>
  );
}

export function ToneSwatches({ value, onChange }: { value: string; onChange: (tone: string) => void }) {
  const current = toneOf(value);
  return (
    <div className="flex flex-wrap gap-1.5">
      {STAGE_TONES.map((t) => (
        <button key={t} type="button" title={t} aria-label={t} aria-pressed={current === t} onClick={() => onChange(t)}
          className={cls('h-6 w-6 rounded-full ring-offset-2 ring-offset-white transition dark:ring-offset-ink-900', TONE[t].dot,
            current === t ? 'ring-2 ring-zinc-900 dark:ring-white' : 'hover:scale-110')} />
      ))}
    </div>
  );
}

export function EmptyInspector() {
  return (
    <div className="grid h-full place-items-center p-6 text-center">
      <div>
        <MousePointerClick size={28} className="mx-auto text-faint" />
        <p className="mt-2 text-sm font-semibold text-zinc-700 dark:text-zinc-200">Select a step or a stage</p>
        <p className="mt-1 text-xs text-muted">Its settings open here. Add steps with “+ Add step” in a stage.</p>
      </div>
    </div>
  );
}
