// Settings › Engine — how much the AI may do on its own (autonomy), the agent budgets, and the
// scheduler that drives watchers, SLA checks and waits.
import { Bot, Clock, Cog, Hand, ShieldCheck, Zap } from 'lucide-react';
import { useMemo } from 'react';
import { Field, Input, Select, Toggle } from '../../components/ui';
import type { Autonomy } from '../../types';
import { ChoiceCards, Note, NumberInput, SaveBar, Section, useSettingsDraft } from './shared';

const AUTONOMY: Array<{ value: Autonomy; label: string; description: string; icon: typeof Hand; badge?: string }> = [
  {
    value: 'supervised', label: 'Supervised', icon: Hand,
    description: 'Every AI output and every MCP call waits for a person: drafts are reviewed, tool calls confirmed. Slowest, maximum control.',
  },
  {
    value: 'approve_writes', label: 'Approve writes', icon: ShieldCheck, badge: 'Recommended',
    description: 'Reads and drafting run on their own; anything that writes outside the Factory (Jira issues, portfolio updates, messages) asks a person first.',
  },
  {
    value: 'full', label: 'Full', icon: Zap,
    description: 'Automated steps — writes included — run without asking. Approvals and quality gates defined in blueprints still apply.',
  },
];

const HOURS = Array.from({ length: 25 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }));

/** IANA zones known to the browser (fallback: a short list). */
function timeZones(): string[] {
  try {
    const fn = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf;
    if (fn) return fn('timeZone');
  } catch {
    /* older browsers */
  }
  return ['UTC', 'Europe/Paris', 'Europe/London', 'America/New_York', 'Asia/Singapore'];
}

export default function EngineTab() {
  const { draft, set, dirty, reset, save, saving, ready } = useSettingsDraft(['engine', 'scheduler'] as const);
  const zones = useMemo(timeZones, []);
  const e = draft.engine;
  const s = draft.scheduler;
  if (!ready || !e || !s) return <Note>Loading the settings…</Note>;

  return (
    <div className="space-y-5">
      <Section title="Autonomy" subtitle="The default for every blueprint (a blueprint may override it)." icon={ShieldCheck}>
        <ChoiceCards options={AUTONOMY} value={e.autonomy} onChange={(autonomy) => set('engine', { autonomy })} />
      </Section>

      <Section title="Execution" subtitle="Budgets and safety nets of the workflow engine and the agents." icon={Bot}>
        <div className="grid gap-5 md:grid-cols-3">
          <Field label="Max retries" help="Automatic retries of a failed automated step before it waits for a person.">
            <NumberInput value={e.max_retries} min={0} max={10} onChange={(max_retries) => set('engine', { max_retries })} />
          </Field>
          <Field label="Agent max actions" help="Tool calls an agent step may make (a step can lower it).">
            <NumberInput value={e.max_agent_actions} min={1} max={100} fallback={8} onChange={(max_agent_actions) => set('engine', { max_agent_actions })} />
          </Field>
          <Field label="Agent timeout" help="Wall-clock budget of one agent step.">
            <NumberInput value={e.agent_timeout_s} min={30} max={7200} step={30} fallback={600} suffix="seconds" onChange={(agent_timeout_s) => set('engine', { agent_timeout_s })} />
          </Field>
          <Field label="Parallel steps" help="Automated steps running at once. Keep it low with a local model.">
            <NumberInput value={e.parallel_steps} min={1} max={16} fallback={3} onChange={(parallel_steps) => set('engine', { parallel_steps })} />
          </Field>
          <Field label="Context size" help="Characters of project context given to each AI step.">
            <NumberInput value={e.context_chars} min={1000} max={200000} step={500} fallback={6000} suffix="chars" onChange={(context_chars) => set('engine', { context_chars })} />
          </Field>
          <div className="pt-6">
            <Toggle
              checked={e.critic_enabled}
              onChange={(critic_enabled) => set('engine', { critic_enabled })}
              label="Critic"
              description="A second, fast pass reviews AI drafts and agent results and asks for a fix when they miss the brief."
            />
          </div>
        </div>
      </Section>

      <Section title="Scheduler" subtitle="Drives watchers, wait-for polls, SLA checks and digests." icon={Clock}>
        <Toggle
          checked={s.enabled}
          onChange={(enabled) => set('scheduler', { enabled })}
          label="Scheduler running"
          description="Off = watchers and polls only run when someone clicks Run now. Useful while configuring."
        />
        <div className="mt-5 grid gap-5 md:grid-cols-3">
          <Field label="Tick" help="How often the scheduler wakes up.">
            <NumberInput value={s.tick_s} min={5} max={3600} fallback={20} suffix="seconds" onChange={(tick_s) => set('scheduler', { tick_s })} />
          </Field>
          <Field label="SLA check" help="How often overdue steps are flagged and escalated.">
            <NumberInput value={s.sla_check_minutes} min={1} max={1440} fallback={15} suffix="minutes" onChange={(sla_check_minutes) => set('scheduler', { sla_check_minutes })} />
          </Field>
          <Field label="Timezone">
            <Input list="factory-timezones" value={s.timezone} onChange={(ev) => set('scheduler', { timezone: ev.target.value })} />
            <datalist id="factory-timezones">{zones.map((z) => <option key={z} value={z} />)}</datalist>
          </Field>
          <Field label="Business hours start" help="SLA clocks and digests follow business hours.">
            <Select value={String(s.business_hours_start)} options={HOURS.slice(0, 24)} onChange={(ev) => set('scheduler', { business_hours_start: Number(ev.target.value) })} />
          </Field>
          <Field label="Business hours end">
            <Select value={String(s.business_hours_end)} options={HOURS.slice(1)} onChange={(ev) => set('scheduler', { business_hours_end: Number(ev.target.value) })} />
          </Field>
        </div>
        {s.business_hours_end <= s.business_hours_start && (
          <Note tone="amber" icon={Cog} className="mt-3">Business hours end before they start — check the two values.</Note>
        )}
      </Section>

      <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onReset={reset} />
    </div>
  );
}
