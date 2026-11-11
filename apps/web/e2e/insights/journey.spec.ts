// Module 40 end to end, against the REAL API (stack.ts), on the phone (iPhone 13) and desktop (1440 px) projects.
// Taps are counted like the other specs (one real touch tap on the phone, one click on desktop; typing and choosing
// from a select are not taps):
//   (a) the Owner opens the Owner view — desktop: 1 click in the sidebar; phone: More → Owner view, 2 taps — and sees
//       every number with its denominator: commission "from 2 of 3 closings with a commission entered", the cost per
//       closing in words, the deals left out by name, velocity, and the 90-day range with its method and k of n;
//   (b) the Owner sets a goal for an agent on Goals and sees its pace in words (1 tap: Set goal);
//   (c) the agent opens Home, taps "See the plan" on the weekly plan card (1 tap) and lands on that week's plan:
//       3–5 items, deadline first, each with why; "Add … to my tasks" adds them (1 tap) — 2 taps from Home.
// Then axe (contrast included) on each page, no sideways scroll on a phone and 44 px targets.
import { createRequire } from 'node:module';
import { type Locator, type Page, expect, test } from 'playwright/test';
import { type InsightsStack, type World, startInsightsStack } from './stack.js';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

test.describe.configure({ mode: 'serial' });

let stack: InsightsStack;
let w: World;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startInsightsStack();
  w = await stack.fixture<World>('/world');
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

async function signIn(page: Page, who: 'owner' | 'agent') {
  const u = w[who];
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(u.email);
  await page.getByLabel('Password').fill(u.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (who === 'owner') {
    const { code } = await stack.fixture<{ code: string }>('/totp', { email: u.email });
    await page.getByLabel('Code').fill(code);
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible({ timeout: 15_000 });
}

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run(ctx: Document, o: object): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document, { resultTypes: ['violations'] });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

async function layoutChecks(page: Page) {
  expect(await axeViolations(page)).toEqual([]);
  if (isPhone(page)) expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  const small = await page.locator('main button:visible, main a.min-h-tap:visible').evaluateAll((els) => els.filter((e) => e.getBoundingClientRect().height < 44).map((e) => e.textContent?.trim()));
  expect(small).toEqual([]);
}

async function openFromNav(page: Page, label: string, n: { taps: number }) {
  if (isPhone(page)) {
    await tap(page, page.getByRole('link', { name: 'More' }).last(), n);
    await tap(page, page.getByRole('link', { name: label }), n);
  } else {
    await tap(page, page.getByRole('navigation').getByRole('link', { name: label }), n);
  }
}

test('(a) R-OWNER-1 E107 E108 E109: the Owner opens the Owner view and every number shows its denominator and method', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, 'owner');
  const n = { taps: 0 };
  await openFromNav(page, 'Owner view', n);
  await expect(page.getByRole('heading', { level: 1, name: 'Owner view' })).toBeVisible();
  expect(n.taps).toBe(isPhone(page) ? 2 : 1);
  const main = page.getByRole('main');
  // the desktop table or the phone cards (whichever this viewport shows)
  const zillow = isPhone(page) ? main.getByRole('article').filter({ hasText: 'Zillow' }) : main.getByRole('row', { name: /Zillow/ });
  await expect(zillow).toContainText('$15,000.50');
  await expect(zillow).toContainText('from 2 of 3 closings with a commission entered');
  await expect(zillow).toContainText('$300.00 per closing (3 closings)');
  await expect(main.getByText(/1 closed deal with no commission entered/)).toBeVisible();
  await expect(main.getByRole('link', { name: 'Diaz purchase' })).toBeVisible();
  await expect(main.getByText(/summed by the lead source each deal was created with/)).toBeVisible();
  await expect(main.getByText('Under contract: 7 of 10 closed within 90 days').first()).toBeVisible();
  await expect(main.getByText(/Not enough history: Prospect, Agreement signed, Active/).first()).toBeVisible();
  await expect(main.getByTestId('forecast-closings')).toContainText('closings');
  const text = (await main.textContent())!.replace(/80% Wilson range/g, '');
  expect(text).not.toMatch(/confiden|probab|%|\bscore\b|grade/i);
  await layoutChecks(page);
});

test('(b) R-PLAN-2: the Owner sets a goal for an agent and sees its pace', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, 'owner');
  const n = { taps: 0 };
  await openFromNav(page, 'Goals', n);
  await expect(page.getByRole('heading', { level: 1, name: 'Goals' })).toBeVisible();
  await page.getByLabel('Member').selectOption({ label: 'Ava Chen' });
  await page.getByLabel('Period').selectOption('month');
  await page.getByLabel('What to count').selectOption('closings');
  await page.getByLabel('Target').fill('4');
  const before = n.taps;
  await tap(page, page.getByRole('button', { name: 'Set goal' }), n);
  expect(n.taps - before).toBe(1);
  await expect(page.getByText(/^2 of 4 closings; [\d.]+ expected by now; 2 to go in \d+ days?$/)).toBeVisible();
  await expect(page.getByText(/Counted from the scoreboard/)).toBeVisible();
  await layoutChecks(page);
});

test('(c) R-PLAN-1 R-PLAN-3: the agent’s weekly plan card opens the plan in 1 tap; one more tap adds the items to their tasks', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, 'agent');
  const card = page.locator('article').filter({ has: page.getByText('Your plan this week', { exact: true }) }).first();
  await expect(card).toBeVisible({ timeout: 15_000 });
  const n = { taps: 0 };
  await tap(page, card.getByRole('button', { name: 'See the plan' }), n);
  await expect(page).toHaveURL(new RegExp(`/plan/${w.week}$`));
  const items = page.getByRole('main').getByRole('article');
  const add = page.getByRole('button', { name: /^Add \d items? to my tasks$/ });
  await expect(add).toBeVisible();
  const count = Number(/Add (\d)/.exec((await add.textContent())!)![1]);
  await expect(items).toHaveCount(count);
  expect(count).toBeGreaterThanOrEqual(3);
  expect(count).toBeLessThanOrEqual(5);
  await expect(items.nth(0).getByRole('heading', { level: 2 })).toHaveText('Keep your promise: Send Sam the comps');
  await expect(items.nth(1).getByRole('heading', { level: 2 })).toHaveText('Order the yard sign');
  await expect(items.nth(0)).toContainText(/Due /);
  for (let i = 0; i < count; i++) await expect(items.nth(i).getByRole('list', { name: 'Why this is on your plan' })).not.toBeEmpty();
  await expect(page.getByText(/built from your pipeline only/)).toBeVisible();
  await layoutChecks(page);
  await tap(page, add, n);
  await expect(page.getByText('On your tasks').first()).toBeVisible();
  expect(n.taps).toBe(2);
  const t = await stack.fixture<{ titles: string[] }>('/tasks', { userId: w.agent.userId });
  expect(t.titles).toContain('Send Sam the comps');
  await layoutChecks(page);
});
