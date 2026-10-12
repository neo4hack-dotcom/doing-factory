// Blueprint identity & behaviour: name, key, kind, key prefix, icon, colour, status, autonomy
// override and description — plus the small visual pieces shared by the list and the designer
// (icon tile, mini pipeline preview).
import { Check } from 'lucide-react';
import { useRef, useState } from 'react';
import { AiRewrite } from '../../../components/AiRewrite';
import { BLUEPRINT_ICONS, iconByName } from '../../../components/StepIcon';
import { Field, Input, Popover, Select, TONE, Textarea, Tooltip, cls, toneOf } from '../../../components/ui';
import type { AutonomyOverride, Blueprint, BlueprintStatus } from '../../../types';
import { MONO } from './editors';
import { ToneSwatches } from './StepInspector';

export const AUTONOMY_OPTIONS: Array<{ value: AutonomyOverride; label: string; hint: string }> = [
  { value: '', label: 'Use the global setting', hint: 'Follows Settings › Engine for every project of this blueprint.' },
  { value: 'supervised', label: 'Supervised', hint: 'Every AI output waits for a human review before the workflow moves on.' },
  { value: 'approve_writes', label: 'Approve writes', hint: 'The AI drafts freely; writes to external systems (Jira, catalogs…) ask for a confirmation.' },
  { value: 'full', label: 'Full autonomy', hint: 'Automated steps — including sensitive writes — run without asking. Use for trusted, low-risk flows.' },
];

export const STATUS_OPTIONS: Array<{ value: BlueprintStatus; label: string; hint: string }> = [
  { value: 'active', label: 'Active', hint: 'Offered for new projects; must validate without errors.' },
  { value: 'draft', label: 'Draft', hint: 'Work in progress: may be incomplete, not offered for new projects.' },
  { value: 'archived', label: 'Archived', hint: 'Retired: hidden from new projects, history intact.' },
];

export function BlueprintIcon({ bp, size = 'md' }: { bp: Pick<Blueprint, 'icon' | 'color'>; size?: 'sm' | 'md' | 'lg' }) {
  const Icon = iconByName(bp.icon);
  const box = size === 'lg' ? 'h-12 w-12 rounded-xl' : size === 'sm' ? 'h-7 w-7 rounded-md' : 'h-10 w-10 rounded-lg';
  return (
    <span className={cls('grid shrink-0 place-items-center', box, TONE[toneOf(bp.color)].icon)}>
      <Icon size={size === 'lg' ? 24 : size === 'sm' ? 15 : 20} />
    </span>
  );
}

/** One segment per stage, in the stage colour, widths by step count. */
export function MiniPipeline({ bp, className }: { bp: Pick<Blueprint, 'stages'>; className?: string }) {
  if (!bp.stages.length) return <div className={cls('h-1.5 rounded-full bg-zinc-200 dark:bg-ink-500', className)} />;
  return (
    <div className={cls('flex gap-0.5', className)}>
      {bp.stages.map((s, i) => (
        <Tooltip key={`${s.id}-${i}`} className="min-w-0 flex-1" content={<><b>{s.name || s.id}</b> · {s.steps.length} step{s.steps.length === 1 ? '' : 's'}{s.parallel ? ' · parallel' : ''}</>}>
          <span className="block w-full">
            <span className={cls('block h-1.5 rounded-full', TONE[toneOf(s.color)].dot, !s.steps.length && 'opacity-40')} />
          </span>
        </Tooltip>
      ))}
    </div>
  );
}

function IconPicker({ value, color, onChange }: { value: string; color: string; onChange: (icon: string) => void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={anchor} type="button" onClick={() => setOpen((o) => !o)}
        className="flex h-9 w-full items-center gap-2 rounded-lg border border-zinc-300 bg-white px-2 text-sm hover:border-zinc-400 dark:border-ink-400 dark:bg-ink-800">
        <BlueprintIcon bp={{ icon: value, color }} size="sm" />
        <span className="truncate font-mono text-xs">{value || 'Workflow'}</span>
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={280}>
        <div className="grid grid-cols-6 gap-1 p-2">
          {BLUEPRINT_ICONS.map((name) => {
            const Icon = iconByName(name);
            const on = name === value;
            return (
              <Tooltip key={name} content={name}>
                <button type="button" aria-label={name} onClick={() => { onChange(name); setOpen(false); }}
                  className={cls('relative grid h-10 w-10 place-items-center rounded-lg transition',
                    on ? TONE[toneOf(color)].icon : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-ink-600')}>
                  <Icon size={18} />
                  {on && <Check size={10} strokeWidth={3} className="absolute right-1 top-1" />}
                </button>
              </Tooltip>
            );
          })}
        </div>
      </Popover>
    </>
  );
}

export function BlueprintDetailsForm({ bp, onChange, onKeyEdited }: {
  bp: Blueprint;
  onChange: (patch: Partial<Blueprint>) => void;
  onKeyEdited: () => void;
}) {
  const autonomy = AUTONOMY_OPTIONS.find((a) => a.value === bp.autonomy) ?? AUTONOMY_OPTIONS[0];
  const status = STATUS_OPTIONS.find((s) => s.value === bp.status);
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Field label="Name" required>
        <Input value={bp.name} onChange={(e) => onChange({ name: e.target.value })} placeholder="e.g. MCP server delivery" />
      </Field>
      <Field label="Key" help="Unique slug; fan-out steps and the API refer to it" required>
        <Input value={bp.key} className={MONO} placeholder="derived from the name"
          onChange={(e) => { onKeyEdited(); onChange({ key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') }); }} />
      </Field>
      <Field label="Kind" help="Free label used for grouping (e.g. mcp_server, change, onboarding)">
        <Input value={bp.kind} onChange={(e) => onChange({ kind: e.target.value })} className={MONO} />
      </Field>
      <Field label="Project key prefix" help={`Projects are numbered ${bp.key_prefix || 'PRJ'}-0001, ${bp.key_prefix || 'PRJ'}-0002…`}>
        <Input value={bp.key_prefix} maxLength={8} className={MONO}
          onChange={(e) => onChange({ key_prefix: e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '') })} />
      </Field>
      <Field label="Icon">
        <IconPicker value={bp.icon} color={bp.color} onChange={(icon) => onChange({ icon })} />
      </Field>
      <Field label="Colour">
        <div className="flex h-9 items-center"><ToneSwatches value={bp.color} onChange={(color) => onChange({ color })} /></div>
      </Field>
      <Field label="Status" help={status?.hint}>
        <Select value={bp.status} onChange={(e) => onChange({ status: e.target.value as BlueprintStatus })} options={STATUS_OPTIONS.map(({ value, label }) => ({ value, label }))} />
      </Field>
      <Field label="Autonomy override" help={autonomy.hint}>
        <Select value={bp.autonomy} onChange={(e) => onChange({ autonomy: e.target.value as AutonomyOverride })} options={AUTONOMY_OPTIONS.map(({ value, label }) => ({ value, label }))} />
      </Field>
      <Field label="Description" className="md:col-span-2" aside={<AiRewrite value={bp.description} onChange={(description) => onChange({ description })} />}
        help="Shown when people pick a blueprint for a new project">
        <Textarea value={bp.description} onChange={(e) => onChange({ description: e.target.value })} minRows={3} />
      </Field>
    </div>
  );
}
