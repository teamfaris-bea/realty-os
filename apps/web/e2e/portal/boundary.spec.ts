// module 46 (R-PORTALWEB-1, R-PORTALWEB-2, R-PORTALWEB-3, R-PORTALWEB-9; E700, E703, E717, E148): the trust boundary
// in a real browser. A staff browser on /portal.html calls only /api/portal/* and its staff tab is unaffected; a
// client on / or /portal gets the staff sign-in; the token is in no URL, Referer, storage or history entry, also when
// the link is opened in a tab already on the portal (read in place, b15 audit P46-SEC-2); a visit that runs the page's
// script without a tap (a scanner, a preview) leaves the link valid.
import { type Request, expect, test } from 'playwright/test';
import { signIn, tap } from '../journeys/helpers.js';
import type { WorldInfo } from '../journeys/stack.js';
import { newClientContext, openLinkAndSignIn, requestLink } from './common.js';
import { type PortalStack, type PortalWorld, portalUrl, startPortalStack } from './stack.js';

test.describe.configure({ mode: 'serial' });

let stack: PortalStack;
let w: WorldInfo;
let pw: PortalWorld;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startPortalStack();
  w = await stack.world({ agents: 1 });
  pw = await stack.portalWorld();
  await stack.setCleared(true);
  // b15 audit F9: a failed invite fails here, not later as "no sign-in link reached the fake email"
  const inv = await stack.api('a.agent0', 'POST', `/deals/${pw.dealId}/portal/invite`, { contactId: pw.jane.id, idempotencyKey: 'e2einvite' + Date.now() });
  expect(inv.status, JSON.stringify(inv.body)).toBe(200);
});
test.afterAll(async () => {
  await stack?.setCleared(false).catch(() => undefined);
  await stack?.stop();
});

test('E717: a staff browser on /portal.html calls only /api/portal/*; the staff tab still works; the staff session is not the portal\'s', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, stack, w.agents[0]!);
  const portal = await page.context().newPage();
  const apis: string[] = [];
  portal.on('request', (r) => {
    const p = new URL(r.url()).pathname;
    if (p.startsWith('/api/')) apis.push(p);
  });
  await portal.goto(portalUrl(stack, pw.slug));
  await expect(portal.getByRole('heading', { level: 1, name: 'Sign in to your client portal' })).toBeVisible({ timeout: 20_000 });
  expect(apis.length).toBeGreaterThan(0);
  expect(apis.filter((p) => !p.startsWith('/api/portal/'))).toEqual([]);
  await page.goto(`${stack.webUrl}/deals/${pw.dealId}`);
  await expect(page.getByRole('heading', { level: 1, name: pw.dealName })).toBeVisible({ timeout: 20_000 });
});

test('E717: Jane, signed in to the portal, on / and on /portal gets the staff sign-in, never the portal; her portal session answers no staff route', async ({ browser }, info) => {
  test.setTimeout(180_000);
  // b15 audit F4: Jane is signed in first (her portal cookie is in this context: __Host-psid, or psid on plain-http
  // dev), so the staff sign-in is not trivially what a cookie-less browser gets
  const ctx = await newClientContext(browser, info);
  const p = await ctx.newPage();
  const link = await requestLink(p, stack, pw.slug, pw.jane.email);
  await openLinkAndSignIn(p, link);
  await expect(p.getByRole('heading', { level: 1, name: 'Your home purchase' })).toBeVisible({ timeout: 20_000 });
  expect((await ctx.cookies()).map((c) => c.name).filter((n) => n === '__Host-psid' || n === 'psid')).toHaveLength(1);
  const staffAnswers: { path: string; status: number }[] = [];
  p.on('response', (r) => {
    const path = new URL(r.url()).pathname;
    if (path.startsWith('/api/') && !path.startsWith('/api/portal/')) staffAnswers.push({ path, status: r.status() });
  });
  for (const path of ['/', '/portal']) {
    await p.goto(stack.webUrl + path);
    await expect(p.getByLabel('Password'), path).toBeVisible({ timeout: 20_000 });
    await expect(p.getByRole('heading', { name: 'Sign in to your client portal' })).toHaveCount(0);
    await expect(p.getByRole('heading', { name: 'Your home purchase' })).toHaveCount(0);
  }
  expect(staffAnswers.filter((a) => a.path === '/api/auth/session').length).toBeGreaterThan(0);
  expect(staffAnswers.filter((a) => a.path === '/api/auth/session' && a.status === 200)).toEqual([]);
  // the portal session is still hers: back on the portal she is still signed in
  await p.goto(portalUrl(stack, pw.slug));
  await expect(p.getByRole('heading', { level: 1, name: 'Your home purchase' })).toBeVisible({ timeout: 20_000 });
  await ctx.close();
});

test('E703, E700: the token is in no URL, Referer, storage or history entry; a scripted visit with no tap leaves the link valid', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const asker = await newClientContext(browser, info);
  const link = await requestLink(await asker.newPage(), stack, pw.slug, pw.jane.email);
  await asker.close();
  const token = /#token=([A-Za-z0-9_-]{43})/.exec(link)![1]!;

  // a scanner or preview: loads the page, runs its script, never taps
  const scanner = await newClientContext(browser, info);
  const sp = await scanner.newPage();
  const scannerPosts: string[] = [];
  sp.on('request', (r) => r.method() === 'POST' && scannerPosts.push(r.url()));
  await sp.goto(link);
  await expect(sp.getByRole('button', { name: 'Sign in' })).toBeVisible({ timeout: 20_000 });
  await sp.waitForTimeout(1500);
  expect(scannerPosts).toEqual([]);
  await scanner.close();

  // Jane: the link still works; the token never shows in a URL, a Referer, storage or the history entry
  const ctx = await newClientContext(browser, info);
  const jane = await ctx.newPage();
  const seen: Request[] = [];
  jane.on('request', (r) => seen.push(r));
  await jane.goto(link);
  await expect(jane.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible({ timeout: 20_000 });
  expect(jane.url()).not.toContain(token);
  expect(await jane.evaluate(() => location.href + '|' + JSON.stringify(history.state))).not.toContain(token);
  await tap(jane, jane.getByRole('button', { name: 'Sign in' }));
  await expect(jane.getByRole('heading', { level: 1, name: 'Your home purchase' })).toBeVisible({ timeout: 20_000 });
  const storage = await jane.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), document.cookie]));
  expect(storage).not.toContain(token);
  for (const r of seen) {
    expect(r.url(), r.url()).not.toContain(token);
    expect((await r.allHeaders()).referer ?? '', r.url()).not.toContain(token);
  }
  const bodies = seen.filter((r) => r.postData()?.includes(token)).map((r) => new URL(r.url()).pathname);
  expect(bodies).toEqual(['/api/portal/session']);
  // a reload shows no Sign in button: the token is gone with the address
  await jane.reload();
  await expect(jane.getByRole('heading', { level: 1, name: 'Your home purchase' })).toBeVisible({ timeout: 20_000 });
  await ctx.close();
});

test('E703 (b15 audit P46-SEC-2): a link opened in a tab already on the portal is read in place: no reload, the token in no address or history entry, nothing posted before the tap', async ({ browser }, info) => {
  test.setTimeout(180_000);
  const asker = await newClientContext(browser, info);
  const link = await requestLink(await asker.newPage(), stack, pw.slug, pw.jane.email);
  await asker.close();
  const token = /#token=([A-Za-z0-9_-]{43})/.exec(link)![1]!;

  const ctx = await newClientContext(browser, info);
  const jane = await ctx.newPage();
  await jane.goto(portalUrl(stack, pw.slug));
  await expect(jane.getByRole('heading', { level: 1, name: 'Sign in to your client portal' })).toBeVisible({ timeout: 20_000 });
  const posts: string[] = [];
  jane.on('request', (r) => {
    if (r.method() === 'POST') posts.push(new URL(r.url()).pathname);
  });
  let loads = 0;
  jane.on('load', () => (loads += 1));
  const before = await jane.evaluate(() => ({ href: location.href, entries: history.length }));
  // the link, opened in this tab: a fragment change only
  await jane.evaluate((t) => {
    location.hash = `token=${t}`;
  }, token);
  await expect(jane.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible({ timeout: 20_000 });
  expect(loads).toBe(0);
  expect(jane.url()).not.toContain('#');
  const now = await jane.evaluate(() => ({ href: location.href, state: JSON.stringify(history.state), entries: history.length }));
  expect(now.href).toBe(before.href);
  expect(now.href + now.state).not.toContain(token);
  expect(now.entries).toBe(before.entries + 1);
  await jane.waitForTimeout(1000);
  expect(posts).toEqual([]);
  await tap(jane, jane.getByRole('button', { name: 'Sign in' }));
  await expect(jane.getByRole('heading', { level: 1, name: 'Your home purchase' })).toBeVisible({ timeout: 20_000 });
  expect(posts).toEqual(['/api/portal/session']);
  await ctx.close();
});
