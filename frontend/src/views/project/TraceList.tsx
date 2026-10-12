// Execution trace: what the engine, the AI and the agents did, entry by entry (thoughts, tool calls,
// results, errors, human decisions). Chronological like a console; follows the tail while live
// entries arrive unless the reader scrolled up to read.
import {
  Brain, ChevronDown, ChevronRight, CornerDownRight, Info, ScrollText, Sparkles, UserRound, Wrench, XCircle,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { EmptyState, TONE } from '../../components/ui';
import { cls } from '../../lib/cls';
import { formatDateTime, formatTime } from '../../lib/format';
import type { TraceEntry, TraceKind, Tone } from '../../types';
import { JsonView } from './values';

export const TRACE_KIND: Record<TraceKind, { label: string; icon: LucideIcon; tone: Tone }> = {
  info: { label: 'Info', icon: Info, tone: 'zinc' },
  thought: { label: 'Thought', icon: Brain, tone: 'violet' },
  tool: { label: 'Tool call', icon: Wrench, tone: 'brand' },
  result: { label: 'Result', icon: CornerDownRight, tone: 'emerald' },
  error: { label: 'Error', icon: XCircle, tone: 'rose' },
  human: { label: 'Human', icon: UserRound, tone: 'sky' },
  ai: { label: 'AI', icon: Sparkles, tone: 'violet' },
};

export type TraceRow = TraceEntry & { key?: string; step_id?: string; step_name?: string };

export function TraceList({ entries, showStep, onStepClick, maxHeight = 560, emptyLabel, className }: {
  entries: TraceRow[];
  /** Prefix each entry with its step (merged project trace). */
  showStep?: boolean;
  onStepClick?: (stepId: string) => void;
  maxHeight?: number;
  emptyLabel?: string;
  className?: string;
}) {
  const box = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Stay at the bottom while the reader is there; leave them alone once they scroll up.
  useLayoutEffect(() => {
    const el = box.current;
    if (el && pinned.current) el.scrollTop = el.scrollHeight;
  }, [entries.length]);
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onScroll = () => {
      pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  if (entries.length === 0) {
    return <EmptyState compact icon={ScrollText} title="No trace yet" description={emptyLabel ?? 'Entries appear here as soon as the step runs.'} className={className} />;
  }

  return (
    <div ref={box} className={cls('scroll-thin overflow-y-auto rounded-lg border surface-deep', className)} style={{ maxHeight }}>
      <ol className="divide-y divide-zinc-200/70 dark:divide-ink-600/70">
        {entries.map((e, i) => <TraceItem key={e.key ?? `${e.ts}-${i}`} entry={e} showStep={showStep} onStepClick={onStepClick} />)}
      </ol>
    </div>
  );
}

function TraceItem({ entry: e, showStep, onStepClick }: { entry: TraceRow; showStep?: boolean; onStepClick?: (id: string) => void }) {
  const meta = TRACE_KIND[e.kind] ?? TRACE_KIND.info;
  const Icon = meta.icon;
  const [open, setOpen] = useState(false);
  const [full, setFull] = useState(false);
  const long = e.text.length > 420;
  const hasData = e.data !== undefined && e.data !== null && !(typeof e.data === 'object' && Object.keys(e.data as object).length === 0);
  return (
    <li className="flex gap-2.5 px-3 py-2 text-xs animate-fade-in">
      <time className="num w-11 shrink-0 pt-0.5 text-[10px] text-faint" dateTime={e.ts} title={formatDateTime(e.ts)}>{formatTime(e.ts)}</time>
      <span className={cls('mt-px grid h-5 w-5 shrink-0 place-items-center rounded-md', TONE[meta.tone].icon)}>
        <Icon size={11} />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-x-1.5 text-[10px] font-semibold uppercase tracking-wider">
          <span className={TONE[meta.tone].text}>{meta.label}</span>
          {e.agent && <span className="text-muted">· {e.agent}</span>}
          {showStep && e.step_name && (
            onStepClick && e.step_id ? (
              <button type="button" onClick={() => onStepClick(e.step_id!)} className="normal-case tracking-normal text-brand-600 hover:underline dark:text-brand-400">
                · {e.step_name}
              </button>
            ) : <span className="normal-case tracking-normal text-muted">· {e.step_name}</span>
          )}
        </div>
        <p className={cls('mt-0.5 whitespace-pre-wrap break-words leading-relaxed text-zinc-700 dark:text-zinc-300', e.kind === 'error' && 'text-rose-700 dark:text-rose-300')}>
          {long && !full ? `${e.text.slice(0, 420)}…` : e.text}
        </p>
        <div className="flex gap-3">
          {long && (
            <button type="button" onClick={() => setFull((f) => !f)} className="mt-0.5 text-[11px] font-semibold text-brand-600 hover:underline dark:text-brand-400">
              {full ? 'Show less' : 'Show all'}
            </button>
          )}
          {hasData && (
            <button type="button" onClick={() => setOpen((o) => !o)} className="mt-0.5 inline-flex items-center gap-0.5 text-[11px] font-semibold text-muted hover:text-zinc-800 dark:hover:text-zinc-200">
              {open ? <ChevronDown size={11} /> : <ChevronRight size={11} />} Data
            </button>
          )}
        </div>
        {open && hasData && <JsonView value={e.data} collapsedLines={16} className="mt-1.5" />}
      </div>
    </li>
  );
}
