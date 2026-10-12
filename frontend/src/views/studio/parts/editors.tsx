// Reusable Studio editors: live-validated JSON, key → value mappings, tag/multi pickers, Jinja
// prompt fields with a "Variables" helper, and the FieldDef list editor (blueprint inputs, form
// fields, operation inputs). Monospace wherever the content is code or a template.
import {
  ArrowDown, ArrowUp, Braces, Check, ChevronDown, ChevronRight, Plus, Search, Trash2, Variable, X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { AiRewrite } from '../../../components/AiRewrite';
import {
  Badge, Button, Checkbox, Field, IconButton, Input, Popover, Select, Textarea, Tooltip,
} from '../../../components/ui';
import { cls } from '../../../lib/cls';
import type { FieldDef, FieldType } from '../../../types';
import { fingerprint, newField, slugify } from './model';
import type { VarGroup } from './model';

export const MONO = 'font-mono text-xs leading-relaxed';

// =============================================================================================
// JSON editor
// =============================================================================================

function pretty(value: unknown): string {
  if (value === null || value === undefined) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return '';
  }
}

/**
 * Textarea that parses JSON as you type: valid → onChange(parsed); invalid → inline error, the
 * last valid value is kept. Empty → `null` when `nullable`, else `{}`.
 */
export function JsonEditor({ value, onChange, nullable = false, expect = 'object', minRows = 4, maxRows = 16, placeholder, onValidity }: {
  value: unknown;
  onChange: (next: unknown) => void;
  nullable?: boolean;
  expect?: 'object' | 'any';
  minRows?: number;
  maxRows?: number;
  placeholder?: string;
  onValidity?: (ok: boolean) => void;
}) {
  const [text, setText] = useState(() => pretty(value));
  const [error, setError] = useState('');
  const last = useRef(fingerprint(value ?? null));

  // Resync when the value changes from outside (AI suggestion, reset, another step selected).
  useEffect(() => {
    const fp = fingerprint(value ?? null);
    if (fp !== last.current) {
      last.current = fp;
      setText(pretty(value));
      setError('');
    }
  }, [value]);

  const edit = (next: string) => {
    setText(next);
    if (!next.trim()) {
      const empty = nullable ? null : {};
      last.current = fingerprint(empty);
      setError('');
      onValidity?.(true);
      onChange(empty);
      return;
    }
    try {
      const parsed: unknown = JSON.parse(next);
      if (expect === 'object' && (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))) {
        throw new Error('Expected a JSON object ({ … })');
      }
      last.current = fingerprint(parsed);
      setError('');
      onValidity?.(true);
      onChange(parsed);
    } catch (err) {
      setError(err instanceof Error ? err.message.replace(/^JSON\.parse: /, '') : 'Invalid JSON');
      onValidity?.(false);
    }
  };

  const format = () => {
    try {
      setText(pretty(JSON.parse(text)));
    } catch {
      /* keep the text: the error is already shown */
    }
  };

  return (
    <div>
      <div className="relative">
        <Textarea
          value={text}
          onChange={(e) => edit(e.target.value)}
          onBlur={() => !error && format()}
          minRows={minRows}
          maxRows={maxRows}
          spellCheck={false}
          invalid={!!error}
          placeholder={placeholder ?? (nullable ? 'Empty = none' : '{ }')}
          className={MONO}
        />
        <span className={cls('pointer-events-none absolute right-2 top-2 inline-flex items-center gap-1 text-[10px] font-semibold',
          error ? 'text-rose-500' : 'text-emerald-600 dark:text-emerald-400')}>
          {error ? <X size={11} /> : text.trim() ? <Check size={11} /> : null}
          {error ? 'Invalid' : text.trim() ? 'Valid JSON' : ''}
        </span>
      </div>
      {error && <p className="mt-1 text-[11px] font-medium text-rose-600 dark:text-rose-400" role="alert">{error}</p>}
    </div>
  );
}

// =============================================================================================
// Variables helper
// =============================================================================================

/** "{x} Variables" button: lists the context a template may read; click inserts it. */
export function VariablesButton({ groups, onInsert, expression = false }: {
  groups: VarGroup[];
  onInsert: (text: string) => void;
  /** Insert a bare expression (`vars.x`) rather than `{{ vars.x }}`. */
  expression?: boolean;
}) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const query = q.trim().toLowerCase();
  const filtered = groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !query || i.path.toLowerCase().includes(query) || i.label.toLowerCase().includes(query)) }))
    .filter((g) => g.items.length || !query);
  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold text-brand-600 hover:bg-brand-500/10 dark:text-brand-400"
      >
        <Variable size={12} /> Variables
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} align="right" width={340}>
        <div className="border-b hairline p-2">
          <Input icon={Search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter variables…" className="text-xs" />
        </div>
        <div className="max-h-80 overflow-y-auto p-2">
          {filtered.map((g) => (
            <div key={g.title} className="mb-2 last:mb-0">
              <div className="label-xs px-1.5 pb-1">{g.title}</div>
              {g.hint && <p className="px-1.5 pb-1 text-[11px] text-faint">{g.hint}</p>}
              {g.items.length === 0 ? (
                <p className="px-1.5 text-[11px] italic text-faint">None available here</p>
              ) : g.items.map((item) => (
                <button
                  key={item.path}
                  type="button"
                  onClick={() => {
                    onInsert(expression ? item.path : `{{ ${item.path} }}`);
                    setOpen(false);
                  }}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left hover:bg-zinc-100 dark:hover:bg-ink-600"
                >
                  <code className="truncate font-mono text-[11px] text-brand-700 dark:text-brand-300">{item.path}</code>
                  <span className="truncate text-[11px] text-faint">{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
        <p className="border-t hairline px-3 py-2 text-[11px] text-faint">
          Jinja: <code className="font-mono">{'{{ vars.x }}'}</code>, filters <code className="font-mono">tojson · bullets · truncate_chars(n) · slug</code>.
          A value that is exactly one <code className="font-mono">{'{{ … }}'}</code> passes lists and objects natively.
        </p>
      </Popover>
    </>
  );
}

/** Inserts `text` at the caret of a textarea/input, returns the new value. */
function insertAt(el: HTMLTextAreaElement | HTMLInputElement | null, current: string, text: string): { value: string; caret: number } {
  if (!el) return { value: current + text, caret: current.length + text.length };
  const start = el.selectionStart ?? current.length;
  const end = el.selectionEnd ?? current.length;
  return { value: current.slice(0, start) + text + current.slice(end), caret: start + text.length };
}

/** Monospace Jinja template field with Variables helper and optional ✨ rewrite. */
export function TemplateField({ label, value, onChange, vars, help, placeholder, minRows = 4, maxRows = 18, rewrite = false, required, error }: {
  label: ReactNode;
  value: string;
  onChange: (next: string) => void;
  vars: VarGroup[];
  help?: ReactNode;
  placeholder?: string;
  minRows?: number;
  maxRows?: number;
  rewrite?: boolean;
  required?: boolean;
  error?: string;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const insert = (text: string) => {
    const { value: next, caret } = insertAt(ref.current, value, text);
    onChange(next);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(caret, caret);
    });
  };
  return (
    <Field
      label={label}
      help={help}
      required={required}
      error={error}
      aside={<>{rewrite && <AiRewrite value={value} onChange={onChange} />}<VariablesButton groups={vars} onInsert={insert} /></>}
    >
      <Textarea ref={ref} value={value} onChange={(e) => onChange(e.target.value)} minRows={minRows} maxRows={maxRows}
        spellCheck={false} placeholder={placeholder} className={MONO} invalid={!!error} />
    </Field>
  );
}

/** One-line Jinja expression / template input (items, when, until, extract…). */
export function ExprInput({ label, value, onChange, vars, help, placeholder, expression = true }: {
  label: ReactNode;
  value: string;
  onChange: (next: string) => void;
  vars?: VarGroup[];
  help?: ReactNode;
  placeholder?: string;
  expression?: boolean;
}) {
  const ref = useRef<HTMLInputElement | null>(null);
  const insert = (text: string) => {
    const { value: next, caret } = insertAt(ref.current, value, text);
    onChange(next);
    requestAnimationFrame(() => {
      ref.current?.focus();
      ref.current?.setSelectionRange(caret, caret);
    });
  };
  return (
    <Field label={label} help={help} aside={vars ? <VariablesButton groups={vars} onInsert={insert} expression={expression} /> : undefined}>
      <Input ref={ref} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} spellCheck={false} className={MONO} />
    </Field>
  );
}

// =============================================================================================
// Key → value mapping rows (operation input, fan-out inputs…)
// =============================================================================================

type Row = { id: number; key: string; text: string; json: boolean };
let rowSeq = 0;

function toRows(value: Record<string, unknown>): Row[] {
  return Object.entries(value ?? {}).map(([key, v]) => ({
    id: ++rowSeq, key, json: typeof v !== 'string', text: typeof v === 'string' ? v : JSON.stringify(v),
  }));
}

function fromRows(rows: Row[]): { value: Record<string, unknown>; error: string } {
  const out: Record<string, unknown> = {};
  let error = '';
  for (const r of rows) {
    const key = r.key.trim();
    if (!key) continue;
    if (r.json) {
      try {
        out[key] = r.text.trim() ? JSON.parse(r.text) : null;
      } catch {
        error = `"${key}": invalid JSON value`;
        out[key] = r.text;
      }
    } else out[key] = r.text;
  }
  return { value: out, error };
}

/**
 * Editable `{key: value}` object. String values are Jinja templates; a row switched to JSON holds a
 * literal (number, list, object). `suggestedKeys` adds one-click rows (the operation's inputs…).
 */
export function MappingEditor({ value, onChange, vars, suggestedKeys = [], keyLabel = 'Key', valueLabel = 'Value (Jinja)', keyPlaceholder = 'key', valuePlaceholder = '{{ vars.x }}', emptyLabel = 'No entries' }: {
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
  vars?: VarGroup[];
  suggestedKeys?: Array<{ key: string; label?: string; required?: boolean }>;
  keyLabel?: string;
  valueLabel?: string;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
  emptyLabel?: string;
}) {
  const [rows, setRows] = useState<Row[]>(() => toRows(value));
  const [error, setError] = useState('');
  const last = useRef(fingerprint(value ?? {}));
  const inputs = useRef<Record<number, HTMLInputElement | null>>({});

  useEffect(() => {
    const fp = fingerprint(value ?? {});
    if (fp !== last.current) {
      last.current = fp;
      setRows(toRows(value));
    }
  }, [value]);

  const commit = (next: Row[]) => {
    setRows(next);
    const { value: obj, error: err } = fromRows(next);
    setError(err);
    last.current = fingerprint(obj);
    onChange(obj);
  };
  const patch = (id: number, p: Partial<Row>) => commit(rows.map((r) => (r.id === id ? { ...r, ...p } : r)));
  const present = new Set(rows.map((r) => r.key.trim()));
  const missing = suggestedKeys.filter((s) => s.key && !present.has(s.key));

  return (
    <div className="space-y-1.5">
      {rows.length > 0 && (
        <div className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] gap-1.5 px-0.5">
          <span className="label-xs">{keyLabel}</span>
          <span className="label-xs">{valueLabel}</span>
          <span />
        </div>
      )}
      {rows.map((r) => (
        <div key={r.id} className="grid grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] items-center gap-1.5">
          <Input value={r.key} onChange={(e) => patch(r.id, { key: e.target.value })} placeholder={keyPlaceholder} className={cls(MONO, 'h-8')} />
          <Input
            ref={(el) => { inputs.current[r.id] = el; }}
            value={r.text}
            onChange={(e) => patch(r.id, { text: e.target.value })}
            placeholder={r.json ? '[1, 2] · {"a": 1} · 42 · true' : valuePlaceholder}
            className={cls(MONO, 'h-8')}
          />
          <div className="flex items-center">
            <Tooltip content={r.json ? 'Literal JSON value — click for a text/Jinja value' : 'Text/Jinja value — click for a literal JSON value'}>
              <button type="button" onClick={() => patch(r.id, { json: !r.json })}
                className={cls('grid h-7 w-7 place-items-center rounded-md', r.json ? 'bg-brand-500/10 text-brand-600 dark:text-brand-400' : 'text-faint hover:bg-zinc-100 dark:hover:bg-ink-600')}>
                <Braces size={13} />
              </button>
            </Tooltip>
            {vars && (
              <VariablesButtonCompact groups={vars} onInsert={(text) => {
                const el = inputs.current[r.id];
                const { value: next } = insertAt(el ?? null, r.text, text);
                patch(r.id, { text: next, json: false });
              }} />
            )}
            <IconButton icon={Trash2} label="Remove" size="xs" onClick={() => commit(rows.filter((x) => x.id !== r.id))} />
          </div>
        </div>
      ))}
      {rows.length === 0 && <p className="text-xs italic text-faint">{emptyLabel}</p>}
      {error && <p className="text-[11px] font-medium text-rose-600 dark:text-rose-400">{error}</p>}
      <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
        <Button size="xs" variant="outline" icon={Plus} onClick={() => commit([...rows, { id: ++rowSeq, key: '', text: '', json: false }])}>Add</Button>
        {missing.map((s) => (
          <button key={s.key} type="button" onClick={() => commit([...rows, { id: ++rowSeq, key: s.key, text: '', json: false }])}
            className="inline-flex items-center gap-1 rounded-full border border-dashed border-zinc-300 px-2 py-0.5 font-mono text-[11px] text-muted hover:border-brand-500 hover:text-brand-600 dark:border-ink-400 dark:hover:text-brand-400"
            title={s.label}>
            <Plus size={10} />{s.key}{s.required && <span className="text-brand-500">*</span>}
          </button>
        ))}
      </div>
    </div>
  );
}

function VariablesButtonCompact({ groups, onInsert }: { groups: VarGroup[]; onInsert: (text: string) => void }) {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  return (
    <>
      <button ref={anchor} type="button" onClick={() => setOpen((o) => !o)} title="Insert a variable"
        className="grid h-7 w-7 place-items-center rounded-md text-faint hover:bg-zinc-100 hover:text-brand-600 dark:hover:bg-ink-600">
        <Variable size={13} />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} align="right" width={300}>
        <div className="max-h-72 overflow-y-auto p-2">
          {groups.map((g) => (
            <div key={g.title} className="mb-2 last:mb-0">
              <div className="label-xs px-1.5 pb-1">{g.title}</div>
              {g.items.length === 0 && <p className="px-1.5 text-[11px] italic text-faint">None available here</p>}
              {g.items.map((item) => (
                <button key={item.path} type="button" onClick={() => { onInsert(`{{ ${item.path} }}`); setOpen(false); }}
                  className="flex w-full items-center justify-between gap-2 rounded-md px-1.5 py-1 text-left hover:bg-zinc-100 dark:hover:bg-ink-600">
                  <code className="truncate font-mono text-[11px] text-brand-700 dark:text-brand-300">{item.path}</code>
                  <span className="truncate text-[11px] text-faint">{item.label}</span>
                </button>
              ))}
            </div>
          ))}
        </div>
      </Popover>
    </>
  );
}

// =============================================================================================
// Tags & multi pickers
// =============================================================================================

/** Free-text chips (Enter or comma adds), with optional suggestions. */
export function TagInput({ value, onChange, suggestions = [], placeholder = 'Type and press Enter', mono = false }: {
  value: string[];
  onChange: (next: string[]) => void;
  suggestions?: string[];
  placeholder?: string;
  mono?: boolean;
}) {
  const [text, setText] = useState('');
  const listId = useMemo(() => `tags-${Math.random().toString(36).slice(2)}`, []);
  const add = (raw: string) => {
    const parts = raw.split(',').map((s) => s.trim()).filter(Boolean);
    if (!parts.length) return;
    onChange([...value, ...parts.filter((p) => !value.includes(p))]);
    setText('');
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      add(text);
    } else if (e.key === 'Backspace' && !text && value.length) onChange(value.slice(0, -1));
  };
  return (
    <div className="flex min-h-9 flex-wrap items-center gap-1 rounded-lg border border-zinc-300 bg-white px-1.5 py-1 focus-within:border-brand-500 focus-within:ring-2 focus-within:ring-brand-500/20 dark:border-ink-400 dark:bg-ink-800">
      {value.map((tag) => (
        <span key={tag} className={cls('inline-flex items-center gap-1 rounded-md bg-zinc-100 px-1.5 py-0.5 text-xs text-zinc-700 dark:bg-ink-600 dark:text-zinc-200', mono && 'font-mono')}>
          {tag}
          <button type="button" aria-label={`Remove ${tag}`} onClick={() => onChange(value.filter((t) => t !== tag))} className="text-faint hover:text-rose-500">
            <X size={11} />
          </button>
        </span>
      ))}
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onBlur={() => add(text)}
        list={suggestions.length ? listId : undefined}
        placeholder={value.length ? '' : placeholder}
        className={cls('min-w-[8rem] flex-1 bg-transparent px-1 py-0.5 text-sm outline-none placeholder:text-zinc-400', mono && 'font-mono text-xs')}
      />
      {suggestions.length > 0 && (
        <datalist id={listId}>{suggestions.filter((s) => !value.includes(s)).map((s) => <option key={s} value={s} />)}</datalist>
      )}
    </div>
  );
}

export interface PickOption {
  value: string;
  label: string;
  hint?: string;
  badge?: ReactNode;
  group?: string;
}

/** Chips of the selected options + a searchable checklist popover. Unknown values stay visible. */
export function MultiPick({ options, value, onChange, placeholder = 'Select…', emptyHint, mono = false }: {
  options: PickOption[];
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  /** Shown in the popover when there is nothing to choose from. */
  emptyHint?: ReactNode;
  mono?: boolean;
}) {
  const anchor = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const byValue = new Map(options.map((o) => [o.value, o]));
  const query = q.trim().toLowerCase();
  const shown = options.filter((o) => !query || o.label.toLowerCase().includes(query) || o.value.toLowerCase().includes(query));
  const toggle = (v: string) => onChange(value.includes(v) ? value.filter((x) => x !== v) : [...value, v]);
  let lastGroup = '';
  return (
    <>
      <div
        ref={anchor}
        role="button"
        tabIndex={0}
        onClick={() => setOpen(true)}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setOpen(true); } }}
        className="flex min-h-9 cursor-pointer flex-wrap items-center gap-1 rounded-lg border border-zinc-300 bg-white px-1.5 py-1 hover:border-zinc-400 dark:border-ink-400 dark:bg-ink-800"
      >
        {value.length === 0 && <span className="px-1 text-sm text-zinc-400">{placeholder}</span>}
        {value.map((v) => {
          const o = byValue.get(v);
          return (
            <span key={v} className={cls('inline-flex max-w-full items-center gap-1 rounded-md px-1.5 py-0.5 text-xs',
              o ? 'bg-brand-500/10 text-brand-700 dark:text-brand-300' : 'bg-amber-500/10 text-amber-700 dark:text-amber-300', mono && 'font-mono')}
              title={o ? o.hint : 'Not found — it may have been renamed or removed'}>
              <span className="truncate">{o?.label ?? v}</span>
              {o?.badge}
              <button type="button" aria-label="Remove" onClick={(e) => { e.stopPropagation(); toggle(v); }} className="opacity-60 hover:opacity-100">
                <X size={11} />
              </button>
            </span>
          );
        })}
        <ChevronDown size={14} className="ml-auto shrink-0 text-faint" />
      </div>
      <Popover anchor={anchor} open={open} onClose={() => { setOpen(false); setQ(''); }} width={Math.max(260, anchor.current?.offsetWidth ?? 260)}>
        {options.length > 8 && (
          <div className="border-b hairline p-2">
            <Input icon={Search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search…" className="text-xs" autoFocus />
          </div>
        )}
        <div className="max-h-72 overflow-y-auto p-1">
          {options.length === 0 && <div className="px-2.5 py-2 text-xs text-muted">{emptyHint ?? 'Nothing to choose from.'}</div>}
          {shown.map((o) => {
            const header = o.group && o.group !== lastGroup ? o.group : '';
            if (o.group) lastGroup = o.group;
            const on = value.includes(o.value);
            return (
              <div key={o.value}>
                {header && <div className="label-xs px-2.5 pb-1 pt-2">{header}</div>}
                <button type="button" onClick={() => toggle(o.value)}
                  className={cls('flex w-full items-start gap-2 rounded-md px-2.5 py-1.5 text-left text-sm hover:bg-zinc-100 dark:hover:bg-ink-600', on && 'bg-brand-500/5')}>
                  <span className={cls('mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border',
                    on ? 'border-brand-500 bg-brand-500 text-white' : 'border-zinc-300 dark:border-ink-400')}>
                    {on && <Check size={11} strokeWidth={3} />}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className={cls('flex items-center gap-1.5 truncate text-zinc-800 dark:text-zinc-100', mono && 'font-mono text-xs')}>{o.label}{o.badge}</span>
                    {o.hint && <span className="line-clamp-2 text-[11px] text-faint">{o.hint}</span>}
                  </span>
                </button>
              </div>
            );
          })}
        </div>
      </Popover>
    </>
  );
}

// =============================================================================================
// FieldDef list editor
// =============================================================================================

export const FIELD_TYPES: Array<{ value: FieldType; label: string }> = [
  { value: 'text', label: 'Text' }, { value: 'textarea', label: 'Long text' }, { value: 'markdown', label: 'Markdown' },
  { value: 'number', label: 'Number' }, { value: 'select', label: 'Select' }, { value: 'multiselect', label: 'Multi-select' },
  { value: 'date', label: 'Date' }, { value: 'user', label: 'User' }, { value: 'users', label: 'Users' },
  { value: 'team', label: 'Team' }, { value: 'checkbox', label: 'Checkbox' }, { value: 'list', label: 'List' },
  { value: 'url', label: 'URL' },
];

/** Ordered list of FieldDefs: compact rows that expand to the full definition. */
export function FieldDefsEditor({ fields, onChange, addLabel = 'Add field', emptyLabel = 'No fields yet.', keyPrefix = '' }: {
  fields: FieldDef[];
  onChange: (next: FieldDef[]) => void;
  addLabel?: string;
  emptyLabel?: string;
  /** Shown before keys ("inputs.") so admins see how templates read them. */
  keyPrefix?: string;
}) {
  const [open, setOpen] = useState<number | null>(null);
  const keys = fields.map((f) => f.key);
  const patch = (i: number, p: Partial<FieldDef>) => onChange(fields.map((f, j) => (j === i ? { ...f, ...p } : f)));
  const move = (i: number, d: -1 | 1) => {
    const j = i + d;
    if (j < 0 || j >= fields.length) return;
    const next = [...fields];
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
    setOpen((o) => (o === i ? j : o === j ? i : o));
  };
  const dupKeys = new Set(keys.filter((k, i) => k && keys.indexOf(k) !== i));
  return (
    <div className="space-y-1.5">
      {fields.length === 0 && <p className="text-xs italic text-faint">{emptyLabel}</p>}
      {fields.map((f, i) => {
        const expanded = open === i;
        const keyBad = !f.key || !/^[a-z][a-z0-9_]*$/.test(f.key) || dupKeys.has(f.key);
        return (
          <div key={i} className={cls('rounded-lg border', expanded ? 'border-brand-500/40 bg-brand-500/[0.03]' : 'hairline')}>
            <div className="flex items-center gap-1.5 px-2 py-1.5">
              <button type="button" onClick={() => setOpen(expanded ? null : i)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                {expanded ? <ChevronDown size={14} className="shrink-0 text-faint" /> : <ChevronRight size={14} className="shrink-0 text-faint" />}
                <span className="min-w-0 truncate text-sm font-medium text-zinc-800 dark:text-zinc-100">{f.label || <span className="italic text-faint">Untitled</span>}</span>
                <code className={cls('truncate font-mono text-[11px]', keyBad ? 'text-rose-500' : 'text-faint')}>{keyPrefix}{f.key || '?'}</code>
                <Badge size="xs" tone="zinc">{FIELD_TYPES.find((t) => t.value === f.type)?.label ?? f.type}</Badge>
                {f.required && <Badge size="xs" tone="brand">required</Badge>}
              </button>
              <IconButton icon={ArrowUp} label="Move up" size="xs" disabled={i === 0} onClick={() => move(i, -1)} />
              <IconButton icon={ArrowDown} label="Move down" size="xs" disabled={i === fields.length - 1} onClick={() => move(i, 1)} />
              <IconButton icon={Trash2} label="Remove field" size="xs" onClick={() => { onChange(fields.filter((_, j) => j !== i)); setOpen(null); }} />
            </div>
            {expanded && (
              <div className="grid gap-3 border-t hairline p-3 sm:grid-cols-2">
                <Field label="Label" required>
                  <Input value={f.label} autoFocus onChange={(e) => {
                    const label = e.target.value;
                    // Derive the key while it still follows the label (new fields).
                    const follows = !f.key || f.key === slugify(f.label) || /^field(_\d+)?$/.test(f.key);
                    patch(i, follows ? { label, key: slugify(label) || f.key } : { label });
                  }} />
                </Field>
                <Field label="Key" required error={dupKeys.has(f.key) ? 'Another field uses this key' : f.key && !/^[a-z][a-z0-9_]*$/.test(f.key) ? 'Lowercase slug (letters, digits, _)' : undefined}>
                  <Input value={f.key} onChange={(e) => patch(i, { key: e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_') })} className={MONO} />
                </Field>
                <Field label="Type">
                  <Select value={f.type} onChange={(e) => patch(i, { type: e.target.value as FieldType })} options={FIELD_TYPES} />
                </Field>
                <div className="flex items-end pb-2">
                  <Checkbox checked={f.required} onChange={(v) => patch(i, { required: v })} label="Required" />
                </div>
                {(f.type === 'select' || f.type === 'multiselect') && (
                  <Field label="Options" className="sm:col-span-2" help="Enter or comma to add each option">
                    <TagInput value={f.options} onChange={(options) => patch(i, { options })} />
                  </Field>
                )}
                <Field label="Help text" className="sm:col-span-2">
                  <Input value={f.help} onChange={(e) => patch(i, { help: e.target.value })} placeholder="Shown under the field" />
                </Field>
                <Field label="Placeholder" className="sm:col-span-2">
                  <Input value={f.placeholder} onChange={(e) => patch(i, { placeholder: e.target.value })} />
                </Field>
              </div>
            )}
          </div>
        );
      })}
      <Button size="xs" variant="outline" icon={Plus} onClick={() => { onChange([...fields, newField(keys)]); setOpen(fields.length); }}>{addLabel}</Button>
    </div>
  );
}

/** Section title inside inspectors/drawers. */
export function Section({ title, hint, children, actions, className }: {
  title: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <section className={cls('space-y-3', className)}>
      <div className="flex items-end justify-between gap-2">
        <div>
          <h3 className="label-xs">{title}</h3>
          {hint && <p className="mt-0.5 text-[11px] text-faint">{hint}</p>}
        </div>
        {actions}
      </div>
      {children}
    </section>
  );
}
