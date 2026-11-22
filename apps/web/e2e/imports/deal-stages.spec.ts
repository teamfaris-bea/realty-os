// Deal stages (Owner), on the phone and desktop projects: every Follow Up Boss stage is listed with
// its deals, a waiting deal is called out, the controls are at least 44 px, a phone does not scroll
// sideways, and saving the stage clears the wait. A second save does not say another deal came in.
import { type Page, expect, test } from 'playwright/test';
import { MIN_TAP, phoneProblems } from '../a11y/checks.js';
import { settle } from '../a11y/session.js';
import { type DealStageStack, type DealStageWorld, startDealStageStack } from './deal-stages-stack.js';

test.describe.configure({ mode: 'serial' });

let stack: DealStageStack;
let world: DealStageWorld;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startDealStageStack();
  world = await stack.world();
});
test.afterAll(async () => {
  await stack?.stop();
});

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;

async function signIn(page: Page) {
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(world.email);
  await page.getByLabel('Password').fill(world.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await page.getByLabel('Code').fill(await stack.totp(world.email));
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible({ timeout: 20_000 });
}

test('an Owner maps a Follow Up Boss deal stage, on a phone and on desktop', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page);
  await page.goto(`${stack.webUrl}/imports/${world.importId}`);
  await settle(page);
  const section = page.getByRole('region', { name: 'Deal stages' });
  await expect(section).toBeVisible();
  await expect(section.getByText('1 deal is waiting because the stage is not mapped.')).toBeVisible();
  await expect(section.getByLabel('Active (1 deal)')).toBeVisible();
  await expect(section.getByLabel('Waiting On Lender (1 deal)')).toBeVisible();
  const small = await section.evaluate((root, min) => {
    const out: string[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('button, select'))) {
      const r = el.getBoundingClientRect();
      if (r.width && (r.height < min - 0.5 || r.width < min - 0.5)) out.push(`${el.tagName} ${Math.round(r.width)}x${Math.round(r.height)}`);
    }
    return out;
  }, MIN_TAP);
  expect(small).toEqual([]);
  if (isPhone(page)) expect(await phoneProblems(page)).toEqual([]);
  await section.getByLabel('Waiting On Lender (1 deal)').selectOption('active');
  await section.getByRole('button', { name: 'Save deal stages' }).click();
  await expect(page.getByText('1 deal that was waiting is in.')).toBeVisible({ timeout: 20_000 });
  await expect(section.getByText('1 deal is waiting because the stage is not mapped.')).toHaveCount(0);
  await section.getByRole('button', { name: 'Save deal stages' }).click();
  await expect(page.getByRole('status').filter({ hasText: /^Saved\.$/ })).toBeVisible({ timeout: 20_000 });
  await section.screenshot({ path: `test-results/imports/deal-stages-${isPhone(page) ? 'phone' : 'desktop'}.png` });
});
