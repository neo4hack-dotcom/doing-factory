// Icon + tone vocabularies for inbox kinds, activity events and trace entries, shared by Home,
// Inbox and the TaskPanel so a kind never looks different on two screens.
import {
  AlertTriangle, Bell, Bot, Brain, Calculator, CheckCircle2, ClipboardPen, CornerDownRight, Eye, FileText,
  FolderKanban, GitFork, Hourglass, Info, Link2, MessageSquare, PlayCircle, Plug, Radar, RotateCcw, Settings,
  ShieldAlert, ShieldCheck, SkipForward, Sparkles, Stamp, ThumbsDown, ThumbsUp, UserRound, Wand2, Workflow,
  Wrench, XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { InboxKind, Tone, TraceKind } from '../../types';

export interface KindMeta {
  label: string;
  /** Plural label for filter chips. */
  plural: string;
  icon: LucideIcon;
  tone: Tone;
  /** Verb on the primary button when the action needs the full panel. */
  verb: string;
}

export const INBOX_KIND: Record<InboxKind, KindMeta> = {
  approval: { label: 'Approval', plural: 'Approvals', icon: Stamp, tone: 'amber', verb: 'Review' },
  form: { label: 'Form', plural: 'Forms', icon: ClipboardPen, tone: 'sky', verb: 'Fill in' },
  estimate: { label: 'Estimate', plural: 'Estimates', icon: Calculator, tone: 'cyan', verb: 'Estimate' },
  review: { label: 'AI review', plural: 'AI reviews', icon: Sparkles, tone: 'violet', verb: 'Review' },
  confirm: { label: 'Confirmation', plural: 'Confirmations', icon: Plug, tone: 'brand', verb: 'Check & run' },
  gate: { label: 'Quality gate', plural: 'Gates', icon: ShieldAlert, tone: 'rose', verb: 'Decide' },
  failure: { label: 'Failure', plural: 'Failures', icon: XCircle, tone: 'rose', verb: 'Fix' },
  start: { label: 'Ready to start', plural: 'Starts', icon: PlayCircle, tone: 'emerald', verb: 'Start' },
  external: { label: 'External wait', plural: 'External', icon: Hourglass, tone: 'teal', verb: 'Check' },
  intake: { label: 'Intake', plural: 'Intake', icon: Radar, tone: 'brand', verb: 'Triage' },
};

/** Display order of the kind filter chips. */
export const INBOX_KIND_ORDER: InboxKind[] = [
  'approval', 'form', 'estimate', 'review', 'gate', 'confirm', 'failure', 'start', 'external', 'intake',
];

/** Icon + tone of an activity event from its dot.case kind (SPEC §8). */
export function activityMeta(kind: string): { icon: LucideIcon; tone: Tone } {
  const exact: Record<string, { icon: LucideIcon; tone: Tone }> = {
    'project.created': { icon: FolderKanban, tone: 'brand' },
    'project.completed': { icon: CheckCircle2, tone: 'emerald' },
    'project.cancelled': { icon: XCircle, tone: 'zinc' },
    'project.blocked': { icon: AlertTriangle, tone: 'rose' },
    'step.completed': { icon: CheckCircle2, tone: 'emerald' },
    'step.failed': { icon: XCircle, tone: 'rose' },
    'step.skipped': { icon: SkipForward, tone: 'zinc' },
    'step.retried': { icon: RotateCcw, tone: 'sky' },
    'step.reopened': { icon: RotateCcw, tone: 'amber' },
    'step.assigned': { icon: UserRound, tone: 'sky' },
    'approval.approved': { icon: ThumbsUp, tone: 'emerald' },
    'approval.rejected': { icon: ThumbsDown, tone: 'rose' },
    'form.submitted': { icon: ClipboardPen, tone: 'sky' },
    'estimate.submitted': { icon: Calculator, tone: 'cyan' },
    'operation.executed': { icon: Plug, tone: 'brand' },
    'agent.tool_call': { icon: Bot, tone: 'fuchsia' },
    'gate.passed': { icon: ShieldCheck, tone: 'emerald' },
    'gate.failed': { icon: ShieldAlert, tone: 'rose' },
    'gate.overridden': { icon: ShieldAlert, tone: 'amber' },
    'artifact.updated': { icon: FileText, tone: 'violet' },
    'comment.added': { icon: MessageSquare, tone: 'sky' },
    'link.added': { icon: Link2, tone: 'indigo' },
    'watcher.run': { icon: Eye, tone: 'teal' },
    'intake.detected': { icon: Radar, tone: 'brand' },
    'intake.accepted': { icon: CheckCircle2, tone: 'emerald' },
    'intake.dismissed': { icon: XCircle, tone: 'zinc' },
    'notification.sent': { icon: Bell, tone: 'pink' },
    'settings.updated': { icon: Settings, tone: 'zinc' },
    'connector.tested': { icon: Plug, tone: 'teal' },
    'blueprint.saved': { icon: Workflow, tone: 'indigo' },
    'demo.installed': { icon: Wand2, tone: 'violet' },
  };
  if (exact[kind]) return exact[kind];
  if (kind.startsWith('stage.') || kind.startsWith('step.')) return { icon: GitFork, tone: 'sky' };
  return { icon: Info, tone: 'zinc' };
}

export const TRACE_KIND: Record<TraceKind, { icon: LucideIcon; tone: Tone; label: string }> = {
  info: { icon: Info, tone: 'zinc', label: 'Info' },
  thought: { icon: Brain, tone: 'violet', label: 'Thought' },
  tool: { icon: Wrench, tone: 'brand', label: 'Tool call' },
  result: { icon: CornerDownRight, tone: 'emerald', label: 'Result' },
  error: { icon: XCircle, tone: 'rose', label: 'Error' },
  human: { icon: UserRound, tone: 'sky', label: 'Person' },
  ai: { icon: Sparkles, tone: 'violet', label: 'AI' },
};
