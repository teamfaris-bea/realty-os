// Browser-side helpers shared by the lead-journey specs: sign-in (with the Owner/Admin TOTP step),
// counted taps (a real touch tap on the phone project, a click on desktop), the toast, polling the
// fake providers / the database until a condition holds (no fixed sleeps), and key-step screenshots.
// Screenshots go to $JOURNEY_SHOTS_DIR (default apps/web/test-results/journey-shots, gitignored),
// named <journey>-<step>-<project>.png, at deviceScaleFactor 1 (they are for review, not for people).
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type Locator, type Page, type TestInfo, expect } from 'playwright/test';
import type { JourneyStack, Sends } from './stack.js';

const here = dirname(fileURLToPath(import.meta.url));
export const SHOTS_DIR = process.env.JOURNEY_SHOTS_DIR ?? resolve(here, '../../test-results/journey-shots');

export const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

/** The visible toast (it is also announced through the app's one live region). */
export const toast = (page: Page) => page.getByTestId('toast');

/** One counted tap. */
export async function tap(page: Page, target: Locator, counter?: { taps: number }) {
  if (isPhone(page)) await target.tap();
  else await target.click();
  if (counter) counter.taps += 1;
}

export async function signIn(page: Page, stack: JourneyStack, who: { email: string; password: string }) {
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const code = page.getByLabel('Code');
  const home = page.getByRole('heading', { level: 1, name: 'Home' });
  await expect(code.or(home)).toBeVisible({ timeout: 20_000 });
  if (await code.isVisible()) {
    const totp = (await stack.fixture<{ code: string | null }>('/totp', { email: who.email })).code;
    if (!totp) throw new Error(`no TOTP secret for ${who.email}`);
    await code.fill(totp);
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await expect(home).toBeVisible({ timeout: 20_000 });
}

/** The feed card whose level-3 heading is `name`. */
export function feedCard(page: Page, name: string): Locator {
  return page.locator('article').filter({ has: page.getByRole('heading', { level: 3, name }) }).first();
}

/** A full-page screenshot of a key step: <journey>-<step>-<phone|desktop>.png. */
export async function shot(page: Page, info: TestInfo, journey: string, step: string) {
  mkdirSync(SHOTS_DIR, { recursive: true });
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await page.screenshot({ path: resolve(SHOTS_DIR, `${journey}-${step}-${info.project.name}.png`), fullPage: !isPhone(page) });
}

/** Polls the fake providers until `pick` returns something that satisfies `ok`. */
export async function pollSends<T>(stack: JourneyStack, pick: (s: Sends) => T, ok: (v: T) => boolean, timeout = 15_000): Promise<T> {
  let last: T | undefined;
  await expect
    .poll(async () => {
      last = pick(await stack.sends());
      return ok(last);
    }, { timeout })
    .toBe(true);
  return last as T;
}

/** Polls a read-back query until `ok(rows)` holds; returns the rows. */
export async function pollSql<T>(stack: JourneyStack, text: string, values: unknown[], ok: (rows: T[]) => boolean, timeout = 15_000): Promise<T[]> {
  let last: T[] = [];
  await expect
    .poll(async () => {
      last = await stack.sql<T>(text, values);
      return ok(last);
    }, { timeout })
    .toBe(true);
  return last;
}

/** Runs the worker until `ok()` holds (jobs a UI action enqueued run on the real handlers). */
export async function drainUntil(stack: JourneyStack, ok: () => Promise<boolean>, o: { kinds?: string[]; timeout?: number } = {}) {
  await expect
    .poll(async () => {
      await stack.jobs(o.kinds ? { kinds: o.kinds } : {});
      return ok();
    }, { timeout: o.timeout ?? 20_000 })
    .toBe(true);
}

/** The session's CSRF token, for API probes made with the browser's own cookie. */
export async function browserApi(page: Page, stack: JourneyStack) {
  const s = await page.request.get(`${stack.webUrl}/api/auth/session`);
  const sj = (await s.json()) as { csrfToken?: string; session?: { csrfToken?: string } };
  const csrf = sj.session?.csrfToken ?? sj.csrfToken ?? '';
  const headers = { 'x-csrf-token': csrf, origin: stack.webUrl, 'content-type': 'application/json' };
  return {
    get: (path: string) => page.request.get(`${stack.webUrl}/api${path}`),
    post: (path: string, data: unknown = {}) => page.request.post(`${stack.webUrl}/api${path}`, { headers, data }),
    patch: (path: string, data: unknown = {}) => page.request.patch(`${stack.webUrl}/api${path}`, { headers, data }),
    put: (path: string, data: unknown = {}) => page.request.put(`${stack.webUrl}/api${path}`, { headers, data }),
    delete: (path: string) => page.request.delete(`${stack.webUrl}/api${path}`, { headers }),
  };
}

/** Last 4 digits of an E.164 number (how the UI masks a phone). */
export const last4 = (e164: string) => e164.slice(-4);
