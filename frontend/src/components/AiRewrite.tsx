// ✨ AI reword menu for any long text field: pick a style (or describe the change), the local LLM
// rewrites, the text is replaced — with Undo, because a rewrite must never destroy what a person wrote.
// Without an LLM the backend answers with an actionable message, shown as a toast.
import {
  AlignLeft, Briefcase, CheckCheck, Code2, Expand, List, ListChecks, Scissors, Smile, Sparkles, Undo2, Wand2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useRef, useState } from 'react';
import { api } from '../api';
import { cls } from '../lib/cls';
import type { RewriteStyle } from '../types';
import { Button, IconButton, MenuItem, Popover, useToast } from './ui';

export const REWRITE_STYLES: Array<{ key: RewriteStyle; label: string; hint: string; icon: LucideIcon }> = [
  { key: 'professional', label: 'Professional', hint: 'Polished business tone', icon: Briefcase },
  { key: 'concise', label: 'Concise', hint: 'Shorter, same meaning', icon: Scissors },
  { key: 'executive', label: 'Executive summary', hint: 'Decision first', icon: AlignLeft },
  { key: 'technical', label: 'Technical', hint: 'Precise, for engineers', icon: Code2 },
  { key: 'friendly', label: 'Friendly', hint: 'Warm and clear', icon: Smile },
  { key: 'fix', label: 'Fix spelling & grammar', hint: 'Minimal edits', icon: CheckCheck },
  { key: 'expand', label: 'Expand', hint: 'More detail and structure', icon: Expand },
  { key: 'bullets', label: 'Bullet points', hint: 'Scannable list', icon: List },
  { key: 'jira', label: 'Jira-ready', hint: 'Story + acceptance criteria', icon: ListChecks },
];

export function AiRewrite({ value, onChange, disabled, size = 'xs', className }: {
  value: string;
  onChange: (text: string) => void;
  disabled?: boolean;
  size?: 'xs' | 'sm';
  className?: string;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<RewriteStyle | null>(null);
  const [instructions, setInstructions] = useState('');
  const [undo, setUndo] = useState<{ previous: string; result: string } | null>(null);
  const toast = useToast();
  const empty = !value.trim();

  const run = async (style: RewriteStyle, extra?: string) => {
    setOpen(false);
    setBusy(style);
    const previous = value;
    try {
      const { text } = await api.ai.rewrite(previous, style, extra?.trim() || undefined);
      if (!text?.trim()) throw new Error('The model returned an empty text — the original was kept.');
      onChange(text);
      setUndo({ previous, result: text });
      setInstructions('');
      toast.success(`Rewritten · ${REWRITE_STYLES.find((s) => s.key === style)?.label ?? style}`, {
        action: { label: 'Undo', onClick: () => onChange(previous) },
      });
    } catch (err) {
      toast.error(err);
    } finally {
      setBusy(null);
    }
  };

  // The inline Undo only makes sense while the field still holds the AI result.
  const canUndo = !!undo && undo.result === value;

  return (
    <span className={cls('inline-flex items-center gap-1', className)}>
      {canUndo && (
        <IconButton icon={Undo2} label="Undo AI rewrite" size="xs" onClick={() => {
          onChange(undo.previous);
          setUndo(null);
        }} />
      )}
      <Button
        ref={anchor}
        variant="ai"
        size={size}
        icon={Sparkles}
        busy={busy !== null}
        disabled={disabled || empty}
        title={empty ? 'Write something first' : 'Rewrite with AI'}
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        AI
      </Button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} align="right" width={280}>
        <div className="label-xs px-2.5 pb-1 pt-1.5">Rewrite as</div>
        {REWRITE_STYLES.map((s) => (
          <MenuItem key={s.key} icon={s.icon} label={s.label} hint={s.hint} onClick={() => void run(s.key)} />
        ))}
        <div className="mt-1 border-t hairline p-1.5">
          <form
            className="flex items-center gap-1.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (instructions.trim()) void run('professional', instructions);
            }}
          >
            <Wand2 size={14} className="shrink-0 text-brand-500" />
            <input
              value={instructions}
              onChange={(e) => setInstructions(e.target.value)}
              placeholder="Or describe the change… (Enter)"
              className="h-7 min-w-0 flex-1 rounded-md bg-transparent px-1 text-xs outline-none placeholder:text-zinc-400"
            />
          </form>
        </div>
      </Popover>
    </span>
  );
}
