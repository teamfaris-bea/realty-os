// The People tab and smart lists (PARITY_PLAN module 61) against the REAL API (stack.ts: api/lists on a
// fresh per-test Postgres database, RLS-bound app_user), on the phone (iPhone 13) and desktop (1440 px)
// projects. Each job of PARITY_PLAN §5 is run with its taps counted:
//   open a smart list: phone People → list = 2 · desktop list = 1 (from the People page)
//   see everyone with a tag: tap chip = 1
//   bulk tag 30 from a list: phone People → list → Select all → Tag → tag = 5 · desktop 4 to module 64's
//     count sheet (the frozen target, built by the server from the whole list), then Confirm in the sheet
//     starts it at 6 · 5: one over §5's 5 · 4 ("count sheet confirms inline"), an owner gap (ARCHITECTURE)
//   next person in a list: Next = 1 · desktop J = 1
// Then 44 px tap targets on the People page and no horizontal scroll on a phone.
import { type Locator, type Page, expect, test } from 'playwright/test';
import { type ListsStack, startListsStack } from './stack.js';

test.describe.configure({ mode: 'serial' });

let stack: ListsStack;
let world: { agent: { email: string; password: string }; buyerTagId: string; listId: string; firstContactId: string };

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startListsStack();
  world = await stack.fixture('/world');
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
  await page.getByLabel('Email').fill(world.agent.email);
  await page.getByLabel('Password').fill(world.agent.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
}

/** The People nav entry: the phone tab bar or the desktop sidebar. */
const peopleNav = (page: Page) => page.getByRole('navigation').getByRole('link', { name: 'People', exact: true }).first();

test('open a smart list: phone People → list = 2 taps; desktop 1 click from the People page', async ({ page }) => {
  await signIn(page);
  const c = { taps: 0 };
  if (isPhone(page)) await tap(page, peopleNav(page), c);
  else await page.goto(`${stack.webUrl}/people`);
  await expect(page.getByRole('heading', { level: 2, name: 'Everyone' })).toBeVisible();
  await expect(page.getByText('Showing people you can see')).toBeVisible();
  await tap(page, page.getByRole('navigation', { name: 'Lists' }).getByRole('button', { name: 'Hot buyers' }), c);
  await expect(page.getByRole('heading', { level: 2, name: 'Hot buyers' })).toBeVisible();
  await expect(page.getByText(/^30 people · Showing people you can see/)).toBeVisible();
  expect(c.taps).toBe(isPhone(page) ? 2 : 1);
});

test('see everyone with a tag: 1 tap on a chip', async ({ page }) => {
  await signIn(page);
  await page.goto(`${stack.webUrl}/people`);
  const c = { taps: 0 };
  await tap(page, page.getByRole('button', { name: 'Tag Buyer, show everyone with it' }).first(), c);
  await expect(page.getByRole('heading', { level: 2, name: 'Tag: Buyer' })).toBeVisible();
  await expect(page.getByText(/^30 people/)).toBeVisible();
  expect(c.taps).toBe(1);
});

test('bulk tag 30 from a list: phone 5 taps, desktop 4 to module 64\'s count sheet with the frozen target; Confirm starts it at 6 / 5 (one over PARITY_PLAN §5)', async ({ page }) => {
  await signIn(page);
  const c = { taps: 0 };
  if (isPhone(page)) await tap(page, peopleNav(page), c);
  else await page.goto(`${stack.webUrl}/people`);
  await tap(page, page.getByRole('navigation', { name: 'Lists' }).getByRole('button', { name: 'Hot buyers' }), c);
  await expect(page.getByText(/^30 people/)).toBeVisible();
  await tap(page, page.getByRole('checkbox', { name: /Select all/ }), c);
  const bar = page.getByRole('region', { name: 'Bulk actions' });
  await expect(bar.getByText('30 selected')).toBeVisible();
  await tap(page, bar.getByRole('button', { name: 'Tag', exact: true }), c);
  await tap(page, page.getByRole('dialog').getByRole('button', { name: 'Investor' }), c);
  const sheet = page.getByRole('dialog', { name: 'Tag 30 of 30?' });
  await expect(sheet).toBeVisible();
  await expect(sheet.getByText('Tag "Investor"')).toBeVisible();
  expect(c.taps).toBe(isPhone(page) ? 5 : 4); // to the count sheet only: nothing has started yet
  await tap(page, sheet.getByRole('button', { name: 'Tag 30 people' }), c);
  await expect(page.getByText(/Started: 30 people/)).toBeVisible();
  expect(c.taps).toBe(isPhone(page) ? 6 : 5); // started: §5 asks 5 / 4, an owner gap
});

test('next person in a list: 1 tap (phone) or J (desktop)', async ({ page }) => {
  await signIn(page);
  await page.goto(`${stack.webUrl}/people?list=${world.listId}`);
  await expect(page.getByRole('heading', { level: 2, name: 'Hot buyers' })).toBeVisible();
  const rows = page.getByRole('list', { name: 'People' }).getByRole('link');
  const firstName = (await rows.first().textContent())!.trim();
  const secondName = (await rows.nth(1).textContent())!.trim();
  await rows.first().click();
  await expect(page.getByText(/^1 of 30/)).toBeVisible();
  await expect(page.getByRole('heading', { name: firstName }).first()).toBeVisible();
  const c = { taps: 0 };
  if (isPhone(page)) await tap(page, page.getByRole('button', { name: 'Next person' }), c);
  else {
    await page.keyboard.press('j');
    c.taps += 1;
  }
  await expect(page.getByText(/^2 of 30/)).toBeVisible();
  await expect(page.getByRole('heading', { name: secondName }).first()).toBeVisible();
  expect(c.taps).toBe(1);
});

test('the People page: every control is at least 44 px; no horizontal scroll on a phone', async ({ page }) => {
  await signIn(page);
  await page.goto(`${stack.webUrl}/people?list=${world.listId}`);
  await expect(page.getByRole('heading', { level: 2, name: 'Hot buyers' })).toBeVisible();
  await page.getByRole('checkbox', { name: /Select all/ }).check();
  await expect(page.getByRole('region', { name: 'Bulk actions' })).toBeVisible();
  const small = await page.evaluate(() => {
    const out: string[] = [];
    for (const el of document.querySelectorAll<HTMLElement>('main button, main a[href], main label:has(input), [aria-label="Bulk actions"] button')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.height < 43.5 || r.width < 43.5) out.push(`${el.tagName} "${(el.getAttribute('aria-label') ?? el.textContent ?? '').trim().slice(0, 40)}" ${Math.round(r.width)}×${Math.round(r.height)}`);
    }
    return out;
  });
  expect(small).toEqual([]);
  if (isPhone(page)) {
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
  }
});
