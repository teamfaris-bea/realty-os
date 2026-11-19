// Navigation exploration (branch explore/navigation): two candidate navigations beside the current one.
//
//   current  the navigation as it ships: left sidebar listing every page, Search as a page and a tab. THE DEFAULT.
//   a        "Slim rail": a narrow left rail with the role's primary pages plus More; search in a top bar.
//   b        "Top bar": no rail; one top bar with the primary pages as text links, search, More, create, account.
//
// `?nav=a` / `?nav=b` switches and is remembered in localStorage; `?nav=current` goes back. Nobody gets a or b
// without asking for it. This file is the pure part: which pages are primary for a role, how the rest is grouped,
// and the proof obligations the test asserts (nothing a role can open from navigation today becomes unreachable).
import type { Role } from '@realty/core/foundation';
import { createContext, useContext } from 'react';
import type { NavItem } from './pages.js';
import type { PageDef, PageNav } from './types.js';

export type NavMode = 'current' | 'a' | 'b';
export const NAV_MODE_KEY = 'realty.nav';
export const NAV_MODE_LABEL: Record<NavMode, string> = { current: 'Current navigation', a: 'Slim rail', b: 'Top bar' };

const parse = (v: string | null | undefined): NavMode | null => (v === 'a' || v === 'b' || v === 'current' ? v : null);

/** `?nav=` wins and is remembered; otherwise what was remembered; otherwise the current navigation. */
export function resolveNavMode(search: string, storage: Pick<Storage, 'getItem' | 'setItem'> | null): NavMode {
  const fromUrl = parse(new URLSearchParams(search).get('nav'));
  try {
    if (fromUrl) {
      storage?.setItem(NAV_MODE_KEY, fromUrl);
      return fromUrl;
    }
    return parse(storage?.getItem(NAV_MODE_KEY)) ?? 'current';
  } catch {
    // storage refused (private window, blocked site data): the URL still switches for this page
    return fromUrl ?? 'current';
  }
}

export interface NavModeValue {
  mode: NavMode;
  setMode(m: NavMode): void;
}
export const NavModeContext = createContext<NavModeValue>({ mode: 'current', setMode: () => undefined });
export const useNavMode = (): NavModeValue => useContext(NavModeContext);

// ---- what each role opens every day ------------------------------------------------------------------------------
//
// Desktop shows up to six primary pages; the phone tab bar shows the first five of the same list (so the two never
// disagree about what "primary" means). Based on what the role does all day, not on what exists:
export const PRIMARY: Record<Role, readonly string[]> = {
  // works leads between showings: what is due, who they are, drafts waiting for a yes, to-dos, the deals in flight
  agent: ['/', '/people', '/approvals', '/tasks', '/deals'],
  // qualifies leads and hands them on: the same loop as an agent, with the pond in place of deals
  isa: ['/', '/people', '/approvals', '/tasks', '/pond'],
  // runs files to closing: transactions and their tasks first, then the deals and people behind them, then listings
  tc: ['/', '/transactions', '/tasks', '/deals', '/people', '/listings'],
  // works leads and watches the team: the agent loop plus the exception queue; the scoreboard is a desk job (6th)
  team_lead: ['/', '/people', '/approvals', '/tasks', '/team', '/team/scoreboard'],
  // asks "how are the money and the team doing": owner view, what needs attention, the scoreboard, then deals (6th)
  owner: ['/', '/people', '/owner', '/team', '/team/scoreboard', '/deals'],
  // keeps the machine running: the two queues that need a person, who is on the team, where leads come from
  admin: ['/', '/people', '/team', '/team/lead-email', '/admin/members', '/admin/lead-sources'],
};
export const MAX_PRIMARY_DESKTOP = 6;
export const MAX_PRIMARY_PHONE = 5;

export type GroupId = 'work' | 'clients' | 'deals' | 'growth' | 'team' | 'setup' | 'comms' | 'data' | 'you';

/** Plain names, in the order they are shown. */
export const GROUPS: readonly { id: GroupId; label: string }[] = [
  { id: 'work', label: 'Work' },
  { id: 'clients', label: 'Clients' },
  { id: 'deals', label: 'Deals and listings' },
  { id: 'growth', label: 'Goals and coaching' },
  { id: 'team', label: 'Team' },
  { id: 'setup', label: 'Team settings' },
  { id: 'comms', label: 'Phone, email and AI settings' },
  { id: 'data', label: 'Data and compliance' },
  { id: 'you', label: 'You' },
];

/** Where each page of today's navigation goes when it is not one of the role's primary pages. */
export const GROUP_OF: Readonly<Record<string, GroupId>> = {
  '/': 'work',
  '/approvals': 'work',
  '/tasks': 'work',
  '/pond': 'work',
  '/duplicates': 'work',
  '/templates': 'work',
  '/bulk': 'work',
  '/people': 'clients',
  '/likely': 'clients',
  '/ai-care': 'clients',
  '/gbp': 'clients',
  '/deals': 'deals',
  '/transactions': 'deals',
  '/listings': 'deals',
  '/plan': 'growth',
  '/goals': 'growth',
  '/coaching': 'growth',
  '/coaching/trends': 'growth',
  '/team': 'team',
  '/team/lead-email': 'team',
  '/team/scoreboard': 'team',
  '/owner': 'team',
  '/ads': 'team',
  '/settings/playbooks': 'team',
  '/admin/members': 'setup',
  '/settings/team': 'setup',
  '/admin/lead-sources': 'setup',
  '/admin/routing': 'setup',
  '/admin/tags': 'setup',
  '/admin/fields': 'setup',
  '/admin/stage-labels': 'setup',
  '/admin/milestone-templates': 'setup',
  '/admin/numbers': 'comms',
  '/settings/batch-text': 'comms',
  '/admin/mail': 'comms',
  '/admin/web-chat': 'comms',
  '/admin/ai-answering': 'comms',
  '/settings/ai-assistant/team': 'comms',
  '/admin/coaching': 'comms',
  '/imports': 'data',
  '/admin/integrations': 'data',
  '/admin/integrations/mls': 'data',
  '/settings/compliance': 'data',
  '/admin/erasure': 'data',
  '/admin/system': 'data',
  '/settings/calendar': 'you',
  '/settings/ai-assistant': 'you',
  '/settings/mail': 'you',
  '/account': 'you',
};

/** A page nobody placed yet (added to the registry later) still shows: under the group its sidebar section maps to. */
const SECTION_FALLBACK: Record<NonNullable<PageNav['section']>, GroupId> = { work: 'work', team: 'team', admin: 'setup', account: 'you' };

/** The search page is opened from the search field (Enter, or "See all results"); it is not listed again. */
export const SEARCH_PATH = '/search';

export interface ExploreGroup {
  id: GroupId;
  label: string;
  items: NavItem[];
}

export interface ExploreNav {
  /** desktop: the rail (A) or the top-bar links (B), at most MAX_PRIMARY_DESKTOP */
  primary: NavItem[];
  /** desktop More: every other sidebar page, grouped; the account pages are in `account` instead */
  more: ExploreGroup[];
  /** desktop account menu: the role's own settings and Account */
  account: NavItem[];
  /** phone: bottom tabs, at most MAX_PRIMARY_PHONE (then the More tab) */
  tabs: NavItem[];
  /** phone More: every other page the phone lists today, grouped (the account pages under "You") */
  phoneMore: ExploreGroup[];
  /** every page of the role that is in some navigation: for the search field's "Pages" matches */
  all: NavItem[];
}

type NavPage = PageDef & { nav: PageNav };

function ordered(pages: readonly PageDef[]): NavPage[] {
  return pages
    .map((p, i) => ({ p, i }))
    .filter((x): x is { p: NavPage; i: number } => x.p.nav !== undefined)
    .sort((a, b) => a.p.nav.order - b.p.nav.order || a.i - b.i)
    .map((x) => x.p);
}

const item = (p: NavPage): NavItem => ({ path: p.path, label: p.nav.label ?? p.title, icon: p.nav.icon, section: p.nav.section ?? 'work' });
const groupOf = (p: NavPage): GroupId => GROUP_OF[p.path] ?? SECTION_FALLBACK[p.nav.section ?? 'work'];

function grouped(pages: readonly NavPage[]): ExploreGroup[] {
  return GROUPS.map((g) => ({ ...g, items: pages.filter((p) => groupOf(p) === g.id).map(item) })).filter((g) => g.items.length > 0);
}

/** The exploration's navigation for one role (pass `pagesFor(table, role)`). */
export function exploreNavFor(role: Role, pages: readonly PageDef[]): ExploreNav {
  const list = ordered(pages).filter((p) => p.path !== SEARCH_PATH);
  const byPath = new Map(list.map((p) => [p.path, p]));
  const pick = (max: number, where: (p: NavPage) => boolean) =>
    PRIMARY[role]
      .map((path) => byPath.get(path))
      .filter((p): p is NavPage => p !== undefined && where(p))
      .slice(0, max);

  // a page appears on a viewport only where it does today (`/bulk` is phone-only, for one)
  const onDesktop = (p: NavPage) => p.nav.desktop === 'sidebar';
  const onPhone = (p: NavPage) => p.nav.phone !== 'none';

  const primary = pick(MAX_PRIMARY_DESKTOP, onDesktop);
  const tabs = pick(MAX_PRIMARY_PHONE, onPhone);
  const restDesktop = list.filter((p) => onDesktop(p) && !primary.includes(p));
  const restPhone = list.filter((p) => onPhone(p) && !tabs.includes(p));
  return {
    primary: primary.map(item),
    more: grouped(restDesktop.filter((p) => groupOf(p) !== 'you')),
    account: restDesktop.filter((p) => groupOf(p) === 'you').map(item),
    tabs: tabs.map(item),
    phoneMore: grouped(restPhone),
    all: list.map(item),
  };
}

/**
 * Clicks (desktop) or taps (phone) to open `path` from any page: 1 for a primary page, 2 for a page under More or
 * the account menu, null when the page is not in this viewport's navigation. The search page counts as 1: the field
 * is on every page and Enter opens it.
 */
export function exploreTapsTo(nav: ExploreNav, path: string, viewport: 'phone' | 'desktop'): 1 | 2 | null {
  if (path === SEARCH_PATH) return 1;
  if (viewport === 'desktop') {
    if (nav.primary.some((i) => i.path === path)) return 1;
    return nav.account.some((i) => i.path === path) || nav.more.some((g) => g.items.some((i) => i.path === path)) ? 2 : null;
  }
  if (nav.tabs.some((i) => i.path === path)) return 1;
  return nav.phoneMore.some((g) => g.items.some((i) => i.path === path)) ? 2 : null;
}
