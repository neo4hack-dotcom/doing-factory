// Write confirmations (pending_action confirm_operation / agent_tool_call): the Factory shows the
// exact tool call it is about to make — tool, connector, arguments — and a person approves it,
// corrects the arguments, or refuses. Nothing is written to an external system before that.
import { Bot, Brain, CheckCheck, Pencil, Play, Plug, ShieldAlert, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Markdown } from '../../components/Markdown';
import { Badge, Button, useConfirm } from '../../components/ui';
import { api } from '../../api';
import { useApp } from '../../lib/store';
import type { PendingAction } from '../../types';
import type { ActionProps } from './types';
import { ArgsEditor } from './ArgsEditor';
import { ActionBar, NotAllowed, Section } from './common';
import { argsToRows, rowsToArgs } from './logic';
import type { ArgRow } from './logic';
import { TraceView } from './TraceView';

const str = (v: unknown) => (typeof v === 'string' ? v : '');

/** Resolves the connector a pending call targets, from the payload or the operation it runs. */
function useTarget(pending: PendingAction) {
  const { connectors, operations, connectorById } = useApp();
  const p = pending.payload ?? {};
  const opKey = str(p.operation_key);
  const operation = opKey ? operations.find((o) => o.key === opKey) : undefined;
  const qualified = str(p.tool) || str(p.qualified);
  // Agent tools are namespaced "<connector slug>__<tool>".
  const [slug, bare] = qualified.includes('__') ? qualified.split('__', 2) : ['', qualified];
  const connector = connectorById(str(p.connector_id))
    ?? connectorById(operation?.connector_id)
    ?? (slug ? connectors.find((c) => c.slug === slug) : undefined);
  const toolName = bare || operation?.tool || 'a tool';
  const tool = connector?.tools.find((t) => t.name === toolName);
  return {
    operation,
    connector,
    connectorName: str(p.connector_name) || connector?.name || (slug ? slug : 'an MCP connector'),
    toolName,
    toolDescription: tool?.description ?? '',
  };
}

function useArgRows(pending: PendingAction) {
  const source = (pending.payload?.args ?? {}) as Record<string, unknown>;
  const sourceKey = JSON.stringify(source);
  const [rows, setRows] = useState<ArgRow[]>(() => argsToRows(source));
  // A new pending call (the agent moved on) replaces the editor content.
  useEffect(() => setRows(argsToRows(JSON.parse(sourceKey) as Record<string, unknown>)), [sourceKey]);
  const { args, errors } = useMemo(() => rowsToArgs(rows), [rows]);
  const edited = JSON.stringify(args) !== sourceKey;
  return { rows, setRows, args, errors, invalid: Object.keys(errors).length > 0, edited };
}

function CallHeader({ icon: Icon, verb, toolName, connectorName, sandbox, description }: {
  icon: typeof Plug;
  verb: string;
  toolName: string;
  connectorName: string;
  sandbox?: boolean;
  description?: string;
}) {
  return (
    <div className="rounded-xl border border-brand-500/30 bg-brand-50/50 p-3.5 dark:bg-brand-500/[0.06]">
      <div className="flex items-start gap-3">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-brand-500 text-white shadow-brand">
          <Icon size={17} />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm text-zinc-700 dark:text-zinc-200">
            {verb} <code className="rounded bg-white px-1.5 py-0.5 font-mono text-[12.5px] font-semibold text-brand-700 ring-1 ring-brand-500/20 dark:bg-ink-900 dark:text-brand-300">{toolName}</code>
            {' '}on <b>{connectorName}</b>
          </p>
          {description && <p className="mt-1 text-xs text-muted">{description}</p>}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Badge tone="amber" size="xs" icon={ShieldAlert}>Write — needs your confirmation</Badge>
            {sandbox && <Badge tone="violet" size="xs">Sandbox</Badge>}
          </div>
        </div>
      </div>
    </div>
  );
}

/** mcp_operation under approve_writes: confirm, edit the arguments, or refuse the call. */
export function ConfirmOperationAction({ project, step, userId, canAct, blockedReason, busy, run }: ActionProps) {
  const pending = step.pending_action!;
  const confirm = useConfirm();
  const target = useTarget(pending);
  const editor = useArgRows(pending);

  const runIt = () => run(
    'confirm',
    () => api.steps.confirm(project.id, step.id, userId, true, { ...pending.payload, args: editor.args }),
    `${target.toolName} executed on ${target.connectorName}`,
  );

  const refuse = async () => {
    const ok = await confirm({
      title: 'Refuse this call?',
      message: <>The Factory will not call <b>{target.toolName}</b>. The step stops here and the owner decides what happens next.</>,
      tone: 'danger',
      confirmLabel: 'Refuse the call',
    });
    if (ok) await run('reject', () => api.steps.confirm(project.id, step.id, userId, false), 'Call refused — nothing was sent');
  };

  return (
    <div className="space-y-4">
      <CallHeader
        icon={Plug}
        verb="The Factory is about to call"
        toolName={target.toolName}
        connectorName={target.connectorName}
        sandbox={target.connector?.sandbox}
        description={pending.description || target.operation?.description || target.toolDescription}
      />
      <Section
        title="Arguments"
        icon={Pencil}
        actions={editor.edited ? <Badge tone="sky" size="xs">Edited</Badge> : <span className="text-[11px] text-faint">Edit anything before running</span>}
      >
        <ArgsEditor rows={editor.rows} onChange={editor.setRows} errors={editor.errors} disabled={!canAct || !!busy} />
      </Section>
      <ActionBar note={!canAct ? <NotAllowed>{blockedReason}</NotAllowed> : editor.invalid ? <span className="text-rose-600 dark:text-rose-400">Fix the arguments first</span> : undefined}>
        <Button variant="outline" size="sm" icon={X} busy={busy === 'reject'} disabled={!canAct || !!busy} onClick={() => void refuse()}>
          Reject
        </Button>
        <Button size="sm" icon={Play} busy={busy === 'confirm'} disabled={!canAct || !!busy || editor.invalid} onClick={() => void runIt()}>
          Confirm & run
        </Button>
      </ActionBar>
    </div>
  );
}

/** agent_task under approve_writes: the agent wants to call a write tool — approve, edit or refuse. */
export function AgentToolCallAction({ project, step, userId, canAct, blockedReason, busy, run, trace }: ActionProps) {
  const pending = step.pending_action!;
  const confirm = useConfirm();
  const target = useTarget(pending);
  const editor = useArgRows(pending);
  const thought = str(pending.payload?.thought) || str(pending.payload?.reason);

  const approve = async (all: boolean) => {
    if (all) {
      const ok = await confirm({
        title: 'Approve every remaining write?',
        message: <>The agent calls <b>{target.toolName}</b> now and will run its later write tools for this step <b>without asking again</b>. Every call stays in the trace and the audit log.</>,
        tone: 'warning',
        confirmLabel: 'Approve all writes',
      });
      if (!ok) return;
    }
    await run(
      all ? 'approve_all' : 'approve',
      () => api.steps.confirm(project.id, step.id, userId, true, { ...pending.payload, args: editor.args, approve_all: all }),
      all ? 'Approved — the agent continues without asking again for this step' : `Approved — the agent calls ${target.toolName}`,
    );
  };

  const refuse = async () => {
    const ok = await confirm({
      title: 'Refuse this tool call?',
      message: <>The agent is told the call was refused and continues its work without it.</>,
      tone: 'warning',
      confirmLabel: 'Refuse',
    });
    if (ok) await run('reject', () => api.steps.confirm(project.id, step.id, userId, false, { ...pending.payload, approve_all: false }), 'Tool call refused');
  };

  return (
    <div className="space-y-4">
      {thought && (
        <div className="flex items-start gap-2.5 rounded-lg border border-violet-500/25 bg-violet-50/50 px-3 py-2.5 dark:bg-violet-500/[0.06]">
          <Brain size={16} className="mt-0.5 shrink-0 text-violet-500" />
          <div className="min-w-0 text-sm italic text-violet-900 dark:text-violet-200">
            <span className="label-xs mb-0.5 block not-italic !text-violet-600 dark:!text-violet-300">Agent's reasoning</span>
            <Markdown content={thought} size="xs" />
          </div>
        </div>
      )}
      <CallHeader
        icon={Bot}
        verb="The agent wants to call"
        toolName={target.toolName}
        connectorName={target.connectorName}
        sandbox={target.connector?.sandbox}
        description={pending.description || target.toolDescription}
      />
      <Section
        title="Arguments"
        icon={Pencil}
        actions={editor.edited ? <Badge tone="sky" size="xs">Edited</Badge> : <span className="text-[11px] text-faint">Correct anything before approving</span>}
      >
        <ArgsEditor rows={editor.rows} onChange={editor.setRows} errors={editor.errors} disabled={!canAct || !!busy} />
      </Section>
      {trace.length > 0 && (
        <Section title="What the agent did so far" icon={Bot}>
          <TraceView entries={trace} limit={12} maxHeight="max-h-56" />
        </Section>
      )}
      <ActionBar note={!canAct ? <NotAllowed>{blockedReason}</NotAllowed> : editor.invalid ? <span className="text-rose-600 dark:text-rose-400">Fix the arguments first</span> : undefined}>
        <Button variant="outline" size="sm" icon={X} busy={busy === 'reject'} disabled={!canAct || !!busy} onClick={() => void refuse()}>
          Reject
        </Button>
        <Button
          variant="outline"
          size="sm"
          icon={CheckCheck}
          busy={busy === 'approve_all'}
          disabled={!canAct || !!busy || editor.invalid}
          title="Approve this call and every later write of this step without asking again"
          onClick={() => void approve(true)}
        >
          Approve all remaining writes
        </Button>
        <Button size="sm" icon={Play} busy={busy === 'approve'} disabled={!canAct || !!busy || editor.invalid} onClick={() => void approve(false)}>
          Approve
        </Button>
      </ActionBar>
    </div>
  );
}
