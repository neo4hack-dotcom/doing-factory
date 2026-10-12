// Settings › Watchers — scheduled polls of an MCP operation that turn new items (e.g. a sponsor's new
// use case in DOINg.AI) into intake items or auto-started projects. "Run now" shows exactly what the
// poll sees; the editor maps item fields to project fields with Jinja templates.
import {
  CalendarClock, CheckCircle2, Eraser, Eye, Pencil, Play, Plus, Radar, Rocket, Trash2, XCircle,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import {
  Badge, Button, Card, Drawer, EmptyState, Field, IconButton, Input, Modal, Select, Skeleton, Textarea, Toggle, Tooltip,
  useBusy, useConfirm, useToast,
} from '../../components/ui';
import { cls } from '../../lib/cls';
import { formatNumber, plural, timeAgo, truncate } from '../../lib/format';
import { navigate, paths } from '../../lib/router';
import { useApp, useLive } from '../../lib/store';
import type { Watcher, WatcherAction, WatcherRunResult, WatcherSchedule } from '../../types';
import { ChipSelect, ChoiceCards, JsonTextarea, Note, NumberInput, parseJsonObject, prettyJson } from './shared';

const WEEKDAYS = [
  { value: 1, label: 'Mon' }, { value: 2, label: 'Tue' }, { value: 3, label: 'Wed' }, { value: 4, label: 'Thu' },
  { value: 5, label: 'Fri' }, { value: 6, label: 'Sat' }, { value: 7, label: 'Sun' },
];

const HOURS = Array.from({ length: 25 }, (_, h) => ({ value: String(h), label: `${String(h).padStart(2, '0')}:00` }));

/** "Every 15 min · 09:00–18:00 · Mon–Fri" */
export function scheduleLabel(s: WatcherSchedule): string {
  const every = s.every_minutes % 60 === 0 && s.every_minutes >= 60 ? `Every ${plural(s.every_minutes / 60, 'hour')}` : `Every ${s.every_minutes} min`;
  const parts = [every];
  if (s.active_hours_start != null || s.active_hours_end != null) {
    parts.push(`${String(s.active_hours_start ?? 0).padStart(2, '0')}:00–${String(s.active_hours_end ?? 24).padStart(2, '0')}:00`);
  }
  if (s.days.length && s.days.length < 7) {
    const sorted = [...s.days].sort();
    const contiguous = sorted.every((d, i) => i === 0 || d === sorted[i - 1] + 1);
    parts.push(contiguous && sorted.length > 2
      ? `${WEEKDAYS[sorted[0] - 1].label}–${WEEKDAYS[sorted[sorted.length - 1] - 1].label}`
      : sorted.map((d) => WEEKDAYS[d - 1].label).join(', '));
  }
  return parts.join(' · ');
}

export default function WatchersTab() {
  const { operations, blueprintById } = useApp();
  const [watchers, setWatchers] = useState<Watcher[] | null>(null);
  const [editing, setEditing] = useState<Watcher | 'new' | null>(null);
  const [runResult, setRunResult] = useState<{ watcher: Watcher; result: WatcherRunResult } | null>(null);
  const [busy, run] = useBusy();
  const confirm = useConfirm();
  const toast = useToast();

  const load = () => api.watchers.list().then(setWatchers).catch((err: unknown) => {
    toast.error(err);
    setWatchers([]);
  });
  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useLive('watcher.updated', (e) => setWatchers((list) => list?.map((w) => (w.id === e.watcher.id ? e.watcher : w)) ?? list));

  const opName = (key: string) => operations.find((o) => o.key === key)?.name ?? key;

  const toggle = (w: Watcher) => run(`en:${w.id}`, async () => {
    const saved = await api.watchers.update(w.id, { enabled: !w.enabled });
    setWatchers((list) => list?.map((x) => (x.id === w.id ? saved : x)) ?? list);
  });

  const runNow = (w: Watcher) => run(`run:${w.id}`, async () => {
    const result = await api.watchers.run(w.id);
    setRunResult({ watcher: w, result });
    void load();
  });

  const resetSeen = async (w: Watcher) => {
    const ok = await confirm({
      title: `Reset ${w.name}?`,
      message: `It forgets the ${plural(w.state.seen_keys.length, 'item')} it has already seen: its next run detects every item again (as new intake items or projects).`,
      tone: 'warning',
      confirmLabel: 'Reset seen items',
    });
    if (!ok) return;
    await run(`reset:${w.id}`, async () => {
      const saved = await api.watchers.reset(w.id);
      setWatchers((list) => list?.map((x) => (x.id === w.id ? saved : x)) ?? list);
      toast.success(`${w.name} reset.`);
    });
  };

  const remove = async (w: Watcher) => {
    const ok = await confirm({ title: `Delete ${w.name}?`, message: 'Intake items it already detected are kept.', tone: 'danger', confirmLabel: 'Delete watcher' });
    if (!ok) return;
    await run(`del:${w.id}`, async () => {
      await api.watchers.remove(w.id);
      setWatchers((list) => list?.filter((x) => x.id !== w.id) ?? list);
      toast.success(`${w.name} deleted.`);
    });
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="mr-auto max-w-2xl text-sm text-muted">
          Watchers poll an operation on a schedule and turn every new item into an intake item to triage — or start a project straight away.
        </p>
        <Button icon={Plus} disabled={!operations.length} onClick={() => setEditing('new')}>Add watcher</Button>
      </div>
      {!operations.length && (
        <Note tone="amber" icon={Radar}>A watcher polls an operation: create one in Studio › Operations first (or install the Sandbox demo).</Note>
      )}

      {watchers === null ? (
        <Skeleton lines={4} />
      ) : watchers.length === 0 ? (
        <EmptyState
          icon={Eye}
          title="No watcher yet"
          description="Example: every 15 minutes, list the DOINg.AI use cases in status Planning and send the new ones to Intake."
          action={operations.length ? <Button icon={Plus} onClick={() => setEditing('new')}>Add watcher</Button> : undefined}
        />
      ) : (
        <div className="space-y-3">
          {watchers.map((w) => {
            const bp = blueprintById(w.blueprint_id);
            return (
              <Card key={w.id} padding="none" className={cls(!w.enabled && 'opacity-70')}>
                <div className="flex flex-wrap items-start gap-4 p-4">
                  <span className={cls('grid h-10 w-10 shrink-0 place-items-center rounded-xl', w.enabled ? 'bg-brand-500/10 text-brand-600 dark:text-brand-400' : 'bg-zinc-100 text-zinc-400 dark:bg-ink-600')}>
                    <Radar size={18} className={cls(w.enabled && 'animate-pulse-slow')} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h3 className="text-sm font-bold text-zinc-900 dark:text-white">{w.name}</h3>
                      <Badge tone={w.action === 'auto_start' ? 'violet' : 'sky'} size="xs" icon={w.action === 'auto_start' ? Rocket : Radar}>
                        {w.action === 'auto_start' ? 'Auto-start' : 'Intake'}
                      </Badge>
                      {bp && <Badge tone="zinc" size="xs" variant="outline">{bp.name}</Badge>}
                    </div>
                    {w.description && <p className="mt-0.5 text-xs text-muted">{w.description}</p>}
                    <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                      <span className="inline-flex items-center gap-1"><Play size={11} /> {opName(w.operation_key)}</span>
                      <span className="inline-flex items-center gap-1"><CalendarClock size={11} /> {scheduleLabel(w.schedule)}</span>
                    </div>
                  </div>
                  <dl className="grid shrink-0 grid-cols-3 gap-x-5 gap-y-0.5 text-xs">
                    <dt className="label-xs">Last run</dt><dt className="label-xs">Next run</dt><dt className="label-xs">Seen</dt>
                    <dd className="flex items-center gap-1">
                      {w.state.last_status === 'ok' && <CheckCircle2 size={12} className="text-emerald-500" />}
                      {w.state.last_status === 'error' && <XCircle size={12} className="text-rose-500" />}
                      <span title={w.state.last_run_at ?? ''}>{w.state.last_run_at ? timeAgo(w.state.last_run_at) : 'never'}</span>
                    </dd>
                    <dd title={w.state.next_run_at ?? ''}>{!w.enabled ? 'paused' : w.state.next_run_at ? timeAgo(w.state.next_run_at) : 'next tick'}</dd>
                    <dd className="num">
                      {formatNumber(w.state.seen_keys.length)}
                      {w.state.new_total > 0 && <span className="text-faint"> · {formatNumber(w.state.new_total)} new total</span>}
                    </dd>
                  </dl>
                  <Toggle size="sm" checked={w.enabled} disabled={busy === `en:${w.id}`} onChange={() => void toggle(w)} />
                </div>
                {w.state.last_status === 'error' && w.state.last_error && (
                  <p className="mx-4 mb-3 rounded-lg bg-rose-50 px-2.5 py-1.5 font-mono text-[11px] text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{w.state.last_error}</p>
                )}
                <div className="flex flex-wrap items-center gap-1 border-t px-3 py-2 hairline">
                  <Button size="xs" variant="ghost" icon={Play} busy={busy === `run:${w.id}`} onClick={() => void runNow(w)}>Run now</Button>
                  <Button size="xs" variant="ghost" icon={Pencil} onClick={() => setEditing(w)}>Edit</Button>
                  <Tooltip content="Forget the items already seen">
                    <Button size="xs" variant="ghost" icon={Eraser} busy={busy === `reset:${w.id}`} onClick={() => void resetSeen(w)}>Reset seen</Button>
                  </Tooltip>
                  <IconButton icon={Trash2} label={`Delete ${w.name}`} size="xs" className="ml-auto" busy={busy === `del:${w.id}`} onClick={() => void remove(w)} />
                </div>
              </Card>
            );
          })}
        </div>
      )}

      {editing && (
        <WatcherEditor
          key={editing === 'new' ? 'new' : editing.id}
          watcher={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved) => {
            setEditing(null);
            setWatchers((list) => (list ? (list.some((w) => w.id === saved.id) ? list.map((w) => (w.id === saved.id ? saved : w)) : [...list, saved]) : [saved]));
          }}
        />
      )}
      {runResult && <RunResultModal {...runResult} onClose={() => setRunResult(null)} />}
    </div>
  );
}

function RunResultModal({ watcher, result, onClose }: { watcher: Watcher; result: WatcherRunResult; onClose: () => void }) {
  const items = result.items_preview;
  const columns = useMemo(() => {
    const keys: string[] = [];
    for (const it of items.slice(0, 20)) for (const k of Object.keys(it)) if (!keys.includes(k)) keys.push(k);
    const preferred = [watcher.key_field, watcher.title_field].filter((k) => keys.includes(k));
    return [...preferred, ...keys.filter((k) => !preferred.includes(k))].slice(0, 6);
  }, [items, watcher]);
  const cell = (v: unknown) => (v === null || v === undefined ? '—' : typeof v === 'object' ? truncate(JSON.stringify(v), 60) : truncate(String(v), 60));
  return (
    <Modal
      open
      onClose={onClose}
      title={`${watcher.name} · run`}
      subtitle={result.ok ? `${plural(result.total, 'item')} seen, ${result.new} new` : 'The run failed'}
      icon={result.ok ? CheckCircle2 : XCircle}
      iconTone={result.ok ? 'emerald' : 'rose'}
      size="xl"
      footer={
        <>
          {result.new > 0 && <Button variant="outline" icon={Radar} onClick={() => { onClose(); navigate(watcher.action === 'auto_start' ? paths.projects() : paths.intake()); }}>
            {watcher.action === 'auto_start' ? 'Open projects' : 'Open Intake'}
          </Button>}
          <Button onClick={onClose}>Close</Button>
        </>
      }
    >
      <div className="mb-4 grid grid-cols-3 gap-3">
        {[['Total', result.total, 'zinc'], ['New', result.new, 'brand'], ['Errors', result.error ? 1 : 0, result.error ? 'rose' : 'zinc']].map(([label, n, tone]) => (
          <div key={label as string} className="rounded-xl border p-3 hairline">
            <p className="label-xs">{label}</p>
            <p className={cls('num mt-1 text-2xl font-bold', tone === 'brand' ? 'text-brand-600 dark:text-brand-400' : tone === 'rose' ? 'text-rose-600' : 'text-zinc-900 dark:text-white')}>{n as number}</p>
          </div>
        ))}
      </div>
      {result.error && <Note tone="rose" icon={XCircle} className="mb-4">{result.error}</Note>}
      {items.length > 0 ? (
        <div className="overflow-x-auto rounded-lg border hairline">
          <table className="w-full text-left text-xs">
            <thead className="bg-zinc-50 dark:bg-ink-900">
              <tr>{columns.map((c) => <th key={c} className="whitespace-nowrap px-3 py-2 label-xs">{c}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-ink-600">
              {items.map((it, i) => (
                <tr key={i}>{columns.map((c) => <td key={c} className="px-3 py-1.5 text-zinc-700 dark:text-zinc-300">{cell(it[c])}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : result.ok && <p className="text-xs text-muted">The operation returned no item matching the watcher's expression and filter.</p>}
    </Modal>
  );
}

// ---- Editor ------------------------------------------------------------------------------------

interface MappingRow {
  target: string;
  template: string;
}

const BASE_TARGETS = [
  { value: 'title', label: 'Title' },
  { value: 'description', label: 'Description' },
  { value: 'priority', label: 'Priority (low/medium/high/critical)' },
  { value: 'sponsor_email', label: 'Sponsor e-mail' },
  { value: 'tags', label: 'Tags (comma-separated)' },
];

function WatcherEditor({ watcher, onClose, onSaved }: { watcher: Watcher | null; onClose: () => void; onSaved: (w: Watcher) => void }) {
  const { operations, blueprints, blueprintById } = useApp();
  const toast = useToast();
  const [busy, run] = useBusy();
  const [name, setName] = useState(watcher?.name ?? '');
  const [description, setDescription] = useState(watcher?.description ?? '');
  const [enabled, setEnabled] = useState(watcher?.enabled ?? true);
  const [operationKey, setOperationKey] = useState(watcher?.operation_key ?? '');
  const [inputText, setInputText] = useState(prettyJson(watcher?.input ?? {}));
  const [schedule, setSchedule] = useState<WatcherSchedule>(watcher?.schedule ?? { every_minutes: 15, active_hours_start: null, active_hours_end: null, days: [] });
  const [itemsExpr, setItemsExpr] = useState(watcher?.items_expr ?? 'result');
  const [keyField, setKeyField] = useState(watcher?.key_field ?? 'id');
  const [titleField, setTitleField] = useState(watcher?.title_field ?? 'title');
  const [filter, setFilter] = useState(watcher?.filter ?? '');
  const [action, setAction] = useState<WatcherAction>(watcher?.action ?? 'intake');
  const [blueprintId, setBlueprintId] = useState(watcher?.blueprint_id ?? '');
  const [mapping, setMapping] = useState<MappingRow[]>(() => Object.entries(watcher?.mapping ?? {}).map(([target, template]) => ({ target, template })));
  const [baseline, setBaseline] = useState(watcher?.baseline_on_first_run ?? false);
  const input = parseJsonObject(inputText);

  const blueprint = blueprintById(blueprintId);
  const targets = useMemo(() => {
    const out = [...BASE_TARGETS, ...(blueprint?.inputs ?? []).map((f) => ({ value: `inputs.${f.key}`, label: `Input · ${f.label || f.key}` }))];
    for (const m of mapping) if (m.target && !out.some((t) => t.value === m.target)) out.push({ value: m.target, label: m.target });
    return out;
  }, [blueprint, mapping]);

  const pickOperation = (key: string) => {
    setOperationKey(key);
    const op = operations.find((o) => o.key === key);
    if (op && (!input.value || Object.keys(input.value).length === 0) && Object.keys(op.test_input ?? {}).length) {
      setInputText(prettyJson(op.test_input));
    }
  };

  const save = () => run('save', async () => {
    if (!input.value) throw new Error(`Input: ${input.error}`);
    const body: Partial<Watcher> = {
      name: name.trim(), description, enabled, operation_key: operationKey, input: input.value, schedule,
      items_expr: itemsExpr, key_field: keyField, title_field: titleField, filter, action, blueprint_id: blueprintId,
      mapping: Object.fromEntries(mapping.filter((m) => m.target && m.template.trim()).map((m) => [m.target, m.template])),
      baseline_on_first_run: baseline,
    };
    const saved = watcher ? await api.watchers.update(watcher.id, body) : await api.watchers.create(body);
    toast.success(`${saved.name} saved.`);
    onSaved(saved);
  });

  const setHours = (bound: 'active_hours_start' | 'active_hours_end', v: string) =>
    setSchedule((s) => ({ ...s, [bound]: v === '' ? null : Number(v) }));

  return (
    <Drawer
      open
      onClose={onClose}
      title={watcher ? `Edit ${watcher.name}` : 'Add watcher'}
      subtitle="Poll an operation, detect new items, send them to Intake or start a project."
      icon={Radar}
      width="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button busy={busy === 'save'} disabled={!name.trim() || !operationKey || !input.value} onClick={() => void save()}>Save watcher</Button>
        </>
      }
    >
      <div className="space-y-6 p-5">
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="New DOINg.AI use cases" />
          </Field>
          <div className="pt-6"><Toggle checked={enabled} onChange={setEnabled} label="Enabled" /></div>
        </div>
        <Field label="Description">
          <Textarea value={description} minRows={2} onChange={(e) => setDescription(e.target.value)} />
        </Field>

        <fieldset className="space-y-4">
          <legend className="label-xs mb-2">Source</legend>
          <Field label="Operation" required help="The MCP operation polled on each run (Studio › Operations).">
            <Select value={operationKey} placeholder="Pick an operation…" onChange={(e) => pickOperation(e.target.value)}
              options={operations.map((o) => ({ value: o.key, label: `${o.name} (${o.key})` }))} />
          </Field>
          <Field label="Input" help="JSON object passed to the operation, e.g. { &quot;status&quot;: &quot;Planning&quot; }.">
            <JsonTextarea value={inputText} onChange={setInputText} error={input.error} minRows={3} />
          </Field>
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="label-xs mb-2">Schedule</legend>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Every">
              <NumberInput value={schedule.every_minutes} min={1} max={10080} fallback={15} suffix="minutes"
                onChange={(n) => setSchedule((s) => ({ ...s, every_minutes: n }))} />
            </Field>
            <Field label="Active from" help="Empty = any time.">
              <Select value={schedule.active_hours_start == null ? '' : String(schedule.active_hours_start)} placeholder="Any time"
                options={HOURS.slice(0, 24)} onChange={(e) => setHours('active_hours_start', e.target.value)} />
            </Field>
            <Field label="Until">
              <Select value={schedule.active_hours_end == null ? '' : String(schedule.active_hours_end)} placeholder="Any time"
                options={HOURS.slice(1)} onChange={(e) => setHours('active_hours_end', e.target.value)} />
            </Field>
          </div>
          <Field label="Days" help="None selected = every day.">
            <ChipSelect options={WEEKDAYS} value={schedule.days} onChange={(days) => setSchedule((s) => ({ ...s, days: [...days].sort() }))} />
          </Field>
          <p className="text-xs text-muted"><CalendarClock size={12} className="mr-1 inline" />{scheduleLabel(schedule)}</p>
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="label-xs mb-2">Items</legend>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Items expression" help="Jinja over `result` → a list.">
              <Input value={itemsExpr} onChange={(e) => setItemsExpr(e.target.value)} className="font-mono text-xs" placeholder="result.projects" />
            </Field>
            <Field label="Key field" help="Identifies an item across runs.">
              <Input value={keyField} onChange={(e) => setKeyField(e.target.value)} className="font-mono text-xs" />
            </Field>
            <Field label="Title field">
              <Input value={titleField} onChange={(e) => setTitleField(e.target.value)} className="font-mono text-xs" />
            </Field>
          </div>
          <Field label="Filter" help="Optional Jinja condition with `item`, e.g. item.status == 'Planning'.">
            <Input value={filter} onChange={(e) => setFilter(e.target.value)} className="font-mono text-xs" />
          </Field>
        </fieldset>

        <fieldset className="space-y-4">
          <legend className="label-xs mb-2">Action</legend>
          <ChoiceCards<WatcherAction>
            columns={2}
            value={action}
            onChange={setAction}
            options={[
              { value: 'intake', label: 'Send to Intake', icon: Radar, badge: 'Recommended', description: 'A person triages each item (with an AI suggestion of blueprint, team and priority) before a project starts.' },
              { value: 'auto_start', label: 'Start a project', icon: Rocket, description: 'Each new item starts a project from the blueprint below immediately — no triage.' },
            ]}
          />
          <Field label="Blueprint" required={action === 'auto_start'} help={action === 'intake' ? 'Pre-selected when accepting an intake item (optional).' : 'Projects start from this blueprint.'}>
            <Select value={blueprintId} placeholder="None" onChange={(e) => setBlueprintId(e.target.value)}
              options={blueprints.filter((b) => b.status !== 'archived').map((b) => ({ value: b.id, label: b.name }))} />
          </Field>
          <Field label="Field mapping" help="Each target receives a Jinja template rendered with `item`, e.g. {{ item.name }}.">
            <div className="space-y-2">
              {mapping.map((m, i) => (
                <div key={i} className="flex items-center gap-2">
                  <Select className="w-2/5" value={m.target} placeholder="Target…" options={targets}
                    onChange={(e) => setMapping((rows) => rows.map((r, j) => (j === i ? { ...r, target: e.target.value } : r)))} />
                  <Input className="flex-1 font-mono text-xs" value={m.template} placeholder="{{ item.description }}"
                    onChange={(e) => setMapping((rows) => rows.map((r, j) => (j === i ? { ...r, template: e.target.value } : r)))} />
                  <IconButton icon={Trash2} label="Remove" size="sm" onClick={() => setMapping((rows) => rows.filter((_, j) => j !== i))} />
                </div>
              ))}
              <Button size="xs" variant="outline" icon={Plus} onClick={() => setMapping((rows) => [...rows, { target: '', template: '' }])}>Add mapping</Button>
            </div>
          </Field>
          <Toggle
            checked={baseline}
            onChange={setBaseline}
            label="Baseline on first run"
            description="The first run only records what already exists (nothing is created) — only items appearing afterwards are new. Use it when pointing at a source with a long history."
          />
        </fieldset>
      </div>
    </Drawer>
  );
}
