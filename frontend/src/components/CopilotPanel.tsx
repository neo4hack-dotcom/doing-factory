// "Ask the Factory" copilot drawer. The shell renders <CopilotPanel open question projectId onClose />
// from the store's `copilot` state: `question` is sent as soon as the drawer opens (⌘K "Ask Factory",
// KPI insights…), `projectId` scopes the conversation to one project. Answers come from POST
// /api/copilot (the model only sees read-only portfolio tools); `copilot.progress` events show what it
// is doing meanwhile. A new chat gets a client-chosen id so progress can be followed from the first
// question. The current chat id survives reloads (localStorage); a failure keeps the question so it
// can be retried — nothing is invented when no model is configured.
import {
  AlertTriangle, ArrowUp, Bot, FolderOpen, MessageSquarePlus, Settings2, Sparkles, Wrench, X,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, errorMessage } from '../api';
import { cls } from '../lib/cls';
import { formatTime, humanize, truncate } from '../lib/format';
import { navigate, paths } from '../lib/router';
import { useApp, useLive } from '../lib/store';
import { readStorage, writeStorage } from '../lib/storage';
import type { ChatMessage } from '../types';
import { Markdown } from './Markdown';
import { Button, CopyButton, Drawer, IconButton, Textarea, Tooltip } from './ui';

export interface CopilotPanelProps {
  open: boolean;
  onClose: () => void;
  /** Question to ask immediately ('' = none). */
  question: string;
  /** Project the conversation is about ('' = whole portfolio). */
  projectId: string;
}

const CHAT_KEY = 'factory.copilot.chat';

const PORTFOLIO_SUGGESTIONS = [
  'What needs my attention?',
  'Which projects are at risk and why?',
  'Summarize a project for its sponsor',
  'Where are the bottlenecks?',
];
const PROJECT_SUGGESTIONS = [
  'Summarize this project for its sponsor',
  'What is blocking this project, and who can unblock it?',
  'What are the next steps and who owns them?',
  'Which compliance findings are still open?',
];

/** `chat_` + 16 letters/digits — the shape the backend accepts for a client-chosen chat id. */
function newChatId(): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `chat_${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')}`;
}

export function CopilotPanel({ open, onClose, question, projectId }: CopilotPanelProps) {
  const { userId, settings } = useApp();
  const [chatId, setChatId] = useState(() => readStorage(CHAT_KEY) ?? '');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [scope, setScope] = useState('');
  const [scopeLabel, setScopeLabel] = useState('');
  const [pending, setPending] = useState<string | null>(null);
  const [progress, setProgress] = useState('');
  const [error, setError] = useState<{ message: string; question: string } | null>(null);
  const [input, setInput] = useState('');
  const pendingId = useRef('');
  const bottom = useRef<HTMLDivElement>(null);
  const llmReady = !!settings?.llm.base_url;

  // Restore the persisted conversation once.
  useEffect(() => {
    const id = readStorage(CHAT_KEY);
    if (!id) return;
    api.copilot.get(id)
      .then((chat) => {
        // A question sent meanwhile already returned the full conversation: keep that.
        setMessages((cur) => (cur.length ? cur : chat.messages));
        setScope((s) => s || chat.project_id);
      })
      .catch(() => {
        writeStorage(CHAT_KEY, null);
        setChatId('');
      });
  }, []);

  const rememberChat = (id: string) => {
    setChatId(id);
    writeStorage(CHAT_KEY, id || null);
  };

  const newChat = useCallback((nextScope = '') => {
    rememberChat('');
    setMessages([]);
    setScope(nextScope);
    setError(null);
    setProgress('');
    pendingId.current = '';
    setPending(null);
  }, []);

  const send = useCallback(async (text: string, opts: { chat?: string; scope?: string } = {}) => {
    const message = text.trim();
    if (!message || pendingId.current) return;
    const id = (opts.chat ?? chatId) || newChatId();
    const projectScope = opts.scope ?? scope;
    pendingId.current = id;
    setPending(message);
    setProgress('Thinking…');
    setError(null);
    setInput('');
    try {
      const reply = await api.copilot.send({ user_id: userId, message, chat_id: id, project_id: projectScope || undefined });
      rememberChat(reply.chat_id);
      setMessages(reply.messages);
    } catch (err) {
      setError({ message: errorMessage(err), question: message });
      setInput((cur) => cur || message);
    } finally {
      pendingId.current = '';
      setPending(null);
      setProgress('');
    }
  }, [chatId, scope, userId]);

  // Opening with a project and/or a question: scope the conversation, then ask.
  const handled = useRef('');
  useEffect(() => {
    if (!open) {
      handled.current = '';
      return;
    }
    const signature = `${projectId}\u0000${question}`;
    if (handled.current === signature) return;
    handled.current = signature;
    let chat = chatId;
    let target = scope;
    if (projectId && projectId !== scope) {
      // A different project = a different conversation (the backend pins a chat to its project).
      newChat(projectId);
      chat = '';
      target = projectId;
    }
    if (question) void send(question, { chat, scope: target });
  }, [open, question, projectId, chatId, scope, newChat, send]);

  // Label of the scoped project (key · title).
  useEffect(() => {
    if (!scope) {
      setScopeLabel('');
      return;
    }
    let live = true;
    api.projects.get(scope)
      .then((p) => live && setScopeLabel(`${p.key} · ${p.title}`))
      .catch(() => live && setScopeLabel(scope));
    return () => { live = false; };
  }, [scope]);

  useLive('copilot.progress', (e) => {
    if (e.chat_id === pendingId.current && e.text !== 'Done') setProgress(e.text);
  });

  useEffect(() => {
    if (open) bottom.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }, [open, messages, pending, progress, error]);

  const goTo = (pid: string) => {
    onClose();
    navigate(paths.project(pid));
  };

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send(input);
    }
  };

  const empty = messages.length === 0 && !pending;
  const suggestions = scope ? PROJECT_SUGGESTIONS : PORTFOLIO_SUGGESTIONS;

  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={<span className="flex items-center gap-1.5">Ask the <span className="text-ai">Factory</span></span>}
      subtitle={scope ? 'Copilot scoped to one project' : `Copilot over the whole portfolio${settings?.llm.model ? ` · ${settings.llm.model}` : ''}`}
      icon={Bot}
      width="lg"
      actions={<IconButton icon={MessageSquarePlus} label="New chat" onClick={() => newChat('')} disabled={!!pending} />}
    >
      <div className="flex h-full flex-col">
        {scope && (
          <div className="flex items-center gap-2 border-b hairline bg-brand-50/50 px-5 py-2 dark:bg-brand-500/5">
            <span className="label-xs">About</span>
            <span className="inline-flex min-w-0 items-center gap-1.5 rounded-full border border-brand-500/30 bg-white px-2 py-0.5 text-xs font-semibold text-brand-700 dark:bg-ink-800 dark:text-brand-300">
              <FolderOpen size={12} className="shrink-0" />
              <button type="button" className="truncate hover:underline" onClick={() => goTo(scope)}>{scopeLabel || '…'}</button>
              <Tooltip content="Leave this project: start a portfolio-wide chat">
                <button type="button" aria-label="Remove project scope" onClick={() => newChat('')} disabled={!!pending} className="shrink-0 rounded-full p-0.5 hover:bg-brand-500/10">
                  <X size={11} />
                </button>
              </Tooltip>
            </span>
          </div>
        )}

        {!llmReady && (
          <div className="mx-5 mt-4 flex items-start gap-2.5 rounded-lg border border-amber-500/30 bg-amber-50 p-3 text-xs text-amber-800 dark:bg-amber-500/10 dark:text-amber-300">
            <AlertTriangle size={15} className="mt-px shrink-0" />
            <div className="flex-1">
              <div className="font-semibold">No AI model configured</div>
              The copilot answers with a local LLM. Point the Factory at Ollama, LM Studio or another OpenAI-compatible server first.
            </div>
            <Button size="xs" variant="outline" icon={Settings2} onClick={() => { onClose(); navigate(paths.settings('ai')); }}>Configure</Button>
          </div>
        )}

        <div className="flex-1 space-y-5 px-5 py-5">
          {empty && (
            <div className="flex flex-col items-center pt-6 text-center animate-fade-in">
              <span className="btn-ai grid h-12 w-12 place-items-center rounded-2xl"><Sparkles size={22} /></span>
              <h3 className="mt-3 text-base font-semibold text-zinc-900 dark:text-white">
                {scope ? 'Ask about this project' : 'Ask anything about the factory'}
              </h3>
              <p className="mt-1 max-w-sm text-sm text-muted">
                Projects, approvals, risks, KPIs and intake — answered from live data, with links to the projects cited.
              </p>
              <div className="mt-5 grid w-full gap-2 sm:grid-cols-2">
                {suggestions.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={!llmReady}
                    onClick={() => void send(s)}
                    className="rounded-xl border hairline bg-white px-3 py-2.5 text-left text-sm font-medium text-zinc-700 transition-colors hover:border-brand-500/60 hover:text-brand-700 disabled:opacity-50 dark:bg-ink-800 dark:text-zinc-200 dark:hover:text-brand-300"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map((m, i) => <Message key={`${m.ts}-${i}`} m={m} onProject={goTo} />)}

          {pending && (
            <>
              <UserBubble text={pending} />
              <div className="flex items-start gap-2.5 animate-fade-in">
                <span className="btn-ai grid h-7 w-7 shrink-0 place-items-center rounded-lg shadow-none"><Bot size={14} /></span>
                <div className="flex items-center gap-2 rounded-xl border hairline bg-zinc-50 px-3 py-2 text-xs text-muted dark:bg-ink-800">
                  <span className="flex gap-1" aria-hidden>
                    {[0, 150, 300].map((d) => (
                      <span key={d} className="h-1.5 w-1.5 animate-bounce rounded-full bg-brand-500" style={{ animationDelay: `${d}ms` }} />
                    ))}
                  </span>
                  <span className="truncate">{progress || 'Thinking…'}</span>
                </div>
              </div>
            </>
          )}

          {error && (
            <div className="flex items-start gap-2.5 rounded-lg border border-rose-500/25 bg-rose-50 p-3 text-xs text-rose-700 animate-fade-in dark:bg-rose-500/10 dark:text-rose-300">
              <AlertTriangle size={15} className="mt-px shrink-0" />
              <div className="min-w-0 flex-1">
                <div className="font-semibold">The copilot could not answer</div>
                <div className="mt-0.5 break-words">{error.message}</div>
              </div>
              <Button size="xs" variant="outline" onClick={() => void send(error.question)}>Retry</Button>
            </div>
          )}
          <div ref={bottom} />
        </div>

        <div className="sticky bottom-0 border-t hairline bg-white px-4 py-3 dark:bg-ink-900">
          <div className="flex items-end gap-2 rounded-xl border hairline bg-zinc-50 p-1.5 focus-within:border-brand-500/60 dark:bg-ink-800">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={onKey}
              placeholder={scope ? 'Ask about this project…' : 'Ask the Factory…'}
              minRows={1}
              maxRows={6}
              aria-label="Your question"
              className="flex-1 !border-0 !bg-transparent !shadow-none focus:!ring-0"
            />
            <IconButton
              icon={ArrowUp}
              label="Send (Enter)"
              variant="primary"
              busy={!!pending}
              disabled={!input.trim() || !!pending}
              onClick={() => void send(input)}
            />
          </div>
          <p className="mt-1.5 px-1 text-[10.5px] text-faint">Enter to send · Shift+Enter for a new line · answers use read-only tools</p>
        </div>
      </div>
    </Drawer>
  );
}

function UserBubble({ text, ts }: { text: string; ts?: string }) {
  return (
    <div className="flex justify-end animate-fade-in">
      <div className="max-w-[85%]">
        <div className="whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-brand-500 px-3.5 py-2 text-sm text-white">{text}</div>
        {ts && <div className="num mt-1 text-right text-[10px] text-faint">{formatTime(ts)}</div>}
      </div>
    </div>
  );
}

function Message({ m, onProject }: { m: ChatMessage; onProject: (projectId: string) => void }) {
  if (m.role === 'user') return <UserBubble text={m.content} ts={m.ts} />;
  return (
    <div className="group flex items-start gap-2.5 animate-fade-in">
      <span className="btn-ai grid h-7 w-7 shrink-0 place-items-center rounded-lg shadow-none"><Bot size={14} /></span>
      <div className="min-w-0 flex-1">
        {m.tool_calls.length > 0 && (
          <div className="mb-1.5 flex flex-wrap gap-1">
            {m.tool_calls.map((t, i) => (
              <Tooltip key={i} content={Object.keys(t.args).length ? truncate(JSON.stringify(t.args), 160) : humanize(t.name)}>
                <span className="inline-flex max-w-[260px] items-center gap-1 rounded-md bg-zinc-100 px-1.5 py-0.5 text-[10.5px] font-medium text-zinc-600 dark:bg-ink-700 dark:text-zinc-300">
                  <Wrench size={10} className="shrink-0 text-brand-500" />
                  <span className="truncate">{t.summary || humanize(t.name)}</span>
                </span>
              </Tooltip>
            ))}
          </div>
        )}
        <div className="rounded-2xl rounded-tl-md border hairline bg-white px-3.5 py-2.5 dark:bg-ink-800">
          <Markdown content={m.content} />
        </div>
        {m.links.length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {m.links.map((l) => (
              <button
                key={l.project_id}
                type="button"
                onClick={() => onProject(l.project_id)}
                className="inline-flex max-w-full items-center gap-1 rounded-full border border-brand-500/30 bg-brand-50 px-2 py-0.5 text-[11px] font-semibold text-brand-700 transition-colors hover:bg-brand-100 dark:bg-brand-500/10 dark:text-brand-300 dark:hover:bg-brand-500/20"
              >
                <FolderOpen size={11} className="shrink-0" />
                <span className="truncate">{l.label}</span>
              </button>
            ))}
          </div>
        )}
        <div className={cls('mt-1 flex items-center gap-2 text-[10px] text-faint')}>
          <span className="num">{formatTime(m.ts)}</span>
          <span className="opacity-0 transition-opacity group-hover:opacity-100"><CopyButton text={m.content} size="xs" /></span>
        </div>
      </div>
    </div>
  );
}
