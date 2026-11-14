// module 46 (R-PORTALWEB-4, R-PORTALWEB-6, R-PORTALWEB-10; E693, E699, E704, E705): platform:portal uncleared, the
// default on every deployment. Nothing is sent, the portal says it is not available, and the deal section says it
// is off; a link minted while cleared stops working at the tap once the clearance is withdrawn; a withdrawal
// mid-session signs the client out on her next request. The clearance is restored in a finally.
import { expect, test } from 'playwright/test';
import { signIn, tap } from '../journeys/helpers.js';
import type { WorldInfo } from '../journeys/stack.js';
import { NOT_AVAILABLE, newClientContext, openLinkAndSignIn, requestLink } from './common.js';
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
});
test.afterAll(async () => {
  await stack?.setCleared(false).catch(() => undefined);
  await stack?.stop();
});

test('E704, E693: uncleared, nothing is sent: the portal is not available, the deal section is off, the invite says nothing was sent', async ({ page, browser }, info) => {
  test.setTimeout(240_000);
  await stack.setCleared(false);
  await signIn(page, stack, w.agents[0]!);
  await page.goto(`${stack.webUrl}/deals/${pw.dealId}`);
  const s = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Client portal' }) });
  await expect(s.getByText(/Clients can't sign in, and invitations aren't sent\./)).toBeVisible({ timeout: 20_000 });
  await tap(page, s.getByRole('button', { name: `Invite ${pw.jane.name}` }));
  await expect(s.getByText(/can't sign in until the client portal is turned on, so nothing was sent to them\./)).toBeVisible({ timeout: 20_000 });

  const before = await stack.emailCount(pw.jane.email);
  const ctx = await newClientContext(browser, info);
  const jane = await ctx.newPage();
  await jane.goto(portalUrl(stack, pw.slug));
  await jane.getByLabel('Email address').fill(pw.jane.email);
  await tap(jane, jane.getByRole('button', { name: 'Send me a sign-in link' }));
  await expect(jane.getByRole('heading', { level: 1, name: "The client portal isn't available" })).toBeVisible();
  await expect(jane.getByText(NOT_AVAILABLE)).toBeVisible();
  await expect(jane.getByText('No sign-in link was sent.')).toBeVisible();
  await jane.waitForTimeout(1000);
  expect(await stack.emailCount(pw.jane.email)).toBe(before);
  await ctx.close();
});

test('E704: a link minted while cleared, then the clearance withdrawn: the tap answers not available', async ({ browser }, info) => {
  test.setTimeout(240_000);
  const ctx = await newClientContext(browser, info);
  const jane = await ctx.newPage();
  try {
    await stack.setCleared(true);
    const link = await requestLink(jane, stack, pw.slug, pw.jane.email);
    await stack.setCleared(false);
    await openLinkAndSignIn(jane, link);
    await expect(jane.getByRole('heading', { level: 1, name: "The client portal isn't available" })).toBeVisible({ timeout: 20_000 });
    // b15 audit F11: she holds a link that was sent, so the tap's not-available screen makes no claim about sending
    await expect(jane.getByText(NOT_AVAILABLE)).toBeVisible();
    await expect(jane.getByText('No sign-in link was sent.')).toHaveCount(0);
  } finally {
    await stack.setCleared(false);
    await ctx.close();
  }
});

test('E699, E705: the clearance withdrawn mid-session signs Jane out on her next request; nothing stale stays', async ({ browser }, info) => {
  test.setTimeout(240_000);
  const ctx = await newClientContext(browser, info);
  const jane = await ctx.newPage();
  try {
    await stack.setCleared(true);
    const st = await stack.api<{ grants: { id: string }[] }>('a.agent0', 'GET', `/deals/${pw.dealId}/portal`);
    expect(st.status, JSON.stringify(st.body)).toBe(200);
    await stack.publishDocument(st.body.grants[0]!.id, pw.documentId);
    const link = await requestLink(jane, stack, pw.slug, pw.jane.email);
    await openLinkAndSignIn(jane, link);
    await expect(jane.getByRole('heading', { level: 1, name: 'Your home purchase' })).toBeVisible({ timeout: 20_000 });
    // registered before the withdrawal, so a refetch that lands at once is caught too (no portal request is refused before it)
    const refused = jane.waitForResponse((r) => new URL(r.url()).pathname.startsWith('/api/portal/') && r.status() === 401, { timeout: 60_000 });
    await stack.setCleared(false);
    // b15 audit F9: her next request is driven and asserted, never swallowed. It is the Download tap's stream-token
    // POST, unless a refetch on window focus (App.tsx refetchOnWindowFocus) reaches 45 first. Either way her first
    // portal request after the withdrawal answers 401 and signs her out (E699): the wait takes the first portal 401,
    // whichever request it is, and a tap that cannot happen because she is already signed out is the only error let
    // through (b15 suite: the desktop run lost this race 1 time in 4; a forced focus refetch reproduces it).
    const signedOut = jane.getByRole('heading', { level: 1, name: "You're signed out" });
    const phone = (jane.viewportSize()?.width ?? 1440) < 768;
    const press = (l: ReturnType<typeof jane.getByRole>) => (phone ? l.tap({ timeout: 10_000 }) : l.click({ timeout: 10_000 }));
    try {
      if (phone) await press(jane.getByRole('tab', { name: 'Documents' }));
      await press(jane.getByRole('button', { name: 'Download Purchase contract.pdf' }));
    } catch (e) {
      if (!(await signedOut.isVisible())) throw e;
    }
    const first = await refused;
    expect(first.status()).toBe(401);
    await expect(signedOut).toBeVisible({ timeout: 20_000 });
    await expect(jane.getByText('Inspection', { exact: true })).toHaveCount(0);
  } finally {
    await stack.setCleared(false);
    await ctx.close();
  }
});
