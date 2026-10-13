// Operation editor drawer: bind a named, reusable action to an MCP tool (direct call with a Jinja
// argument template, LLM-built arguments, or a small agent), describe its inputs and output, and
// try it for real against the connector — with the arguments sent, the output and the trace.
import {
  AlertCircle, Bot, CheckCircle2, ChevronDown, ChevronRight, Play, Plug, Save, ShieldAlert, Sparkles, Trash2, Wand2, Zap,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../../../api';
import {
  Badge, Button, Drawer, Field, Input, Select, Tabs, Textarea, Toggle, cls, useBusy, useConfirm, useToast,
} from '../../../components/ui';
import { formatLatency, formatTime } from '../../../lib/format';
import { useApp } from '../../../lib/store';
import type { Connector, Operation, OperationMode, OperationResult } from '../../../types';
import {
  ExprInput, FieldDefsEditor, JsonEditor, MONO, MultiPick, Section, TemplateField,
} from './editors';
import type { VarGroup } from './model';
import { fingerprint } from './model';
import { useUnsavedGuard } from './session';

export function blankOperation(connectorId = ''): Operation {
  return {
    id: '', key: '', name: '', description: '', connector_id: connectorId, mode: 'direct', tool: '', args_template: {},
    prompt: '', allowed_tools: [], output: { extract: '', json_schema: null }, sensitive: false, inputs: [], test_input: {},
    created_at: '', updated_at: '',
  };
}

/** Same rule as the backend: lowercase, dots/dashes kept, other runs → "_". */
export function normaliseOpKey(raw: string): string {
  return raw.trim().toLowerCase().replace(/ /g, '_').replace(/[^a-z0-9_.-]+/g, '_').replace(/_+/g, '_').replace(/^[._-]+|[._-]+$/g, '').slice(0, 80);
}

export const MODE_COPY: Record<OperationMode, { label: string; icon: typeof Zap; text: string }> = {
  direct: { label: 'Direct', icon: Zap, text: 'One tool call. Arguments come from a JSON template whose string values are Jinja ({{ input.x }}) — fast, deterministic, no LLM.' },
  llm: { label: 'LLM-built args', icon: Sparkles, text: 'The local LLM reads your instructions and the tool’s input schema and builds the arguments — for free-form inputs that need interpretation.' },
  agent: { label: 'Agent', icon: Bot, text: 'A bounded tool-calling agent pursues the goal with the connector’s tools (optionally restricted) — for multi-call lookups. Slower; writes ask for confirmation.' },
};

function schemaTemplate(schema: Record<string, unknown>): Record<string, unknown> {
  const props = (schema?.properties ?? {}) as Record<string, unknown>;
  return Object.fromEntries(Object.keys(props).map((k) => [k, `{{ input.${k} }}`]));
}

function Pretty({ value }: { value: unknown }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return <pre className={cls(MONO, 'max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-zinc-50 p-2.5 text-zinc-800 dark:bg-ink-950 dark:text-zinc-200')}>{text ?? '—'}</pre>;
}

function Collapsible({ title, children, defaultOpen = false }: { title: string; children: ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button type="button" onClick={() => setOpen((o) => !o)} className="flex items-center gap-1 text-[11px] font-semibold text-muted hover:text-zinc-800 dark:hover:text-zinc-100">
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}{title}
      </button>
      {open && <div className="mt-1.5">{children}</div>}
    </div>
  );
}

const TRACE_TONE: Record<string, string> = {
  error: 'text-rose-600 dark:text-rose-400', tool: 'text-brand-600 dark:text-brand-400', thought: 'text-violet-600 dark:text-violet-400',
  result: 'text-emerald-600 dark:text-emerald-400', ai: 'text-violet-600 dark:text-violet-400',
};

export function RunResult({ result }: { result: OperationResult }) {
  return (
    <div className={cls('space-y-3 rounded-xl border p-3 animate-fade-in', result.ok ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-rose-500/30 bg-rose-500/5')}>
      <div className="flex flex-wrap items-center gap-2">
        {result.ok ? <CheckCircle2 size={16} className="text-emerald-500" /> : <AlertCircle size={16} className="text-rose-500" />}
        <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-100">{result.ok ? 'Success' : 'Failed'}</span>
        {result.tool && <code className={cls(MONO, 'rounded bg-white/70 px-1.5 dark:bg-ink-800')}>{result.tool}</code>}
        <span className="num ml-auto text-xs text-muted">{formatLatency(result.latency_ms)}</span>
      </div>
      {result.error && <p className="text-xs font-medium text-rose-700 dark:text-rose-300">{result.error}</p>}
      {result.summary && <p className="text-xs text-zinc-700 dark:text-zinc-300">{result.summary}</p>}
      {result.output !== undefined && result.output !== null && (
        <div><div className="label-xs mb-1">Output</div><Pretty value={result.output} /></div>
      )}
      <Collapsible title="Arguments sent"><Pretty value={result.args} /></Collapsible>
      {result.raw !== undefined && result.raw !== null && <Collapsible title="Raw tool result"><Pretty value={result.raw} /></Collapsible>}
      {result.trace.length > 0 && (
        <Collapsible title={`Trace (${result.trace.length})`} defaultOpen={!result.ok}>
          <ol className="space-y-1">
            {result.trace.map((t, i) => (
              <li key={i} className="flex gap-2 text-[11px]">
                <span className="num shrink-0 text-faint">{formatTime(t.ts)}</span>
                <span className={cls('shrink-0 font-semibold uppercase', TRACE_TONE[t.kind] ?? 'text-muted')}>{t.kind}</span>
                <span className="min-w-0 whitespace-pre-wrap break-words text-zinc-700 dark:text-zinc-300">{t.agent && <b>{t.agent}: </b>}{t.text}</span>
              </li>
            ))}
          </ol>
        </Collapsible>
      )}
    </div>
  );
}

export function OperationEditor({ open, operation, onClose, onSaved, onDeleted }: {
  open: boolean;
  /** null = new operation. */
  operation: Operation | null;
  onClose: () => void;
  onSaved: (op: Operation) => void;
  onDeleted: () => void;
}) {
  const { connectors, connectorById } = useApp();
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, run] = useBusy();
  const fresh = () => operation ?? blankOperation(connectors.find((c) => c.enabled)?.id ?? '');
  const [draft, setDraft] = useState<Operation>(fresh);
  const [baseline, setBaseline] = useState(() => fingerprint(draft));
  const [intent, setIntent] = useState('');
  const [result, setResult] = useState<OperationResult | null>(null);
  const [keyTouched, setKeyTouched] = useState(!!operation);
  const [jsonOk, setJsonOk] = useState<Record<string, boolean>>({});

  // Reset when the drawer opens or switches to another operation — not when reference data
  // reloads after a save (that would wipe the editor with a stale copy).
  useEffect(() => {
    if (!open) return;
    const init = fresh();
    setDraft(init);
    setBaseline(fingerprint(init));
    setResult(null);
    setIntent('');
    setKeyTouched(!!operation);
    setJsonOk({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, operation?.id]);

  const dirty = open && fingerprint(draft) !== baseline;
  useUnsavedGuard(dirty, 'This operation has unsaved changes. Leave without saving?');

  const connector: Connector | undefined = connectorById(draft.connector_id);
  const tools = connector?.tools ?? [];
  const tool = tools.find((t) => t.name === draft.tool);
  const set = (patch: Partial<Operation>) => setDraft((d) => ({ ...d, ...patch }));
  const jsonInvalid = Object.values(jsonOk).some((ok) => !ok);

  const vars: VarGroup[] = [
    { title: 'Input', hint: 'Values given by the step, watcher or test', items: draft.inputs.filter((f) => f.key).map((f) => ({ path: `input.${f.key}`, label: f.label || f.key })) },
    { title: 'Project (when run by a step)', items: ['key', 'title', 'description', 'priority'].map((k) => ({ path: `project.${k}`, label: k })).concat([{ path: 'vars', label: 'Outputs of earlier steps' }]) },
  ];

  const close = async () => {
    if (dirty && !(await confirm({ title: 'Discard unsaved changes?', tone: 'warning', confirmLabel: 'Discard' }))) return;
    onClose();
  };

  const persist = async (): Promise<Operation> => {
    const saved = draft.id ? await api.operations.update(draft.id, draft) : await api.operations.create(draft);
    setDraft(saved);
    setBaseline(fingerprint(saved));
    setKeyTouched(true);
    onSaved(saved);
    return saved;
  };

  const save = () => run('save', async () => {
    const saved = await persist();
    toast.success(`Operation ${saved.key} saved`);
  });

  const tryIt = () => run('run', async () => {
    if (draft.sensitive && !(await confirm({
      title: `Run ${draft.key || 'this operation'} for real?`,
      message: 'It is marked sensitive: the connector will perform a real write with the test input.',
      tone: 'warning', confirmLabel: 'Run it', steps: 2,
    }))) return;
    setResult(null);
    const op = !draft.id || dirty ? await persist() : draft;
    const res = await api.operations.run(op.id, draft.test_input ?? {});
    setResult(res);
  });

  const suggest = () => run('suggest', async () => {
    const s = await api.operations.suggest(draft.connector_id, intent.trim());
    setDraft((d) => ({
      ...d,
      name: s.name || d.name,
      key: d.key && keyTouched ? d.key : (s.key || normaliseOpKey(`${connector?.slug ?? ''}.${s.name ?? ''}`)),
      description: s.description || d.description,
      mode: s.mode || d.mode,
      tool: s.tool || d.tool,
      args_template: s.args_template ?? d.args_template,
      prompt: s.prompt ?? d.prompt,
      allowed_tools: s.allowed_tools ?? d.allowed_tools,
      output: s.output ?? d.output,
      inputs: s.inputs?.length ? s.inputs : d.inputs,
      sensitive: s.sensitive ?? d.sensitive,
      test_input: s.test_input && Object.keys(s.test_input).length ? s.test_input : d.test_input,
    }));
    toast.success('Draft suggested — review it, then Save.');
  });

  const remove = () => run('delete', async () => {
    if (!draft.id) return;
    if (!(await confirm({
      title: `Delete the operation ${draft.key}?`,
      message: 'Blueprint steps, watchers and the notification channel that use it would fail — the Factory refuses while it is still referenced.',
      tone: 'danger', confirmLabel: 'Delete operation',
    }))) return;
    await api.operations.remove(draft.id);
    toast.success(`Operation ${draft.key} deleted`);
    onDeleted();
  });

  return (
    <Drawer
      open={open}
      onClose={() => void close()}
      width="xl"
      icon={Plug}
      title={draft.id ? (draft.name || draft.key) : 'New operation'}
      subtitle={draft.id ? <span className="font-mono">{draft.key}</span> : 'A reusable, named action on an MCP server'}
      footer={(
        <>
          {draft.id && <Button variant="ghost" icon={Trash2} className="mr-auto text-rose-600 dark:text-rose-400" busy={busy === 'delete'} onClick={() => void remove()}>Delete</Button>}
          {dirty && <span className="mr-2 text-xs font-semibold text-amber-600 dark:text-amber-400">Unsaved changes</span>}
          <Button variant="ghost" onClick={() => void close()}>Close</Button>
          <Button icon={Save} busy={busy === 'save'} disabled={jsonInvalid || (!!draft.id && !dirty)} onClick={() => void save()}>{draft.id ? 'Save' : 'Create'}</Button>
        </>
      )}
    >
      <div className="space-y-6 px-5 py-5">
        {/* AI suggestion */}
        <div className="rounded-xl border border-violet-500/25 bg-violet-500/5 p-3">
          <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold text-violet-700 dark:text-violet-300"><Wand2 size={13} /> Suggest with AI</div>
          <div className="flex flex-wrap gap-2">
            <Input value={intent} onChange={(e) => setIntent(e.target.value)} className="min-w-[14rem] flex-1"
              placeholder={connector ? `What should it do on ${connector.name}? e.g. list the open epics of a Jira project` : 'Pick a connector first'}
              onKeyDown={(e) => { if (e.key === 'Enter' && intent.trim() && draft.connector_id) { e.preventDefault(); void suggest(); } }} />
            <Button variant="ai" icon={Sparkles} busy={busy === 'suggest'} disabled={!intent.trim() || !draft.connector_id} onClick={() => void suggest()}>Suggest</Button>
          </div>
          <p className="mt-1.5 text-[11px] text-muted">The local model picks a real tool of the connector and drafts the binding. Nothing is saved until you press Save.</p>
        </div>

        <Section title="Identity">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Name" required>
              <Input value={draft.name} onChange={(e) => {
                const name = e.target.value;
                set(keyTouched ? { name } : { name, key: normaliseOpKey(`${connector?.slug ?? ''}.${name}`) });
              }} placeholder="Create Jira issue" />
            </Field>
            <Field label="Key" required help="Steps and watchers call it by this key">
              <Input value={draft.key} className={MONO} placeholder="jira.create_issue"
                onChange={(e) => { setKeyTouched(true); set({ key: e.target.value.toLowerCase().replace(/[^a-z0-9_.-]/g, '_') }); }} />
            </Field>
          </div>
          <Field label="Description" help="Also read by the AI when it designs blueprints">
            <Textarea value={draft.description} onChange={(e) => set({ description: e.target.value })} minRows={2} />
          </Field>
        </Section>

        <Section title="Target">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Connector" required>
              <Select value={draft.connector_id} placeholder={connectors.length ? 'Select a connector…' : 'No connector — add one in Settings'}
                onChange={(e) => set({ connector_id: e.target.value, tool: '', allowed_tools: [] })}
                options={connectors.map((c) => ({ value: c.id, label: `${c.name} · ${c.tools.length} tools` }))} />
            </Field>
            {draft.mode !== 'agent' && (
              <Field label="Tool" required aside={tool?.sensitive ? <Badge size="xs" tone="amber" icon={ShieldAlert}>writes</Badge> : tool?.read_only ? <Badge size="xs" tone="emerald">read-only</Badge> : undefined}>
                {tools.length ? (
                  <Select value={draft.tool} placeholder="Select a tool…"
                    onChange={(e) => {
                      const next = tools.find((t) => t.name === e.target.value);
                      const patch: Partial<Operation> = { tool: e.target.value };
                      if (next && !draft.id) patch.sensitive = next.sensitive;
                      if (next && draft.mode === 'direct' && !Object.keys(draft.args_template).length) patch.args_template = schemaTemplate(next.input_schema);
                      set(patch);
                    }}
                    options={tools.map((t) => ({ value: t.name, label: `${t.name}${t.sensitive ? ' · writes' : ''}` }))}>
                    {draft.tool && !tool && <option value={draft.tool}>{draft.tool} (not listed)</option>}
                  </Select>
                ) : (
                  <Input value={draft.tool} onChange={(e) => set({ tool: e.target.value })} className={MONO} placeholder="tool_name" />
                )}
              </Field>
            )}
          </div>
          {connector && !tools.length && (
            <p className="text-[11px] text-amber-700 dark:text-amber-400">This connector lists no tools yet — test it in Settings › Connectors to pick from its catalogue.</p>
          )}
          {tool && (
            <div className="rounded-lg border hairline p-2.5">
              {tool.description && <p className="mb-1.5 text-xs text-muted">{tool.description}</p>}
              <Collapsible title="Input schema"><Pretty value={tool.input_schema} /></Collapsible>
            </div>
          )}
        </Section>

        <Section title="Mode">
          <Tabs<OperationMode> size="sm" value={draft.mode} onChange={(mode) => set({ mode })}
            tabs={(Object.keys(MODE_COPY) as OperationMode[]).map((m) => ({ key: m, label: MODE_COPY[m].label, icon: MODE_COPY[m].icon }))} />
          <p className="text-xs text-muted">{MODE_COPY[draft.mode].text}</p>
          {draft.mode === 'direct' && (
            <Field label="Arguments template" help="JSON sent to the tool; string values are Jinja over {input, project, vars}. A value that is exactly {{ expr }} passes lists/objects natively."
              aside={tool ? <Button size="xs" variant="ghost" onClick={() => set({ args_template: { ...schemaTemplate(tool.input_schema), ...draft.args_template } })}>Fill from schema</Button> : undefined}>
              <JsonEditor value={draft.args_template} onChange={(v) => set({ args_template: (v ?? {}) as Record<string, unknown> })}
                onValidity={(ok) => setJsonOk((s) => ({ ...s, args: ok }))} minRows={5} />
            </Field>
          )}
          {draft.mode === 'llm' && (
            <TemplateField label="Instructions" required value={draft.prompt} onChange={(prompt) => set({ prompt })} vars={vars} minRows={5}
              help="How the LLM must build the tool arguments from the input." placeholder="Build a Jira issue for {{ input.summary }}: concise title, description with acceptance criteria…" />
          )}
          {draft.mode === 'agent' && (
            <>
              <TemplateField label="Goal" required value={draft.prompt} onChange={(prompt) => set({ prompt })} vars={vars} minRows={5} rewrite
                help="What the agent must find out or do with the tools." />
              <Field label="Allowed tools" help="Empty = all tools of the connector">
                <MultiPick value={draft.allowed_tools} onChange={(allowed_tools) => set({ allowed_tools })} placeholder="All tools" mono
                  options={tools.map((t) => ({ value: t.name, label: t.name, hint: t.description, badge: t.sensitive ? <Badge size="xs" tone="amber">writes</Badge> : undefined }))}
                  emptyHint="This connector lists no tools — test it in Settings › Connectors." />
              </Field>
            </>
          )}
        </Section>

        <Section title="Output">
          <ExprInput label="Extract" value={draft.output.extract} onChange={(extract) => set({ output: { ...draft.output, extract } })}
            vars={[{ title: 'Tool result', items: [{ path: 'result', label: 'Parsed tool output' }] }]}
            placeholder="result.issues" help="Jinja expression over `result`; empty = the whole result. This is what steps store in vars." />
          {draft.mode !== 'direct' && (
            <Field label="JSON schema" help="Optional structured output for llm/agent modes">
              <JsonEditor value={draft.output.json_schema} nullable onChange={(json_schema) => set({ output: { ...draft.output, json_schema: json_schema as Record<string, unknown> | null } })}
                onValidity={(ok) => setJsonOk((s) => ({ ...s, schema: ok }))} />
            </Field>
          )}
        </Section>

        <Section title="Inputs" hint="What callers pass in (read as input.<key>); steps and watchers see them as suggested keys">
          <FieldDefsEditor fields={draft.inputs} onChange={(inputs) => set({ inputs })} addLabel="Add input" keyPrefix="input." emptyLabel="No declared input." />
        </Section>

        <Section title="Safety">
          <Toggle checked={draft.sensitive} onChange={(sensitive) => set({ sensitive })} label="Sensitive (writes to an external system)"
            description="Steps calling it ask a person to confirm the exact arguments unless the autonomy is Full. Defaults to the tool's own flag." />
        </Section>

        <Section title="Try it" hint="Runs the operation for real against the connector, with full autonomy (you pressed the button)">
          <Field label="Test input">
            <JsonEditor value={draft.test_input} onChange={(v) => set({ test_input: (v ?? {}) as Record<string, unknown> })}
              onValidity={(ok) => setJsonOk((s) => ({ ...s, test: ok }))} minRows={3} />
          </Field>
          <div className="flex items-center gap-2">
            <Button variant="outline" icon={Play} busy={busy === 'run'} disabled={jsonInvalid || !draft.connector_id} onClick={() => void tryIt()}>
              {!draft.id || dirty ? 'Save & run' : 'Run'}
            </Button>
            {draft.sensitive && <span className="inline-flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400"><ShieldAlert size={12} />This performs a real write.</span>}
          </div>
          {result && <RunResult result={result} />}
        </Section>
      </div>
    </Drawer>
  );
}
