// approval · waiting_approval: the AI decision brief, the evidence the blueprint asks approvers to
// read (`show_vars`), who signed and who is still missing, then Approve / Reject with a comment.
import { Check, CircleDashed, FileSearch, Sparkles, ThumbsDown, ThumbsUp, Undo2, Users, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { AiRewrite } from '../../components/AiRewrite';
import { Markdown } from '../../components/Markdown';
import { AvatarStack, Badge, Button, Field, ProgressBar, Textarea, Tooltip, useToast } from '../../components/ui';
import { api } from '../../api';
import { cls } from '../../lib/cls';
import { formatDateTime, plural, timeAgo } from '../../lib/format';
import { useApp } from '../../lib/store';
import type { Project, StepRun, User } from '../../types';
import type { ActionProps } from './types';
import { ActionBar, ActorName, AiChip, AiWorking, ArtifactPreview, Collapsible, JsonBlock, NotAllowed, Section } from './common';
import { approvalState, evidenceForVars, findStep, holdsRole, stepConfig } from './logic';
import type { ApprovalState, ApproverRow } from './logic';

export function ApprovalAction({ project, step, userId, canAct, blockedReason, busy, run }: ActionProps) {
  const { me, isAdmin } = useApp();
  const toast = useToast();
  const [comment, setComment] = useState('');
  const [commentError, setCommentError] = useState('');
  const commentRef = useRef<HTMLTextAreaElement>(null);
  const cfg = stepConfig(step, 'approval');
  const state = approvalState(project, step, me, isAdmin);

  const rejectTarget = (() => {
    const onReject = cfg.on_reject;
    if (onReject?.action === 'fail') return 'The step fails and the project is blocked.';
    const all = project.stages.flatMap((s) => s.steps);
    const at = all.findIndex((s) => s.id === step.id);
    const target = onReject?.goto_step ? all.find((s) => s.id === onReject.goto_step) : all[at - 1];
    return target ? `Rejecting sends the work back to “${target.name}” with your comment.` : 'Rejecting sends the work back with your comment.';
  })();

  const approve = () => run(
    'approve',
    () => api.steps.decide(project.id, step.id, userId, 'approved', comment.trim()),
    `Approved — ${step.name}`,
  ).then((p) => p && setComment(''));

  const reject = () => {
    if (!comment.trim()) {
      setCommentError('Say why — your comment goes back to the team.');
      commentRef.current?.focus();
      return;
    }
    void run('reject', () => api.steps.decide(project.id, step.id, userId, 'rejected', comment.trim()), `Rejected — ${step.name}`)
      .then((p) => p && setComment(''));
  };

  const askBrief = async () => {
    try {
      await api.steps.aiDraft(project.id, step.id, userId);
      toast.info('The AI is writing the decision brief…');
    } catch (err) {
      toast.error(err);
    }
  };

  const showVars = cfg.show_vars ?? [];
  const evidence = evidenceForVars(project, showVars);

  return (
    <div className="space-y-5">
      <DecisionBrief step={step} onAsk={() => void askBrief()} />

      {evidence.length > 0 && (
        <Section title="Evidence to review" icon={FileSearch}>
          <div className="space-y-2">
            {evidence.map((ev, i) => {
              if (ev.artifacts.length) {
                return ev.artifacts.map((a, j) => <ArtifactPreview key={a.id} artifact={a} defaultOpen={i === 0 && j === 0} />);
              }
              return (
                <Collapsible
                  key={ev.name}
                  title={ev.step?.name ?? ev.name}
                  meta={ev.value === undefined ? <span className="text-[11px] text-faint">not produced yet</span> : <code className="text-[11px] text-faint">vars.{ev.name}</code>}
                >
                  {ev.value === undefined ? <p className="text-xs text-faint">This step has not produced an output yet.</p> : <JsonBlock value={ev.value} />}
                </Collapsible>
              );
            })}
          </div>
        </Section>
      )}

      <ApproverProgress project={project} step={step} state={state} />

      <div className="space-y-3">
        <Field
          label="Comment"
          help={commentError ? undefined : 'Optional when approving, required when rejecting. Recorded in the audit trail.'}
          error={commentError}
          aside={<AiRewrite value={comment} onChange={setComment} disabled={!canAct} />}
        >
          <Textarea
            ref={commentRef}
            value={comment}
            onChange={(e) => {
              setComment(e.target.value);
              if (commentError) setCommentError('');
            }}
            placeholder={canAct ? 'Conditions, concerns or context for the team…' : ''}
            minRows={2}
            disabled={!canAct || !!busy}
            invalid={!!commentError}
          />
        </Field>
        <ActionBar note={!canAct ? <NotAllowed>{blockedReason}</NotAllowed> : <span className="inline-flex items-center gap-1.5"><Undo2 size={12} className="shrink-0" />{rejectTarget}</span>}>
          <Button variant="outline" size="sm" icon={ThumbsDown} busy={busy === 'reject'} disabled={!canAct || !!busy} onClick={reject} className="hover:!border-rose-400 hover:!text-rose-600">
            Reject
          </Button>
          <Button size="sm" icon={ThumbsUp} busy={busy === 'approve'} disabled={!canAct || !!busy} onClick={() => void approve()}>
            Approve{signAs(state, me, isAdmin)}
          </Button>
        </ActionBar>
      </div>
    </div>
  );
}

/** " as Security" when the persona signs for one specific role. */
function signAs(state: ApprovalState, me: User | null, isAdmin: boolean): string {
  if (!me) return '';
  const role = state.eligibleRoles[0];
  const row = state.rows.find((r) => r.role === role);
  if (row && state.eligibleRoles.length === 1 && state.rows.length > 1) return ` as ${row.label}`;
  if (!role && isAdmin && state.rows.length > 1) return ' as admin';
  return '';
}

function DecisionBrief({ step, onAsk }: { step: StepRun; onAsk: () => void }) {
  if (step.ai_busy && !step.brief) return <AiWorking label="The AI is writing a decision brief for approvers…" lines={5} />;
  if (!step.brief) {
    return (
      <div className="flex flex-wrap items-center gap-3 rounded-lg border border-dashed border-zinc-300 px-3 py-2.5 dark:border-ink-400">
        <Sparkles size={15} className="shrink-0 text-violet-500" />
        <p className="min-w-0 flex-1 text-xs text-muted">No AI decision brief for this approval yet — review the evidence below, or ask the AI to summarise it.</p>
        <Button size="xs" variant="ai" icon={Sparkles} onClick={onAsk}>Write a brief</Button>
      </div>
    );
  }
  return (
    <div className="overflow-hidden rounded-xl border border-violet-500/25 bg-gradient-to-b from-violet-50/70 to-white dark:from-violet-500/[0.07] dark:to-transparent">
      <div className="flex items-center gap-2 border-b border-violet-500/15 px-3.5 py-2">
        <AiChip label="AI brief" />
        <span className="text-xs font-semibold text-zinc-700 dark:text-zinc-200">Decision memo for approvers</span>
        {step.ai_busy && <span className="ml-auto text-[11px] text-violet-600 dark:text-violet-300">updating…</span>}
      </div>
      <div className="max-h-[26rem] overflow-y-auto px-3.5 py-3">
        <Markdown content={step.brief} />
      </div>
    </div>
  );
}

function policyLabel(state: ApprovalState): string {
  if (state.policy === 'any') return 'Any one approval is enough';
  if (state.policy === 'quorum') return `${state.required} approvals needed`;
  return state.rows.length > 1 ? 'Every role below must approve' : 'One approval needed';
}

export function ApproverProgress({ project, step, state }: { project: Project; step: StepRun; state: ApprovalState }) {
  const { users } = useApp();
  if (state.rows.length === 0) return null;
  return (
    <Section
      title="Sign-off"
      icon={Users}
      actions={<span className="num text-[11px] text-muted">{state.approvedCount}/{state.required} · {policyLabel(state)}</span>}
    >
      <ProgressBar value={state.required ? state.approvedCount / state.required : 0} tone="emerald" size="xs" className="mb-2.5" />
      <ul className="divide-y hairline overflow-hidden rounded-lg border hairline">
        {state.rows.map((row) => <ApproverRowView key={row.role} row={row} candidates={candidatesFor(project, step, row, users)} />)}
      </ul>
    </Section>
  );
}

/** Active users who could sign this row (the sponsor row is the project's sponsor only). */
function candidatesFor(project: Project, step: StepRun, row: ApproverRow, users: User[]): User[] {
  const holders = users.filter((u) => u.active && holdsRole(project, u, row.role));
  const assigned = users.filter((u) => step.assignee_user_ids.includes(u.id) && holdsRole(project, u, row.role));
  return [...new Map([...assigned, ...holders].map((u) => [u.id, u])).values()];
}

function ApproverRowView({ row, candidates }: { row: ApproverRow; candidates: User[] }) {
  const { roleByKey } = useApp();
  const roleLabel = roleByKey(row.role)?.label ?? row.role;
  return (
    <li className="flex items-center gap-3 px-3 py-2">
      <span className={cls(
        'grid h-6 w-6 shrink-0 place-items-center rounded-full',
        row.status === 'approved' ? 'bg-emerald-500 text-white' : row.status === 'rejected' ? 'bg-rose-500 text-white' : 'border border-dashed border-zinc-300 text-zinc-400 dark:border-ink-400',
      )}>
        {row.status === 'approved' ? <Check size={13} strokeWidth={3} /> : row.status === 'rejected' ? <X size={13} strokeWidth={3} /> : <CircleDashed size={12} />}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-sm">
          <span className="font-semibold text-zinc-800 dark:text-zinc-100">{row.label}</span>
          {row.label !== roleLabel && <span className="text-[11px] text-faint">{roleLabel}</span>}
        </div>
        {row.approval ? (
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
            <span>{row.status === 'approved' ? 'Approved by' : 'Rejected by'}</span>
            <ActorName id={row.approval.user_id} size={16} />
            <span title={formatDateTime(row.approval.at)}>· {timeAgo(row.approval.at)}</span>
          </div>
        ) : (
          <div className="mt-0.5 text-xs text-muted">
            {candidates.length ? `Waiting for ${candidates.length === 1 ? candidates[0].name : plural(candidates.length, 'possible approver')}` : 'Nobody holds this role yet — add someone in Settings › People'}
          </div>
        )}
        {row.approval?.comment && (
          <p className={cls('mt-1 rounded-md px-2 py-1 text-xs', row.status === 'rejected' ? 'bg-rose-50 text-rose-800 dark:bg-rose-500/10 dark:text-rose-200' : 'bg-zinc-50 text-zinc-700 dark:bg-ink-900 dark:text-zinc-300')}>
            “{row.approval.comment}”
          </p>
        )}
      </div>
      {row.status === 'pending' && candidates.length > 0 && (
        <Tooltip content={candidates.map((u) => u.name).join(', ')}>
          <AvatarStack users={candidates} max={3} size={22} />
        </Tooltip>
      )}
      {row.status !== 'pending' && <Badge tone={row.status === 'approved' ? 'emerald' : 'rose'} size="xs">{row.status === 'approved' ? 'Approved' : 'Rejected'}</Badge>}
    </li>
  );
}

/** Read-only sign-off summary for finished approval steps. */
export function ApprovalSummary({ project, step }: { project: Project; step: StepRun }) {
  const { me, isAdmin } = useApp();
  const state = approvalState(project, step, me, isAdmin);
  if (!findStep(project, step.id)) return null;
  return <ApproverProgress project={project} step={step} state={state} />;
}
