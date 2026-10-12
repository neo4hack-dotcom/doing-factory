// App shell: sidebar + header + scrollable main, the route table (docs/SPEC.md §11), global
// overlays (⌘K palette, copilot drawer, onboarding, shortcut help) and global shortcuts.
// Views are lazy-loaded: each is its own chunk, so the first paint only ships the shell.
import { AlertTriangle, Compass, Keyboard, RefreshCw, ServerCrash } from 'lucide-react';
import { Component, lazy, Suspense, useEffect, useRef, useState } from 'react';
import type { ErrorInfo, ReactNode } from 'react';
import { CommandPalette } from './components/CommandPalette';
import { CopilotPanel } from './components/CopilotPanel';
import { Header } from './components/Header';
import { Onboarding } from './components/Onboarding';
import { LogoTile, Sidebar, Wordmark } from './components/Sidebar';
import { Button, EmptyState, Kbd, Modal, Skeleton, Spinner } from './components/ui';
import { MOD_LABEL, useHotkeys } from './lib/hotkeys';
import type { HotkeyMap } from './lib/hotkeys';
import { NAV_ITEMS } from './lib/nav';
import { Link, navigate, paths, SETTINGS_TABS, useRoute } from './lib/router';
import type { Route, SettingsTab } from './lib/router';
import { readStorage, STORAGE_KEYS, writeStorage } from './lib/storage';
import { useApp } from './lib/store';
import { cls } from './lib/cls';

const Home = lazy(() => import('./views/Home'));
const Inbox = lazy(() => import('./views/Inbox'));
const Projects = lazy(() => import('./views/Projects'));
const ProjectDetail = lazy(() => import('./views/ProjectDetail'));
const NewProject = lazy(() => import('./views/NewProject'));
const Floor = lazy(() => import('./views/Floor'));
const Intake = lazy(() => import('./views/Intake'));
const Kpis = lazy(() => import('./views/Kpis'));
const Blueprints = lazy(() => import('./views/studio/Blueprints'));
const BlueprintDesigner = lazy(() => import('./views/studio/BlueprintDesigner'));
const Operations = lazy(() => import('./views/studio/Operations'));
const Prompts = lazy(() => import('./views/studio/Prompts'));
const Rules = lazy(() => import('./views/studio/Rules'));
const Settings = lazy(() => import('./views/settings/Settings'));

/** Routes whose view uses the full width (live boards, designers) instead of the reading column. */
const WIDE_ROUTES = new Set<Route['name']>(['floor', 'blueprint']);

function isSettingsTab(tab: string | undefined): tab is SettingsTab {
  return SETTINGS_TABS.some((t) => t.key === tab);
}

/**
 * Identity of the page for remounting and scroll reset: a project's step drawer
 * (#/projects/:id/:stepId) opens inside the same page instead of reloading it.
 */
function pageKey(route: Route): string {
  return route.name === 'project' ? `/projects/${route.params.id}` : route.path;
}

function renderRoute(route: Route): ReactNode {
  const p = route.params;
  switch (route.name) {
    case 'home': return <Home />;
    case 'inbox': return <Inbox itemId={p.itemId} />;
    case 'projects': return <Projects query={route.query} />;
    case 'project-new': return <NewProject blueprintId={route.query.blueprint} />;
    case 'project': return <ProjectDetail id={p.id} stepId={p.stepId} />;
    case 'floor': return <Floor />;
    case 'intake': return <Intake />;
    case 'kpis': return <Kpis />;
    case 'blueprints': return <Blueprints />;
    case 'blueprint': return <BlueprintDesigner id={p.id} />;
    case 'operations': return <Operations />;
    case 'prompts': return <Prompts />;
    case 'rules': return <Rules />;
    case 'settings': return <Settings tab={isSettingsTab(p.tab) ? p.tab : 'ai'} />;
    default: return <NotFound />;
  }
}

export default function App() {
  const app = useApp();
  if (app.status === 'loading') return <BootSplash />;
  if (app.status === 'error') return <BootError message={app.error} onRetry={() => void app.reload()} />;
  return <Shell />;
}

function Shell() {
  const route = useRoute();
  const { onboarding, copilot, closeCopilot } = useApp();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [onboardingDismissed, setOnboardingDismissed] = useState(() => readStorage(STORAGE_KEYS.onboardingDismissed, 'session') === '1');
  const main = useRef<HTMLElement>(null);

  // A new page starts at the top (query-only changes, like filters, keep the scroll position).
  const page = pageKey(route);
  useEffect(() => {
    main.current?.scrollTo({ top: 0 });
  }, [page]);

  // `#/settings` has no tab: normalise to the first one so links and the sidebar agree.
  useEffect(() => {
    if (route.name === 'settings' && !isSettingsTab(route.params.tab)) navigate(paths.settings(), { replace: true });
  }, [route.name, route.params.tab]);

  const keys: HotkeyMap = {
    'mod+k': () => setPaletteOpen((o) => !o),
    '/': () => setPaletteOpen(true),
    '?': () => setHelpOpen(true),
  };
  for (const item of NAV_ITEMS) if (item.shortcut) keys[`g ${item.shortcut}`] = () => navigate(item.path);
  useHotkeys(keys);

  const showOnboarding = !!onboarding && !onboarding.llm_configured && !onboardingDismissed;
  const dismissOnboarding = () => {
    writeStorage(STORAGE_KEYS.onboardingDismissed, '1', 'session');
    setOnboardingDismissed(true);
  };

  return (
    <div className="flex h-screen overflow-hidden">
      <Sidebar />
      <div className="flex min-w-0 flex-1 flex-col">
        <Header onOpenPalette={() => setPaletteOpen(true)} />
        <main ref={main} id="main" className="flex-1 overflow-y-auto">
          <div key={page} className={cls('mx-auto w-full px-4 py-6 animate-fade-in sm:px-6 lg:px-8', !WIDE_ROUTES.has(route.name) && 'max-w-[1360px]')}>
            <ViewBoundary routeKey={page}>
              <Suspense fallback={<ViewSkeleton />}>{renderRoute(route)}</Suspense>
            </ViewBoundary>
          </div>
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
      <CopilotPanel open={copilot.open} question={copilot.question} projectId={copilot.projectId} onClose={closeCopilot} />
      <Onboarding open={showOnboarding} onClose={dismissOnboarding} />
      <ShortcutsHelp open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Boot states
// ---------------------------------------------------------------------------------------------

function BootSplash() {
  return (
    <div className="grid h-screen place-items-center grid-bg">
      <div className="flex flex-col items-center gap-4 animate-fade-in">
        <div className="flex items-center gap-3">
          <LogoTile size={40} />
          <Wordmark />
        </div>
        <Spinner size={18} />
      </div>
    </div>
  );
}

function BootError({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="grid h-screen place-items-center p-6 grid-bg">
      <div className="card w-full max-w-md p-6 text-center animate-slide-up">
        <div className="mx-auto mb-4 flex w-fit items-center gap-3">
          <LogoTile size={34} />
          <Wordmark />
        </div>
        <ServerCrash size={26} className="mx-auto mb-2 text-rose-500" />
        <h1 className="text-base font-bold">The Factory API is not answering</h1>
        <p className="mt-1.5 text-sm text-muted">{message}</p>
        <p className="mt-3 text-xs text-faint">
          Start the backend (port 3071), then retry. The UI reconnects on its own once it is up.
        </p>
        <Button className="mt-5" icon={RefreshCw} onClick={onRetry}>Retry</Button>
      </div>
    </div>
  );
}

function ViewSkeleton() {
  return (
    <div className="space-y-6" aria-busy>
      <div className="space-y-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-7 w-72" />
        <Skeleton className="h-4 w-96 max-w-full" />
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24 rounded-xl" />)}
      </div>
      <Skeleton className="h-64 rounded-xl" />
    </div>
  );
}

function NotFound() {
  return (
    <EmptyState
      icon={Compass}
      title="Nothing lives at this address"
      description="The link may be outdated, or the item was deleted."
      action={<Link to={paths.home()} className="text-sm font-semibold text-brand-600 hover:underline dark:text-brand-400">Back to Home</Link>}
    />
  );
}

/** A crashing view shows its error instead of blanking the whole app; navigating away resets it. */
class ViewBoundary extends Component<{ routeKey: string; children: ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('View crashed', error, info.componentStack);
  }

  componentDidUpdate(prev: { routeKey: string }) {
    if (prev.routeKey !== this.props.routeKey && this.state.error) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <EmptyState
        icon={AlertTriangle}
        title="This view hit an error"
        description={this.state.error.message || 'Unexpected error'}
        action={<Button variant="outline" icon={RefreshCw} onClick={() => this.setState({ error: null })}>Try again</Button>}
      />
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Keyboard shortcut help ("?")
// ---------------------------------------------------------------------------------------------

function ShortcutsHelp({ open, onClose }: { open: boolean; onClose: () => void }) {
  const rows: Array<[ReactNode, string]> = [
    [<><Kbd>{MOD_LABEL}</Kbd><Kbd>K</Kbd></>, 'Command palette'],
    [<Kbd>/</Kbd>, 'Search'],
    ...NAV_ITEMS.filter((n) => n.shortcut).map((n): [ReactNode, string] => [<><Kbd>g</Kbd><Kbd>{n.shortcut}</Kbd></>, `Go to ${n.label}`]),
    [<><Kbd>j</Kbd><Kbd>k</Kbd></>, 'Move in lists (Inbox)'],
    [<><Kbd>a</Kbd> / <Kbd>r</Kbd></>, 'Approve / reject the selected item (Inbox)'],
    [<Kbd>?</Kbd>, 'This help'],
  ];
  return (
    <Modal open={open} onClose={onClose} title="Keyboard shortcuts" icon={Keyboard} size="sm">
      <dl className="divide-y hairline">
        {rows.map(([keys, label]) => (
          <div key={label} className="flex items-center justify-between gap-4 py-2 text-sm">
            <dt className="text-zinc-600 dark:text-zinc-300">{label}</dt>
            <dd className="flex shrink-0 items-center gap-1">{keys}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}
