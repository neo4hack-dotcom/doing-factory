// Operations (#/studio/operations): the named MCP bindings blueprint steps, watchers and the
// notification channel call by key. A searchable table grouped visually by connector, and the
// editor drawer (create, AI suggestion, try it for real, delete).
import { Bot, Plug, Plus, Search, Settings2, ShieldAlert, Sparkles, Zap } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Badge, Button, Card, EmptyState, Input, SectionHeader, Select, cls } from '../../components/ui';
import { timeAgo } from '../../lib/format';
import { usePageTitle } from '../../lib/pageTitle';
import { navigate, paths } from '../../lib/router';
import { useApp } from '../../lib/store';
import type { Operation, OperationMode } from '../../types';
import { OperationEditor } from './parts/OperationEditor';

const MODE_BADGE: Record<OperationMode, { label: string; tone: 'brand' | 'violet' | 'fuchsia'; icon: typeof Zap }> = {
  direct: { label: 'direct', tone: 'brand', icon: Zap },
  llm: { label: 'llm', tone: 'violet', icon: Sparkles },
  agent: { label: 'agent', tone: 'fuchsia', icon: Bot },
};

export default function Operations() {
  usePageTitle('Operations');
  const { operations, connectors, connectorById, reload } = useApp();
  const [q, setQ] = useState('');
  const [connectorFilter, setConnectorFilter] = useState('');
  const [editing, setEditing] = useState<Operation | null>(null);
  const [open, setOpen] = useState(false);

  const query = q.trim().toLowerCase();
  const rows = useMemo(() => operations
    .filter((o) => !connectorFilter || o.connector_id === connectorFilter)
    .filter((o) => !query || [o.key, o.name, o.tool, o.description].some((v) => v.toLowerCase().includes(query)))
    .sort((a, b) => a.key.localeCompare(b.key)), [operations, connectorFilter, query]);

  const openEditor = (op: Operation | null) => {
    setEditing(op);
    setOpen(true);
  };

  return (
    <>
      <SectionHeader
        eyebrow="Studio"
        icon={Plug}
        title="Operations"
        description="Named, reusable actions on your MCP servers — a direct tool call, LLM-built arguments, or a small agent. Steps and watchers call them by key."
        actions={<Button icon={Plus} onClick={() => openEditor(null)} disabled={!connectors.length}>New operation</Button>}
      />

      {connectors.length === 0 ? (
        <EmptyState
          icon={Plug}
          title="Connect an MCP server first"
          description="An operation binds to a tool of a connector. Connect your DOINg.AI or Jira in Settings › Connectors, then let “Create standard operations” add the usual ones."
          action={<Button icon={Settings2} onClick={() => navigate(paths.settings('connectors'))}>Open Settings › Connectors</Button>}
        />
      ) : operations.length === 0 ? (
        <EmptyState
          icon={Zap}
          title="No operation yet"
          description="Create one by hand, or describe what it should do and let the AI pick the tool and draft the arguments."
          action={<Button icon={Plus} onClick={() => openEditor(null)}>New operation</Button>}
        />
      ) : (
        <Card padding="none">
          <div className="flex flex-wrap items-center gap-2 border-b hairline px-4 py-3">
            <Input icon={Search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search key, name, tool…" className="w-72 max-w-full" />
            <Select value={connectorFilter} onChange={(e) => setConnectorFilter(e.target.value)} placeholder="All connectors" className="w-56"
              options={connectors.map((c) => ({ value: c.id, label: c.name }))} />
            <span className="num ml-auto text-xs text-muted">{rows.length} of {operations.length}</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] text-sm">
              <thead>
                <tr className="border-b hairline text-left">
                  {['Key', 'Name', 'Connector', 'Mode', 'Tool', '', 'Updated'].map((h, i) => <th key={i} className="label-xs px-4 py-2.5 font-bold">{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {rows.map((op) => {
                  const connector = connectorById(op.connector_id);
                  const mode = MODE_BADGE[op.mode] ?? MODE_BADGE.direct;
                  return (
                    <tr key={op.id} onClick={() => openEditor(op)} tabIndex={0}
                      onKeyDown={(e) => { if (e.key === 'Enter') openEditor(op); }}
                      className="cursor-pointer border-b hairline transition-colors last:border-0 hover:bg-zinc-50 focus:bg-zinc-50 focus:outline-none dark:hover:bg-ink-700/60 dark:focus:bg-ink-700/60">
                      <td className="px-4 py-2.5"><code className="font-mono text-xs font-semibold text-zinc-800 dark:text-zinc-100">{op.key}</code></td>
                      <td className="max-w-[16rem] px-4 py-2.5">
                        <div className="truncate font-medium text-zinc-800 dark:text-zinc-100">{op.name}</div>
                        {op.description && <div className="truncate text-[11px] text-muted">{op.description}</div>}
                      </td>
                      <td className="px-4 py-2.5">
                        {connector ? (
                          <span className="inline-flex items-center gap-1.5 text-xs">
                            <span className={cls('h-1.5 w-1.5 rounded-full', connector.status.ok === true ? 'bg-emerald-500' : connector.status.ok === false ? 'bg-rose-500' : 'bg-zinc-400')} />
                            {connector.name}
                          </span>
                        ) : <span className="text-xs text-rose-600 dark:text-rose-400">Missing connector</span>}
                      </td>
                      <td className="px-4 py-2.5"><Badge size="xs" tone={mode.tone} icon={mode.icon}>{mode.label}</Badge></td>
                      <td className="px-4 py-2.5"><code className="font-mono text-xs text-muted">{op.tool || '—'}</code></td>
                      <td className="px-4 py-2.5">{op.sensitive && <Badge size="xs" tone="amber" icon={ShieldAlert} title="Writes to an external system: asks for confirmation unless autonomy is Full">sensitive</Badge>}</td>
                      <td className="whitespace-nowrap px-4 py-2.5 text-xs text-faint">{timeAgo(op.updated_at)}</td>
                    </tr>
                  );
                })}
                {rows.length === 0 && (
                  <tr><td colSpan={7} className="px-4 py-8 text-center text-sm text-muted">No operation matches.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <OperationEditor
        open={open}
        operation={editing}
        onClose={() => setOpen(false)}
        onSaved={(op) => { setEditing(op); void reload(); }}
        onDeleted={() => { setOpen(false); setEditing(null); void reload(); }}
      />
    </>
  );
}
