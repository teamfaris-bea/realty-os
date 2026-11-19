// Source coverage end to end, against the REAL API (stack.ts: api/platform's harness on a fresh per-test Postgres
// database, the RLS-bound app_user, fake providers), on the phone (iPhone 13) and desktop (1440 px) projects (b19
// team-queue lane, step 2; DATA_MODEL R-TEAMQ-10, R-TEAMQ-11):
//   (a) the Owner opens Lead sources: the seeded source says "Not covered: no owner and no backup are named."; on
//       its page the Covered switch cannot be turned on until an owner and a backup are picked; picking both,
//       marking high intent and turning it on is saved (asserted in the database, with one audit row), and the page
//       and the list card then say "Covered: … owns this source and … is the backup." with "High intent";
//   (b) the Owner suspends the backup (through the API): the source page says "Not covered: the backup, …, is
//       suspended." and that nobody was put in their place; the database still names them;
//   (c) axe (contrast included) on the source page in light and dark, no sideways scroll on a phone, 44 px targets.
// Nothing here sends anything or moves a lead. Names are made up.
import { createRequire } from 'node:module';
import { type Locator, type Page, expect, test } from 'playwright/test';
import { type CoverageFacts, type LeadSourcesStack, type World, startLeadSourcesStack } from './stack.js';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');
const SOURCE = 'Portal';

test.describe.configure({ mode: 'serial' });

let stack: LeadSourcesStack;
let w: World;
let agents: { userId: string; firstAgentUserId: string };
let sourceUrl = '';

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startLeadSourcesStack();
  w = await stack.fixture<World>('/world');
  agents = await stack.fixture<{ userId: string; firstAgentUserId: string }>('/second-agent');
});
test.afterAll(async () => {
  await stack?.stop();
});

const isPhone = (page: Page) => (page.viewportSize()?.width ?? 1440) < 768;
const tap = (page: Page, target: Locator) => (isPhone(page) ? target.tap() : target.click());

async function signIn(page: Page) {
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(w.owner.email);
  await page.getByLabel('Password').fill(w.owner.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  const { code } = await stack.fixture<{ code: string | null }>('/totp', { email: w.owner.email });
  if (code) {
    await page.getByLabel('Code').fill(code);
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible({ timeout: 15_000 });
}

const coverageCard = (page: Page): Locator => page.locator('section').filter({ has: page.getByRole('heading', { level: 2, name: 'Coverage' }) });
const listCard = (page: Page): Locator => page.locator('article').filter({ has: page.getByRole('heading', { level: 2, name: SOURCE }) });

test('(a) the Owner names an owner and a backup, marks high intent and turns coverage on; the page, the list and the database agree', async ({ page }) => {
  await signIn(page);
  if (isPhone(page)) {
    await tap(page, page.getByRole('navigation', { name: 'Main tabs' }).getByRole('link', { name: 'More' }));
    await tap(page, page.getByRole('main').getByRole('link', { name: 'Lead sources' }));
  } else await tap(page, page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name: 'Lead sources' }));
  await expect(page.getByRole('heading', { level: 1, name: 'Lead sources' })).toBeVisible();
  await expect(listCard(page).getByText('Not covered: no owner and no backup are named.')).toBeVisible();

  await tap(page, listCard(page).getByRole('link', { name: SOURCE, exact: true }));
  await expect(page.getByRole('heading', { level: 1, name: SOURCE })).toBeVisible({ timeout: 15_000 });
  sourceUrl = page.url().replace(/\?.*$/, '');
  const card = coverageCard(page);
  await expect(card.getByText('Not covered: no owner and no backup are named.')).toBeVisible();
  await expect(card.getByRole('list', { name: 'What to check' }).getByRole('listitem')).toContainText(['No owner is named for this source.', 'No backup is named for this source.']);
  const covered = card.getByRole('checkbox', { name: 'Covered' });
  await expect(covered).toBeDisabled();
  await expect(card.getByText('Name an owner and a backup first.')).toBeVisible();

  await card.getByLabel('Owner').selectOption({ label: 'Casey Agent (Agent)' });
  await expect(covered).toBeDisabled();
  await card.getByLabel('Backup').selectOption({ label: 'Riley Backup (Agent)' });
  await expect(covered).toBeEnabled();
  await card.getByRole('checkbox', { name: 'High intent' }).check();
  await covered.check();
  await tap(page, card.getByRole('button', { name: 'Save coverage' }));
  await expect(card.getByRole('status').filter({ hasText: 'Coverage saved' })).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText('Covered: Casey Agent owns this source and Riley Backup is the backup.')).toBeVisible();

  const facts = await stack.fixture<CoverageFacts>('/coverage-facts', { name: SOURCE });
  expect(facts).toMatchObject({ ownerUserId: agents.firstAgentUserId, backupUserId: agents.userId, highIntent: true, covered: true, audits: 1 });

  await page.goto(`${stack.webUrl}/admin/lead-sources`);
  await expect(listCard(page).getByText('Covered: Casey Agent owns this source and Riley Backup is the backup.')).toBeVisible();
  await expect(listCard(page).getByText('High intent')).toBeVisible();
  expect(await page.locator('body').textContent()).not.toMatch(/NO_OWNER|NO_BACKUP|SHARED_FALLBACK_POND|NO_ROUTING_RULE|VALIDATION_FAILED/);
});

test('(b) suspending the backup flags the source: "Not covered", why, and nobody put in their place; the database still names them', async ({ page }) => {
  expect(sourceUrl).not.toBe('');
  expect((await stack.fixture<{ status: number }>('/suspend', { userId: agents.userId })).status).toBe(200);
  await signIn(page);
  await page.goto(sourceUrl);
  const card = coverageCard(page);
  await expect(card.getByText('Not covered: the backup, Riley Backup, is suspended.')).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText(/^The backup, Riley Backup, is suspended\. Nobody was put in their place/)).toBeVisible();
  await expect(card.getByLabel('Backup').locator('option:checked')).toHaveText('Riley Backup (suspended)');
  const facts = await stack.fixture<CoverageFacts>('/coverage-facts', { name: SOURCE });
  expect(facts).toMatchObject({ ownerUserId: agents.firstAgentUserId, backupUserId: agents.userId, covered: true, audits: 1 });
});

test('(c) the source page with its Coverage card: axe (incl. contrast) in light and dark, no horizontal scroll on a phone, 44 px tap targets', async ({ page }) => {
  test.setTimeout(120_000);
  expect(sourceUrl).not.toBe('');
  await signIn(page);
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme });
    await page.goto(sourceUrl);
    await expect(coverageCard(page).getByRole('button', { name: 'Save coverage' })).toBeVisible({ timeout: 15_000 });
    await page.waitForLoadState('networkidle');
    await page.addScriptTag({ path: AXE_PATH });
    const violations = await page.evaluate(async () => {
      const r = await (window as unknown as { axe: { run(n: Node, o: unknown): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document.body, { resultTypes: ['violations'] });
      return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
    });
    expect(violations, scheme).toEqual([]);
    if (isPhone(page)) {
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, 'horizontal scroll').toBeLessThanOrEqual(0);
    }
    const small = await coverageCard(page)
      .locator('button:visible, select:visible, label:visible:has(input[type=checkbox])')
      .evaluateAll((els) => els.map((e) => ({ t: (e.textContent ?? '').trim().slice(0, 30), h: e.getBoundingClientRect().height, w: e.getBoundingClientRect().width })).filter((x) => x.h < 44 || x.w < 44));
    expect(small, `${scheme} tap targets`).toEqual([]);
  }
});
