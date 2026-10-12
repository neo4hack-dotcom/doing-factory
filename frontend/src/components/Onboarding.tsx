// First-run wizard: 1) AI model (detects a local Ollama, recommends tool-capable local models, tests
// and saves), 2) Connect (Sandbox demo or your own MCP servers), 3) Who are you (persona) with the
// end-to-end CTA "Simulate a new use case". Every step reflects the real backend state, and the
// whole thing is skippable. Contract: <Onboarding open onClose />.
//
// The shell shows it while no LLM is configured, so saving step 1 flips `open` to false; the wizard
// latches open until the person closes it, otherwise it would vanish mid-flow.
import {
  ArrowLeft, ArrowRight, Bot, CheckCircle2, FlaskConical, House, Plug, Radar, Rocket, Search, Sparkles, UserRound, XCircle, Zap,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { cls } from '../lib/cls';
import { plural } from '../lib/format';
import { navigate, paths } from '../lib/router';
import { useApp } from '../lib/store';
import type { LLMProviderKind, LlmPreset, LlmTestResult } from '../types';
import { DEMO_CONTENTS, installDemo, simulateUseCase } from '../views/settings/demo';
import type { DemoInstall, SimulationOutcome } from '../views/settings/demo';
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
    { title: 'Connect', icon: Plug, done: !!onboarding?.has_connectors || connectors.length > 0 },
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
        {step === 1 && <ConnectStep onClose={onClose} onDone={() => setStep(2)} />}
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

// ---- 2. Connect --------------------------------------------------------------------------------

function ConnectStep({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { onboarding, connectors, reload } = useApp();
  const toast = useToast();
  const [busy, run] = useBusy();
  const [result, setResult] = useState<DemoInstall | null>(null);
  const installed = !!onboarding?.demo_installed;

  const install = () => run('demo', async () => {
    const res = await installDemo();
    setResult(res);
    await reload();
    const failing = (res.connectors ?? []).filter((c) => !c.ok);
    if (failing.length) toast.warn(`Sandbox installed, but ${failing.map((c) => c.name).join(', ')} did not answer its test.`);
    else toast.success('Sandbox installed and connected.');
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">The Factory talks to your tools through <b>MCP servers</b>: the DOINg.AI portfolio (new use cases), Jira, notification channels…</p>
      <div className="grid gap-3 md:grid-cols-2">
        <div className={cls('flex flex-col rounded-xl border p-4', installed ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-violet-500/40 bg-violet-500/[0.03]')}>
          <div className="flex items-center gap-2">
            <FlaskConical size={18} className="text-violet-500" />
            <span className="text-sm font-bold">Install the demo environment</span>
            {installed && <CheckCircle2 size={16} className="ml-auto text-emerald-500" />}
          </div>
          <p className="mt-1 text-xs text-muted">Bundled, clearly labelled <Badge tone="violet" size="xs">Sandbox</Badge> — fictional data, nothing leaves this machine:</p>
          <ul className="mt-2 flex-1 space-y-1">
            {DEMO_CONTENTS.map((l) => <li key={l} className="flex gap-1.5 text-[11px] text-zinc-600 dark:text-zinc-400"><span className="text-brand-500">•</span>{l}</li>)}
          </ul>
          {result?.connectors && (
            <ul className="mt-2 space-y-0.5">
              {result.connectors.map((c) => (
                <li key={c.id} className="flex items-center gap-1.5 text-[11px]">
                  {c.ok ? <CheckCircle2 size={12} className="text-emerald-500" /> : <XCircle size={12} className="text-rose-500" />}
                  <span className="font-medium">{c.name}</span>
                  <span className="truncate text-muted">{c.ok ? plural(c.tool_count, 'tool') : c.error}</span>
                </li>
              ))}
            </ul>
          )}
          <div className="mt-3 flex gap-2">
            {installed
              ? <Button size="sm" iconRight={ArrowRight} onClick={onDone}>Continue</Button>
              : <Button size="sm" icon={FlaskConical} busy={busy === 'demo'} onClick={() => void install()}>Install demo</Button>}
          </div>
        </div>

        <div className="flex flex-col rounded-xl border p-4 hairline">
          <div className="flex items-center gap-2">
            <Plug size={18} className="text-brand-500" />
            <span className="text-sm font-bold">Connect my own MCP servers</span>
          </div>
          <p className="mt-1 flex-1 text-xs text-muted">
            Add your DOINg.AI, Jira (e.g. mcp-atlassian), e-mail or Teams servers over stdio, HTTP or SSE, test them and browse their tools.
            {connectors.length > 0 && <> You already have <b>{plural(connectors.length, 'connector')}</b>.</>}
          </p>
          <div className="mt-3">
            <Button size="sm" variant="outline" icon={Plug} onClick={() => { onClose(); navigate(paths.settings('connectors')); }}>Open Connectors</Button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ---- 3. Who are you ----------------------------------------------------------------------------

function PersonaStep({ onClose }: { onClose: () => void }) {
  const { users, userId, setUserId, roleByKey, onboarding, settings } = useApp();
  const [busy, run] = useBusy();
  const [sim, setSim] = useState<SimulationOutcome | null>(null);
  const active = useMemo(() => users.filter((u) => u.active), [users]);
  const canSimulate = !!onboarding?.demo_installed && !!settings?.llm.base_url && !!settings.llm.model;

  const simulate = () => run('sim', async () => {
    setSim(await simulateUseCase());
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Pick who you act as. The persona decides your inbox and who signs approvals — switch any time from the header (great for demos).</p>
      {active.length === 0 ? (
        <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted hairline">
          Nobody yet — install the demo (previous step) or add people in Settings › People & Teams.
        </p>
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

      {canSimulate && (
        <div className="rounded-xl border border-violet-500/30 bg-violet-500/[0.04] p-4">
          <div className="flex flex-wrap items-center gap-3">
            <Sparkles size={18} className="text-violet-500" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold">See the factory run end to end</p>
              <p className="text-xs text-muted">The AI plays a sponsor creating a new use case in the sandbox DOINg.AI; the watcher detects it into Intake.</p>
            </div>
            <Button variant="ai" icon={Sparkles} busy={busy === 'sim'} onClick={() => void simulate()}>Simulate a new use case</Button>
          </div>
          {busy === 'sim' && <p className="mt-2 text-xs text-muted">The local model is writing the use case — this can take a minute…</p>}
          {sim && (
            <div className="mt-3 rounded-lg border bg-white p-3 animate-slide-up hairline dark:bg-ink-900">
              <p className="text-sm font-semibold">{sim.name}</p>
              {sim.description && <p className="mt-0.5 line-clamp-3 text-xs text-muted">{sim.description}</p>}
              <div className="mt-2 flex flex-wrap items-center gap-2">
                {sim.detected
                  ? <Badge tone="emerald" icon={Radar}>{plural(sim.detected, 'new item')} in Intake</Badge>
                  : <Badge tone="amber">{sim.watcherError || 'Created — the watcher will detect it at its next run'}</Badge>}
                <Button size="xs" iconRight={ArrowRight} onClick={() => { onClose(); navigate(paths.intake()); }}>Open Intake</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
