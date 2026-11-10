// web/lead-admin against the REAL API (stack.ts: api/platform's harness on a fresh per-test Postgres
// database, RLS-bound app_user, fake providers), on the phone (iPhone 13) and desktop (1440 px)
// projects:
//   - ARCHITECTURE §1 benchmark: a Team Lead reassigns from an exception in 2 taps, and the database
//     shows a real ownership-engine reassignment cited by the exception event (R-ACC-3 / R-OWN-18).
//   - Concurrency: the Team Lead and the Owner tap Verify on the same item at the same moment in two
//     sessions. Exactly one verified event is written; the other person is told in words that someone
//     handled it, and both queues end up without the item.
//   - axe-core (color contrast included) on the queue, no horizontal page scroll on a phone, and 44 px
//     tap targets for every button.
import { createRequire } from 'node:module';
import { type Browser, type Locator, type Page, expect, test } from 'playwright/test';
import { type LeadAdminStack, type World, startLeadAdminStack } from './stack.js';

const require = createRequire(import.meta.url);
const AXE_PATH = require.resolve('axe-core/axe.min.js');

test.describe.configure({ mode: 'serial' });

let stack: LeadAdminStack;
let w: World;
let leads: { contactId: string; ownerUserId: string; key: string }[];

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startLeadAdminStack();
  w = await stack.fixture<World>('/world');
  ({ leads } = await stack.fixture<{ leads: typeof leads }>('/exceptions', { names: ['Priya Shah', 'Marcus Lee'], promise: false, appointment: false }));
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

async function signIn(page: Page, who: 'teamLead' | 'owner') {
  const u = w[who];
  await page.goto(`${stack.webUrl}/login`);
  await page.getByLabel('Email').fill(u.email);
  await page.getByLabel('Password').fill(u.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  if (who === 'owner') {
    const { code } = await stack.fixture<{ code: string }>('/totp', { email: w.owner.email, secret: w.owner.totpSecret });
    await page.getByLabel('Code').fill(code);
    await page.getByRole('button', { name: 'Continue' }).click();
  }
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
}

function itemCard(page: Page, contactName: string): Locator {
  return page.locator('article').filter({ has: page.getByRole('heading', { level: 2, name: `Untouched lead · ${contactName}` }) });
}

test('a Team Lead reaches the queue in ≤ 2 taps and reassigns an untouched lead in 2 taps through the ownership engine', async ({ page }) => {
  await signIn(page, 'teamLead');
  const nav = { taps: 0 };
  if (isPhone(page)) {
    await tap(page, page.getByRole('navigation', { name: 'Main tabs' }).getByRole('link', { name: 'More' }), nav);
    await tap(page, page.getByRole('link', { name: 'Needs attention' }), nav);
  } else await tap(page, page.getByRole('navigation', { name: 'Main', exact: true }).getByRole('link', { name: 'Needs attention' }), nav);
  expect(nav.taps).toBeLessThanOrEqual(isPhone(page) ? 2 : 1);
  await expect(page.getByRole('heading', { level: 1, name: 'Needs attention' })).toBeVisible();

  const lead = leads[0]!;
  const card = itemCard(page, 'Priya Shah');
  await expect(card).toBeVisible();
  const target = w.agents.find((a) => a.userId !== lead.ownerUserId)!;
  const targetName = target.userId === w.agents[0]!.userId ? 'Ava Chen' : 'Ben Okafor';
  const job = { taps: 0 };
  await tap(page, card.getByRole('button', { name: 'Reassign' }), job);
  await tap(page, page.getByRole('group', { name: 'Reassign to' }).getByRole('button', { name: targetName }), job);
  await expect(page.getByText(`Reassigned Priya Shah to ${targetName}`)).toBeVisible();
  expect(job.taps).toBe(2);

  const state = await stack.fixture<{ events: { action: string; actor_user_id: string; ownership_command_id: string | null }[]; contact: { owner_user_id: string } }>('/exception-state', { key: lead.key, contactId: lead.contactId });
  expect(state.events).toHaveLength(1);
  expect(state.events[0]).toMatchObject({ action: 'reassigned', actor_user_id: w.teamLead.userId });
  expect(state.events[0]!.ownership_command_id).toBeTruthy();
  expect(state.contact.owner_user_id).toBe(target.userId);
  // R-ACC-1: a reassignment is not a resolution; the item stays live, now showing who reassigned it
  await expect(itemCard(page, 'Priya Shah').getByText(/Reassigned by Sam Rivera/)).toBeVisible();
});

test('concurrency: the Team Lead and the Owner verify the same item at once; one event is written and the other is told someone handled it', async ({ browser, page }) => {
  test.setTimeout(120_000);
  const lead = leads[1]!;
  await signIn(page, 'teamLead');
  const other = await (browser as Browser).newContext({ viewport: page.viewportSize() ?? { width: 1440, height: 900 } });
  try {
    const ownerPage = await other.newPage();
    await signIn(ownerPage, 'owner');
    await Promise.all([page.goto(`${stack.webUrl}/team`), ownerPage.goto(`${stack.webUrl}/team`)]);
    const a = itemCard(page, 'Marcus Lee').getByRole('button', { name: 'Verify' });
    const b = itemCard(ownerPage, 'Marcus Lee').getByRole('button', { name: 'Verify' });
    await Promise.all([expect(a).toBeVisible(), expect(b).toBeVisible()]);
    await Promise.all([a.click(), b.click()]);

    const done = (p: Page) => p.getByText('Verified: Untouched lead for Marcus Lee').or(p.getByText('Someone handled this just now. The list below is up to date.'));
    await Promise.all([expect(done(page)).toBeVisible(), expect(done(ownerPage)).toBeVisible()]);
    const state = await stack.fixture<{ events: { action: string }[] }>('/exception-state', { key: lead.key, contactId: lead.contactId });
    expect(state.events.filter((e) => e.action === 'verified')).toHaveLength(1);
    const conflicts = (await page.getByText('Someone handled this just now.', { exact: false }).count()) + (await ownerPage.getByText('Someone handled this just now.', { exact: false }).count());
    expect(conflicts).toBe(1);
    await expect(itemCard(page, 'Marcus Lee')).toHaveCount(0);
    await expect(itemCard(ownerPage, 'Marcus Lee')).toHaveCount(0);
  } finally {
    await other.close();
  }
});

test('the queue passes axe (color contrast included), has no horizontal scroll, and every button is a 44 px target', async ({ page }) => {
  await stack.fixture('/exceptions', { names: ['Dana Cho'], promise: true, appointment: false });
  await signIn(page, 'teamLead');
  await page.goto(`${stack.webUrl}/team`);
  await expect(itemCard(page, 'Dana Cho')).toBeVisible();
  await page.addScriptTag({ path: AXE_PATH });
  const violations = await page.evaluate(async () => {
    const r = await (window as unknown as { axe: { run(n: Node, o: unknown): Promise<{ violations: { id: string; nodes: { target: string[] }[] }[] }> } }).axe.run(document.body, { resultTypes: ['violations'] });
    return r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  });
  expect(violations).toEqual([]);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  const small = await page.locator('main button:visible, main [role="radio"]:visible').evaluateAll((els) => els.map((e) => e.getBoundingClientRect()).filter((r) => r.height < 44 || r.width < 44).length);
  expect(small).toBe(0);
});
