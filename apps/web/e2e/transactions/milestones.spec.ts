// Module 31 + 39 (with 18a) against the REAL API (journeys/stack.ts: a fresh Postgres database, RLS-bound app_user,
// the real worker drained through /jobs, fake providers only), on the phone (iPhone 13, 390×844) and desktop
// (1440×900) projects (§6 Phase 2 criterion 7, tap counts asserted):
//   1. a TC opens the deal, enters the acceptance date and proposes the list from the tenant's template (1 tap),
//      then confirms each proposed date with its Confirm chip (1 tap each), all on the deal's one screen; the rule
//      and "not reviewed by counsel" are on that screen;
//   2. on desktop the TC confirms a proposed date from the TC board in 1 tap;
//   3. a confirmed milestone becomes overdue (stored-instant clock fixture), the tenant exception scan is enqueued
//      exactly as maintenance does and exception.recompute is drained once (no wall-clock 60 s), and the Team Lead
//      sees "Milestone at risk" on the queue, linked to the deal.
import { expect, test } from 'playwright/test';
import { isPhone, shot, signIn, tap } from '../journeys/helpers.js';
import { type JourneyStack, type WorldInfo, startJourneyStack } from '../journeys/stack.js';

test.describe.configure({ mode: 'serial' });

let stack: JourneyStack;
let w: WorldInfo;
let tc: { email: string; password: string; userId: string };

/** A fictional tenant template (test data; no state's contract defaults). */
const TEMPLATE = {
  id: 'purchase-e2e',
  version: 1,
  name: 'Purchase (test data)',
  side: 'buy',
  jurisdiction: 'US',
  rules: [
    { key: 'inspection', kind: 'inspection', offsetDays: 10, dayCount: 'business', responsible: 'buyer', reminderDaysBefore: 2 },
    { key: 'appraisal', kind: 'appraisal', offsetDays: 17, dayCount: 'calendar', responsible: 'lender', reminderDaysBefore: 3 },
    { key: 'closing', kind: 'closing', offsetDays: 30, dayCount: 'calendar', reminderDaysBefore: 5 },
  ],
};

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startJourneyStack({
    imports: `import { enqueueTenantScan } from './src/accountability/testing.ts';\nimport { ownedContact } from './src/comms/testing.ts';`,
    routes: `
  /** a TC member (client "<world>.tc") and the tenant's milestone templates (set by the Owner through the API) */
  async '/txn-setup'(b) {
    const w = world(b.world);
    const tc = await h.invite(w.owner, 'tc');
    clients.set((b.world ?? 'a') + '.tc', tc);
    must(await call(w.owner, 'PUT', '/transactions/milestone-templates', { templates: b.templates }), 'templates');
    return { tc: who(tc) };
  },
  /** a buy deal of agent0 on a new contact, with the TC as a member */
  async '/txn-deal'(b) {
    const w = world(b.world);
    const tc = client((b.world ?? 'a') + '.tc');
    const c = await ownedContact(w.agents[0], { consent: false, firstName: b.firstName ?? 'Robin' });
    const d = must(await call(w.agents[0], 'POST', '/deals', { primaryContactId: c.id, side: 'buy' }), 'deal');
    must(await call(w.owner, 'POST', '/deals/' + d.deal.id + '/members', { userId: tc.userId, role: 'tc' }), 'member');
    return { dealId: d.deal.id, name: d.deal.name };
  },
  /** clock fixture: a confirmed date's stored due instant moves into the past (Postgres' clock cannot be faked) */
  async '/clock/date'(b) {
    await h.su.query("UPDATE deal_dates SET due_at = now() - interval '2 hours' WHERE id = $1 AND status = 'confirmed'", [b.dateId]);
    return { ok: true };
  },
  /** the periodic exception scan, enqueued exactly as the maintenance pass does */
  async '/exception-scan'(b) { return { enqueued: await enqueueTenantScan(h, world(b.world).tenantId) }; },
`,
  });
  w = await stack.world({ agents: 2, teamLead: true });
  tc = (await stack.fixture<{ tc: typeof tc }>('/txn-setup', { templates: [TEMPLATE] })).tc;
});
test.afterAll(async () => {
  await stack?.stop();
});

test('module 31/39: a TC enters the acceptance date and confirms the proposed list on one screen; a proposed date is confirmed in 1 tap', async ({ page }, info) => {
  test.setTimeout(240_000);
  const deal = await stack.fixture<{ dealId: string; name: string }>('/txn-deal', { firstName: info.project.name === 'phone' ? 'Robin' : 'Riley' });
  await signIn(page, stack, tc);
  await page.goto(`${stack.webUrl}/deals/${deal.dealId}`);
  await expect(page.getByRole('heading', { level: 1, name: deal.name })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/not reviewed by counsel/).first()).toBeVisible();
  const url = page.url();

  // the acceptance date (typed) and the template's list (1 tap)
  const taps = { taps: 0 };
  await page.getByLabel('Acceptance date').fill('2027-03-01');
  await tap(page, page.getByRole('button', { name: 'Propose dates' }), taps);
  const dates = page.getByRole('list', { name: 'Dates' });
  await expect(dates.getByRole('button', { name: /^Confirm / })).toHaveCount(3, { timeout: 15_000 });
  expect(taps.taps, 'propose the list = 1 tap').toBe(1);
  await expect(page.getByText('Rule: 10 business days after acceptance (2027-03-01)')).toBeVisible();
  await shot(page, info, 'm31', '1-proposed');

  // each proposed date: its Confirm chip, 1 tap
  for (let i = 0; i < 3; i++) {
    const before = taps.taps;
    const chip = dates.getByRole('button', { name: /^Confirm / }).first();
    await tap(page, chip, taps);
    await expect(dates.getByRole('button', { name: /^Confirm / })).toHaveCount(2 - i, { timeout: 15_000 });
    expect(taps.taps - before, 'confirm a proposed date = 1 tap').toBe(1);
  }
  expect(page.url(), 'one screen').toBe(url);
  expect(taps.taps, 'acceptance date + list on one screen: 1 + 3 taps').toBe(4);
  const rows = await stack.sql<{ status: string; confirmed_by_user_id: string; due_at: string | null }>("SELECT status, confirmed_by_user_id, due_at FROM deal_dates WHERE deal_id = $1 AND source = 'template' ORDER BY due_on", [deal.dealId]);
  expect(rows.map((r) => [r.status, r.confirmed_by_user_id, r.due_at !== null])).toEqual([0, 1, 2].map(() => ['confirmed', tc.userId, true]));
  await expect(dates.getByRole('button', { name: /^Mark .* done$/ })).toHaveCount(3);
  await shot(page, info, 'm31', '2-confirmed');
});

test('module 39: on desktop the TC confirms a proposed date from the TC board in 1 tap', async ({ page }, info) => {
  test.setTimeout(180_000);
  test.skip(isPhone(page), 'the TC board is the desktop view (the phone confirms on the deal page, test above)');
  const deal = await stack.fixture<{ dealId: string; name: string }>('/txn-deal', { firstName: 'Blake' });
  expect((await stack.api('a.tc', 'POST', `/deals/${deal.dealId}/milestones/plan`, { acceptanceDate: '2027-04-01', templateId: TEMPLATE.id, templateVersion: 1 })).status).toBe(200);
  await signIn(page, stack, tc);
  await page.goto(`${stack.webUrl}/transactions`);
  await expect(page.getByRole('heading', { level: 1, name: 'Transactions' })).toBeVisible({ timeout: 15_000 });
  const card = page.getByRole('listitem').filter({ has: page.getByRole('link', { name: deal.name }) });
  await expect(card.getByText('3 proposed')).toBeVisible({ timeout: 15_000 });
  const taps = { taps: 0 };
  await tap(page, card.getByRole('button', { name: /^Confirm Inspection/ }), taps);
  await expect(card.getByText('2 proposed')).toBeVisible({ timeout: 15_000 });
  expect(taps.taps, 'confirm from the board = 1 tap').toBe(1);
  await shot(page, info, 'm31', '3-board');
});

test('module 31 + 18a: an overdue confirmed milestone appears in the Team Lead queue, linked to the deal', async ({ page }, info) => {
  test.setTimeout(240_000);
  const deal = await stack.fixture<{ dealId: string; name: string }>('/txn-deal', { firstName: info.project.name === 'phone' ? 'Casey' : 'Corey' });
  const plan = await stack.api<{ proposals: { dateId: string; ruleKey: string }[] }>('a.tc', 'POST', `/deals/${deal.dealId}/milestones/plan`, { acceptanceDate: '2027-05-03', templateId: TEMPLATE.id, templateVersion: 1 });
  const inspection = plan.body.proposals.find((p) => p.ruleKey === 'inspection')!.dateId;
  expect((await stack.api('a.tc', 'POST', `/deal-dates/${inspection}/confirm`, {})).status).toBe(200);
  // the confirmed date's stored deadline passes; the tenant scan runs once on the real worker
  await stack.fixture('/clock/date', { dateId: inspection });
  const key = `milestone:${inspection}:1`;
  await expect.poll(async () => {
    await stack.fixture('/exception-scan', { world: 'a' });
    await stack.jobs({ kinds: ['exception.recompute'], tenantId: w.tenantId });
    return (await stack.sql('SELECT 1 FROM exception_items WHERE dedupe_key = $1', [key])).length;
  }, { timeout: 30_000 }).toBe(1);

  await signIn(page, stack, w.lead!);
  await page.goto(`${stack.webUrl}/team`);
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15_000 });
  await tap(page, page.getByRole('radio', { name: /^Dates at risk/ }));
  await expect(page.getByText('Milestone at risk').first()).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Inspection deadline has passed and is not marked done').first()).toBeVisible();
  // b8 deals ui/F7: the card's heading names the deal (linked to it) and the date (the template labels it "Inspection")
  const heading = page.getByRole('heading', { level: 2 }).filter({ hasText: `Milestone at risk · ${deal.name} · Inspection, ` });
  await expect(heading).toHaveCount(1);
  await expect(heading.getByRole('link', { name: deal.name })).toHaveAttribute('href', `/deals/${deal.dealId}`);
  await shot(page, info, 'm31', '4-tl-queue');
  // the item's deal evidence opens the deal (evidenceRoutes.deal)
  await tap(page, page.getByRole('link', { name: 'The deal this date belongs to' }).first());
  await expect(page.getByRole('heading', { level: 1, name: deal.name })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText('Overdue', { exact: false }).first()).toBeVisible();
});
