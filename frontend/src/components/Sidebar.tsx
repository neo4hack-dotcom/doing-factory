// Collapsible app sidebar: wordmark, primary navigation with live inbox/intake counters, the Studio
// section, Settings at the bottom, and the two facts worth always seeing — is the live feed
// connected, and which LLM (local or cloud) is doing the work.
import { Cloud, HardDrive, PanelLeftClose, PanelLeftOpen, TriangleAlert } from 'lucide-react';
import { useState } from 'react';
import { cls } from '../lib/cls';
import { llmLocality } from '../lib/llm';
import { NAV_ITEMS } from '../lib/nav';
import type { NavItem } from '../lib/nav';
import { isActivePath, Link, paths, useRoute } from '../lib/router';
import { readStorage, STORAGE_KEYS, writeStorage } from '../lib/storage';
import { useApp } from '../lib/store';
import type { WsStatus } from '../ws';
import { IconButton, Tooltip } from './ui';

/** Brand mark: the Pantone 340 C green tile used by the favicon. */
export function LogoTile({ size = 30 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden className="shrink-0">
      <rect width="32" height="32" rx="7" fill="#009464" />
      <path d="M7 24V14l5 3v-3l5 3v-3l5 3V8h3v16z" fill="#fff" />
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="leading-none">
      <span className="wordmark block text-[17px] text-zinc-900 dark:text-white">
        DOINg<span className="text-brand-500">.AI</span>
      </span>
      <span className="mt-1 block text-[9px] font-bold uppercase tracking-[0.32em] text-faint">Factory</span>
    </span>
  );
}

const LIVE_LABEL: Record<WsStatus, { text: string; dot: string }> = {
  open: { text: 'Live', dot: 'bg-emerald-500' },
  connecting: { text: 'Connecting…', dot: 'bg-amber-500' },
  closed: { text: 'Offline — retrying', dot: 'bg-rose-500' },
};

export function LiveDot({ status, className }: { status: WsStatus; className?: string }) {
  return (
    <span className={cls('relative flex h-2 w-2 shrink-0', className)} aria-label={LIVE_LABEL[status].text}>
      {status === 'open' && <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-500 opacity-60" />}
      <span className={cls('relative inline-flex h-2 w-2 rounded-full', LIVE_LABEL[status].dot)} />
    </span>
  );
}

export function Sidebar() {
  const route = useRoute();
  const { counts, live, settings } = useApp();
  const [collapsed, setCollapsed] = useState(() => readStorage(STORAGE_KEYS.sidebarCollapsed) === '1');
  const toggle = () => {
    writeStorage(STORAGE_KEYS.sidebarCollapsed, collapsed ? '0' : '1');
    setCollapsed(!collapsed);
  };

  const badgeOf = (item: NavItem) => (item.badge === 'inbox' ? counts.total : item.badge === 'intake' ? counts.intake : 0);
  const llm = settings?.llm;
  const locality = llmLocality(llm);
  const LlmIcon = locality === 'remote' ? Cloud : locality === 'local' ? HardDrive : TriangleAlert;
  const llmText = locality === 'none' ? 'No LLM configured' : llm?.model || 'Model not selected';
  const llmHint = locality === 'none'
    ? 'AI steps will fail until a model is configured — open Settings › AI Model'
    : `${locality === 'local' ? 'Runs locally' : 'Remote / cloud model'} · ${llm?.base_url}`;

  const renderItem = (item: NavItem) => {
    const match = item.path.startsWith('/settings') ? '/settings' : item.path;
    const active = isActivePath(route.path, match);
    const badge = badgeOf(item);
    const Icon = item.icon;
    const link = (
      <Link
        to={item.path}
        aria-current={active ? 'page' : undefined}
        className={cls(
          'group relative flex h-9 items-center gap-3 rounded-lg text-[13px] font-medium transition-colors',
          collapsed ? 'w-10 justify-center' : 'px-2.5',
          active
            ? 'bg-brand-500 text-white shadow-sm shadow-brand-500/25'
            : 'text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:text-zinc-400 dark:hover:bg-ink-600 dark:hover:text-white',
        )}
      >
        <Icon size={17} className="shrink-0" />
        {!collapsed && <span className="min-w-0 flex-1 truncate">{item.label}</span>}
        {!collapsed && item.live && live === 'open' && <LiveDot status="open" />}
        {badge > 0 && (
          <span className={cls(
            'num grid h-[18px] min-w-[18px] place-items-center rounded-full px-1 text-[10px] font-bold',
            collapsed && 'absolute -right-1 -top-1 ring-2 ring-white dark:ring-ink-900',
            active ? 'bg-white text-brand-600' : 'bg-brand-500 text-white',
          )}>
            {badge > 99 ? '99+' : badge}
          </span>
        )}
      </Link>
    );
    return collapsed ? <Tooltip key={item.path} content={item.label} side="bottom">{link}</Tooltip> : <div key={item.path}>{link}</div>;
  };

  return (
    <aside className={cls(
      'no-print sticky top-0 z-30 flex h-screen shrink-0 flex-col border-r surface-glass transition-[width] duration-200',
      collapsed ? 'w-16' : 'w-60',
    )}>
      <div className={cls('flex h-14 shrink-0 items-center border-b hairline', collapsed ? 'justify-center' : 'gap-2.5 px-4')}>
        <Link to={paths.home()} className="flex items-center gap-2.5" aria-label="DOINg.AI Factory — Home">
          <LogoTile />
          {!collapsed && <Wordmark />}
        </Link>
      </div>

      <nav className={cls('flex-1 space-y-0.5 overflow-y-auto py-3', collapsed ? 'flex flex-col items-center px-2' : 'px-3')}>
        {NAV_ITEMS.filter((n) => n.section === 'main').map(renderItem)}
        {collapsed ? <div className="my-3 h-px w-8 bg-zinc-200 dark:bg-ink-600" /> : <div className="label-xs px-2.5 pb-1.5 pt-5">Studio</div>}
        {NAV_ITEMS.filter((n) => n.section === 'studio').map(renderItem)}
      </nav>

      <div className={cls('shrink-0 space-y-0.5 border-t hairline py-3', collapsed ? 'flex flex-col items-center px-2' : 'px-3')}>
        {NAV_ITEMS.filter((n) => n.section === 'bottom').map(renderItem)}
        <div className={cls('pt-2', collapsed ? 'flex flex-col items-center gap-2' : 'space-y-1.5 px-1')}>
          <Tooltip content={llmHint} side="top">
            <Link
              to={paths.settings('ai')}
              className={cls(
                'flex items-center gap-2 rounded-md text-[11px] font-medium transition-colors',
                collapsed ? 'h-8 w-8 justify-center' : 'w-full px-1.5 py-1',
                locality === 'none'
                  ? 'bg-amber-500/10 text-amber-700 hover:bg-amber-500/15 dark:text-amber-300'
                  : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-ink-600',
              )}
            >
              <LlmIcon size={13} className={cls('shrink-0', locality === 'remote' && 'text-sky-500', locality === 'local' && 'text-emerald-500')} />
              {!collapsed && <span className="min-w-0 truncate font-mono">{llmText}</span>}
            </Link>
          </Tooltip>
          <div className={cls('flex items-center', collapsed ? 'flex-col gap-2' : 'justify-between gap-2 px-1.5')}>
            <Tooltip content={`Live updates: ${LIVE_LABEL[live].text}`} side="top">
              <span className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-faint">
                <LiveDot status={live} />
                {!collapsed && LIVE_LABEL[live].text}
              </span>
            </Tooltip>
            <IconButton icon={collapsed ? PanelLeftOpen : PanelLeftClose} label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'} size="xs" onClick={toggle} />
          </div>
        </div>
      </div>
    </aside>
  );
}
