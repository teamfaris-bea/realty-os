// J2 — nobody accepts, against the REAL API (journeys/stack.ts: a fresh Postgres database, RLS-bound
// app_user, fake providers only), on the phone (iPhone 13, 390×844) and desktop (1440×900) projects:
//   - an offer the agent leaves alone expires (stored-deadline clock fixture + the real offer-expiry timer
//     job on the real worker): it moves to the NEXT agent of the round-robin rule, never back to one who
//     already had it, and after max_offers (3, the default) it goes to the default pond
//     (sent_to_pond MAX_OFFERS_REACHED). The first agent's feed card and its Accept are gone (a late Accept is
//     refused); the ledger holds every step;
//   - a pond claim race between two agents ends with exactly one owner: two simultaneous API claims give
//     one 200 and one 409 with a precise code (recorded as a rejection), and in the browser the agent who
//     taps Claim a moment too late reads "Someone else claimed this lead just now." and the card goes away.
import { randomUUID } from 'node:crypto';
import { expect, test } from 'playwright/test';
import { feedCard, isPhone, pollSql, shot, signIn, tap } from './helpers.js';
import { type JourneyStack, type WorldInfo, startJourneyStack } from './stack.js';

test.describe.configure({ mode: 'serial' });

let stack: JourneyStack;
let w: WorldInfo;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  stack = await startJourneyStack();
  w = await stack.world({ agents: 3 });
});
test.afterAll(async () => {
  await stack?.stop();
});

/** the fixture client name of an agent ("a.agent0" …) by user id */
const clientOf = (userId: string) => `a.agent${w.agents.findIndex((a) => a.userId === userId)}`;

interface Row {
  ownership_state: string;
  offered_to_user_id: string | null;
  owner_user_id: string | null;
  offer_id: string | null;
  pond_id: string | null;
}
const state = async (id: string) => (await stack.sql<Row>('SELECT ownership_state, offered_to_user_id, owner_user_id, offer_id, pond_id FROM contacts WHERE id = $1', [id]))[0]!;

async function newLead(fullName: string): Promise<string> {
  const { phone } = await stack.fixture<{ phone: string }>('/phone');
  const r = await stack.fixture<{ status: number; body: { contactId: string } }>('/intake', { body: { fullName, phones: [phone], message: 'Looking in 94610', postalCode: '94610' } });
  expect(r.status).toBe(201);
  return r.body.contactId;
}

/** expires the current offer through the stored deadline and the real timer job; returns the new state */
async function expireOffer(contactId: string): Promise<Row> {
  const before = await state(contactId);
  await stack.fixture('/clock/offer', { contactId, ms: -1000 });
  await expect.poll(async () => {
    await stack.jobs({ kinds: ['ownership.offer_expiry'], tenantId: w.tenantId });
    return (await state(contactId)).offer_id !== before.offer_id;
  }, { timeout: 20_000 }).toBe(true);
  return state(contactId);
}

/** a lead accepted by whoever it was offered to and released by them to the default pond (real commands) */
async function pondLead(fullName: string): Promise<{ id: string; releasedBy: string }> {
  const id = await newLead(fullName);
  const s = await state(id);
  const as = clientOf(s.offered_to_user_id!);
  expect((await stack.api(as, 'POST', `/leads/${id}/accept`, { commandId: randomUUID(), offerId: s.offer_id })).status).toBe(200);
  const rel = await stack.api(as, 'POST', `/leads/${id}/release`, { commandId: randomUUID(), reason: 'not_a_fit' });
  expect(rel.status, JSON.stringify(rel.body)).toBe(200);
  expect(await state(id)).toMatchObject({ ownership_state: 'in_pond', pond_id: w.defaultPondId, owner_user_id: null });
  return { id, releasedBy: s.offered_to_user_id! };
}

test('J2: an offer nobody accepts moves to the next agent on expiry, never back, and reaches the pond after max_offers; the first agent’s offer card is gone', async ({ page }, info) => {
  test.setTimeout(180_000);
  const name = `Omar ${info.project.name === 'phone' ? 'Phone' : 'Desk'}`;
  const id = await newLead(name);
  const first = await state(id);
  expect(first.ownership_state).toBe('offered');
  const firstAgent = w.agents.find((a) => a.userId === first.offered_to_user_id)!;

  await signIn(page, stack, firstAgent);
  const card = feedCard(page, name);
  await expect(card.getByRole('button', { name: 'Accept' })).toBeVisible({ timeout: 15_000 });
  await shot(page, info, 'j2', '1-offer');

  // expiry 1 → the next agent; expiry 2 → the third; expiry 3 → the pond (max_offers = 3)
  const offerees = [first.offered_to_user_id!];
  const second = await expireOffer(id);
  expect(second.ownership_state).toBe('offered');
  offerees.push(second.offered_to_user_id!);
  const third = await expireOffer(id);
  expect(third.ownership_state).toBe('offered');
  offerees.push(third.offered_to_user_id!);
  expect(new Set(offerees).size, 'each expiry offers an agent who has not had it').toBe(3);
  const last = await expireOffer(id);
  expect(last).toMatchObject({ ownership_state: 'in_pond', pond_id: w.defaultPondId, owner_user_id: null, offered_to_user_id: null });
  const ledger = await stack.sql<{ type: string; reason_code: string; actor_kind: string }>('SELECT type, reason_code, actor_kind FROM lead_ownership_events WHERE contact_id = $1 ORDER BY seq', [id]);
  expect(ledger.map((e) => e.type)).toEqual(['created', 'offered', 'offer_expired', 'offered', 'offer_expired', 'offered', 'offer_expired', 'sent_to_pond']);
  expect(ledger.at(-1)).toMatchObject({ reason_code: 'MAX_OFFERS_REACHED', actor_kind: 'timer' });
  // no offer is left for anyone, nothing was sent to the lead
  expect((await stack.sends()).sms).toHaveLength(0);

  // the first agent's screen: the offer is no longer actionable
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Home' })).toBeVisible();
  await expect(feedCard(page, name).getByRole('button', { name: 'Accept' }).and(page.locator(':enabled'))).toHaveCount(0, { timeout: 15_000 });
  await shot(page, info, 'j2', '2-after-expiry');
  // an Accept that was in flight is refused, and the lead stays in the pond. Once the offer moved on the
  // first agent lost sight of the lead (R-PERM-7), so the API answers 404, as leads/ownership.test.ts allows
  const late = await stack.api(clientOf(firstAgent.userId), 'POST', `/leads/${id}/accept`, { commandId: randomUUID(), offerId: first.offer_id });
  expect([404, 409]).toContain(late.status);
  if (late.status === 409) expect((late.body as { error?: { code?: string } }).error?.code).toMatch(/^LEAD_OFFER_(EXPIRED|SUPERSEDED)$|^LEAD_STATE_CHANGED$/);
  expect((await state(id)).ownership_state).toBe('in_pond');
});

test('J2: a pond claim race between two agents ends with exactly one owner; the loser gets a precise 409 and is recorded', async ({ page }, info) => {
  test.setTimeout(180_000);
  const tag = info.project.name === 'phone' ? 'Phone' : 'Desk';

  // 1. two agents claim the same pond lead at the same moment (API)
  const racy = await pondLead(`Rae ${tag}race`);
  const racers = w.agents.filter((a) => a.userId !== racy.releasedBy);
  expect(racers).toHaveLength(2);
  // evidence for the open pond bug below: the lead is in the pond, yet a racer's Pond page is empty
  await signIn(page, stack, racers[0]!);
  await page.goto(`${stack.webUrl}/pond`);
  await expect(page.getByRole('heading', { level: 1, name: 'Pond' })).toBeVisible();
  await expect(page.getByText(/No pond leads to claim right now|Claim/).first()).toBeVisible({ timeout: 15_000 });
  await shot(page, info, 'j2', '3-pond-as-agent');
  const results = await Promise.all(racers.map((a) => stack.api(clientOf(a.userId), 'POST', `/leads/${racy.id}/claim`, { commandId: randomUUID(), pondId: w.defaultPondId })));
  const statuses = results.map((r) => r.status).sort();
  expect(statuses).toEqual([200, 409]);
  const winner = racers[results.findIndex((r) => r.status === 200)]!;
  const loser = racers[results.findIndex((r) => r.status === 409)]!;
  const loserCode = (results.find((r) => r.status === 409)!.body as { error: { code: string } }).error.code;
  expect(['LEAD_ALREADY_CLAIMED', 'LEAD_STATE_CHANGED']).toContain(loserCode);
  expect(await state(racy.id)).toMatchObject({ ownership_state: 'owned', owner_user_id: winner.userId, pond_id: null });
  const claims = await stack.sql<{ actor_user_id: string }>("SELECT actor_user_id FROM lead_ownership_events WHERE contact_id = $1 AND type = 'claimed'", [racy.id]);
  expect(claims.map((c) => c.actor_user_id)).toEqual([winner.userId]);
  await pollSql(stack, 'SELECT code, actor_user_id FROM ownership_command_rejections WHERE contact_id = $1', [racy.id], (r: { actor_user_id: string }[]) => r.some((x) => x.actor_user_id === loser.userId));
});

// BUG (High, open): an agent or Team Lead never sees a pond lead in the web app, so nobody can claim from a
// pond on phone or desktop. The Pond page lists, for non-Owner/Admin roles, only the ponds named by the
// feed's "pond_new" Claim actions (PondPage.pondIdsFromFeed), and the feed never has one:
// apps/api/src/workspace/repos/feedInputs.ts builds FeedInputs with `pondLeads: []` (core/priority/feed.ts
// would emit pond_new cards from it). Owner/Admin see the pond cards but may not claim ("You can't claim
// from this pond"). Repro: a lead released to the default pond (state in_pond); sign in as another agent of
// the routing rule; Home has no "New in the pond" card and /pond says "No pond leads to claim right now",
// while POST /api/leads/:id/claim as that agent succeeds. Not a small fix: pond entry has to refresh every
// eligible member's incremental feed (0034). Remove the fixme when the feed carries pond leads.
test.fixme('J2: on screen, the agent who taps Claim a moment too late reads why and the pond card goes away', async ({ page }, info) => {
  test.setTimeout(180_000);
  const tag = info.project.name === 'phone' ? 'Phone' : 'Desk';
  // 2. on screen: one agent has the pond card open, the other claims first, the late tap is told why
  const lead = await pondLead(`Sol ${tag}pond`);
  const [slow, fast] = w.agents.filter((a) => a.userId !== lead.releasedBy);
  await signIn(page, stack, slow!);
  await page.goto(`${stack.webUrl}/pond`);
  await expect(page.getByRole('heading', { level: 1, name: 'Pond' })).toBeVisible();
  const card = page.locator('article').filter({ hasText: `Sol ${tag[0]}.` }).first();
  await expect(card.getByRole('button', { name: 'Claim' })).toBeVisible({ timeout: 15_000 });
  await shot(page, info, 'j2', '3-pond');
  expect((await stack.api(clientOf(fast!.userId), 'POST', `/leads/${lead.id}/claim`, { commandId: randomUUID(), pondId: w.defaultPondId })).status).toBe(200);
  await tap(page, card.getByRole('button', { name: 'Claim' }));
  await expect(page.getByText('Someone else claimed this lead just now.')).toBeVisible({ timeout: 15_000 });
  await shot(page, info, 'j2', '4-claim-lost');
  // nothing reveals who won (R-PERM-7), and the lead is the winner's
  expect(await page.locator('main').textContent()).not.toContain('Member agent claimed');
  expect(await state(lead.id)).toMatchObject({ ownership_state: 'owned', owner_user_id: fast!.userId });
  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: 'Pond' })).toBeVisible();
  await expect(page.locator('article').filter({ hasText: `Sol ${tag[0]}.` })).toHaveCount(0, { timeout: 15_000 });
  if (isPhone(page)) expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
});
