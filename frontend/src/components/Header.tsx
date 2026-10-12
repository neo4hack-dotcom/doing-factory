// Sticky top bar: page title slot, ⌘K search, "Ask Factory", live dot, notifications, persona and
// theme. Views set the title with usePageTitle(); otherwise the route's default title shows.
import { CircleHelp, Moon, Search, Sparkles, Sun } from 'lucide-react';
import { MOD_LABEL } from '../lib/hotkeys';
import { ROUTE_TITLES } from '../lib/nav';
import { usePageTitleValue } from '../lib/pageTitle';
import { navigate, paths, useRoute } from '../lib/router';
import { useApp } from '../lib/store';
import { NotificationBell } from './NotificationBell';
import { PersonaSwitcher } from './PersonaSwitcher';
import { LiveDot } from './Sidebar';
import { Button, IconButton, Kbd, Tooltip } from './ui';

export function Header({ onOpenPalette }: { onOpenPalette: () => void }) {
  const route = useRoute();
  const custom = usePageTitleValue();
  const { theme, toggleTheme, live, openCopilot } = useApp();
  const title = custom || ROUTE_TITLES[route.name];

  return (
    <header className="no-print sticky top-0 z-20 flex h-14 shrink-0 items-center gap-3 border-b surface-glass px-4 sm:px-6">
      <h1 className="min-w-0 flex-1 truncate text-sm font-bold tracking-tight text-zinc-900 dark:text-white">{title}</h1>

      <button
        type="button"
        onClick={onOpenPalette}
        className="hidden h-9 w-64 items-center gap-2 rounded-lg border border-zinc-200 bg-white/70 px-3 text-left text-xs text-zinc-400 transition-colors hover:border-zinc-300 hover:text-zinc-600 md:flex xl:w-80 dark:border-ink-500 dark:bg-ink-800/70 dark:hover:border-ink-400 dark:hover:text-zinc-300"
      >
        <Search size={14} className="shrink-0" />
        <span className="flex-1 truncate">Search projects, views, actions…</span>
        <Kbd>{MOD_LABEL}K</Kbd>
      </button>
      <IconButton icon={Search} label="Search" className="md:hidden" onClick={onOpenPalette} />

      <Button variant="ai" size="sm" icon={Sparkles} onClick={() => openCopilot()} title="Ask the Factory about any project, approval or KPI">
        <span className="hidden sm:inline">Ask Factory</span>
      </Button>

      <div className="flex items-center gap-1">
        <Tooltip content={live === 'open' ? 'Live updates connected' : live === 'connecting' ? 'Connecting to live updates…' : 'Live updates offline — retrying'} side="bottom">
          <span className="grid h-8 w-6 place-items-center"><LiveDot status={live} /></span>
        </Tooltip>
        <NotificationBell />
        <IconButton icon={CircleHelp} label="User guide" onClick={() => navigate(paths.guide())} />
        <IconButton icon={theme === 'dark' ? Sun : Moon} label={theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'} onClick={toggleTheme} />
      </div>
      <div className="h-6 w-px bg-zinc-200 dark:bg-ink-500" />
      <PersonaSwitcher />
    </header>
  );
}
