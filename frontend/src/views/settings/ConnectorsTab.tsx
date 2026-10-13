// Settings › Connectors — the MCP servers the Factory talks to (DOINg.AI portfolio, Jira, channels…).
// Cards show live health; the drawer edits the launch settings (secrets stay masked server-side);
// the tool bench lists every tool with its schema and lets an admin try one call for real.
import {
  Bug, CircleDot, Globe, ListPlus, Pencil, Plug, Plus, Radio, RefreshCw, SlidersHorizontal, TerminalSquare, Trash2, Wrench,
} from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../../api';
import {
  Badge, Button, Card, Drawer, EmptyState, Field, IconButton, Input, Modal, Select, Tabs, Textarea, Toggle, Tooltip,
  useBusy, useConfirm, useToast,
} from '../../components/ui';
import { cls } from '../../lib/cls';
import { formatLatency, plural, timeAgo } from '../../lib/format';
import { navigate, paths, useRoute } from '../../lib/router';
import { useApp } from '../../lib/store';
import type { Connector, ConnectorKind, ConnectorTemplate, StandardSetupResult, Transport } from '../../types';
import {
  hasStandardSetup, ImportPeopleButton, StandardSetupReport, standardSetupSummary, TemplateConnectForm, templateIcon,
  TemplatesLoading, useConnectorTemplates,
} from './connectorSetup';
import { fromRows, KeyValueEditor, ListEditor, Note, NumberInput, toRows } from './shared';
import type { KvRow } from './shared';
import { ToolBench } from './ToolBench';

export const KIND_META: Record<ConnectorKind, { label: string; tone: 'brand' | 'sky' | 'pink' | 'indigo' | 'teal' | 'zinc' }> = {
  portfolio: { label: 'Portfolio', tone: 'brand' },
  jira: { label: 'Jira', tone: 'sky' },
  notification: { label: 'Notification', tone: 'pink' },
  git: { label: 'Git', tone: 'indigo' },
  docs: { label: 'Docs', tone: 'teal' },
  other: { label: 'Other', tone: 'zinc' },
};

const TRANSPORT_LABEL: Record<Transport, string> = { stdio: 'stdio', http: 'Streamable HTTP', sse: 'SSE' };

/** Health dot: emerald answered, rose failed, zinc never tested. */
export function StatusDot({ connector }: { connector: Connector }) {
  const ok = connector.status.ok;
  const tone = !connector.enabled ? 'bg-zinc-300 dark:bg-ink-400' : ok === true ? 'bg-emerald-500' : ok === false ? 'bg-rose-500' : 'bg-zinc-400';
  const label = !connector.enabled ? 'Disabled' : ok === true ? 'Connected' : ok === false ? 'Failing' : 'Never tested';
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted" title={label}>
      <span className={cls('relative h-2 w-2 rounded-full', tone)}>
        {ok === true && connector.enabled && <span className="absolute inset-0 animate-ping rounded-full bg-emerald-500/50" />}
      </span>
      {label}
    </span>
  );
}

export default function ConnectorsTab() {
  const { connectors, operations, reload } = useApp();
  const [editing, setEditing] = useState<Connector | 'new' | null>(null);
  const [bench, setBench] = useState<Connector | null>(null);
  const [adding, setAdding] = useState<'pick' | ConnectorTemplate | null>(null);
  const [setupReport, setSetupReport] = useState<{ connector: Connector; result: StandardSetupResult } | null>(null);
  const [busy, run] = useBusy();
  const confirm = useConfirm();
  const toast = useToast();
  const { templates, error: templatesError, reload: reloadTemplates } = useConnectorTemplates();

  // Deep link from Home / the guide: #/settings/connectors?add=doing_ai|jira|http|custom
  const { query } = useRoute();
  const addParam = query.add ?? '';
  useEffect(() => {
    if (!addParam) return;
    if (addParam === 'custom') setEditing('new');
    else if (templates) setAdding(templates.find((t) => t.id === addParam) ?? 'pick');
    else if (templatesError) setAdding('pick'); // the picker shows the error and a Retry
    else return; // wait for the templates
    navigate(paths.settings('connectors'), { replace: true });
  }, [addParam, templates, templatesError]);

  const test = (c: Connector) => run(`test:${c.id}`, async () => {
    const saved = await api.connectors.test(c.id);
    await reload();
    if (saved.status.ok) toast.success(`${saved.name}: ${plural(saved.status.tool_count, 'tool')} in ${formatLatency(saved.status.latency_ms)}.`);
    else toast.error(`${saved.name}: ${saved.status.error || 'the server did not answer.'}`);
    if (bench?.id === c.id) setBench(saved);
  });

  const remove = async (c: Connector) => {
    const used = operations.filter((o) => o.connector_id === c.id).length;
    const ok = await confirm({
      title: `Delete ${c.name}?`,
      message: used
        ? `${plural(used, 'operation')} use this connector — the server will refuse until they are deleted or re-pointed in Studio › Operations.`
        : 'Agents and operations will no longer reach this MCP server.',
      tone: 'danger',
      confirmLabel: 'Delete connector',
    });
    if (!ok) return;
    await run(`del:${c.id}`, async () => {
      await api.connectors.remove(c.id);
      await reload();
      toast.success(`${c.name} deleted.`);
    });
  };

  const toggleEnabled = (c: Connector) => run(`en:${c.id}`, async () => {
    await api.connectors.update(c.id, { enabled: !c.enabled });
    await reload();
  });

  const standardSetup = (c: Connector) => run(`std:${c.id}`, async () => {
    const result = await api.connectors.standardSetup(c.id);
    await reload();
    setSetupReport({ connector: c, result });
    toast.success(`${c.name}: ${standardSetupSummary(result)}`);
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <p className="mr-auto max-w-2xl text-sm text-muted">
          MCP servers the Factory uses for operations, agents and watchers. Launch settings are tested live; secrets are masked once saved.
        </p>
        <Button icon={Plus} onClick={() => setAdding('pick')}>Add connector</Button>
      </div>

      {connectors.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="No connector yet"
          description="Start with your DOINg.AI (its URL) and your Jira (mcp-atlassian with an API token) — templates fill in the launch settings for you."
          action={<Button icon={Plus} onClick={() => setAdding('pick')}>Add connector</Button>}
        />
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {connectors.map((c) => {
            const kind = KIND_META[c.kind] ?? KIND_META.other;
            const opCount = operations.filter((o) => o.connector_id === c.id).length;
            return (
              <Card key={c.id} padding="none" className={cls('flex flex-col', !c.enabled && 'opacity-70')}>
                <div className="flex items-start gap-3 p-4">
                  <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-brand-500/10 text-brand-600 dark:text-brand-400">
                    {c.transport === 'stdio' ? <TerminalSquare size={18} /> : <Globe size={18} />}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <h3 className="truncate text-sm font-bold text-zinc-900 dark:text-white">{c.name}</h3>
                      <Badge tone={kind.tone} size="xs">{kind.label}</Badge>
                      <Badge tone="zinc" size="xs" variant="outline">{TRANSPORT_LABEL[c.transport]}</Badge>
                    </div>
                    {c.description && <p className="mt-1 line-clamp-2 text-xs text-muted">{c.description}</p>}
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1">
                      <StatusDot connector={c} />
                      <span className="inline-flex items-center gap-1 text-xs text-muted"><Wrench size={12} /> {plural(c.status.tool_count || c.tools.length, 'tool')}</span>
                      {opCount > 0 && <span className="text-xs text-muted">{plural(opCount, 'operation')}</span>}
                      {c.status.checked_at && (
                        <span className="text-xs text-faint" title={c.status.checked_at}>checked {timeAgo(c.status.checked_at)}</span>
                      )}
                      {c.status.ok && c.status.latency_ms > 0 && <span className="num text-xs text-faint">{formatLatency(c.status.latency_ms)}</span>}
                    </div>
                    {c.status.ok === false && c.status.error && (
                      <p className="mt-2 line-clamp-3 rounded-lg bg-rose-50 px-2.5 py-1.5 font-mono text-[11px] text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
                        {c.status.error}
                      </p>
                    )}
                  </div>
                  <Toggle size="sm" checked={c.enabled} disabled={busy === `en:${c.id}`} onChange={() => void toggleEnabled(c)} />
                </div>
                <div className="mt-auto flex flex-wrap items-center gap-1 border-t px-3 py-2 hairline">
                  <Button size="xs" variant="ghost" icon={RefreshCw} busy={busy === `test:${c.id}`} onClick={() => void test(c)}>Test</Button>
                  <Button size="xs" variant="ghost" icon={Wrench} onClick={() => setBench(c)}>Tools</Button>
                  <Button size="xs" variant="ghost" icon={Pencil} onClick={() => setEditing(c)}>Edit</Button>
                  {hasStandardSetup(c) && (
                    <Tooltip content="Creates the standard operations (and the intake watcher) for this system — safe to run twice">
                      <Button size="xs" variant="ghost" icon={ListPlus} busy={busy === `std:${c.id}`} disabled={!c.enabled} onClick={() => void standardSetup(c)}>
                        Create standard operations
                      </Button>
                    </Tooltip>
                  )}
                  {c.kind === 'portfolio' && <ImportPeopleButton connector={c} size="xs" variant="ghost" />}
                  <IconButton icon={Trash2} label={`Delete ${c.name}`} size="xs" className="ml-auto" busy={busy === `del:${c.id}`} onClick={() => void remove(c)} />
                </div>
              </Card>
            );
          })}
        </div>
      )}

      <AddConnector
        state={adding}
        templates={templates}
        templatesError={templatesError}
        onRetryTemplates={() => void reloadTemplates()}
        onPick={setAdding}
        onCustom={() => { setAdding(null); setEditing('new'); }}
        onClose={() => setAdding(null)}
        onOpenTools={(c) => { setAdding(null); setBench(c); }}
        onSetup={(c) => { setAdding(null); void standardSetup(c); }}
      />
      <Modal
        open={!!setupReport}
        onClose={() => setSetupReport(null)}
        title={setupReport ? `Standard operations · ${setupReport.connector.name}` : ''}
        subtitle="Review or adapt them in Studio › Operations; the watcher is in Settings › Watchers."
        icon={ListPlus}
        footer={(
          <>
            <Button variant="ghost" onClick={() => navigate(paths.settings('watchers'))}>Watchers</Button>
            <Button variant="outline" onClick={() => navigate(paths.operations())}>Open Operations</Button>
            <Button onClick={() => setSetupReport(null)}>Done</Button>
          </>
        )}
      >
        {setupReport && <StandardSetupReport result={setupReport.result} />}
      </Modal>
      <ConnectorEditor
        connector={editing}
        onClose={() => setEditing(null)}
        onSaved={(saved, tested) => {
          setEditing(null);
          if (tested) setBench(saved);
        }}
      />
      <ToolBench connector={bench} onClose={() => setBench(null)} onTest={(c) => void test(c)} testing={!!bench && busy === `test:${bench.id}`} />
    </div>
  );
}

// ---- Add: template picker, then the form generated from the template -----------------------------

function AddConnector({ state, templates, templatesError, onRetryTemplates, onPick, onCustom, onClose, onOpenTools, onSetup }: {
  state: 'pick' | ConnectorTemplate | null;
  templates: ConnectorTemplate[] | null;
  templatesError: string;
  onRetryTemplates: () => void;
  onPick: (t: ConnectorTemplate | 'pick') => void;
  onCustom: () => void;
  onClose: () => void;
  onOpenTools: (c: Connector) => void;
  onSetup: (c: Connector) => void;
}) {
  const [connected, setConnected] = useState<Connector | null>(null);
  useEffect(() => setConnected(null), [state]);
  if (state === null) return null;

  if (state === 'pick') {
    return (
      <Modal open onClose={onClose} title="Add a connector" subtitle="Pick a template — or describe the MCP server yourself." icon={Plug} size="lg">
        {!templates && <TemplatesLoading error={templatesError} onRetry={onRetryTemplates} />}
        <div className={cls('grid gap-3 sm:grid-cols-2', !templates && 'mt-3')}>
          {(templates ?? []).map((t) => {
            const Icon = templateIcon(t);
            const kind = KIND_META[t.kind] ?? KIND_META.other;
            return (
              <Card key={t.id} padding="md" onClick={() => onPick(t)} className="cursor-pointer transition-colors hover:border-brand-500/50">
                <div className="flex items-center gap-2">
                  <Icon size={18} className="text-brand-500" />
                  <span className="text-sm font-bold text-zinc-900 dark:text-white">{t.name}</span>
                  <Badge tone={kind.tone} size="xs" className="ml-auto">{kind.label}</Badge>
                </div>
                <p className="mt-1.5 text-xs text-muted">{t.description}</p>
              </Card>
            );
          })}
          <Card padding="md" onClick={onCustom} className="cursor-pointer transition-colors hover:border-brand-500/50">
            <div className="flex items-center gap-2">
              <SlidersHorizontal size={18} className="text-zinc-500" />
              <span className="text-sm font-bold text-zinc-900 dark:text-white">Custom</span>
            </div>
            <p className="mt-1.5 text-xs text-muted">Any MCP server: command, arguments and environment (stdio), or a URL and headers (HTTP / SSE).</p>
          </Card>
        </div>
      </Modal>
    );
  }

  const t = state;
  return (
    <Drawer
      open
      onClose={onClose}
      title={`Connect ${t.name}`}
      subtitle={t.description}
      icon={templateIcon(t)}
      width="lg"
      footer={
        connected ? (
          <>
            <Button variant="ghost" onClick={() => onOpenTools(connected)}>Browse tools</Button>
            {hasStandardSetup(connected) && <Button variant="outline" icon={ListPlus} onClick={() => onSetup(connected)}>Create standard operations</Button>}
            <Button onClick={onClose}>Done</Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={() => onPick('pick')}>Other templates</Button>
            <Button variant="ghost" onClick={onClose}>Cancel</Button>
          </>
        )
      }
    >
      <div className="space-y-4 p-5">
        <TemplateConnectForm template={t} onConnected={setConnected} />
        {connected?.kind === 'portfolio' && (
          <Note tone="sky" icon={CircleDot}>
            Next: create the standard operations (new use cases → Intake), then import the people your DOINg.AI knows from the connector card.
          </Note>
        )}
      </div>
    </Drawer>
  );
}

// ---- Editor drawer ------------------------------------------------------------------------------

interface ConnectorForm {
  name: string;
  kind: ConnectorKind;
  description: string;
  transport: Transport;
  command: string;
  args: string[];
  env: KvRow[];
  cwd: string;
  url: string;
  headers: KvRow[];
  timeout_s: number;
  enabled: boolean;
}

const EMPTY_FORM: ConnectorForm = {
  name: '', kind: 'other', description: '', transport: 'stdio', command: '', args: [], env: [], cwd: '', url: '',
  headers: [], timeout_s: 60, enabled: true,
};

function toForm(c: Connector): ConnectorForm {
  return {
    name: c.name, kind: c.kind, description: c.description, transport: c.transport, command: c.command, args: [...c.args],
    env: toRows(c.env), cwd: c.cwd, url: c.url, headers: toRows(c.headers), timeout_s: c.timeout_s, enabled: c.enabled,
  };
}

function ConnectorEditor({ connector, onClose, onSaved }: {
  connector: Connector | 'new' | null;
  onClose: () => void;
  onSaved: (saved: Connector, tested: boolean) => void;
}) {
  const open = connector !== null;
  const isNew = connector === 'new';
  return open ? (
    <ConnectorEditorBody key={isNew ? 'new' : connector.id} connector={isNew ? null : connector} onClose={onClose} onSaved={onSaved} />
  ) : null;
}

function ConnectorEditorBody({ connector, onClose, onSaved }: {
  connector: Connector | null;
  onClose: () => void;
  onSaved: (saved: Connector, tested: boolean) => void;
}) {
  const { reload } = useApp();
  const toast = useToast();
  const [form, setForm] = useState<ConnectorForm>(() => (connector ? toForm(connector) : EMPTY_FORM));
  const [busy, run] = useBusy();
  const set = (patch: Partial<ConnectorForm>) => setForm((f) => ({ ...f, ...patch }));

  const save = (thenTest: boolean) => run(thenTest ? 'test' : 'save', async () => {
    const body: Partial<Connector> = {
      name: form.name.trim(), kind: form.kind, description: form.description, transport: form.transport,
      command: form.command, args: form.args.filter((a) => a !== ''), env: fromRows(form.env), cwd: form.cwd,
      url: form.url, headers: fromRows(form.headers), timeout_s: form.timeout_s, enabled: form.enabled,
    };
    let saved = connector ? await api.connectors.update(connector.id, body) : await api.connectors.create(body);
    if (thenTest) {
      saved = await api.connectors.test(saved.id);
      if (saved.status.ok) toast.success(`${saved.name} saved and connected — ${plural(saved.status.tool_count, 'tool')}.`);
      else toast.warn(`${saved.name} saved, but the test failed: ${saved.status.error || 'no answer'}`);
    } else toast.success(`${saved.name} saved.`);
    await reload();
    onSaved(saved, thenTest && !!saved.status.ok);
  });

  const stdio = form.transport === 'stdio';
  return (
    <Drawer
      open
      onClose={onClose}
      title={connector ? `Edit ${connector.name}` : 'Add connector'}
      subtitle="An MCP server reached over stdio, streamable HTTP or SSE."
      icon={Plug}
      width="xl"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button variant="outline" icon={RefreshCw} busy={busy === 'test'} disabled={!!busy || !form.name.trim()} onClick={() => void save(true)}>Save & test</Button>
          <Button busy={busy === 'save'} disabled={!!busy || !form.name.trim()} onClick={() => void save(false)}>Save</Button>
        </>
      }
    >
      <div className="space-y-5 p-5">
        <div className="grid gap-4 sm:grid-cols-[2fr_1fr]">
          <Field label="Name" required help="Also the tool namespace (slug) — renaming later keeps the original slug.">
            <Input value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Jira (production)" />
          </Field>
          <Field label="Kind">
            <Select value={form.kind} onChange={(e) => set({ kind: e.target.value as ConnectorKind })}
              options={Object.entries(KIND_META).map(([value, m]) => ({ value, label: m.label }))} />
          </Field>
        </div>
        <Field label="Description" help="Helps people — and the agents — know what this server is for.">
          <Textarea value={form.description} minRows={2} onChange={(e) => set({ description: e.target.value })} />
        </Field>

        <div>
          <p className="mb-2 text-xs font-semibold text-zinc-700 dark:text-zinc-300">Transport</p>
          <Tabs<Transport>
            value={form.transport}
            onChange={(t) => set({ transport: t })}
            tabs={[
              { key: 'stdio', label: 'stdio (local process)', icon: TerminalSquare },
              { key: 'http', label: 'Streamable HTTP', icon: Globe },
              { key: 'sse', label: 'SSE', icon: Radio },
            ]}
          />
        </div>

        {stdio ? (
          <div className="space-y-4">
            <Field label="Command" required help="The executable that starts the server: python, node, npx, uvx, docker…">
              <Input value={form.command} onChange={(e) => set({ command: e.target.value })} className="font-mono text-xs" placeholder="uvx" />
            </Field>
            <Field label="Arguments" help="One per row, passed as-is (no shell).">
              <ListEditor items={form.args} onChange={(args) => set({ args })} placeholder="mcp-atlassian" addLabel="Add argument" />
            </Field>
            <Field label="Environment" help="Values under secret-looking names (TOKEN, KEY, PASSWORD…) are masked once saved.">
              <KeyValueEditor rows={form.env} onChange={(env) => set({ env })} keyPlaceholder="JIRA_URL" />
            </Field>
            <Field label="Working directory" help="Optional. Empty = the Factory's backend directory.">
              <Input value={form.cwd} onChange={(e) => set({ cwd: e.target.value })} className="font-mono text-xs" />
            </Field>
          </div>
        ) : (
          <div className="space-y-4">
            <Field label="URL" required help={form.transport === 'sse' ? 'The SSE endpoint, usually ending in /sse.' : 'The MCP endpoint, usually ending in /mcp.'}>
              <Input value={form.url} onChange={(e) => set({ url: e.target.value })} className="font-mono text-xs"
                placeholder={form.transport === 'sse' ? 'https://mcp.example.com/sse' : 'https://mcp.example.com/mcp'} />
            </Field>
            <Field label="Headers" help="e.g. Authorization: Bearer … — masked once saved.">
              <KeyValueEditor rows={form.headers} onChange={(headers) => set({ headers })} keyPlaceholder="Authorization" addLabel="Add header" />
            </Field>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Timeout" help="Per tool call.">
            <NumberInput value={form.timeout_s} min={1} max={3600} fallback={60} onChange={(n) => set({ timeout_s: n })} suffix="seconds" />
          </Field>
          <div className="pt-6">
            <Toggle checked={form.enabled} onChange={(enabled) => set({ enabled })} label="Enabled" description="Disabled connectors are skipped by agents and operations fail with a clear message." />
          </div>
        </div>

        {connector && connector.status.ok === false && connector.status.error && (
          <Note tone="rose" icon={Bug}><b>Last test:</b> {connector.status.error}</Note>
        )}
        {connector?.status.server_name && (
          <p className="flex items-center gap-1.5 text-xs text-muted">
            <CircleDot size={12} className="text-emerald-500" />
            Server reports itself as <b>{connector.status.server_name}</b>{connector.status.server_version && ` ${connector.status.server_version}`}
          </p>
        )}
      </div>
    </Drawer>
  );
}
