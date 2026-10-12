// Step identity at a glance: the tile shows the step *type* (icon + colour from STEP_TYPES) and a
// corner badge shows its *status*. Running automated steps get the AI gradient ring — the Factory's
// "work is happening" signal shared with the Floor.
import {
  Ban, Bot, Boxes, Briefcase, Calculator, Check, CircleDashed, ClipboardList, ClipboardPen, Cpu, Database,
  Factory, FileText, GitFork, GitPullRequest, Hourglass, Layers, Lightbulb, Loader2, Megaphone, Network,
  Package, Pause, Plug, Rocket, Server, Shield, ShieldCheck, Sparkles, Stamp, UserRound, Workflow, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { cls } from '../lib/cls';
import { STEP_STATUS } from '../lib/status';
import { STEP_TYPES } from '../types';
import type { StepStatus, StepType } from '../types';
import { TONE } from './ui';

/**
 * lucide components by name: the icons of STEP_TYPES plus the curated set a blueprint `icon` field
 * may use (the Blueprint Designer offers BLUEPRINT_ICONS as its picker). Unknown names fall back.
 */
export const ICONS: Record<string, LucideIcon> = {
  Sparkles, ClipboardPen, Stamp, Calculator, Plug, Bot, ShieldCheck, GitFork, Megaphone, Hourglass,
  Workflow, Rocket, Server, Boxes, FileText, GitPullRequest, Layers, Network, Factory, Database, Shield,
  Lightbulb, Briefcase, Cpu, Package, ClipboardList,
};

export const BLUEPRINT_ICONS = [
  'Workflow', 'Rocket', 'Server', 'Plug', 'Boxes', 'Layers', 'Network', 'Database', 'GitPullRequest',
  'FileText', 'ClipboardList', 'Shield', 'Lightbulb', 'Briefcase', 'Cpu', 'Package', 'Factory', 'Bot',
] as const;

/** Resolves an icon name from data (blueprint.icon…) with a neutral fallback. */
export function iconByName(name: string | null | undefined, fallback: LucideIcon = Workflow): LucideIcon {
  return (name && ICONS[name]) || fallback;
}

export function stepTypeIcon(type: StepType): LucideIcon {
  return iconByName(STEP_TYPES[type]?.icon, CircleDashed);
}

const STATUS_GLYPH: Partial<Record<StepStatus, LucideIcon>> = {
  running: Loader2,
  waiting_human: UserRound,
  waiting_approval: UserRound,
  waiting_children: GitFork,
  waiting_external: Pause,
  done: Check,
  skipped: Ban,
  failed: X,
  rejected: X,
};

const SIZES = { sm: { box: 'h-6 w-6 rounded-md', icon: 13, badge: 'h-3 w-3', glyph: 8 }, md: { box: 'h-8 w-8 rounded-lg', icon: 16, badge: 'h-3.5 w-3.5', glyph: 9 }, lg: { box: 'h-10 w-10 rounded-xl', icon: 19, badge: 'h-4 w-4', glyph: 10 } };

export function StepIcon({ type, status, size = 'md', className }: {
  type: StepType;
  /** Adds a status badge (and the running ring) when given. */
  status?: StepStatus;
  size?: keyof typeof SIZES;
  className?: string;
}) {
  const meta = STEP_TYPES[type];
  const Icon = stepTypeIcon(type);
  const s = SIZES[size];
  const tone = meta ? TONE[meta.color] : TONE.zinc;
  const Glyph = status ? STATUS_GLYPH[status] : undefined;
  const statusTone = status ? TONE[STEP_STATUS[status].tone] : null;
  const running = status === 'running';
  const muted = status === 'skipped' || status === 'pending';
  return (
    <span
      title={status ? `${meta?.label ?? type} · ${STEP_STATUS[status].label}` : meta?.label ?? type}
      className={cls('relative inline-grid shrink-0 place-items-center', s.box, tone.icon, muted && 'opacity-60', running && 'ring-ai', className)}
    >
      <Icon size={s.icon} />
      {Glyph && statusTone && (
        <span className={cls('absolute -bottom-1 -right-1 grid place-items-center rounded-full ring-2 ring-white dark:ring-ink-800', s.badge, statusTone.solid)}>
          <Glyph size={s.glyph} strokeWidth={3} className={running ? 'animate-spin' : undefined} />
        </span>
      )}
    </span>
  );
}

/** Just the status glyph in its tone (timelines, compact lists). */
export function StepStatusIcon({ status, size = 14, className }: { status: StepStatus; size?: number; className?: string }) {
  const Glyph = STATUS_GLYPH[status] ?? CircleDashed;
  return (
    <Glyph
      size={size}
      aria-label={STEP_STATUS[status].label}
      className={cls(TONE[STEP_STATUS[status].tone].text, status === 'running' && 'animate-spin', className)}
    />
  );
}
