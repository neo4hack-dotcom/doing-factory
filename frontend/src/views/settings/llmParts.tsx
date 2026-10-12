// AI-model pieces shared by Settings › AI Model and the first-run wizard: provider presets, the
// live model list of a (possibly unsaved) server, the model picker and the connection-test report.
// Everything shown comes from the server the person points at — nothing is assumed.
import {
  AlertTriangle, Brain, CheckCircle2, Cloud, Cpu, HardDrive, RefreshCw, Search, Sparkles, Wrench, XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { Badge, Button, Input, Spinner, Tooltip } from '../../components/ui';
import { cls } from '../../lib/cls';
import { formatBytes, formatCompact, formatLatency, plural, truncate } from '../../lib/format';
import type { LLMSettings, LlmModelInfo, LlmPreset, LlmTestResult } from '../../types';

/**
 * LLM settings as edited: like LLMSettings, but `api_key` may be `null` = clear the stored key
 * (PUT /settings and the draft endpoints treat '' as "keep the stored key" and null as "no key").
 */
export type LlmDraft = Omit<LLMSettings, 'api_key'> & { api_key: string | null };

/** The draft as the typed client takes it (the client types api_key as string; null is valid on the wire). */
export const asLlmPayload = (draft: Partial<LlmDraft>) => draft as unknown as Partial<LLMSettings>;

export function usePresets() {
  const [presets, setPresets] = useState<LlmPreset[]>([]);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    api.llm.presets()
      .then((p) => alive && setPresets(p))
      .catch((err: unknown) => alive && setError(err instanceof Error ? err.message : 'Could not load the presets'));
    return () => {
      alive = false;
    };
  }, []);
  return { presets, error };
}

/** The preset matching a provider + base URL ('custom' when none does). */
export function matchPreset(presets: LlmPreset[], provider: string, baseUrl: string): string {
  const norm = (u: string) => u.trim().replace(/\/+$/, '').replace('localhost', '127.0.0.1');
  const hit = presets.find((p) => p.base_url && p.provider === provider && norm(p.base_url) === norm(baseUrl));
  return hit?.id ?? 'custom';
}

/** Tool-capable models running on this machine are what the agents need. */
export const isRecommended = (m: LlmModelInfo) => m.local && m.tools === true;

/** Recommended first, then local, then by name. */
export function sortModels(models: LlmModelInfo[]): LlmModelInfo[] {
  const rank = (m: LlmModelInfo) => (isRecommended(m) ? 0 : m.local ? 1 : 2);
  return [...models].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

/**
 * Lists the models of the server described by the draft, debounced while the URL is typed.
 * A typed API key goes through POST (a secret never travels in a URL).
 */
export function useModelList(provider: string, baseUrl: string, apiKey: string | null) {
  const [models, setModels] = useState<LlmModelInfo[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);

  const load = useCallback(async () => {
    const id = ++seq.current;
    if (!baseUrl.trim()) {
      setModels([]);
      setError('');
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const res = apiKey
        ? await api.llm.modelsDraft({ provider: provider as LLMSettings['provider'], base_url: baseUrl, api_key: apiKey })
        : await api.llm.models(provider, baseUrl);
      if (id !== seq.current) return;
      setModels(sortModels(res.models));
      setError(res.error);
    } catch (err) {
      if (id !== seq.current) return;
      setModels([]);
      setError(err instanceof Error ? err.message : 'Could not list the models');
    } finally {
      if (id === seq.current) setLoading(false);
    }
  }, [provider, baseUrl, apiKey]);

  useEffect(() => {
    const t = setTimeout(() => void load(), 450);
    return () => clearTimeout(t);
  }, [load]);

  return { models, error, loading, reload: load };
}

/** Provider preset cards: one click fills provider + base URL. */
export function PresetCards({ presets, selected, onSelect, compact }: {
  presets: LlmPreset[];
  selected: string;
  onSelect: (preset: LlmPreset) => void;
  compact?: boolean;
}) {
  return (
    <div className={cls('grid gap-2', compact ? 'grid-cols-2 sm:grid-cols-3' : 'sm:grid-cols-2 lg:grid-cols-3')} role="radiogroup" aria-label="Provider">
      {presets.map((p) => {
        const on = p.id === selected;
        return (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onSelect(p)}
            className={cls(
              'rounded-xl border p-3 text-left transition-all',
              on ? 'border-brand-500 bg-brand-500/5 ring-2 ring-brand-500/25' : 'hairline hover:border-zinc-300 dark:hover:border-ink-400',
            )}
          >
            <div className="flex items-center gap-2">
              <Cpu size={15} className={on ? 'text-brand-500' : 'text-zinc-400'} />
              <span className="truncate text-sm font-semibold text-zinc-900 dark:text-white">{p.label}</span>
            </div>
            {!compact && <p className="mt-1 text-[11px] leading-relaxed text-muted">{p.hint}</p>}
            <p className="mt-1 truncate font-mono text-2xs text-faint">{p.base_url || 'your URL'}</p>
          </button>
        );
      })}
    </div>
  );
}

/** Capability chips for one model. */
export function ModelBadges({ model }: { model: LlmModelInfo }) {
  return (
    <div className="flex flex-wrap items-center gap-1">
      {model.local
        ? <Badge tone="emerald" size="xs" icon={HardDrive} title="Runs on this machine: prompts never leave it">Local</Badge>
        : <Badge tone="amber" size="xs" icon={Cloud} title="Hosted remotely: prompts leave this machine">Cloud</Badge>}
      {model.tools === true && <Badge tone="brand" size="xs" icon={Wrench} title="Declares native tool calling (agents, MCP steps)">Tools</Badge>}
      {model.tools === false && <Badge tone="zinc" size="xs" title="No native tool calling: agents fall back to JSON mode">No tools</Badge>}
      {model.thinking && <Badge tone="violet" size="xs" icon={Brain} title="Reasoning model (see the Think toggle)">Thinking</Badge>}
      {model.vision && <Badge tone="sky" size="xs">Vision</Badge>}
    </div>
  );
}

/** Selectable model list (radio rows) with search when the server offers many. */
export function ModelList({ models, value, onChange, loading, error, onRefresh, maxHeight = 'max-h-80' }: {
  models: LlmModelInfo[];
  value: string;
  onChange: (name: string) => void;
  loading: boolean;
  error: string;
  onRefresh: () => void;
  maxHeight?: string;
}) {
  const [q, setQ] = useState('');
  const shown = useMemo(
    () => (q ? models.filter((m) => m.name.toLowerCase().includes(q.toLowerCase())) : models),
    [models, q],
  );
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2">
        {models.length > 6 && (
          <Input icon={Search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter models…" className="h-8 text-xs" />
        )}
        <span className="ml-auto shrink-0 text-xs text-muted">
          {loading ? 'Listing models…' : error ? '' : plural(models.length, 'model')}
        </span>
        <Button size="xs" variant="ghost" icon={RefreshCw} busy={loading} onClick={onRefresh}>Refresh</Button>
      </div>
      {error && (
        <div className="flex items-start gap-2 rounded-lg bg-rose-50 px-3 py-2 text-xs text-rose-700 dark:bg-rose-500/10 dark:text-rose-300">
          <XCircle size={14} className="mt-0.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {!error && !loading && !models.length && (
        <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted hairline">
          No model listed yet — enter the server URL above. You can also type a model name below.
        </p>
      )}
      {loading && !models.length && (
        <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted"><Spinner size={14} /> Contacting the server…</div>
      )}
      {shown.length > 0 && (
        <ul className={cls('divide-y overflow-y-auto rounded-xl border hairline dark:divide-ink-600', maxHeight)} role="radiogroup" aria-label="Model">
          {shown.map((m) => {
            const on = m.name === value;
            return (
              <li key={m.name}>
                <button
                  type="button"
                  role="radio"
                  aria-checked={on}
                  onClick={() => onChange(m.name)}
                  className={cls('flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors',
                    on ? 'bg-brand-500/[0.07]' : 'hover:bg-zinc-50 dark:hover:bg-ink-700')}
                >
                  <span className={cls('grid h-4 w-4 shrink-0 place-items-center rounded-full border-2',
                    on ? 'border-brand-500' : 'border-zinc-300 dark:border-ink-400')}>
                    {on && <span className="h-1.5 w-1.5 rounded-full bg-brand-500" />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-2">
                      <span className="truncate font-mono text-xs font-semibold text-zinc-900 dark:text-white">{m.name}</span>
                      {isRecommended(m) && (
                        <span className="inline-flex items-center gap-0.5 text-2xs font-bold uppercase tracking-wide text-brand-600 dark:text-brand-400">
                          <Sparkles size={10} /> Recommended
                        </span>
                      )}
                    </span>
                    <span className="mt-1 block"><ModelBadges model={m} /></span>
                  </span>
                  <span className="hidden shrink-0 text-right text-2xs text-muted sm:block">
                    {m.parameters && <span className="block num">{m.parameters}</span>}
                    {m.size && m.size > 1e6 ? <span className="block num">{formatBytes(m.size)}</span> : null}
                    {m.context ? <span className="block num">{formatCompact(m.context)} ctx</span> : null}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** What the connection test answered: latency, reply, privacy, capabilities, setup warnings. */
export function TestResultView({ result }: { result: LlmTestResult }) {
  return (
    <div className={cls('rounded-xl border p-4 animate-slide-up', result.ok ? 'border-emerald-500/40 bg-emerald-500/5' : 'border-rose-500/40 bg-rose-500/5')}>
      <div className="flex flex-wrap items-center gap-2">
        {result.ok
          ? <CheckCircle2 size={18} className="text-emerald-500" />
          : <XCircle size={18} className="text-rose-500" />}
        <span className="text-sm font-semibold text-zinc-900 dark:text-white">
          {result.ok ? 'Connected' : 'Connection failed'}
        </span>
        {result.ok && <Badge tone="emerald" size="xs">{formatLatency(result.latency_ms)}</Badge>}
        {result.model && <span className="font-mono text-xs text-muted">{result.model}</span>}
        {result.ok && (
          <span className="ml-auto flex flex-wrap gap-1">
            {result.local
              ? <Badge tone="emerald" size="xs" icon={HardDrive}>Local</Badge>
              : <Badge tone="amber" size="xs" icon={Cloud}>Prompts leave this machine</Badge>}
            {result.tools === true && <Badge tone="brand" size="xs" icon={Wrench}>Tools</Badge>}
            {result.tools === false && <Badge tone="zinc" size="xs">No native tools</Badge>}
            {result.context ? <Badge tone="sky" size="xs">{formatCompact(result.context)} context</Badge> : null}
          </span>
        )}
      </div>
      {result.error && <p className="mt-2 text-xs text-rose-700 dark:text-rose-300">{result.error}</p>}
      {result.reply && (
        <p className="mt-2 rounded-lg bg-white/70 px-3 py-2 text-xs text-zinc-700 dark:bg-ink-900/60 dark:text-zinc-300">
          <span className="label-xs mr-2">Reply</span>{truncate(result.reply, 300)}
        </p>
      )}
      {result.warnings?.length > 0 && (
        <ul className="mt-3 space-y-1.5">
          {result.warnings.map((w) => (
            <li key={w} className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-300">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" /> <span>{w}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Compact "where does the AI run" chip for headers. */
export function LocalityHint({ local }: { local: boolean }) {
  return (
    <Tooltip content={local ? 'The model runs on this machine — prompts never leave it.' : 'Prompts are sent to a remote host.'}>
      {local
        ? <Badge tone="emerald" icon={HardDrive}>Local</Badge>
        : <Badge tone="amber" icon={Cloud}>Remote</Badge>}
    </Tooltip>
  );
}
