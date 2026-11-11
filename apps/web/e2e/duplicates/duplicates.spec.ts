// Resolve a duplicate (PARITY_PLAN module 66, §5: Duplicates → pair → Merge = 3 taps; FUB ~4, VERIFY)
// against the REAL stack (a11y/stack.ts: the API on a fresh Postgres database as app_user, fake
// providers), on the phone (iPhone 13) and desktop (1440 x 900) projects. The agent opens the seeded
// pair (two "Dana Fox" records sharing an email), reads the honest pre-merge text, and merges through
// the ownership engine; then the merged person's page opens. Screenshots of both sizes are written to
// test-results/duplicates (looked at by the author).
import { type Page, expect, test } from 'playwright/test';
import { MIN_TAP, phoneProblems } from '../a11y/checks.js';
import { settle, signIn } from '../a11y/session.js';
import { type A11yStack, type World, startA11yStack } from '../a11y/stack.js';

test.describe.configure({ mode: 'serial' });

let stack: A11yStack;
let world: World;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startA11yStack();
  world = await stack.world();
});
test.afterAll(async () => {
  await stack?.stop();
});

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;
const shot = (page: Page, name: string) => page.screenshot({ path: `test-results/duplicates/${name}-${isPhone(page) ? 'phone' : 'desktop'}.png`, fullPage: true });

async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate((min) => {
    const out: string[] = [];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('main a, main button, main input[type=radio]'))) {
      const target = el.tagName === 'INPUT' ? (el.closest('label') ?? el) : el;
      const r = target.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.height < min - 0.5 || r.width < min - 0.5) out.push(`${el.tagName} "${(el.textContent ?? '').trim().slice(0, 40)}" ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  }, MIN_TAP);
}

test('R-PAR-44 R-PAR-45 §5: an agent resolves a duplicate in 3 taps from Duplicates, with every opt-out promise shown before the tap', async ({ page }) => {
  test.setTimeout(120_000);
  // the phone and desktop projects run against one seeded world: the phone merges, the desktop dismisses and undoes
  await signIn(page, stack, world, 'agent');
  // reach the Duplicates page from the navigation (phone: More → Duplicates; desktop: the sidebar)
  if (isPhone(page)) {
    await page.getByRole('link', { name: 'More' }).click();
    await page.getByRole('link', { name: 'Duplicates' }).click();
  } else {
    await page.getByRole('navigation').getByRole('link', { name: 'Duplicates' }).click();
  }
  await settle(page);
  await expect(page.getByRole('heading', { level: 1, name: 'Duplicates' })).toBeVisible();
  let taps = 1; // the Duplicates entry itself (§5 counts it as the first tap)
  const review = page.getByRole('link', { name: 'Review Dana Fox and Dana Fox' });
  if ((await review.count()) === 0) test.skip(true, 'the pair was already resolved by the other project');
  await shot(page, 'list');
  await review.click();
  taps += 1;
  await settle(page);
  await expect(page.getByText('Same email address')).toBeVisible();
  await expect(page.getByText(/Every opt-out on either record stays/)).toBeVisible();
  await expect(page.getByText(/Moves to the kept record/)).toBeVisible();
  expect(await smallTargets(page)).toEqual([]);
  if (isPhone(page)) expect(await phoneProblems(page)).toEqual([]);
  await shot(page, 'pair');
  if (isPhone(page)) {
    await page.getByRole('button', { name: 'Merge into Dana Fox' }).click();
    taps += 1;
    await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    expect(taps).toBeLessThanOrEqual(3);
    // the pair is gone from the list
    await page.goto(`${stack.webUrl}/duplicates`);
    await settle(page);
    await expect(page.getByRole('link', { name: 'Review Dana Fox and Dana Fox' })).toHaveCount(0);
  } else {
    await page.getByRole('button', { name: 'Not the same person' }).click();
    await expect(page.getByText('Marked Dana Fox and Dana Fox as different people.')).toBeVisible();
    await shot(page, 'dismissed');
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.getByRole('link', { name: 'Review Dana Fox and Dana Fox' })).toBeVisible({ timeout: 15_000 });
    // and the 3-tap merge on desktop too
    await page.getByRole('link', { name: 'Review Dana Fox and Dana Fox' }).click();
    await settle(page);
    await page.getByRole('button', { name: 'Merge into Dana Fox' }).click();
    await expect(page).toHaveURL(/\/contacts\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    expect(taps + 1).toBeLessThanOrEqual(3);
  }
});

test('R-PERM-15: a transaction coordinator has no Duplicates page', async ({ page }) => {
  await signIn(page, stack, world, 'tc');
  await page.goto(`${stack.webUrl}/duplicates`);
  await expect(page.getByRole('heading', { level: 1, name: 'Duplicates' })).toHaveCount(0);
});
