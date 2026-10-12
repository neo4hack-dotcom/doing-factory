// TaskPanel bodies for the non-form states: ready to start, running, failed, waiting on an external
// system or on child projects, finished (done / skipped / rejected) — and the generic manual
// completion used when a step waits on a person without a dedicated editor.
import {
  CheckCircle2, CircleSlash, Clock, CornerDownRight, ExternalLink, GitFork, Hourglass, Lightbulb, Play, RotateCcw,
  SkipForward, Sparkles, Wrench, XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { FormRenderer } from '../../components/FormRenderer';
import { Markdown } from '../../components/Markdown';
import { PipelineStrip } from '../../components/PipelineStrip';
import { Badge, Button, Field, Skeleton, Spinner, StatusBadge, Textarea, useConfirmReason } from '../../components/ui';
import { api, errorMessage } from '../../api';
import { cls } from '../../lib/cls';
import { formatDateTime, formatNumber, plural, timeAgo } from '../../lib/format';
import { Link, paths } from '../../lib/router';
import { useApp, useLive } from '../../lib/store';
import type { ProjectSummary } from '../../types';
import type { ActionProps } from './types';
import { ApprovalSummary } from './ApprovalAction';
import { ActionBar, ActorName, ArtifactPreview, Callout, Collapsible, JsonBlock, NotAllowed, Section } from './common';
import { GateSummary } from './GateReview';
import { readSuggestion } from './EstimationAction';
import { stepArtifacts, stepConfig } from './logic';
import { TraceView } from './TraceView';

// ---------------------------------------------------------------------------------------------
// pending
// ---------------------------------------------------------------------------------------------

export function PendingView({ project, step, userId, canAct, blockedReason, busy, run }: ActionProps) {
  if (step.auto_start) {
    return (
      <Callout tone="sky" icon={Clock} title="Not started yet">
        This step starts on its own as soon as the steps before it are finished{step.when ? ' and its condition holds' : ''}.
      </Callout>
    );
  }
  return (
    <div className="space-y-3">
      <Callout tone="amber" icon={Play} title="Waiting for someone to press Start">
        The blueprint keeps this step on hold until a person starts it — typically when the team is ready to pick it up.
      </Callout>
      <ActionBar note={!canAct ? <NotAllowed>{blockedReason}</NotAllowed> : undefined}>
        <Button icon={Play} busy={busy === 'start'} disabled={!canAct || !!busy} onClick={() => void run('start', () => api.steps.start(project.id, step.id, userId), `${step.name} started`)}>
          Start
        </Button>
      </ActionBar>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// running
// ---------------------------------------------------------------------------------------------

const RUNNING_COPY: Partial<Record<string, string>> = {
  ai_task: 'The local LLM is writing',
  agent_task: 'The agent is working through its tools',
  mcp_operation: 'Calling the MCP operation',
  quality_gate: 'The AI is checking the compliance rules',
  fan_out: 'Starting the child projects',
  notify: 'Notifying the audience',
};

export function RunningView({ step, trace }: ActionProps) {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 rounded-lg border border-sky-500/30 bg-sky-50/60 px-3 py-2.5 dark:bg-sky-500/[0.06]">
        <Spinner size={16} className="text-sky-500" />
        <div className="min-w-0 flex-1 text-sm">
          <span className="font-semibold text-sky-900 dark:text-sky-200">{RUNNING_COPY[step.type] ?? 'Working'}…</span>
          {step.started_at && <span className="ml-2 text-xs text-sky-700/80 dark:text-sky-300/80">started {timeAgo(step.started_at)}</span>}
          {step.attempts > 1 && <Badge tone="amber" size="xs" className="ml-2">attempt {step.attempts}</Badge>}
        </div>
      </div>
      <Section title="Live trace" icon={Sparkles}>
        <TraceView entries={trace} running emptyLabel="Waiting for the first trace entry…" />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// failed
// ---------------------------------------------------------------------------------------------

export function FailedView({ project, step, userId, canAct, blockedReason, busy, run, trace }: ActionProps) {
  const confirmReason = useConfirmReason();
  const [manual, setManual] = useState(false);
  const [output, setOutput] = useState('');

  const skip = async () => {
    const reason = await confirmReason({
      title: `Skip “${step.name}”?`,
      message: 'The workflow continues as if this step was not needed. Later steps that rely on its output may fail.',
      tone: 'warning',
      confirmLabel: 'Skip step',
      reasonPlaceholder: 'Why can this step be skipped?',
    });
    if (reason !== null) await run('skip', () => api.steps.skip(project.id, step.id, userId, reason), `${step.name} skipped`);
  };

  const complete = () => run(
    'complete',
    () => api.steps.complete(project.id, step.id, userId, { output: output.trim() }),
    `${step.name} completed manually`,
  ).then((p) => p && setManual(false));

  const lastLines = trace.slice(-8);

  return (
    <div className="space-y-4">
      <Callout tone="rose" icon={XCircle} title={`Failed${step.attempts > 1 ? ` after ${plural(step.attempts, 'attempt')}` : ''}`}>
        <span className="whitespace-pre-wrap break-words">{step.error || 'The step failed without an error message.'}</span>
      </Callout>
      {step.heal_hint && (
        <Callout tone="violet" icon={Lightbulb} title="AI critic's advice">
          <Markdown content={step.heal_hint} size="xs" />
        </Callout>
      )}
      {lastLines.length > 0 && (
        <Section title="Last trace lines" icon={CornerDownRight}>
          <TraceView entries={trace} limit={8} maxHeight="max-h-60" />
        </Section>
      )}

      {manual && (
        <div className="space-y-2 rounded-lg border hairline p-3 animate-fade-in">
          <Field label="Output" help="What this step should have produced — stored as its output for the next steps.">
            <Textarea autoFocus value={output} onChange={(e) => setOutput(e.target.value)} minRows={4} placeholder="e.g. the Jira key you created by hand, or the summary of what was done" />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setManual(false)}>Cancel</Button>
            <Button size="sm" icon={CheckCircle2} busy={busy === 'complete'} disabled={!output.trim() || !!busy} onClick={() => void complete()}>Mark complete</Button>
          </div>
        </div>
      )}

      <ActionBar note={!canAct ? <NotAllowed>{blockedReason}</NotAllowed> : (
        <Link to={paths.blueprint(project.blueprint_id)} className="inline-flex items-center gap-1 font-semibold text-brand-600 hover:underline dark:text-brand-400">
          <Wrench size={12} /> Fix the blueprint config
        </Link>
      )}>
        <Button variant="ghost" size="sm" icon={SkipForward} busy={busy === 'skip'} disabled={!canAct || !!busy} onClick={() => void skip()}>Skip…</Button>
        <Button variant="outline" size="sm" icon={CheckCircle2} disabled={!canAct || !!busy || manual} onClick={() => setManual(true)}>Complete manually</Button>
        <Button size="sm" icon={RotateCcw} busy={busy === 'retry'} disabled={!canAct || !!busy} onClick={() => void run('retry', () => api.steps.retry(project.id, step.id, userId), `Retrying ${step.name}…`)}>
          Retry
        </Button>
      </ActionBar>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// waiting_external
// ---------------------------------------------------------------------------------------------

export function WaitExternalView({ project, step, userId, canAct, blockedReason, busy, run, trace }: ActionProps) {
  const { operations } = useApp();
  const cfg = stepConfig(step, 'wait_for');
  const op = operations.find((o) => o.key === cfg.operation_key);
  const [note, setNote] = useState('');
  const [manual, setManual] = useState(false);
  const lastPoll = [...trace].reverse().find((e) => e.kind === 'tool' || e.kind === 'result');
  const timeoutAt = cfg.timeout_hours && step.started_at
    ? new Date(Date.parse(step.started_at) + cfg.timeout_hours * 3_600_000).toISOString()
    : null;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-teal-500/30 bg-teal-50/50 p-3.5 dark:bg-teal-500/[0.06]">
        <div className="flex items-start gap-3">
          <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-teal-500/15 text-teal-600 dark:text-teal-300">
            <Hourglass size={17} className="animate-pulse-slow" />
          </span>
          <div className="min-w-0 flex-1 space-y-1 text-sm">
            <p className="text-zinc-700 dark:text-zinc-200">
              Polling <b>{op?.name ?? cfg.operation_key ?? 'an operation'}</b>{cfg.poll_minutes ? <> every {plural(cfg.poll_minutes, 'minute')}</> : null} until
            </p>
            {cfg.until && <code className="block rounded-md bg-white px-2 py-1 font-mono text-xs text-teal-800 ring-1 ring-teal-500/20 dark:bg-ink-900 dark:text-teal-200">{cfg.until}</code>}
          </div>
        </div>
        <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
          <Fact label="Waiting since" value={step.started_at ? timeAgo(step.started_at) : '—'} title={formatDateTime(step.started_at)} />
          <Fact label="Last poll" value={lastPoll ? timeAgo(lastPoll.ts) : 'not yet'} title={lastPoll ? formatDateTime(lastPoll.ts) : undefined} />
          <Fact label="Next poll" value={step.next_poll_at ? timeAgo(step.next_poll_at) : '—'} title={formatDateTime(step.next_poll_at)} />
          <Fact label="Times out" value={timeoutAt ? timeAgo(timeoutAt) : 'never'} title={timeoutAt ? formatDateTime(timeoutAt) : undefined} />
        </dl>
      </div>

      {step.output !== undefined && step.output !== null && (
        <Collapsible title="Last result" icon={CornerDownRight}>
          <JsonBlock value={step.output} />
        </Collapsible>
      )}
      {trace.length > 0 && (
        <Collapsible title={`Poll history · ${trace.length}`} icon={Clock}>
          <TraceView entries={trace} limit={15} maxHeight="max-h-60" />
        </Collapsible>
      )}

      {cfg.manual_complete ? (
        <>
          {manual && (
            <Field label="Completion note" help="Optional — e.g. where the work was confirmed.">
              <Textarea autoFocus value={note} onChange={(e) => setNote(e.target.value)} minRows={2} />
            </Field>
          )}
          <ActionBar note={!canAct ? <NotAllowed>{blockedReason}</NotAllowed> : 'The blueprint lets a person confirm this without waiting for the poll.'}>
            {manual && <Button variant="ghost" size="sm" onClick={() => setManual(false)}>Cancel</Button>}
            <Button
              size="sm"
              icon={CheckCircle2}
              busy={busy === 'complete'}
              disabled={!canAct || !!busy}
              onClick={() => {
                if (!manual) {
                  setManual(true);
                  return;
                }
                void run('complete', () => api.steps.complete(project.id, step.id, userId, note.trim() ? { output: note.trim() } : {}), `${step.name} marked as complete`);
              }}
            >
              {manual ? 'Confirm complete' : 'Mark as complete'}
            </Button>
          </ActionBar>
        </>
      ) : (
        <p className="text-xs text-faint">The Factory moves on by itself when the condition becomes true.</p>
      )}
    </div>
  );
}

function Fact({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="min-w-0">
      <dt className="label-xs">{label}</dt>
      <dd className="num mt-0.5 truncate font-semibold text-zinc-800 dark:text-zinc-100" title={title}>{value}</dd>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// waiting_children
// ---------------------------------------------------------------------------------------------

export function WaitChildrenView({ project, step }: ActionProps) {
  const [children, setChildren] = useState<ProjectSummary[] | null>(null);
  const [error, setError] = useState('');
  const ids = step.child_ids ?? [];
  // Compared by value: every project refresh brings a new array, which must not reload in a loop.
  const idsKey = ids.join(',');

  const load = useCallback(async () => {
    const wanted = idsKey ? idsKey.split(',') : [];
    try {
      const all = await api.projects.list({ parent_id: project.id });
      setChildren(all.filter((c) => wanted.length === 0 || wanted.includes(c.id)));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [project.id, idsKey]);

  useEffect(() => {
    void load();
  }, [load]);
  useLive('project.updated', (e) => {
    if (ids.includes(e.project_id)) setChildren((list) => list?.map((c) => (c.id === e.project_id ? e.summary : c)) ?? list);
  });

  const done = children?.filter((c) => c.status === 'done' || c.status === 'cancelled').length ?? 0;
  const failing = children?.filter((c) => c.status === 'failed' || c.status === 'blocked') ?? [];

  return (
    <div className="space-y-3">
      <Callout tone="sky" icon={GitFork} title={`Waiting for ${plural(ids.length, 'child project')}`}>
        The parent continues automatically once every child is delivered or cancelled.
        {failing.length > 0 && <> <b>{plural(failing.length, 'child')} {failing.length === 1 ? 'needs' : 'need'} attention.</b></>}
      </Callout>
      {error ? <p className="text-xs text-rose-600 dark:text-rose-400">{error}</p> : children === null ? (
        <div className="space-y-2">{ids.map((id) => <Skeleton key={id} className="h-14 rounded-lg" />)}</div>
      ) : children.length === 0 ? (
        <p className="text-xs text-faint">No child project found.</p>
      ) : (
        <>
          <div className="num text-[11px] text-muted">{done}/{children.length} finished</div>
          <ul className="space-y-2">
            {children.map((c) => (
              <li key={c.id}>
                <Link to={paths.project(c.id)} className="block rounded-lg border hairline p-3 transition-colors hover:border-brand-500/50">
                  <div className="mb-2 flex items-center gap-2">
                    <span className="font-mono text-[11px] font-semibold text-muted">{c.key}</span>
                    <span className="min-w-0 flex-1 truncate text-sm font-semibold">{c.title}</span>
                    <StatusBadge kind="project" value={c.status} size="xs" />
                    <ExternalLink size={12} className="shrink-0 text-faint" />
                  </div>
                  <PipelineStrip summary={c} size="sm" />
                </Link>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// done / skipped / rejected
// ---------------------------------------------------------------------------------------------

export function FinishedView({ project, step, userId, canAct, blockedReason, busy, run, trace }: ActionProps) {
  const confirmReason = useConfirmReason();
  const artifacts = stepArtifacts(project, step.id);
  const skipped = step.status === 'skipped';
  const rejected = step.status === 'rejected';

  const reopen = async () => {
    const reason = await confirmReason({
      title: `Reopen “${step.name}”?`,
      message: 'The step and every step after it in the workflow go back to pending, and the project resumes from here. Approvals given later are cleared.',
      tone: 'warning',
      confirmLabel: 'Reopen step',
      reasonLabel: 'Reason (shown to the assignee as feedback)',
      reasonPlaceholder: 'What needs to change?',
    });
    if (reason !== null) await run('reopen', () => api.steps.reopen(project.id, step.id, userId, reason), `${step.name} reopened`);
  };

  return (
    <div className="space-y-4">
      <div className={cls(
        'flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg border px-3 py-2.5 text-sm',
        rejected ? 'border-rose-500/30 bg-rose-50/60 dark:bg-rose-500/[0.06]' : skipped ? 'hairline bg-zinc-50 dark:bg-ink-900/50' : 'border-emerald-500/30 bg-emerald-50/60 dark:bg-emerald-500/[0.06]',
      )}>
        {rejected ? <XCircle size={16} className="text-rose-500" /> : skipped ? <CircleSlash size={16} className="text-zinc-400" /> : <CheckCircle2 size={16} className="text-emerald-500" />}
        <span className="font-semibold">{rejected ? 'Rejected' : skipped ? 'Skipped' : 'Completed'}</span>
        {step.completed_by && <span className="inline-flex items-center gap-1.5 text-xs text-muted">by <ActorName id={step.completed_by} size={16} /></span>}
        {step.completed_at && <span className="text-xs text-muted" title={formatDateTime(step.completed_at)}>{timeAgo(step.completed_at)}</span>}
      </div>

      {step.output_summary && (
        <div className="text-sm text-zinc-700 dark:text-zinc-300"><Markdown content={step.output_summary} size="xs" /></div>
      )}
      {skipped && step.error && <p className="text-xs text-muted">Reason: {step.error}</p>}

      <TypeSummary {...{ project, step, userId, canAct, blockedReason, busy, run, trace }} />

      {artifacts.length > 0 && (
        <Section title={plural(artifacts.length, 'artifact')}>
          <div className="space-y-2">
            {artifacts.map((a, i) => <ArtifactPreview key={a.id} artifact={a} defaultOpen={i === 0 && step.type === 'ai_task'} />)}
          </div>
        </Section>
      )}

      {step.output !== undefined && step.output !== null && step.type !== 'human_form' && step.type !== 'estimation' && (
        <Collapsible title="Raw output" meta={<code className="text-[11px] text-faint">vars.{step.store_as || step.id}</code>}>
          <JsonBlock value={step.output} />
        </Collapsible>
      )}
      {trace.length > 0 && (
        <Collapsible title={`Trace · ${trace.length}`}>
          <TraceView entries={trace} limit={30} />
        </Collapsible>
      )}

      <ActionBar note={!canAct ? <NotAllowed>{blockedReason}</NotAllowed> : undefined}>
        <Button variant="outline" size="sm" icon={RotateCcw} busy={busy === 'reopen'} disabled={!canAct || !!busy || project.status === 'cancelled'} onClick={() => void reopen()}>
          Reopen…
        </Button>
      </ActionBar>
    </div>
  );
}

/** What a finished step decided, by type (form values, sign-offs, estimate, findings, children). */
function TypeSummary(props: ActionProps) {
  const { project, step } = props;
  const { blueprints } = useApp();
  if (step.type === 'human_form') {
    const fields = stepConfig(step, 'human_form').fields ?? [];
    if (!fields.length) return null;
    return <FormRenderer fields={fields} value={step.form ?? {}} onChange={() => undefined} readOnly aiDraft={step.ai_draft} />;
  }
  if (step.type === 'approval') return <ApprovalSummary project={project} step={step} />;
  if (step.type === 'quality_gate') return <GateSummary project={project} step={step} />;
  if (step.type === 'estimation' && step.estimate) {
    const e = step.estimate;
    const ai = readSuggestion(e.ai_suggestion ?? null);
    return (
      <div className="flex flex-wrap items-end gap-x-6 gap-y-2">
        <div>
          <div className="label-xs">Estimate</div>
          <div className="num text-2xl font-bold tracking-tight">{formatNumber(e.value ?? null, 1)} <span className="text-sm font-semibold text-muted">{e.unit}</span></div>
        </div>
        <Badge tone={e.confidence === 'high' ? 'emerald' : e.confidence === 'low' ? 'rose' : 'amber'} size="xs">{e.confidence} confidence</Badge>
        {ai?.value !== null && ai?.value !== undefined && <span className="text-xs text-muted">AI suggested {formatNumber(ai.value, 1)} {ai.unit}</span>}
        {e.rationale && <div className="w-full text-xs"><Markdown content={e.rationale} size="xs" /></div>}
      </div>
    );
  }
  if (step.type === 'fan_out' && step.child_ids.length) {
    const bpKey = stepConfig(step, 'fan_out').blueprint_key;
    const bp = blueprints.find((b) => b.key === bpKey);
    return (
      <p className="text-xs text-muted">
        Started {plural(step.child_ids.length, 'child project')}{bpKey ? <> from the <b>{bp?.name ?? bpKey}</b> blueprint</> : null}.{' '}
        <Link to={paths.project(project.id)} className="font-semibold text-brand-600 hover:underline dark:text-brand-400">See them on the project</Link>
      </p>
    );
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// Fallback: waiting on a person without a dedicated editor
// ---------------------------------------------------------------------------------------------

export function ManualCompleteView({ project, step, userId, canAct, blockedReason, busy, run, trace }: ActionProps) {
  const [output, setOutput] = useState('');
  return (
    <div className="space-y-3">
      <Callout tone="amber" icon={Hourglass} title={step.pending_action?.title || 'Waiting for a person'}>
        {step.pending_action?.description || 'This step needs someone to confirm it is done.'}
      </Callout>
      {trace.length > 0 && <TraceView entries={trace} limit={10} maxHeight="max-h-52" />}
      <Field label="Output (optional)">
        <Textarea value={output} onChange={(e) => setOutput(e.target.value)} minRows={2} disabled={!canAct} />
      </Field>
      <ActionBar note={!canAct ? <NotAllowed>{blockedReason}</NotAllowed> : undefined}>
        <Button size="sm" icon={CheckCircle2} busy={busy === 'complete'} disabled={!canAct || !!busy} onClick={() => void run('complete', () => api.steps.complete(project.id, step.id, userId, output.trim() ? { output: output.trim() } : {}), `${step.name} completed`)}>
          Mark complete
        </Button>
      </ActionBar>
    </div>
  );
}
