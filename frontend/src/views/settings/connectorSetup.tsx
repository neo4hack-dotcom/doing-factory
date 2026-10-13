// Real setup building blocks shared by Settings › Connectors, the first-run wizard and Home:
// connector templates (DOINg.AI, Jira via mcp-atlassian, remote MCP over HTTP…) with the form
// generated from their `fields`, the live test result, the "standard operations" report of a
// portfolio / Jira connector and the "import people from DOINg.AI" action. Everything reflects the
// backend's answer — a failed connection shows the server's error, never a placeholder.
import { Briefcase, CheckCircle2, ExternalLink, Globe, ListChecks, Plug, Radar, RefreshCw, Users, XCircle } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../../api';
import { Badge, Button, Field, Input, Spinner, useBusy, useToast } from '../../components/ui';
import { plural } from '../../lib/format';
import { safeUrl } from '../../components/Markdown';
import { useApp } from '../../lib/store';
import type { Connector, ConnectorTemplate, PeopleImportResult, StandardSetupResult } from '../../types';
import { Note } from './shared';

// ---- Templates ---------------------------------------------------------------------------------

let templatesCache: ConnectorTemplate[] | null = null;

/** GET /connectors/templates once per page load (the list is static server-side). */
export function useConnectorTemplates() {
  const [templates, setTemplates] = useState<ConnectorTemplate[] | null>(templatesCache);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setError('');
    try {
      templatesCache = await api.connectors.templates();
      setTemplates(templatesCache);
    } catch (err) {
      setError(errorMessage(err));
    }
  }, []);
  useEffect(() => {
    if (!templatesCache) void load();
  }, [load]);
  return { templates, error, reload: load };
}

export function templateIcon(t: Pick<ConnectorTemplate, 'id' | 'kind' | 'transport'>): LucideIcon {
  if (t.id === 'doing_ai' || t.kind === 'portfolio') return Briefcase;
  if (t.id === 'jira' || t.kind === 'jira') return ListChecks;
  if (t.transport !== 'stdio') return Globe;
  return Plug;
}

/** The connector a setup item points at: the first enabled one of that kind, healthy ones first. */
export function connectorOfKind(connectors: Connector[], kind: Connector['kind']): Connector | null {
  const of = connectors.filter((c) => c.kind === kind);
  return of.find((c) => c.enabled && c.status.ok) ?? of.find((c) => c.enabled) ?? of[0] ?? null;
}

/** Kinds that have a standard setup (operations + intake watcher) on the backend. */
export const hasStandardSetup = (c: Pick<Connector, 'kind'>) => c.kind === 'portfolio' || c.kind === 'jira';

// ---- Form generated from a template --------------------------------------------------------------

/**
 * One input per template field (secret ones as password inputs), then "Connect & test":
 * POST /connectors/from-template creates the connector and tests it; the result is shown inline.
 */
export function TemplateConnectForm({ template, onConnected, showName = true, submitLabel = 'Connect & test' }: {
  template: ConnectorTemplate;
  onConnected?: (connector: Connector) => void | Promise<void>;
  showName?: boolean;
  submitLabel?: string;
}) {
  const { reload } = useApp();
  const toast = useToast();
  const [busy, run] = useBusy();
  const [name, setName] = useState(template.name);
  const [values, setValues] = useState<Record<string, string>>({});
  const [result, setResult] = useState<Connector | null>(null);
  const missing = template.fields.filter((f) => f.required && !(values[f.key] ?? '').trim());
  const docs = template.docs_url ? safeUrl(template.docs_url) : '';

  const connect = () => run('connect', async () => {
    const clean: Record<string, string> = {};
    for (const f of template.fields) {
      const v = (values[f.key] ?? '').trim();
      if (v) clean[f.key] = v;
    }
    const created = await api.connectors.fromTemplate(template.id, clean, name.trim() || undefined);
    setResult(created);
    await reload();
    if (created.status.ok) toast.success(`${created.name} connected — ${plural(created.status.tool_count || created.tools.length, 'tool')}.`);
    else toast.warn(`${created.name} was saved, but its test failed: ${created.status.error || 'no answer'}`);
    if (created.status.ok) await onConnected?.(created);
  });

  if (result?.status.ok) return <ConnectorTestResult connector={result} />;

  return (
    <div className="space-y-3">
      {showName && (
        <Field label="Name" help="Shown in Studio and in the audit trail. Also the tool namespace.">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </Field>
      )}
      {template.fields.map((f) => (
        <Field key={f.key} label={f.label} required={f.required} help={f.help || undefined}>
          <Input
            type={f.secret ? 'password' : 'text'}
            autoComplete={f.secret ? 'new-password' : 'off'}
            value={values[f.key] ?? ''}
            placeholder={f.placeholder}
            className={f.secret ? undefined : 'font-mono text-xs'}
            onChange={(e) => setValues((v) => ({ ...v, [f.key]: e.target.value }))}
          />
        </Field>
      ))}
      {result && <ConnectorTestResult connector={result} />}
      <div className="flex flex-wrap items-center gap-2">
        <Button icon={RefreshCw} busy={busy === 'connect'} disabled={!!busy || missing.length > 0} onClick={() => void connect()}>
          {result ? 'Try again' : submitLabel}
        </Button>
        {missing.length > 0 && <span className="text-2xs text-faint">Required: {missing.map((f) => f.label).join(', ')}</span>}
        {docs && (
          <a href={docs} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-xs font-medium text-brand-600 hover:underline dark:text-brand-400">
            Documentation <ExternalLink size={12} />
          </a>
        )}
      </div>
      {result && !result.status.ok && (
        <p className="text-2xs text-faint">The connector was saved: fix the values and try again, or edit it later in Settings › Connectors.</p>
      )}
    </div>
  );
}

/** The live test of a connector: tools found, or the server's error. */
export function ConnectorTestResult({ connector }: { connector: Connector }) {
  const tools = connector.tools.map((t) => t.name);
  if (connector.status.ok) {
    return (
      <Note tone="emerald" icon={CheckCircle2}>
        <b>{connector.name}</b> is connected — {plural(connector.status.tool_count || tools.length, 'tool')} found
        {connector.status.server_name && <> on <b>{connector.status.server_name}</b></>}.
        {tools.length > 0 && (
          <span className="mt-1 block font-mono text-[11px] opacity-80">
            {tools.slice(0, 8).join(' · ')}{tools.length > 8 && ` · +${tools.length - 8}`}
          </span>
        )}
      </Note>
    );
  }
  return (
    <Note tone="rose" icon={XCircle}>
      <b>{connector.name}</b> did not answer its test{connector.status.error ? ':' : '.'}
      {connector.status.error && <span className="mt-1 block font-mono text-[11px]">{connector.status.error}</span>}
    </Note>
  );
}

// ---- Standard setup & people import ------------------------------------------------------------

/** What POST /connectors/{id}/standard-setup did. */
export function StandardSetupReport({ result }: { result: StandardSetupResult }) {
  return (
    <div className="space-y-2 text-xs">
      {result.operations_created.length > 0 && (
        <div>
          <p className="mb-1 font-semibold text-zinc-800 dark:text-zinc-200">{plural(result.operations_created.length, 'operation')} created</p>
          <div className="flex flex-wrap gap-1">{result.operations_created.map((o) => <Badge key={o} tone="emerald" size="xs">{o}</Badge>)}</div>
        </div>
      )}
      {result.operations_existing.length > 0 && (
        <div>
          <p className="mb-1 font-semibold text-zinc-800 dark:text-zinc-200">Already there</p>
          <div className="flex flex-wrap gap-1">{result.operations_existing.map((o) => <Badge key={o} tone="zinc" size="xs">{o}</Badge>)}</div>
        </div>
      )}
      {result.operations_created.length === 0 && result.operations_existing.length === 0 && (
        <p className="text-muted">No operation was created.</p>
      )}
      {result.watcher_created && <Badge tone="sky" icon={Radar}>Intake watcher created</Badge>}
      {result.notes.map((n) => <Note key={n} tone="amber">{n}</Note>)}
    </div>
  );
}

export const standardSetupSummary = (r: StandardSetupResult) =>
  `${plural(r.operations_created.length, 'operation')} created, ${r.operations_existing.length} already there${r.watcher_created ? ', intake watcher created' : ''}.`;

export const peopleImportSummary = (r: PeopleImportResult) =>
  `${plural(r.created, 'person', 'people')} imported${r.skipped ? `, ${r.skipped} already known` : ''}.`;

/** "Import people" from a portfolio connector, with a toast of the counts. */
export function ImportPeopleButton({ connector, size = 'sm', variant = 'outline', onDone }: {
  connector: Connector;
  size?: 'xs' | 'sm';
  variant?: 'outline' | 'ghost' | 'primary';
  onDone?: (r: PeopleImportResult) => void;
}) {
  const { reload } = useApp();
  const toast = useToast();
  const [busy, run] = useBusy();
  const importPeople = () => run('people', async () => {
    const res = await api.people.importFromConnector(connector.id);
    await reload();
    toast.success(`${connector.name}: ${peopleImportSummary(res)}`);
    onDone?.(res);
  });
  return (
    <Button size={size} variant={variant} icon={Users} busy={busy === 'people'} disabled={!connector.enabled} onClick={() => void importPeople()}>
      Import people
    </Button>
  );
}

/** Inline loading line used while the template list arrives. */
export function TemplatesLoading({ error, onRetry }: { error: string; onRetry: () => void }) {
  if (error) {
    return (
      <Note tone="rose" icon={XCircle}>
        Could not load the connector templates: {error}{' '}
        <button type="button" className="font-semibold underline" onClick={onRetry}>Retry</button>
      </Note>
    );
  }
  return <p className="flex items-center gap-2 text-xs text-muted"><Spinner size={13} /> Loading connector templates…</p>;
}
