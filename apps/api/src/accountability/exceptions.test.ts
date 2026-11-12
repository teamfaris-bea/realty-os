// The exception queue derivation over real Postgres (BUILD_PLAN module 15; R-ACC-1, R-ACC-2, R-OWN-13,
// R-IMPORT-6, R-AST-15, E68). Recomputes run as the system actor (what the job does); the queue is read
// through the real server as each role, under RLS.
import { randomUUID } from 'node:crypto';
import { EXCEPTION_RULE_VERSION } from '@realty/core/priority';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { grantConsent } from '../comms/testing.js';
import {
  type AccWorld,
  accWorld,
  accWorker,
  acceptedLead,
  act,
  asUser,
  call,
  command,
  contactState,
  daytimeContact,
  endedAppointment,
  enqueueTenantScan,
  humanTouch,
  intake,
  type ItemT,
  itemRow,
  leadsWorker,
  ledger,
  promiseTask,
  queue,
  recompute,
  sendText,
  setPeriodDeadlines,
  sleep,
  suFixture,
} from './testing.js';

let h: ApiHarness;
let w: AccWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await accWorld(h);
});
afterAll(async () => {
  await h?.close();
});

const untouched = (contactId: string, seq: number) => `untouched:${contactId}:${seq}`;
const keysOf = (items: { dedupeKey: string }[]) => items.map((i) => i.dedupeKey);

/** A lead whose first-touch deadline passed with no human touch, recomputed for its contact. */
async function missedLead() {
  const lead = await acceptedLead(h, w);
  await setPeriodDeadlines(h, lead.contactId, -60_000, 86_400_000);
  await recompute(h, w.tenantId, { contactId: lead.contactId });
  return { ...lead, key: untouched(lead.contactId, lead.periodSeq) };
}

const explanations = (evidence: unknown) => (evidence as { explanation: string }[]).map((e) => e.explanation);
const phoneOf = async (contactId: string) =>
  (await h.su.query(`SELECT address FROM contact_points WHERE contact_id = $1 AND kind = 'phone' LIMIT 1`, [contactId])).rows[0].address as string;
const lastFirstTouchAt = async (contactId: string) =>
  (await h.su.query(`SELECT occurred_at FROM lead_ownership_events WHERE contact_id = $1 AND type = 'first_touch_recorded' ORDER BY seq DESC LIMIT 1`, [contactId])).rows[0].occurred_at as Date;

/**
 * E68: a missed lead the Team Lead verified, then more than 7 days of quiet (clock fixture), then an intake
 * re-inquiry that starts a new SLA period of the same agent (R-OWN-20). Returns the newer period's item key.
 */
async function reinquiryAfterVerifiedMiss() {
  const lead = await missedLead();
  expect((await act(w.teamLead!, lead.key, 'verify', { note: 'Talked with them about it' })).status).toBe(200);
  // the lead went quiet for more than 7 days (clock fixture), then inquires again
  await suFixture(h, [{ text: `UPDATE contacts SET owned_at = now() - interval '8 days', last_human_touch_at = now() - interval '8 days' WHERE id = $1`, values: [lead.contactId] }]);
  const again = await intake(h, w, { phones: [await phoneOf(lead.contactId)], fullName: 'Pat Lead', inquiryType: 'sell', message: 'Thinking of selling now too' });
  expect([again.contactId, again.outcome]).toEqual([lead.contactId, 'reinquiry']);
  const st = await contactState(h, lead.contactId);
  expect([st.ownership_state, st.owner_user_id]).toEqual(['owned', lead.owner.userId]);
  expect((await ledger(h, lead.contactId)).at(-1)).toMatchObject({ type: 'reinquiry', reason_code: 'REINQUIRY_SLA' });
  const secondSeq = Number(st.ownership_period_seq);
  expect(secondSeq).toBeGreaterThan(lead.periodSeq);
  return { lead, second: untouched(lead.contactId, secondSeq) };
}

describe('untouched_lead', () => {
  it('R-ACC-2 R-OWN-13: an untouched_lead item appears at the first-touch deadline, owned by the agent of that period, with evidence; nothing before it', async () => {
    const lead = await acceptedLead(h, w);
    const key = untouched(lead.contactId, lead.periodSeq);
    await recompute(h, w.tenantId, { contactId: lead.contactId });
    expect(await itemRow(h, key)).toBeNull();

    await setPeriodDeadlines(h, lead.contactId, -60_000, 86_400_000);
    await recompute(h, w.tenantId, { contactId: lead.contactId });
    const row = await itemRow(h, key);
    expect(row).not.toBeNull();
    expect(row!.owner_user_id).toBe(lead.owner.userId);
    expect(row!.condition_cleared_at).toBeNull();
    // detected at the deadline itself, not at the recompute instant
    const st = await contactState(h, lead.contactId);
    expect(row!.detected_at.getTime()).toBe(st.first_touch_due_at!.getTime());

    const mine = (await queue(lead.owner)).items.find((i) => i.dedupeKey === key)!;
    expect(mine).toMatchObject({ itemType: 'untouched_lead', live: true, owner: { userId: lead.owner.userId }, contact: { id: lead.contactId, name: 'Pat Lead' } });
    expect(mine.evidence.length).toBeGreaterThanOrEqual(1);
    expect(mine.evidence[0]).toMatchObject({ sourceType: 'ownership_period', explanation: 'No human call, text or email by the first-contact deadline', link: { kind: 'contact', id: lead.contactId } });
    expect(mine.ageSeconds).toBeGreaterThanOrEqual(59);
    expect(mine.actions).toEqual({ resolve: true, reassign: false, verify: false, reopen: false });

    // the Team Lead of the agent's team and the Owner see it; the other agent and an outsider do not
    const tl = (await queue(w.teamLead!)).items.find((i) => i.dedupeKey === key)!;
    expect(tl.actions).toEqual({ resolve: true, reassign: true, verify: true, reopen: false });
    expect(keysOf((await queue(w.owner)).items)).toContain(key);
    const other = w.agents.find((a) => a.userId !== lead.owner.userId)!;
    expect(keysOf((await queue(other)).items)).not.toContain(key);
    expect(keysOf((await queue(w.outsider)).items)).not.toContain(key);
    expect((await call(other, 'GET', `/team/exceptions/${encodeURIComponent(key)}`)).code).toBe('NOT_FOUND');
  });

  it('R-ACC-1: recompute is idempotent (a second run writes nothing) and keys are per occurrence', async () => {
    const lead = await missedLead();
    const before = await itemRow(h, lead.key);
    const again = await recompute(h, w.tenantId, { contactId: lead.contactId });
    expect([again.upserted, again.cleared]).toEqual([0, 0]);
    expect((await itemRow(h, lead.key))!.computed_at.getTime()).toBe(before!.computed_at.getTime());
    const tenant1 = await recompute(h, w.tenantId);
    const tenant2 = await recompute(h, w.tenantId);
    expect(tenant1.inputs.periods).toBeGreaterThan(0);
    expect([tenant2.upserted, tenant2.cleared]).toEqual([0, 0]);
    const n = await h.su.query('SELECT count(*)::int AS n FROM exception_items WHERE dedupe_key = $1', [lead.key]);
    expect(n.rows[0].n).toBe(1);
  });

  it('R-ACC-1 R-ACC-2: fixed late — a human touch after the deadline sets condition_cleared_at; the item stays in the live queue until a person resolves it', async () => {
    const lead = await missedLead();
    await humanTouch(h, lead.owner, lead.contactId);
    const r = await recompute(h, w.tenantId, { contactId: lead.contactId });
    expect(r.upserted).toBe(1);
    const item = (await queue(lead.owner)).items.find((i) => i.dedupeKey === lead.key)!;
    expect(item.live).toBe(true);
    expect(item.conditionClearedAt).not.toBeNull();
    expect(item.evidence.map((e) => e.explanation)).toEqual([
      'First human call, text or email came after the first-contact deadline',
      'Lead became theirs',
      'First human contact',
    ]);
    expect((await act(lead.owner, lead.key, 'resolve', { note: 'Called her at 9:05, she is fine' })).status).toBe(200);
    expect(keysOf((await queue(lead.owner)).items)).not.toContain(lead.key);
    expect(keysOf((await queue(lead.owner, '?state=handled')).items)).toContain(lead.key);
  });

  it('R-ACC-2: a breach followed by auto-release stays in the queue (derived from the ledger); its agent still sees it, with only the pond card of the contact', async () => {
    const lead = await acceptedLead(h, w);
    const key = untouched(lead.contactId, lead.periodSeq);
    await setPeriodDeadlines(h, lead.contactId, -2_000, -1_000);
    await leadsWorker(h).drain();
    expect((await ledger(h, lead.contactId)).at(-1)).toMatchObject({ type: 'auto_released', reason_code: 'FIRST_TOUCH_MISSED' });
    await recompute(h, w.tenantId);
    const row = await itemRow(h, key);
    expect([row?.owner_user_id, row?.condition_cleared_at]).toEqual([lead.owner.userId, null]);
    const item = (await queue(lead.owner)).items.find((i) => i.dedupeKey === key)!;
    expect(item.live).toBe(true);
    expect(item.evidence[0]!.explanation).toBe('No human call, text or email by the first-contact deadline; the lead later left this agent');
    // R-PERM-6/7: the previous owner sees the pond card (masked last name), never the detail
    expect(item.contact).toEqual({ id: lead.contactId, name: 'Pat L.' });
    expect(keysOf((await queue(w.teamLead!)).items)).toContain(key);
    // a later recompute does not erase it (the period is in the ledger, not the projection)
    await recompute(h, w.tenantId);
    expect((await itemRow(h, key))!.condition_cleared_at).toBeNull();
  });

  it('E68 R-ACC-1: a lead that re-inquires and is missed again by the same agent after an earlier VERIFIED miss is a new item (the re-inquiry SLA is a new ownership period)', async () => {
    const { lead, second } = await reinquiryAfterVerifiedMiss();
    await setPeriodDeadlines(h, lead.contactId, -60_000, 86_400_000);
    await recompute(h, w.tenantId);
    const live = (await queue(w.teamLead!)).items;
    expect(keysOf(live)).toContain(second);
    expect(keysOf(live)).not.toContain(lead.key);
    expect(live.find((i) => i.dedupeKey === second)!.owner?.userId).toBe(lead.owner.userId);
    const handled = (await queue(w.teamLead!, '?state=handled')).items.find((i) => i.dedupeKey === lead.key)!;
    expect(handled.latestEvent).toMatchObject({ action: 'verified', actor: { userId: w.teamLead!.userId } });
    // R-PAR-32: the earlier card is the same agent's earlier period. The lead never left them (a new period started
    // when it inquired again), so the card must not say it moved on.
    expect(handled.period).toEqual({ current: false, movedOn: false });
    expect(live.find((i) => i.dedupeKey === second)!.period).toEqual({ current: true, movedOn: false });
    // a call they log in the new period is context of the new period's card only, never of the earlier one
    const loggedNow = await call<{ note: { id: string } }>(lead.owner, 'POST', `/contacts/${lead.contactId}/activities`, { kind: 'call', direction: 'outbound', at: new Date().toISOString(), outcome: 'connected' });
    expect(loggedNow.status, JSON.stringify(loggedNow.body)).toBe(201);
    const notes = (i: ItemT | undefined) => i!.evidence.filter((e) => e.sourceType === 'note').map((e) => e.sourceId);
    expect(notes((await queue(w.teamLead!, '?state=handled')).items.find((i) => i.dedupeKey === lead.key))).toEqual([]);
    expect(notes((await queue(w.teamLead!)).items.find((i) => i.dedupeKey === second))).toEqual([loggedNow.body.note.id]);

    // R-ACC-2 (owner decision 2026-11-11): the re-inquiry ended the earlier period. The agent's touch now is the
    // newer period's late first touch; it never marks the earlier miss fixed late.
    await humanTouch(h, lead.owner, lead.contactId);
    await recompute(h, w.tenantId, { contactId: lead.contactId });
    const earlier = (await itemRow(h, lead.key))!;
    expect(earlier.condition_cleared_at).toBeNull();
    expect(explanations(earlier.evidence)).toEqual(['No human call, text or email by the first-contact deadline', 'Lead became theirs']);
    const touchAt = await lastFirstTouchAt(lead.contactId);
    const newer = (await itemRow(h, second))!;
    expect(newer.condition_cleared_at?.getTime()).toBe(touchAt.getTime());
    expect(explanations(newer.evidence)).toEqual(['First human call, text or email came after the first-contact deadline', 'Lead became theirs', 'First human contact']);
    const tl = (await queue(w.teamLead!)).items;
    expect(tl.find((i) => i.dedupeKey === second)).toMatchObject({ live: true, conditionClearedAt: touchAt.toISOString() });
    expect(keysOf(tl)).not.toContain(lead.key);
  });

  it('R-ACC-1 rule version 3: an item the earlier rule stored as fixed late by a touch in a later re-inquiry period reopens its condition on the next recompute; its human events stand', async () => {
    const { lead } = await reinquiryAfterVerifiedMiss();
    await humanTouch(h, lead.owner, lead.contactId);
    const touchAt = await lastFirstTouchAt(lead.contactId);
    // what rule version 2 stored: the touch in the re-inquiry period taken as the earlier period's late first touch
    await suFixture(h, [{
      text: `UPDATE exception_items
                SET rule_version = 2, condition_cleared_at = $2,
                    evidence = jsonb_set(evidence, '{0,explanation}', '"First human call, text or email came after the first-contact deadline"')
                               || jsonb_build_array(jsonb_build_object('sourceType', 'ownership_period', 'sourceId', contact_id, 'explanation', 'First human contact', 'at', $3::bigint))
              WHERE dedupe_key = $1`,
      values: [lead.key, touchAt, touchAt.getTime()],
    }]);
    expect((await itemRow(h, lead.key))!.evidence).toHaveLength(3);
    await recompute(h, w.tenantId, { contactId: lead.contactId });
    const row = (await h.su.query('SELECT condition_cleared_at, rule_version, evidence FROM exception_items WHERE dedupe_key = $1', [lead.key])).rows[0];
    expect([row.condition_cleared_at, row.rule_version]).toEqual([null, EXCEPTION_RULE_VERSION]);
    expect(row.rule_version).toBeGreaterThanOrEqual(3);
    expect(explanations(row.evidence)).toEqual(['No human call, text or email by the first-contact deadline', 'Lead became theirs']);
    // the condition reopened, the Team Lead's verification still stands: handled, not back in the live queue
    expect(keysOf((await queue(w.teamLead!)).items)).not.toContain(lead.key);
    expect((await queue(w.teamLead!, '?state=handled')).items.find((i) => i.dedupeKey === lead.key)?.latestEvent).toMatchObject({ action: 'verified' });
  });

  it('R-ACC-2 R-OWN-20: a period a re-inquiry superseded before its deadline is no item (its breach timer was fenced out); the touch after it is the newer period\'s, in time', async () => {
    const lead = await acceptedLead(h, w);
    const earlierKey = untouched(lead.contactId, lead.periodSeq);
    // never touched, quiet for more than 7 days (clock fixture), and inquires again before its first-touch deadline
    await suFixture(h, [{ text: `UPDATE contacts SET owned_at = now() - interval '8 days' WHERE id = $1`, values: [lead.contactId] }]);
    const again = await intake(h, w, { phones: [await phoneOf(lead.contactId)], fullName: 'Pat Lead', inquiryType: 'sell' });
    expect(again.outcome).toBe('reinquiry');
    const newerSeq = Number((await contactState(h, lead.contactId)).ownership_period_seq);
    expect(newerSeq).toBeGreaterThan(lead.periodSeq);
    // a long first-touch SLA: the earlier deadline fell just after the re-inquiry, and it has passed by now
    await suFixture(h, [{
      text: `UPDATE lead_ownership_events e SET deadline_at = n.occurred_at + interval '1 millisecond'
               FROM lead_ownership_events n WHERE e.contact_id = $1 AND e.seq = $2 AND n.contact_id = e.contact_id AND n.seq = $3`,
      values: [lead.contactId, lead.periodSeq, newerSeq],
    }]);
    await sleep(5);
    await recompute(h, w.tenantId, { contactId: lead.contactId });
    expect(await itemRow(h, earlierKey)).toBeNull();
    await humanTouch(h, lead.owner, lead.contactId);
    await recompute(h, w.tenantId, { contactId: lead.contactId });
    expect(await itemRow(h, earlierKey)).toBeNull();
    expect(await itemRow(h, untouched(lead.contactId, newerSeq))).toBeNull();
  });
});

// Batch 6 review ownership-sla/F5 and F2. A merge that hands the survivor to the loser's owner writes only merged_in on
// it (owner B, a new period with no deadline), and a deactivation re-route goes from owned straight to offered. Neither
// was on the list of events that end a first-touch window, so B's later first touch became A's period's (A's miss "fixed
// late" by B), and a period that left A before its deadline was still A's miss. And an item an earlier rule stored for a
// period the current rules make no item (rule 3: a period a re-inquiry superseded before its deadline) was cleared like
// a late fix, so the Team Lead's card said "Fixed late" of a period nobody missed, in the live queue.
describe('a first-touch window ends however the lead leaves its owner (R-ACC-2, review F5); stored items the rules make no item are withdrawn (F2, F5)', () => {
  /** Two accepted leads with different owners. */
  async function twoOwners() {
    const a = await acceptedLead(h, w);
    const b = await acceptedLead(h, w);
    let bOwner = b.owner;
    if (bOwner.userId === a.owner.userId) {
      bOwner = [...w.agents, w.teamLead!].find((x) => x.userId !== a.owner.userId)!;
      expect((await command(w.owner, b.contactId, 'reassign', { toUserId: bOwner.userId, reason: 'MANUAL' })).status).toBe(200);
    }
    return { a, b, bOwner };
  }
  /** The Owner merges `loser` into `survivor`, giving the survivor to `ownerChoice` (R-OWN-24, different owners). */
  async function merge(survivorId: string, loserId: string, ownerChoice: string) {
    const r = await command(w.owner, survivorId, 'merge', { loserId, ownerChoice });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect((await ledger(h, survivorId)).at(-1)).toMatchObject({ type: 'merged_in', owner_user_id: ownerChoice });
  }
  /** What an earlier rule stored for a period: an untouched_lead row as of rule `version`, open or "fixed late". */
  async function storedAsBefore(contactId: string, seq: number, o: { version: number; clearedAt?: Date | null; lateTouchAt?: Date }) {
    const p = (await h.su.query(`SELECT tenant_id, owner_user_id, occurred_at, deadline_at FROM lead_ownership_events WHERE contact_id = $1 AND seq = $2`, [contactId, seq])).rows[0];
    const ev = [
      { sourceType: 'ownership_period', sourceId: contactId, explanation: o.lateTouchAt ? 'First human call, text or email came after the first-contact deadline' : 'No human call, text or email by the first-contact deadline', at: p.deadline_at.getTime() },
      { sourceType: 'ownership_period', sourceId: contactId, explanation: 'Lead became theirs', at: p.occurred_at.getTime() },
      ...(o.lateTouchAt ? [{ sourceType: 'ownership_period', sourceId: contactId, explanation: 'First human contact', at: o.lateTouchAt.getTime() }] : []),
    ];
    await h.su.query(
      `INSERT INTO exception_items (tenant_id, id, item_type, subject_type, subject_id, contact_id, owner_user_id, detected_at, due_at, evidence,
                                    condition_cleared_at, rule_version, dedupe_key, computed_at)
       VALUES ($1, gen_random_uuid(), 'untouched_lead', 'contact', $2, $2, $3, $4, $4, $5::jsonb, $6, $7, $8, now())`,
      [p.tenant_id, contactId, p.owner_user_id, p.deadline_at, JSON.stringify(ev), o.clearedAt ?? null, o.version, untouched(contactId, seq)],
    );
  }
  const withdrawnRow = async (key: string) => (await h.su.query('SELECT withdrawn_at, condition_cleared_at, rule_version, evidence FROM exception_items WHERE dedupe_key = $1', [key])).rows[0];

  it('R-ACC-2 R-OWN-24 E68: an owner-changing merge after the deadline ends the earlier owner\'s window: the new owner\'s first touch is never their late fix', async () => {
    const { a, b, bOwner } = await twoOwners();
    const key = untouched(a.contactId, a.periodSeq);
    await setPeriodDeadlines(h, a.contactId, -60_000, 86_400_000);
    await recompute(h, w.tenantId, { contactId: a.contactId });
    expect((await itemRow(h, key))?.condition_cleared_at).toBeNull();
    await merge(a.contactId, b.contactId, bOwner.userId as string);
    // the new owner answers: their period's touch, never A's late fix
    await humanTouch(h, bOwner, a.contactId);
    expect((await ledger(h, a.contactId)).at(-1)).toMatchObject({ type: 'first_touch_recorded', owner_user_id: bOwner.userId });
    await recompute(h, w.tenantId, { contactId: a.contactId });
    const row = (await itemRow(h, key))!;
    expect(row.condition_cleared_at).toBeNull();
    expect(explanations(row.evidence)).toEqual(['No human call, text or email by the first-contact deadline; the lead later left this agent', 'Lead became theirs']);
    const tl = (await queue(w.teamLead!)).items.find((i) => i.dedupeKey === key)!;
    expect(tl).toMatchObject({ live: true, conditionClearedAt: null, owner: { userId: a.owner.userId }, period: { current: false, movedOn: true } });
  });

  it('R-ACC-2 R-OWN-24: a period whose lead a merge handed to another owner before its deadline is no item; one an earlier rule stored is withdrawn, never "fixed late" (review F5)', async () => {
    const { a, b, bOwner } = await twoOwners();
    const key = untouched(a.contactId, a.periodSeq);
    await merge(a.contactId, b.contactId, bOwner.userId as string);
    const mergedSeq = Number((await contactState(h, a.contactId)).ownership_seq);
    // a long first-touch SLA: A's deadline fell just after the merge, and it has passed by now
    await suFixture(h, [{
      text: `UPDATE lead_ownership_events e SET deadline_at = n.occurred_at + interval '1 millisecond'
               FROM lead_ownership_events n WHERE e.contact_id = $1 AND e.seq = $2 AND n.contact_id = e.contact_id AND n.seq = $3`,
      values: [a.contactId, a.periodSeq, mergedSeq],
    }]);
    await sleep(5);
    await recompute(h, w.tenantId, { contactId: a.contactId });
    expect(await itemRow(h, key)).toBeNull();
    // what the earlier rule stored for it: A's open miss; then B's touch, which that rule took for A's late fix
    await storedAsBefore(a.contactId, a.periodSeq, { version: 3 });
    await humanTouch(h, bOwner, a.contactId);
    await recompute(h, w.tenantId, { contactId: a.contactId });
    const row = await withdrawnRow(key);
    expect(row.withdrawn_at).not.toBeNull();
    expect([row.condition_cleared_at, row.rule_version]).toEqual([null, EXCEPTION_RULE_VERSION]);
    expect(explanations(row.evidence)).toEqual(['Not a miss: the lead left this agent before the first-contact deadline', 'Lead became theirs', 'Lead left this agent']);
    // never in the live queue (so never "fixed late"), counted nowhere; the full list says it was withdrawn, offering nothing
    expect(keysOf((await queue(w.teamLead!)).items)).not.toContain(key);
    const all = (await queue(w.owner, '?state=all')).items.find((i) => i.dedupeKey === key)!;
    expect(all).toMatchObject({ live: false, withdrawn: true, actions: { resolve: false, reassign: false, verify: false, reopen: false } });
    for (const verb of ['resolve', 'verify'] as const) {
      const r = await act(w.owner, key, verb, { note: 'Called them' });
      expect([verb, r.status, r.code]).toEqual([verb, 409, 'EXCEPTION_STATE_CONFLICT']);
    }
    // a later recompute writes nothing
    const again = await recompute(h, w.tenantId, { contactId: a.contactId });
    expect([again.upserted, again.cleared]).toEqual([0, 0]);
  });

  it('R-ACC-2 R-OWN-22: a deactivation re-route (owned straight to offered) ends the window: a period it took from its owner before the deadline is no item', async () => {
    const lead = await acceptedLead(h, w);
    const key = untouched(lead.contactId, lead.periodSeq);
    const next = [...w.agents, w.teamLead!].find((x) => x.userId !== lead.owner.userId)!;
    // the ledger as R-OWN-22 stage 3 writes it for destination `reroute` (route(b) offers from owned), then the accept
    await appendEvents(lead.contactId, [
      { type: 'offered', from: 'owned', to: 'offered', owner: null, offeredTo: next.userId as string },
      { type: 'offer_accepted', from: 'offered', to: 'owned', owner: next.userId as string },
    ]);
    const offered = (await h.su.query<{ occurred_at: Date }>(`SELECT occurred_at FROM lead_ownership_events WHERE contact_id = $1 AND type = 'offered' AND seq > $2 ORDER BY seq LIMIT 1`, [lead.contactId, lead.periodSeq])).rows[0]!;
    await suFixture(h, [{ text: `UPDATE lead_ownership_events SET deadline_at = $3::timestamptz + interval '1 millisecond' WHERE contact_id = $1 AND seq = $2`, values: [lead.contactId, lead.periodSeq, offered.occurred_at] }]);
    await sleep(5);
    await recompute(h, w.tenantId, { contactId: lead.contactId });
    expect(await itemRow(h, key)).toBeNull();
  });

  it('R-ACC-1 R-OWN-20 E68: rule-2 items of a period a re-inquiry superseded before its deadline (open, or "fixed late" by the later period\'s touch) are withdrawn on the next recompute, never shown as fixed late (review F2)', async () => {
    const lead = await acceptedLead(h, w);
    const earlierKey = untouched(lead.contactId, lead.periodSeq);
    await suFixture(h, [{ text: `UPDATE contacts SET owned_at = now() - interval '8 days' WHERE id = $1`, values: [lead.contactId] }]);
    expect((await intake(h, w, { phones: [await phoneOf(lead.contactId)], fullName: 'Pat Lead', inquiryType: 'value' })).outcome).toBe('reinquiry');
    const newerSeq = Number((await contactState(h, lead.contactId)).ownership_period_seq);
    expect(newerSeq).toBeGreaterThan(lead.periodSeq);
    await suFixture(h, [{
      text: `UPDATE lead_ownership_events e SET deadline_at = n.occurred_at + interval '1 millisecond'
               FROM lead_ownership_events n WHERE e.contact_id = $1 AND e.seq = $2 AND n.contact_id = e.contact_id AND n.seq = $3`,
      values: [lead.contactId, lead.periodSeq, newerSeq],
    }]);
    await sleep(5);
    // what rule 2 stored for the earlier period: an open miss
    await storedAsBefore(lead.contactId, lead.periodSeq, { version: 2 });
    expect(keysOf((await queue(w.teamLead!)).items)).toContain(earlierKey);
    await recompute(h, w.tenantId, { contactId: lead.contactId });
    // never "fixed late" in the live queue (before the fix: cleared, so live with a clear instant)
    expect(keysOf((await queue(w.teamLead!)).items)).not.toContain(earlierKey);
    let row = await withdrawnRow(earlierKey);
    expect(row.withdrawn_at).not.toBeNull();
    expect([row.condition_cleared_at, row.rule_version]).toEqual([null, EXCEPTION_RULE_VERSION]);
    expect(explanations(row.evidence)).toEqual(["Not a miss: a re-inquiry started this agent's next period before this one was due", 'Lead became theirs', 'Re-inquiry started their next period']);
    // and the one rule 2 had marked "fixed late" by the newer period's touch: withdrawn too, its clear instant kept
    await h.su.query('DELETE FROM exception_items WHERE dedupe_key = $1', [earlierKey]);
    await humanTouch(h, lead.owner, lead.contactId);
    const touchAt = await lastFirstTouchAt(lead.contactId);
    await storedAsBefore(lead.contactId, lead.periodSeq, { version: 2, clearedAt: touchAt, lateTouchAt: touchAt });
    expect((await queue(w.teamLead!)).items.find((i) => i.dedupeKey === earlierKey)).toMatchObject({ live: true, conditionClearedAt: touchAt.toISOString() });
    await recompute(h, w.tenantId, { contactId: lead.contactId });
    row = await withdrawnRow(earlierKey);
    expect(row.withdrawn_at).not.toBeNull();
    expect(row.condition_cleared_at?.getTime()).toBe(touchAt.getTime());
    expect(keysOf((await queue(w.teamLead!)).items)).not.toContain(earlierKey);
    // a tenant scan agrees and writes nothing more
    expect((await recompute(h, w.tenantId)).upserted).toBe(0);
  });
});

/**
 * Appends ledger rows at the contact's head, as the engine writes them, through the ledger guard (one command id per
 * transaction; the superuser pool, a fixture for a path these tests do not drive: R-OWN-22 stage 3's re-route).
 */
async function appendEvents(contactId: string, events: { type: string; from: string; to: string; owner: string | null; offeredTo?: string }[]): Promise<void> {
  const c = await h.su.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.ownership_command', gen_random_uuid()::text, true)`);
    for (const e of events) {
      await c.query(
        `INSERT INTO lead_ownership_events (tenant_id, contact_id, seq, event_id, type, from_state, to_state, owner_user_id, offered_to_user_id, offer_id,
                                            deadline_at, actor_kind, reason_code, command_id, occurred_at, payload)
         SELECT c.tenant_id, c.id, (SELECT max(seq) + 1 FROM lead_ownership_events WHERE contact_id = c.id), gen_random_uuid(), $2, $3, $4, $5, $6,
                CASE WHEN $2 = 'offered' THEN gen_random_uuid() END, NULL, 'system', 'TEST_REROUTE', current_setting('app.ownership_command')::uuid,
                date_trunc('milliseconds', clock_timestamp()), '{}'::jsonb
           FROM contacts c WHERE c.id = $1`,
        [contactId, e.type, e.from, e.to, e.owner, e.offeredTo ?? null],
      );
    }
    await c.query('COMMIT');
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    c.release();
  }
}

describe('overdue_promise, missing_outcome, failed_send', () => {
  it('R-ACC-2: an open promise task past due is an item with the promise evidence; the quote is added at read time for the viewer and never stored; done late keeps it live', async () => {
    const lead = await acceptedLead(h, w);
    const p = await promiseTask(h, w.tenantId, lead.contactId, lead.owner.userId!, { dueInMs: -60_000 });
    // the same promise was also said on a call: a transcript quote (encrypted at rest) at 2:14
    const callId = randomUUID();
    await h.su.query(
      `INSERT INTO evidence_refs (tenant_id, id, claim_id, source_type, source_id, locator, snippet_enc, verbatim_verified)
       VALUES ($1, gen_random_uuid(), $2, 'call', $3, '{"kind":"transcript_offset","startMs":134000,"endMs":138000}', '\\x00'::bytea, true)`,
      [w.tenantId, p.claimId, callId],
    );
    await recompute(h, w.tenantId, { contactId: lead.contactId });
    const key = `promise:${p.taskId}`;
    const stored = await itemRow(h, key);
    expect(stored).not.toBeNull();
    expect(JSON.stringify(stored!.evidence)).not.toContain('comps by Friday');
    const item = (await queue(lead.owner, '?type=overdue_promise')).items.find((i) => i.dedupeKey === key)!;
    expect(item.owner?.userId).toBe(lead.owner.userId);
    expect(item.evidence[0]).toMatchObject({ sourceType: 'task', sourceId: p.taskId, explanation: 'Promised follow-up is past due and still open', link: { kind: 'task', id: p.taskId } });
    const quote = item.evidence.find((e) => e.snippet !== null)!;
    expect(quote).toMatchObject({ sourceType: 'message', sourceId: p.messageId, snippet: 'I will send you the comps by Friday', needsReview: false, link: { kind: 'message', id: p.messageId, contactId: lead.contactId } });
    // "jump to the moment": the call evidence links to the call at its offset; the quote itself is withheld
    // from a viewer who may not read that call's transcript (no recording they may play: R-PERM-8)
    expect(item.evidence.find((e) => e.sourceType === 'call')).toMatchObject({
      sourceId: callId,
      snippet: null,
      explanation: 'Quoted from the call (open the call to hear it)',
      locator: { kind: 'transcript_offset', startMs: 134000, endMs: 138000 },
      link: { kind: 'call', id: callId, contactId: lead.contactId, offsetMs: 134000 },
    });

    const done = await call(lead.owner, 'PATCH', `/tasks/${p.taskId}`, { status: 'done' });
    expect(done.status).toBe(200);
    await recompute(h, w.tenantId, { contactId: lead.contactId });
    const after = (await queue(lead.owner)).items.find((i) => i.dedupeKey === key)!;
    expect([after.live, after.conditionClearedAt !== null]).toEqual([true, true]);
    expect(after.evidence[0]!.explanation).toBe('Promised follow-up was done after it was due');
  });

  it('R-ACC-2: an appointment that ended more than 2 h ago with no outcome is a missing_outcome item; an outcome logged late clears its condition', async () => {
    const lead = await acceptedLead(h, w);
    const id = await endedAppointment(h, lead.owner, lead.contactId, 2 * 3_600_000 + 60_000);
    const fresh = await endedAppointment(h, lead.owner, lead.contactId, 3_600_000);
    await recompute(h, w.tenantId, { contactId: lead.contactId });
    expect(await itemRow(h, `appt:${fresh}`)).toBeNull();
    const item = (await queue(lead.owner)).items.find((i) => i.dedupeKey === `appt:${id}`)!;
    expect(item).toMatchObject({ itemType: 'missing_outcome', live: true, conditionClearedAt: null });
    expect(item.evidence[0]).toMatchObject({ sourceType: 'appointment', explanation: 'Buyer consult ended; no outcome logged', link: { kind: 'appointment', id } });
    expect((await call(lead.owner, 'POST', `/appointments/${id}/outcome`, { result: 'follow_up' })).status).toBe(200);
    await recompute(h, w.tenantId, { contactId: lead.contactId });
    expect((await itemRow(h, `appt:${id}`))!.condition_cleared_at).not.toBeNull();
  });

  it('R-ACC-2: an outbound text the provider rejected is a failed_send item owned by its human sender, linked to the message', async () => {
    const lead = await acceptedLead(h, w);
    await daytimeContact(h, lead.contactId);
    await grantConsent(lead.owner, lead.contactId, 'sms');
    h.providers.telephony.failNext('rejected');
    const r = await sendText(lead.owner, lead.contactId, 'Hi, following up on the house');
    const messageId = r.body.message!.id;
    const status = (await h.su.query('SELECT status FROM messages WHERE id = $1', [messageId])).rows[0].status;
    expect(['failed', 'blocked', 'undelivered']).toContain(status);
    await recompute(h, w.tenantId, { contactId: lead.contactId });
    const item = (await queue(w.teamLead!, '?type=failed_send')).items.find((i) => i.dedupeKey === `send:${messageId}`)!;
    expect(item.owner?.userId).toBe(lead.owner.userId);
    expect(item.evidence[0]).toMatchObject({ sourceType: 'message', sourceId: messageId, link: { kind: 'message', id: messageId, contactId: lead.contactId } });
    expect(item.evidence[0]!.explanation).toMatch(/^Text /);
  });
});

describe('time-only conditions (no write)', () => {
  it('R-ACC-1 R-ACC-2: promise due, appointment end + 2 h, unknown dispatch + 10 min, dispatching + 20 min and the first-touch deadline enter the queue on the 60-second scan with no write to their rows', async () => {
    const LEAD_MS = 1_500;
    const lead = await acceptedLead(h, w);
    await daytimeContact(h, lead.contactId);
    await grantConsent(lead.owner, lead.contactId, 'sms');
    // dispatch_unknown: the provider timed out before it saw the submit
    h.providers.telephony.failNext('timeout');
    const unknown = (await sendText(lead.owner, lead.contactId, 'Lost in transit')).body.message!.id;
    expect((await h.su.query('SELECT status FROM messages WHERE id = $1', [unknown])).rows[0].status).toBe('dispatch_unknown');
    // dispatching: a send stuck after TX1
    const stuck = (await sendText(lead.owner, lead.contactId, 'Stuck after TX1')).body.message!.id;
    await suFixture(h, [
      { text: `UPDATE messages SET updated_at = clock_timestamp() - (600000 - $2::int) * interval '1 millisecond' WHERE id = $1`, values: [unknown, LEAD_MS] },
      { text: `UPDATE messages SET status = 'dispatching', dispatched_at = clock_timestamp() - (1200000 - $2::int) * interval '1 millisecond' WHERE id = $1`, values: [stuck, LEAD_MS] },
    ]);
    const p = await promiseTask(h, w.tenantId, lead.contactId, lead.owner.userId!, { dueInMs: LEAD_MS });
    const appt = await endedAppointment(h, lead.owner, lead.contactId, 2 * 3_600_000 - LEAD_MS);
    const other = await acceptedLead(h, w);
    await setPeriodDeadlines(h, other.contactId, LEAD_MS, 86_400_000);
    const keys = [`send:${unknown}`, `send:${stuck}`, `promise:${p.taskId}`, `appt:${appt}`, untouched(other.contactId, other.periodSeq)];

    // the periodic job (as the maintenance pass enqueues it) runs now: nothing yet, and it reschedules itself 60 s out
    await h.su.query(`DELETE FROM jobs WHERE tenant_id = $1 AND kind = 'exception.recompute'`, [w.tenantId]);
    expect(await enqueueTenantScan(h, w.tenantId)).toBe(true);
    expect(await enqueueTenantScan(h, w.tenantId)).toBe(false); // one live job per tenant
    await accWorker(h).drain(5);
    for (const k of keys) expect(await itemRow(h, k)).toBeNull();
    const job = (await h.su.query(`SELECT status, run_at, now() AS now FROM jobs WHERE tenant_id = $1 AND kind = 'exception.recompute'`, [w.tenantId])).rows;
    expect(job).toHaveLength(1);
    expect(job[0].status).toBe('pending');
    const wait = job[0].run_at.getTime() - Date.now();
    expect(wait).toBeGreaterThan(50_000);
    expect(wait).toBeLessThanOrEqual(60_000);

    // time passes; nobody writes any of these rows. The next scan (its 60 s are fast-forwarded) finds all five.
    await sleep(LEAD_MS + 1_000);
    await h.su.query(`UPDATE jobs SET run_at = now() WHERE tenant_id = $1 AND kind = 'exception.recompute' AND status = 'pending'`, [w.tenantId]);
    await accWorker(h).drain(5);
    for (const k of keys) expect([k, (await itemRow(h, k))?.condition_cleared_at]).toEqual([k, null]);
    const tl = (await queue(w.teamLead!)).items;
    const unknownItem = tl.find((i) => i.dedupeKey === `send:${unknown}`)!;
    expect(unknownItem.evidence[0]!.explanation).toBe('Text send result unknown for over 10 min');
    expect(tl.find((i) => i.dedupeKey === `send:${stuck}`)!.evidence[0]!.explanation).toBe('Text stuck sending for over 20 min');
  });
});

describe('imports, the assistant and concurrency', () => {
  it('R-IMPORT-6 R-AST-15: import-created promise tasks and appointments never raise exceptions, and an assistant message never satisfies the untouched-lead SLA', async () => {
    const lead = await acceptedLead(h, w);
    const p = await promiseTask(h, w.tenantId, lead.contactId, lead.owner.userId!, { dueInMs: -3_600_000, createdByKind: 'import' });
    const apptId = randomUUID();
    await h.su.query(
      `INSERT INTO appointments (tenant_id, id, contact_id, user_id, kind, starts_at, ends_at, status, created_by_kind)
       VALUES ($1, $2, $3, $4, 'consult', now() - interval '5 hours', now() - interval '4 hours', 'scheduled', 'import')`,
      [w.tenantId, apptId, lead.contactId, lead.owner.userId],
    );
    // the assistant wrote to the lead (a 60-second first response, say): not a touch (R-AST-15, R-OWN-14)
    const conv = randomUUID();
    await suFixture(h, [
      {
        text: `INSERT INTO messages (tenant_id, id, conversation_id, contact_id, channel, direction, phone_number_id, from_address, to_address, body, status,
                                     initiator, initiated_by_user_id, purpose, assistant_action_id, gate_decision_id, dispatched_at, occurred_at)
               VALUES ($1, gen_random_uuid(), $2, $3, 'sms', 'outbound', $4, '+14155550100', '+14155550101', 'Thanks for reaching out', 'delivered',
                       'assistant', $5, 'informational', gen_random_uuid(), NULL, now(), now())`,
        values: [w.tenantId, conv, lead.contactId, w.mainNumberId, lead.owner.userId],
      },
    ]);
    await setPeriodDeadlines(h, lead.contactId, -60_000, 86_400_000);
    await recompute(h, w.tenantId, { contactId: lead.contactId });
    await recompute(h, w.tenantId);
    expect(await itemRow(h, `promise:${p.taskId}`)).toBeNull();
    expect(await itemRow(h, `appt:${apptId}`)).toBeNull();
    const item = await itemRow(h, untouched(lead.contactId, lead.periodSeq));
    expect([item !== null, item?.condition_cleared_at]).toEqual([true, null]);
  });

  it('R-ACC-1: concurrent recomputes (tenant scans and a contact-scoped run at once) serialize: no error, one row per key, no lost clear', async () => {
    const lead = await missedLead();
    await humanTouch(h, lead.owner, lead.contactId);
    const runs = await Promise.all([recompute(h, w.tenantId), recompute(h, w.tenantId, { contactId: lead.contactId }), recompute(h, w.tenantId)]);
    expect(runs.reduce((n, r) => n + r.upserted, 0)).toBeGreaterThanOrEqual(1);
    const rows = await h.su.query('SELECT condition_cleared_at FROM exception_items WHERE dedupe_key = $1', [lead.key]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].condition_cleared_at).not.toBeNull();
  });

  it('nobody hand-enters an exception: a member cannot insert or update exception_items (RLS: system / tenant-wide only), and there is no create route', async () => {
    const lead = await missedLead();
    const tl = w.teamLead!;
    const ins = await asUser(h, tl, `INSERT INTO exception_items (tenant_id, id, item_type, subject_type, subject_id, contact_id, owner_user_id, detected_at, evidence, dedupe_key, computed_at)
      VALUES (app.tenant_id(), gen_random_uuid(), 'untouched_lead', 'contact', '${lead.contactId}', '${lead.contactId}', '${lead.owner.userId}', now(), '[{"x":1}]', 'untouched:${lead.contactId}:999', now())`);
    expect(ins).toMatchObject({ ok: false, code: '42501' });
    await asUser(h, tl, `UPDATE exception_items SET condition_cleared_at = now() WHERE dedupe_key = '${lead.key}'`);
    expect((await itemRow(h, lead.key))!.condition_cleared_at).toBeNull();
    expect((await call(tl, 'POST', '/team/exceptions', {})).status).toBe(404);
  });
});
