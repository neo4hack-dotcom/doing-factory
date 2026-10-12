// Header bell: the acting persona's in-app notifications, pushed live over the WebSocket. Reads are
// optimistic (the dot disappears at once) and rolled back if the API refuses.
import { AlertTriangle, AtSign, Bell, CheckCheck, CheckCircle2, ClipboardList, Info, Stamp } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, errorMessage } from '../api';
import { cls } from '../lib/cls';
import { timeAgo } from '../lib/format';
import { navigate, paths } from '../lib/router';
import { useApp, useLive } from '../lib/store';
import type { Notification, NotificationKind, Tone } from '../types';
import { Button, IconButton, Popover, Spinner, TONE, useToast } from './ui';

const KIND: Record<NotificationKind, { icon: LucideIcon; tone: Tone }> = {
  task: { icon: ClipboardList, tone: 'sky' },
  approval: { icon: Stamp, tone: 'amber' },
  info: { icon: Info, tone: 'zinc' },
  warning: { icon: AlertTriangle, tone: 'rose' },
  success: { icon: CheckCircle2, tone: 'emerald' },
  mention: { icon: AtSign, tone: 'violet' },
};

const MAX_ITEMS = 50;

export function NotificationBell() {
  const { userId } = useApp();
  const toast = useToast();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    if (!userId) {
      setItems([]);
      return;
    }
    setLoading(true);
    try {
      const list = await api.notifications.list(userId);
      setItems([...list].sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, MAX_ITEMS));
      setError('');
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    void load();
  }, [load]);

  useLive('notification', ({ notification: n }) => {
    if (n.user_id !== userId) return;
    setItems((prev) => [n, ...prev.filter((x) => x.id !== n.id)].slice(0, MAX_ITEMS));
  });

  const unread = items.filter((n) => !n.read).length;

  const markRead = async (ids: string[] | 'all') => {
    const before = items;
    setItems((prev) => prev.map((n) => (ids === 'all' || ids.includes(n.id) ? { ...n, read: true } : n)));
    try {
      await api.notifications.markRead(userId, ids === 'all' ? { all: true } : { ids });
    } catch (err) {
      setItems(before);
      toast.error(err);
    }
  };

  const openItem = (n: Notification) => {
    if (!n.read) void markRead([n.id]);
    setOpen(false);
    if (n.project_id) navigate(paths.project(n.project_id, n.step_id || undefined));
  };

  return (
    <>
      <IconButton
        ref={anchor}
        icon={Bell}
        label={unread ? `Notifications (${unread} unread)` : 'Notifications'}
        badge={unread}
        active={open}
        onClick={() => {
          setOpen((o) => !o);
          if (!open) void load();
        }}
      />
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} align="right" width={380} className="!p-0">
        <div className="flex items-center justify-between gap-2 border-b hairline px-3.5 py-2.5">
          <span className="text-sm font-bold">Notifications</span>
          {unread > 0 && (
            <Button variant="ghost" size="xs" icon={CheckCheck} onClick={() => void markRead('all')}>Mark all read</Button>
          )}
        </div>
        <div className="max-h-[60vh] overflow-y-auto">
          {loading && items.length === 0 ? (
            <div className="grid place-items-center py-10"><Spinner /></div>
          ) : error && items.length === 0 ? (
            <div className="space-y-2 p-5 text-center text-xs text-rose-600 dark:text-rose-400">
              <p>{error}</p>
              <Button variant="outline" size="xs" onClick={() => void load()}>Retry</Button>
            </div>
          ) : items.length === 0 ? (
            <div className="px-6 py-10 text-center">
              <CheckCircle2 size={22} className="mx-auto mb-2 text-emerald-500" />
              <p className="text-sm font-semibold">You’re all caught up</p>
              <p className="mt-0.5 text-xs text-faint">New tasks, approvals and updates for you appear here.</p>
            </div>
          ) : (
            items.map((n) => {
              const k = KIND[n.kind] ?? KIND.info;
              const Icon = k.icon;
              return (
                <button
                  key={n.id}
                  type="button"
                  onClick={() => openItem(n)}
                  className={cls(
                    'flex w-full items-start gap-3 border-b hairline px-3.5 py-3 text-left transition-colors last:border-0 hover:bg-zinc-50 dark:hover:bg-ink-700',
                    n.read && 'opacity-60',
                  )}
                >
                  <span className={cls('mt-0.5 grid h-7 w-7 shrink-0 place-items-center rounded-lg', TONE[k.tone].icon)}>
                    <Icon size={14} />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-semibold leading-snug text-zinc-900 dark:text-zinc-100">{n.title}</span>
                    {n.body && <span className="mt-0.5 line-clamp-2 block text-xs text-muted">{n.body}</span>}
                    <span className="mt-1 block text-[10px] text-faint">{timeAgo(n.created_at)}</span>
                  </span>
                  {!n.read && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-brand-500" aria-label="Unread" />}
                </button>
              );
            })
          )}
        </div>
      </Popover>
    </>
  );
}
