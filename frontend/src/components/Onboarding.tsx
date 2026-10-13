// First-run wizard: 1) AI model (detects a local Ollama, recommends tool-capable local models, tests
// and saves), 2) Connect your systems (DOINg.AI and Jira from their templates, each tested live,
// then their standard operations, then people imported from DOINg.AI), 3) Who are you (persona).
// Every item reflects the real backend state, and the whole thing is skippable.
// Contract: <Onboarding open onClose />.
//
// The shell shows it while no LLM is configured, so saving step 1 flips `open` to false; the wizard
// latches open until the person closes it, otherwise it would vanish mid-flow.
import {
  ArrowLeft, ArrowRight, Bot, Briefcase, CheckCircle2, Circle, House, ListChecks, ListPlus, Plug, RefreshCw, Rocket, Search,
  UserPlus, UserRound, XCircle, Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { cls } from '../lib/cls';
import { plural } from '../lib/format';
import { navigate, paths } from '../lib/router';
import { useApp } from '../lib/store';
import type {
  Connector, ConnectorTemplate, LLMProviderKind, LlmPreset, LlmTestResult, PeopleImportResult, StandardSetupResult,
} from '../types';
import {
  connectorOfKind, ImportPeopleButton, peopleImportSummary, StandardSetupReport, standardSetupSummary, TemplateConnectForm,
  TemplatesLoading, useConnectorTemplates,
} from '../views/settings/connectorSetup';
import { isRecommended, matchPreset, ModelList, PresetCards, TestResultView, useModelList, usePresets } from '../views/settings/llmParts';
import { Avatar, Badge, Button, Field, Input, Modal, Spinner, TONE, toneOf, useBusy, useToast } from './ui';

const OLLAMA_URL = 'http://127.0.0.1:11434';

interface StepMeta {
  title: string;
  icon: LucideIcon;
  done: boolean;
}

export function Onboarding({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) setShown(true);
  }, [open]);
  if (!shown) return null;
  return <Wizard onClose={() => { setShown(false); onClose(); }} />;
}

function Wizard({ onClose }: { onClose: () => void }) {
  const { onboarding, connectors, userId } = useApp();
  const [step, setStep] = useState(() => (!onboarding?.llm_configured ? 0 : !onboarding.has_connectors ? 1 : 2));
  const steps: StepMeta[] = [
    { title: 'AI model', icon: Bot, done: !!onboarding?.llm_configured },
    { title: 'Connect your systems', icon: Plug, done: !!onboarding?.has_connectors || connectors.length > 0 },
    { title: 'Who are you', icon: UserRound, done: !!userId },
  ];
  const last = step === steps.length - 1;

  return (
    <Modal
      open
      onClose={onClose}
      title="Set up DOINg.AI Factory"
      subtitle="Three short steps — everything can be changed later in Settings."
      icon={Rocket}
      size="lg"
      footer={
        <>
          <Button variant="ghost" className="mr-auto" onClick={onClose}>Skip setup</Button>
          {step > 0 && <Button variant="outline" icon={ArrowLeft} onClick={() => setStep(step - 1)}>Back</Button>}
          {!last && <Button iconRight={ArrowRight} variant={steps[step].done ? 'primary' : 'outline'} onClick={() => setStep(step + 1)}>
            {steps[step].done ? 'Next' : 'Skip this step'}
          </Button>}
          {last && <Button icon={House} onClick={() => { onClose(); navigate(paths.home()); }}>Go to Home</Button>}
        </>
      }
    >
      <ol className="mb-5 flex items-center gap-2" aria-label="Setup steps">
        {steps.map((s, i) => {
          const Icon = s.done ? CheckCircle2 : s.icon;
          const active = i === step;
          return (
            <li key={s.title} className="flex flex-1 items-center gap-2">
              <button
                type="button"
                onClick={() => setStep(i)}
                aria-current={active ? 'step' : undefined}
                className={cls('flex min-w-0 items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors', active ? 'bg-brand-500/10' : 'hover:bg-zinc-100 dark:hover:bg-ink-700')}
              >
                <span className={cls('grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold',
                  s.done ? 'bg-emerald-500 text-white' : active ? 'bg-brand-500 text-white' : 'bg-zinc-100 text-zinc-500 dark:bg-ink-600 dark:text-zinc-400')}>
                  {s.done || active ? <Icon size={14} /> : i + 1}
                </span>
                <span className={cls('truncate text-xs font-semibold', active ? 'text-zinc-900 dark:text-white' : 'text-muted')}>{s.title}</span>
              </button>
              {i < steps.length - 1 && <span className={cls('h-px flex-1', steps[i].done ? 'bg-emerald-500/60' : 'bg-zinc-200 dark:bg-ink-500')} />}
            </li>
          );
        })}
      </ol>
      <div key={step} className="animate-fade-in">
        {step === 0 && <AiStep onDone={() => setStep(1)} />}
        {step === 1 && <ConnectStep onClose={onClose} />}
        {step === 2 && <PersonaStep onClose={onClose} />}
      </div>
    </Modal>
  );
}

// ---- 1. AI model -------------------------------------------------------------------------------

function AiStep({ onDone }: { onDone: () => void }) {
  const { settings, onboarding, reload } = useApp();
  const toast = useToast();
  const { presets } = usePresets();
  const saved = settings?.llm;
  const [provider, setProvider] = useState<LLMProviderKind>(saved?.base_url ? saved.provider : 'ollama');
  const [baseUrl, setBaseUrl] = useState(saved?.base_url || OLLAMA_URL);
  const [model, setModel] = useState(saved?.model ?? '');
  const [test, setTest] = useState<LlmTestResult | null>(null);
  const [busy, run] = useBusy();
  const { models, error, loading, reload: reloadModels } = useModelList(provider, baseUrl, null);
  const recommended = models.filter(isRecommended);

  // Pre-select the best local tool-capable model once the list arrives.
  useEffect(() => {
    if (!model && models.length) setModel((recommended[0] ?? models[0]).name);
  }, [models]); // eslint-disable-line react-hooks/exhaustive-deps

  const unchanged = !!saved && saved.provider === provider && saved.base_url === baseUrl && saved.model === model;
  const configured = !!onboarding?.llm_configured && unchanged;

  const pickPreset = (p: LlmPreset) => {
    setProvider(p.provider);
    setBaseUrl(p.base_url);
    setModel('');
    setTest(null);
  };

  const runTest = () => run('test', async () => {
    setTest(await api.llm.test({ provider, base_url: baseUrl, model }));
  });

  const save = () => run('save', async () => {
    await api.settings.update({ llm: { provider, base_url: baseUrl.trim(), model: model.trim() } });
    await reload();
    toast.success(`AI model saved: ${model}.`);
    onDone();
  });

  const isOllama = provider === 'ollama';
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        The Factory uses a <b>local LLM</b> to draft specs, write Jira backlogs, check compliance and run agents. Prompts stay on your machine.
      </p>

      <div className={cls('flex items-center gap-2 rounded-lg px-3 py-2 text-xs ring-1 ring-inset',
        loading ? TONE.zinc.soft : error ? TONE.amber.soft : models.length ? TONE.emerald.soft : TONE.zinc.soft)}>
        {loading ? <Spinner size={13} /> : error ? <Search size={14} /> : <CheckCircle2 size={14} />}
        <span className="min-w-0 flex-1">
          {loading
            ? `Looking for ${isOllama ? 'Ollama' : 'the server'} at ${baseUrl}…`
            : error
              ? <>{error}{isOllama && <> — start it with <code>ollama serve</code>, or pick another provider.</>}</>
              : models.length
                ? <>{isOllama ? 'Ollama detected' : 'Server reachable'} · {plural(models.length, 'model')}{recommended.length > 0 && <> · <b>{recommended.length} recommended</b> (local + tool calling)</>}</>
                : 'Enter the server URL.'}
        </span>
      </div>

      <PresetCards presets={presets} selected={matchPreset(presets, provider, baseUrl)} onSelect={pickPreset} compact />
      <Field label="Base URL">
        <Input value={baseUrl} onChange={(e) => { setBaseUrl(e.target.value); setTest(null); }} className="font-mono text-xs" />
      </Field>
      <ModelList models={models} value={model} onChange={(m) => { setModel(m); setTest(null); }} loading={loading} error="" onRefresh={() => void reloadModels()} maxHeight="max-h-56" />
      {!models.length && !loading && (
        <Field label="Model name" help="Type it if the server does not list its models.">
          <Input value={model} onChange={(e) => setModel(e.target.value)} className="font-mono text-xs" placeholder="qwen3.5:4b" />
        </Field>
      )}

      {test && <TestResultView result={test} />}

      <div className="flex flex-wrap items-center gap-2">
        <Button variant="ai" icon={Zap} busy={busy === 'test'} disabled={!baseUrl.trim() || !model.trim()} onClick={() => void runTest()}>Test</Button>
        {configured ? (
          <Badge tone="emerald" icon={CheckCircle2}>Configured · {saved?.model}</Badge>
        ) : (
          <Button busy={busy === 'save'} disabled={!baseUrl.trim() || !model.trim()} onClick={() => void save()}>Save & continue</Button>
        )}
        <span className="ml-auto text-2xs text-faint">Advanced options (context window, tool mode…) live in Settings › AI Model.</span>
      </div>
    </div>
  );
}

// ---- 2. Connect your systems -------------------------------------------------------------------

function ConnectStep({ onClose }: { onClose: () => void }) {
  const { connectors } = useApp();
  const { templates, error, reload } = useConnectorTemplates();
  const byId = (id: string) => templates?.find((t) => t.id === id) ?? null;
  const others = connectors.filter((c) => c.kind !== 'portfolio' && c.kind !== 'jira').length;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">
        The Factory talks to your systems through <b>MCP servers</b>. Connect your <b>DOINg.AI</b> (where sponsors register use cases)
        and your <b>Jira</b>; each connection is tested live, then the standard operations are created for you.
      </p>
      {!templates ? <TemplatesLoading error={error} onRetry={() => void reload()} /> : (
        <>
          <SystemCard
            kind="portfolio"
            title="DOINg.AI"
            blurb="Your use-case portfolio — its URL, plus a token if your instance needs one."
            template={byId('doing_ai')}
            initiallyOpen
            onClose={onClose}
          />
          <SystemCard
            kind="jira"
            title="Jira"
            blurb="Through mcp-atlassian: your site URL, your e-mail and an API token."
            template={byId('jira')}
            onClose={onClose}
          />
        </>
      )}
      <p className="text-xs text-muted">
        Teams, e-mail, git or any other MCP server{others > 0 && <> (you have {plural(others, 'other connector')})</>}:{' '}
        <button type="button" className="font-semibold text-brand-600 hover:underline dark:text-brand-400" onClick={() => { onClose(); navigate(paths.settings('connectors')); }}>
          Settings › Connectors
        </button>.
      </p>
    </div>
  );
}

/** One system of step 2: connect it from its template, then its standard operations (and people). */
function SystemCard({ kind, title, blurb, template, initiallyOpen = false, onClose }: {
  kind: 'portfolio' | 'jira';
  title: string;
  blurb: string;
  template: ConnectorTemplate | null;
  initiallyOpen?: boolean;
  onClose: () => void;
}) {
  const { connectors, operations, reload } = useApp();
  const toast = useToast();
  const [busy, run] = useBusy();
  const [expanded, setExpanded] = useState(initiallyOpen);
  const [report, setReport] = useState<StandardSetupResult | null>(null);
  const connector = connectorOfKind(connectors, kind);
  const opCount = connector ? operations.filter((o) => o.connector_id === connector.id).length : 0;
  const ok = connector?.status.ok === true;

  const setup = (c: Connector) => run('std', async () => {
    const res = await api.connectors.standardSetup(c.id);
    setReport(res);
    await reload();
    toast.success(`${c.name}: ${standardSetupSummary(res)}`);
  });
  const retest = (c: Connector) => run('test', async () => {
    const saved = await api.connectors.test(c.id);
    await reload();
    if (saved.status.ok) toast.success(`${saved.name}: ${plural(saved.status.tool_count, 'tool')}.`);
    else toast.error(`${saved.name}: ${saved.status.error || 'the server did not answer.'}`);
  });

  const Icon = kind === 'portfolio' ? Briefcase : ListChecks;
  return (
    <div className={cls('rounded-xl border p-4', ok ? 'border-emerald-500/40 bg-emerald-500/[0.04]' : 'hairline')}>
      <div className="flex flex-wrap items-center gap-2">
        <Icon size={18} className="text-brand-500" />
        <span className="text-sm font-bold">{title}</span>
        {connector ? (
          ok
            ? <Badge tone="emerald" size="xs" icon={CheckCircle2}>Connected · {plural(connector.status.tool_count || connector.tools.length, 'tool')}</Badge>
            : connector.status.ok === false
              ? <Badge tone="rose" size="xs" icon={XCircle}>Failing</Badge>
              : <Badge tone="zinc" size="xs">Not tested</Badge>
        ) : <Badge tone="zinc" size="xs">Not connected</Badge>}
        {!connector && !expanded && (
          <Button size="xs" variant="outline" icon={Plug} className="ml-auto" disabled={!template} onClick={() => setExpanded(true)}>Connect</Button>
        )}
      </div>
      <p className="mt-1 text-xs text-muted">{connector ? connector.description || blurb : blurb}</p>

      {!connector && expanded && (
        <div className="mt-3">
          {template
            ? <TemplateConnectForm template={template} showName={false} onConnected={(c) => setup(c)} />
            : <p className="text-xs text-muted">This server offers no {title} template — add it from Settings › Connectors.</p>}
        </div>
      )}

      {connector && (
        <div className="mt-3 space-y-3">
          {connector.status.ok === false && connector.status.error && (
            <p className="rounded-lg bg-rose-50 px-2.5 py-1.5 font-mono text-[11px] text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">{connector.status.error}</p>
          )}
          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="flex items-center gap-1.5">
              {opCount > 0 ? <CheckCircle2 size={14} className="text-emerald-500" /> : <Circle size={14} className="text-zinc-400" />}
              {opCount > 0 ? plural(opCount, 'operation') : 'No operation yet'}
            </span>
            <Button size="xs" variant={opCount ? 'ghost' : 'primary'} icon={ListPlus} busy={busy === 'std'} disabled={!ok} onClick={() => void setup(connector)}>
              {opCount ? 'Re-run standard setup' : 'Create standard operations'}
            </Button>
            {!ok && <Button size="xs" variant="outline" icon={RefreshCw} busy={busy === 'test'} onClick={() => void retest(connector)}>Test again</Button>}
            {!ok && (
              <button type="button" className="text-xs font-semibold text-brand-600 hover:underline dark:text-brand-400" onClick={() => { onClose(); navigate(paths.settings('connectors')); }}>
                Edit in Settings
              </button>
            )}
          </div>
          {report && <StandardSetupReport result={report} />}
          {kind === 'portfolio' && ok && <PeopleRow connector={connector} />}
        </div>
      )}
    </div>
  );
}

function PeopleRow({ connector }: { connector: Connector }) {
  const { users } = useApp();
  const [last, setLast] = useState<PeopleImportResult | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-xs hairline">
      <span className="flex items-center gap-1.5">
        {users.length > 0 ? <CheckCircle2 size={14} className="text-emerald-500" /> : <Circle size={14} className="text-zinc-400" />}
        {users.length > 0 ? `${plural(users.length, 'person', 'people')} in the Factory` : 'No people yet'}
      </span>
      <ImportPeopleButton connector={connector} size="xs" variant={users.length ? 'ghost' : 'primary'} onDone={setLast} />
      {last && <span className="text-muted">{peopleImportSummary(last)}</span>}
    </div>
  );
}

// ---- 3. Who are you ----------------------------------------------------------------------------

function PersonaStep({ onClose }: { onClose: () => void }) {
  const { users, userId, setUserId, roleByKey, connectors } = useApp();
  const active = useMemo(() => users.filter((u) => u.active), [users]);
  const portfolio = connectorOfKind(connectors, 'portfolio');

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Pick who you act as. The persona decides your inbox and who signs approvals — switch any time from the header.</p>
      {active.length === 0 ? (
        <div className="space-y-3 rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted hairline">
          <p>Nobody yet — import the people your DOINg.AI knows, or add them with their roles.</p>
          <div className="flex flex-wrap justify-center gap-2">
            {portfolio && portfolio.status.ok && <ImportPeopleButton connector={portfolio} variant="primary" />}
            <Button size="sm" variant="outline" icon={UserPlus} onClick={() => { onClose(); navigate(paths.settings('people')); }}>Add people</Button>
          </div>
        </div>
      ) : (
        <div className="grid max-h-64 gap-2 overflow-y-auto pr-1 sm:grid-cols-2" role="radiogroup" aria-label="Persona">
          {active.map((u) => {
            const on = u.id === userId;
            return (
              <button
                key={u.id}
                type="button"
                role="radio"
                aria-checked={on}
                onClick={() => setUserId(u.id)}
                className={cls('flex items-center gap-3 rounded-xl border p-2.5 text-left transition-all',
                  on ? 'border-brand-500 bg-brand-500/5 ring-2 ring-brand-500/25' : 'hairline hover:border-zinc-300 dark:hover:border-ink-400')}
              >
                <Avatar user={u} size={34} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-zinc-900 dark:text-white">{u.name}</span>
                  <span className="block truncate text-2xs text-muted">{u.title || u.email}</span>
                  <span className="mt-1 flex flex-wrap gap-1">
                    {u.roles.slice(0, 3).map((r) => <Badge key={r} tone={toneOf(roleByKey(r)?.color)} size="xs">{roleByKey(r)?.label ?? r}</Badge>)}
                  </span>
                </span>
                {on && <CheckCircle2 size={16} className="shrink-0 text-brand-500" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
