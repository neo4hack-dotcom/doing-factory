// Read-only anatomy of one step: status and timings, who it waits for, what the AI and the people
// produced (form, brief, approvals, checks, estimate, output, artifacts, links, children), and the
// two management actions that are not part of the task itself — reassign and reopen.
import {
  AlertTriangle, ArrowUpRight, Clock, ExternalLink, FileText, GitFork, Lightbulb, MessageSquareWarning, RotateCcw,
  ShieldCheck, Sparkles, Stamp, UserRoundCog, Users,
} from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../../api';
import { FormRenderer } from '../../components/FormRenderer';
import { Markdown, safeUrl } from '../../components/Markdown';
import {
  Avatar, Badge, Button, Modal, StatusBadge, Tooltip, useBusy, useConfirmReason, useToast,
} from '../../components/ui';
import { cls } from '../../lib/cls';
import { dueLabel, formatDateTime, formatDuration, formatNumber, humanize, timeAgo } from '../../lib/format';
import { Link, paths } from '../../lib/router';
import { CHECK_STATUS, SEVERITY } from '../../lib/status';
import { useApp } from '../../lib/store';
import { STEP_TYPES } from '../../types';
import type { FieldDef, Project, ProjectSummary, StepRun } from '../../types';
import { pendingApproverRoles, stepDurationMs } from './model';
import type { StepRef } from './model';
import { VarValue } from './values';

export function Section({ title, icon: Icon, children, aside, className }: {
  title: ReactNode; icon?: typeof Clock; children: ReactNode; aside?: ReactNode; className?: string;
}) {
  return (
    <section className={cls('space-y-2', className)}>
      <div className="flex items-center justify-between gap-2">
        <h4 className="label-xs flex items-center gap-1.5">{Icon && <Icon size={12} />}{title}</h4>
        {aside}
      </div>
      {children}
    </section>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="label-xs mb-0.5">{label}</div>
      <div className="truncate text-sm text-zinc-800 dark:text-zinc-200">{children}</div>
    </div>
  );
}

export function StepDetails({ project, stepRef, childSummaries, onChanged, onOpenArtifact }: {
  project: Project;
  stepRef: StepRef;
  childSummaries: ProjectSummary[];
  onChanged: (project: Project) => void;
  onOpenArtifact: (artifactId: string) => void;
}) {
  const { step, stage } = stepRef;
  const { userById, roleByKey, me, userId } = useApp();
  const confirmReason = useConfirmReason();
  const toast = useToast();
  const [busy, run] = useBusy();
  const [reassignOpen, setReassignOpen] = useState(false);

  const type = STEP_TYPES[step.type];
  const elapsed = stepDurationMs(step);
  const due = step.due_at ? dueLabel(step.due_at) : null;
  const artifacts = project.artifacts.filter((a) => a.step_id === step.id);
  const links = project.links.filter((l) => l.step_id === step.id);
  const kids = childSummaries.filter((c) => step.child_ids.includes(c.id));
  const assignees = step.assignee_user_ids.map((id) => userById(id)).filter(Boolean);
  const pendingRoles = pendingApproverRoles(step);
  const manager = !!me && (me.roles.includes('admin') || project.owner_id === me.id);
  const reopenable = ['done', 'skipped', 'rejected', 'failed'].includes(step.status);
  const reassignable = ['pending', 'waiting_human', 'waiting_approval', 'failed'].includes(step.status);
  const fields = (step.config.fields as FieldDef[] | undefined) ?? [];

  const reopen = async () => {
    const reason = await confirmReason({
      title: `Reopen “${step.name}”?`,
      message: 'The step and every later step of the workflow go back to pending; the trace is kept and your reason becomes the feedback for the rerun.',
      tone: 'warning',
      confirmLabel: 'Reopen step',
      reasonLabel: 'Feedback',
      reasonPlaceholder: 'What must change this time?',
    });
    if (reason === null) return;
    await run('reopen', async () => {
      onChanged(await api.steps.reopen(project.id, step.id, userId, reason));
      toast.success('Step reopened.');
    });
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-4">
        <Fact label="Status"><StatusBadge kind="step" value={step.status} /></Fact>
        <Fact label="Type">{type?.label ?? step.type}</Fact>
        <Fact label="Stage">{stage.name}</Fact>
        <Fact label="Attempts"><span className="num">{step.attempts || '—'}</span></Fact>
        <Fact label="Started"><span title={formatDateTime(step.started_at)}>{step.started_at ? timeAgo(step.started_at) : '—'}</span></Fact>
        <Fact label={step.completed_at ? 'Took' : 'Elapsed'}>{elapsed !== null ? formatDuration(elapsed) : '—'}</Fact>
        <Fact label="Due">
          {due ? (
            <span className={cls(step.sla_breached || due.overdue ? 'text-rose-600 dark:text-rose-400' : due.soon ? 'text-amber-600 dark:text-amber-400' : '')} title={formatDateTime(step.due_at)}>
              {step.sla_breached ? 'SLA breached' : due.label}
            </span>
          ) : step.sla_hours ? `${step.sla_hours} h SLA` : '—'}
        </Fact>
        <Fact label="Completed by">
          {step.completed_by ? (userById(step.completed_by)?.name ?? humanize(step.completed_by)) : '—'}
        </Fact>
      </div>

      {(step.description || type) && (
        <p className="text-sm leading-relaxed text-zinc-600 dark:text-zinc-300">{step.description || type?.description}</p>
      )}

      {step.status === 'failed' && step.error && (
        <div className="rounded-lg border border-rose-500/30 bg-rose-50 p-3 text-sm dark:bg-rose-500/10">
          <div className="flex items-center gap-1.5 font-semibold text-rose-700 dark:text-rose-300"><AlertTriangle size={14} />Failed</div>
          <p className="mt-1 whitespace-pre-wrap break-words text-rose-800 dark:text-rose-200">{step.error}</p>
          {step.heal_hint && (
            <p className="mt-2 flex gap-1.5 text-xs text-rose-700/90 dark:text-rose-200/80"><Lightbulb size={13} className="mt-px shrink-0" /><span><b>Critic advice:</b> {step.heal_hint}</span></p>
          )}
        </div>
      )}
      {step.feedback && (
        <div className="rounded-lg border border-amber-500/30 bg-amber-50 p-3 text-sm dark:bg-amber-500/10">
          <div className="flex items-center gap-1.5 font-semibold text-amber-800 dark:text-amber-300"><MessageSquareWarning size={14} />Reviewer feedback</div>
          <p className="mt-1 whitespace-pre-wrap text-amber-900 dark:text-amber-100">{step.feedback}</p>
        </div>
      )}
      {step.pending_action && (
        <div className="rounded-lg border border-violet-500/30 bg-violet-50 p-3 text-sm dark:bg-violet-500/10">
          <div className="font-semibold text-violet-800 dark:text-violet-200">{step.pending_action.title}</div>
          {step.pending_action.description && <p className="mt-1 text-violet-900/80 dark:text-violet-100/80">{step.pending_action.description}</p>}
        </div>
      )}

      <Section title="Assigned to" icon={Users} aside={manager && reassignable && (
        <Button size="xs" variant="ghost" icon={UserRoundCog} onClick={() => setReassignOpen(true)}>Reassign</Button>
      )}>
        {assignees.length ? (
          <div className="flex flex-wrap gap-2">
            {assignees.map((u) => u && (
              <span key={u.id} className="inline-flex items-center gap-1.5 rounded-full border hairline py-0.5 pl-0.5 pr-2 text-xs">
                <Avatar user={u} size={20} />{u.name}
              </span>
            ))}
          </div>
        ) : (
          <p className="text-xs text-muted">
            {step.assignee.roles.length || step.assignee.project_role
              ? <>Anyone with {[...step.assignee.roles.map((r) => roleByKey(r)?.label ?? humanize(r)), step.assignee.project_role && `the project ${step.assignee.project_role.replace('_', ' ')}`].filter(Boolean).join(', ')} {step.status === 'pending' ? '(resolved when the step starts)' : ''}</>
              : type?.automated ? 'Automated — the engine runs it.' : 'Nobody assigned.'}
          </p>
        )}
      </Section>

      {step.type === 'approval' && (
        <Section title="Approvals" icon={Stamp}>
          {step.approvals.length === 0 && pendingRoles.length === 0 && <p className="text-xs text-muted">No decision yet.</p>}
          <ul className="space-y-2">
            {step.approvals.map((a, i) => {
              const u = userById(a.user_id);
              return (
                <li key={`${a.user_id}-${i}`} className="flex items-start gap-2.5">
                  <Avatar user={u} name={a.user_id} size={24} />
                  <div className="min-w-0 flex-1 text-sm">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-semibold">{u?.name ?? 'Unknown user'}</span>
                      <span className="text-xs text-muted">as {roleByKey(a.role)?.label ?? humanize(a.role)}</span>
                      <Badge tone={a.decision === 'approved' ? 'emerald' : 'rose'} size="xs">{a.decision === 'approved' ? 'Approved' : 'Rejected'}</Badge>
                      <span className="text-[11px] text-faint" title={formatDateTime(a.at)}>{timeAgo(a.at)}</span>
                    </div>
                    {a.comment && <p className="mt-0.5 whitespace-pre-wrap text-xs text-zinc-600 dark:text-zinc-300">“{a.comment}”</p>}
                  </div>
                </li>
              );
            })}
            {!['done', 'rejected', 'skipped'].includes(step.status) && pendingRoles.map((r) => (
              <li key={r} className="flex items-center gap-2.5 text-sm text-muted">
                <span className="grid h-6 w-6 place-items-center rounded-full border border-dashed border-zinc-300 dark:border-ink-400"><Clock size={11} /></span>
                Waiting for {roleByKey(r)?.label ?? humanize(r)}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {step.brief && (
        <Section title={<span className="inline-flex items-center gap-1"><Sparkles size={12} className="text-violet-500" />AI decision brief</span>}>
          <div className="rounded-lg border p-3 ring-ai dark:border-ink-500"><Markdown content={step.brief} size="xs" /></div>
        </Section>
      )}

      {step.checks.length > 0 && <ChecksTable step={step} />}

      {step.estimate && (step.estimate.value !== null && step.estimate.value !== undefined) && (
        <Section title="Estimate">
          <div className="flex flex-wrap items-baseline gap-2">
            <span className="num text-2xl font-bold">{formatNumber(step.estimate.value, 1)}</span>
            <span className="text-sm text-muted">{step.estimate.unit}</span>
            <Badge size="xs">{humanize(step.estimate.confidence)} confidence</Badge>
            {step.estimate.submitted_by && <span className="text-xs text-muted">by {userById(step.estimate.submitted_by)?.name ?? step.estimate.submitted_by}</span>}
          </div>
          {step.estimate.breakdown.length > 0 && (
            <ul className="divide-y divide-zinc-100 rounded-lg border hairline text-xs dark:divide-ink-600">
              {step.estimate.breakdown.map((b, i) => (
                <li key={i} className="flex justify-between gap-3 px-3 py-1.5"><span>{b.item}</span><span className="num font-semibold">{b.value}</span></li>
              ))}
            </ul>
          )}
          {step.estimate.rationale && <p className="text-xs text-zinc-600 dark:text-zinc-300">{step.estimate.rationale}</p>}
        </Section>
      )}

      {step.type === 'human_form' && fields.length > 0 && Object.keys(step.form ?? {}).length > 0 && (
        <Section title="Form">
          <FormRenderer fields={fields} value={step.form} onChange={() => {}} readOnly aiDraft={step.ai_draft} columns={1} />
        </Section>
      )}

      {(step.output_summary || (step.output !== undefined && step.output !== null)) && (
        <Section title="Output" aside={step.store_as && <code className="text-[10px] text-faint">vars.{step.store_as}</code>}>
          {step.output_summary && <p className="text-sm text-zinc-700 dark:text-zinc-200">{step.output_summary}</p>}
          {step.output !== undefined && step.output !== null && step.type !== 'human_form' && (
            <div className="max-h-[420px] overflow-y-auto"><VarValue value={step.output} /></div>
          )}
        </Section>
      )}

      {artifacts.length > 0 && (
        <Section title="Artifacts" icon={FileText}>
          <ul className="space-y-2">
            {artifacts.map((a) => (
              <li key={a.id} className="rounded-lg border hairline">
                <div className="flex items-center justify-between gap-2 border-b hairline px-3 py-2">
                  <span className="truncate text-sm font-semibold">{a.title}</span>
                  <Button size="xs" variant="ghost" iconRight={ArrowUpRight} onClick={() => onOpenArtifact(a.id)}>Open</Button>
                </div>
                {a.kind === 'markdown' && a.content && (
                  <div className="relative max-h-48 overflow-hidden px-3 py-2">
                    <Markdown content={a.content} size="xs" />
                    <div className="pointer-events-none absolute inset-x-0 bottom-0 h-10 bg-gradient-to-t from-white dark:from-ink-900" />
                  </div>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}

      {links.length > 0 && (
        <Section title="Links">
          <div className="flex flex-wrap gap-1.5">
            {links.map((l) => (
              <a key={l.id} href={safeUrl(l.url)} target="_blank" rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-md border hairline px-2 py-1 text-xs font-medium hover:border-brand-500/60">
                {l.label}{l.status && <span className="text-faint">· {l.status}</span>}<ExternalLink size={11} className="text-faint" />
              </a>
            ))}
          </div>
        </Section>
      )}

      {step.child_ids.length > 0 && (
        <Section title="Child projects" icon={GitFork}>
          <ul className="space-y-1.5">
            {step.child_ids.map((cid) => {
              const c = kids.find((k) => k.id === cid);
              return (
                <li key={cid}>
                  <Link to={paths.project(cid)} className="flex items-center gap-2 rounded-lg border hairline px-3 py-2 text-sm hover:border-brand-500/60">
                    <span className="num text-xs font-bold text-muted">{c?.key ?? cid}</span>
                    <span className="min-w-0 flex-1 truncate font-medium">{c?.title ?? 'Child project'}</span>
                    {c && <StatusBadge kind="project" value={c.status} size="xs" />}
                  </Link>
                </li>
              );
            })}
          </ul>
        </Section>
      )}

      {manager && reopenable && (
        <div className="flex flex-wrap items-center gap-2 border-t hairline pt-4">
          <Button size="sm" variant="outline" icon={RotateCcw} busy={busy === 'reopen'} onClick={() => void reopen()}>Reopen step</Button>
          <span className="text-[11px] text-faint">Owner & admin action · recorded in the audit trail</span>
        </div>
      )}

      <ReassignModal open={reassignOpen} onClose={() => setReassignOpen(false)} project={project} step={step} onChanged={onChanged} />
    </div>
  );
}

function ChecksTable({ step }: { step: StepRun }) {
  const [open, setOpen] = useState<string | null>(null);
  const failed = step.checks.filter((c) => c.status === 'fail').length;
  return (
    <Section title="Compliance checks" icon={ShieldCheck} aside={<span className="text-[11px] text-muted">{step.checks.length - failed}/{step.checks.length} passing</span>}>
      <ul className="divide-y divide-zinc-100 rounded-lg border hairline dark:divide-ink-600">
        {step.checks.map((c) => {
          const st = CHECK_STATUS[c.status] ?? CHECK_STATUS.na;
          const sev = SEVERITY[c.severity] ?? SEVERITY.low;
          const key = c.rule_id || c.code;
          const expanded = open === key;
          return (
            <li key={key}>
              <button type="button" onClick={() => setOpen(expanded ? null : key)} className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs hover:bg-zinc-50 dark:hover:bg-ink-700/40">
                <Badge tone={st.tone} size="xs" dot>{st.label}</Badge>
                <span className="num w-14 shrink-0 font-mono text-[10px] text-muted">{c.code}</span>
                <span className="min-w-0 flex-1 truncate font-medium">{c.title}</span>
                {c.overridden_by && <Tooltip content={c.override_comment || 'Overridden'}><Badge tone="violet" size="xs">Overridden</Badge></Tooltip>}
                <Badge tone={sev.tone} size="xs" variant="outline">{sev.label}</Badge>
              </button>
              {expanded && (c.evidence || c.recommendation) && (
                <div className="space-y-1.5 px-3 pb-2.5 text-xs">
                  {c.evidence && <p><span className="font-semibold">Evidence: </span>{c.evidence}</p>}
                  {c.recommendation && <p className="text-zinc-600 dark:text-zinc-300"><span className="font-semibold">Recommendation: </span>{c.recommendation}</p>}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

function ReassignModal({ open, onClose, project, step, onChanged }: {
  open: boolean; onClose: () => void; project: Project; step: StepRun; onChanged: (p: Project) => void;
}) {
  const { userId } = useApp();
  const toast = useToast();
  const [value, setValue] = useState<Record<string, unknown>>({ users: step.assignee_user_ids });
  const [busy, run] = useBusy();
  const ids = Array.isArray(value.users) ? (value.users as string[]) : [];
  const save = () => run('save', async () => {
    onChanged(await api.steps.reassign(project.id, step.id, userId, ids));
    toast.success('Step reassigned — the new assignees see it in their inbox.');
    onClose();
  });
  return (
    <Modal open={open} onClose={onClose} title="Reassign step" subtitle={step.name} icon={UserRoundCog}
      footer={<>
        <Button variant="outline" onClick={onClose}>Cancel</Button>
        <Button busy={busy === 'save'} disabled={ids.length === 0} onClick={() => void save()}>Reassign</Button>
      </>}>
      <FormRenderer
        fields={[{ key: 'users', label: 'Assignees', type: 'users', required: true, options: [], help: 'They are notified and the step moves to their inbox.', placeholder: '' }]}
        value={value}
        onChange={setValue}
        columns={1}
      />
    </Modal>
  );
}
