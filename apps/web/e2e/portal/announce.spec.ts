// module 46 (R-PORTALWEB-5, R-PORTALWEB-6, R-PORTALWEB-11): the portal's focus and its live region, in a real browser,
// against the REAL module 45 API with fakes (e2e/portal/stack.ts), on the phone (390×844) and desktop (1440×900)
// projects. b17 (b16 review): jsdom has no focus fix-up rule, and the unit tests' act() flushed the live region's clear
// and set apart, so these run where only a browser shows them:
//   FA-1  a failed Try again (a Grant panel, and HomeError) announces the same sentence again: the region is read
//         after two failures and holds it twice; the first /me's error screen keeps its focused Try again meanwhile
// Where the real stack cannot fail on cue, the browser answers with module 45's own error body (a 500 INTERNAL_ERROR).
import { type BrowserContext, type Page, type Route, expect, test } from 'playwright/test';
import { newClientContext, openLinkAndSignIn, requestLink } from './common.js';
import { type PortalStack, type PortalWorld, portalUrl, startPortalStack } from './stack.js';

test.describe.configure({ mode: 'serial' });

const GENERIC = 'Something went wrong. Try again in a moment.';
/** module 45's error body (webContract.json errors), as the API sends it */
const apiError = (status: number, code: string) => ({ status, contentType: 'application/json', body: JSON.stringify({ error: { code, requestId: '01900000-0000-7000-8000-0000000000ef' } }) });
const failed = (r: Route) => r.fulfill(apiError(500, 'INTERNAL_ERROR')).catch(() => undefined); // an aborted read (StrictMode's first) is gone
const timelineOf = (u: URL) => u.pathname === '/api/portal/timeline';
const meOf = (u: URL) => u.pathname === '/api/portal/me';

let stack: PortalStack;
let pw: PortalWorld;
let ctx: BrowserContext;
let p: Page;
let link = '';

/**
 * Every text the live region holds, recorded from the page's start (an init script, so a reload keeps recording): one
 * entry per mutation batch that touched the region. A sentence announced again shows up again.
 */
const LIVE_LOG = () => {
  const w = window as unknown as { __live: string[] };
  w.__live = [];
  new MutationObserver((records) => {
    const region = document.querySelector('[data-testid="portal-live"]');
    if (region && records.some((r) => region === r.target || region.contains(r.target))) w.__live.push(region.textContent ?? '');
  }).observe(document, { childList: true, characterData: true, subtree: true });
};
const liveLog = () => p.evaluate(() => (window as unknown as { __live: string[] }).__live.slice());
const times = async (sentence: string) => (await liveLog()).filter((t) => t === sentence).length;
/** a keyboard press on the control, so it is focused first on both projects (a tap on WebKit would not focus it) */
const press = async (name: string | RegExp, within = p.locator('main')) => {
  const b = within.getByRole('button', { name, exact: typeof name === 'string' });
  await b.focus();
  await p.keyboard.press('Enter');
  return b;
};
const section = (heading: string) => p.locator('main section').filter({ has: p.getByRole('heading', { level: 2, name: heading, exact: true }) });
const home = async () => {
  await p.goto(portalUrl(stack, pw.slug));
  await expect(p.getByRole('heading', { level: 1, name: 'Your home purchase' })).toBeVisible({ timeout: 20_000 });
};
const count = (match: (u: URL) => boolean) => {
  const seen = { n: 0 };
  p.on('request', (r) => {
    if (match(new URL(r.url()))) seen.n += 1;
  });
  return seen;
};

test.beforeAll(async ({ browser }, info) => {
  test.setTimeout(300_000);
  stack = await startPortalStack();
  await stack.world({ agents: 1 });
  pw = await stack.portalWorld();
  await stack.setCleared(true);
  const inv = await stack.api<{ grant: { id: string } }>('a.agent0', 'POST', `/deals/${pw.dealId}/portal/invite`, { contactId: pw.jane.id, idempotencyKey: 'announceinvite' + Date.now() });
  expect(inv.status, JSON.stringify(inv.body)).toBe(200);
  await stack.publishDocument(inv.body.grant.id, pw.documentId);
  await stack.jobs();
  ctx = await newClientContext(browser, info);
  await ctx.addInitScript(LIVE_LOG);
  p = await ctx.newPage();
  link = await requestLink(p, stack, pw.slug, pw.jane.email);
  await openLinkAndSignIn(p, link);
  await expect(p.getByRole('heading', { level: 1, name: 'Your home purchase' })).toBeVisible({ timeout: 20_000 });
});
test.afterAll(async () => {
  await ctx?.close().catch(() => undefined);
  await stack?.setCleared(false).catch(() => undefined);
  await stack?.stop();
});
test.afterEach(async () => {
  await p.unrouteAll({ behavior: 'ignoreErrors' });
});

test('FA-1: a Grant panel whose Try again fails again announces the same sentence again', async () => {
  await p.route(timelineOf, failed);
  const reads = count(timelineOf);
  await home();
  const tl = section('Timeline');
  await expect(tl.getByText(GENERIC)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => times(GENERIC), { message: 'the first failure is announced' }).toBe(1);
  const before = reads.n;
  const again = await press('Try again', tl);
  await expect.poll(() => reads.n, { message: 'Try again read the timeline again' }).toBeGreaterThan(before);
  await expect(again).not.toHaveAttribute('aria-disabled', 'true');
  // two failures, two announcements of the same sentence (b16: the region already held it, so nothing changed)
  await expect.poll(() => times(GENERIC), { message: 'the failed retry is announced again', timeout: 5_000 }).toBe(2);
  await expect(again).toBeFocused();
});

test('FA-1: HomeError (a first /me that fails) announces its sentence again after a failed Try again', async () => {
  await p.route(meOf, failed);
  const reads = count(meOf);
  await p.goto(portalUrl(stack, pw.slug));
  await expect(p.locator('main').getByText(GENERIC)).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => times(GENERIC)).toBe(1);
  const before = reads.n;
  const again = await press('Try again');
  await expect.poll(() => reads.n).toBeGreaterThan(before);
  await expect(again).not.toHaveAttribute('aria-disabled', 'true');
  await expect.poll(() => times(GENERIC), { message: 'the failed retry is announced again', timeout: 5_000 }).toBe(2);
  // b17: the error screen stayed while /me was read again (it was swapped for "Loading", and focus fell to <body>)
  await expect(again).toBeFocused();
});

