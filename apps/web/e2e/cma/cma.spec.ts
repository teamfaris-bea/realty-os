// The CMA screen against the REAL API (stack.ts: real Postgres, RLS-bound app_user, fake providers only; synthetic
// fixtures through api/cma's own test helpers), on the phone (iPhone 13, 390×844) and desktop (1440×900) projects
// (module 72, web/cma; D9 V2-A, R-CMA-7, R-CMA-9, D1).
// Accept: from the contact page, opening the CMA is 1 tap ("Prepare CMA", or the CMA's row once it exists) with the
// range and the comparable sales on screen. As shipped (platform:cma not reviewed) the screen names that in the
// server's words and Email is off. With platform:cma's review recorded in THIS test database only (restored in a
// finally, as withPlatformCmaCleared does), emailing is 1 more tap: "Sent", and exactly one email at the fake provider.
// The screen passes axe and the phone checks of the a11y sweep.
import AxeBuilder from '@axe-core/playwright';
import { type Locator, type Page, expect, test } from 'playwright/test';
import { obscuredFocus, phoneProblems } from '../a11y/checks.js';
import { type CmaSeed, type CmaStack, startCmaStack } from './stack.js';

test.describe.configure({ mode: 'serial' });

/** the a11y sweep's tags (e2e/a11y/a11y.spec.ts AXE_TAGS; not imported, so that spec's tests are not loaded here) */
const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

let stack: CmaStack;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startCmaStack();
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

async function signIn(page: Page, seed: CmaSeed) {
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(seed.email);
  await page.getByLabel('Password').fill(seed.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible({ timeout: 20_000 });
}

async function axe(page: Page): Promise<string[]> {
  const r = await new AxeBuilder({ page: page as never }).withTags(AXE_TAGS).analyze();
  return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

const homeValue = (page: Page) => page.locator('section').filter({ has: page.getByRole('heading', { name: 'Home value (CMA)' }) }).first();

async function openContact(page: Page, seed: CmaSeed) {
  await page.goto(`${stack.webUrl}/contacts/${seed.contactId}`);
  await expect(homeValue(page)).toBeVisible({ timeout: 20_000 });
}

/** The range and at least one comparable sale are on screen. */
async function rangeAndComps(page: Page) {
  await expect(page.getByRole('heading', { name: 'Estimated range' })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/^\$[\d,]+ to \$[\d,]+$/)).toBeVisible();
  await expect(page.getByText('This is an estimate, not an appraisal.', { exact: true })).toBeVisible();
  const comps = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Comparable sales' }) }).getByRole('article');
  expect(await comps.count()).toBeGreaterThanOrEqual(3);
  await expect(comps.first().getByText(/^Sold \$[\d,]+ on /)).toBeVisible();
}

test('opening the CMA is 1 tap from the contact page, with the range and the comps on screen; as shipped, the counsel-review sentence is shown and Email is off; axe and the phone checks pass', async ({ page }) => {
  test.setTimeout(180_000);
  const seed = await stack.fixture<CmaSeed>('/seed');
  await signIn(page, seed);
  await openContact(page, seed);
  const n = { taps: 0 };
  await tap(page, homeValue(page).getByRole('button', { name: 'Prepare CMA' }), n);
  await expect(page).toHaveURL(/\/cma\/[0-9a-f-]{36}$/, { timeout: 20_000 });
  await rangeAndComps(page);
  expect(n.taps).toBe(1);
  const cmaUrl = page.url();

  // the share preview, before any tap: platform:cma is not reviewed, said in the server's words; Email is off
  await expect(page.getByText('This CMA can’t be shown to a client yet:').first()).toBeVisible({ timeout: 20_000 });
  await expect(page.getByText(/counsel review/).first()).toBeVisible();
  const email = page.getByRole('button', { name: 'Email to Sam' });
  await expect(email).toBeVisible();
  await expect(email).toBeDisabled();
  // the screen's own words (the report preview quotes the MLS's attribution and disclaimer verbatim, so it is left out)
  const own = await page.locator('main').evaluate((m) => {
    const c = m.cloneNode(true) as HTMLElement;
    c.querySelectorAll('pre').forEach((p) => p.remove());
    return c.textContent ?? '';
  });
  expect(own).not.toMatch(/confiden|probab|accura|\bscore|likel|guarantee/i);

  // a comp expands to its adjustments, adjusted price and weight
  const first = page.locator('section').filter({ has: page.getByRole('heading', { name: 'Comparable sales' }) }).getByRole('article').first();
  await first.getByRole('button', { name: 'Show adjustments' }).click();
  await expect(first.getByText(/^Adjusted price: \$/)).toBeVisible();
  await expect(first.getByText(/^Counts for [\d.]+% of the estimate$/)).toBeVisible();
  await first.getByRole('button', { name: 'Hide adjustments' }).click();

  await page.waitForLoadState('networkidle');
  expect(await axe(page)).toEqual([]);
  if (isPhone(page)) {
    expect(await phoneProblems(page)).toEqual([]);
    expect(await obscuredFocus(page)).toEqual([]);
  }

  // the CMA is listed on the contact page: its row opens it in 1 tap
  await openContact(page, seed);
  const row = homeValue(page).getByRole('link', { name: `Open the CMA of ${seed.line1}, Oakland` });
  await expect(row).toBeVisible({ timeout: 15_000 });
  await expect(row.getByText('Draft')).toBeVisible();
  const again = { taps: 0 };
  await tap(page, row, again);
  await expect(page).toHaveURL(cmaUrl);
  await rangeAndComps(page);
  expect(again.taps).toBe(1);
  expect(await axe(page)).toEqual([]);
});

test('R-CMA-9 D1: with platform:cma reviewed in this test database only, emailing is 1 more tap: "Sent", and exactly one email at the fake provider', async ({ page }) => {
  test.setTimeout(180_000);
  const seed = await stack.fixture<CmaSeed>('/seed');
  await signIn(page, seed);
  await stack.fixture('/clear-platform');
  try {
    await openContact(page, seed);
    const n = { taps: 0 };
    await tap(page, homeValue(page).getByRole('button', { name: 'Prepare CMA' }), n);
    await expect(page).toHaveURL(/\/cma\/[0-9a-f-]{36}$/, { timeout: 20_000 });
    await rangeAndComps(page);
    expect(n.taps).toBe(1);

    const email = page.getByRole('button', { name: 'Email to Sam' });
    await expect(email).toBeEnabled({ timeout: 20_000 });
    // the recipient and the address are on screen before the tap (audit cma-v2a F7): in the share panel, and on a phone
    // also in the sticky bar beside the Email button (ShareRecipient); desktop has no bar and says it once
    const to = `To: Sam Seller · ${seed.sellerEmail}`;
    await expect(page.getByRole('region', { name: 'Share with the client' }).getByText(to, { exact: true })).toBeVisible();
    const bar = page.locator('main [data-sticky]');
    if (isPhone(page)) {
      await expect(bar.getByText(to, { exact: true })).toBeVisible();
      await expect(bar.getByRole('button', { name: 'Email to Sam' })).toBeVisible();
    } else await expect(bar).toHaveCount(0);
    await expect(page.getByText(to, { exact: true })).toHaveCount(isPhone(page) ? 2 : 1);
    await expect(page.getByText('This CMA can’t be shown to a client yet:')).toHaveCount(0);
    expect((await email.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    expect(await stack.fixture<{ count: number }>('/sent', { to: seed.sellerEmail })).toEqual({ count: 0 });
    if (isPhone(page)) {
      expect(await phoneProblems(page)).toEqual([]);
      expect(await obscuredFocus(page)).toEqual([]);
    }
    expect(await axe(page)).toEqual([]);

    const send = { taps: 0 };
    await tap(page, email, send);
    await expect(page.getByText('Sent', { exact: true })).toBeVisible({ timeout: 20_000 });
    expect(send.taps).toBe(1);
    await expect(page.getByRole('heading', { name: 'The email' })).toBeVisible();
    await expect(page.getByText(/^Shared on /)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Email to Sam' })).toHaveCount(0);
    expect(await stack.fixture<{ count: number }>('/sent', { to: seed.sellerEmail })).toEqual({ count: 1 });
    await expect(page.getByRole('link', { name: 'Download the PDF (to print or hand over)' })).toBeVisible();
    expect(await axe(page)).toEqual([]);

    // read only once shared: no Remove, no editor
    await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(0);
    await expect(page.getByRole('button', { name: "Edit the home's facts" })).toHaveCount(0);
    await page.reload();
    await expect(page.getByText('Sent.')).toBeVisible({ timeout: 20_000 });
    expect(await stack.fixture<{ count: number }>('/sent', { to: seed.sellerEmail })).toEqual({ count: 1 });
  } finally {
    await stack.fixture('/restore-platform');
  }
});
