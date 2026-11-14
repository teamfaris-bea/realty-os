// module 46 (R-PORTALWEB-11): the portal's screens and states, and the staff preview, against the REAL module 45 API
// with fakes, on the phone (390×844) and desktop (1440×900) projects, in light and dark, with axe-core (the sweep's
// AXE_TAGS: WCAG 2.0/2.1/2.2 A and AA plus best practices). On the phone: no sideways scroll, 44 px targets and no
// clipped text at 390 px, at 320 px and at 200 % text. On desktop: keyboard only through sign-in, the tabs (phone
// layout at 390 px), a download and sign out, with focus never hidden.
// b15 audit F5: the sweep covers every screen and state of the brief's steps 4-5: sign-in, its error, link requested,
// incomplete, no team, link landing, home (timeline, phone documents), several grants, nothing shared, no longer shared,
// a failed download, signed out, a used link, 429, text messages off, and not available. Where the real stack cannot
// reach a state without changing the world later tests use (a revoke is final; SMS is a config), the browser answers
// with module 45's own error body, or /me with its grants changed, or (a revoke) both: the screen is the client's own.
import { AxeBuilder } from '@axe-core/playwright';
import { type Locator, type Page, type Route, expect, test } from 'playwright/test';
// the sweep's tags (e2e/a11y/a11y.spec.ts AXE_TAGS; a spec file cannot import another spec)
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];
import { clippedText, obscuredFocus, phoneProblems } from '../a11y/checks.js';
import { signIn, tap } from '../journeys/helpers.js';
import type { WorldInfo } from '../journeys/stack.js';
import { newClientContext, requestLink } from './common.js';
import { type PortalStack, type PortalWorld, portalUrl, startPortalStack } from './stack.js';

test.describe.configure({ mode: 'serial' });

let stack: PortalStack;
let w: WorldInfo;
let pw: PortalWorld;
let grantId = '';

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startPortalStack();
  w = await stack.world({ agents: 1 });
  pw = await stack.portalWorld();
  await stack.setCleared(true);
  const inv = await stack.api<{ grant: { id: string } }>('a.agent0', 'POST', `/deals/${pw.dealId}/portal/invite`, { contactId: pw.jane.id, idempotencyKey: 'a11yinvite' + Date.now() });
  expect(inv.status, JSON.stringify(inv.body)).toBe(200);
  grantId = inv.body.grant.id;
  await stack.publishDocument(grantId, pw.documentId);
  await stack.publishNewDocument(pw.dealId, grantId, LONG_TITLE);
  await stack.jobs();
});
test.afterAll(async () => {
  await stack?.setCleared(false).catch(() => undefined);
  await stack?.stop();
});

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;
/** A tap where the context has touch, else a click: by the context's touch support, not by width (helpers.ts tap()
 *  goes by width, and the desktop project at 320 px has no touch, so a tap there throws). Counts like tap(). */
async function press(page: Page, target: Locator, counter?: { taps: number }) {
  if (await page.evaluate(() => navigator.maxTouchPoints > 0)) await target.tap();
  else await target.click();
  if (counter) counter.taps += 1;
}
/** module 45's error body (webContract.json errors), as the API sends it */
const apiError = (status: number, code: string, details?: Record<string, unknown>) => ({ status, contentType: 'application/json', body: JSON.stringify({ error: { code, requestId: '01900000-0000-7000-8000-0000000000ee', ...(details ? { details } : {}) } }) });
const SECOND_GRANT = '01900000-0000-7000-8000-00000000f5a2';
/** b15 audit F12 (E709): a 118-character document title with no space or hyphen: one long word */
const LONG_TITLE = `Inspection${'W'.repeat(104)}.pdf`;
/** /me as the API answered it, with its grants changed */
const meWith = (page: Page, grants: (real: Record<string, unknown>[]) => Record<string, unknown>[]) =>
  page.route('**/api/portal/me', async (r) => {
    const res = await r.fetch();
    const me = (await res.json()) as { grants: Record<string, unknown>[] };
    await r.fulfill({ response: res, json: { ...me, grants: grants(me.grants) } });
  });

async function axe(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page: page as never }).withTags(AXE_TAGS).analyze();
  return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

/** axe in both themes, and on a phone the reflow checks at 390 px, 320 px and 200 % text. */
async function check(page: Page, name: string): Promise<string[]> {
  const found: string[] = [];
  await page.waitForLoadState('networkidle').catch(() => undefined);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    // let colour transitions settle (axe samples the computed colours)
    await page.waitForTimeout(400);
    found.push(...(await axe(page)).map((v) => `${scheme} ${name}: ${v}`));
  }
  await page.emulateMedia({ colorScheme: 'light' });
  if (isPhone(page)) {
    const size = page.viewportSize()!;
    found.push(...(await phoneProblems(page)).map((v) => `390 ${name}: ${v}`), ...(await clippedText(page)).map((v) => `390 ${name}: ${v}`));
    await page.setViewportSize({ width: 320, height: size.height });
    found.push(...(await phoneProblems(page)).map((v) => `320 ${name}: ${v}`), ...(await clippedText(page)).map((v) => `320 ${name}: ${v}`));
    await page.setViewportSize(size);
    await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
    found.push(...(await clippedText(page)).map((v) => `200% ${name}: ${v}`));
    const sideways = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
    if (sideways) found.push(`200% ${name}: scrolls sideways`);
    await page.evaluate(() => (document.documentElement.style.fontSize = ''));
  }
  return found;
}

test('R-PORTALWEB-11: every portal screen and state passes axe in both themes and holds up on a phone', async ({ browser }, info) => {
  test.setTimeout(300_000);
  const found: string[] = [];
  const ctx = await newClientContext(browser, info);
  const p = await ctx.newPage();
  const h1 = (name: string) => expect(p.getByRole('heading', { level: 1, name })).toBeVisible({ timeout: 20_000 });

  await p.goto(portalUrl(stack, pw.slug));
  await h1('Sign in to your client portal');
  found.push(...(await check(p, 'sign-in')));
  await p.getByLabel('Email address').fill('not-an-email');
  await tap(p, p.getByRole('button', { name: 'Send me a sign-in link' }));
  await expect(p.locator('main').getByText(/^That does not look like (an email address|a phone number)\.$/)).toBeVisible();
  found.push(...(await check(p, 'sign-in error')));

  const link = await requestLink(p, stack, pw.slug, pw.jane.email);
  found.push(...(await check(p, 'link requested')));

  await p.goto(`${stack.webUrl}/portal.html#token=short`);
  await expect(p.getByText('This sign-in link is incomplete.', { exact: false })).toBeVisible();
  found.push(...(await check(p, 'incomplete')));

  const fresh = await newClientContext(browser, info);
  const nt = await fresh.newPage();
  await nt.goto(`${stack.webUrl}/portal.html`);
  await expect(nt.getByRole('heading', { level: 1, name: 'Open your invitation link' })).toBeVisible({ timeout: 20_000 });
  found.push(...(await check(nt, 'no team')));
  await fresh.close();

  await p.goto(link);
  await h1('Sign in');
  found.push(...(await check(p, 'link landing')));
  await tap(p, p.getByRole('button', { name: 'Sign in' }));
  await h1('Your home purchase');
  found.push(...(await check(p, 'home timeline')));
  if (isPhone(p)) {
    await tap(p, p.getByRole('tab', { name: 'Documents' }));
    await expect(p.getByText('Purchase contract.pdf', { exact: true })).toBeVisible();
    found.push(...(await check(p, 'home documents')));
  }

  // E709 (b15 audit F12): a very long word wraps at 320 px, measured in the browser (not taken from a class): the
  // word's box stays inside the viewport, it takes more than one line, nothing scrolls sideways and no text is clipped
  {
    const size = p.viewportSize()!;
    await p.setViewportSize({ width: 320, height: size.height });
    // at 320 px every project has the phone layout: the documents are behind their tab (the desktop project has no
    // touch at this width: press, not tap)
    const docsTab = p.getByRole('tab', { name: 'Documents' });
    await expect(docsTab).toBeVisible();
    if ((await docsTab.getAttribute('aria-selected')) !== 'true') await press(p, docsTab);
    const word = p.getByText(LONG_TITLE, { exact: true });
    await expect(word).toBeVisible();
    const m = await word.evaluate((e) => {
      const r = e.getBoundingClientRect();
      const root = document.documentElement;
      return { left: r.left, right: r.right, height: r.height, font: parseFloat(getComputedStyle(e).fontSize), vw: root.clientWidth, sideways: root.scrollWidth > root.clientWidth };
    });
    expect(m.vw).toBe(320);
    expect(m.left).toBeGreaterThanOrEqual(0);
    expect(m.right).toBeLessThanOrEqual(m.vw);
    expect(m.height).toBeGreaterThan(2 * m.font);
    expect(m.sideways).toBe(false);
    found.push(...(await clippedText(p)).map((v) => `320 long word: ${v}`));
    await p.setViewportSize(size);
  }

  // several grants: a one-tap list (a second grant beside the real one; it is never opened)
  await meWith(p, (g) => [...g, { ...g[0], id: SECOND_GRANT, title: 'Your home sale', scope: 'sale' }]);
  await p.goto(portalUrl(stack, pw.slug));
  await expect(p.getByRole('navigation', { name: 'Choose what to open' })).toBeVisible({ timeout: 20_000 });
  found.push(...(await check(p, 'several grants')));
  await p.unroute('**/api/portal/me');
  // nothing shared (E711)
  await meWith(p, () => []);
  await p.reload();
  await expect(p.locator('main').getByText('Nothing is shared with you right now.', { exact: false })).toBeVisible({ timeout: 20_000 });
  found.push(...(await check(p, 'nothing shared')));
  await p.unroute('**/api/portal/me');
  // no longer shared (E712): the grant is revoked between /me and its timeline. A revoke hides it from every later query
  // (R-PORTAL-6, E125): 45 answers its timeline and documents 404 and /me no longer lists it (E711). So the first /me
  // is the real one, every item read of the grant answers 404 (not one: the dev build's StrictMode mounts the grant
  // twice and aborts the first read), and from the first 404 on, /me is the real answer without the grant.
  let revoked = false;
  let meWithout = 0;
  const grantItems = (u: URL) => u.pathname === '/api/portal/timeline' || u.pathname === '/api/portal/documents';
  const revokedItems = (r: Route) => {
    revoked = true;
    return r.fulfill(apiError(404, 'NOT_FOUND'));
  };
  await meWith(p, (g) => {
    if (!revoked) return g;
    meWithout += 1;
    return g.filter((x) => x.id !== grantId);
  });
  await p.route(grantItems, revokedItems);
  await p.reload();
  await expect(p.locator('main').getByText('This is no longer shared with you.')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => meWithout, { message: '/me refetched after the 404', timeout: 20_000 }).toBeGreaterThan(0);
  found.push(...(await check(p, 'no longer shared')));
  // Home's state after the refetch: the sentence stays, above "nothing shared", and nothing of the grant is left
  await expect(p.locator('main').getByText('This is no longer shared with you.')).toBeVisible();
  await expect(p.locator('main').getByText('Nothing is shared with you right now.', { exact: false })).toBeVisible();
  await expect(p.getByText('Inspection', { exact: true })).toHaveCount(0);
  await p.unroute(grantItems, revokedItems);
  await p.unroute('**/api/portal/me');
  // a failed download (E713): the stream token answers 404 once
  await p.goto(portalUrl(stack, pw.slug));
  await h1('Your home purchase');
  if (isPhone(p)) await tap(p, p.getByRole('tab', { name: 'Documents' }));
  await p.route('**/api/portal/documents/*/stream-token', (r) => r.fulfill(apiError(404, 'NOT_FOUND')), { times: 1 });
  await tap(p, p.getByRole('button', { name: `Download ${pw.documentName}` }));
  await expect(p.locator('main').getByText("This file isn't available now.", { exact: false })).toBeVisible({ timeout: 20_000 });
  found.push(...(await check(p, 'download failed')));

  await tap(p, p.getByRole('button', { name: 'Sign out' }));
  await h1("You're signed out");
  found.push(...(await check(p, 'signed out')));

  // a used link (E701): the link, opened again and tapped, then the form with 45's sentence
  await p.goto(link);
  await h1('Sign in');
  await tap(p, p.getByRole('button', { name: 'Sign in' }));
  await h1('Sign in to your client portal');
  await expect(p.locator('main').getByText('That sign-in link no longer works.', { exact: false })).toBeVisible();
  found.push(...(await check(p, 'used link')));
  // 429 (E707), then text messages off (E706): each answered once with 45's error
  await p.route('**/api/portal/login', (r) => r.fulfill(apiError(429, 'RATE_LIMITED')), { times: 1 });
  await p.getByLabel('Email address').fill(pw.jane.email);
  await tap(p, p.getByRole('button', { name: 'Send me a sign-in link' }));
  await expect(p.locator('main').getByText('Too many tries. Wait a few minutes and try again.')).toBeVisible();
  found.push(...(await check(p, '429')));
  await p.route('**/api/portal/login', (r) => r.fulfill(apiError(503, 'PORTAL_NOT_AVAILABLE', { channel: 'sms' })), { times: 1 });
  await tap(p, p.getByRole('radio', { name: 'Text message' }));
  await p.getByLabel('Mobile number').fill(pw.jane.phone);
  await tap(p, p.getByRole('button', { name: 'Send me a sign-in link' }));
  await expect(p.locator('main').getByText("Sign-in links can't be sent by text message right now", { exact: false })).toBeVisible();
  found.push(...(await check(p, 'text messages off')));
  await tap(p, p.getByRole('radio', { name: 'Email' }));

  await stack.setCleared(false);
  try {
    await p.getByLabel('Email address').fill(pw.jane.email);
    await tap(p, p.getByRole('button', { name: 'Send me a sign-in link' }));
    await h1("The client portal isn't available");
    found.push(...(await check(p, 'not available')));
  } finally {
    await stack.setCleared(true);
  }
  await ctx.close();
  expect(found).toEqual([]);
});

test('R-PORTALWEB-11: the staff preview passes axe, visible now and not', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, stack, w.agents[0]!);
  const found: string[] = [];
  await page.goto(`${stack.webUrl}/client-portal/${grantId}`);
  await expect(page.getByText(/sees now\.$|can't see this now/).first()).toBeVisible({ timeout: 20_000 });
  found.push(...(await check(page, 'preview')));
  await stack.setCleared(false);
  try {
    await page.reload();
    await expect(page.getByText(/client portal is not turned on/).first()).toBeVisible({ timeout: 20_000 });
    found.push(...(await check(page, 'preview not visible')));
  } finally {
    await stack.setCleared(true);
  }
  await page.goto(`${stack.webUrl}/deals/${pw.dealId}`);
  await expect(page.getByRole('heading', { name: 'Client portal' })).toBeVisible({ timeout: 20_000 });
  found.push(...(await check(page, 'deal section')));
  expect(found).toEqual([]);
});

test('R-PORTALWEB-11: keyboard only: sign in, the tabs, a download and sign out; focus is never hidden', async ({ browser }, info) => {
  test.skip(info.project.name !== 'desktop', 'keyboard journey runs on desktop');
  test.setTimeout(180_000);
  const ctx = await newClientContext(browser, info);
  const p = await ctx.newPage();
  const link = await requestLink(p, stack, pw.slug, pw.jane.email);
  await p.goto(link);
  await expect(p.getByRole('heading', { level: 1, name: 'Sign in' })).toBeFocused({ timeout: 20_000 });
  const tabTo = async (name: RegExp | string, role: 'button' | 'tab' = 'button') => {
    const target = p.getByRole(role, { name });
    for (let i = 0; i < 30 && !(await target.evaluate((e) => e === document.activeElement).catch(() => false)); i += 1) await p.keyboard.press('Tab');
    await expect(target).toBeFocused();
  };
  // obscuredFocus focuses every control of the screen in turn, so it runs between steps, never between a Tab and its Enter
  const noHiddenFocus = async () => expect(await obscuredFocus(p)).toEqual([]);
  await noHiddenFocus();
  await tabTo('Sign in');
  await p.keyboard.press('Enter');
  await expect(p.getByRole('heading', { level: 1, name: 'Your home purchase' })).toBeFocused({ timeout: 20_000 });
  await noHiddenFocus();
  const dl = p.waitForEvent('download');
  await tabTo('Download Purchase contract.pdf');
  await p.keyboard.press('Enter');
  await dl;
  // the phone layout's tabs, by keyboard (arrow keys move between them)
  await p.setViewportSize({ width: 390, height: 844 });
  await tabTo('Timeline', 'tab');
  await p.keyboard.press('ArrowRight');
  await expect(p.getByRole('tab', { name: 'Documents' })).toBeFocused();
  await expect(p.getByRole('tab', { name: 'Documents' })).toHaveAttribute('aria-selected', 'true');
  await p.setViewportSize({ width: 1440, height: 900 });
  await tabTo('Sign out');
  await p.keyboard.press('Enter');
  await expect(p.getByRole('heading', { level: 1, name: "You're signed out" })).toBeFocused();
  await noHiddenFocus();
  await ctx.close();
});
