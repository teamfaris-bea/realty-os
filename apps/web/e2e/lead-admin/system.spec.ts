// The System page against the REAL API (stack.ts: a fresh per-test Postgres database, RLS-bound
// app_user, fake providers), on the phone (iPhone 13) and desktop (1440 px) projects: the Owner opens
// it from navigation and sees the page heading and its four sections, read from GET /system/overview,
// with no sideways scroll on a phone.
import { type Page, expect, test } from 'playwright/test';
import { type LeadAdminStack, type World, startLeadAdminStack } from './stack.js';

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

test('the Owner opens System from navigation and sees its sections', async ({ page }) => {
  await signInOwner(page);
  if (isPhone(page)) {
    await page.getByRole('navigation', { name: 'Main tabs' }).getByRole('link', { name: 'More' }).tap();
    await page.getByRole('link', { name: 'System', exact: true }).tap();
  } else await page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name: 'System', exact: true }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'System' })).toBeVisible();
  for (const name of ['Jobs that need attention', 'Messages stuck while sending', 'Timers that fired late (last 24 hours)', 'Provider health']) {
    await expect(page.getByRole('heading', { level: 2, name })).toBeVisible();
  }
  await expect(page.getByText(/^Updated /)).toBeVisible();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});
