// Sign-in and "page has settled" helpers shared by the a11y specs.
import { type Page, expect } from 'playwright/test';
import type { Role } from './pages.js';
import type { A11yStack, World } from './stack.js';

export async function signIn(page: Page, stack: A11yStack, world: World, role: Role) {
  const u = world.users[role];
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(u.email);
  await page.getByLabel('Password').fill(u.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (u.mfa) {
    await page.getByLabel('Code').fill(await stack.totp(u.email));
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible({ timeout: 15_000 });
}

/** The page's h1 is shown, the network is quiet and no "Loading" status is left. */
export async function settle(page: Page) {
  await expect(page.getByRole('heading', { level: 1 }).first()).toBeVisible({ timeout: 15_000 });
  await page.waitForLoadState('networkidle');
  await expect(page.getByRole('status').filter({ hasText: /^Loading/ })).toHaveCount(0, { timeout: 15_000 });
}
