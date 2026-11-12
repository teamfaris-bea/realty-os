// Phase 2/3 feed cards against the REAL API (stack.ts), on the phone (iPhone 13, 390×844) and desktop
// (1440×900) projects (module 18a). One card of each type is written under its key family the way its
// owning module will write it; each must show its label and a primary action reachable in ≤ 2 taps from
// opening the app, and lead somewhere real (the listing page, the contact page, or the card's own lines).
// A likely_to_move card disappears as soon as its model is withdrawn (R-PRED-5, E144).
import { createRequire } from 'node:module';
import { type Locator, type Page, expect, test } from 'playwright/test';
import { type FeedSeed, type FeedStack, startFeedStack } from './stack.js';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

test.describe.configure({ mode: 'serial' });

let stack: FeedStack;
let seed: FeedSeed;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startFeedStack();
  seed = await stack.fixture<FeedSeed>('/seed');
});
test.afterAll(async () => {
  await stack?.stop();
});

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

async function tap(page: Page, target: Locator, counter: { taps: number }) {
  if (isPhone(page)) await target.tap();
  else await target.click();
  counter.taps += 1;
}

async function signIn(page: Page) {
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(seed.email);
  await page.getByLabel('Password').fill(seed.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
}

/** The feed card whose type label is `label`. */
function cardOf(page: Page, label: string): Locator {
  return page.locator('article').filter({ has: page.getByText(label, { exact: true }) }).first();
}

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run(ctx: Document, o: object): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document, { resultTypes: ['violations'] });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

const CARDS = [
  { label: 'Seller update to review', action: 'Open listing', to: () => `/listings/${seed.listingId}` },
  { label: 'Marketing to review', action: 'Open listing', to: () => `/listings/${seed.listingId}` },
  { label: 'Your plan this week', action: 'See the plan', to: () => '/plan/2026-W46' },
  // module 40: the coaching tip links to the daily fix page
  { label: "Today's coaching tip", action: 'See the tip', to: () => '/coaching' },
  { label: 'May be thinking of moving', action: 'Open contact', to: () => `/contacts/${seed.lenaId}` },
] as const;

test('each Phase 2/3 card shows its label and a primary action that does its job in ≤ 2 taps', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  for (const c of CARDS) {
    await page.goto(`${stack.webUrl}/`);
    const card = cardOf(page, c.label);
    await expect(card).toBeVisible({ timeout: 15_000 });
    const primary = card.getByRole('button', { name: c.action });
    await expect(primary).toBeVisible();
    await expect(primary).toBeEnabled();
    // a 44 px tap target
    const box = await primary.boundingBox();
    expect(box!.height).toBeGreaterThanOrEqual(44);
    const n = { taps: 0 };
    if (!(await primary.isVisible())) await primary.scrollIntoViewIfNeeded();
    await tap(page, primary, n);
    if ('to' in c) {
      await expect(page).toHaveURL(new RegExp(`${c.to()}$`));
    } else {
      await expect(primary).toHaveAttribute('aria-expanded', 'true');
      await expect(card.getByRole('list', { name: 'Details' }).getByText(c.details)).toBeVisible();
    }
    expect(n.taps).toBeLessThanOrEqual(2);
  }
  await page.goto(`${stack.webUrl}/`);
  await expect(cardOf(page, 'Your plan this week')).toBeVisible();
  expect(await page.locator('main').textContent()).not.toMatch(/confiden|probab|\d+\s?%/i);
  expect(await axeViolations(page)).toEqual([]);
  if (isPhone(page)) expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test('E144 / R-PRED-5: the likely-to-move card disappears when its model is withdrawn', async ({ page }) => {
  test.setTimeout(60_000);
  await signIn(page);
  await expect(cardOf(page, 'May be thinking of moving')).toBeVisible({ timeout: 15_000 });
  await stack.fixture('/withdraw');
  try {
    await page.reload();
    await expect(cardOf(page, 'Your plan this week')).toBeVisible({ timeout: 15_000 });
    await expect(cardOf(page, 'May be thinking of moving')).toHaveCount(0);
  } finally {
    await stack.fixture('/approve');
  }
});
