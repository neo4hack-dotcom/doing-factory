// Project page › Activity: the project's audit timeline (every decision, AI action, tool call and
// comment, newest first, live) with a comment box — comments are part of the tamper-evident trail.
import { AlertTriangle, MessageSquare, Send } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { api, errorMessage } from '../../api';
import { AiRewrite } from '../../components/AiRewrite';
import { Button, Card, EmptyState, Skeleton, Textarea, TONE, useToast } from '../../components/ui';
import { cls } from '../../lib/cls';
import { formatDateTime, timeAgo } from '../../lib/format';
import { useHotkeys, MOD_LABEL } from '../../lib/hotkeys';
import { useApp, useLive } from '../../lib/store';
import type { Event, Project } from '../../types';
import { ActorName, Callout } from '../task/common';
import { activityMeta } from '../task/meta';

const newestFirst = (a: Event, b: Event) => (b.ts || '').localeCompare(a.ts || '');

export function ActivityTab({ project, onOpenStep }: { project: Project; onOpenStep: (stepId: string) => void }) {
  const { userId } = useApp();
  const toast = useToast();
  const [events, setEvents] = useState<Event[] | null>(null);
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);

  const load = useCallback(async () => {
    try {
      setEvents((await api.projects.events(project.id)).sort(newestFirst));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    }
  }, [project.id]);
  useEffect(() => {
    void load();
  }, [load]);
  useLive('activity', (e) => {
    if (!e.event || e.event.project_id !== project.id) return;
    setEvents((prev) => (prev ? [e.event, ...prev.filter((x) => x.id !== e.event.id)].sort(newestFirst) : prev));
  });

  const stepName = (id: string) => project.stages.flatMap((s) => s.steps).find((s) => s.id === id)?.name ?? '';

  const post = async () => {
    const body = text.trim();
    if (!body || posting) return;
    setPosting(true);
    try {
      const ev = await api.projects.comment(project.id, userId, body);
      setEvents((prev) => [ev, ...(prev ?? []).filter((x) => x.id !== ev.id)].sort(newestFirst));
      setText('');
    } catch (err) {
      toast.error(err);
    } finally {
      setPosting(false);
    }
  };
  useHotkeys({ 'mod+enter': () => void post() }, !!text.trim());

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <Card padding="sm">
        <div className="flex items-center justify-between gap-2 pb-2">
          <span className="label-xs flex items-center gap-1.5"><MessageSquare size={12} />Comment</span>
          <AiRewrite value={text} onChange={setText} disabled={posting || !text.trim()} />
        </div>
        <Textarea value={text} onChange={(e) => setText(e.target.value)} minRows={2} placeholder="Share an update, ask a question, mention a decision…" aria-label="Comment" />
        <div className="mt-2 flex items-center justify-end gap-2">
          <span className="text-[11px] text-faint">{MOD_LABEL}+Enter to post</span>
          <Button size="sm" icon={Send} busy={posting} disabled={!text.trim()} onClick={() => void post()}>Post</Button>
        </div>
      </Card>

      {error ? (
        <Callout tone="rose" icon={AlertTriangle} title="Could not load the activity">{error}</Callout>
      ) : events === null ? (
        <div className="space-y-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-10 w-full" />)}</div>
      ) : events.length === 0 ? (
        <EmptyState icon={MessageSquare} title="No activity yet" description="Decisions, AI actions and comments appear here." />
      ) : (
        <ol className="relative space-y-0.5 before:absolute before:bottom-2 before:left-[15px] before:top-2 before:w-px before:bg-zinc-200 dark:before:bg-ink-600">
          {events.map((e) => {
            const m = activityMeta(e.kind);
            const comment = e.kind === 'comment.added';
            const commentText = comment ? (typeof e.data?.text === 'string' && e.data.text ? e.data.text : e.message) : '';
            return (
              <li key={e.id} className="relative flex gap-3 py-2 animate-fade-in">
                <span className={cls('relative z-[1] grid h-8 w-8 shrink-0 place-items-center rounded-full ring-4 ring-zinc-50 dark:ring-ink-950', TONE[m.tone].icon)}>
                  <m.icon size={14} />
                </span>
                <div className="min-w-0 flex-1 pt-1">
                  <div className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted">
                    <ActorName id={e.actor} size={16} className="text-zinc-800 dark:text-zinc-200" />
                    <span title={formatDateTime(e.ts)}>· {timeAgo(e.ts)}</span>
                    {e.step_id && stepName(e.step_id) && (
                      <button type="button" onClick={() => onOpenStep(e.step_id)} className="font-semibold text-brand-600 hover:underline dark:text-brand-400">· {stepName(e.step_id)}</button>
                    )}
                  </div>
                  {commentText ? (
                    <div className="mt-1 whitespace-pre-wrap rounded-lg border hairline bg-white px-3 py-2 text-sm text-zinc-800 dark:bg-ink-800 dark:text-zinc-100">{commentText}</div>
                  ) : (
                    <p className="mt-0.5 text-sm text-zinc-700 dark:text-zinc-200">{e.message}</p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
