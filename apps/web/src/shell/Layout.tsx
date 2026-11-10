// The responsive app frame. One layout for every surface:
// - phone (< 768 px): a sticky top bar with the page title (and Back on detail pages) and a bottom
//   tab bar (≤ 4 page tabs + More) inside the iOS safe area;
// - desktop (≥ 768 px): a left sidebar grouped work / team / admin, with the account at the bottom.
// Both navs are in the DOM and one is display:none per breakpoint, so there is no layout flash and
// assistive tech sees exactly one. A skip link jumps to <main>. After client-side navigation focus
// moves to the page's h1 so screen-reader users hear where they are (WCAG 2.4.3).
import { type ReactNode, Suspense, createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { Icon, Notice, Spinner } from '../design/index.js';
import type { SessionInfo } from './authApi.js';
import { useSession, useShell } from './context.js';
import { type NavItem, type NavModel, activeNavPath, navFor, pagesFor } from './pages.js';
import { TeamLinkPrompt } from './TeamLinkPrompt.js';

export const ROLE_LABEL: Record<NonNullable<SessionInfo['tenant']>['role'], string> = {
  owner: 'Owner',
  admin: 'Admin',
  team_lead: 'Team Lead',
  agent: 'Agent',
  isa: 'ISA',
  tc: 'Transaction Coordinator',
};

// ---- page title -----------------------------------------------------------------------------------

interface TitleValue {
  title: string;
  setTitle(t: string | null): void;
}
const TitleContext = createContext<TitleValue>({ title: '', setTitle: () => undefined });

/** Lets a page replace its registry title with something specific, e.g. the contact's name. */
export function usePageTitle(title: string | null): void {
  const { setTitle } = useContext(TitleContext);
  useEffect(() => {
    setTitle(title);
    return () => setTitle(null);
  }, [title, setTitle]);
}

/** Wraps every registry page: header with the h1, document title, focus on navigation. */
export function PageFrame({ title, detail, children }: { title: string; detail: boolean; children: ReactNode }) {
  const { session } = useSession();
  const [override, setOverride] = useState<string | null>(null);
  const shown = override ?? title;
  const h1 = useRef<HTMLHeadingElement>(null);
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    document.title = session?.tenant ? `${shown} · ${session.tenant.name}` : shown;
  }, [shown, session?.tenant]);

  // after an in-app navigation (not the first page load, whose location key is 'default') focus
  // moves to the h1 so a screen reader announces the new page
  useEffect(() => {
    if (location.key !== 'default') h1.current?.focus();
  }, [location.key]);

  const value = useMemo(() => ({ title: shown, setTitle: setOverride }), [shown]);
  return (
    <TitleContext.Provider value={value}>
      <header className="pt-safe sticky top-0 z-20 border-b border-line bg-surface/95 backdrop-blur md:static md:border-0 md:bg-transparent md:backdrop-blur-none">
        <div className="mx-auto flex min-h-[52px] max-w-5xl items-center gap-2 px-2 md:mx-0 md:min-h-0 md:px-8 md:pb-2 md:pt-8">
          {detail ? (
            <button
              type="button"
              onClick={() => (window.history.length > 1 ? navigate(-1) : navigate('/'))}
              className="inline-flex min-h-tap min-w-tap items-center justify-center rounded-xl text-accent md:hidden"
            >
              <Icon name="back" label="Back" />
            </button>
          ) : (
            <span className="w-2 md:hidden" aria-hidden="true" />
          )}
          <h1 ref={h1} tabIndex={-1} className="min-w-0 flex-1 truncate text-[17px] font-semibold text-ink outline-none md:text-[28px] md:font-bold">
            {shown}
          </h1>
        </div>
      </header>
      <div className="mx-auto w-full max-w-5xl px-4 pb-6 pt-4 md:mx-0 md:px-8">{children}</div>
    </TitleContext.Provider>
  );
}

// ---- navigation -------------------------------------------------------------------------------------

export function useNav(): NavModel {
  const { table } = useShell();
  const { session } = useSession();
  const role = session?.tenant?.role;
  return useMemo(() => (role ? navFor(pagesFor(table, role)) : { tabs: [], more: [], sidebar: [] }), [table, role]);
}

function TabBar({ nav }: { nav: NavModel }) {
  const { pathname } = useLocation();
  const all = [...nav.tabs, ...nav.more];
  const active = activeNavPath(all, pathname);
  const moreActive = pathname === '/more' || nav.more.some((m) => m.path === active);
  return (
    <nav aria-label="Main tabs" className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur md:hidden">
      <ul className="mx-auto flex max-w-xl">
        {nav.tabs.map((t) => (
          <li key={t.path} className="flex-1">
            <TabLink to={t.path} icon={t.icon} label={t.label} current={active === t.path} />
          </li>
        ))}
        <li className="flex-1">
          <TabLink to="/more" icon="more" label="More" current={moreActive} />
        </li>
      </ul>
    </nav>
  );
}

function TabLink({ to, icon, label, current }: { to: string; icon: NavItem['icon']; label: string; current: boolean }) {
  return (
    <Link
      to={to}
      aria-current={current ? 'page' : undefined}
      className={`flex h-tabbar flex-col items-center justify-center gap-0.5 text-[11px] font-medium ${current ? 'text-accent' : 'text-ink-muted'}`}
    >
      <Icon name={icon} size={24} />
      <span>{label}</span>
    </Link>
  );
}

const SECTION_LABEL = { work: null, team: 'Team', admin: 'Admin', account: null } as const;

function Sidebar({ nav }: { nav: NavModel }) {
  const { session } = useSession();
  const { pathname } = useLocation();
  const all = nav.sidebar.flatMap((g) => g.items);
  const active = activeNavPath(all, pathname);
  const main = nav.sidebar.filter((g) => g.section !== 'account');
  const account = nav.sidebar.find((g) => g.section === 'account');
  return (
    <aside className="sticky top-0 hidden h-dvh w-64 shrink-0 flex-col border-r border-line bg-surface md:flex">
      <div className="px-5 pb-3 pt-6">
        <p className="truncate text-[17px] font-bold text-ink">{session?.tenant?.name ?? 'Realty OS'}</p>
        {session?.tenant ? <p className="text-[13px] text-ink-muted">{ROLE_LABEL[session.tenant.role]}</p> : null}
      </div>
      <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3">
        {main.map((g) => (
          <div key={g.section} className="mb-3">
            {SECTION_LABEL[g.section] ? <p className="px-3 pb-1 pt-2 text-[12px] font-semibold uppercase tracking-wide text-ink-muted">{SECTION_LABEL[g.section]}</p> : null}
            <ul className="flex flex-col gap-0.5">
              {g.items.map((i) => (
                <li key={i.path}>
                  <SideLink item={i} current={active === i.path} />
                </li>
              ))}
            </ul>
          </div>
        ))}
        {account ? (
          <ul className="mt-auto flex flex-col gap-0.5 border-t border-line py-3">
            {account.items.map((i) => (
              <li key={i.path}>
                <SideLink item={i} current={active === i.path} />
              </li>
            ))}
          </ul>
        ) : null}
      </nav>
    </aside>
  );
}

function SideLink({ item, current }: { item: NavItem; current: boolean }) {
  return (
    <NavLink
      to={item.path}
      end={item.path === '/'}
      aria-current={current ? 'page' : undefined}
      className={`flex min-h-tap items-center gap-3 rounded-xl px-3 text-[15px] font-medium ${current ? 'bg-accent-soft text-accent' : 'text-ink hover:bg-surface-2'}`}
    >
      <Icon name={item.icon} size={20} />
      <span className="truncate">{item.label}</span>
    </NavLink>
  );
}

// ---- frame ------------------------------------------------------------------------------------------

function useOnline(): boolean {
  const [online, setOnline] = useState(() => (typeof navigator === 'undefined' ? true : navigator.onLine));
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => {
      window.removeEventListener('online', on);
      window.removeEventListener('offline', off);
    };
  }, []);
  return online;
}

export function PageLoading() {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-16 text-[15px] text-ink-muted">
      <Spinner />
      <span>Loading</span>
    </div>
  );
}

export function AppLayout() {
  const nav = useNav();
  const online = useOnline();
  return (
    <div className="min-h-dvh bg-canvas md:flex">
      <a href="#main" className="sr-only z-50 rounded-lg bg-surface px-4 py-3 text-accent focus:not-sr-only focus:fixed focus:left-3 focus:top-3">
        Skip to content
      </a>
      <Sidebar nav={nav} />
      <div className="flex min-w-0 flex-1 flex-col">
        {!online ? (
          <div className="px-4 pt-3 md:px-8">
            <Notice tone="warn">You're offline. What you see may be out of date, and nothing you do will send until you're back online.</Notice>
          </div>
        ) : null}
        <TeamLinkPrompt />
        <main id="main" tabIndex={-1} className="flex-1 pb-[calc(var(--tabbar-h)+env(safe-area-inset-bottom)+16px)] outline-none md:pb-0">
          <Suspense fallback={<PageLoading />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
      <TabBar nav={nav} />
    </div>
  );
}
