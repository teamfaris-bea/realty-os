// Module 41 admin pages against the REAL API (stack.ts: a fresh Postgres database, RLS-bound app_user, fake
// providers, MLS live calls off; no external call), on the phone (390×844) and desktop (1440×900) projects. Each
// test counts the taps a person makes and checks there is no sideways scroll:
//   - Integrations: the Owner sees every service's state and the counsel-review banner; no Meta DM, lead-ads or
//     Meta-ads kind is offered and platform:meta is not shown as a review to clear;
//   - MLS: the Owner marks the licence pack reviewed value by value and the page then says MLS data may reach
//     clients (before: it cannot);
//   - Website chat: the Owner adds a widget and gets the embed code with the key, once; after a reload the key is gone.
// Set SHOTS_DIR to also save a full-page screenshot of each page.
import { type Locator, type Page, expect, test } from 'playwright/test';
import { type AdminPagesStack, type World, startAdminPagesStack } from './stack.js';

test.describe.configure({ mode: 'serial' });

let stack: AdminPagesStack;
let w: World;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startAdminPagesStack();
  w = await stack.fixture<World>('/world');
  await stack.fixture('/mls');
  await stack.fixture('/chat-source');
});
test.afterAll(async () => {
  await stack?.stop();
});

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

/** Taps a person makes (clicks on desktop). */
function taps(page: Page) {
  let n = 0;
  const tap = async (l: Locator) => {
    n += 1;
    if (isPhone(page)) await l.tap();
    else await l.click();
  };
  const count = Object.assign(() => n, { add: () => void (n += 1) });
  return { tap, count };
}

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

async function openFromNav(page: Page, t: ReturnType<typeof taps>, label: string) {
  if (isPhone(page)) {
    await t.tap(page.getByRole('navigation', { name: 'Main tabs' }).getByRole('link', { name: 'More' }));
    await t.tap(page.getByRole('link', { name: label, exact: true }));
  } else await t.tap(page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name: label, exact: true }));
}

/** The shell asks for the password again when the API wants a fresh sign-in (integration.manage is 🔒). */
async function passwordIfAsked(page: Page, t: ReturnType<typeof taps>) {
  const prompt = page.getByRole('dialog', { name: "Confirm it's you" });
  if (await prompt.isVisible().catch(() => false)) {
    await prompt.getByLabel('Password').fill(w.owner.password);
    await t.tap(prompt.getByRole('button', { name: 'Confirm' }));
  }
}

async function noSideScroll(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
}

async function shot(page: Page, name: string) {
  const dir = process.env.SHOTS_DIR;
  if (dir) await page.screenshot({ path: `${dir}/${name}-${isPhone(page) ? 'phone' : 'desktop'}.png`, fullPage: true });
}

test('Integrations: the Owner sees every service and each review pack in words, and no out-of-scope Meta kind', async ({ page }) => {
  await signInOwner(page);
  const t = taps(page);
  await openFromNav(page, t, 'Integrations');
  await expect(page.getByRole('heading', { level: 1, name: 'Integrations' })).toBeVisible();
  for (const name of ['Facebook Page (publishing)', 'Instagram business account (publishing)', 'Google Ads account', 'Google Business Profile', 'Zillow lead feed', 'realtor.com lead feed', 'Lead email inbox', 'Website chat', 'MLS listings (Spark, read-only)']) {
    await expect(page.getByRole('heading', { level: 3, name })).toBeVisible();
  }
  await expect(page.getByText(/This deployment uses test adapters/)).toBeVisible();
  const review = page.getByRole('region', { name: 'Counsel review' });
  await expect(review.getByText('Not reviewed by counsel').first()).toBeVisible();
  const text = await page.locator('main').innerText();
  expect(text).not.toMatch(/Messenger|direct messages|Lead Ads|Meta ads|Meta messaging|platform:/);
  await expect(page.getByRole('button', { name: /^Connect/ })).toHaveCount(0);
  expect(t.count()).toBe(isPhone(page) ? 2 : 1);
  await noSideScroll(page);
  await shot(page, 'integrations');
});

test('MLS: the Owner marks the licence pack reviewed value by value; only then may MLS data reach clients', async ({ page }) => {
  await signInOwner(page);
  const t = taps(page);
  await openFromNav(page, t, 'MLS');
  await expect(page.getByRole('heading', { level: 1, name: 'MLS' })).toBeVisible();
  await expect(page.getByText('MLS data does not reach clients')).toBeVisible();
  await expect(page.getByText(/MLS data as of/).first()).toBeVisible();
  const pack = page.getByRole('region', { name: 'Licence pack' });
  await expect(pack.getByText(/MLS data cannot reach clients until every value is marked as reviewed by counsel\. 9 of 9/)).toBeVisible();
  await noSideScroll(page);
  await shot(page, 'mls-before');
  const marks = pack.getByRole('checkbox', { name: 'Counsel reviewed this value' });
  await expect(marks).toHaveCount(9);
  for (let i = 0; i < 9; i++) await t.tap(marks.nth(i));
  await t.tap(pack.getByRole('button', { name: 'Save licence pack' }));
  await passwordIfAsked(page, t);
  await expect(pack.getByText('Licence pack saved. Every value is marked as reviewed by counsel.')).toBeVisible();
  await expect(page.getByText('MLS data may reach clients')).toBeVisible();
  // open (1 desktop, 2 phone) + 9 marks + Save (+ the password prompt's Confirm when asked)
  expect(t.count()).toBeGreaterThanOrEqual((isPhone(page) ? 2 : 1) + 10);
  expect(t.count()).toBeLessThanOrEqual((isPhone(page) ? 2 : 1) + 11);
  test.info().annotations.push({ type: 'taps', description: `MLS licence pack reviewed: ${t.count()} taps` });
  await noSideScroll(page);
  await shot(page, 'mls-after');
});

test('Website chat: the Owner adds a widget and gets the embed code once; a reload never shows the key again', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']).catch(() => undefined);
  await signInOwner(page);
  const t = taps(page);
  await openFromNav(page, t, 'Website chat');
  await expect(page.getByRole('heading', { level: 1, name: 'Website chat' })).toBeVisible();
  await expect(page.getByText('No chat widgets yet.')).toBeVisible();
  // the seeded team has several lead sources; the chat one carries the consent disclosure the widget shows first
  await page.getByLabel('Lead source').selectOption({ label: 'Website chat' });
  t.count.add();
  await t.tap(page.getByRole('button', { name: 'Add widget' }));
  await passwordIfAsked(page, t);
  const panel = page.getByRole('region', { name: 'Website chat is added' });
  await expect(panel.getByText('Shown only this once')).toBeVisible();
  const key = await panel.getByLabel('Widget key').inputValue();
  expect(key).toMatch(/^wk_[0-9a-f]{40}$/);
  const code = await panel.getByLabel('Embed code').inputValue();
  expect(code).toContain(`data-widget-key="${key}"`);
  expect(code).toMatch(/data-disclosure-id="[0-9a-f-]{36}"/);
  expect(code).toContain('/widget/chat.js');
  await t.tap(panel.getByRole('button', { name: 'Copy embed code' }));
  await expect(panel.getByText(/Embed code copied\.|Couldn't copy automatically/)).toBeVisible();
  // open (1 desktop, 2 phone) + choose the lead source + Add widget + Copy (+ Confirm when asked)
  expect(t.count()).toBeLessThanOrEqual((isPhone(page) ? 2 : 1) + 4);
  test.info().annotations.push({ type: 'taps', description: `Widget added and embed code copied: ${t.count()} taps` });
  await noSideScroll(page);
  await shot(page, 'webchat-key');

  await page.reload();
  await expect(page.getByRole('heading', { level: 3, name: 'Website chat' })).toBeVisible();
  expect(await page.content()).not.toContain(key);
  await expect(page.getByText(/To get it again, make a new key\./)).toBeVisible();
  await noSideScroll(page);
  await shot(page, 'webchat-list');
});

test('Website chat: a lead source without a consent disclosure is said honestly, with no broken embed code', async ({ page }) => {
  await signInOwner(page);
  await page.goto(`${stack.webUrl}/admin/web-chat`);
  await expect(page.getByRole('heading', { level: 2, name: 'Add a chat widget' })).toBeVisible();
  const select = page.getByLabel('Lead source');
  const other = (await select.locator('option').allTextContents()).find((o) => o !== 'Website chat');
  test.skip(other === undefined, 'the seeded team has no other lead source');
  await select.selectOption({ label: other! });
  await page.getByLabel('Widget name').fill('No disclosure');
  await page.getByRole('button', { name: 'Add widget' }).click();
  await passwordIfAsked(page, taps(page));
  const panel = page.getByRole('region', { name: 'No disclosure is added' });
  await expect(panel.getByLabel('Widget key')).toBeVisible();
  await expect(panel.getByText("The chat window won't appear yet")).toBeVisible();
  await expect(panel.getByLabel('Embed code')).toHaveCount(0);
});
