// Navigation exploration in jsdom (fake API): the current navigation stays the default; ?nav=a / ?nav=b switch and
// are remembered; the top-bar search shows only what the API returned, by keyboard; More and the account menu are
// disclosures; both directions pass axe. (jsdom applies no CSS, so the phone's and the desktop's pieces are both in
// the document here: queries are scoped to the piece under test.)
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NAV_MODE_KEY } from './exploreNavModel.js';
import { FakeFetch, renderApp, sessionFixture, tableWith } from './testing/fakeApi.js';
import type { PageDef, SurfaceModule } from './types.js';

const body = (text: string) => () => <p>{text}</p>;
const nav = (order: number, icon: NonNullable<PageDef['nav']>['icon'], extra: Partial<NonNullable<PageDef['nav']>> = {}) => ({ phone: 'more' as const, desktop: 'sidebar' as const, icon, order, ...extra });
const testSurface: SurfaceModule = {
  pages: [
    { path: '/people', title: 'People', roles: 'all', nav: nav(5, 'people', { phone: 'tab' }), component: body('people page body') },
    { path: '/approvals', title: 'Approvals', roles: 'all', nav: nav(10, 'inbox', { phone: 'tab' }), component: body('approvals page body') },
    { path: '/search', title: 'Search', roles: 'all', nav: nav(20, 'search', { phone: 'tab' }), component: body('search page body') },
    { path: '/tasks', title: 'Tasks', roles: 'all', nav: nav(30, 'checklist', { phone: 'tab' }), component: body('tasks page body') },
    { path: '/deals', title: 'Deals', roles: 'all', nav: nav(40, 'deal'), component: body('deals page body') },
    { path: '/templates', title: 'Templates', roles: 'all', nav: nav(50, 'checklist'), component: body('templates page body') },
    { path: '/team/scoreboard', title: 'Scoreboard', roles: 'all', nav: nav(60, 'team', { section: 'team' }), component: body('scoreboard page body') },
    { path: '/settings/calendar', title: 'Calendar', roles: 'all', nav: nav(900, 'calendar', { section: 'account' }), component: body('calendar page body') },
    { path: '/contacts/:id', title: 'Contact', roles: 'all', component: body('contact page body') },
    { path: '/deals/:id', title: 'Deal', roles: 'all', component: body('deal page body') },
  ],
};
const table = tableWith(testSurface);
const session = { status: 200, body: sessionFixture() };

const MAR = {
  contacts: [
    { id: 'c1', name: 'Mara Ellison', view: 'full', ownershipState: 'owned', matchedOn: 'name' },
    { id: 'c2', name: 'Ivy M.', view: 'card', ownershipState: 'in_pond', matchedOn: 'name' },
    { id: 'c3', name: 'Maren Castellano', view: 'full', ownershipState: 'owned', matchedOn: 'phone' },
  ],
  listings: [{ id: 'l1', address: '214 Marigold Lane', city: 'Fairhaven', status: 'active', listPriceCents: 72_500_000 }],
  deals: [{ id: 'd1', name: 'Mara Ellison: Marlow Court purchase', stage: 'prospect' }],
  notes: [{ id: 'n1', contactId: 'c1', dealId: null, snippet: 'Marlow Court showing', createdAt: '2026-11-01T10:00:00.000Z' }],
  messages: [],
  incomplete: [],
};
const NONE = { contacts: [], listings: [], deals: [], notes: [], messages: [], incomplete: [] };

const bar = () => within(document.querySelector<HTMLElement>('[data-search="bar"]')!);
const field = () => bar().getByRole('combobox', { name: 'Search people, deals and listings' });
const mainNav = () => within(screen.getByRole('navigation', { name: 'Main' }));

/** What the stylesheet does at each width (jsdom applies none): the other width's pieces are not rendered. */
function asViewport(v: 'desktop' | 'phone') {
  const hide = v === 'desktop' ? ['[data-search="compact"]', 'nav[aria-label="Main tabs"]'] : ['[data-nav] > aside', '[data-nav] > div > header'];
  for (const sel of hide) for (const e of document.querySelectorAll<HTMLElement>(sel)) (sel.includes('data-search') ? e.parentElement! : e).hidden = true;
}

async function axeViolations(): Promise<string[]> {
  const r = await axe.run(document.body, { rules: { 'color-contrast': { enabled: false } }, resultTypes: ['violations'] });
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

beforeEach(() => {
  window.localStorage.clear();
  window.sessionStorage.clear();
});
afterEach(() => {
  window.localStorage.clear();
});

describe('the default', () => {
  it('is the current navigation: the sidebar lists every page with Search among them, and there is no search field in a top bar', async () => {
    renderApp({ fake: new FakeFetch().on('GET /auth/session', session), table });
    expect(await screen.findByRole('heading', { level: 1, name: 'Home' })).toBeInTheDocument();
    expect(mainNav().getByRole('link', { name: 'Search' })).toBeInTheDocument();
    expect(mainNav().getByRole('link', { name: 'Templates' })).toBeInTheDocument();
    expect(mainNav().queryByRole('button', { name: 'More' })).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(document.querySelector('[data-nav]')).toBeNull();
    expect(window.localStorage.getItem(NAV_MODE_KEY)).toBeNull();
  });
});

describe.each([
  ['a', 'Slim rail'],
  ['b', 'Top bar'],
] as const)('?nav=%s (%s)', (mode, _name) => {
  it('shows only the role’s primary pages at rest, everything else under More in named groups, the own settings in the account menu', async () => {
    renderApp({ fake: new FakeFetch().on('GET /auth/session', session), table, path: `/people?nav=${mode}` });
    expect(await screen.findByText('people page body')).toBeInTheDocument();
    expect(document.querySelector('[data-nav]')?.getAttribute('data-nav')).toBe(mode);
    expect(mainNav().getAllByRole('link').map((l) => l.textContent)).toEqual(expect.arrayContaining(['Home', 'People', 'Approvals', 'Tasks', 'Deals']));
    expect(mainNav().queryByRole('link', { name: 'Search' })).toBeNull();
    expect(mainNav().getByRole('link', { name: 'People' })).toHaveAttribute('aria-current', 'page');
    // closed: the pages under More are not exposed
    expect(mainNav().queryByRole('link', { name: 'Templates' })).toBeNull();

    const more = mainNav().getByRole('button', { name: /^More/ });
    expect(more).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    const work = screen.getByRole('list', { name: 'Work' });
    expect(within(work).getByRole('link', { name: 'Templates' })).toHaveAttribute('href', '/templates');
    expect(within(screen.getByRole('list', { name: 'Team' })).getByRole('link', { name: 'Scoreboard' })).toBeInTheDocument();
    // the panel comes right after its button: Tab walks into it
    more.focus();
    await userEvent.tab();
    expect(document.activeElement?.closest('[id]')?.id ?? '').not.toBe('');
    expect(document.getElementById(more.getAttribute('aria-controls')!)!.contains(document.activeElement)).toBe(true);
    await userEvent.keyboard('{Escape}');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(more).toHaveFocus();

    const account = screen.getByRole('button', { name: 'Account menu, Ava Agent' });
    await userEvent.click(account);
    const own = within(screen.getByRole('list', { name: 'Your settings' }));
    expect(own.getAllByRole('link').map((l) => l.textContent)).toEqual(['Calendar', 'Account']);
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    await userEvent.click(more);
    asViewport('desktop');
    expect(await axeViolations()).toEqual([]);
  });

  it('is remembered on the next page, and the preview switch goes back to the current navigation', async () => {
    const { router } = renderApp({ fake: new FakeFetch().on('GET /auth/session', session), table, path: `/?nav=${mode}` });
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    expect(window.localStorage.getItem(NAV_MODE_KEY)).toBe(mode);
    await userEvent.click(mainNav().getByRole('link', { name: 'Tasks' }));
    expect(await screen.findByText('tasks page body')).toBeInTheDocument();
    expect(router.state.location.search).toBe('');
    expect(document.querySelector('[data-nav]')?.getAttribute('data-nav')).toBe(mode);
    await userEvent.click(screen.getByRole('button', { name: 'Account menu, Ava Agent' }));
    await userEvent.click(screen.getByRole('button', { name: 'Current navigation' }));
    expect(document.querySelector('[data-nav]')).toBeNull();
    expect(mainNav().getByRole('link', { name: 'Search' })).toBeInTheDocument();
    expect(window.localStorage.getItem(NAV_MODE_KEY)).toBe('current');
  });

  it('a page under More marks More and carries aria-current in the panel', async () => {
    renderApp({ fake: new FakeFetch().on('GET /auth/session', session), table, path: `/templates?nav=${mode}` });
    expect(await screen.findByText('templates page body')).toBeInTheDocument();
    await userEvent.click(mainNav().getByRole('button', { name: /^More/ }));
    expect(within(screen.getByRole('list', { name: 'Work' })).getByRole('link', { name: 'Templates' })).toHaveAttribute('aria-current', 'page');
    expect(mainNav().getByRole('link', { name: 'People' })).not.toHaveAttribute('aria-current');
  });

  it('search: results as you type, only what the API returned, people first; Down and Enter open a row', async () => {
    const fake = new FakeFetch().on('GET /auth/session', session).on('GET /search?q=mar', { status: 200, body: MAR });
    const { router } = renderApp({ fake, table, path: `/?nav=${mode}` });
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    expect(field()).toHaveAttribute('aria-expanded', 'false');
    await userEvent.type(field(), 'm');
    expect(bar().getByRole('status')).toHaveTextContent('Type at least 2 characters.');
    expect(fake.calls.filter((c) => c.path.startsWith('/search'))).toEqual([]);
    await userEvent.type(field(), 'ar');
    const list = await bar().findByRole('listbox', { name: 'Search results' });
    await waitFor(() => expect(within(list).getAllByRole('option').length).toBeGreaterThan(1));
    expect(field()).toHaveAttribute('aria-expanded', 'true');
    const rows = within(list)
      .getAllByRole('option')
      .map((o) => o.textContent);
    expect(rows).toEqual([
      'Mara EllisonMatched on name',
      'Ivy M.Pond or offer lead · claim or accept to see details',
      'Maren CastellanoMatched on phone',
      'Mara Ellison: Marlow Court purchaseProspect',
      '214 Marigold LaneFairhaven · active · $725,000',
      'See all results for “mar”Also 1 in messages and notes',
    ]);
    expect(within(list).getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['People', 'Deals', 'Listings']);
    // no phone number, no email address: the API returned neither
    expect(list.textContent).not.toMatch(/@|\d{3}[-. ]\d{4}/);
    // the first row is ready; Down moves to the second; Enter opens it
    await waitFor(() => expect(within(list).getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true'));
    expect(field()).toHaveAttribute('aria-activedescendant', within(list).getAllByRole('option')[0]!.id);
    await userEvent.keyboard('{ArrowDown}');
    expect(within(list).getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/contacts/c2'));
    expect(await screen.findByText('contact page body')).toBeInTheDocument();
    expect(field()).toHaveValue('');
    expect(fake.calls.filter((c) => c.path.startsWith('/search')).map((c) => c.path)).toEqual(['/search?q=mar']);
  });

  it('search: "/" and Ctrl+K focus the field; Up from the first row reaches "See all results", which opens the Search page with the words', async () => {
    const fake = new FakeFetch().on('GET /auth/session', session).on('GET /search?q=mar', { status: 200, body: MAR });
    const { router } = renderApp({ fake, table, path: `/?nav=${mode}` });
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    await userEvent.keyboard('/');
    expect(field()).toHaveFocus();
    expect(field()).toHaveValue('');
    field().blur();
    await userEvent.keyboard('{Control>}k{/Control}');
    expect(field()).toHaveFocus();
    await userEvent.keyboard('mar');
    const list = await bar().findByRole('listbox', { name: 'Search results' });
    await waitFor(() => expect(within(list).getAllByRole('option')[0]).toHaveAttribute('aria-selected', 'true'));
    await userEvent.keyboard('{ArrowUp}');
    expect(within(list).getAllByRole('option').at(-1)).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.pathname + router.state.location.search).toBe('/search?q=mar'));
    expect(await screen.findByText('search page body')).toBeInTheDocument();
  });

  it('search: a "/" typed into another field stays there; Escape closes the list, then clears; no match says so; a page matches by name', async () => {
    const fake = new FakeFetch().on('GET /auth/session', session).on('GET /search?q=zzz', { status: 200, body: NONE }).on('GET /search?q=templ', { status: 200, body: NONE });
    const { router } = renderApp({ fake, table, path: `/?nav=${mode}` });
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    await userEvent.type(field(), 'zzz');
    await waitFor(() => expect(bar().getByRole('status')).toHaveTextContent('No matches for “zzz”.'));
    expect(bar().queryAllByRole('option')).toEqual([]);
    await userEvent.keyboard('{Escape}');
    expect(field()).toHaveAttribute('aria-expanded', 'false');
    expect(field()).toHaveValue('zzz');
    await userEvent.keyboard('/');
    expect(field()).toHaveValue('zzz/');
    await userEvent.keyboard('{Escape}{Escape}');
    expect(field()).toHaveValue('');
    await userEvent.type(field(), 'templ');
    const option = await bar().findByRole('option', { name: /Templates/ });
    expect(within(bar().getByRole('listbox')).getAllByRole('group').map((g) => g.getAttribute('aria-label'))).toEqual(['Pages']);
    await waitFor(() => expect(option).toHaveAttribute('aria-selected', 'true'));
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/templates'));
  });

  it('search: a failed search says so in a sentence and shows no rows', async () => {
    const fake = new FakeFetch().on('GET /auth/session', session).on('GET /search?q=mar', { status: 500, body: { error: { code: 'INTERNAL', requestId: 'r' } } });
    renderApp({ fake, table, path: `/?nav=${mode}` });
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    await userEvent.type(field(), 'mar');
    await waitFor(() => expect(bar().getByRole('status').textContent).toMatch(/Try again/));
    expect(bar().queryAllByRole('option').map((o) => o.textContent)).toEqual([]);
    expect(document.body.textContent).not.toMatch(/INTERNAL/);
  });
});

describe('the phone pieces', () => {
  it('the tab bar holds the primary pages and More, no Search tab; A opens More as a sheet, B links to the More page', async () => {
    renderApp({ fake: new FakeFetch().on('GET /auth/session', session), table, path: '/?nav=a' });
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    const tabs = within(screen.getByRole('navigation', { name: 'Main tabs' }));
    expect(tabs.getAllByRole('link').map((l) => l.textContent)).toEqual(['Home', 'People', 'Approvals', 'Tasks', 'Deals']);
    await userEvent.click(tabs.getByRole('button', { name: 'More' }));
    const sheet = within(await screen.findByRole('dialog', { name: 'More' }));
    expect(sheet.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['More', 'Work', 'Team', 'You']);
    expect(within(sheet.getByRole('list', { name: 'You' })).getAllByRole('link').map((l) => l.textContent)).toEqual(['Calendar', 'Account']);
    asViewport('phone');
    expect(await axeViolations()).toEqual([]);
    await userEvent.click(sheet.getByRole('link', { name: 'Templates' }));
    expect(await screen.findByText('templates page body')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('B: the More page lists the same groups', async () => {
    renderApp({ fake: new FakeFetch().on('GET /auth/session', session), table, path: '/more?nav=b' });
    const more = within(await screen.findByRole('navigation', { name: 'More' }));
    expect(more.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual(['Work', 'Team', 'You']);
    expect(within(screen.getByRole('navigation', { name: 'Main tabs' })).getByRole('link', { name: 'More' })).toHaveAttribute('aria-current', 'page');
  });

  it('the page’s top bar holds the compact search field, which grows with Cancel when it is used', async () => {
    const fake = new FakeFetch().on('GET /auth/session', session).on('GET /search?q=mar', { status: 200, body: MAR });
    const { router } = renderApp({ fake, table, path: '/?nav=a' });
    await screen.findByRole('heading', { level: 1, name: 'Home' });
    const compact = within(document.querySelector<HTMLElement>('[data-search="compact"]')!);
    const input = compact.getByRole('combobox', { name: 'Search people, deals and listings' });
    expect(compact.queryByRole('button', { name: 'Cancel' })).toBeNull();
    await userEvent.click(input);
    expect(compact.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
    await userEvent.type(input, 'mar');
    await userEvent.click(await compact.findByRole('option', { name: /Maren Castellano/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/contacts/c3'));
  });
});
