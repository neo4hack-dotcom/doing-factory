// Prompts (#/studio/prompts): the system prompts behind every AI role. The defaults ship with the
// Factory; an edit is stored as an override (and follows nothing anymore), Reset deletes it. A
// line diff against the default shows exactly what was customised.
import { GitCompare, MessageSquareText, RotateCcw, Save, Search } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import {
  Badge, Button, Card, EmptyState, Input, Kbd, SectionHeader, Skeleton, Textarea, Toggle, cls, useBusy, useConfirm, useToast,
} from '../../components/ui';
import { plural, timeAgo } from '../../lib/format';
import { MOD_LABEL, useHotkeys } from '../../lib/hotkeys';
import { usePageTitle } from '../../lib/pageTitle';
import type { PromptDef } from '../../types';
import { LineDiff } from './parts/LineDiff';
import { useUnsavedGuard } from './parts/session';

const isCustom = (p: PromptDef) => p.content !== p.default_content;

export default function Prompts() {
  usePageTitle('Prompts');
  const toast = useToast();
  const confirm = useConfirm();
  const [busy, run] = useBusy();
  const [prompts, setPrompts] = useState<PromptDef[] | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState('');
  const [text, setText] = useState('');
  const [showDiff, setShowDiff] = useState(false);
  const [q, setQ] = useState('');

  useEffect(() => {
    api.prompts.list()
      .then((list) => {
        setPrompts(list);
        if (list.length) {
          setSelected(list[0].key);
          setText(list[0].content);
        }
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const current = prompts?.find((p) => p.key === selected) ?? null;
  const dirty = !!current && text !== current.content;
  useUnsavedGuard(dirty, 'This prompt has unsaved changes. Leave without saving?');

  const query = q.trim().toLowerCase();
  const shown = useMemo(() => (prompts ?? []).filter((p) => !query || [p.key, p.name, p.description].some((v) => v.toLowerCase().includes(query))), [prompts, query]);
  const customCount = (prompts ?? []).filter(isCustom).length;

  const replace = (next: PromptDef) => {
    setPrompts((list) => (list ?? []).map((p) => (p.key === next.key ? next : p)));
    setText(next.content);
  };

  const pick = async (p: PromptDef) => {
    if (p.key === selected) return;
    if (dirty && !(await confirm({ title: 'Discard unsaved changes?', message: `Your edits to “${current?.name}” will be lost.`, tone: 'warning', confirmLabel: 'Discard' }))) return;
    setSelected(p.key);
    setText(p.content);
  };

  const save = () => run('save', async () => {
    if (!current || !dirty) return;
    const next = await api.prompts.update(current.key, text);
    replace(next);
    toast.success(isCustom(next) ? `“${next.name}” saved` : `“${next.name}” matches the default again — it follows future improvements`);
  });

  const reset = () => run('reset', async () => {
    if (!current) return;
    if (!(await confirm({
      title: `Reset “${current.name}” to its default?`,
      message: 'Your customised version is deleted; the prompt follows the built-in default again.',
      tone: 'warning', confirmLabel: 'Reset to default',
    }))) return;
    const next = await api.prompts.reset(current.key);
    replace(next);
    toast.success(`“${next.name}” reset to default`);
  });

  useHotkeys({ 'mod+s': () => { if (dirty) void save(); } }, dirty);

  return (
    <>
      <SectionHeader
        eyebrow="Studio"
        icon={MessageSquareText}
        title="Prompts"
        description="The system prompts behind every AI role — spec writer, Jira writer, compliance reviewer, copilot… Tune the voice and rules of your Factory; reset any time."
      />

      {error ? (
        <EmptyState icon={MessageSquareText} title="Cannot load the prompts" description={error} />
      ) : !prompts ? (
        <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]"><Skeleton className="h-96" /><Skeleton className="h-96" /></div>
      ) : prompts.length === 0 ? (
        <EmptyState icon={MessageSquareText} title="No prompt registered" description="The backend reported no AI prompt." />
      ) : (
        <div className="grid gap-4 lg:grid-cols-[20rem_minmax(0,1fr)]">
          <Card padding="none" className="flex max-h-[calc(100vh-12rem)] flex-col overflow-hidden lg:sticky lg:top-4">
            <div className="space-y-2 border-b hairline p-3">
              <Input icon={Search} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search prompts…" />
              <p className="text-[11px] text-muted">{plural(prompts.length, 'prompt')} · {customCount} customised</p>
            </div>
            <ul className="flex-1 overflow-y-auto p-1.5">
              {shown.map((p) => (
                <li key={p.key}>
                  <button type="button" onClick={() => void pick(p)}
                    className={cls('w-full rounded-lg px-3 py-2 text-left transition-colors',
                      p.key === selected ? 'bg-brand-500/10' : 'hover:bg-zinc-100 dark:hover:bg-ink-700')}>
                    <div className="flex items-center gap-1.5">
                      <span className={cls('truncate text-sm font-semibold', p.key === selected ? 'text-brand-700 dark:text-brand-300' : 'text-zinc-800 dark:text-zinc-100')}>{p.name}</span>
                      {isCustom(p) && <Badge size="xs" tone="violet">custom</Badge>}
                      {p.key === selected && dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" title="Unsaved" />}
                    </div>
                    <code className="block truncate font-mono text-[10.5px] text-faint">{p.key}</code>
                    {p.description && <p className="mt-0.5 line-clamp-2 text-[11px] text-muted">{p.description}</p>}
                  </button>
                </li>
              ))}
              {shown.length === 0 && <li className="px-3 py-6 text-center text-xs text-muted">No prompt matches.</li>}
            </ul>
          </Card>

          {current && (
            <Card padding="none" className="min-w-0">
              <div className="flex flex-wrap items-start justify-between gap-3 border-b hairline px-5 py-4">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h2 className="truncate text-base font-bold text-zinc-900 dark:text-white">{current.name}</h2>
                    {isCustom(current) ? <Badge tone="violet">custom</Badge> : <Badge tone="zinc">default</Badge>}
                  </div>
                  <code className="font-mono text-[11px] text-faint">{current.key}</code>
                  {current.description && <p className="mt-1 max-w-2xl text-xs text-muted">{current.description}</p>}
                  {isCustom(current) && current.updated_at && <p className="mt-1 text-[11px] text-faint">Customised {timeAgo(current.updated_at)}</p>}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Toggle size="sm" checked={showDiff} onChange={setShowDiff} label="Diff vs default" />
                  <Button variant="outline" icon={RotateCcw} busy={busy === 'reset'} disabled={!isCustom(current) || !current.default_content} onClick={() => void reset()}>Reset to default</Button>
                  <Button icon={Save} busy={busy === 'save'} disabled={!dirty || !text.trim()} onClick={() => void save()}>
                    Save <Kbd className="ml-1 hidden opacity-70 lg:inline-flex">{MOD_LABEL}S</Kbd>
                  </Button>
                </div>
              </div>
              <div className="space-y-3 p-5">
                {showDiff ? (
                  <LineDiff before={current.default_content} after={text} />
                ) : (
                  <Textarea value={text} onChange={(e) => setText(e.target.value)} minRows={18} maxRows={40} spellCheck={false}
                    className="font-mono text-xs leading-relaxed" aria-label={`${current.name} prompt`} />
                )}
                <div className="flex flex-wrap items-center justify-between gap-2 text-[11px] text-faint">
                  <span className="num">{text.length.toLocaleString()} characters · {text.split('\n').length} lines</span>
                  {dirty && (
                    <span className="inline-flex items-center gap-2">
                      <span className="font-semibold text-amber-600 dark:text-amber-400">Unsaved changes</span>
                      <button type="button" onClick={() => setText(current.content)} className="font-semibold text-muted hover:text-zinc-800 dark:hover:text-zinc-100">Revert</button>
                    </span>
                  )}
                  {showDiff && <span className="inline-flex items-center gap-1"><GitCompare size={12} />Turn the diff off to edit</span>}
                </div>
              </div>
            </Card>
          )}
        </div>
      )}
    </>
  );
}
