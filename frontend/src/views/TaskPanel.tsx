// Task panel — the action surface for ONE step of ONE project, used inline by the Inbox (right pane)
// and by ProjectDetail (step drawer). It shows who must act and by when, the context needed to
// decide, the live trace while the Factory works, and the primary actions for the step's type and
// status (submit a form, approve, estimate, confirm an MCP write, review a gate or an AI draft,
// handle a failure, start, complete, reopen). Every action calls api.steps.* as the acting persona,
// toasts the outcome and reports the updated project through onChanged.
//
// The panel keeps itself live: on `project.updated` for its project it re-reads the project (the
// AI draft landing, another approver signing) and forwards it through onChanged, so a parent that
// only renders what it is given still stays current.
import { AlertTriangle, ExternalLink, FolderX, SearchX, Siren } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../api';
import { StepIcon } from '../components/StepIcon';
import { AvatarStack, Badge, EmptyState, StatusBadge, TONE, Tooltip, toneOf } from '../components/ui';
import { cls } from '../lib/cls';
import { dueLabel, formatDateTime, timeAgo, toMs } from '../lib/format';
import { Link, paths } from '../lib/router';
import { useApp, useLive } from '../lib/store';
import type { Project } from '../types';
import { STEP_TYPES } from '../types';
import { AiReview } from './task/AiReview';
import { ApprovalAction } from './task/ApprovalAction';
import { useStepAction } from './task/common';
import { AgentToolCallAction, ConfirmOperationAction } from './task/ConfirmAction';
import { StepContext } from './task/Context';
import { EstimationAction } from './task/EstimationAction';
import { FormAction } from './task/FormAction';
import { GateReview } from './task/GateReview';
import { approvalState, assigneeLabel, canActOnStep, findStep } from './task/logic';
import {
  FailedView, FinishedView, ManualCompleteView, PendingView, RunningView, WaitChildrenView, WaitExternalView,
} from './task/StateViews';
import { useLiveTrace } from './task/TraceView';
import type { ActionProps } from './task/types';

export interface TaskPanelProps {
  project: Project;
  stepId: string;
  /** Called with the updated project after every successful action. */
  onChanged?: (project: Project) => void;
  /** Tighter layout for drawers. */
  compact?: boolean;
}

const isNewer = (a: Project, b: Project) => (toMs(a.updated_at) ?? 0) >= (toMs(b.updated_at) ?? 0);

export default function TaskPanel({ project: given, stepId, onChanged, compact }: TaskPanelProps) {
  const [project, setProject] = useState(given);
  const [deleted, setDeleted] = useState(false);
  const current = useRef(project);
  current.current = project;
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  // The parent's copy wins whenever it is at least as fresh as ours (or is another project).
  useEffect(() => {
    setProject((cur) => (cur.id !== given.id || isNewer(given, cur) ? given : cur));
    setDeleted(false);
  }, [given]);

  const accept = useCallback((p: Project) => {
    setProject(p);
    onChangedRef.current?.(p);
  }, []);

  // ---- Live refresh -------------------------------------------------------------------------
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const refresh = useCallback(async (id: string) => {
    try {
      const fresh = await api.projects.get(id);
      if (fresh.id === current.current.id && isNewer(fresh, current.current)) accept(fresh);
    } catch {
      /* the next event retries; a deleted project arrives as project.deleted */
    }
  }, [accept]);
  useLive('project.updated', (e) => {
    if (e.project_id !== current.current.id) return;
    const seen = toMs(current.current.updated_at) ?? 0;
    if ((toMs(e.summary?.updated_at) ?? Infinity) <= seen) return;
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void refresh(e.project_id), 250);
  });
  useLive('project.deleted', (e) => {
    if (e.project_id === current.current.id) setDeleted(true);
  });
  useEffect(() => () => clearTimeout(timer.current), []);

  const loc = findStep(project, stepId);
  if (deleted) return <EmptyState compact icon={FolderX} title="This project was deleted" description="Nothing left to do here." />;
  if (!loc) {
    return (
      <EmptyState
        compact
        icon={SearchX}
        title="This step no longer exists"
        description="The project may have been changed since this link was created."
        action={<Link to={paths.project(project.id)} className="text-sm font-semibold text-brand-600 hover:underline dark:text-brand-400">Open {project.key}</Link>}
      />
    );
  }
  return <PanelBody project={project} loc={loc} onChanged={accept} compact={compact} />;
}

function PanelBody({ project, loc, onChanged, compact }: {
  project: Project;
  loc: NonNullable<ReturnType<typeof findStep>>;
  onChanged: (p: Project) => void;
  compact?: boolean;
}) {
  const app = useApp();
  const { step } = loc;
  const [busy, run] = useStepAction(onChanged);
  const trace = useLiveTrace(project.id, step);

  const closed = project.status === 'cancelled';
  const roleLabel = (key: string) => app.roleByKey(key)?.label ?? key;
  const allowed = !closed && canActOnStep(project, step, app.me, app.isAdmin);
  let blockedReason = '';
  if (closed) blockedReason = 'This project was cancelled — its steps are read-only.';
  else if (!app.me) blockedReason = 'Choose who you are acting as (top right) to act on this step.';
  else if (!allowed) {
    if (step.type === 'approval') {
      const st = approvalState(project, step, app.me, app.isAdmin);
      const waiting = st.waitingFor || assigneeLabel(step, app.users, roleLabel);
      blockedReason = st.myDecision
        ? `You ${st.myDecision.decision} ${timeAgo(st.myDecision.at)} — waiting for: ${waiting}.`
        : `Waiting for: ${waiting}. Switch persona to act as one of them.`;
    } else {
      blockedReason = `Assigned to ${assigneeLabel(step, app.users, roleLabel)} — switch persona to act.`;
    }
  }

  const props: ActionProps = {
    project, step, userId: app.userId, canAct: allowed, blockedReason, busy, run, trace, compact,
  };
  const waitsOnPerson = step.status === 'waiting_human' || step.status === 'waiting_approval' || step.status === 'failed';

  return (
    <div className={cls('min-w-0', compact ? 'space-y-4' : 'space-y-5')}>
      <PanelHeader project={project} loc={loc} compact={compact} />
      {step.feedback && (step.status !== 'done' && step.status !== 'skipped') && (
        <div className="flex items-start gap-2.5 rounded-lg border border-amber-500/40 bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:bg-amber-500/10 dark:text-amber-200">
          <AlertTriangle size={16} className="mt-0.5 shrink-0 text-amber-500" />
          <div className="min-w-0">
            <div className="font-semibold">Sent back by a reviewer</div>
            <p className="mt-0.5 whitespace-pre-wrap text-[13px] leading-relaxed">{step.feedback}</p>
          </div>
        </div>
      )}
      <StepContext project={project} step={step} defaultOpen={!compact && waitsOnPerson && step.type !== 'approval'} />
      <div key={`${step.id}:${step.status}:${step.pending_action?.kind ?? ''}`} className="animate-fade-in">
        {renderBody(props)}
      </div>
    </div>
  );
}

function renderBody(props: ActionProps): ReactNode {
  const { step } = props;
  switch (step.status) {
    case 'pending': return <PendingView {...props} />;
    case 'running': return <RunningView {...props} />;
    case 'waiting_approval': return <ApprovalAction {...props} />;
    case 'waiting_children': return <WaitChildrenView {...props} />;
    case 'waiting_external': return <WaitExternalView {...props} />;
    case 'failed': return <FailedView {...props} />;
    case 'done':
    case 'skipped':
    case 'rejected': return <FinishedView {...props} />;
    case 'waiting_human': {
      switch (step.pending_action?.kind) {
        case 'confirm_operation': return <ConfirmOperationAction {...props} />;
        case 'agent_tool_call': return <AgentToolCallAction {...props} />;
        case 'gate_review': return <GateReview {...props} />;
        case 'ai_review': return <AiReview {...props} />;
        default: break;
      }
      if (step.type === 'human_form') return <FormAction {...props} />;
      if (step.type === 'estimation') return <EstimationAction {...props} />;
      if (step.type === 'quality_gate') return <GateReview {...props} />;
      if (step.type === 'approval') return <ApprovalAction {...props} />;
      return <ManualCompleteView {...props} />;
    }
    default: return <ManualCompleteView {...props} />;
  }
}

function PanelHeader({ project, loc, compact }: { project: Project; loc: NonNullable<ReturnType<typeof findStep>>; compact?: boolean }) {
  const { userById, roleByKey } = useApp();
  const { step, stage } = loc;
  const assignees = step.assignee_user_ids.map((id) => userById(id)).filter((u) => !!u);
  const due = dueLabel(step.due_at);
  const terminal = step.status === 'done' || step.status === 'skipped';
  const typeMeta = STEP_TYPES[step.type];

  return (
    <header className="flex items-start gap-3">
      <StepIcon type={step.type} status={step.status} size={compact ? 'md' : 'lg'} />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          <Link to={paths.project(project.id)} className="shrink-0 font-mono font-semibold text-brand-600 hover:underline dark:text-brand-400">{project.key}</Link>
          <span className="min-w-0 truncate text-muted" title={project.title}>{project.title}</span>
          {project.risk?.level === 'high' && <Badge tone="rose" size="xs" dot title={project.risk.reasons.join(' · ')}>High risk</Badge>}
        </div>
        <h2 className={cls('mt-0.5 font-bold tracking-tight text-zinc-900 dark:text-white', compact ? 'text-base' : 'text-lg')}>{step.name}</h2>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1.5 text-xs text-muted">
          <span className="inline-flex items-center gap-1">
            <span className={cls('h-1.5 w-1.5 rounded-full', TONE[toneOf(stage.color)].dot)} aria-hidden />
            {stage.name}
          </span>
          <span className="text-faint">›</span>
          <span>{typeMeta?.label ?? step.type}</span>
          <StatusBadge kind="step" value={step.status} size="xs" />
          {step.sla_breached && !terminal && <Badge tone="rose" variant="solid" size="xs" icon={Siren} title="The step is past its SLA — the owner was notified">SLA breached</Badge>}
          {due.label && !terminal && (
            <Badge tone={due.overdue ? 'rose' : due.soon ? 'amber' : 'zinc'} size="xs" title={`Due ${formatDateTime(step.due_at)}`}>{due.label}</Badge>
          )}
        </div>
      </div>
      <div className="flex shrink-0 flex-col items-end gap-2">
        {assignees.length > 0 ? (
          <Tooltip content={`Assigned to ${assignees.map((u) => u.name).join(', ')}`}>
            <AvatarStack users={assignees} max={compact ? 3 : 4} size={compact ? 22 : 26} />
          </Tooltip>
        ) : step.assignee.roles.length > 0 ? (
          <div className="flex max-w-[12rem] flex-wrap justify-end gap-1">
            {step.assignee.roles.slice(0, 3).map((r) => <Badge key={r} tone={toneOf(roleByKey(r)?.color)} size="xs">{roleByKey(r)?.label ?? r}</Badge>)}
          </div>
        ) : null}
        {!compact && (
          <Link to={paths.project(project.id, step.id)} className="inline-flex items-center gap-1 text-[11px] font-semibold text-faint hover:text-brand-600 dark:hover:text-brand-400">
            Open in project <ExternalLink size={11} />
          </Link>
        )}
      </div>
    </header>
  );
}
