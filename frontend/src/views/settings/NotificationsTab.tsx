// Settings › Notifications — in-app notifications always work; an external channel (e-mail, Teams…)
// is any operation that accepts {to, subject, body}, so the Factory never hard-codes a provider.
import { BellRing, Mail, Newspaper, Send } from 'lucide-react';
import { useApp } from '../../lib/store';
import { Badge, Field, Select, Toggle } from '../../components/ui';
import { Note, SaveBar, Section, useSettingsDraft } from './shared';

const CHANNEL_ARGS = ['to', 'subject', 'body'];

export default function NotificationsTab() {
  const { operations } = useApp();
  const { draft, set, dirty, reset, save, saving, ready } = useSettingsDraft(['notifications'] as const);
  const n = draft.notifications;
  if (!ready || !n) return <Note>Loading the settings…</Note>;

  const op = operations.find((o) => o.key === n.channel_operation_key);
  const declared = new Set((op?.inputs ?? []).map((f) => f.key));
  const missing = op && op.inputs.length ? CHANNEL_ARGS.filter((a) => !declared.has(a)) : [];

  return (
    <div className="space-y-5">
      <Section title="In-app" subtitle="The bell, the inbox badges and the live toasts." icon={BellRing}>
        <Toggle
          checked={n.in_app}
          onChange={(in_app) => set('notifications', { in_app })}
          label="In-app notifications"
          description="Tasks, approvals, mentions and project updates appear in each person's notification bell. Recommended: keep it on."
        />
      </Section>

      <Section title="External channel" subtitle="Optional: also send messages through an MCP operation (e-mail, Teams, Slack…)." icon={Send}>
        <Field label="Channel operation" help="Empty = in-app only. Notify steps set to 'external' or 'both' use it.">
          <Select
            value={n.channel_operation_key}
            onChange={(e) => set('notifications', { channel_operation_key: e.target.value })}
            options={[{ value: '', label: 'None — in-app only' }, ...operations.map((o) => ({ value: o.key, label: `${o.name} (${o.key})` }))]}
          />
        </Field>
        <Note icon={Mail} className="mt-3">
          The operation runs once per message with this input (recipients without an e-mail are skipped):
          <pre className="mt-1.5 rounded-md bg-white/70 p-2 font-mono text-[11px] dark:bg-ink-900/60">{`{
  "to": ["alice.martin@doing.ai", "paul.durand@doing.ai"],
  "subject": "UC-0007 needs your approval",
  "body": "Markdown text written by the notify step"
}`}</pre>
          Map these in the operation's arguments template, e.g. <code>{'{"recipients": "{{ input.to | join(\',\') }}", "text": "{{ input.body }}"}'}</code>.
          A failed delivery is recorded in the audit log; the in-app notification is still created.
        </Note>
        {op && (
          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs">
            <span className="text-muted">Declared inputs:</span>
            {op.inputs.length ? op.inputs.map((f) => <Badge key={f.key} tone={CHANNEL_ARGS.includes(f.key) ? 'emerald' : 'zinc'} size="xs">{f.key}</Badge>)
              : <span className="text-faint">none declared (the template decides)</span>}
            {op.sensitive && <Badge tone="amber" size="xs">sensitive — may ask for confirmation</Badge>}
          </div>
        )}
        {missing.length > 0 && (
          <Note tone="amber" className="mt-3">This operation does not declare {missing.map((m) => `"${m}"`).join(', ')} — check that its template uses the input it receives.</Note>
        )}
        {operations.length === 0 && <Note tone="amber" className="mt-3">No operation yet: create one in Studio › Operations on a notification connector.</Note>}
      </Section>

      <Section title="Digest" subtitle="One summary instead of a stream." icon={Newspaper}>
        <Toggle
          checked={n.digest_enabled}
          onChange={(digest_enabled) => set('notifications', { digest_enabled })}
          label="Daily digest"
          description="Group notifications into one summary per person instead of a message per event (sent within the business hours of the Engine tab)."
        />
      </Section>

      <SaveBar dirty={dirty} saving={saving} onSave={() => void save()} onReset={reset} />
    </div>
  );
}
