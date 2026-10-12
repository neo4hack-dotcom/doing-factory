// Settings › AI Model — where the local LLM is chosen. Presets fill the server, the model list comes
// live from that server (before saving), "Test connection" runs one real round-trip on the draft,
// and the usage strip shows how the configured model has behaved over the last 24 hours.
import {
  Activity, AlertTriangle, Bot, Brain, Gauge, KeyRound, PlugZap, SlidersHorizontal, Timer, Wrench, Zap,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { Badge, Button, Field, Input, Select, Stat, Toggle, useToast } from '../../components/ui';
import { formatLatency, formatNumber, formatPercent } from '../../lib/format';
import { llmLocality } from '../../lib/llm';
import { useApp, useLive } from '../../lib/store';
import type { LLMCall, LlmPreset, LlmTestResult, ToolMode } from '../../types';
import {
  asLlmPayload, LocalityHint, matchPreset, ModelBadges, ModelList, PresetCards, TestResultView, useModelList, usePresets,
} from './llmParts';
import type { LlmDraft } from './llmParts';
import { ChoiceCards, Note, NumberInput, SaveBar, Section, useSettingsDraft } from './shared';

const TOOL_MODES: Array<{ value: ToolMode; label: string; description: string }> = [
  { value: 'auto', label: 'Auto', description: 'Native tool calling when the model declares it, JSON decide-act otherwise. Recommended.' },
  { value: 'native', label: 'Native', description: "Always use the server's tool-calling API. Fastest — only for models that support it." },
  { value: 'json', label: 'JSON', description: 'The agent answers with a JSON action each turn. Works with any model, a little slower.' },
];

const DAY_MS = 24 * 3600 * 1000;

export default function AiModelTab() {
  const { draft, set, dirty, reset, save, saving, ready } = useSettingsDraft(['llm'] as const);
  const { settings } = useApp(); // as saved: tells a stored key from the draft
  const toast = useToast();
  const llm = draft.llm;
  const { presets, error: presetsError } = usePresets();

  // The API key is never read back: '' keeps the stored one, null (Clear) removes it.
  const [apiKey, setApiKey] = useState('');
  const [clearKey, setClearKey] = useState(false);
  const keyForDraft: string | null = clearKey ? null : apiKey;
  const { models, error: modelsError, loading, reload: reloadModels } = useModelList(llm?.provider ?? 'ollama', llm?.base_url ?? '', apiKey || null);

  const [test, setTest] = useState<LlmTestResult | null>(null);
  const [testing, setTesting] = useState(false);
  const [customCtx, setCustomCtx] = useState(false);
  useEffect(() => setCustomCtx(!!llm && llm.num_ctx > 0), [llm?.num_ctx]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!ready || !llm) return <Note>Loading the settings…</Note>;

  const preset = matchPreset(presets, llm.provider, llm.base_url);
  const selectedModel = models.find((m) => m.name === llm.model);
  const keyDirty = clearKey || apiKey !== '';
  const changed = dirty || keyDirty;

  const pickPreset = (p: LlmPreset) => {
    set('llm', { provider: p.provider, base_url: p.base_url || (preset === 'custom' ? llm.base_url : '') });
    setTest(null);
  };

  const runTest = async () => {
    setTesting(true);
    setTest(null);
    try {
      // '' api_key = the stored key; the backend tests the draft over the saved settings.
      const payload: Partial<LlmDraft> = { ...llm, api_key: keyForDraft };
      setTest(await api.llm.test(asLlmPayload(payload)));
    } catch (err) {
      toast.error(err);
    } finally {
      setTesting(false);
    }
  };

  const onSave = async () => {
    const ok = await save((d) => ({ llm: asLlmPayload({ ...d.llm, api_key: keyForDraft }) }));
    if (ok) {
      setApiKey('');
      setClearKey(false);
    }
  };
  const onReset = () => {
    reset();
    setApiKey('');
    setClearKey(false);
    setTest(null);
  };

  const locality = llmLocality(llm);
  const fastOptions = [{ value: '', label: 'Same as the main model' }, ...models.map((m) => ({ value: m.name, label: m.name }))];
  if (llm.fast_model && !models.some((m) => m.name === llm.fast_model)) fastOptions.push({ value: llm.fast_model, label: llm.fast_model });

  return (
    <div className="space-y-5">
      <UsageStrip configured={!!settings?.llm.base_url} />

      <Section
        title="Server"
        subtitle="Where the Factory's LLM runs. Local servers keep every prompt on this machine."
        icon={PlugZap}
        actions={locality !== 'none' ? <LocalityHint local={locality === 'local'} /> : undefined}
      >
        {presetsError && <Note tone="rose" icon={AlertTriangle} className="mb-3">{presetsError}</Note>}
        <PresetCards presets={presets} selected={preset} onSelect={pickPreset} />
        <div className="mt-4 grid gap-4 md:grid-cols-[1fr_1fr]">
          <Field label="Base URL" required help={llm.provider === 'ollama' ? 'Native Ollama API — without /v1.' : 'OpenAI-compatible endpoint — usually ends in /v1.'}>
            <Input
              value={llm.base_url}
              placeholder={llm.provider === 'ollama' ? 'http://127.0.0.1:11434' : 'http://127.0.0.1:1234/v1'}
              onChange={(e) => set('llm', { base_url: e.target.value })}
              className="font-mono text-xs"
            />
          </Field>
          <Field
            label="API key"
            help={settings?.has_api_key && !clearKey ? 'A key is stored. Leave empty to keep it.' : 'Only for servers that require one (most local servers do not).'}
            aside={settings?.has_api_key && !clearKey ? (
              <button type="button" className="text-2xs font-semibold text-rose-600 hover:underline dark:text-rose-400" onClick={() => { setClearKey(true); setApiKey(''); }}>
                Clear key
              </button>
            ) : clearKey ? (
              <button type="button" className="text-2xs font-semibold text-brand-600 hover:underline dark:text-brand-400" onClick={() => setClearKey(false)}>
                Keep stored key
              </button>
            ) : undefined}
          >
            <Input
              type="password"
              icon={KeyRound}
              autoComplete="off"
              value={apiKey}
              disabled={clearKey}
              placeholder={clearKey ? 'The stored key will be removed on save' : settings?.has_api_key ? '•••• stored' : 'none'}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </Field>
        </div>
      </Section>

      <Section
        title="Model"
        subtitle="Listed live from the server above. Agents and MCP steps work best with a model that declares tool calling."
        icon={Bot}
      >
        <ModelList
          models={models}
          value={llm.model}
          onChange={(name) => { set('llm', { model: name }); setTest(null); }}
          loading={loading}
          error={modelsError}
          onRefresh={() => void reloadModels()}
        />
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <Field label="Main model" required help="Orchestration, drafting, agents. Type a name if the server does not list it.">
            <Input value={llm.model} onChange={(e) => set('llm', { model: e.target.value })} className="font-mono text-xs" placeholder="e.g. qwen3.5:4b" />
            {selectedModel && <div className="mt-1.5"><ModelBadges model={selectedModel} /></div>}
          </Field>
          <Field label="Fast model" help="Optional cheaper model for rewording, classification and the critic.">
            <Select value={llm.fast_model} options={fastOptions} onChange={(e) => set('llm', { fast_model: e.target.value })} />
          </Field>
        </div>
        {selectedModel && selectedModel.tools === false && (
          <Note tone="amber" icon={Wrench} className="mt-3">
            This model does not declare native tool calling: agent steps will use the JSON strategy, which works but is slower and less reliable.
          </Note>
        )}
      </Section>

      <Section title="Generation" subtitle="How the model is called." icon={SlidersHorizontal}>
        <div className="grid gap-5 md:grid-cols-2">
          <Field label={<>Temperature <span className="num ml-1 font-mono text-brand-600 dark:text-brand-400">{llm.temperature.toFixed(2)}</span></>}
            help="Low = precise and repeatable (recommended for workflows); high = more creative.">
            <input
              type="range"
              min={0}
              max={1.5}
              step={0.05}
              value={llm.temperature}
              onChange={(e) => set('llm', { temperature: Number(e.target.value) })}
              className="w-full accent-brand-500"
              aria-label="Temperature"
            />
            <div className="flex justify-between text-2xs text-faint"><span>Precise</span><span>Balanced</span><span>Creative</span></div>
          </Field>
          <Field label="Context window (num_ctx)">
            <div className="flex items-center gap-3">
              <Toggle size="sm" checked={!customCtx} onChange={(auto) => { setCustomCtx(!auto); set('llm', { num_ctx: auto ? 0 : llm.num_ctx || 16384 }); }} label="Auto" />
              {customCtx && (
                <NumberInput value={llm.num_ctx} min={2048} step={1024} fallback={0} onChange={(n) => set('llm', { num_ctx: n })} suffix="tokens" className="flex-1" />
              )}
            </div>
            <Note tone="amber" icon={AlertTriangle} className="mt-2">
              Ollama loads models with a <b>4 096-token</b> window unless told otherwise and silently cuts longer prompts — specs,
              agent transcripts and compliance evidence get truncated. <b>Auto</b> asks for the model's maximum, capped at 16 384
              locally. {llm.provider === 'openai' && 'OpenAI-compatible servers set the window at load time (LM Studio context length, vLLM --max-model-len, llama.cpp -c).'}
            </Note>
          </Field>
          <Field label="Max output tokens" help="0 = the provider's default.">
            <NumberInput value={llm.max_tokens} min={0} step={256} onChange={(n) => set('llm', { max_tokens: n })} suffix="tokens" />
          </Field>
          <Field label="Timeout" help="Per call. Local models on a laptop can need several minutes for long drafts.">
            <NumberInput value={llm.timeout_s} min={10} max={3600} step={10} fallback={240} onChange={(n) => set('llm', { timeout_s: n })} suffix="seconds" />
          </Field>
        </div>

        <div className="mt-5">
          <p className="mb-2 text-xs font-semibold text-zinc-700 dark:text-zinc-300">Agent tool mode</p>
          <ChoiceCards options={TOOL_MODES} value={llm.tool_mode} onChange={(v) => set('llm', { tool_mode: v })} />
        </div>

        <div className="mt-5 rounded-xl border p-4 hairline">
          <Toggle
            checked={llm.think}
            onChange={(v) => set('llm', { think: v })}
            label={<span className="inline-flex items-center gap-1.5"><Brain size={14} className="text-violet-500" /> Think (reasoning)</span>}
            description="Lets thinking models (qwen3.5, gemma4…) reason before answering: better on hard analyses, much slower. Only sent to models that declare thinking — keep it off for day-to-day workflows."
          />
          {llm.think && selectedModel && !selectedModel.thinking && (
            <p className="mt-2 text-xs text-muted">The selected model does not declare thinking: this setting will have no effect.</p>
          )}
        </div>
      </Section>

      <Section
        title="Test connection"
        subtitle="One real round-trip with the settings above — saved or not."
        icon={Zap}
        actions={<Button size="sm" variant="ai" icon={Zap} busy={testing} disabled={!llm.base_url.trim()} onClick={() => void runTest()}>Test connection</Button>}
      >
        {test ? <TestResultView result={test} /> : (
          <p className="text-xs text-muted">
            {llm.base_url.trim()
              ? 'Sends a short prompt and reports the latency, the reply and any setup warning (wrong endpoint, cloud model, no tool support…).'
              : 'Pick a provider and enter its URL first.'}
          </p>
        )}
      </Section>

      <SaveBar dirty={changed} saving={saving} onSave={() => void onSave()} onReset={onReset} />
    </div>
  );
}

/** LLM usage over the last 24 h, live: calls, average latency, error rate, calls per hour. */
function UsageStrip({ configured }: { configured: boolean }) {
  const [calls, setCalls] = useState<LLMCall[] | null>(null);
  useEffect(() => {
    let alive = true;
    api.admin.llmCalls(1).then((c) => alive && setCalls(c)).catch(() => alive && setCalls([]));
    return () => {
      alive = false;
    };
  }, []);
  useLive('llm.call', (e) => setCalls((prev) => (prev ? [e.call, ...prev.filter((c) => c.id !== e.call.id)] : prev)));

  const stats = useMemo(() => {
    const since = Date.now() - DAY_MS;
    const recent = (calls ?? []).filter((c) => Date.parse(c.ts) >= since);
    const hours = Array.from({ length: 24 }, () => 0);
    for (const c of recent) {
      const h = Math.min(23, Math.floor((Date.now() - Date.parse(c.ts)) / 3600000));
      hours[23 - h] += 1;
    }
    const ok = recent.filter((c) => c.ok);
    return {
      count: recent.length,
      latency: ok.length ? ok.reduce((s, c) => s + c.latency_ms, 0) / ok.length : null,
      errorRate: recent.length ? (recent.length - ok.length) / recent.length : null,
      tokens: recent.reduce((s, c) => s + c.tokens_in + c.tokens_out, 0),
      hours,
    };
  }, [calls]);

  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <Stat
        label="LLM calls · 24 h"
        icon={Activity}
        loading={calls === null}
        value={formatNumber(stats.count)}
        sub={configured ? `${formatNumber(stats.tokens)} tokens` : 'No model configured yet'}
        trend={stats.count ? stats.hours : undefined}
      />
      <Stat label="Average latency" icon={Timer} tone="sky" loading={calls === null} value={formatLatency(stats.latency)} sub="successful calls" />
      <Stat
        label="Error rate"
        icon={Gauge}
        tone={stats.errorRate && stats.errorRate > 0.1 ? 'rose' : 'emerald'}
        loading={calls === null}
        value={formatPercent(stats.errorRate)}
        sub={stats.errorRate ? <Badge tone="rose" size="xs">check the warnings of a test</Badge> : 'all calls answered'}
      />
    </div>
  );
}
