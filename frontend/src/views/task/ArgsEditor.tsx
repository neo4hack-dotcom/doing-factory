// Editable tool-call arguments for confirmations: one row per argument, strings as textareas, any
// other value (number, boolean, list, object) as JSON. The person sees exactly what will be sent
// and can correct it before the Factory calls the tool.
import { Braces, Plus, Trash2, Type } from 'lucide-react';
import { Button, IconButton, Input, Textarea } from '../../components/ui';
import { cls } from '../../lib/cls';
import type { ArgRow } from './logic';
import { newRowId } from './logic';

export function ArgsEditor({ rows, onChange, errors, disabled }: {
  rows: ArgRow[];
  onChange: (rows: ArgRow[]) => void;
  /** Error message by row id (from rowsToArgs). */
  errors: Record<string, string>;
  disabled?: boolean;
}) {
  const set = (id: string, patch: Partial<ArgRow>) => onChange(rows.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  const toggleMode = (row: ArgRow) => {
    if (row.mode === 'text') {
      set(row.id, { mode: 'json', text: JSON.stringify(row.text) });
      return;
    }
    // JSON → text: unwrap a JSON string, otherwise keep the source text as the string value.
    let text = row.text;
    try {
      const parsed: unknown = JSON.parse(row.text);
      if (typeof parsed === 'string') text = parsed;
    } catch {
      /* keep the raw text */
    }
    set(row.id, { mode: 'text', text });
  };

  return (
    <div className="space-y-2">
      {rows.length === 0 && <p className="text-xs text-faint">No arguments — the tool will be called without parameters.</p>}
      {rows.map((row) => {
        const err = errors[row.id];
        const multiline = row.mode === 'json' || row.text.length > 60 || row.text.includes('\n');
        return (
          <div key={row.id} className="grid gap-1.5 sm:grid-cols-[minmax(110px,180px)_1fr_auto] sm:items-start">
            <Input
              value={row.key}
              onChange={(e) => set(row.id, { key: e.target.value })}
              placeholder="name"
              aria-label="Argument name"
              disabled={disabled}
              className="h-8 font-mono text-xs"
            />
            <div className="min-w-0">
              {multiline ? (
                <Textarea
                  value={row.text}
                  onChange={(e) => set(row.id, { text: e.target.value })}
                  minRows={row.mode === 'json' ? 2 : 2}
                  maxRows={14}
                  spellCheck={row.mode === 'text'}
                  disabled={disabled}
                  invalid={!!err}
                  aria-label={`Value of ${row.key || 'argument'}`}
                  className={cls('text-xs', row.mode === 'json' && 'font-mono')}
                />
              ) : (
                <Input
                  value={row.text}
                  onChange={(e) => set(row.id, { text: e.target.value })}
                  disabled={disabled}
                  invalid={!!err}
                  aria-label={`Value of ${row.key || 'argument'}`}
                  className="h-8 text-xs"
                />
              )}
              {err && <p className="mt-1 text-[11px] text-rose-600 dark:text-rose-400">{err}</p>}
            </div>
            <div className="flex items-center gap-0.5">
              <IconButton
                icon={row.mode === 'json' ? Braces : Type}
                label={row.mode === 'json' ? 'JSON value — switch to plain text' : 'Plain text — switch to JSON (numbers, lists, objects)'}
                size="sm"
                active={row.mode === 'json'}
                disabled={disabled}
                onClick={() => toggleMode(row)}
              />
              <IconButton icon={Trash2} label="Remove argument" size="sm" disabled={disabled} onClick={() => onChange(rows.filter((r) => r.id !== row.id))} />
            </div>
          </div>
        );
      })}
      <Button
        variant="ghost"
        size="xs"
        icon={Plus}
        disabled={disabled}
        onClick={() => onChange([...rows, { id: newRowId(), key: '', mode: 'text', text: '' }])}
      >
        Add argument
      </Button>
    </div>
  );
}
