// Building blocks shared by the TaskPanel action areas: the step-action runner (api call → toast →
// onChanged), section chrome, the "why can't I act" note, AI accents and artifact/JSON previews.
import { ChevronDown, ChevronRight, FileJson, FileText, History, Lock, Sparkles } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useCallback, useState } from 'react';
import type { ReactNode } from 'react';
import { Markdown } from '../../components/Markdown';
import { Avatar, CopyButton, Skeleton, useToast } from '../../components/ui';
import { cls } from '../../lib/cls';
import { formatDateTime, timeAgo } from '../../lib/format';
import { useApp } from '../../lib/store';
import type { Artifact, Project } from '../../types';
import { previewJson } from './logic';

// ---------------------------------------------------------------------------------------------
// Action runner
// ---------------------------------------------------------------------------------------------

export type ActionRunner = (key: string, call: () => Promise<Project>, success: string) => Promise<Project | null>;

/**
 * Runs one step action: marks `key` busy, toasts the outcome (backend `detail` on error) and hands
 * the updated project to `onChanged`. Returns the project, or null when the call failed.
 */
export function useStepAction(onChanged: (p: Project) => void): [string | null, ActionRunner] {
  const toast = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const run = useCallback<ActionRunner>(async (key, call, success) => {
    setBusy(key);
    try {
      const project = await call();
      onChanged(project);
      if (success) toast.success(success);
      return project;
    } catch (err) {
      toast.error(err);
      return null;
    } finally {
      setBusy(null);
    }
  }, [onChanged, toast]);
  return [busy, run];
}

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

/** A titled block of the panel (micro-label + optional right-side actions). */
export function Section({ title, icon: Icon, actions, className, children }: {
  title: ReactNode;
  icon?: LucideIcon;
  actions?: ReactNode;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={cls('min-w-0', className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="label-xs flex items-center gap-1.5">
          {Icon && <Icon size={12} className="text-brand-500" />}
          {title}
        </h4>
        {actions && <div className="flex items-center gap-1.5">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Disclosure block: a header button that shows/hides its body. */
export function Collapsible({ title, icon: Icon, meta, defaultOpen = false, className, children }: {
  title: ReactNode;
  icon?: LucideIcon;
  /** Right-aligned summary shown on the header (counts, badges). */
  meta?: ReactNode;
  defaultOpen?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className={cls('rounded-lg border hairline', className)}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-xs font-semibold text-zinc-700 hover:bg-zinc-50 dark:text-zinc-200 dark:hover:bg-ink-700/60"
      >
        {open ? <ChevronDown size={14} className="shrink-0 text-faint" /> : <ChevronRight size={14} className="shrink-0 text-faint" />}
        {Icon && <Icon size={14} className="shrink-0 text-brand-500" />}
        <span className="min-w-0 flex-1 truncate">{title}</span>
        {meta && <span className="flex shrink-0 items-center gap-1.5 font-normal">{meta}</span>}
      </button>
      {open && <div className="border-t hairline px-3 py-3 animate-fade-in">{children}</div>}
    </div>
  );
}

/** Bottom row of primary actions, with an optional explanation on the left. */
export function ActionBar({ note, children, className }: { note?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <div className={cls('flex flex-wrap items-center justify-end gap-2 border-t hairline pt-3', className)}>
      {note && <div className="mr-auto min-w-0 text-xs text-muted">{note}</div>}
      {children}
    </div>
  );
}

/** Why the persona cannot act (shown next to disabled buttons). */
export function NotAllowed({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300">
      <Lock size={13} className="mt-px shrink-0" />
      <span>{children}</span>
    </span>
  );
}

/** Tone-coloured callout (feedback from a reviewer, errors, AI hints). */
export function Callout({ tone, icon: Icon, title, children, className }: {
  tone: 'amber' | 'rose' | 'violet' | 'sky' | 'emerald';
  icon: LucideIcon;
  title?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const tones = {
    amber: 'border-amber-500/30 bg-amber-50 text-amber-900 dark:bg-amber-500/10 dark:text-amber-200',
    rose: 'border-rose-500/30 bg-rose-50 text-rose-900 dark:bg-rose-500/10 dark:text-rose-200',
    violet: 'border-violet-500/30 bg-violet-50 text-violet-900 dark:bg-violet-500/10 dark:text-violet-200',
    sky: 'border-sky-500/30 bg-sky-50 text-sky-900 dark:bg-sky-500/10 dark:text-sky-200',
    emerald: 'border-emerald-500/30 bg-emerald-50 text-emerald-900 dark:bg-emerald-500/10 dark:text-emerald-200',
  };
  const iconTones = {
    amber: 'text-amber-500', rose: 'text-rose-500', violet: 'text-violet-500', sky: 'text-sky-500', emerald: 'text-emerald-500',
  };
  return (
    <div className={cls('flex items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm', tones[tone], className)}>
      <Icon size={16} className={cls('mt-0.5 shrink-0', iconTones[tone])} />
      <div className="min-w-0 flex-1">
        {title && <div className="font-semibold">{title}</div>}
        {children && <div className={cls('min-w-0 text-[13px] leading-relaxed opacity-90', !!title && 'mt-0.5')}>{children}</div>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// AI accents
// ---------------------------------------------------------------------------------------------

/** Gradient "AI" chip — the brand→amber gradient is reserved for AI-made content. */
export function AiChip({ label = 'AI', className }: { label?: string; className?: string }) {
  return (
    <span className={cls('inline-flex items-center gap-1 rounded-md bg-gradient-to-r from-brand-500 to-amber-500 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-white', className)}>
      <Sparkles size={10} />
      {label}
    </span>
  );
}

/** Shimmering placeholder while the local LLM works in the background. */
export function AiWorking({ label, lines = 4, className }: { label: string; lines?: number; className?: string }) {
  return (
    <div className={cls('rounded-lg border border-violet-500/25 bg-violet-50/40 p-3 dark:bg-violet-500/5', className)} aria-busy>
      <div className="mb-2.5 flex items-center gap-2 text-xs font-semibold text-violet-700 dark:text-violet-300">
        <span className="relative flex h-2 w-2">
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-violet-500 opacity-60" />
          <span className="relative inline-flex h-2 w-2 rounded-full bg-violet-500" />
        </span>
        {label}
      </div>
      <Skeleton lines={lines} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Previews
// ---------------------------------------------------------------------------------------------

export function JsonBlock({ value, max = 4000, className }: { value: unknown; max?: number; className?: string }) {
  return (
    <pre className={cls('max-h-72 overflow-auto rounded-lg border hairline bg-zinc-50 p-3 font-mono text-[11.5px] leading-relaxed text-zinc-700 dark:bg-ink-900 dark:text-zinc-300', className)}>
      {previewJson(value, max)}
    </pre>
  );
}

/** A person (avatar + name) from a user id; "AI" / "System" for non-human actors. */
export function ActorName({ id, size = 18, className }: { id: string; size?: number; className?: string }) {
  const { userById } = useApp();
  const user = userById(id);
  if (!id) return <span className={cls('text-faint', className)}>—</span>;
  if (!user) {
    const label = id === 'ai' ? 'AI' : id === 'system' ? 'System' : id === 'scheduler' ? 'Scheduler' : id;
    return <span className={cls('font-medium', className)}>{label}</span>;
  }
  return (
    <span className={cls('inline-flex min-w-0 items-center gap-1.5 font-medium', className)}>
      <Avatar user={user} size={size} />
      <span className="truncate">{user.name}</span>
    </span>
  );
}

/** One artifact: title, version and author on a disclosure header; Markdown or JSON body. */
export function ArtifactPreview({ artifact, defaultOpen = false }: { artifact: Artifact; defaultOpen?: boolean }) {
  const isJson = artifact.kind === 'json';
  const body = isJson ? previewJson(artifact.data ?? artifact.content, 20_000) : artifact.content;
  return (
    <Collapsible
      defaultOpen={defaultOpen}
      icon={isJson ? FileJson : FileText}
      title={artifact.title || 'Untitled artifact'}
      meta={
        <>
          <span className="inline-flex items-center gap-1 text-[11px] text-faint" title={`Updated ${formatDateTime(artifact.updated_at)}`}>
            <History size={11} /> v{artifact.version} · {timeAgo(artifact.updated_at)}
          </span>
        </>
      }
    >
      <div className="mb-2 flex justify-end">
        <CopyButton text={isJson ? body : artifact.content} size="xs" />
      </div>
      <div className="max-h-[28rem] overflow-y-auto pr-1">
        {isJson ? <JsonBlock value={artifact.data ?? artifact.content} max={20_000} className="max-h-none" /> : (
          artifact.content.trim() ? <Markdown content={artifact.content} /> : <p className="text-sm text-faint">This artifact is empty.</p>
        )}
      </div>
    </Collapsible>
  );
}

/** Two-to-four-option toggle (Edit / Preview, status filters). */
export function Segmented<K extends string>({ value, onChange, options, size = 'sm', className }: {
  value: K;
  onChange: (k: K) => void;
  options: Array<{ key: K; label: ReactNode; icon?: LucideIcon; count?: number }>;
  size?: 'xs' | 'sm';
  className?: string;
}) {
  return (
    <div role="radiogroup" className={cls('inline-flex items-center gap-0.5 rounded-lg border hairline bg-zinc-50 p-0.5 dark:bg-ink-900', className)}>
      {options.map((o) => {
        const active = o.key === value;
        const Icon = o.icon;
        return (
          <button
            key={o.key}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.key)}
            className={cls(
              'inline-flex items-center gap-1 rounded-md font-semibold transition-colors',
              size === 'xs' ? 'h-6 px-2 text-[11px]' : 'h-7 px-2.5 text-xs',
              active
                ? 'bg-white text-zinc-900 shadow-sm dark:bg-ink-600 dark:text-white'
                : 'text-zinc-500 hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200',
            )}
          >
            {Icon && <Icon size={12} />}
            {o.label}
            {o.count !== undefined && <span className="num text-[10px] opacity-70">{o.count}</span>}
          </button>
        );
      })}
    </div>
  );
}
