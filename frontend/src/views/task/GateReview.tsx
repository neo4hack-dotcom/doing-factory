// quality_gate · gate_review: the AI's compliance findings, with the blocking ones first. A person
// decides: override (authorised roles, recorded with a reason), send the work back to an earlier
// step with feedback, or re-run the checks once the evidence changed.
import { ChevronDown, ChevronRight, CornerUpLeft, RefreshCw, ShieldAlert, ShieldCheck, ShieldX } from 'lucide-react';
import { useMemo, useState } from 'react';
import { AiRewrite } from '../../components/AiRewrite';
import { Markdown } from '../../components/Markdown';
import { Badge, Button, Checkbox, Field, Select, StatusBadge, Textarea, useConfirmReason } from '../../components/ui';
import { api } from '../../api';
import { cls } from '../../lib/cls';
import { plural } from '../../lib/format';
import { SEVERITY } from '../../lib/status';
import { useApp } from '../../lib/store';
import type { CheckResult, Project, Severity, StepRun } from '../../types';
import type { ActionProps } from './types';
import { ActionBar, ActorName, Callout, NotAllowed, Section, Segmented } from './common';
import { canOverrideGate, earlierSteps, stepConfig } from './logic';

type Filter = 'attention' | 'fail' | 'warn' | 'pending' | 'pass' | 'all';

const BLOCK_RANK: Record<string, number> = { any: 0, medium: SEVERITY.medium.rank, high: SEVERITY.high.rank, critical: SEVERITY.critical.rank };

/** A check blocks the gate when it failed at/above `block_on` (or awaits a manual review) and nobody overrode it. */
export function isBlocking(check: CheckResult, blockOn: string): boolean {
  if (check.overridden_by) return false;
  if (check.status === 'pending') return true;
  if (check.status !== 'fail') return false;
  return (SEVERITY[check.severity as Severity]?.rank ?? 0) >= (BLOCK_RANK[blockOn] ?? BLOCK_RANK.high);
}

const keyOf = (c: CheckResult) => c.rule_id || c.code || c.title;

export function GateReview({ project, step, userId, canAct, blockedReason, busy, run }: ActionProps) {
  const { me, isAdmin, roleByKey } = useApp();
  const confirmReason = useConfirmReason();
  const cfg = stepConfig(step, 'quality_gate');
  const blockOn = cfg.block_on ?? 'high';
  const checks = useMemo(() => [...(step.checks ?? [])].sort(
    (a, b) => Number(isBlocking(b, blockOn)) - Number(isBlocking(a, blockOn))
      || (SEVERITY[b.severity]?.rank ?? 0) - (SEVERITY[a.severity]?.rank ?? 0),
  ), [step.checks, blockOn]);
  const blocking = checks.filter((c) => isBlocking(c, blockOn));
  const counts = {
    fail: checks.filter((c) => c.status === 'fail').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    pending: checks.filter((c) => c.status === 'pending').length,
    pass: checks.filter((c) => c.status === 'pass' || c.status === 'na').length,
  };
  const attention = checks.filter((c) => !c.overridden_by && (c.status === 'fail' || c.status === 'warn' || c.status === 'pending'));
  const [filter, setFilter] = useState<Filter>(attention.length ? 'attention' : 'all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [sendBack, setSendBack] = useState(false);
  const targets = earlierSteps(project, step.id);
  const [goto, setGoto] = useState(() => targets.at(-1)?.id ?? '');
  const [feedback, setFeedback] = useState('');

  const canOverride = canOverrideGate(project, step, me, isAdmin);
  const overrideRoles = (cfg.override_roles ?? []).map((r) => roleByKey(r)?.label ?? r);

  const shown = checks.filter((c) => {
    if (filter === 'attention') return attention.includes(c);
    if (filter === 'pass') return c.status === 'pass' || c.status === 'na';
    if (filter === 'all') return true;
    return c.status === filter;
  });
  const chosen = checks.filter((c) => selected.has(keyOf(c)));
  const toggle = (c: CheckResult) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(keyOf(c))) next.delete(keyOf(c));
    else next.add(keyOf(c));
    return next;
  });

  const override = async () => {
    const scope = chosen.length ? chosen : blocking;
    const reason = await confirmReason({
      title: `Override ${plural(scope.length, 'finding')}?`,
      message: (
        <div className="space-y-2">
          <p>The gate lets the project continue despite:</p>
          <ul className="list-disc space-y-0.5 pl-5 text-xs">
            {scope.slice(0, 8).map((c) => <li key={keyOf(c)}><b>{c.code || c.rule_id}</b> {c.title}</li>)}
            {scope.length > 8 && <li>…and {scope.length - 8} more</li>}
          </ul>
          <p className="text-xs">Your name and reason are written to the tamper-evident audit trail.</p>
        </div>
      ),
      tone: 'danger',
      steps: 2,
      confirmLabel: 'Override the gate',
      reasonLabel: 'Justification',
      reasonPlaceholder: 'Why is it acceptable to proceed? Compensating controls, deadline for the fix…',
    });
    if (reason === null) return;
    await run('override', () => api.steps.gate(project.id, step.id, userId, 'override', {
      comment: reason, rule_ids: scope.map((c) => c.rule_id).filter(Boolean),
    }), 'Gate overridden — recorded in the audit trail');
  };

  const rerun = () => run(
    'rerun',
    () => api.steps.gate(project.id, step.id, userId, 'rerun', { rule_ids: chosen.length ? chosen.map((c) => c.rule_id).filter(Boolean) : undefined }),
    chosen.length ? `Re-running ${plural(chosen.length, 'check')}…` : 'Re-running every check…',
  ).then((p) => p && setSelected(new Set()));

  const doSendBack = () => run(
    'send_back',
    () => api.steps.gate(project.id, step.id, userId, 'send_back', { goto_step: goto, comment: feedback.trim() }),
    `Sent back to “${targets.find((t) => t.id === goto)?.name ?? goto}” with your feedback`,
  ).then((p) => {
    if (p) {
      setSendBack(false);
      setFeedback('');
    }
  });

  const verdict = blocking.length === 0
    ? <Callout tone="emerald" icon={ShieldCheck} title="Nothing blocks this gate any more">Re-run the checks or let the step finish.</Callout>
    : (
      <Callout tone="rose" icon={ShieldX} title={`${plural(blocking.length, 'finding')} ${blocking.length === 1 ? 'blocks' : 'block'} the release`}>
        The gate blocks on <b>{blockOn === 'any' ? 'any failure' : `${blockOn} severity and above`}</b>
        {counts.pending > 0 && <> and on rules that need a manual review</>}. Fix and re-run, send the work back, or override with a justification.
      </Callout>
    );

  return (
    <div className="space-y-4">
      {verdict}

      <Section
        title={`Findings · ${checks.length}`}
        icon={ShieldAlert}
        actions={
          <Segmented<Filter>
            size="xs"
            value={filter}
            onChange={setFilter}
            options={[
              { key: 'attention', label: 'Attention', count: attention.length },
              { key: 'fail', label: 'Fail', count: counts.fail },
              { key: 'warn', label: 'Warn', count: counts.warn },
              { key: 'pending', label: 'Manual', count: counts.pending },
              { key: 'pass', label: 'Pass', count: counts.pass },
              { key: 'all', label: 'All', count: checks.length },
            ]}
          />
        }
      >
        {checks.length === 0 ? (
          <p className="text-xs text-faint">No checks were recorded for this gate — re-run it.</p>
        ) : shown.length === 0 ? (
          <p className="py-3 text-center text-xs text-faint">No finding matches this filter.</p>
        ) : (
          <ul className="divide-y hairline overflow-hidden rounded-lg border hairline">
            {shown.map((c) => (
              <CheckRow
                key={keyOf(c)}
                check={c}
                blocking={isBlocking(c, blockOn)}
                selectable={canAct}
                selected={selected.has(keyOf(c))}
                onToggle={() => toggle(c)}
              />
            ))}
          </ul>
        )}
      </Section>

      {sendBack && (
        <div className="space-y-3 rounded-lg border border-amber-500/30 bg-amber-50/40 p-3 animate-fade-in dark:bg-amber-500/5">
          <Field label="Send the work back to">
            <Select value={goto} onChange={(e) => setGoto(e.target.value)} options={targets.map((t) => ({ value: t.id, label: t.name }))} />
          </Field>
          <Field label="Feedback for the team" required aside={<AiRewrite value={feedback} onChange={setFeedback} />}>
            <Textarea value={feedback} onChange={(e) => setFeedback(e.target.value)} minRows={2} placeholder="What must change before the gate can pass?" />
          </Field>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setSendBack(false)}>Cancel</Button>
            <Button size="sm" icon={CornerUpLeft} busy={busy === 'send_back'} disabled={!goto || !feedback.trim() || !!busy} onClick={() => void doSendBack()}>
              Send back
            </Button>
          </div>
        </div>
      )}

      <ActionBar
        note={!canAct ? <NotAllowed>{blockedReason}</NotAllowed>
          : !canOverride ? <NotAllowed>Only {overrideRoles.join(', ') || 'authorised roles'} can override this gate.</NotAllowed>
            : chosen.length ? `${plural(chosen.length, 'finding')} selected` : undefined}
      >
        <Button variant="outline" size="sm" icon={RefreshCw} busy={busy === 'rerun'} disabled={!canAct || !!busy} onClick={() => void rerun()}>
          {chosen.length ? 'Re-run selected' : 'Re-run checks'}
        </Button>
        <Button variant="outline" size="sm" icon={CornerUpLeft} disabled={!canAct || !!busy || targets.length === 0 || sendBack} onClick={() => setSendBack(true)}>
          Send back
        </Button>
        <Button variant="danger" size="sm" icon={ShieldAlert} busy={busy === 'override'} disabled={!canAct || !canOverride || !!busy || (blocking.length === 0 && chosen.length === 0)} onClick={() => void override()}>
          Override{chosen.length ? ` (${chosen.length})` : ''}
        </Button>
      </ActionBar>
    </div>
  );
}

function CheckRow({ check, blocking, selectable, selected, onToggle }: {
  check: CheckResult;
  blocking: boolean;
  selectable: boolean;
  selected: boolean;
  onToggle: () => void;
}) {
  const [open, setOpen] = useState(blocking);
  const hasDetail = !!(check.evidence || check.recommendation || check.override_comment);
  return (
    <li className={cls('px-3 py-2.5', blocking && 'bg-rose-50/50 dark:bg-rose-500/[0.04]')}>
      <div className="flex items-start gap-2.5">
        {selectable && (
          <span className="pt-0.5">
            <Checkbox checked={selected} onChange={onToggle} label={<span className="sr-only">Select {check.code || check.title}</span>} />
          </span>
        )}
        <button type="button" className="min-w-0 flex-1 text-left" onClick={() => hasDetail && setOpen((o) => !o)} aria-expanded={hasDetail ? open : undefined}>
          <div className="flex flex-wrap items-center gap-1.5">
            {hasDetail && (open ? <ChevronDown size={13} className="text-faint" /> : <ChevronRight size={13} className="text-faint" />)}
            {check.code && <code className="rounded bg-zinc-100 px-1 py-px font-mono text-[11px] font-semibold text-zinc-600 dark:bg-ink-600 dark:text-zinc-300">{check.code}</code>}
            <span className="text-sm font-medium text-zinc-800 dark:text-zinc-100">{check.title || check.rule_id}</span>
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <StatusBadge kind="severity" value={check.severity} size="xs" />
            {check.overridden_by
              ? <Badge tone="amber" size="xs" icon={ShieldAlert}>Overridden</Badge>
              : <StatusBadge kind="check" value={check.status} size="xs" />}
            {blocking && <Badge tone="rose" variant="solid" size="xs">Blocking</Badge>}
          </div>
        </button>
      </div>
      {open && hasDetail && (
        <div className={cls('mt-2 space-y-2 text-xs animate-fade-in', selectable ? 'pl-7' : 'pl-5')}>
          {check.evidence && (
            <div>
              <div className="label-xs mb-0.5">Evidence</div>
              <Markdown content={check.evidence} size="xs" />
            </div>
          )}
          {check.recommendation && (
            <div>
              <div className="label-xs mb-0.5">Recommendation</div>
              <Markdown content={check.recommendation} size="xs" />
            </div>
          )}
          {check.overridden_by && (
            <div className="rounded-md bg-amber-50 px-2 py-1.5 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
              <span className="inline-flex items-center gap-1">Overridden by <ActorName id={check.overridden_by} size={14} /></span>
              {check.override_comment && <> — “{check.override_comment}”</>}
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/** Read-only findings list for finished gates. */
export function GateSummary({ step }: { project: Project; step: StepRun }) {
  const blockOn = stepConfig(step, 'quality_gate').block_on ?? 'high';
  const checks = step.checks ?? [];
  if (!checks.length) return null;
  const failed = checks.filter((c) => c.status === 'fail').length;
  return (
    <Section title={`Findings · ${checks.length}`} icon={ShieldCheck} actions={<span className="text-[11px] text-muted">{failed} failed · {checks.filter((c) => c.overridden_by).length} overridden</span>}>
      <ul className="divide-y hairline overflow-hidden rounded-lg border hairline">
        {checks.map((c) => <CheckRow key={keyOf(c)} check={c} blocking={isBlocking(c, blockOn)} selectable={false} selected={false} onToggle={() => undefined} />)}
      </ul>
    </Section>
  );
}
