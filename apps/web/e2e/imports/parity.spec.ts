// The import's "Stages, tags and custom fields" section (PARITY_PLAN module 65; R-PAR-46) against the REAL
// stack (a11y/stack.ts seeds a CSV import through the API), on the phone and desktop projects: the section
// says what will land before anything is written, the controls meet the 44 px target, nothing scrolls
// sideways on a phone, and the report shows the parity rows. Screenshots go to test-results/imports.
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

test('R-PAR-46: an Owner sees how stages, tags and custom fields will land before approving, on phone and desktop', async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, stack, world, 'owner');
  await page.goto(`${stack.webUrl}/imports/${world.ids.importId}`);
  await settle(page);
  // the seeded CSV import has not taken its snapshot yet: nothing is planned before it (R-IMPORT-1)
  await expect(page.getByRole('region', { name: 'Stages, tags and custom fields' })).toHaveCount(0);
  const snap = page.getByRole('button', { name: 'Take snapshot' });
  if (await snap.count()) {
    await snap.click();
    await expect(page.getByText('Taking the snapshot…')).toBeVisible({ timeout: 15_000 }).catch(() => undefined);
    await stack.drainImports();
    await page.reload();
    await settle(page);
  }
  const section = page.getByRole('region', { name: 'Stages, tags and custom fields' });
  await expect(section).toBeVisible({ timeout: 30_000 });
  await expect(section.getByText(/No stages in your file: everyone starts as New\./).first()).toBeVisible();
  await expect(section.getByText(/Tags never decide who can be contacted/)).toBeVisible();
  const small = await section.evaluate((root, min) => {
    const out: string[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('button, select, input[type=checkbox]'))) {
      const t = el.tagName === 'INPUT' ? (el.closest('label') ?? el) : el;
      const r = t.getBoundingClientRect();
      if (r.width && r.height < min - 0.5) out.push(`${el.tagName} ${Math.round(r.height)}`);
    }
    return out;
  }, MIN_TAP);
  expect(small).toEqual([]);
  if (isPhone(page)) expect(await phoneProblems(page)).toEqual([]);
  await section.screenshot({ path: `test-results/imports/parity-${isPhone(page) ? 'phone' : 'desktop'}.png` });
  // saving keeps the (empty) map and leaves the contacts check to be run again
  await section.getByRole('button', { name: 'Save stages, tags and fields' }).click();
  await expect(page.getByText(/Saved\./).first()).toBeVisible({ timeout: 15_000 });
});
