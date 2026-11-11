// The accessibility sweep (lane a11y-mobile) against the REAL API (stack.ts), on the phone (iPhone 13,
// 390×844) and desktop (1440×900) projects. Every page of the web page registry (pages.ts, kept in step
// with the registry by src/shell/a11yCoverage.test.ts) is opened as EVERY role that can see it, in light
// and dark, and checked with axe-core (@axe-core/playwright, WCAG 2.0/2.1/2.2 A and AA plus axe best
// practices: landmarks, heading order, accessible names, contrast). On the phone it also checks that
// the page never scrolls sideways and that every visible control in the page is a 44 × 44 px target.
//
// Pages owned by another lane right now (lane/optout-visibility: feed, contact, thread, compose,
// approvals) are swept too, but their findings are written to the report and annotations instead of
// failing this lane's suite; that lane fixes them.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from 'playwright/test';
import { ROLES, SIGNED_OUT_PAGES, SWEEP_PAGES } from './pages.js';
import { type A11yStack, type World, startA11yStack } from './stack.js';
import { obscuredFocus, phoneProblems } from './checks.js';
import { settle, signIn as signInAs } from './session.js';

const here = dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = resolve(here, '../../test-results/a11y');

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

export const AXE_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'];

async function axe(page: Page): Promise<string[]> {
  // @axe-core/playwright is typed against its own playwright-core; the runtime Page is the same API
  const r = await new AxeBuilder({ page: page as never }).withTags(AXE_TAGS).analyze();
  return r.violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
}

function report(name: string, data: unknown) {
  mkdirSync(REPORT_DIR, { recursive: true });
  writeFileSync(resolve(REPORT_DIR, `${name}.json`), JSON.stringify(data, null, 2));
}

for (const role of ROLES) {
  test(`${role}: every page they can open passes axe in light and dark, and holds up on a phone`, async ({ page }, info) => {
    test.setTimeout(300_000);
    await signInAs(page, stack, world, role);
    const own: string[] = [];
    const foreign: string[] = [];
    for (const p of SWEEP_PAGES.filter((x) => x.roles.includes(role))) {
      const url = p.url(world.ids);
      for (const scheme of ['light', 'dark'] as const) {
        await page.emulateMedia({ colorScheme: scheme });
        await page.goto(`${stack.webUrl}${url}`);
        await settle(page);
        const found = (await axe(page)).map((v) => `${scheme} ${p.path}: ${v}`);
        if (isPhone(page) && scheme === 'light') found.push(...(await phoneProblems(page)).map((v) => `${p.path}: ${v}`));
        (p.foreignLane ? foreign : own).push(...found);
      }
    }
    await page.emulateMedia({ colorScheme: 'light' });
    report(`${info.project.name}-${role}`, { own, foreign });
    if (foreign.length) info.annotations.push({ type: 'other lane (optout-visibility) a11y findings', description: foreign.join('\n') });
    expect(own).toEqual([]);
  });
}

test('a long conversation: the compose bar is a marked sticky bar and no focused control hides behind it (WCAG 2.4.11)', async ({ page }) => {
  await signInAs(page, stack, world, 'agent');
  await page.goto(`${stack.webUrl}/contacts/${world.ids.longThreadContactId}/thread`);
  await settle(page);
  const held = page.getByRole('group', { name: 'Held message' });
  await expect(held.getByRole('button', { name: 'Send anyway' })).toBeVisible({ timeout: 15_000 });
  // the conversation is taller than the window, so the bar really floats over it
  const tall = await page.evaluate(() => document.documentElement.scrollHeight > window.innerHeight * 1.5);
  expect(tall, 'the seeded conversation is longer than the screen').toBe(true);
  expect(await obscuredFocus(page)).toEqual([]);
  await expect(page.locator('main [data-sticky]')).toHaveCount(1);
  expect(await axe(page)).toEqual([]);
});

test('signed-out screens pass axe in light and dark, and hold up on a phone', async ({ page }) => {
  const found: string[] = [];
  for (const p of SIGNED_OUT_PAGES) {
    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.goto(`${stack.webUrl}${p.url}`);
      await expect(page.getByRole('heading', { level: 1, name: p.h1 })).toBeVisible();
      await page.waitForLoadState('networkidle');
      found.push(...(await axe(page)).map((v) => `${scheme} ${p.url}: ${v}`));
      if (isPhone(page) && scheme === 'light') found.push(...(await phoneProblems(page)).map((v) => `${p.url}: ${v}`));
    }
  }
  expect(found).toEqual([]);
});
