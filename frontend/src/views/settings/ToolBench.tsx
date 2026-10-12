// Tool bench of one connector: every tool with its read-only / write badge and input schema, and
// "Try tool" — one real call with JSON arguments (writes ask first). Calls are audited server-side
// without their arguments.
import { BookOpen, CheckCircle2, Eye, Lock, Play, RefreshCw, Search, ShieldAlert, Wrench, XCircle } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { Badge, Button, CopyButton, Drawer, EmptyState, Input, useConfirm, useToast } from '../../components/ui';
import { cls } from '../../lib/cls';
import { formatLatency, plural } from '../../lib/format';
import type { Connector, ToolCallResult, ToolInfo } from '../../types';
import { JsonTextarea, parseJsonObject, prettyJson } from './shared';

interface SchemaProp {
  name: string;
  type: string;
  required: boolean;
  description: string;
  enumValues: string[];
  defaultValue?: unknown;
}

/** Top-level properties of a JSON schema, for the readable table. */
function schemaProps(schema: Record<string, unknown>): SchemaProp[] {
  const props = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  return Object.entries(props).map(([name, p]) => {
    const t = p.type;
    let type = Array.isArray(t) ? t.join(' | ') : typeof t === 'string' ? t : p.anyOf ? 'any of…' : 'any';
    if (type === 'array' && p.items && typeof p.items === 'object') {
      const it = (p.items as Record<string, unknown>).type;
      if (typeof it === 'string') type = `${it}[]`;
    }
    return {
      name, type, required: required.has(name),
      description: typeof p.description === 'string' ? p.description : '',
      enumValues: Array.isArray(p.enum) ? p.enum.map(String) : [],
      defaultValue: p.default,
    };
  });
}

/** Starter arguments: required fields with an empty value of their type (defaults when declared). */
function skeletonArgs(schema: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of schemaProps(schema)) {
    if (!p.required) continue;
    if (p.defaultValue !== undefined) out[p.name] = p.defaultValue;
    else if (p.enumValues.length) out[p.name] = p.enumValues[0];
    else if (p.type.endsWith('[]') || p.type === 'array') out[p.name] = [];
    else if (p.type === 'object') out[p.name] = {};
    else if (p.type === 'integer' || p.type === 'number') out[p.name] = 0;
    else if (p.type === 'boolean') out[p.name] = false;
    else out[p.name] = '';
  }
  return out;
}

export function ToolBench({ connector, onClose, onTest, testing }: {
  connector: Connector | null;
  onClose: () => void;
  onTest: (c: Connector) => void;
  testing: boolean;
}) {
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState('');
  useEffect(() => {
    setQ('');
    setSelected(connector?.tools[0]?.name ?? '');
  }, [connector?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!connector) return null;
  const tools = connector.tools.filter((t) => !q || `${t.name} ${t.description}`.toLowerCase().includes(q.toLowerCase()));
  const tool = connector.tools.find((t) => t.name === selected) ?? null;

  return (
    <Drawer
      open
      onClose={onClose}
      title={`${connector.name} · tools`}
      subtitle={`${plural(connector.tools.length, 'tool')} · namespace ${connector.slug}__`}
      icon={Wrench}
      width="xl"
      actions={<Button size="xs" variant="outline" icon={RefreshCw} busy={testing} onClick={() => onTest(connector)}>Re-test</Button>}
    >
      {connector.tools.length === 0 ? (
        <EmptyState
          icon={Wrench}
          title="No tool listed"
          description={connector.status.error || 'Test the connector to list the tools its server exposes.'}
          action={<Button icon={RefreshCw} busy={testing} onClick={() => onTest(connector)}>Test now</Button>}
        />
      ) : (
        <div className="grid h-full min-h-0 md:grid-cols-[240px_1fr]">
          <div className="flex min-h-0 flex-col border-b hairline md:border-b-0 md:border-r">
            <div className="p-3">
              <Input icon={Search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter tools…" className="h-8 text-xs" />
            </div>
            <ul className="max-h-60 flex-1 overflow-y-auto px-2 pb-3 md:max-h-none">
              {tools.map((t) => (
                <li key={t.name}>
                  <button
                    type="button"
                    onClick={() => setSelected(t.name)}
                    className={cls('flex w-full items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-xs transition-colors',
                      t.name === selected ? 'bg-brand-500/10 font-semibold text-brand-700 dark:text-brand-300' : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-ink-700')}
                  >
                    {t.sensitive ? <ShieldAlert size={12} className="shrink-0 text-rose-500" /> : t.read_only ? <Eye size={12} className="shrink-0 text-emerald-500" /> : <Wrench size={12} className="shrink-0 text-zinc-400" />}
                    <span className="truncate font-mono">{t.name}</span>
                  </button>
                </li>
              ))}
              {!tools.length && <li className="px-2 py-3 text-xs text-faint">No match.</li>}
            </ul>
          </div>
          <div className="min-w-0 overflow-y-auto">
            {tool ? <ToolDetail key={tool.name} connector={connector} tool={tool} /> : (
              <EmptyState icon={BookOpen} title="Pick a tool" description="Its description, input schema and a live try-out appear here." compact />
            )}
          </div>
        </div>
      )}
    </Drawer>
  );
}

function ToolDetail({ connector, tool }: { connector: Connector; tool: ToolInfo }) {
  const props = useMemo(() => schemaProps(tool.input_schema ?? {}), [tool]);
  const [args, setArgs] = useState(() => prettyJson(skeletonArgs(tool.input_schema ?? {})));
  const [raw, setRaw] = useState(false);
  const [result, setResult] = useState<ToolCallResult | null>(null);
  const [running, setRunning] = useState(false);
  const parsed = parseJsonObject(args);
  const confirm = useConfirm();
  const toast = useToast();

  const tryIt = async () => {
    if (!parsed.value) return;
    if (tool.sensitive) {
      const ok = await confirm({
        title: `Call ${tool.name}?`,
        message: `This tool can change data in ${connector.name}${connector.sandbox ? ' (Sandbox)' : ''}. The call is real and audited.`,
        tone: connector.sandbox ? 'warning' : 'danger',
        confirmLabel: 'Call the tool',
        steps: connector.sandbox ? 1 : 2,
      });
      if (!ok) return;
    }
    setRunning(true);
    setResult(null);
    try {
      setResult(await api.connectors.call(connector.id, tool.name, parsed.value));
    } catch (err) {
      toast.error(err);
    } finally {
      setRunning(false);
    }
  };

  const output = result ? (result.data !== undefined && result.data !== null ? prettyJson(result.data) : result.content_text) : '';

  return (
    <div className="space-y-5 p-5">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-mono text-sm font-bold text-zinc-900 dark:text-white">{tool.name}</h3>
          {tool.sensitive && <Badge tone="rose" size="xs" icon={ShieldAlert} title="Writes or deletes: agents ask for approval before calling it">Write · sensitive</Badge>}
          {tool.read_only && <Badge tone="emerald" size="xs" icon={Eye}>Read-only</Badge>}
          {!tool.sensitive && !tool.read_only && <Badge tone="zinc" size="xs">Unclassified</Badge>}
        </div>
        <p className="mt-0.5 font-mono text-2xs text-faint">{connector.slug}__{tool.name}</p>
        {tool.description && <p className="mt-2 whitespace-pre-line text-xs leading-relaxed text-zinc-700 dark:text-zinc-300">{tool.description}</p>}
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <span className="label-xs">Input schema</span>
          <button type="button" className="text-2xs font-semibold text-brand-600 hover:underline dark:text-brand-400" onClick={() => setRaw((r) => !r)}>
            {raw ? 'Table view' : 'Raw JSON'}
          </button>
        </div>
        {raw ? (
          <pre className="max-h-72 overflow-auto rounded-lg bg-zinc-50 p-3 font-mono text-[11px] text-zinc-700 dark:bg-ink-900 dark:text-zinc-300">{prettyJson(tool.input_schema)}</pre>
        ) : props.length === 0 ? (
          <p className="text-xs text-faint">No parameter.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border hairline">
            <table className="w-full text-left text-xs">
              <thead className="bg-zinc-50 dark:bg-ink-900">
                <tr><th className="px-3 py-1.5 label-xs">Name</th><th className="px-3 py-1.5 label-xs">Type</th><th className="px-3 py-1.5 label-xs">Description</th></tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-ink-600">
                {props.map((p) => (
                  <tr key={p.name} className="align-top">
                    <td className="px-3 py-1.5 font-mono font-semibold text-zinc-800 dark:text-zinc-200">
                      {p.name}{p.required && <span className="ml-0.5 text-brand-500" title="required">*</span>}
                    </td>
                    <td className="whitespace-nowrap px-3 py-1.5 font-mono text-muted">{p.type}</td>
                    <td className="px-3 py-1.5 text-muted">
                      {p.description}
                      {p.enumValues.length > 0 && <span className="mt-0.5 block font-mono text-2xs text-faint">one of: {p.enumValues.join(', ')}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="rounded-xl border p-4 hairline">
        <div className="mb-2 flex items-center gap-2">
          <Play size={14} className="text-brand-500" />
          <span className="text-sm font-semibold">Try tool</span>
          {tool.sensitive && <span className="inline-flex items-center gap-1 text-2xs text-rose-600 dark:text-rose-400"><Lock size={11} /> asks before calling</span>}
        </div>
        <JsonTextarea value={args} onChange={setArgs} error={parsed.error} minRows={4} />
        <div className="mt-3 flex items-center gap-2">
          <Button size="sm" icon={Play} busy={running} disabled={!parsed.value || !connector.enabled} onClick={() => void tryIt()}>Call</Button>
          {!connector.enabled && <span className="text-xs text-muted">Enable the connector first.</span>}
        </div>
        {result && (
          <div className={cls('mt-4 rounded-lg border animate-slide-up', result.ok && !result.is_error ? 'border-emerald-500/40' : 'border-rose-500/40')}>
            <div className="flex items-center gap-2 border-b px-3 py-2 hairline">
              {result.ok && !result.is_error ? <CheckCircle2 size={14} className="text-emerald-500" /> : <XCircle size={14} className="text-rose-500" />}
              <span className="text-xs font-semibold">{result.ok && !result.is_error ? 'Result' : 'Tool error'}</span>
              <span className="num text-xs text-muted">{formatLatency(result.latency_ms)}</span>
              {output && <CopyButton text={output} size="xs" className="ml-auto" />}
            </div>
            {result.error && <p className="px-3 py-2 text-xs text-rose-700 dark:text-rose-300">{result.error}</p>}
            {output && <pre className="max-h-96 overflow-auto p-3 font-mono text-[11px] text-zinc-700 dark:text-zinc-300">{output}</pre>}
          </div>
        )}
      </div>
    </div>
  );
}
