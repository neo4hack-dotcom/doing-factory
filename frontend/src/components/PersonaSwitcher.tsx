// "Acting as": there is no sign-in by default, so every mutation carries the persona's user_id and
// the backend checks it. Switching persona instantly shows that person's inbox — the fastest way to
// walk through (or test) a multi-party approval.
import { Check, ChevronsUpDown, Search, UserPlus } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { cls } from '../lib/cls';
import { navigate, paths } from '../lib/router';
import { useApp } from '../lib/store';
import type { User } from '../types';
import { Avatar, Badge, Button, Popover, toneOf, useToast } from './ui';

export function PersonaSwitcher({ compact }: { compact?: boolean }) {
  const { users, roles, me, userId, setUserId, roleByKey } = useApp();
  const toast = useToast();
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');

  // Group by the person's first role, in the order roles are defined; inactive users are hidden.
  const groups = useMemo(() => {
    const term = q.trim().toLowerCase();
    const visible = users.filter((u) => u.active && (!term
      || `${u.name} ${u.title} ${u.email} ${u.roles.join(' ')}`.toLowerCase().includes(term)));
    const order = [...roles.map((r) => r.key), ''];
    const map = new Map<string, User[]>();
    for (const u of visible) {
      const key = u.roles.find((r) => order.includes(r)) ?? '';
      map.set(key, [...(map.get(key) ?? []), u]);
    }
    return order.filter((k) => map.has(k)).map((k) => ({ key: k, label: k ? roleByKey(k)?.label ?? k : 'No role', users: map.get(k)! }));
  }, [users, roles, q, roleByKey]);

  const choose = (u: User) => {
    setOpen(false);
    setQ('');
    if (u.id === userId) return;
    setUserId(u.id);
    toast.info(`Now acting as ${u.name}`);
  };

  return (
    <>
      <button
        ref={anchor}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        title="Switch persona"
        className={cls(
          'flex h-9 items-center gap-2 rounded-lg border border-transparent pl-1 pr-1.5 text-left transition-colors hover:border-zinc-200 hover:bg-zinc-50 dark:hover:border-ink-500 dark:hover:bg-ink-700',
          open && 'border-zinc-200 bg-zinc-50 dark:border-ink-500 dark:bg-ink-700',
        )}
      >
        <Avatar user={me} name={me ? undefined : '?'} size={28} />
        {!compact && (
          <span className="hidden min-w-0 lg:block">
            <span className="block text-[9px] font-bold uppercase leading-tight tracking-[0.16em] text-faint">Acting as</span>
            <span className="block max-w-[140px] truncate text-xs font-semibold leading-tight text-zinc-800 dark:text-zinc-100">{me?.name ?? 'No users yet'}</span>
          </span>
        )}
        <ChevronsUpDown size={13} className="shrink-0 text-zinc-400" />
      </button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} align="right" width={320} className="!p-0">
        {me && (
          <div className="border-b hairline p-3.5">
            <div className="flex items-center gap-3">
              <Avatar user={me} size={38} />
              <div className="min-w-0">
                <div className="truncate text-sm font-bold">{me.name}</div>
                <div className="truncate text-xs text-muted">{me.title || me.email}</div>
              </div>
            </div>
            {me.roles.length > 0 && (
              <div className="mt-2.5 flex flex-wrap gap-1">
                {me.roles.map((r) => <Badge key={r} size="xs" tone={toneOf(roleByKey(r)?.color)}>{roleByKey(r)?.label ?? r}</Badge>)}
              </div>
            )}
          </div>
        )}
        {users.length === 0 ? (
          <div className="space-y-3 p-4 text-center">
            <p className="text-sm text-muted">No people yet. Import them from your DOINg.AI or add them in Settings.</p>
            <Button size="sm" variant="outline" icon={UserPlus} onClick={() => {
              setOpen(false);
              navigate(paths.settings('people'));
            }}>People & Teams</Button>
          </div>
        ) : (
          <>
            {users.length > 8 && (
              <div className="border-b hairline p-2">
                <label className="flex items-center gap-2 rounded-md bg-zinc-100 px-2 dark:bg-ink-700">
                  <Search size={13} className="text-zinc-400" />
                  <input
                    autoFocus
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Find a person or role…"
                    className="h-8 w-full bg-transparent text-xs outline-none"
                  />
                </label>
              </div>
            )}
            <div className="max-h-[50vh] overflow-y-auto p-1.5">
              <div className="label-xs px-2 pb-1 pt-1">Switch to</div>
              {groups.length === 0 && <p className="px-2 py-4 text-center text-xs text-faint">Nobody matches.</p>}
              {groups.map((g) => (
                <div key={g.key || 'none'} className="mb-1">
                  <div className="px-2 pb-0.5 pt-1.5 text-[10px] font-semibold text-faint">{g.label}</div>
                  {g.users.map((u) => (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => choose(u)}
                      className={cls(
                        'flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-zinc-100 dark:hover:bg-ink-600',
                        u.id === userId && 'bg-brand-500/10',
                      )}
                    >
                      <Avatar user={u} size={24} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{u.name}</span>
                        {u.title && <span className="block truncate text-[11px] text-faint">{u.title}</span>}
                      </span>
                      {u.id === userId && <Check size={14} className="shrink-0 text-brand-500" />}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}
      </Popover>
    </>
  );
}
