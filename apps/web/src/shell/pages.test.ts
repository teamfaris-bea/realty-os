// Page registry: validation, the page table, role filtering, navigation and tap counts.
// The tap-count assertions are the automated proxy for "every primary job reachable in ≤ 2 taps"
// (BUILD_PLAN module 17); the per-job FUB benchmarks are asserted by each surface's e2e spec.
import { ROLES } from '@realty/core/foundation';
import { describe, expect, it } from 'vitest';
import { MAX_PHONE_TABS, activeNavPath, buildPageTable, canOpen, navFor, pagesFor, tapsTo, validateRegistry } from './pages.js';
import { surfaces } from './registry.js';
import { homeFallback, shellSurface } from './shellSurface.js';
import type { PageDef, SurfaceModule } from './types.js';

const C = () => null;
const page = (path: string, nav?: PageDef['nav'], roles: PageDef['roles'] = 'all'): PageDef => ({ path, title: path, roles, component: C, ...(nav ? { nav } : {}) });
const tab = (order: number, extra: Partial<NonNullable<PageDef['nav']>> = {}) => ({ phone: 'tab' as const, desktop: 'sidebar' as const, icon: 'feed' as const, order, ...extra });

describe('the real registry', () => {
  it('has no duplicate paths, conflicting error sentences or evidence openers', () => {
    expect(validateRegistry(surfaces)).toEqual([]);
  });

  it('puts every nav page within 2 taps on a phone and 1 click on desktop, for every role', () => {
    const table = buildPageTable(surfaces, homeFallback);
    for (const role of ROLES) {
      const pages = pagesFor(table, role);
      const nav = navFor(pages);
      expect(nav.tabs.length).toBeLessThanOrEqual(MAX_PHONE_TABS);
      for (const p of pages.filter((x) => x.nav)) {
        if (p.nav!.phone !== 'none') expect(tapsTo(nav, p.path, 'phone'), `${role} ${p.path} phone`).not.toBeNull();
        if (p.nav!.phone !== 'none') expect(tapsTo(nav, p.path, 'phone')!).toBeLessThanOrEqual(2);
        if (p.nav!.desktop === 'sidebar') expect(tapsTo(nav, p.path, 'desktop'), `${role} ${p.path} desktop`).toBe(1);
      }
      // the account (and sign out) is always reachable
      expect(tapsTo(nav, '/account', 'phone')).toBe(2);
      expect(tapsTo(nav, '/account', 'desktop')).toBe(1);
    }
  });

  it('home is the shell fallback only while no surface registers "/"', () => {
    expect(buildPageTable([shellSurface], homeFallback).pages.find((p) => p.path === '/')).toBe(homeFallback);
    const feed = page('/', tab(0));
    const t = buildPageTable([shellSurface, { pages: [feed] }], homeFallback);
    expect(t.pages.filter((p) => p.path === '/')).toEqual([feed]);
  });
});

describe('validateRegistry', () => {
  it('reports duplicate paths (param names do not matter)', () => {
    const a: SurfaceModule = { pages: [page('/contacts/:id')] };
    const b: SurfaceModule = { pages: [page('/contacts/:contactId')] };
    expect(validateRegistry([a, b])).toEqual(['surface #1: path "/contacts/:contactId" is already registered by surface #0']);
  });

  it('reports relative paths, empty role lists, missing titles and nav that shows nowhere', () => {
    const s: SurfaceModule = {
      pages: [page('feed'), page('/x', undefined, []), { ...page('/y'), title: ' ' }, page('/z', { phone: 'none', desktop: 'none', icon: 'feed', order: 1 })],
    };
    const p = validateRegistry([s]);
    expect(p).toHaveLength(4);
    expect(p.join('\n')).toMatch(/must be absolute[\s\S]*allows no role[\s\S]*has no title[\s\S]*appears nowhere/);
  });

  it('reports error sentences that conflict, are empty, show a raw code, or use a bad key', () => {
    const a: SurfaceModule = { pages: [], errorMessages: { LEAD_ALREADY_CLAIMED: 'Someone else claimed this lead first.' } };
    const b: SurfaceModule = {
      pages: [],
      errorMessages: { LEAD_ALREADY_CLAIMED: 'Too late.', DRAFT_STALE: ' ', lower_case: 'x', LEAD_OFFER_EXPIRED: 'Failed: LEAD_OFFER_EXPIRED' },
    };
    const p = validateRegistry([a, b]).join('\n');
    expect(p).toContain('"LEAD_ALREADY_CLAIMED" conflicts with surface #0');
    expect(p).toContain('"DRAFT_STALE" has an empty sentence');
    expect(p).toContain('"lower_case" is not a CODE');
    expect(p).toContain('"LEAD_OFFER_EXPIRED" sentence shows a raw code');
  });

  it('reports two surfaces opening the same evidence source type', () => {
    const a: SurfaceModule = { pages: [], evidenceRoutes: { call: () => '/a' } };
    const b: SurfaceModule = { pages: [], evidenceRoutes: { call: () => '/b' } };
    expect(validateRegistry([a, b])).toEqual(['surface #1: evidence source "call" is already opened by surface #0']);
  });
});

describe('buildPageTable', () => {
  it('first registration of a path wins; messages and evidence openers merge first-wins', () => {
    const one = page('/search', tab(1));
    const two = page('/search', tab(2));
    const t = buildPageTable([
      { pages: [one], errorMessages: { X_CODE: 'first' }, evidenceRoutes: { call: () => '/one' } },
      { pages: [two], errorMessages: { X_CODE: 'second', Y_CODE: 'y' }, evidenceRoutes: { call: () => '/two', message: () => '/m' } },
    ]);
    expect(t.pages).toEqual([one]);
    expect(t.errorMessages).toEqual({ X_CODE: 'first', Y_CODE: 'y' });
    expect(t.evidenceRoutes.call?.({ sourceType: 'call', sourceId: 'x' })).toBe('/one');
    expect(t.evidenceRoutes.message?.({ sourceType: 'message', sourceId: 'x' })).toBe('/m');
  });
});

describe('roles', () => {
  it('a page restricted to some roles is not opened, routed in nav, or counted for others', () => {
    const team = page('/team', { phone: 'more', desktop: 'sidebar', icon: 'team', order: 50, section: 'team' }, ['owner', 'admin', 'team_lead']);
    const t = buildPageTable([shellSurface, { pages: [team] }], homeFallback);
    expect(canOpen(team, 'agent')).toBe(false);
    expect(canOpen(team, 'team_lead')).toBe(true);
    expect(tapsTo(navFor(pagesFor(t, 'agent')), '/team', 'desktop')).toBeNull();
    expect(tapsTo(navFor(pagesFor(t, 'team_lead')), '/team', 'desktop')).toBe(1);
    expect(tapsTo(navFor(pagesFor(t, 'team_lead')), '/team', 'phone')).toBe(2);
  });
});

describe('navFor', () => {
  it('keeps at most MAX_PHONE_TABS (5) phone tabs (by order, ties in registry order) and moves the overflow to More', () => {
    const pages = [page('/e', tab(5)), page('/a', tab(1)), page('/b', tab(2)), page('/c', tab(2)), page('/d', tab(4)), page('/f', tab(6)), page('/m', { phone: 'more', desktop: 'sidebar', icon: 'settings', order: 3 })];
    const nav = navFor(pages);
    expect(MAX_PHONE_TABS).toBe(5);
    expect(nav.tabs.map((t) => t.path)).toEqual(['/a', '/b', '/c', '/d', '/e']);
    expect(nav.more.map((t) => t.path)).toEqual(['/m', '/f']);
    expect(tapsTo(nav, '/f', 'phone')).toBe(2);
    expect(tapsTo(nav, '/a', 'phone')).toBe(1);
  });

  it('groups the desktop sidebar work → team → admin → account and skips empty groups', () => {
    const pages = [
      page('/acct', { phone: 'more', desktop: 'sidebar', icon: 'person', order: 9, section: 'account' }),
      page('/admin', { phone: 'more', desktop: 'sidebar', icon: 'settings', order: 1, section: 'admin' }),
      page('/', tab(0)),
      page('/phone-only', { phone: 'tab', desktop: 'none', icon: 'feed', order: 2 }),
    ];
    const nav = navFor(pages);
    expect(nav.sidebar.map((g) => [g.section, g.items.map((i) => i.path)])).toEqual([
      ['work', ['/']],
      ['admin', ['/admin']],
      ['account', ['/acct']],
    ]);
    expect(tapsTo(nav, '/phone-only', 'desktop')).toBeNull();
    expect(tapsTo(nav, '/phone-only', 'phone')).toBe(1);
  });

  it('labels default to the page title', () => {
    expect(navFor([page('/x', tab(1))]).tabs[0]?.label).toBe('/x');
    expect(navFor([page('/x', tab(1, { label: 'Feed' }))]).tabs[0]?.label).toBe('Feed');
  });
});

describe('activeNavPath', () => {
  it('marks the deepest matching nav entry; "/" only matches exactly', () => {
    const items = [
      { path: '/', label: 'Home', icon: 'home' as const, section: 'work' as const },
      { path: '/contacts', label: 'Contacts', icon: 'people' as const, section: 'work' as const },
    ];
    expect(activeNavPath(items, '/')).toBe('/');
    expect(activeNavPath(items, '/contacts/123')).toBe('/contacts');
    expect(activeNavPath(items, '/contactsx')).toBeNull();
    expect(activeNavPath(items, '/account')).toBeNull();
  });
});
