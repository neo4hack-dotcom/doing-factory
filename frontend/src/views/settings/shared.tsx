// Building blocks shared by the Settings tabs: a draft-and-save hook over the settings singleton,
// the sticky save bar, section cards and the small editors (key/value rows with secret masking,
// string lists, JSON objects, chip pickers) that connectors, watchers and people all need.
import { Eye, EyeOff, KeyRound, Plus, RotateCcw, Save, Trash2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { api } from '../../api';
import type { SettingsPatch } from '../../api';
import { Button, Card, CardHeader, IconButton, Input, Textarea, TONE, useToast } from '../../components/ui';
import { cls } from '../../lib/cls';
import { useApp } from '../../lib/store';
import type { AppSettings, Tone } from '../../types';

/** What the backend puts in place of a secret value on every read (util.MASK). */
export const MASK = '••••';

/** Keys whose values the backend masks (SPEC §14): show them as passwords. */
const SECRET_KEY = /token|key|secret|password|auth|cookie|session|credential/i;
export const isSecretKey = (key: string) => SECRET_KEY.test(key);

type SectionKey = Exclude<keyof AppSettings, 'has_api_key'>;

/**
 * A local draft of one or more settings sections. It follows the server while untouched (another
 * admin, a backup import) and stops following once edited, so a live reload never eats typing.
 */
export function useSettingsDraft<K extends SectionKey>(keys: readonly K[]) {
  const { settings, reload } = useApp();
  const toast = useToast();
  const pick = useCallback((s: AppSettings | null) => {
    const out = {} as Pick<AppSettings, K>;
    if (s) for (const k of keys) out[k] = structuredClone(s[k]);
    return out;
    // keys is a literal per tab: stable for the component's life.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [draft, setDraft] = useState<Pick<AppSettings, K>>(() => pick(settings));
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!dirty) setDraft(pick(settings));
  }, [settings, dirty, pick]);

  const set = useCallback(<S extends K>(section: S, patch: Partial<AppSettings[S]>) => {
    setDraft((d) => ({ ...d, [section]: { ...d[section], ...patch } }));
    setDirty(true);
  }, []);

  const reset = useCallback(() => {
    setDraft(pick(settings));
    setDirty(false);
  }, [settings, pick]);

  /** Saves the draft; `build` may reshape it first (e.g. to add a secret typed elsewhere). */
  const save = useCallback(async (build?: (d: Pick<AppSettings, K>) => SettingsPatch) => {
    setSaving(true);
    try {
      await api.settings.update(build ? build(draft) : (draft as SettingsPatch));
      setDirty(false);
      await reload();
      toast.success('Settings saved.');
      return true;
    } catch (err) {
      toast.error(err);
      return false;
    } finally {
      setSaving(false);
    }
  }, [draft, reload, toast]);

  return { draft, set, dirty, reset, save, saving, ready: !!settings };
}

/** Sticky bar at the bottom of a settings form: appears highlighted once something changed. */
export function SaveBar({ dirty, saving, onSave, onReset, label = 'Save changes' }: {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  onReset: () => void;
  label?: string;
}) {
  return (
    <div className={cls(
      'sticky bottom-0 z-10 -mx-1 mt-6 flex items-center justify-end gap-2 rounded-xl border px-4 py-3 transition-colors surface-glass',
      dirty ? 'border-brand-500/40 shadow-brand' : 'hairline',
    )}>
      <p className="mr-auto text-xs text-muted">{dirty ? 'You have unsaved changes.' : 'All changes saved.'}</p>
      <Button variant="ghost" size="sm" icon={RotateCcw} disabled={!dirty || saving} onClick={onReset}>Discard</Button>
      <Button size="sm" icon={Save} busy={saving} disabled={!dirty} onClick={onSave}>{label}</Button>
    </div>
  );
}

/** A titled settings card. */
export function Section({ title, subtitle, icon, iconTone, actions, children, className, bodyClassName }: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: LucideIcon;
  iconTone?: Tone;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <Card padding="none" className={className}>
      <CardHeader title={title} subtitle={subtitle} icon={icon} iconTone={iconTone} actions={actions} />
      <div className={cls('p-5', bodyClassName)}>{children}</div>
    </Card>
  );
}

/** Small explanatory note (what a setting does, a trap to avoid). */
export function Note({ tone = 'zinc', icon: Icon, children, className }: {
  tone?: Tone;
  icon?: LucideIcon;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cls('flex items-start gap-2 rounded-lg px-3 py-2 text-xs ring-1 ring-inset', TONE[tone].soft, className)}>
      {Icon && <Icon size={14} className="mt-0.5 shrink-0" />}
      <div className="min-w-0 leading-relaxed">{children}</div>
    </div>
  );
}

/** Integer input that never emits NaN (empty → `fallback`). */
export function NumberInput({ value, onChange, min, max, step = 1, fallback = 0, className, id, disabled, suffix }: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  fallback?: number;
  className?: string;
  id?: string;
  disabled?: boolean;
  suffix?: string;
}) {
  const input = (
    <Input
      id={id}
      type="number"
      inputMode="decimal"
      value={Number.isFinite(value) ? value : ''}
      min={min}
      max={max}
      step={step}
      disabled={disabled}
      onChange={(e) => {
        const n = e.target.value === '' ? fallback : Number(e.target.value);
        onChange(Number.isFinite(n) ? n : fallback);
      }}
      className={cls('num', !suffix && className)}
    />
  );
  if (!suffix) return input;
  return (
    <div className={cls('flex items-center gap-2', className)}>
      {input}
      <span className="shrink-0 text-xs text-muted">{suffix}</span>
    </div>
  );
}

// ---- Key/value rows (env vars, HTTP headers) ---------------------------------------------------

export interface KvRow {
  key: string;
  value: string;
}

export const toRows = (map: Record<string, string> | null | undefined): KvRow[] =>
  Object.entries(map ?? {}).map(([key, value]) => ({ key, value }));

/** Rows → mapping (empty keys dropped, last duplicate wins). */
export function fromRows(rows: KvRow[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const r of rows) if (r.key.trim()) out[r.key.trim()] = r.value;
  return out;
}

/**
 * Editable key/value rows. Values under secret-looking keys are typed as passwords; a value the
 * server masked shows "•••• stored" and is sent back unchanged (= keep the stored secret) unless
 * the user chooses to replace it.
 */
export function KeyValueEditor({ rows, onChange, keyPlaceholder = 'NAME', valuePlaceholder = 'value', addLabel = 'Add variable' }: {
  rows: KvRow[];
  onChange: (rows: KvRow[]) => void;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  addLabel?: string;
}) {
  const [revealed, setRevealed] = useState<Set<number>>(new Set());
  const update = (i: number, patch: Partial<KvRow>) => onChange(rows.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  return (
    <div className="space-y-2">
      {rows.map((row, i) => {
        const secret = isSecretKey(row.key);
        const stored = row.value === MASK;
        const shown = revealed.has(i);
        return (
          <div key={i} className="flex items-center gap-2">
            <Input
              value={row.key}
              placeholder={keyPlaceholder}
              onChange={(e) => update(i, { key: e.target.value })}
              className="w-2/5 font-mono text-xs"
              aria-label="Name"
            />
            {stored ? (
              <div className="flex min-w-0 flex-1 items-center gap-2 rounded-lg border border-dashed px-3 py-1.5 text-xs text-muted hairline">
                <KeyRound size={13} className="shrink-0 text-brand-500" />
                <span className="flex-1 truncate">•••• stored</span>
                <button type="button" className="font-semibold text-brand-600 hover:underline dark:text-brand-400" onClick={() => update(i, { value: '' })}>
                  Replace
                </button>
              </div>
            ) : (
              <div className="relative min-w-0 flex-1">
                <Input
                  value={row.value}
                  type={secret && !shown ? 'password' : 'text'}
                  placeholder={valuePlaceholder}
                  autoComplete="off"
                  onChange={(e) => update(i, { value: e.target.value })}
                  className={cls('font-mono text-xs', secret && 'pr-9')}
                  aria-label="Value"
                />
                {secret && (
                  <button
                    type="button"
                    aria-label={shown ? 'Hide value' : 'Show value'}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200"
                    onClick={() => setRevealed((s) => {
                      const next = new Set(s);
                      if (next.has(i)) next.delete(i);
                      else next.add(i);
                      return next;
                    })}
                  >
                    {shown ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                )}
              </div>
            )}
            <IconButton icon={Trash2} label="Remove" size="sm" onClick={() => onChange(rows.filter((_, j) => j !== i))} />
          </div>
        );
      })}
      <Button size="xs" variant="outline" icon={Plus} onClick={() => onChange([...rows, { key: '', value: '' }])}>{addLabel}</Button>
    </div>
  );
}

/** Ordered list of strings (command arguments). */
export function ListEditor({ items, onChange, placeholder = 'value', addLabel = 'Add' }: {
  items: string[];
  onChange: (items: string[]) => void;
  placeholder?: string;
  addLabel?: string;
}) {
  return (
    <div className="space-y-2">
      {items.map((item, i) => (
        <div key={i} className="flex items-center gap-2">
          <span className="num w-5 shrink-0 text-right text-2xs text-faint">{i + 1}</span>
          <Input
            value={item}
            placeholder={placeholder}
            onChange={(e) => onChange(items.map((x, j) => (j === i ? e.target.value : x)))}
            className="font-mono text-xs"
          />
          <IconButton icon={Trash2} label="Remove" size="sm" onClick={() => onChange(items.filter((_, j) => j !== i))} />
        </div>
      ))}
      <Button size="xs" variant="outline" icon={Plus} onClick={() => onChange([...items, ''])}>{addLabel}</Button>
    </div>
  );
}

/** Parses a JSON object typed by a person; `error` explains what is wrong. */
export function parseJsonObject(text: string): { value: Record<string, unknown> | null; error: string } {
  if (!text.trim()) return { value: {}, error: '' };
  try {
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { value: null, error: 'Expected a JSON object: { … }' };
    return { value: parsed as Record<string, unknown>, error: '' };
  } catch (err) {
    return { value: null, error: err instanceof Error ? err.message : 'Invalid JSON' };
  }
}

export const prettyJson = (value: unknown) => JSON.stringify(value ?? {}, null, 2);

/** Monospace JSON textarea with live validation. */
export function JsonTextarea({ value, onChange, error, minRows = 4, placeholder = '{}' }: {
  value: string;
  onChange: (text: string) => void;
  error?: string;
  minRows?: number;
  placeholder?: string;
}) {
  return (
    <>
      <Textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        invalid={!!error}
        minRows={minRows}
        spellCheck={false}
        placeholder={placeholder}
        className="font-mono text-xs"
      />
      {error && <p className="mt-1 text-[11px] font-medium text-rose-600 dark:text-rose-400">{error}</p>}
    </>
  );
}

/** Toggleable chips (roles, teams, weekdays). */
export function ChipSelect<V extends string | number>({ options, value, onChange, emptyLabel }: {
  options: Array<{ value: V; label: string; tone?: Tone; title?: string }>;
  value: V[];
  onChange: (next: V[]) => void;
  emptyLabel?: string;
}) {
  const selected = useMemo(() => new Set(value), [value]);
  if (!options.length && emptyLabel) return <p className="text-xs text-faint">{emptyLabel}</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = selected.has(o.value);
        return (
          <button
            key={String(o.value)}
            type="button"
            title={o.title}
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((v) => v !== o.value) : [...value, o.value])}
            className={cls(
              'rounded-full px-2.5 py-1 text-xs font-medium ring-1 ring-inset transition-colors',
              on ? TONE[o.tone ?? 'brand'].soft : 'text-zinc-500 ring-zinc-300 hover:bg-zinc-50 dark:text-zinc-400 dark:ring-ink-500 dark:hover:bg-ink-700',
            )}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Segmented choice with an explanation per option. */
export function ChoiceCards<V extends string>({ options, value, onChange, columns = 3 }: {
  options: Array<{ value: V; label: string; description: ReactNode; icon?: LucideIcon; badge?: string }>;
  value: V;
  onChange: (value: V) => void;
  columns?: 2 | 3;
}) {
  return (
    <div className={cls('grid gap-3', columns === 3 ? 'sm:grid-cols-3' : 'sm:grid-cols-2')} role="radiogroup">
      {options.map((o) => {
        const on = o.value === value;
        const Icon = o.icon;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={on}
            onClick={() => onChange(o.value)}
            className={cls(
              'relative rounded-xl border p-4 text-left transition-all',
              on ? 'border-brand-500 bg-brand-500/5 ring-2 ring-brand-500/25' : 'hairline hover:border-zinc-300 dark:hover:border-ink-400',
            )}
          >
            <div className="flex items-center gap-2">
              {Icon && <Icon size={16} className={on ? 'text-brand-500' : 'text-zinc-400'} />}
              <span className="text-sm font-semibold text-zinc-900 dark:text-white">{o.label}</span>
              {o.badge && <span className="label-xs !text-brand-600 dark:!text-brand-400">{o.badge}</span>}
            </div>
            <p className="mt-1.5 text-xs leading-relaxed text-muted">{o.description}</p>
          </button>
        );
      })}
    </div>
  );
}

/** Saves a JSON value as a file download (backups, exports). */
export function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
