// module 46 (R-PORTALWEB-4, R-PORTALWEB-6, R-PORTALWEB-10; E653, E659, E684, E685): platform:portal uncleared, the
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

test('E684, E653: uncleared, nothing is sent: the portal is not available, the deal section is off, the invite says nothing was sent', async ({ page, browser }, info) => {
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

test('E684: a link minted while cleared, then the clearance withdrawn: the tap answers not available', async ({ browser }, info) => {
  test.setTimeout(240_000);
  const ctx = await newClientContext(browser, info);
  const jane = await ctx.newPage();
  try {
    await stack.setCleared(true);
    const link = await requestLink(jane, stack, pw.slug, pw.jane.email);
    await stack.setCleared(false);
    await openLinkAndSignIn(jane, link);
    await expect(jane.getByRole('heading', { level: 1, name: "The client portal isn't available" })).toBeVisible({ timeout: 20_000 });
  } finally {
    await stack.setCleared(false);
    await ctx.close();
  }
});

test('E659, E685: the clearance withdrawn mid-session signs Jane out on her next request; nothing stale stays', async ({ browser }, info) => {
  test.setTimeout(240_000);
  const ctx = await newClientContext(browser, info);
  const jane = await ctx.newPage();
  try {
    await stack.setCleared(true);
    const st = await stack.api<{ grants: { id: string }[] }>('a.agent0', 'GET', `/deals/${pw.dealId}/portal`);
    await stack.publishDocument(st.body.grants[0]!.id, pw.documentId);
    const link = await requestLink(jane, stack, pw.slug, pw.jane.email);
    await openLinkAndSignIn(jane, link);
    await expect(jane.getByRole('heading', { level: 1, name: 'Your home purchase' })).toBeVisible({ timeout: 20_000 });
    await stack.setCleared(false);
    // her next request (a Download tap) answers 401; a background refetch (window focus) may get there first, so
    // a tap on a control that is already gone is skipped: either way she is signed out
    const quick = { timeout: 3000 };
    if ((jane.viewportSize()?.width ?? 1440) < 768) await jane.getByRole('tab', { name: 'Documents' }).tap(quick).catch(() => undefined);
    await jane.getByRole('button', { name: 'Download Purchase contract.pdf' }).click(quick).catch(() => undefined);
    await expect(jane.getByRole('heading', { level: 1, name: "You're signed out" })).toBeVisible({ timeout: 20_000 });
    await expect(jane.getByText('Inspection', { exact: true })).toHaveCount(0);
  } finally {
    await stack.setCleared(false);
    await ctx.close();
  }
});
