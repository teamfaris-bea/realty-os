// The marketing tab and the marketing approval card against the REAL API (stack.ts), on the phone (iPhone
// 13, 390×844) and desktop (1440×900) projects (module 38, lane 2C marketing):
//   - the listing page opens its marketing tab; "Make marketing" drafts every kind;
//   - a draft is approved in ONE tap from the approvals inbox;
//   - the social post is approved and published to the fake Facebook Page; its publication says "Posted"
//     only once the server answered with a provider-confirmed publication (posted: true);
//   - where publishing is not available (Instagram without a photo; Marketplace), the server's sentence
//     is shown, and Copy exports the piece: "Exported: post it yourself".
// Each project boots its own stack, so the phone and desktop runs never share data.
import { type Locator, type Page, expect, test } from 'playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { phoneProblems, toastProblems } from '../a11y/checks.js';
import { type MarketingSeed, type MarketingStack, startMarketingStack } from './stack.js';

test.describe.configure({ mode: 'serial' });

let stack: MarketingStack;
let seed: MarketingSeed;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startMarketingStack();
  seed = await stack.fixture<MarketingSeed>('/seed');
});
test.afterAll(async () => {
  await stack?.stop();
});

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

async function tap(page: Page, target: Locator, counter: { taps: number }) {
  await target.scrollIntoViewIfNeeded();
  if (isPhone(page)) await target.tap();
  else await target.click();
  counter.taps += 1;
}

async function signIn(page: Page) {
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(seed.email);
  await page.getByLabel('Password').fill(seed.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible({ timeout: 15_000 });
}

/** The marketing tab's card group for one kind (newest version first). */
const pieceOf = (page: Page, kind: string) => page.locator(`li[data-piece-kind="${kind}"]`).first();

async function axe(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page: page as never }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
  return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

test('the listing page opens its marketing tab; "Make marketing" drafts every kind', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await page.goto(`${stack.webUrl}/listings/${seed.listingId}`);
  const n = { taps: 0 };
  await tap(page, page.getByRole('link', { name: 'Marketing' }), n);
  await expect(page).toHaveURL(new RegExp(`/listings/${seed.listingId}/marketing$`));
  await expect(page.getByRole('heading', { level: 1, name: 'Marketing' })).toBeVisible();
  await tap(page, page.getByRole('button', { name: 'Make marketing' }), n);
  for (const kind of ['social_post', 'website_page', 'flyer', 'open_house_invite', 'marketplace_export']) {
    await expect(pieceOf(page, kind).getByTestId('status-label')).toHaveText('Draft: not approved yet', { timeout: 15_000 });
  }
  expect(n.taps).toBe(2);
  // counsel cleared the pack: the review sentence is not shown
  await expect(page.getByText(/Not reviewed by counsel yet/)).toHaveCount(0);
  // a draft shows its brokerage name in the preview and has no Copy/Download (nothing leaves unapproved)
  await expect(pieceOf(page, 'flyer').getByRole('button', { name: 'Copy' })).toHaveCount(0);
  expect(await page.locator('main').textContent()).not.toMatch(/\bposted\b|\d+\s?%|score|confiden/i);
  expect(await axe(page)).toEqual([]);
  if (isPhone(page)) expect(await phoneProblems(page)).toEqual([]);
});

test('a draft is approved in ONE tap from the approvals inbox', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  await page.goto(`${stack.webUrl}/approvals`);
  const section = page.getByRole('region', { name: 'Marketing to approve' });
  const card = section.locator('article').filter({ hasText: 'Listing page · Version 1' });
  await expect(card).toHaveCount(1, { timeout: 15_000 });
  await expect(card.getByRole('heading', { level: 3 })).toContainText(seed.address);
  const approve = card.getByRole('button', { name: 'Approve' });
  expect((await approve.boundingBox())!.height).toBeGreaterThanOrEqual(44);
  const n = { taps: 0 };
  const answered = page.waitForResponse((r) => r.url().includes('/approve') && r.request().method() === 'POST');
  await tap(page, approve, n);
  expect((await answered).status()).toBe(200);
  await expect(card).toHaveCount(0, { timeout: 15_000 });
  expect(n.taps).toBe(1);
  console.log(`[${isPhone(page) ? 'phone' : 'desktop'}] approve from the approvals inbox: ${n.taps} tap`);
  // b19: the "Approved: …" toast is drawn in the page's one stack of toasts, a fixed element declared while it shows
  // (data-sticky). With it on screen (the phone project's 390 × 664; desktop 1440 × 900): it sits on no bar, every
  // control of the inbox can be brought clear of it, and the phone layout check is clean
  await expect(page.getByTestId('toast').getByText(`Approved: listing page for ${seed.address}`, { exact: false })).toBeVisible();
  expect(await toastProblems(page)).toEqual([]);
  if (isPhone(page)) expect(await phoneProblems(page)).toEqual([]);
  expect(await axe(page)).toEqual([]);
  if (isPhone(page)) expect(await phoneProblems(page)).toEqual([]);
  if (isPhone(page)) {
    // the same on the phone's whole screen, 390 × 844, with the next draft of the inbox (no later test reads it)
    // (the open house invite: it can be approved once its time is set, which is done on the marketing tab)
    const size = page.viewportSize()!;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${stack.webUrl}/listings/${seed.listingId}/marketing`);
    const time = pieceOf(page, 'open_house_invite').getByRole('form', { name: 'Open-house time' });
    await time.getByLabel('Open house starts').fill('2027-03-06T13:00');
    await time.getByLabel('Ends').fill('2027-03-06T15:00');
    await tap(page, time.getByRole('button', { name: 'Set the time' }), { taps: 0 });
    await expect(page.getByTestId('announcer')).toHaveText(/Open-house time set\./, { timeout: 15_000 });
    await page.goto(`${stack.webUrl}/approvals`);
    await expect(page.getByTestId('toast-stack')).not.toHaveAttribute('data-sticky', /.*/);
    const invite = section.locator('article').filter({ hasText: /Open house invite · Version \d/ });
    await expect(invite).toHaveCount(1, { timeout: 15_000 });
    await tap(page, invite.getByRole('button', { name: 'Approve' }), { taps: 0 });
    await expect(page.getByTestId('toast').getByText(`Approved: open house invite for ${seed.address}`, { exact: false })).toBeVisible({ timeout: 15_000 });
    expect(await toastProblems(page)).toEqual([]);
    expect(await phoneProblems(page)).toEqual([]);
    await page.setViewportSize(size);
  }
  await page.goto(`${stack.webUrl}/listings/${seed.listingId}/marketing`);
  await expect(pieceOf(page, 'website_page').getByTestId('status-label')).toHaveText('Approved: not shared anywhere yet', { timeout: 15_000 });
});

test('the social post is approved and published to the fake Facebook Page: "Posted" only after the server confirmed', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  await page.goto(`${stack.webUrl}/listings/${seed.listingId}/marketing`);
  const post = pieceOf(page, 'social_post');
  await expect(post.getByTestId('status-label')).toHaveText('Draft: not approved yet', { timeout: 15_000 });
  const approveTaps = { taps: 0 };
  await tap(page, post.getByRole('button', { name: 'Approve' }), approveTaps);
  await expect(post.getByTestId('status-label')).toHaveText('Approved: not shared anywhere yet', { timeout: 15_000 });
  expect(approveTaps.taps).toBe(1);
  // Instagram needs a photo: no Publish button for it, the server's sentence instead
  await expect(post.getByText('Instagram needs at least one photo on the post. Add one in a new version, or export it.')).toBeVisible();
  await expect(post.getByRole('button', { name: 'Publish to Harbor Insta' })).toHaveCount(0);
  const publish = post.getByRole('button', { name: 'Publish to Harbor Page' });
  await expect(publish).toBeVisible();
  // nothing claims a post before the provider answered
  expect(await post.textContent()).not.toMatch(/\bposted\b/i);
  const publishTaps = { taps: 0 };
  const answered = page.waitForResponse((r) => r.url().endsWith('/publish') && r.request().method() === 'POST');
  await tap(page, publish, publishTaps);
  const res = await answered;
  const body = (await res.json()) as { publication: { posted: boolean; status: string; label: string } | null };
  expect(res.status()).toBe(200);
  expect(body.publication).toMatchObject({ status: 'published', posted: true });
  const where = post.getByRole('list', { name: 'Where it went' });
  await expect(where.locator('li[data-posted="true"]')).toContainText('Posted to your Facebook Page', { timeout: 15_000 });
  await expect(where.locator('li[data-posted="false"]')).toHaveCount(0);
  await expect(post.getByTestId('status-label')).toHaveText('Posted: see each account below');
  expect(publishTaps.taps).toBe(1);
  console.log(`[${isPhone(page) ? 'phone' : 'desktop'}] approve social post: ${approveTaps.taps} tap; publish to the Page: ${publishTaps.taps} tap`);
  // the same version is never posted to the Page twice
  await expect(post.getByRole('button', { name: 'Publish to Harbor Page' })).toHaveCount(0);
  expect(await axe(page)).toEqual([]);
});

test('where publishing is not available, Copy exports it: "Exported: post it yourself"; the flyer downloads as a PDF', async ({ page }) => {
  test.setTimeout(90_000);
  await signIn(page);
  await page.goto(`${stack.webUrl}/listings/${seed.listingId}/marketing`);
  const mp = pieceOf(page, 'marketplace_export');
  await expect(mp.getByTestId('status-label')).toHaveText('Draft: not approved yet', { timeout: 15_000 });
  const n = { taps: 0 };
  await tap(page, mp.getByRole('button', { name: 'Approve' }), n);
  await expect(mp.getByRole('button', { name: 'Copy' })).toBeVisible({ timeout: 15_000 });
  await expect(mp.getByRole('button', { name: /^Publish/ })).toHaveCount(0);
  await tap(page, mp.getByRole('button', { name: 'Copy' }), n);
  await expect(mp.getByTestId('status-label')).toHaveText('Exported: post it yourself', { timeout: 15_000 });
  await expect(mp.getByText('Copied. Exported: post it yourself')).toBeVisible();
  // and heard: the page's one live region says it
  await expect(page.getByTestId('announcer')).toHaveText(/Exported: post it yourself/);
  expect(await mp.textContent()).not.toMatch(/\bposted\b/i);
  expect(n.taps).toBe(2);

  const flyer = pieceOf(page, 'flyer');
  await tap(page, flyer.getByRole('button', { name: 'Approve' }), n);
  const dl = page.waitForEvent('download');
  await tap(page, flyer.getByRole('button', { name: 'Download flyer' }), n);
  expect((await dl).suggestedFilename()).toBe('flyer.pdf');
  await expect(flyer.getByTestId('status-label')).toHaveText('Exported: post it yourself', { timeout: 15_000 });
  if (isPhone(page)) expect(await phoneProblems(page)).toEqual([]);
  expect(await axe(page)).toEqual([]);
});
