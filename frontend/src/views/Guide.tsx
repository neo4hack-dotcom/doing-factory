// User guide (#/guide, #/guide/:section): a table of contents grouped by topic, a search over every
// section, and one section at a time with links straight into the screens it describes. Content
// lives in guide/content.ts so it can be searched and tested as data.
import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ArrowRight, BookOpen, ExternalLink, Search } from 'lucide-react';
import { Markdown } from '../components/Markdown';
import { Button, Card, EmptyState, Input, SectionHeader } from '../components/ui';
import { cls } from '../lib/cls';
import { Link, navigate, paths } from '../lib/router';
import { usePageTitle } from '../lib/pageTitle';
import { GUIDE, GUIDE_GROUPS, searchGuide } from './guide/content';
import type { GuideSection } from './guide/content';

export interface GuideProps {
  /** Section id from #/guide/:section ('' or unknown = the first section). */
  section?: string;
}

export default function Guide({ section }: GuideProps) {
  const [query, setQuery] = useState('');
  const current = GUIDE.find((s) => s.id === section) ?? GUIDE[0];
  const index = GUIDE.indexOf(current);
  const results = useMemo(() => searchGuide(query), [query]);
  const top = useRef<HTMLDivElement>(null);
  usePageTitle(`User Guide · ${current.title}`);

  // A new section starts at its top, not at the scroll position of the previous one.
  useEffect(() => { top.current?.scrollIntoView({ block: 'start' }); }, [current.id]);

  const open = (id: string) => {
    setQuery('');
    navigate(paths.guide(id));
  };

  return (
    <div ref={top} className="scroll-mt-20">
      <SectionHeader
        eyebrow="Help"
        icon={BookOpen}
        title="User Guide"
        description="How the Factory works, screen by screen — and how to configure it for your teams."
      />

      <div className="grid gap-6 lg:grid-cols-[16rem_minmax(0,1fr)]">
        <aside className="lg:sticky lg:top-20 lg:self-start">
          <Input
            icon={Search}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search the guide…"
            aria-label="Search the guide"
          />
          <nav className="mt-4 space-y-4" aria-label="Guide contents">
            {GUIDE_GROUPS.map((group) => (
              <div key={group}>
                <div className="label-xs px-2 pb-1">{group}</div>
                {GUIDE.filter((s) => s.group === group).map((s) => (
                  <TocItem key={s.id} section={s} active={!query && s.id === current.id} />
                ))}
              </div>
            ))}
          </nav>
        </aside>

        <main className="min-w-0">
          {query ? (
            <SearchResults query={query} results={results} onOpen={open} />
          ) : (
            <Card padding="lg" className="animate-fade-in" key={current.id}>
              <div className="mb-1 flex items-center gap-2 text-brand-600 dark:text-brand-400">
                <current.icon size={18} />
                <span className="label-xs !text-current">{current.group}</span>
              </div>
              <h2 className="text-xl font-bold tracking-tight text-zinc-900 dark:text-white">{current.title}</h2>
              <p className="mt-1 text-sm text-muted">{current.summary}</p>

              <div className="mt-5 border-t hairline pt-5">
                <Markdown content={current.body.trim()} />
              </div>

              {current.links && current.links.length > 0 && (
                <div className="mt-6 flex flex-wrap gap-2">
                  {current.links.map((l) => (
                    <Button key={l.to + l.label} variant="outline" size="sm" icon={ExternalLink} onClick={() => navigate(l.to)}>
                      {l.label}
                    </Button>
                  ))}
                </div>
              )}

              <div className="mt-8 flex items-center justify-between gap-3 border-t hairline pt-4">
                {index > 0 ? (
                  <Button variant="ghost" size="sm" icon={ArrowLeft} onClick={() => open(GUIDE[index - 1].id)}>
                    {GUIDE[index - 1].title}
                  </Button>
                ) : <span />}
                {index < GUIDE.length - 1 && (
                  <Button variant="ghost" size="sm" onClick={() => open(GUIDE[index + 1].id)}>
                    {GUIDE[index + 1].title}
                    <ArrowRight size={14} />
                  </Button>
                )}
              </div>
            </Card>
          )}
        </main>
      </div>
    </div>
  );
}

function TocItem({ section, active }: { section: GuideSection; active: boolean }) {
  const Icon = section.icon;
  return (
    <Link
      to={paths.guide(section.id)}
      aria-current={active ? 'page' : undefined}
      className={cls(
        'flex items-center gap-2 rounded-md px-2 py-1.5 text-sm transition-colors',
        active
          ? 'bg-brand-50 font-medium text-brand-700 dark:bg-brand-500/10 dark:text-brand-300'
          : 'text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-ink-700',
      )}
    >
      <Icon size={15} className="shrink-0" />
      <span className="truncate">{section.title}</span>
    </Link>
  );
}

function SearchResults({ query, results, onOpen }: { query: string; results: GuideSection[]; onOpen: (id: string) => void }) {
  if (!results.length) {
    return <EmptyState icon={Search} title={`Nothing found for “${query}”`} description="Try another word, or browse the contents on the left." />;
  }
  return (
    <div className="space-y-2">
      <div className="label-xs px-1">{results.length} section{results.length > 1 ? 's' : ''}</div>
      {results.map((s) => (
        <Card key={s.id} padding="md" onClick={() => onOpen(s.id)} className="cursor-pointer transition-colors hover:border-brand-400">
          <div className="flex items-start gap-3">
            <s.icon size={18} className="mt-0.5 shrink-0 text-brand-600 dark:text-brand-400" />
            <div className="min-w-0">
              <div className="font-semibold text-zinc-900 dark:text-white">{s.title}</div>
              <div className="text-sm text-muted">{s.summary}</div>
              <Snippet body={s.body} query={query} />
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

/** The first line of the body containing the first search word, so a result shows why it matched. */
function Snippet({ body, query }: { body: string; query: string }) {
  const word = query.toLowerCase().split(/\s+/).find(Boolean) ?? '';
  const line = body.split('\n').find((l) => l.toLowerCase().includes(word));
  if (!word || !line) return null;
  const clean = line.replace(/[|*`#>]/g, ' ').replace(/\s+/g, ' ').trim();
  return <div className="mt-1 truncate text-xs text-faint">… {clean} …</div>;
}
