// Settings › General — the instance's name and the "hours saved" baselines the KPIs multiply by
// each automated step (an honest, editable assumption rather than a hidden constant).
import { Building2, Clock4, RotateCcw } from 'lucide-react';
import { Button, Field, Input } from '../../components/ui';
import { formatHours } from '../../lib/format';
import { DEFAULT_HOURS_SAVED, STEP_TYPES } from '../../types';
import type { StepType } from '../../types';
import { Note, NumberInput, SaveBar, Section, useSettingsDraft } from './shared';

/** Baselines that are not a plain step type. */
const EXTRA_LABELS: Record<string, { label: string; description: string }> = {
  human_form_ai_draft: { label: 'Form drafted by AI', description: 'A person accepted an AI draft instead of writing the form.' },
  estimation_ai: { label: 'AI estimate suggestion', description: 'The team started from the AI estimate.' },
  approval_brief: { label: 'Approval brief', description: 'An approver read the AI decision brief.' },
};

function describe(key: string): { label: string; description: string } {
  if (EXTRA_LABELS[key]) return EXTRA_LABELS[key];
  const meta = STEP_TYPES[key as StepType];
  return meta ? { label: meta.label, description: meta.description } : { label: key, description: '' };
}

export default function GeneralTab() {
  const { draft, set, dirty, reset, save, saving, ready } = useSettingsDraft(['general'] as const);
  const g = draft.general;
  if (!ready || !g) return <Note>Loading the settings…</Note>;

  const keys = [...Object.keys(DEFAULT_HOURS_SAVED), ...Object.keys(g.hours_saved).filter((k) => !(k in DEFAULT_HOURS_SAVED))];
  const value = (k: string) => g.hours_saved[k] ?? DEFAULT_HOURS_SAVED[k] ?? 0;
  const setHours = (k: string, h: number) => set('general', { hours_saved: { ...g.hours_saved, [k]: h } });
  const isDefault = keys.every((k) => value(k) === (DEFAULT_HOURS_SAVED[k] ?? value(k)));

  return (
    <div className="space-y-5">
      <Section title="Identity" subtitle="Shown in the header, reports and notifications." icon={Building2}>
        <div className="grid gap-4 md:grid-cols-2">
          <Field label="Application name">
            <Input value={g.app_name} onChange={(e) => set('general', { app_name: e.target.value })} placeholder="DOINg.AI Factory" />
          </Field>
          <Field label="Company">
            <Input value={g.company} onChange={(e) => set('general', { company: e.target.value })} placeholder="e.g. Corporate & Investment Banking" />
          </Field>
        </div>
      </Section>

      <Section
        title="Hours saved baselines"
        subtitle="Manual effort an automated step replaces — the KPIs' 'hours saved' is the sum of these per completed step."
        icon={Clock4}
        actions={<Button size="xs" variant="ghost" icon={RotateCcw} disabled={isDefault} onClick={() => set('general', { hours_saved: { ...DEFAULT_HOURS_SAVED } })}>Reset all</Button>}
        bodyClassName="p-0"
      >
        <table className="w-full text-left text-sm">
          <thead className="border-b hairline">
            <tr>
              <th className="px-5 py-2.5 label-xs">Step</th>
              <th className="w-48 px-5 py-2.5 label-xs">Hours saved</th>
              <th className="w-28 px-5 py-2.5 label-xs">Default</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-ink-600">
            {keys.map((k) => {
              const d = describe(k);
              const def = DEFAULT_HOURS_SAVED[k];
              return (
                <tr key={k} className="align-middle">
                  <td className="px-5 py-2.5">
                    <p className="font-medium text-zinc-900 dark:text-white">{d.label}</p>
                    {d.description && <p className="line-clamp-1 text-xs text-muted">{d.description}</p>}
                  </td>
                  <td className="px-5 py-2.5">
                    <NumberInput value={value(k)} min={0} max={200} step={0.5} onChange={(h) => setHours(k, h)} suffix="h" />
                  </td>
                  <td className="num px-5 py-2.5 text-xs text-faint">{def !== undefined ? formatHours(def) : '—'}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Section>

      <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onReset={reset} />
    </div>
  );
}
