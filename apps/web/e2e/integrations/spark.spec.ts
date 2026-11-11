// The Connect MLS (Spark) page against the REAL API (the lead-admin stack: a fresh per-test Postgres
// database, RLS-bound app_user, fake providers; MLS_PROVIDER and MLS_LIVE_CALLS at their defaults,
// so the provider is the built-in fake and live calls are off), on the phone and desktop projects:
// the Owner opens it from navigation and sees, in words, that live MLS calls are turned off, with no
// sideways scroll on a phone. No key is entered: the default deployment refuses one.
import { type Page, expect, test } from 'playwright/test';
import { type LeadAdminStack, type World, startLeadAdminStack } from '../lead-admin/stack.js';

test.describe.configure({ mode: 'serial' });

let stack: LeadAdminStack;
let w: World;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startLeadAdminStack();
  w = await stack.fixture<World>('/world');
});
test.afterAll(async () => {
  await stack?.stop();
});

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

async function signInOwner(page: Page) {
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(w.owner.email);
  await page.getByLabel('Password').fill(w.owner.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const { code } = await stack.fixture<{ code: string }>('/totp', { email: w.owner.email, secret: w.owner.totpSecret });
  await page.getByLabel('Code').fill(code);
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
}

test('the Owner opens Connect MLS from navigation and is told live MLS calls are off', async ({ page }) => {
  await signInOwner(page);
  if (isPhone(page)) {
    await page.getByRole('navigation', { name: 'Main tabs' }).getByRole('link', { name: 'More' }).tap();
    await page.getByRole('link', { name: 'Connect MLS', exact: true }).tap();
  } else await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name: 'Connect MLS', exact: true }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Connect MLS (Spark)' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'This deployment' })).toBeVisible();
  await expect(page.getByText(/Live MLS calls are turned off on this deployment/).first()).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
