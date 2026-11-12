// The weekly seller update against the REAL API (stack.ts: real Postgres, RLS-bound app_user, fake providers
// only), on the phone (iPhone 13, 390×844) and desktop (1440×900) projects (modules 28 and 38).
// Accept (PHASE2_3_PLAN §5.4 #28): a listing agent sends a weekly update in ≤ 3 taps on a phone, with a typed
// recommendation, every figure sourced, through dispatch. Taps are counted from the Home feed: the card's
// "Open listing", the recommendation box, Send. Typing is not a tap. Also: the opted-out co-seller is shown
// before the tap and never sent to (R-SELL-5, D1); stale data says so and offers one tap to refresh
// (R-SELL-4); the page passes axe and the phone checks of the a11y sweep.
import { createRequire } from 'node:module';
import { type Locator, type Page, expect, test } from 'playwright/test';
import { obscuredFocus, phoneProblems } from '../a11y/checks.js';
import { type SellerSeed, type SellerStack, startSellerStack } from './stack.js';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');
const REC = 'Hold the price two more weeks; the feedback on the kitchen is strong.';

test.describe.configure({ mode: 'serial' });

let stack: SellerStack;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startSellerStack();
});
test.afterAll(async () => {
  await stack?.stop();
});

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

async function tap(page: Page, target: Locator, counter: { taps: number }) {
  await target.scrollIntoViewIfNeeded();
  if (isPhone(page)) await target.tap();
  else await target.click();
  counter.taps += 1;
}

async function signIn(page: Page, seed: SellerSeed) {
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(seed.email);
  await page.getByLabel('Password').fill(seed.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
}

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE_PATH });
  return page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run(ctx: Document, o: object): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document, { resultTypes: ['violations'] });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
}

const sellerCard = (page: Page) => page.locator('section').filter({ has: page.getByRole('heading', { name: 'Seller update this week' }) }).first();

test('a listing agent sends the weekly update in ≤ 3 taps from the feed: typed recommendation, every figure sourced, the opted-out co-seller shown before the tap and never sent to', async ({ page }) => {
  test.setTimeout(180_000);
  const seed = await stack.fixture<SellerSeed>('/seed');
  await signIn(page, seed);
  const n = { taps: 0 };
  const feedCard = page.locator('article').filter({ has: page.getByText('Seller update to review', { exact: true }) }).first();
  await expect(feedCard).toBeVisible({ timeout: 20_000 });
  await tap(page, feedCard.getByRole('button', { name: 'Open listing' }), n);
  await expect(page).toHaveURL(new RegExp(`/listings/${seed.listingId}$`));
  const card = sellerCard(page);
  await expect(card).toBeVisible({ timeout: 15_000 });

  // before any tap on Send: who it reaches and who it cannot, in words
  const goes = card.getByRole('list', { name: 'Goes to' });
  await expect(goes.getByText('Sam Ortiz')).toBeVisible();
  await expect(goes.getByText('Not sent: their phone texted STOP.')).toBeVisible();
  // every figure says where it came from and as of when
  await expect(card.getByText('2 showings logged in Realty OS this week', { exact: true }).first()).toBeVisible();
  await expect(card.getByText('Showings are logged by hand in Realty OS; no showing service is connected.')).toBeVisible();
  await expect(card.getByText('Competing listings unavailable: no MLS feed connected').first()).toBeVisible();
  expect(await card.getByText(/^Sources · as of /).count()).toBeGreaterThanOrEqual(3);
  await expect(card.getByText('Names a person. Check it before you send.')).toBeVisible();
  expect(await card.textContent()).not.toMatch(/confiden|probab|page views?|email opens?|\d+\s?%/i);

  // the recommendation is required: Send is off until it is typed
  const send = card.getByRole('button', { name: 'Send to Sam Ortiz' });
  await expect(send).toBeDisabled();
  const box = card.getByLabel('Your recommendation (required)');
  await expect(box).toHaveValue('');
  await tap(page, box, n);
  await box.pressSequentially(REC, { delay: 0 });
  await expect(send).toBeEnabled();
  const box44 = await send.boundingBox();
  expect(box44!.height).toBeGreaterThanOrEqual(44);
  await tap(page, send, n);
  await expect(card.getByText('Sam Ortiz: Sent')).toBeVisible({ timeout: 20_000 });
  expect(n.taps).toBeLessThanOrEqual(3);

  // through dispatch, with the fakes: one email to Sam with the recommendation; nothing to the co-seller who texted STOP
  const { messages } = await stack.fixture<{ messages: { contact_id: string; channel: string; status: string; body: string }[] }>('/messages', { contactIds: [seed.samId, seed.alexId] });
  expect(messages.filter((m) => m.contact_id === seed.alexId)).toEqual([]);
  const toSam = messages.filter((m) => m.contact_id === seed.samId);
  expect(toSam).toHaveLength(1);
  expect(toSam[0]).toMatchObject({ channel: 'email', status: 'sent' });
  expect(toSam[0]!.body).toContain(REC);

  await page.reload();
  await expect(sellerCard(page).getByText(/^Sent /)).toBeVisible({ timeout: 15_000 });
});

test('R-SELL-4: data that moved after assembly says so; Send stays off; one tap refreshes and the update sends; the page passes axe and the phone checks', async ({ page }) => {
  test.setTimeout(180_000);
  const seed = await stack.fixture<SellerSeed>('/seed');
  await signIn(page, seed);
  await stack.fixture('/showing');
  await page.goto(`${stack.webUrl}/listings/${seed.listingId}`);
  const card = sellerCard(page);
  await expect(card.getByText('New data since this was put together')).toBeVisible({ timeout: 15_000 });
  expect(await axeViolations(page)).toEqual([]);
  if (isPhone(page)) {
    expect(await phoneProblems(page)).toEqual([]);
    expect(await obscuredFocus(page)).toEqual([]);
  }
  await card.getByLabel('Your recommendation (required)').fill(REC);
  await expect(card.getByRole('button', { name: 'Send to Sam Ortiz' })).toBeDisabled();
  await card.getByRole('button', { name: 'Refresh the update' }).click();
  await expect(card.getByText('New data since this was put together')).toHaveCount(0, { timeout: 15_000 });
  await expect(card.getByText('3 showings logged in Realty OS this week', { exact: true }).first()).toBeVisible();
  await expect(card.getByLabel('Your recommendation (required)')).toHaveValue(REC);
  await card.getByRole('button', { name: 'Send to Sam Ortiz' }).click();
  await expect(card.getByText('Sam Ortiz: Sent')).toBeVisible({ timeout: 20_000 });
});
