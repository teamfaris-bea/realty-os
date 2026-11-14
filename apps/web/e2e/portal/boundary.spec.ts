// module 46 (R-PORTALWEB-1, R-PORTALWEB-2, R-PORTALWEB-3, R-PORTALWEB-9; E680, E683, E697, E148): the trust boundary
// in a real browser. A staff browser on /portal.html calls only /api/portal/* and its staff tab is unaffected; a
// client on / or /portal gets the staff sign-in; the token is in no URL, Referer, storage or history entry; a visit
// that runs the page's script without a tap (a scanner, a preview) leaves the link valid.
import { type Request, expect, test } from 'playwright/test';
import { signIn, tap } from '../journeys/helpers.js';
import type { WorldInfo } from '../journeys/stack.js';
import { newClientContext, requestLink } from './common.js';
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
  await stack.api('a.agent0', 'POST', `/deals/${pw.dealId}/portal/invite`, { contactId: pw.jane.id, idempotencyKey: 'e2einvite' + Date.now() });
});
test.afterAll(async () => {
  await stack?.setCleared(false).catch(() => undefined);
  await stack?.stop();
});

test('E697: a staff browser on /portal.html calls only /api/portal/*; the staff tab still works; the staff session is not the portal\'s', async ({ page }) => {
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

test('E697: a client on / and on /portal gets the staff sign-in, never the portal', async ({ browser }, info) => {
  const ctx = await newClientContext(browser, info);
  const p = await ctx.newPage();
  for (const path of ['/', '/portal']) {
    await p.goto(stack.webUrl + path);
    await expect(p.getByLabel('Password'), path).toBeVisible({ timeout: 20_000 });
    await expect(p.getByRole('heading', { name: 'Sign in to your client portal' })).toHaveCount(0);
  }
  await ctx.close();
});

test('E683, E680: the token is in no URL, Referer, storage or history entry; a scripted visit with no tap leaves the link valid', async ({ browser }, info) => {
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
