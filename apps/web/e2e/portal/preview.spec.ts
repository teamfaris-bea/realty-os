// module 46 (R-PORTALWEB-10; E698): "What {name} sees" before Jane signs in (45's reason in the banner), an ISA (no
// section, the preview not found), and an invite whose notice an opt-out blocks (the decision, no send-anyway).
import { type Page, expect, test } from 'playwright/test';
import { signIn, tap } from '../journeys/helpers.js';
import type { WorldInfo } from '../journeys/stack.js';
import { type PortalStack, type PortalWorld, startPortalStack } from './stack.js';

test.describe.configure({ mode: 'serial' });

let stack: PortalStack;
let w: WorldInfo;
let pw: PortalWorld;
let isa: { email: string; password: string };
let grantId = '';

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startPortalStack();
  w = await stack.world({ agents: 1 });
  pw = await stack.portalWorld();
  isa = (await stack.fixture<{ isa: typeof isa }>('/portal/isa', {})).isa;
  await stack.setCleared(true);
});
test.afterAll(async () => {
  await stack?.setCleared(false).catch(() => undefined);
  await stack?.stop();
});

const section = (page: Page) => page.locator('section').filter({ has: page.getByRole('heading', { name: 'Client portal' }) });

test('E698: before Jane signs in, the preview says why she cannot see it (45\'s reason); it is 1 tap from the deal', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, stack, w.agents[0]!);
  await page.goto(`${stack.webUrl}/deals/${pw.dealId}`);
  await tap(page, section(page).getByRole('button', { name: `Invite ${pw.jane.name}` }));
  const link = section(page).getByRole('link', { name: `What ${pw.jane.name} sees` });
  await expect(link).toBeVisible({ timeout: 20_000 });
  grantId = (await link.getAttribute('href'))!.split('/').pop()!;
  const taps = { taps: 0 };
  await tap(page, link, taps);
  expect(taps.taps).toBe(1);
  await expect(page.getByRole('heading', { level: 1, name: `What ${pw.jane.name} sees` })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(`${pw.jane.name} can't see this now: the client has not signed in yet.`)).toBeVisible();
});

test('E698: an ISA gets no section on the deal and not-found on the preview', async ({ page }) => {
  test.setTimeout(180_000);
  await signIn(page, stack, isa);
  await page.goto(`${stack.webUrl}/client-portal/${grantId}`);
  // the page is not a role page of the ISA: the shell's not-available state (the API answers 404 as well)
  await expect(page.getByRole('heading', { level: 1, name: 'Not available' })).toBeVisible({ timeout: 20_000 });
  expect((await stack.api('a.isa', 'GET', `/portal-grants/${grantId}/preview`)).status).toBe(404);
  await page.goto(`${stack.webUrl}/deals/${pw.dealId}`);
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('heading', { name: 'Client portal' })).toHaveCount(0);
});

test('D1: an invite whose notice an opt-out blocks shows the decision, and no send-anyway', async ({ page }) => {
  test.setTimeout(180_000);
  const other = await stack.portalWorld();
  const dnc = await stack.api('a.agent0', 'POST', `/contacts/${other.jane.id}/do-not-contact`, { reason: 'asked_in_writing' });
  expect(dnc.status).toBe(200);
  await signIn(page, stack, w.agents[0]!);
  await page.goto(`${stack.webUrl}/deals/${other.dealId}`);
  await tap(page, section(page).getByRole('button', { name: `Invite ${other.jane.name}` }));
  await expect(section(page).getByText(/was not sent; the reason is below\. The invite stands\./)).toBeVisible({ timeout: 20_000 });
  await expect(section(page).locator('[data-gate-outcome="deny"]')).toBeVisible();
  await expect(section(page).getByRole('button', { name: /anyway/i })).toHaveCount(0);
});
