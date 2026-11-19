// Navigation exploration: the pure model. The obligations: the current navigation stays the default; for every role
// nothing that is in today's navigation becomes unreachable in A or B, on desktop or on the phone; nothing is listed
// twice; the primary lists are short; every page has been given a group on purpose.
import { ROLES } from '@realty/core/foundation';
import { describe, expect, it } from 'vitest';
import { GROUPS, GROUP_OF, MAX_PRIMARY_DESKTOP, MAX_PRIMARY_PHONE, NAV_MODE_KEY, PRIMARY, SEARCH_PATH, exploreNavFor, exploreTapsTo, resolveNavMode } from './exploreNavModel.js';
import { buildPageTable, navFor, pagesFor } from './pages.js';
import { surfaces } from './registry.js';
import { homeFallback } from './shellSurface.js';

const table = buildPageTable(surfaces, homeFallback);

function memoryStorage(initial: Record<string, string> = {}) {
  const m = new Map(Object.entries(initial));
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), dump: () => Object.fromEntries(m) };
}

describe('which navigation', () => {
  it('is the current one unless asked: no parameter and nothing remembered', () => {
    expect(resolveNavMode('', memoryStorage())).toBe('current');
    expect(resolveNavMode('?filter=open', memoryStorage())).toBe('current');
    expect(resolveNavMode('', null)).toBe('current');
  });

  it('?nav=a and ?nav=b switch and are remembered; ?nav=current goes back', () => {
    const s = memoryStorage();
    expect(resolveNavMode('?nav=a', s)).toBe('a');
    expect(s.dump()).toEqual({ [NAV_MODE_KEY]: 'a' });
    expect(resolveNavMode('', s)).toBe('a');
    expect(resolveNavMode('?x=1&nav=b', s)).toBe('b');
    expect(resolveNavMode('', s)).toBe('b');
    expect(resolveNavMode('?nav=current', s)).toBe('current');
    expect(resolveNavMode('', s)).toBe('current');
  });

  it('ignores anything else, in the address or remembered', () => {
    expect(resolveNavMode('?nav=c', memoryStorage())).toBe('current');
    expect(resolveNavMode('', memoryStorage({ [NAV_MODE_KEY]: 'sidebar' }))).toBe('current');
    const s = memoryStorage({ [NAV_MODE_KEY]: 'b' });
    expect(resolveNavMode('?nav=nope', s)).toBe('b');
  });

  it('still switches for the page when storage refuses', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(resolveNavMode('?nav=a', broken)).toBe('a');
    expect(resolveNavMode('', broken)).toBe('current');
  });
});

describe.each(ROLES)('the exploration navigation for %s', (role) => {
  const pages = pagesFor(table, role);
  const today = navFor(pages);
  const nav = exploreNavFor(role, pages);
  const desktopToday = today.sidebar.flatMap((g) => g.items.map((i) => i.path));
  const phoneToday = [...today.tabs, ...today.more].map((i) => i.path);
  const desktopNow = [...nav.primary, ...nav.more.flatMap((g) => g.items), ...nav.account].map((i) => i.path);
  const phoneNow = [...nav.tabs, ...nav.phoneMore.flatMap((g) => g.items)].map((i) => i.path);

  it('keeps every page of today’s sidebar reachable on desktop, in at most 2 clicks, and lists none twice', () => {
    expect([...desktopNow, SEARCH_PATH].sort()).toEqual([...desktopToday].sort());
    expect(new Set(desktopNow).size).toBe(desktopNow.length);
    for (const p of desktopToday) expect(exploreTapsTo(nav, p, 'desktop'), p).not.toBeNull();
  });

  it('keeps every page of today’s tabs and More reachable on the phone, in at most 2 taps, and lists none twice', () => {
    expect([...phoneNow, SEARCH_PATH].sort()).toEqual([...phoneToday].sort());
    expect(new Set(phoneNow).size).toBe(phoneNow.length);
    for (const p of phoneToday) expect(exploreTapsTo(nav, p, 'phone'), p).not.toBeNull();
  });

  it('shows the pages named for the role, at most six on desktop and five on the phone, the phone’s being the first of the desktop’s', () => {
    expect(nav.primary.map((i) => i.path)).toEqual(PRIMARY[role].slice(0, MAX_PRIMARY_DESKTOP));
    expect(nav.tabs.map((i) => i.path)).toEqual(PRIMARY[role].slice(0, MAX_PRIMARY_PHONE));
    expect(nav.primary.length).toBeGreaterThanOrEqual(5);
    // a primary page is one the role may open (a path that left the registry, or the role, would shorten the list)
    expect(nav.primary).toHaveLength(Math.min(PRIMARY[role].length, MAX_PRIMARY_DESKTOP));
  });

  it('the account menu holds the role’s own settings and Account; the phone lists them under You', () => {
    expect(nav.account.map((i) => i.path)).toContain('/account');
    expect(nav.phoneMore.find((g) => g.id === 'you')?.items.map((i) => i.path)).toEqual(nav.account.map((i) => i.path));
    expect(exploreTapsTo(nav, '/account', 'desktop')).toBe(2);
    expect(exploreTapsTo(nav, '/account', 'phone')).toBe(2);
  });

  it('groups are in the fixed order, none empty, none longer than eight entries', () => {
    const order = GROUPS.map((g) => g.id);
    for (const groups of [nav.more, nav.phoneMore]) {
      expect(groups.map((g) => g.id)).toEqual(order.filter((id) => groups.some((g) => g.id === id)));
      for (const g of groups) {
        expect(g.items.length, g.label).toBeGreaterThan(0);
        expect(g.items.length, g.label).toBeLessThanOrEqual(8);
      }
    }
  });
});

describe('placement is deliberate', () => {
  it('every page in any role’s navigation today has a group of its own choosing (the fallback is for pages added later)', () => {
    const inNav = table.pages.filter((p) => p.nav && p.path !== SEARCH_PATH).map((p) => p.path);
    expect(inNav.filter((p) => !Object.hasOwn(GROUP_OF, p))).toEqual([]);
    // and no entry is left over for a page that no longer exists
    expect(Object.keys(GROUP_OF).filter((p) => !inNav.includes(p))).toEqual([]);
  });

  it('a page nobody placed still shows, under the group of its sidebar section', () => {
    const C = () => null;
    const extra = { path: '/brand-new', title: 'Brand new', roles: 'all' as const, component: C, nav: { phone: 'more' as const, desktop: 'sidebar' as const, icon: 'info' as const, order: 5, section: 'team' as const } };
    const nav = exploreNavFor('agent', [...pagesFor(table, 'agent'), extra]);
    expect(nav.more.find((g) => g.id === 'team')?.items.map((i) => i.path)).toContain('/brand-new');
    expect(nav.phoneMore.find((g) => g.id === 'team')?.items.map((i) => i.path)).toContain('/brand-new');
  });
});
