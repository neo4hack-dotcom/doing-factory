// Renders a FieldDef[] (blueprint inputs, human_form steps, operation inputs) as controls — or as a
// read-only summary. Values are plain JSON (string, number, boolean, string[]), exactly what the
// backend stores in `step.form` / `project.inputs`. Fields still holding the AI draft are marked
// so a reviewer always knows what the model wrote and what a person confirmed.
import { Eye, Pencil, Plus, Sparkles, Trash2, X } from 'lucide-react';
import { useId, useState } from 'react';
import type { ReactNode } from 'react';
import { useApp } from '../lib/store';
import { cls } from '../lib/cls';
import { formatDate } from '../lib/format';
import type { FieldDef, FieldType } from '../types';
import { AiRewrite } from './AiRewrite';
import { Markdown, safeUrl } from './Markdown';
import { Avatar, Badge, Checkbox, Field, IconButton, Input, Select, Textarea } from './ui';

export type FormValue = Record<string, unknown>;

const ARRAY_TYPES: FieldType[] = ['multiselect', 'users', 'list'];
/** Types that take the full row; the others pair up two per row on wide screens. */
const WIDE_TYPES: FieldType[] = ['textarea', 'markdown', 'list', 'multiselect', 'users'];

/** null, '', whitespace, [] — and a list made only of blank rows (an untouched list editor). */
export function isEmptyValue(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  if (typeof v === 'string') return !v.trim();
  if (Array.isArray(v)) return v.every(isEmptyValue);
  return false;
}

function emptyFor(type: FieldType): unknown {
  if (ARRAY_TYPES.includes(type)) return [];
  if (type === 'checkbox') return false;
  return '';
}

/** Starting value for a form: existing values win, then field defaults, then a typed empty value. */
export function initialFormValue(fields: FieldDef[], current: FormValue = {}): FormValue {
  const out: FormValue = { ...current };
  for (const f of fields) {
    if (out[f.key] !== undefined && out[f.key] !== null) continue;
    out[f.key] = f.default !== undefined && f.default !== null ? f.default : emptyFor(f.type);
  }
  return out;
}

/** Client-side checks mirroring the backend (required, number, URL). Returns {key: message}. */
export function validateForm(fields: FieldDef[], value: FormValue): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const v = value[f.key];
    if (f.required && f.type !== 'checkbox' && isEmptyValue(v)) {
      errors[f.key] = 'Required';
      continue;
    }
    if (isEmptyValue(v)) continue;
    if (f.type === 'number' && !Number.isFinite(typeof v === 'number' ? v : Number(v))) errors[f.key] = 'Enter a number';
    if (f.type === 'url' && !/^https?:\/\/\S+$/i.test(String(v))) errors[f.key] = 'Enter a full URL (https://…)';
  }
  return errors;
}

/** What to send to the backend: blank list rows dropped, cleared numbers as null. */
export function normalizeFormValue(fields: FieldDef[], value: FormValue): FormValue {
  const out: FormValue = { ...value };
  for (const f of fields) {
    const v = out[f.key];
    if (f.type === 'list' && Array.isArray(v)) out[f.key] = v.map(String).map((x) => x.trim()).filter(Boolean);
    if (f.type === 'number' && v === '') out[f.key] = null;
  }
  return out;
}

function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const asString = (v: unknown) => (v === null || v === undefined ? '' : String(v));
const asArray = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : isEmptyValue(v) ? [] : [String(v)]);

export interface FormRendererProps {
  fields: FieldDef[];
  value: FormValue;
  onChange: (next: FormValue) => void;
  /** Renders a read-only summary instead of controls. */
  readOnly?: boolean;
  disabled?: boolean;
  /** Messages by field key (from validateForm or the backend). */
  errors?: Record<string, string>;
  /** The AI draft (`step.ai_draft`): fields whose value still equals it get an "AI draft" marker. */
  aiDraft?: Record<string, unknown> | null;
  /** 1 = every field full width; 2 (default) = short fields pair up on wide screens. */
  columns?: 1 | 2;
  className?: string;
}

export function FormRenderer({ fields, value, onChange, readOnly, disabled, errors = {}, aiDraft, columns = 2, className }: FormRendererProps) {
  const idPrefix = useId();
  const set = (key: string, v: unknown) => onChange({ ...value, [key]: v });

  if (fields.length === 0) return <p className="text-sm text-faint">This form has no fields.</p>;

  return (
    <div className={cls('grid gap-x-4 gap-y-4', columns === 2 && 'md:grid-cols-2', className)}>
      {fields.map((f) => {
        const v = value[f.key];
        const drafted = !!aiDraft && f.key in aiDraft && !isEmptyValue(v) && sameValue(aiDraft[f.key], v);
        const id = `${idPrefix}-${f.key}`;
        const wide = columns === 1 || WIDE_TYPES.includes(f.type);
        const aiBadge = drafted && <Badge tone="violet" size="xs" icon={Sparkles} title="Pre-filled by the AI — review before submitting">AI draft</Badge>;
        if (readOnly) {
          return (
            <div key={f.key} className={cls('min-w-0', wide && 'md:col-span-2')}>
              <div className="mb-1 flex items-center gap-2">
                <span className="label-xs">{f.label || f.key}</span>
                {aiBadge}
              </div>
              <ReadValue field={f} value={v} />
            </div>
          );
        }
        const longText = f.type === 'textarea' || f.type === 'markdown';
        return (
          <Field
            key={f.key}
            label={f.label || f.key}
            htmlFor={id}
            required={f.required}
            help={f.help}
            error={errors[f.key]}
            className={cls(wide && 'md:col-span-2')}
            aside={<>
              {aiBadge}
              {longText && !disabled && <AiRewrite value={asString(v)} onChange={(t) => set(f.key, t)} />}
            </>}
          >
            <div className={cls(drafted && 'rounded-lg ring-ai')}>
              <Control field={f} id={id} value={v} onChange={(nv) => set(f.key, nv)} disabled={disabled} invalid={!!errors[f.key]} />
            </div>
          </Field>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Editable controls
// ---------------------------------------------------------------------------------------------

function Control({ field: f, id, value, onChange, disabled, invalid }: {
  field: FieldDef;
  id: string;
  value: unknown;
  onChange: (v: unknown) => void;
  disabled?: boolean;
  invalid?: boolean;
}) {
  const { users, teams } = useApp();
  const common = { id, disabled, invalid };
  switch (f.type) {
    case 'textarea':
      return <Textarea {...common} value={asString(value)} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} />;
    case 'markdown':
      return <MarkdownEditor {...common} value={asString(value)} placeholder={f.placeholder} onChange={onChange} />;
    case 'number':
      return (
        <Input {...common} type="number" inputMode="decimal" value={asString(value)} placeholder={f.placeholder}
          onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
      );
    case 'date':
      return <Input {...common} type="date" value={asString(value).slice(0, 10)} onChange={(e) => onChange(e.target.value)} />;
    case 'url':
      return <Input {...common} type="url" value={asString(value)} placeholder={f.placeholder || 'https://'} onChange={(e) => onChange(e.target.value)} />;
    case 'select':
      return <Select {...common} value={asString(value)} placeholder={f.placeholder || 'Select…'} options={f.options} onChange={(e) => onChange(e.target.value)} />;
    case 'multiselect':
      return <ChipToggles options={f.options} value={asArray(value)} onChange={onChange} disabled={disabled} />;
    case 'checkbox':
      return <Checkbox checked={value === true} onChange={onChange} label={f.placeholder || 'Yes'} disabled={disabled} />;
    case 'user':
      return (
        <Select {...common} value={asString(value)} placeholder={f.placeholder || 'Select a person…'} onChange={(e) => onChange(e.target.value)}
          options={users.filter((u) => u.active || u.id === value).map((u) => ({ value: u.id, label: u.title ? `${u.name} — ${u.title}` : u.name }))} />
      );
    case 'users':
      return <UsersPicker value={asArray(value)} onChange={onChange} disabled={disabled} />;
    case 'team':
      return (
        <Select {...common} value={asString(value)} placeholder={f.placeholder || 'Select a team…'} onChange={(e) => onChange(e.target.value)}
          options={teams.map((t) => ({ value: t.id, label: t.name }))} />
      );
    case 'list':
      return <ListEditor value={asArray(value)} onChange={onChange} placeholder={f.placeholder} disabled={disabled} />;
    default:
      return <Input {...common} value={asString(value)} placeholder={f.placeholder} onChange={(e) => onChange(e.target.value)} />;
  }
}

function MarkdownEditor({ id, value, onChange, placeholder, disabled, invalid }: {
  id: string; value: string; onChange: (v: string) => void; placeholder?: string; disabled?: boolean; invalid?: boolean;
}) {
  const [preview, setPreview] = useState(false);
  return (
    <div className="space-y-1.5">
      <div className="flex gap-1">
        {([['write', 'Write', Pencil], ['preview', 'Preview', Eye]] as const).map(([key, label, Icon]) => (
          <button
            key={key}
            type="button"
            onClick={() => setPreview(key === 'preview')}
            className={cls('inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-semibold transition-colors',
              preview === (key === 'preview') ? 'bg-zinc-100 text-zinc-900 dark:bg-ink-600 dark:text-white' : 'text-zinc-500 hover:text-zinc-800 dark:hover:text-zinc-200')}
          >
            <Icon size={12} /> {label}
          </button>
        ))}
        <span className="ml-auto self-center text-[10px] text-faint">Markdown supported</span>
      </div>
      {preview ? (
        <div className="min-h-[84px] rounded-lg border border-zinc-200 p-3 dark:border-ink-500">
          {value.trim() ? <Markdown content={value} /> : <p className="text-sm text-faint">Nothing to preview.</p>}
        </div>
      ) : (
        <Textarea id={id} value={value} placeholder={placeholder} disabled={disabled} invalid={invalid} minRows={5}
          className="font-mono text-[13px]" onChange={(e) => onChange(e.target.value)} />
      )}
    </div>
  );
}

function ChipToggles({ options, value, onChange, disabled }: {
  options: string[]; value: string[]; onChange: (v: string[]) => void; disabled?: boolean;
}) {
  if (options.length === 0) return <p className="text-xs text-faint">No options configured for this field.</p>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {options.map((o) => {
        const on = value.includes(o);
        return (
          <button
            key={o}
            type="button"
            disabled={disabled}
            aria-pressed={on}
            onClick={() => onChange(on ? value.filter((x) => x !== o) : [...value, o])}
            className={cls('rounded-full border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50',
              on ? 'border-brand-500 bg-brand-500/10 text-brand-700 dark:text-brand-300'
                : 'border-zinc-300 text-zinc-600 hover:border-zinc-400 dark:border-ink-400 dark:text-zinc-300')}
          >
            {o}
          </button>
        );
      })}
    </div>
  );
}

function UsersPicker({ value, onChange, disabled }: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean }) {
  const { users, userById } = useApp();
  const remaining = users.filter((u) => u.active && !value.includes(u.id));
  return (
    <div className="space-y-2">
      {value.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {value.map((id) => {
            const u = userById(id);
            return (
              <span key={id} className="inline-flex items-center gap-1.5 rounded-full border border-zinc-200 py-0.5 pl-0.5 pr-1.5 text-xs dark:border-ink-500">
                <Avatar user={u} name={id} size={20} />
                <span className="font-medium">{u?.name ?? 'Unknown user'}</span>
                {!disabled && (
                  <button type="button" onClick={() => onChange(value.filter((x) => x !== id))} className="text-zinc-400 hover:text-rose-500" aria-label={`Remove ${u?.name ?? id}`}>
                    <X size={12} />
                  </button>
                )}
              </span>
            );
          })}
        </div>
      )}
      <Select
        value=""
        disabled={disabled || remaining.length === 0}
        placeholder={remaining.length ? 'Add a person…' : users.length ? 'Everyone is selected' : 'No users yet — add them in Settings › People & Teams'}
        options={remaining.map((u) => ({ value: u.id, label: u.title ? `${u.name} — ${u.title}` : u.name }))}
        onChange={(e) => e.target.value && onChange([...value, e.target.value])}
      />
    </div>
  );
}

function ListEditor({ value, onChange, placeholder, disabled }: {
  value: string[]; onChange: (v: string[]) => void; placeholder?: string; disabled?: boolean;
}) {
  const rows = value.length ? value : [''];
  const update = (i: number, text: string) => onChange(rows.map((r, j) => (j === i ? text : r)));
  return (
    <div className="space-y-1.5">
      {rows.map((row, i) => (
        <div key={i} className="flex items-center gap-1.5">
          <span className="num w-5 shrink-0 text-right text-[11px] text-faint">{i + 1}.</span>
          <Input
            value={row}
            placeholder={placeholder || 'Item'}
            disabled={disabled}
            onChange={(e) => update(i, e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                if (row.trim()) onChange([...rows.slice(0, i + 1), '', ...rows.slice(i + 1)]);
              }
            }}
          />
          <IconButton icon={Trash2} label="Remove item" size="sm" disabled={disabled || (rows.length === 1 && !row)}
            onClick={() => onChange(rows.filter((_, j) => j !== i))} />
        </div>
      ))}
      <button type="button" disabled={disabled} onClick={() => onChange([...rows, ''])}
        className="ml-6 inline-flex items-center gap-1 text-xs font-semibold text-brand-600 hover:underline disabled:opacity-50 dark:text-brand-400">
        <Plus size={13} /> Add item
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Read-only values
// ---------------------------------------------------------------------------------------------

function ReadValue({ field: f, value }: { field: FieldDef; value: unknown }) {
  const { userById, teamById } = useApp();
  const none = <span className="text-sm text-faint">—</span>;
  if (f.type === 'checkbox') return <span className="text-sm">{value === true ? 'Yes' : 'No'}</span>;
  if (isEmptyValue(value)) return none;
  const text = asString(value);
  let node: ReactNode;
  switch (f.type) {
    case 'markdown':
      node = <Markdown content={text} />;
      break;
    case 'textarea':
      node = <p className="whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">{text}</p>;
      break;
    case 'date':
      node = <span className="text-sm">{formatDate(text)}</span>;
      break;
    case 'url':
      node = <a href={safeUrl(text)} target="_blank" rel="noopener noreferrer" className="break-all text-sm font-medium text-brand-600 hover:underline dark:text-brand-400">{text}</a>;
      break;
    case 'select':
      node = <Badge>{text}</Badge>;
      break;
    case 'multiselect':
      node = <div className="flex flex-wrap gap-1">{asArray(value).map((o) => <Badge key={o}>{o}</Badge>)}</div>;
      break;
    case 'user': {
      const u = userById(text);
      node = <span className="inline-flex items-center gap-2 text-sm"><Avatar user={u} name={text} size={22} />{u?.name ?? 'Unknown user'}</span>;
      break;
    }
    case 'users':
      node = (
        <div className="flex flex-wrap gap-2">
          {asArray(value).map((id) => {
            const u = userById(id);
            return <span key={id} className="inline-flex items-center gap-1.5 text-sm"><Avatar user={u} name={id} size={20} />{u?.name ?? 'Unknown user'}</span>;
          })}
        </div>
      );
      break;
    case 'team':
      node = <span className="text-sm">{teamById(text)?.name ?? 'Unknown team'}</span>;
      break;
    case 'list':
      node = <ul className="list-disc space-y-0.5 pl-5 text-sm marker:text-zinc-400">{asArray(value).filter((x) => x.trim()).map((x, i) => <li key={i}>{x}</li>)}</ul>;
      break;
    default:
      node = <span className="whitespace-pre-wrap text-sm text-zinc-800 dark:text-zinc-200">{text}</span>;
  }
  return <div className="min-w-0">{node}</div>;
}
