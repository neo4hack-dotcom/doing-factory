// Pure helpers for the Blueprint Designer: config defaults (mirror of models.py), immutable edit
// operations on a draft, the Jinja context a step can read, and mapping of the backend validation
// messages back to the steps they concern. No React here: everything is easy to reason about.
import { STEP_TYPES } from '../../../types';
import type {
  Blueprint, FieldDef, StageDef, StepConfigMap, StepDef, StepType, Tone, ValidationReport,
} from '../../../types';

// ---------------------------------------------------------------------------------------------
// Slugs (same rule as backend util.slugify: lowercase ascii, underscores)
// ---------------------------------------------------------------------------------------------

export function slugify(text: string, max = 64): string {
  return text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, max)
    .replace(/_+$/, '');
}

export const SLUG_RE = /^[a-z][a-z0-9_]*$/;

/** `base`, else `base_2`, `base_3`… — the first not in `taken`. */
export function uniqueSlug(base: string, taken: Iterable<string>): string {
  const set = new Set(taken);
  const root = slugify(base) || 'item';
  let key = root;
  for (let n = 2; set.has(key); n++) key = `${root}_${n}`;
  return key;
}

// ---------------------------------------------------------------------------------------------
// Defaults (models.py)
// ---------------------------------------------------------------------------------------------

export const CONFIG_DEFAULTS: { [K in StepType]: StepConfigMap[K] } = {
  ai_task: { prompt: '', system_prompt: 'writer', output: 'markdown', json_schema: null, artifact_title: '', review: false, include_context: true },
  human_form: { fields: [], instructions: '', ai_prefill: '', artifact_title: '', include_context: true },
  approval: { approvers: [], policy: 'all', quorum: 1, on_reject: { action: 'reopen', goto_step: '' }, brief_prompt: '', show_vars: [] },
  estimation: { unit: 'days', ai_suggest: true, prompt: '', require_breakdown: false },
  mcp_operation: { operation_key: '', input: {}, create_link: null },
  agent_task: { goal: '', connector_ids: [], allowed_tools: [], max_actions: 0, output_schema: null, artifact_title: '', include_context: true },
  quality_gate: { rule_tags: [], rule_ids: [], evidence: [], block_on: 'high', override_roles: ['compliance', 'security', 'admin'] },
  fan_out: { items: '', blueprint_key: '', title: '', inputs: {}, wait: 'all', inherit: ['sponsor', 'owner', 'team', 'priority'] },
  notify: { audience: [], subject: '', prompt: '', body: '', channel: 'in_app' },
  wait_for: { operation_key: '', input: {}, until: '', poll_minutes: 15, timeout_hours: 0, manual_complete: true },
};

/** A step's config with every default filled in (stored configs may omit keys). */
export function configOf<K extends StepType>(step: StepDef & { type: K }): StepConfigMap[K];
export function configOf(step: StepDef): StepConfigMap[StepType];
export function configOf(step: StepDef): StepConfigMap[StepType] {
  const defaults = CONFIG_DEFAULTS[step.type] ?? {};
  return { ...defaults, ...(step.config ?? {}) } as StepConfigMap[StepType];
}

export function newField(taken: string[]): FieldDef {
  const key = uniqueSlug('field', taken);
  return { key, label: '', type: 'text', required: false, options: [], help: '', placeholder: '', default: null };
}

export function blankBlueprint(): Blueprint {
  return {
    id: '', key: '', name: '', description: '', kind: 'custom', icon: 'Workflow', color: 'brand', key_prefix: 'PRJ',
    version: 0, status: 'draft', autonomy: '', inputs: [], builtin: false, created_at: '', updated_at: '',
    stages: [{ id: 'intake', name: 'Intake', description: '', color: 'sky', parallel: false, steps: [] }],
  };
}

/** Normalises any blueprint-like object (a generated draft may miss keys) into a full Blueprint. */
export function normaliseBlueprint(raw: Partial<Blueprint>): Blueprint {
  const base = blankBlueprint();
  return {
    ...base,
    ...raw,
    inputs: (raw.inputs ?? []).map((f) => ({ ...newField([]), ...f })),
    stages: (raw.stages ?? base.stages).map((s) => ({
      id: s.id ?? '', name: s.name ?? '', description: s.description ?? '', color: s.color ?? 'indigo',
      parallel: !!s.parallel,
      steps: (s.steps ?? []).map((t) => ({
        id: t.id ?? '', name: t.name ?? '', type: t.type, description: t.description ?? '',
        assignee: { roles: t.assignee?.roles ?? [], user_ids: t.assignee?.user_ids ?? [], project_role: t.assignee?.project_role ?? '' },
        sla_hours: t.sla_hours ?? null, when: t.when ?? '', store_as: t.store_as ?? '',
        auto_start: t.auto_start ?? true, config: t.config ?? {},
      })),
    })),
  };
}

export const STAGE_TONES: Tone[] = ['brand', 'sky', 'indigo', 'violet', 'fuchsia', 'pink', 'rose', 'orange', 'amber', 'emerald', 'teal', 'cyan', 'zinc'];

// ---------------------------------------------------------------------------------------------
// Immutable edits
// ---------------------------------------------------------------------------------------------

export interface StepRef { stage: number; step: number }

export function allStepIds(bp: Blueprint): string[] {
  return bp.stages.flatMap((s) => s.steps.map((t) => t.id));
}

function withStages(bp: Blueprint, stages: StageDef[]): Blueprint {
  return { ...bp, stages };
}

export function updateStage(bp: Blueprint, index: number, patch: Partial<StageDef>): Blueprint {
  return withStages(bp, bp.stages.map((s, i) => (i === index ? { ...s, ...patch } : s)));
}

export function updateStep(bp: Blueprint, ref: StepRef, patch: Partial<StepDef>): Blueprint {
  return withStages(bp, bp.stages.map((s, i) => (i !== ref.stage ? s : {
    ...s, steps: s.steps.map((t, j) => (j === ref.step ? { ...t, ...patch } : t)),
  })));
}

export function updateStepConfig(bp: Blueprint, ref: StepRef, patch: Record<string, unknown>): Blueprint {
  const step = bp.stages[ref.stage]?.steps[ref.step];
  if (!step) return bp;
  return updateStep(bp, ref, { config: { ...step.config, ...patch } });
}

export function addStage(bp: Blueprint, at = bp.stages.length): Blueprint {
  const id = uniqueSlug('stage', bp.stages.map((s) => s.id));
  const color = STAGE_TONES[bp.stages.length % STAGE_TONES.length];
  const stage: StageDef = { id, name: `Stage ${bp.stages.length + 1}`, description: '', color, parallel: false, steps: [] };
  const stages = [...bp.stages];
  stages.splice(at, 0, stage);
  return withStages(bp, stages);
}

export function moveStage(bp: Blueprint, from: number, to: number): Blueprint {
  if (to < 0 || to >= bp.stages.length || from === to) return bp;
  const stages = [...bp.stages];
  const [moved] = stages.splice(from, 1);
  stages.splice(to, 0, moved);
  return withStages(bp, stages);
}

export function removeStage(bp: Blueprint, index: number): Blueprint {
  return withStages(bp, bp.stages.filter((_, i) => i !== index));
}

export function newStep(bp: Blueprint, type: StepType): StepDef {
  const label = STEP_TYPES[type].label;
  return {
    id: uniqueSlug(type, allStepIds(bp)), name: label, type, description: '',
    assignee: { roles: [], user_ids: [], project_role: '' }, sla_hours: null, when: '', store_as: '',
    auto_start: true, config: {},
  };
}

export function addStep(bp: Blueprint, stage: number, type: StepType): { bp: Blueprint; ref: StepRef } {
  const step = newStep(bp, type);
  const next = withStages(bp, bp.stages.map((s, i) => (i === stage ? { ...s, steps: [...s.steps, step] } : s)));
  return { bp: next, ref: { stage, step: next.stages[stage].steps.length - 1 } };
}

export function duplicateStep(bp: Blueprint, ref: StepRef): { bp: Blueprint; ref: StepRef } {
  const source = bp.stages[ref.stage]?.steps[ref.step];
  if (!source) return { bp, ref };
  const copy: StepDef = {
    ...structuredClone(source),
    id: uniqueSlug(`${source.id}_copy`, allStepIds(bp)),
    name: `${source.name} (copy)`,
    store_as: source.store_as ? uniqueSlug(`${source.store_as}_copy`, storeNames(bp)) : '',
  };
  const next = withStages(bp, bp.stages.map((s, i) => {
    if (i !== ref.stage) return s;
    const steps = [...s.steps];
    steps.splice(ref.step + 1, 0, copy);
    return { ...s, steps };
  }));
  return { bp: next, ref: { stage: ref.stage, step: ref.step + 1 } };
}

export function removeStep(bp: Blueprint, ref: StepRef): Blueprint {
  return withStages(bp, bp.stages.map((s, i) => (i === ref.stage ? { ...s, steps: s.steps.filter((_, j) => j !== ref.step) } : s)));
}

/** Moves a step to (stage, index) — across stages too. Returns the new position. */
export function moveStep(bp: Blueprint, from: StepRef, toStage: number, toIndex: number): { bp: Blueprint; ref: StepRef } {
  const step = bp.stages[from.stage]?.steps[from.step];
  if (!step || !bp.stages[toStage]) return { bp, ref: from };
  const stages = bp.stages.map((s) => ({ ...s, steps: [...s.steps] }));
  stages[from.stage].steps.splice(from.step, 1);
  let index = toIndex;
  if (toStage === from.stage && toIndex > from.step) index -= 1;
  index = Math.max(0, Math.min(index, stages[toStage].steps.length));
  stages[toStage].steps.splice(index, 0, step);
  return { bp: withStages(bp, stages), ref: { stage: toStage, step: index } };
}

// ---------------------------------------------------------------------------------------------
// What a step can read (SPEC §4 context)
// ---------------------------------------------------------------------------------------------

/** The `vars.<name>` a step writes (store_as, else its id). */
export function varName(step: StepDef): string {
  return step.store_as || step.id;
}

export function storeNames(bp: Blueprint): string[] {
  return bp.stages.flatMap((s) => s.steps.map(varName));
}

/**
 * Steps that run before `ref`: every step of earlier stages, plus the earlier steps of the same
 * stage when it is sequential (a parallel stage's siblings may not have finished).
 */
export function earlierSteps(bp: Blueprint, ref: StepRef): StepDef[] {
  const out: StepDef[] = [];
  bp.stages.forEach((s, i) => {
    if (i < ref.stage) out.push(...s.steps);
    else if (i === ref.stage && !s.parallel) out.push(...s.steps.slice(0, ref.step));
  });
  return out;
}

export interface VarGroup {
  title: string;
  hint?: string;
  items: Array<{ path: string; label: string }>;
}

/** The context a template of this step may reference, grouped for the Variables helper. */
export function contextVariables(bp: Blueprint, ref: StepRef | null, extra: VarGroup[] = []): VarGroup[] {
  const project = ['id', 'key', 'title', 'description', 'priority', 'status', 'tags', 'due_date', 'kind']
    .map((k) => ({ path: `project.${k}`, label: k }));
  const groups: VarGroup[] = [
    { title: 'Project', items: project },
    {
      title: 'Inputs', hint: 'Blueprint inputs, filled when the project is created',
      items: bp.inputs.filter((f) => f.key).map((f) => ({ path: `inputs.${f.key}`, label: f.label || f.key })),
    },
  ];
  if (ref) {
    const earlier = earlierSteps(bp, ref);
    groups.push({
      title: 'Vars', hint: 'Outputs of earlier steps (store_as, else the step id)',
      items: earlier.map((t) => ({ path: `vars.${varName(t)}`, label: t.name || t.id })),
    });
  }
  groups.push({
    title: 'People & context',
    items: [
      { path: 'sponsor.name', label: 'Sponsor (name, email…)' },
      { path: 'owner.name', label: 'Owner (name, email…)' },
      { path: 'team.name', label: 'Team (name, jira_project_key…)' },
      { path: 'teams', label: 'All teams (routing)' },
      { path: 'parent.key', label: 'Parent project (key, title, inputs, vars)' },
      { path: 'feedback', label: 'Reviewer feedback on this step' },
      { path: 'step.name', label: 'This step (id, name, type)' },
      { path: 'now', label: 'Current time (ISO)' },
    ],
  });
  return [...groups, ...extra];
}

// ---------------------------------------------------------------------------------------------
// Validation messages → steps
// ---------------------------------------------------------------------------------------------

export interface MappedReport {
  report: ValidationReport;
  /** step id → messages that start with "Step '<id>'". */
  byStep: Record<string, { errors: string[]; warnings: string[] }>;
  /** Messages not tied to a step. */
  general: { errors: string[]; warnings: string[] };
}

const STEP_PREFIX = /^Step '([^']+)'/;

export function mapReport(report: ValidationReport, bp: Blueprint): MappedReport {
  const ids = new Set(allStepIds(bp));
  const byName = new Map(bp.stages.flatMap((s) => s.steps.map((t) => [t.name, t.id] as const)));
  const byStep: MappedReport['byStep'] = {};
  const general = { errors: [] as string[], warnings: [] as string[] };
  const place = (msg: string, kind: 'errors' | 'warnings') => {
    const m = STEP_PREFIX.exec(msg);
    const id = m ? (ids.has(m[1]) ? m[1] : byName.get(m[1])) : undefined;
    if (id) (byStep[id] ??= { errors: [], warnings: [] })[kind].push(msg.replace(STEP_PREFIX, '').replace(/^[:\s]+/, ''));
    else general[kind].push(msg);
  };
  report.errors.forEach((m) => place(m, 'errors'));
  report.warnings.forEach((m) => place(m, 'warnings'));
  return { report, byStep, general };
}

/** Fast client-side checks shown while typing (the backend validation stays authoritative). */
export function localIssues(bp: Blueprint): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const seen = new Map<string, number>();
  for (const id of allStepIds(bp)) seen.set(id, (seen.get(id) ?? 0) + 1);
  bp.stages.forEach((s) => s.steps.forEach((t) => {
    const issues: string[] = [];
    if (!t.id) issues.push('The step needs an id');
    else if (!SLUG_RE.test(t.id)) issues.push('The id must be a lowercase slug (letters, digits, underscores)');
    if ((seen.get(t.id) ?? 0) > 1) issues.push(`Another step already uses the id '${t.id}'`);
    if (t.store_as && !SLUG_RE.test(t.store_as)) issues.push('store_as must be a lowercase slug');
    if (issues.length) out[t.id || `${s.id}#${t.name}`] = issues;
  }));
  return out;
}

/** Stable JSON for dirty checks. */
export function fingerprint(value: unknown): string {
  return JSON.stringify(value);
}
