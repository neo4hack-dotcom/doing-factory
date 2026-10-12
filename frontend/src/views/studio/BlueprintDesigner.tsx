// Blueprint Designer (#/studio/blueprints/:id, full width): a visual editor for a workflow
// template. Stage lanes left → right with their steps, a right-hand inspector with the selected
// step's type-specific configuration, details & inputs tabs, live server validation mapped back
// onto the steps, Save (create/update — every save is a new revision) and an unsaved-changes
// guard. 'new' opens a blank draft, or the AI-generated draft handed over by the Blueprints list.
import {
  AlertCircle, AlertTriangle, ArrowLeft, CheckCircle2, Copy, FileWarning, Info, ListChecks, Save, ShieldCheck,
  Sparkles, Workflow, X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, ApiError } from '../../api';
import {
  Badge, Button, Card, EmptyState, Kbd, Skeleton, Tabs, cls, useBusy, useConfirm, useToast,
} from '../../components/ui';
import { MOD_LABEL, useHotkeys } from '../../lib/hotkeys';
import { usePageTitle } from '../../lib/pageTitle';
import { Link, navigate, paths } from '../../lib/router';
import { useApp } from '../../lib/store';
import type { Blueprint, PromptDef, Rule, StageDef, StepDef, StepType, ValidationReport } from '../../types';
import { BlueprintDetailsForm, BlueprintIcon, MiniPipeline, STATUS_OPTIONS } from './parts/BlueprintDetails';
import { FieldDefsEditor, MONO } from './parts/editors';
import {
  addStage, addStep, allStepIds, blankBlueprint, contextVariables, duplicateStep, fingerprint, localIssues, mapReport,
  moveStage, moveStep, normaliseBlueprint, removeStage, removeStep, slugify, updateStage, updateStep, updateStepConfig,
} from './parts/model';
import type { MappedReport, StepRef } from './parts/model';
import { clearGeneratedDraft, peekGeneratedDraft, useUnsavedGuard } from './parts/session';
import { StageCanvas } from './parts/StageCanvas';
import type { Selection } from './parts/StageCanvas';
import { EmptyInspector, IssueList, StageInspector, StepInspector } from './parts/StepInspector';

export interface BlueprintDesignerProps {
  /** Blueprint id from #/studio/blueprints/:id ('new' = a blank draft). */
  id: string;
}

type Tab = 'pipeline' | 'details' | 'inputs';

interface Loaded {
  bp: Blueprint;
  baseline: string;
  generated?: { description: string; validation: ValidationReport | null };
}

function initialNew(): Loaded {
  const generated = peekGeneratedDraft();
  if (generated) {
    const bp = normaliseBlueprint({ ...generated.blueprint, id: '', builtin: false });
    // An unsaved AI draft is dirty by definition: baseline = blank.
    return { bp, baseline: '', generated: { description: generated.description, validation: generated.validation } };
  }
  const bp = blankBlueprint();
  return { bp, baseline: fingerprint(bp) };
}

/** Index of a stage after moving `from` → `to`. */
function remapStage(s: number, from: number, to: number): number {
  if (s === from) return to;
  if (from < to && s > from && s <= to) return s - 1;
  if (to < from && s >= to && s < from) return s + 1;
  return s;
}

export default function BlueprintDesigner({ id }: BlueprintDesignerProps) {
  const isNew = id === 'new';
  const app = useApp();
  const { reload } = app;
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, run] = useBusy();

  const [loaded, setLoaded] = useState<Loaded | null>(() => (isNew ? initialNew() : null));
  const [loadError, setLoadError] = useState('');
  const [tab, setTab] = useState<Tab>('pipeline');
  const [selection, setSelection] = useState<Selection>(null);
  const [report, setReport] = useState<MappedReport | null>(null);
  const [keyTouched, setKeyTouched] = useState(!isNew);
  const [rules, setRules] = useState<Rule[]>([]);
  const [prompts, setPrompts] = useState<PromptDef[]>([]);

  const bp = loaded?.bp ?? null;
  usePageTitle(bp ? `${bp.name || 'Untitled blueprint'} · Designer` : 'Blueprint Designer');

  // Load (or reload when the route id changes to another blueprint).
  useEffect(() => {
    if (isNew) {
      setLoaded((cur) => (cur && !cur.bp.id ? cur : initialNew()));
      return;
    }
    if (loaded?.bp.id === id) return;
    let alive = true;
    setLoadError('');
    api.blueprints.get(id)
      .then((raw) => {
        if (!alive) return;
        const next = normaliseBlueprint(raw);
        setLoaded({ bp: next, baseline: fingerprint(next) });
        setSelection(null);
        setReport(null);
        setKeyTouched(true);
      })
      .catch((err) => alive && setLoadError(err instanceof ApiError && err.status === 404 ? 'This blueprint does not exist (any more).' : String(err?.message ?? err)));
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, isNew]);

  // The generated draft's validation report is shown as soon as it opens.
  useEffect(() => {
    if (loaded?.generated?.validation && !report) setReport(mapReport(loaded.generated.validation, loaded.bp));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded?.generated]);

  // Reference lists used by the config forms (rules for gates, prompt keys for AI tasks).
  useEffect(() => {
    api.rules.list().then(setRules).catch(() => setRules([]));
    api.prompts.list().then(setPrompts).catch(() => setPrompts([]));
  }, []);

  const dirty = !!loaded && fingerprint(loaded.bp) !== loaded.baseline;
  useUnsavedGuard(dirty, 'This blueprint has unsaved changes. Leave without saving?');

  const change = useCallback((next: Blueprint | ((cur: Blueprint) => Blueprint)) => {
    setLoaded((cur) => (cur ? { ...cur, bp: typeof next === 'function' ? next(cur.bp) : next } : cur));
  }, []);

  const patchDetails = (patch: Partial<Blueprint>) => change((cur) => {
    const next = { ...cur, ...patch };
    if ('name' in patch && !keyTouched) next.key = slugify(patch.name ?? '');
    return next;
  });

  // ---- validation ------------------------------------------------------------------------------

  const validate = async (quiet = false) => {
    if (!bp) return;
    const r = await api.blueprints.validate(bp);
    const mapped = mapReport(r, bp);
    setReport(mapped);
    if (!quiet) {
      if (r.ok && !r.warnings.length) toast.success('The blueprint is valid.');
      else if (r.ok) toast.warn(`Valid, with ${r.warnings.length} warning${r.warnings.length === 1 ? '' : 's'}.`);
      else toast.error(`${r.errors.length} error${r.errors.length === 1 ? '' : 's'} to fix before it can be active.`);
    }
  };

  const local = useMemo(() => (bp ? localIssues(bp) : {}), [bp]);
  const issueCounts = useMemo(() => {
    const out: Record<string, { errors: number; warnings: number }> = {};
    for (const [sid, msgs] of Object.entries(local)) out[sid] = { errors: msgs.length, warnings: 0 };
    for (const [sid, v] of Object.entries(report?.byStep ?? {})) {
      const cur = out[sid] ?? { errors: 0, warnings: 0 };
      out[sid] = { errors: Math.max(cur.errors, v.errors.length), warnings: v.warnings.length };
    }
    return out;
  }, [local, report]);

  // ---- save ------------------------------------------------------------------------------------

  const save = (statusOverride?: Blueprint['status']) => run('save', async () => {
    if (!bp) return;
    const body: Blueprint = statusOverride ? { ...bp, status: statusOverride } : bp;
    try {
      const saved = bp.id ? await api.blueprints.update(bp.id, body) : await api.blueprints.create(body);
      const next = normaliseBlueprint(saved);
      setLoaded({ bp: next, baseline: fingerprint(next) });
      setKeyTouched(true);
      clearGeneratedDraft();
      toast.success(`Saved “${saved.name}” · v${saved.version}${saved.status !== 'active' ? ` (${saved.status})` : ''}`);
      void reload();
      if (!bp.id) navigate(paths.blueprint(saved.id), { replace: true });
      api.blueprints.validate(next).then((r) => setReport(mapReport(r, next))).catch(() => undefined);
    } catch (err) {
      // An active blueprint must be valid: offer to keep the work as a draft.
      if (err instanceof ApiError && err.status === 422 && body.status === 'active') {
        toast.error(err, { action: { label: 'Save as draft', onClick: () => void save('draft') }, duration: 10000 });
        void validate(true);
        return;
      }
      throw err;
    }
  });

  useHotkeys({ 'mod+s': () => { if (bp && busy !== 'save') void save(); } }, !!bp);

  const leave = async () => {
    if (dirty && !(await confirm({ title: 'Discard unsaved changes?', message: 'Your edits to this blueprint will be lost.', tone: 'warning', confirmLabel: 'Discard' }))) return;
    if (isNew) clearGeneratedDraft();
    setLoaded((cur) => (cur ? { ...cur, baseline: fingerprint(cur.bp) } : cur));
    navigate(paths.blueprints());
  };

  const duplicate = () => run('duplicate', async () => {
    if (!bp?.id) return;
    if (dirty && !(await confirm({ title: 'Duplicate the saved version?', message: 'The copy is made from the last saved version — your unsaved edits are not included.', tone: 'warning', confirmLabel: 'Duplicate' }))) return;
    const copy = await api.blueprints.duplicate(bp.id);
    toast.success(`Created “${copy.name}” (draft) — customise it safely.`);
    await reload();
    setLoaded((cur) => (cur ? { ...cur, baseline: fingerprint(cur.bp) } : cur));
    navigate(paths.blueprint(copy.id));
  });

  // ---- canvas operations ----------------------------------------------------------------------

  const onAddStep = (stage: number, type: StepType) => {
    if (!bp) return;
    const { bp: next, ref } = addStep(bp, stage, type);
    change(next);
    setSelection({ kind: 'step', ref });
    setTab('pipeline');
  };
  const onMoveStage = (from: number, to: number) => {
    if (!bp) return;
    change(moveStage(bp, from, to));
    setSelection((sel) => {
      if (!sel) return sel;
      if (sel.kind === 'stage') return { kind: 'stage', stage: remapStage(sel.stage, from, to) };
      return { kind: 'step', ref: { ...sel.ref, stage: remapStage(sel.ref.stage, from, to) } };
    });
  };
  const onMoveStep = (from: StepRef, toStage: number, toIndex: number) => {
    if (!bp) return;
    const { bp: next, ref } = moveStep(bp, from, toStage, toIndex);
    change(next);
    setSelection({ kind: 'step', ref });
  };
  const onDuplicateStep = (ref: StepRef) => {
    if (!bp) return;
    const { bp: next, ref: copy } = duplicateStep(bp, ref);
    change(next);
    setSelection({ kind: 'step', ref: copy });
  };
  const onDeleteStep = async (ref: StepRef) => {
    const step = bp?.stages[ref.stage]?.steps[ref.step];
    if (!bp || !step) return;
    if (!(await confirm({ title: `Delete the step “${step.name || step.id}”?`, message: 'Later steps that read its output (vars) will need updating.', tone: 'danger', confirmLabel: 'Delete step' }))) return;
    change(removeStep(bp, ref));
    setSelection(null);
  };
  const onDeleteStage = async (index: number) => {
    const stage = bp?.stages[index];
    if (!bp || !stage) return;
    if (stage.steps.length && !(await confirm({ title: `Delete the stage “${stage.name || stage.id}”?`, message: `Its ${stage.steps.length} step(s) are deleted too.`, tone: 'danger', confirmLabel: 'Delete stage' }))) return;
    change(removeStage(bp, index));
    setSelection(null);
  };
  const onAddStage = () => {
    if (!bp) return;
    const next = addStage(bp);
    change(next);
    setSelection({ kind: 'stage', stage: next.stages.length - 1 });
  };

  // ---- render ---------------------------------------------------------------------------------

  if (loadError) {
    return (
      <EmptyState icon={FileWarning} title="Cannot open this blueprint" description={loadError}
        action={<Button icon={ArrowLeft} variant="outline" onClick={() => navigate(paths.blueprints())}>Back to blueprints</Button>} />
    );
  }
  if (!bp || !loaded) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-16 w-full" />
        <div className="flex gap-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-96 w-72" />)}</div>
      </div>
    );
  }

  const selectedStep: StepDef | undefined = selection?.kind === 'step' ? bp.stages[selection.ref.stage]?.steps[selection.ref.step] : undefined;
  const selectedStage: StageDef | undefined = selection?.kind === 'stage' ? bp.stages[selection.stage] : undefined;
  const stepCount = bp.stages.reduce((n, s) => n + s.steps.length, 0);
  const ids = allStepIds(bp);
  const generalErrors = report?.general.errors ?? [];
  const generalWarnings = report?.general.warnings ?? [];
  const statusMeta = STATUS_OPTIONS.find((s) => s.value === bp.status);
  const statusTone = bp.status === 'active' ? 'emerald' : bp.status === 'draft' ? 'amber' : 'zinc';

  const stepIssues = (step: StepDef) => {
    const fromReport = report?.byStep[step.id] ?? { errors: [], warnings: [] };
    const fromLocal = local[step.id] ?? [];
    return { errors: [...new Set([...fromLocal, ...fromReport.errors])], warnings: fromReport.warnings };
  };

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex min-w-0 items-start gap-3">
          <button type="button" onClick={() => void leave()} aria-label="Back to blueprints"
            className="mt-2 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-muted hover:bg-zinc-100 hover:text-zinc-900 dark:hover:bg-ink-700 dark:hover:text-white">
            <ArrowLeft size={16} />
          </button>
          <BlueprintIcon bp={bp} size="lg" />
          <div className="min-w-0">
            <div className="label-xs mb-1 flex items-center gap-1.5">
              <Workflow size={12} className="text-brand-500" />Blueprint Designer
              {bp.id && <span className="num text-faint normal-case tracking-normal">· v{bp.version}</span>}
            </div>
            <input
              value={bp.name}
              onChange={(e) => patchDetails({ name: e.target.value })}
              placeholder="Name this blueprint"
              aria-label="Blueprint name"
              className="w-full min-w-[16rem] max-w-xl rounded-md bg-transparent text-2xl font-bold tracking-tight text-zinc-900 outline-none placeholder:text-zinc-300 hover:bg-zinc-100/60 focus:bg-white focus:ring-2 focus:ring-brand-500/30 dark:text-white dark:placeholder:text-ink-400 dark:hover:bg-ink-700/60 dark:focus:bg-ink-800"
            />
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs text-muted">
              <Badge tone={statusTone} dot title={statusMeta?.hint}>{statusMeta?.label ?? bp.status}</Badge>
              {bp.builtin && <Badge tone="brand" icon={ShieldCheck}>builtin</Badge>}
              {bp.key && <code className={cls(MONO, 'rounded bg-zinc-100 px-1.5 py-0.5 dark:bg-ink-700')}>{bp.key}</code>}
              <span className="num">{bp.stages.length} stage{bp.stages.length === 1 ? '' : 's'} · {stepCount} step{stepCount === 1 ? '' : 's'} · {bp.inputs.length} input{bp.inputs.length === 1 ? '' : 's'}</span>
            </div>
            <MiniPipeline bp={bp} className="mt-2 w-72 max-w-full" />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {dirty && <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-amber-600 dark:text-amber-400"><span className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-500" />Unsaved changes</span>}
          {bp.id && <Button variant="ghost" icon={Copy} busy={busy === 'duplicate'} onClick={() => void duplicate()}>Duplicate</Button>}
          <Button variant="outline" icon={ListChecks} busy={busy === 'validate'} onClick={() => void run('validate', () => validate())}>
            Validate
            {report && (report.report.errors.length > 0
              ? <Badge size="xs" tone="rose" variant="solid">{report.report.errors.length}</Badge>
              : report.report.warnings.length > 0 ? <Badge size="xs" tone="amber" variant="solid">{report.report.warnings.length}</Badge>
                : <CheckCircle2 size={14} className="text-emerald-500" />)}
          </Button>
          <Button icon={Save} busy={busy === 'save'} onClick={() => void save()} disabled={!!bp.id && !dirty}>
            {bp.id ? 'Save' : 'Create'} <Kbd className="ml-1 hidden opacity-70 lg:inline-flex">{MOD_LABEL}S</Kbd>
          </Button>
        </div>
      </div>

      {/* Banners */}
      {bp.builtin && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-brand-500/30 bg-brand-500/5 px-4 py-2.5 text-sm">
          <Info size={16} className="shrink-0 text-brand-600 dark:text-brand-400" />
          <p className="min-w-0 flex-1 text-zinc-700 dark:text-zinc-300">
            <b>Builtin blueprint.</b> It powers the end-to-end demo — <b>Duplicate to customize safely</b>; edits here change the original for every new project.
          </p>
          <Button size="sm" variant="outline" icon={Copy} busy={busy === 'duplicate'} onClick={() => void duplicate()}>Duplicate</Button>
        </div>
      )}
      {loaded.generated && !bp.id && (
        <div className="flex items-start gap-3 rounded-xl border border-violet-500/30 bg-violet-500/5 px-4 py-2.5 text-sm">
          <Sparkles size={16} className="mt-0.5 shrink-0 text-violet-500" />
          <div className="min-w-0 flex-1">
            <p className="text-zinc-700 dark:text-zinc-300"><b>AI-generated draft — not saved yet.</b> Review the stages and steps, fix the flagged items, then Create.</p>
            <p className="mt-0.5 truncate text-xs text-muted" title={loaded.generated.description}>From: “{loaded.generated.description}”</p>
          </div>
        </div>
      )}
      {report && (generalErrors.length > 0 || generalWarnings.length > 0 || report.report.ok) && (
        <Card padding="sm" className={cls('animate-fade-in', !report.report.ok && 'border-rose-300 dark:border-rose-500/40')}>
          <div className="flex items-start gap-3">
            {report.report.ok
              ? <CheckCircle2 size={18} className="mt-0.5 shrink-0 text-emerald-500" />
              : <AlertCircle size={18} className="mt-0.5 shrink-0 text-rose-500" />}
            <div className="min-w-0 flex-1 space-y-2">
              <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">
                {report.report.ok ? 'Valid blueprint' : 'Validation found problems'}
                <span className="ml-2 text-xs font-normal text-muted">
                  {report.report.errors.length} error{report.report.errors.length === 1 ? '' : 's'} · {report.report.warnings.length} warning{report.report.warnings.length === 1 ? '' : 's'}
                  {Object.keys(report.byStep).length > 0 && ' — step issues are flagged on the canvas'}
                </span>
              </p>
              <IssueList issues={{ errors: generalErrors, warnings: generalWarnings }} />
            </div>
            <button type="button" aria-label="Dismiss" onClick={() => setReport(null)} className="text-faint hover:text-zinc-700 dark:hover:text-zinc-200"><X size={15} /></button>
          </div>
        </Card>
      )}

      <Tabs<Tab>
        value={tab}
        onChange={setTab}
        tabs={[
          { key: 'pipeline', label: 'Pipeline', icon: Workflow, count: stepCount },
          { key: 'details', label: 'Details', icon: Info },
          { key: 'inputs', label: 'Inputs', icon: ListChecks, count: bp.inputs.length },
        ]}
      />

      {tab === 'pipeline' && (
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start">
          <div className="min-w-0 flex-1 rounded-xl border hairline bg-white/60 p-3 grid-bg dark:bg-ink-900/40">
            <StageCanvas
              bp={bp}
              selection={selection}
              onSelect={setSelection}
              issues={issueCounts}
              onAddStep={onAddStep}
              onMoveStage={onMoveStage}
              onMoveStep={onMoveStep}
              onDuplicateStep={onDuplicateStep}
              onDeleteStep={(ref) => void onDeleteStep(ref)}
              onDeleteStage={(i) => void onDeleteStage(i)}
              onAddStage={onAddStage}
            />
          </div>
          <aside className="card w-full shrink-0 overflow-hidden xl:sticky xl:top-4 xl:h-[calc(100vh-9rem)] xl:w-[28rem]">
            {selectedStep && selection?.kind === 'step' ? (
              <StepInspector
                key={`${selection.ref.stage}:${selection.ref.step}`}
                ctx={{
                  bp, ref: selection.ref, step: selectedStep, vars: contextVariables(bp, selection.ref),
                  roles: app.roles, users: app.users, operations: app.operations, connectors: app.connectors,
                  blueprints: app.blueprints, rules, prompts,
                  set: (patch) => change((cur) => updateStepConfig(cur, selection.ref, patch)),
                }}
                allIds={ids}
                issues={stepIssues(selectedStep)}
                onPatch={(patch) => change((cur) => updateStep(cur, selection.ref, patch))}
                onDuplicate={() => onDuplicateStep(selection.ref)}
                onDelete={() => void onDeleteStep(selection.ref)}
                onClose={() => setSelection(null)}
              />
            ) : selectedStage && selection?.kind === 'stage' ? (
              <StageInspector
                stage={selectedStage}
                allIds={bp.stages.map((s) => s.id)}
                onPatch={(patch) => change((cur) => updateStage(cur, selection.stage, patch))}
                onDelete={() => void onDeleteStage(selection.stage)}
                onClose={() => setSelection(null)}
              />
            ) : (
              <EmptyInspector />
            )}
          </aside>
        </div>
      )}

      {tab === 'details' && (
        <Card padding="lg" className="max-w-4xl">
          <BlueprintDetailsForm bp={bp} onChange={patchDetails} onKeyEdited={() => setKeyTouched(true)} />
          {bp.status === 'active' && report && !report.report.ok && (
            <p className="mt-4 flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-400">
              <AlertTriangle size={13} /> An active blueprint must validate without errors — fix them or save it as a draft.
            </p>
          )}
        </Card>
      )}

      {tab === 'inputs' && (
        <Card padding="lg" className="max-w-4xl">
          <p className="mb-4 text-sm text-muted">
            Inputs are asked when a project is created (or mapped by a watcher / fan-out) and read in templates as <code className={MONO}>inputs.&lt;key&gt;</code>.
          </p>
          <FieldDefsEditor fields={bp.inputs} onChange={(inputs) => change((cur) => ({ ...cur, inputs }))} addLabel="Add input" keyPrefix="inputs."
            emptyLabel="No input — projects only get a title and a description." />
        </Card>
      )}

      {!bp.id && stepCount === 0 && tab === 'pipeline' && (
        <p className="text-xs text-muted">
          Tip: describe your process in plain words and let the AI draft it — <Link to={paths.blueprints()} className="font-semibold text-brand-600 hover:underline dark:text-brand-400">Generate with AI</Link> on the Blueprints page.
        </p>
      )}
    </div>
  );
}
