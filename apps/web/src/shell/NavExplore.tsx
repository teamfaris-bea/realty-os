// Navigation exploration (branch explore/navigation): the pieces of the two candidate navigations. Layout.tsx puts
// them together when `?nav=a` or `?nav=b` asked for one; the current navigation does not use this file.
//
//   A "Slim rail"  Rail (primary pages, icon over label, then More) + TopBarA (search, Add person, account).
//   B "Top bar"    TopBarB only: team name, primary pages as text links, More, search, Add person, account.
//   phone (both)   ExploreTabBar: the primary pages (at most five) + More; the search field is in the page's top bar
//                  (GlobalSearch `compact`, placed by PageFrame). The one real difference: in A, More is a sheet over
//                  the page you are on; in B, More is the /more page, as today.
//
// More and the account menu are disclosures (a button with aria-expanded and the panel right after it in the DOM, so
// Tab walks into it): Escape closes and returns focus to the button, a press outside closes, a page change closes.
import { type ReactNode, type RefObject, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { Dialog, Icon, buttonClass } from '../design/index.js';
import { useSession, useShell } from './context.js';
import { GlobalSearch } from './GlobalSearch.js';
import { type ExploreGroup, type ExploreNav, NAV_MODE_LABEL, type NavMode, exploreNavFor, useNavMode } from './exploreNavModel.js';
import { type NavItem, activeNavPath, pagesFor } from './pages.js';

const EMPTY: ExploreNav = { primary: [], more: [], account: [], tabs: [], phoneMore: [], all: [] };

export function useExploreNav(): ExploreNav {
  const { table } = useShell();
  const { session } = useSession();
  const role = session?.tenant?.role;
  return useMemo(() => (role ? exploreNavFor(role, pagesFor(table, role)) : EMPTY), [table, role]);
}

/** "Harbor Home Team" → "HH" */
const initials = (name: string): string =>
  name
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w.slice(0, 1).toUpperCase())
    .join('') || '?';

// ---- disclosure -----------------------------------------------------------------------------------------------------

function useDisclosure<P extends HTMLElement = HTMLDivElement>(): { open: boolean; toggle(): void; close(): void; button: RefObject<HTMLButtonElement>; panel: RefObject<P> } {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const panel = useRef<P>(null);
  const { pathname, search } = useLocation();
  useEffect(() => setOpen(false), [pathname, search]);
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      setOpen(false);
      button.current?.focus();
    };
    const onDown = (e: PointerEvent) => {
      if (!(e.target instanceof Node)) return;
      if (!button.current?.contains(e.target) && !panel.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('pointerdown', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('pointerdown', onDown);
    };
  }, [open]);
  return { open, toggle: () => setOpen((o) => !o), close: () => setOpen(false), button, panel };
}

// ---- grouped lists ----------------------------------------------------------------------------------------------------

function GroupColumns({ groups, active, lead }: { groups: readonly ExploreGroup[]; active: string | null; lead?: ReactNode }) {
  const id = useId();
  return (
    <div className="columns-[220px] gap-x-6">
      {lead}
      {groups.map((g) => (
        <section key={g.id} className="mb-4 break-inside-avoid">
          <h2 id={`${id}-${g.id}`} className="px-3 pb-1 text-[12px] font-semibold uppercase tracking-wide text-ink-muted">
            {g.label}
          </h2>
          <ul aria-labelledby={`${id}-${g.id}`} className="flex flex-col">
            {g.items.map((i) => (
              <li key={i.path}>
                <PanelLink item={i} current={active === i.path} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}

function PanelLink({ item, current, className = '' }: { item: NavItem; current: boolean; className?: string }) {
  return (
    <Link
      to={item.path}
      aria-current={current ? 'page' : undefined}
      className={`flex min-h-tap items-center gap-3 rounded-xl px-3 text-[15px] font-medium ${current ? 'bg-accent-soft text-accent' : 'text-ink hover:bg-surface-2'} ${className}`}
    >
      <span className={current ? '' : 'text-ink-muted'}>
        <Icon name={item.icon} size={20} />
      </span>
      <span className="min-w-0 [overflow-wrap:anywhere]">{item.label}</span>
    </Link>
  );
}

/** The phone's More list in both directions (A: inside the sheet; B: the /more page): the same groups as desktop, plus "You". */
export function PhoneMoreGroups({ groups }: { groups: readonly ExploreGroup[] }) {
  const id = useId();
  const { pathname } = useLocation();
  const active = activeNavPath(groups.flatMap((g) => g.items), pathname);
  return (
    <nav aria-label="More" className="flex flex-col gap-4">
      {groups.map((g) => (
        <section key={g.id} className="flex flex-col gap-1.5">
          <h2 id={`${id}-${g.id}`} className="px-1 text-[13px] font-semibold uppercase tracking-wide text-ink-muted">
            {g.label}
          </h2>
          <ul aria-labelledby={`${id}-${g.id}`} className="overflow-hidden rounded-2xl border border-line bg-surface">
            {g.items.map((i, idx) => (
              <li key={i.path} className={idx > 0 ? 'border-t border-line' : ''}>
                <Link to={i.path} aria-current={active === i.path ? 'page' : undefined} className="flex min-h-[52px] items-center gap-3 px-4 text-[17px] text-ink active:bg-surface-2">
                  <span className="text-accent">
                    <Icon name={i.icon} size={22} />
                  </span>
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{i.label}</span>
                  <span className="text-ink-muted">
                    <Icon name="chevron" size={18} />
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}

// ---- shared top-bar controls ------------------------------------------------------------------------------------------

/** The create button: Add person (not for a TC, who creates no contacts; not on the Add person page itself). */
function CreateLink() {
  const { session } = useSession();
  const { pathname } = useLocation();
  if (!session?.tenant || session.tenant.role === 'tc' || pathname === '/people/new') return null;
  return (
    <Link to="/people/new" aria-label="Add person" className={buttonClass('primary', 'shrink-0 px-3 text-[15px]')}>
      <span aria-hidden="true" className="text-[20px] leading-none">
        +
      </span>
      <span className="hidden min-[1400px]:inline">Add person</span>
    </Link>
  );
}

function AccountMenu({ nav, roleLabel }: { nav: ExploreNav; roleLabel: string }) {
  const { session, signOut } = useSession();
  const { mode, setMode } = useNavMode();
  const { pathname } = useLocation();
  const d = useDisclosure();
  const id = useId();
  if (!session?.tenant) return null;
  const active = activeNavPath(nav.account, pathname);
  return (
    <div className="relative shrink-0">
      <button
        ref={d.button}
        type="button"
        aria-expanded={d.open}
        aria-controls={`${id}-panel`}
        aria-label={`Account menu, ${session.user.displayName}`}
        onClick={d.toggle}
        className="inline-flex min-h-tap min-w-tap items-center justify-center rounded-full"
      >
        <span aria-hidden="true" className={`flex h-9 w-9 items-center justify-center rounded-full text-[13px] font-semibold ${d.open || active ? 'bg-accent text-accent-ink' : 'bg-accent-soft text-accent'}`}>
          {initials(session.user.displayName)}
        </span>
      </button>
      <div ref={d.panel} id={`${id}-panel`} hidden={!d.open} className="absolute right-0 top-full z-40 mt-2 w-[300px] max-w-[calc(100vw-32px)] rounded-2xl border border-line bg-surface p-2 shadow-xl">
        <div className="px-3 pb-2 pt-1">
          <p className="text-[16px] font-semibold text-ink [overflow-wrap:anywhere]">{session.user.displayName}</p>
          <p className="text-[13px] text-ink-muted [overflow-wrap:anywhere]">
            {session.tenant.name} · {roleLabel}
          </p>
        </div>
        <ul aria-label="Your settings" className="border-t border-line pt-1">
          {nav.account.map((i) => (
            <li key={i.path}>
              <PanelLink item={i} current={active === i.path} />
            </li>
          ))}
        </ul>
        <div className="mt-1 border-t border-line pt-1">
          <button type="button" onClick={() => void signOut()} className="flex min-h-tap w-full items-center gap-3 rounded-xl px-3 text-left text-[15px] font-medium text-ink hover:bg-surface-2">
            <span className="text-ink-muted">
              <Icon name="logout" size={20} />
            </span>
            Sign out
          </button>
        </div>
        {/* exploration only: flip between the three navigations without editing the address */}
        <fieldset className="mt-1 border-t border-line px-3 pb-1 pt-2">
          <legend className="sr-only">Navigation preview</legend>
          <p aria-hidden="true" className="pb-1 text-[12px] font-semibold uppercase tracking-wide text-ink-muted">
            Navigation preview
          </p>
          <div className="flex flex-wrap gap-1.5">
            {(['current', 'a', 'b'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={`inline-flex min-h-tap items-center rounded-xl border px-3 text-[14px] font-medium ${mode === m ? 'border-accent bg-accent-soft text-accent' : 'border-line text-ink hover:bg-surface-2'}`}
              >
                {NAV_MODE_LABEL[m]}
              </button>
            ))}
          </div>
        </fieldset>
      </div>
    </div>
  );
}

// ---- A: slim rail -------------------------------------------------------------------------------------------------------

export function Rail({ nav }: { nav: ExploreNav }) {
  const { session } = useSession();
  const { pathname } = useLocation();
  const d = useDisclosure();
  const id = useId();
  const moreItems = nav.more.flatMap((g) => g.items);
  const active = activeNavPath([...nav.primary, ...moreItems, ...nav.account], pathname);
  const inMore = moreItems.some((i) => i.path === active);
  const width = moreItems.length <= 18 ? 'w-[300px]' : moreItems.length <= 34 ? 'w-[560px]' : 'w-[820px]';
  const team = session?.tenant?.name ?? 'Realty OS';
  return (
    <aside className="sticky top-0 z-40 hidden h-dvh w-[96px] shrink-0 flex-col border-r border-line bg-surface md:flex">
      <div className="flex h-[60px] shrink-0 items-center justify-center border-b border-line">
        <span aria-hidden="true" title={team} className="flex h-9 w-9 items-center justify-center rounded-xl bg-ink text-[13px] font-bold text-surface">
          {initials(team)}
        </span>
        <span className="sr-only">{team}</span>
      </div>
      <nav aria-label="Main" className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1.5 py-3">
        <ul className="flex flex-col gap-1">
          {nav.primary.map((i) => (
            <li key={i.path}>
              <Link to={i.path} aria-current={active === i.path ? 'page' : undefined} className={railItem(active === i.path)}>
                <Icon name={i.icon} size={22} />
                <span className="[overflow-wrap:anywhere]">{i.label}</span>
              </Link>
            </li>
          ))}
          {moreItems.length > 0 ? (
            <li>
              <div>
                <button ref={d.button} type="button" aria-expanded={d.open} aria-controls={`${id}-more`} onClick={d.toggle} className={`w-full ${railItem(d.open || inMore)}`}>
                  <Icon name="more" size={22} />
                  <span>More</span>
                </button>
                <div ref={d.panel} id={`${id}-more`} hidden={!d.open} className={`fixed bottom-0 left-[96px] top-0 z-40 max-w-[calc(100vw-96px)] overflow-y-auto border-r border-line bg-surface px-3 pb-6 shadow-xl ${width}`}>
                  <div className="flex h-[60px] items-center justify-between px-3">
                    <p className="text-[17px] font-bold text-ink">More</p>
                    <button type="button" onClick={d.close} className="inline-flex min-h-tap items-center rounded-xl px-2 text-[15px] font-medium text-accent">
                      Close
                    </button>
                  </div>
                  <GroupColumns groups={nav.more} active={active} />
                </div>
              </div>
            </li>
          ) : null}
        </ul>
      </nav>
    </aside>
  );
}

const railItem = (current: boolean) =>
  `flex min-h-[60px] flex-col items-center justify-center gap-1 rounded-xl px-0.5 py-1.5 text-center text-[12px] font-medium leading-[1.15] ${current ? 'bg-accent-soft text-accent' : 'text-ink-muted hover:bg-surface-2 hover:text-ink'}`;

export function TopBarA({ nav, roleLabel }: { nav: ExploreNav; roleLabel: string }) {
  return (
    <header className="sticky top-0 z-30 hidden h-[60px] shrink-0 items-center gap-3 border-b border-line bg-surface px-8 md:flex">
      <div className="w-full max-w-[560px]">
        <GlobalSearch variant="bar" pages={nav.all} />
      </div>
      <div className="ml-auto flex items-center gap-2">
        <CreateLink />
        <AccountMenu nav={nav} roleLabel={roleLabel} />
      </div>
    </header>
  );
}

// ---- B: top bar ---------------------------------------------------------------------------------------------------------

// A bar has room for three links at 768 px, four at 1024 px and all six from 1280 px; the ones that do not fit are
// listed first under More at that width ("Main pages"), so nothing disappears.
const LINK_SHOWN = ['', '', '', 'hidden lg:block', 'hidden xl:block', 'hidden xl:block'] as const;
const MORE_SHOWN = [null, null, null, 'lg:hidden', 'xl:hidden', 'xl:hidden'] as const;

export function TopBarB({ nav, roleLabel }: { nav: ExploreNav; roleLabel: string }) {
  const { session } = useSession();
  const { pathname } = useLocation();
  const d = useDisclosure();
  const id = useId();
  const moreItems = nav.more.flatMap((g) => g.items);
  const active = activeNavPath([...nav.primary, ...moreItems, ...nav.account], pathname);
  const inMore = moreItems.some((i) => i.path === active);
  const team = session?.tenant?.name ?? 'Realty OS';
  const overflow = nav.primary.flatMap((item, i) => {
    const cls = i < MORE_SHOWN.length ? MORE_SHOWN[i] : 'xl:hidden';
    return cls ? [{ item, cls }] : [];
  });
  return (
    <header className="sticky top-0 z-30 hidden border-b border-line bg-surface md:block">
      <div className="relative">
        <div className="flex h-[60px] items-center gap-2 px-4 xl:px-6">
          <p className="flex shrink-0 items-center gap-2 pr-1">
            <span aria-hidden="true" className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-ink text-[13px] font-bold text-surface">
              {initials(team)}
            </span>
            <span className="sr-only max-w-[150px] text-[15px] font-bold leading-tight text-ink [overflow-wrap:anywhere] xl:not-sr-only xl:line-clamp-2">{team}</span>
          </p>
          <nav aria-label="Main" className="flex min-w-0 items-center">
            <ul className="flex items-center gap-0.5">
              {nav.primary.map((item, i) => (
                <li key={item.path} className={LINK_SHOWN[i] ?? 'hidden xl:block'}>
                  <Link to={item.path} aria-current={active === item.path ? 'page' : undefined} className={barItem(active === item.path)}>
                    {item.label}
                  </Link>
                </li>
              ))}
              {moreItems.length > 0 ? (
                <li>
                  <button ref={d.button} type="button" aria-expanded={d.open} aria-controls={`${id}-more`} onClick={d.toggle} className={`gap-1 ${barItem(d.open || inMore)}`}>
                    More
                    <span className={d.open ? '-rotate-90' : 'rotate-90'}>
                      <Icon name="chevron" size={14} />
                    </span>
                  </button>
                  {/* the More menu: a full-width panel under the bar, right after its button in the DOM so Tab walks into it */}
                  <div ref={d.panel} id={`${id}-more`} hidden={!d.open} className="absolute inset-x-0 top-full z-40 max-h-[calc(100dvh-60px)] overflow-y-auto border-b border-line bg-surface px-3 pb-3 pt-5 shadow-xl xl:px-5">
                    <GroupColumns
                      groups={nav.more}
                      active={active}
                      lead={
                        overflow.length > 0 ? (
                          <section className={`mb-4 break-inside-avoid ${nav.primary.length > 4 ? 'xl:hidden' : 'lg:hidden'}`}>
                            <h2 id={`${id}-main`} className="px-3 pb-1 text-[12px] font-semibold uppercase tracking-wide text-ink-muted">
                              Main pages
                            </h2>
                            <ul aria-labelledby={`${id}-main`} className="flex flex-col">
                              {overflow.map(({ item, cls }) => (
                                <li key={item.path} className={cls}>
                                  <PanelLink item={item} current={active === item.path} />
                                </li>
                              ))}
                            </ul>
                          </section>
                        ) : null
                      }
                    />
                  </div>
                </li>
              ) : null}
            </ul>
          </nav>
          <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2">
            <div className="min-w-[200px] max-w-[360px] flex-1">
              <GlobalSearch variant="bar" align="right" shortBelowLg pages={nav.all} />
            </div>
            <CreateLink />
            <AccountMenu nav={nav} roleLabel={roleLabel} />
          </div>
        </div>
      </div>
    </header>
  );
}

const barItem = (current: boolean) =>
  `inline-flex min-h-tap items-center whitespace-nowrap rounded-xl px-3 text-[15px] font-medium ${current ? 'bg-accent-soft text-accent' : 'text-ink hover:bg-surface-2'}`;

// ---- phone: tabs + More ---------------------------------------------------------------------------------------------------

export function ExploreTabBar({ nav, mode }: { nav: ExploreNav; mode: Exclude<NavMode, 'current'> }) {
  const { pathname } = useLocation();
  const [sheet, setSheet] = useState(false);
  const moreItems = nav.phoneMore.flatMap((g) => g.items);
  const active = activeNavPath([...nav.tabs, ...moreItems], pathname);
  const moreActive = pathname === '/more' || moreItems.some((m) => m.path === active);
  useEffect(() => setSheet(false), [pathname]);
  return (
    <nav aria-label="Main tabs" className="pb-safe fixed inset-x-0 bottom-0 z-30 border-t border-line bg-surface/95 backdrop-blur md:hidden">
      {/* every tab is at least as wide as its longest word (two-word names wrap); the rest of the width is shared */}
      <ul className="mx-auto grid max-w-xl auto-cols-[minmax(min-content,1fr)] grid-flow-col px-0.5">
        {nav.tabs.map((t) => (
          <li key={t.path} className="min-w-tap">
            <Link to={t.path} aria-current={active === t.path ? 'page' : undefined} className={tabItem(active === t.path)}>
              <Icon name={t.icon} size={24} />
              <span>{t.label}</span>
            </Link>
          </li>
        ))}
        <li className="min-w-tap">
          {mode === 'a' ? (
            <button type="button" aria-haspopup="dialog" onClick={() => setSheet(true)} className={`w-full ${tabItem(moreActive || sheet)}`}>
              <Icon name="more" size={24} />
              <span>More</span>
            </button>
          ) : (
            <Link to="/more" aria-current={moreActive ? 'page' : undefined} className={tabItem(moreActive)}>
              <Icon name="more" size={24} />
              <span>More</span>
            </Link>
          )}
        </li>
      </ul>
      {sheet ? (
        <Dialog title="More" closeButton onClose={() => setSheet(false)}>
          <PhoneMoreGroups groups={nav.phoneMore} />
        </Dialog>
      ) : null}
    </nav>
  );
}

const tabItem = (current: boolean) =>
  `flex h-tabbar flex-col items-center justify-center gap-0.5 px-1 text-center text-[11px] font-medium leading-[1.1] ${current ? 'text-accent' : 'text-ink-muted'}`;
