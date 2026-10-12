// One vocabulary for every status-like value the UI shows: label + tone (+ whether a person is
// expected to act). Status colours follow the SPEC design language: emerald done, sky running,
// amber waiting, rose failed/blocked, violet AI. Badges, step icons and pipeline strips all read
// from here, so a status never looks different on two screens.
import type {
  CheckStatus, IntakeStatus, Priority, ProjectStatus, RiskLevel, Severity, StageStatus, StepStatus,
  Tone,
} from '../types';

export interface StatusMeta {
  label: string;
  tone: Tone;
}

export const STEP_STATUS: Record<StepStatus, StatusMeta & { waiting: boolean }> = {
  pending: { label: 'Pending', tone: 'zinc', waiting: false },
  running: { label: 'Running', tone: 'sky', waiting: false },
  waiting_human: { label: 'Needs input', tone: 'amber', waiting: true },
  waiting_approval: { label: 'Awaiting approval', tone: 'amber', waiting: true },
  waiting_children: { label: 'Waiting on children', tone: 'indigo', waiting: false },
  waiting_external: { label: 'Waiting external', tone: 'teal', waiting: false },
  done: { label: 'Done', tone: 'emerald', waiting: false },
  skipped: { label: 'Skipped', tone: 'zinc', waiting: false },
  failed: { label: 'Failed', tone: 'rose', waiting: true },
  rejected: { label: 'Rejected', tone: 'rose', waiting: false },
};

export const PROJECT_STATUS: Record<ProjectStatus, StatusMeta> = {
  active: { label: 'Active', tone: 'sky' },
  waiting: { label: 'Waiting', tone: 'amber' },
  blocked: { label: 'Blocked', tone: 'rose' },
  done: { label: 'Done', tone: 'emerald' },
  cancelled: { label: 'Cancelled', tone: 'zinc' },
  failed: { label: 'Failed', tone: 'rose' },
};

export const STAGE_STATUS: Record<StageStatus, StatusMeta> = {
  pending: { label: 'Pending', tone: 'zinc' },
  active: { label: 'In progress', tone: 'sky' },
  done: { label: 'Done', tone: 'emerald' },
  skipped: { label: 'Skipped', tone: 'zinc' },
};

export const PRIORITY: Record<Priority, StatusMeta & { rank: number }> = {
  low: { label: 'Low', tone: 'zinc', rank: 0 },
  medium: { label: 'Medium', tone: 'sky', rank: 1 },
  high: { label: 'High', tone: 'amber', rank: 2 },
  critical: { label: 'Critical', tone: 'rose', rank: 3 },
};

export const RISK: Record<RiskLevel, StatusMeta> = {
  low: { label: 'Low risk', tone: 'emerald' },
  medium: { label: 'Medium risk', tone: 'amber' },
  high: { label: 'High risk', tone: 'rose' },
};

export const SEVERITY: Record<Severity, StatusMeta & { rank: number }> = {
  low: { label: 'Low', tone: 'sky', rank: 0 },
  medium: { label: 'Medium', tone: 'amber', rank: 1 },
  high: { label: 'High', tone: 'orange', rank: 2 },
  critical: { label: 'Critical', tone: 'rose', rank: 3 },
};

export const CHECK_STATUS: Record<CheckStatus, StatusMeta> = {
  pass: { label: 'Pass', tone: 'emerald' },
  fail: { label: 'Fail', tone: 'rose' },
  warn: { label: 'Warning', tone: 'amber' },
  na: { label: 'N/A', tone: 'zinc' },
  pending: { label: 'Pending review', tone: 'violet' },
};

export const INTAKE_STATUS: Record<IntakeStatus, StatusMeta> = {
  new: { label: 'New', tone: 'brand' },
  accepted: { label: 'Accepted', tone: 'emerald' },
  dismissed: { label: 'Dismissed', tone: 'zinc' },
};

/** Every vocabulary StatusBadge understands, by kind. */
export const STATUS_KINDS = {
  step: STEP_STATUS,
  project: PROJECT_STATUS,
  stage: STAGE_STATUS,
  priority: PRIORITY,
  risk: RISK,
  severity: SEVERITY,
  check: CHECK_STATUS,
  intake: INTAKE_STATUS,
} as const;

export type StatusKind = keyof typeof STATUS_KINDS;

/** Label + tone for any status value; unknown values degrade to a neutral humanised chip. */
export function statusMeta(kind: StatusKind, value: string): StatusMeta {
  const table = STATUS_KINDS[kind] as Record<string, StatusMeta>;
  return table[value] ?? { label: value ? value.replace(/_/g, ' ') : '—', tone: 'zinc' };
}
