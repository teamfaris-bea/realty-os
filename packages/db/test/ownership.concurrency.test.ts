// Two-session (and N-session) races through the real command path on PG16 as app_user.
// Overlap is forced, not hoped for: a third session holds app.lock_contact while the racing
// commands queue on it, then releases (BUILD_PLAN module 7 concurrency tests; stable over 100 runs).
import type { ContactId, UserId } from '@realty/core/foundation';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { lockContact } from '../src/locks.js';
import { applyOwnershipCommandInTx } from '../src/ownership/apply.js';
import { selectContactForUpdate } from '../src/ownership/rows.js';
import { withTenantTx } from '../src/tenantTx.js';
import {
  BUY,
  cmd,
  contactRow,
  createHarness,
  createWorld,
  drainFollowups,
  type Harness,
  holdContactLocks,
  intakeLead,
  ledger,
  type Member,
  suFixture,
  suRows,
  uuid,
  waitForWaiters,
  type World,
} from './world.js';

let h: Harness;
beforeAll(async () => {
  h = await createHarness(12);
});
afterAll(async () => {
  await h?.close();
});

async function relaxLimits(w: World): Promise<void> {
  // fixture: high claim / capacity limits so 100 iterations never hit R-OWN-16 limits
  await withTenantTx(w.owner.actor, async (tx) => {
    await sql`UPDATE tenant_settings SET uncontacted_capacity_cap = 50, auto_pause_after_misses = 10 WHERE tenant_id = ${w.tenantId}`.execute(tx);
    await sql`UPDATE ponds SET claims_per_day = 50 WHERE tenant_id = ${w.tenantId}`.execute(tx);
  }, { db: h.app });
}

describe('R-OWN-5 E1: two agents claim the same pond lead', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld(h.app, { agents: 4 });
    await relaxLimits(w);
  });

  it('R-OWN-5 E1: exactly one claim wins, the loser gets LEAD_ALREADY_CLAIMED in the rejection log, and the winner can still release (100 runs)', async () => {
    const outcomes = { a: 0, b: 0 };
    for (let i = 0; i < 100; i++) {
      const [x, y] = [w.agents[i % 4]!, w.agents[(i + 1) % 4]!] as [Member, Member];
      const { contactId } = await intakeLead(h.app, w);
      const lock = await holdContactLocks(h, w.tenantId, [contactId]);
      // the lock queue is FIFO: alternate who queues first so both session orders are exercised
      const first = i % 2 === 0 ? x : y;
      const second = first === x ? y : x;
      const pFirst = cmd(h.app, first.actor, contactId, { kind: 'claim', pondId: w.pondId });
      await waitForWaiters(h.su, lock.pid, 1);
      const pSecond = cmd(h.app, second.actor, contactId, { kind: 'claim', pondId: w.pondId });
      await waitForWaiters(h.su, lock.pid, 2);
      const pa = first === x ? pFirst : pSecond;
      const pb = first === x ? pSecond : pFirst;
      await lock.release();
      const [ra, rb] = await Promise.all([pa, pb]);
      const winners = [ra, rb].filter((r) => r.outcome.ok);
      const losers = [ra, rb].filter((r) => !r.outcome.ok);
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      const loser = losers[0]!;
      if (loser.outcome.ok) throw new Error('unreachable');
      expect(loser.outcome.code).toBe('LEAD_ALREADY_CLAIMED');
      expect(loser.projection).toBeNull(); // the loser can no longer see the contact
      const winner = ra.outcome.ok ? x : y;
      if (ra.outcome.ok) outcomes.a++;
      else outcomes.b++;
      const c = await contactRow(h.su, contactId);
      expect(c.owner_user_id).toBe(winner.id);
      // rejection logged (never in the gapless ledger), observing the head after the winning claim
      const rej = await suRows<{ code: string; observed_seq: string; actor_user_id: string }>(h.su,
        'SELECT code, observed_seq, actor_user_id FROM ownership_command_rejections WHERE contact_id = $1', [contactId]);
      expect(rej).toEqual([{ code: 'LEAD_ALREADY_CLAIMED', observed_seq: String(c.ownership_seq), actor_user_id: (winner === x ? y : x).id }]);
      // the next command still uses projection.seq + 1 = ledger head + 1
      const rel = await cmd(h.app, winner.actor, contactId, { kind: 'release', reason: 'not_a_fit' });
      expect(rel.outcome.ok).toBe(true);
      const l = await ledger(h.su, contactId);
      expect(l.map((e) => Number(e.seq))).toEqual(l.map((_, k) => k + 1));
      expect(Number((await contactRow(h.su, contactId)).ownership_seq)).toBe(l.length);
    }
    // both session orders actually happened
    expect(outcomes.a + outcomes.b).toBe(100);
    expect(outcomes.a).toBeGreaterThan(0);
    expect(outcomes.b).toBeGreaterThan(0);
  }, 180_000);
});

describe('R-OWN-8 E3: accept and the expiry timer contend at the expiry instant', () => {
  let w: World;
  beforeAll(async () => {
    w = await createWorld(h.app, { agents: 1, rule: 'round_robin' });
    await relaxLimits(w);
  });

  it('R-OWN-6 E3: both read now after the lock; the accept wins iff now < offer_expires_at, no grace (100 runs)', async () => {
    const agent = w.agents[0]!;
    let accepted = 0;
    let expired = 0;
    for (let i = 0; i < 100; i++) {
      await h.su.query(`UPDATE memberships SET accepting_leads = true, consecutive_missed_offers = 0, auto_paused_at = NULL WHERE tenant_id = $1`, [w.tenantId]);
      const { contactId } = await intakeLead(h.app, w, BUY);
      expect((await contactRow(h.su, contactId)).ownership_state).toBe('offered');
      // fixture: the offer expires 400 ms from now (projection and its ledger event alike)
      await suFixture(h.su, `UPDATE contacts SET offer_expires_at = now() + interval '400 milliseconds' WHERE id = $1`, [contactId]);
      await suFixture(h.su, `UPDATE lead_ownership_events SET deadline_at = (SELECT offer_expires_at FROM contacts WHERE id = $1)
                              WHERE contact_id = $1 AND type = 'offered'`, [contactId]);
      const c0 = await contactRow(h.su, contactId);
      const lock = await holdContactLocks(h, w.tenantId, [contactId]);
      const accept = () => cmd(h.app, agent.actor, contactId, { kind: 'accept', offerId: c0.offer_id as string });
      const timer = () => cmd(h.app, w.system('timer'), contactId, { kind: 'timer', deadline: 'offer_expiry', fence: { offerId: c0.offer_id as string } });
      const acceptFirst = i % 2 === 0;
      const p1 = acceptFirst ? accept() : timer();
      await waitForWaiters(h.su, lock.pid, 1);
      const p2 = acceptFirst ? timer() : accept();
      await waitForWaiters(h.su, lock.pid, 2);
      const pAccept = acceptFirst ? p1 : p2;
      const pTimer = acceptFirst ? p2 : p1;
      await new Promise((r) => setTimeout(r, i % 4 < 2 ? 0 : 450)); // release before or after the instant
      await lock.release();
      const [ra, rt] = await Promise.all([pAccept, pTimer]);
      const c = await contactRow(h.su, contactId);
      const l = await ledger(h.su, contactId);
      const exp = (c0.offer_expires_at as Date).getTime();
      if (ra.outcome.ok) {
        accepted++;
        expect(c.ownership_state).toBe('owned');
        expect(l.some((e) => e.type === 'offer_expired')).toBe(false);
        // the timer, whenever it ran, was a no-op (stale fence)
        expect(rt.outcome.ok && rt.outcome.events.length === 0).toBe(true);
        // keep the agent under the uncontacted-capacity cap for the next iterations
        expect((await cmd(h.app, agent.actor, contactId, { kind: 'release', reason: 'not_a_fit' })).outcome.ok).toBe(true);
      } else {
        expired++;
        expect(['LEAD_OFFER_EXPIRED', 'LEAD_STATE_CHANGED', 'LEAD_OFFER_SUPERSEDED']).toContain(ra.outcome.code);
        expect(c.ownership_state).not.toBe('owned');
        const ev = l.find((e) => e.type === 'offer_expired') as unknown as { occurred_at: Date } | undefined;
        expect(ev).toBeDefined();
        expect(ev!.occurred_at.getTime()).toBeGreaterThanOrEqual(new Date(exp).getTime() - 1);
      }
      // the decision instants respect the no-grace rule in both cases
      const accEv = await suRows<{ occurred_at: Date }>(h.su, `SELECT occurred_at FROM lead_ownership_events WHERE contact_id = $1 AND type = 'offer_accepted'`, [contactId]);
      const deadline = (await suRows<{ d: Date }>(h.su, `SELECT deadline_at AS d FROM lead_ownership_events WHERE contact_id = $1 AND type = 'offered' ORDER BY seq LIMIT 1`, [contactId]))[0]!.d;
      for (const e of accEv) expect(e.occurred_at.getTime()).toBeLessThan(deadline.getTime());
    }
    expect(accepted + expired).toBe(100);
    expect(accepted).toBeGreaterThan(0);
    expect(expired).toBeGreaterThan(0);
  }, 180_000);
});

describe('E4: an Admin reassigns while the agent accepts', () => {
  it('R-OWN-5 E4: the second command sees a new seq and is rejected LEAD_STATE_CHANGED', async () => {
    const w = await createWorld(h.app, { agents: 2, rule: 'round_robin' });
    const { contactId } = await intakeLead(h.app, w, BUY);
    const c0 = await contactRow(h.su, contactId);
    const offeree = w.agents.find((a) => a.id === c0.offered_to_user_id)!;
    const other = w.agents.find((a) => a.id !== offeree.id)!;
    const r1 = await cmd(h.app, w.owner.actor, contactId, { kind: 'reassign', toUserId: other.id, reason: 'MANUAL' });
    expect(r1.outcome.ok).toBe(true);
    // the offeree's stale accept: the offer was rescinded, the contact is invisible to them now
    const r2 = await cmd(h.app, offeree.actor, contactId, { kind: 'accept', offerId: c0.offer_id as string });
    expect(r2.outcome.ok).toBe(false);
    if (!r2.outcome.ok) expect(r2.outcome.code).toBe('LEAD_STATE_CHANGED');
    // a stale UI with an old expectedSeq, from someone who can see the lead
    const r3 = await cmd(h.app, other.actor, contactId, { kind: 'release', reason: 'not_a_fit' }, { expectedSeq: Number(c0.ownership_seq) });
    expect(r3.outcome.ok).toBe(false);
    if (!r3.outcome.ok) expect(r3.outcome.code).toBe('LEAD_STATE_CHANGED');
    expect(r3.projection?.ownerUserId).toBe(other.id); // the fresh projection for the 409
    const l = await ledger(h.su, contactId);
    expect(l.slice(-2).map((e) => e.type)).toEqual(['offer_rescinded', 'assigned']); // R-OWN-18: an offered lead has no old owner
  });
});

describe('deadlock-free lock order', () => {
  it('50 parallel routings on one round-robin rule (plus expiries) commit with zero deadlocks and a fair rotation (R-OWN-10)', async () => {
    const w = await createWorld(h.app, { agents: 5, rule: 'round_robin' });
    await relaxLimits(w);
    const before = Number((await suRows<{ d: string }>(h.su, `SELECT deadlocks AS d FROM pg_stat_database WHERE datname = current_database()`))[0]!.d);
    const results = await Promise.all(Array.from({ length: 50 }, () => intakeLead(h.app, w, BUY)));
    expect(results.every((r) => r.result.outcome.ok)).toBe(true);
    const offered = await suRows<{ u: string; n: string }>(h.su,
      `SELECT offered_to_user_id AS u, count(*) AS n FROM contacts WHERE tenant_id = $1 AND ownership_state = 'offered' GROUP BY 1`, [w.tenantId]);
    expect(offered).toHaveLength(5);
    expect(offered.every((o) => Number(o.n) === 10)).toBe(true); // stored cursor, stable order: 10 each
    // 25 offers expire concurrently (each writes its offeree's membership counter) while 25 new leads route
    await suFixture(h.su, `UPDATE contacts SET offer_expires_at = now() - interval '1 second' WHERE tenant_id = $1 AND ownership_state = 'offered'`, [w.tenantId]);
    const toExpire = results.slice(0, 25).map((r) => r.contactId);
    const offers = await suRows<{ id: string; offer_id: string }>(h.su, `SELECT id, offer_id FROM contacts WHERE id = ANY ($1::uuid[])`, [toExpire]);
    const mixed = await Promise.all([
      ...offers.map((o) => cmd(h.app, w.system('timer'), o.id as ContactId, { kind: 'timer', deadline: 'offer_expiry', fence: { offerId: o.offer_id } })),
      ...Array.from({ length: 25 }, () => intakeLead(h.app, w, BUY).then((r) => r.result)),
    ]);
    expect(mixed.every((r) => r.outcome.ok)).toBe(true);
    const after = Number((await suRows<{ d: string }>(h.su, `SELECT deadlocks AS d FROM pg_stat_database WHERE datname = current_database()`))[0]!.d);
    expect(after - before).toBe(0);
    const cursor = await suRows<{ version: string }>(h.su, `SELECT version FROM routing_rotation_state WHERE rule_id = $1`, [w.ruleId]);
    expect(Number(cursor[0]!.version)).toBeGreaterThanOrEqual(75);
  });
});

describe('E5: decline then re-offer with real eligibility data', () => {
  it('R-OWN-10 E5: a decline commits only offer_declined → unassigned; ownership.followup routes as system and the cursor advances', async () => {
    const w = await createWorld(h.app, { agents: 3, rule: 'round_robin' });
    const { contactId } = await intakeLead(h.app, w, BUY);
    const c0 = await contactRow(h.su, contactId);
    const first = w.agents.find((a) => a.id === c0.offered_to_user_id)!;
    const cursor0 = (await suRows<{ cursor: { lastUserId: string } }>(h.su, 'SELECT cursor FROM routing_rotation_state WHERE rule_id = $1', [w.ruleId]))[0]!.cursor;
    expect(cursor0.lastUserId).toBe(first.id);
    const r = await cmd(h.app, first.actor, contactId, { kind: 'decline', offerId: c0.offer_id as string, reason: 'busy' });
    expect(r.outcome.ok).toBe(true);
    if (!r.outcome.ok) return;
    expect(r.outcome.events.map((e) => e.type)).toEqual(['offer_declined']);
    // E5 / R-PERM-7: the decliner kept sight of the row only inside its own command
    expect(r.projection?.state).toBe('unassigned');
    const mid = await contactRow(h.su, contactId);
    expect(mid.ownership_state).toBe('unassigned');
    expect(mid.route_due_at).not.toBeNull();
    const cursorMid = (await suRows<{ cursor: { lastUserId: string } }>(h.su, 'SELECT cursor FROM routing_rotation_state WHERE rule_id = $1', [w.ruleId]))[0]!.cursor;
    expect(cursorMid.lastUserId).toBe(first.id); // the user actor never routed
    const missed = await suRows<{ n: number }>(h.su, 'SELECT consecutive_missed_offers AS n FROM memberships WHERE user_id = $1', [first.id]);
    expect(missed[0]!.n).toBe(1);
    const followups = await suRows<{ payload: { effects: { kind: string }[] } }>(h.su,
      `SELECT payload FROM jobs WHERE tenant_id = $1 AND kind = 'ownership.followup' AND status = 'pending'`, [w.tenantId]);
    expect(followups).toHaveLength(1);
    expect(followups[0]!.payload.effects.map((e) => e.kind)).toContain('route');
    // the sweeper backstop finds the pending route if the follow-up were lost
    const { dueWork } = await import('../src/jobs.js');
    const due = await dueWork((Date.now() + 20_000) as never, 100, { db: h.app });
    expect(due.some((d) => d.workKind === 'route' && d.refId === contactId)).toBe(true);
    // run the follow-up as the worker does
    expect(await drainFollowups(h, w)).toBe(1);
    const c1 = await contactRow(h.su, contactId);
    expect(c1.ownership_state).toBe('offered');
    expect(c1.offered_to_user_id).not.toBe(first.id); // R-OWN-11 #5: not offered twice in a sequence
    const cursor1 = (await suRows<{ cursor: { lastUserId: string } }>(h.su, 'SELECT cursor FROM routing_rotation_state WHERE rule_id = $1', [w.ruleId]))[0]!.cursor;
    expect(cursor1.lastUserId).toBe(c1.offered_to_user_id);
    const l = await ledger(h.su, contactId);
    const reoffer = l.at(-1)!;
    expect(reoffer.type).toBe('offered');
    expect(reoffer.actor_kind).toBe('system');
    const cands = reoffer.payload.candidates as { userId: string; eligible: boolean; skipReason?: string }[];
    expect(cands.find((c) => c.userId === first.id)?.skipReason).toBe('ALREADY_OFFERED');
    // the follow-up is idempotent: replaying its payload routes nothing new
    const { runOwnershipFollowup } = await import('../src/ownership/followup.js');
    const again = await runOwnershipFollowup(w.system('worker'), { commandId: r.outcome.events[0]!.commandId, contactId, effects: [{ kind: 'route' }], fanoutNotificationIds: [] }, { db: h.app });
    expect(again.routed?.replayed).toBe(true);
    expect((await ledger(h.su, contactId)).length).toBe(l.length);
  });
});

describe('E65: inbound ingestion races a Team Lead reassignment', () => {
  /** Simulated ingestion (api/comms owns the real one): lock_contact, read the owner, insert ONE handback for them. */
  async function ingest(w: World, contactId: ContactId): Promise<UserId> {
    return withTenantTx(w.system('provider'), async (tx) => {
      await lockContact(tx, contactId);
      const row = await selectContactForUpdate(tx, contactId);
      const owner = row!.owner_user_id as UserId;
      const actionId = uuid();
      await sql`INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id,
                  explanation, payload, dedupe_key)
                VALUES (${w.tenantId}, ${actionId}, ${contactId}, 'handback', 'novel_message', 'requires_approval', 'proposed', ${owner},
                  'The client replied', '{}'::jsonb, ${'handback:' + actionId})`.execute(tx);
      await sql`INSERT INTO priority_feed_items (tenant_id, id, user_id, item_type, band, contact_id, subject_type, subject_id,
                  assistant_action_id, reasons, dedupe_key)
                VALUES (${w.tenantId}, ${uuid()}, ${owner}, 'handback', 'pinned', ${contactId}, 'assistant_action', ${actionId},
                  ${actionId}, '["CLIENT_REPLIED"]'::jsonb, ${'handback:' + actionId})`.execute(tx);
      return owner;
    }, { db: h.app });
  }

  it('R-AST-9 E65: whichever commits first, the handback and its feed item end with the new owner (40 runs)', async () => {
    const w = await createWorld(h.app, { agents: 2, teamLead: true });
    await relaxLimits(w);
    const [a, b] = w.agents as [Member, Member];
    const orders = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const { contactId } = await intakeLead(h.app, w);
      expect((await cmd(h.app, a.actor, contactId, { kind: 'claim', pondId: w.pondId })).outcome.ok).toBe(true);
      const lock = await holdContactLocks(h, w.tenantId, [contactId]);
      const doIngest = () => ingest(w, contactId);
      const doReassign = () => cmd(h.app, w.tl!.actor, contactId, { kind: 'reassign', toUserId: b.id, reason: 'TEAM_BALANCE' });
      const ingestFirst = i % 2 === 0;
      const p1 = ingestFirst ? doIngest() : doReassign();
      await waitForWaiters(h.su, lock.pid, 1);
      const p2 = ingestFirst ? doReassign() : doIngest();
      await waitForWaiters(h.su, lock.pid, 2);
      const pIngest = (ingestFirst ? p1 : p2) as Promise<UserId>;
      const pReassign = (ingestFirst ? p2 : p1) as ReturnType<typeof doReassign>;
      await lock.release();
      const [ingestOwner, re] = await Promise.all([pIngest, pReassign]);
      expect(re.outcome.ok).toBe(true);
      orders.add(ingestOwner === a.id ? 'ingest-first' : 'reassign-first');
      await drainFollowups(h, w);
      const hb = await suRows<{ owner_user_id: string }>(h.su, `SELECT owner_user_id FROM assistant_actions WHERE contact_id = $1 AND kind = 'handback'`, [contactId]);
      expect(hb).toEqual([{ owner_user_id: b.id }]);
      const feed = await suRows<{ user_id: string }>(h.su, `SELECT user_id FROM priority_feed_items WHERE contact_id = $1 AND item_type = 'handback' AND state = 'open'`, [contactId]);
      expect(feed).toEqual([{ user_id: b.id }]);
      // the new owner can actually see it under RLS; the old owner cannot
      const seenByB = await withTenantTx(b.actor, async (tx) => (await sql<{ n: string }>`SELECT count(*) AS n FROM assistant_actions WHERE contact_id = ${contactId}`.execute(tx)).rows[0]!.n, { db: h.app });
      const seenByA = await withTenantTx(a.actor, async (tx) => (await sql<{ n: string }>`SELECT count(*) AS n FROM assistant_actions WHERE contact_id = ${contactId}`.execute(tx)).rows[0]!.n, { db: h.app });
      expect([Number(seenByB), Number(seenByA)]).toEqual([1, 0]);
    }
    expect(orders.size).toBe(2);
  }, 120_000);
});

describe('E66: a human send (dispatch TX1) races auto_release at the deadline', () => {
  /** Simulated dispatch TX1 (api/comms owns the real one): lock, sender must still own the lead, touch in the same tx. */
  async function sendTx1(w: World, m: Member, contactId: ContactId): Promise<'sent' | 'blocked'> {
    return withTenantTx(m.actor, async (tx, now) => {
      await lockContact(tx, contactId);
      const row = await selectContactForUpdate(tx, contactId);
      if (!row || row.ownership_state !== 'owned' || row.owner_user_id !== m.id) return 'blocked';
      const at = (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(tx)).rows[0]!.now.getTime();
      const r = await applyOwnershipCommandInTx(tx, m.actor, contactId, { kind: 'touch', via: 'sms', refId: uuid(), at: Math.max(at, now) as never }, { commandId: uuid() });
      return r.outcome.ok ? 'sent' : 'blocked';
    }, { db: h.app });
  }

  it('R-OWN-14 E66: exactly one order wins: touch first ⇒ no release; release first ⇒ the send is blocked (40 runs)', async () => {
    const w = await createWorld(h.app, { agents: 1 });
    await relaxLimits(w);
    const agent = w.agents[0]!;
    const seen = new Set<string>();
    for (let i = 0; i < 40; i++) {
      const { contactId } = await intakeLead(h.app, w);
      expect((await cmd(h.app, agent.actor, contactId, { kind: 'claim', pondId: w.pondId })).outcome.ok).toBe(true);
      // fixture: release due 30 ms from now
      await suFixture(h.su, `UPDATE contacts SET release_due_at = now() + interval '30 milliseconds', first_touch_due_at = now() WHERE id = $1`, [contactId]);
      const c0 = await contactRow(h.su, contactId);
      const lock = await holdContactLocks(h, w.tenantId, [contactId]);
      const send = () => sendTx1(w, agent, contactId);
      const release = () => cmd(h.app, w.system('timer'), contactId, { kind: 'timer', deadline: 'auto_release', fence: { periodSeq: Number(c0.ownership_period_seq), dueAt: (c0.release_due_at as Date).getTime() as never } });
      const sendFirst = i % 2 === 0;
      const p1 = sendFirst ? send() : release();
      await waitForWaiters(h.su, lock.pid, 1);
      const p2 = sendFirst ? release() : send();
      await waitForWaiters(h.su, lock.pid, 2);
      const pSend = (sendFirst ? p1 : p2) as Promise<'sent' | 'blocked'>;
      const pRelease = (sendFirst ? p2 : p1) as ReturnType<typeof release>;
      await new Promise((r) => setTimeout(r, 40)); // past the deadline: whoever holds the lock first decides
      await lock.release();
      const [sent, rel] = await Promise.all([pSend, pRelease]);
      expect(rel.outcome.ok).toBe(true);
      const c = await contactRow(h.su, contactId);
      const types = (await ledger(h.su, contactId)).map((e) => e.type);
      if (sent === 'sent') {
        seen.add('touch-first');
        expect(c.ownership_state).toBe('owned');
        expect(c.first_touch_at).not.toBeNull();
        expect(types).toContain('first_touch_recorded');
        expect(types).not.toContain('auto_released');
      } else {
        seen.add('release-first');
        expect(c.ownership_state).toBe('in_pond');
        expect(types).toContain('auto_released');
        expect(types).not.toContain('first_touch_recorded');
      }
    }
    expect(seen.size).toBe(2);
  }, 120_000);
});

describe('E13: routing picks an agent while their deactivation commits', () => {
  it('R-OWN-22 E13: routing holds candidate memberships FOR SHARE, so the deactivation serializes with it and the next routing skips the member', async () => {
    const w = await createWorld(h.app, { agents: 2, rule: 'round_robin' });
    const [x] = w.agents as [Member, Member];
    // the Owner's deactivation transaction (stage 1) holds x's membership row
    const pg = (await import('pg')).default;
    const c = new pg.Client({ connectionString: h.db.appUserUrl });
    await c.connect();
    await c.query('BEGIN');
    await c.query(`SELECT set_config('app.tenant_id', $1, true), set_config('app.user_id', $2, true), set_config('app.actor_kind', 'user', true),
                          set_config('app.principal_type', 'staff', true)`, [w.tenantId, w.owner.id]);
    await c.query(`UPDATE memberships SET status = 'deactivating', accepting_leads = false WHERE tenant_id = $1 AND user_id = $2`, [w.tenantId, x.id]);
    const pid = (await c.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid;
    const routing = intakeLead(h.app, w, BUY);
    await waitForWaiters(h.su, pid, 1); // the router waits for the deactivation's row lock (FOR SHARE vs FOR UPDATE)
    await c.query('COMMIT');
    await c.end();
    const { contactId } = await routing;
    const offered = await contactRow(h.su, contactId);
    expect(offered.offered_to_user_id).not.toBe(x.id);
    const cands = (await ledger(h.su, contactId)).find((e) => e.type === 'offered')!.payload.candidates as { userId: string; skipReason?: string }[];
    expect(cands.find((k) => k.userId === x.id)?.skipReason).toBe('MEMBERSHIP_INACTIVE');
  });
});
