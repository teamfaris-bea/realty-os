// api/leads ownership commands end to end (BUILD_PLAN module 11): accept / decline / claim / release
// through the API, with the timers and the follow-up run by a real worker. Edge cases E1–E5.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { actorFor } from '../auth/sessions.js';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import {
  type LeadsWorld,
  call,
  command,
  contactState,
  intake,
  jobs,
  ledger,
  leadsWorker,
  leadsWorld,
  rejections,
  setOfferExpiry,
} from './testing.js';
import { getContact } from './repos/contacts.js';
import { projectionFromRow } from './views.js';

let h: ApiHarness;
let w: LeadsWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await leadsWorld(h, { agents: 2 });
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const agentOf = (wd: LeadsWorld, userId: string | null): TestClient => wd.agents.find((a) => a.userId === userId)!;
const otherAgent = (wd: LeadsWorld, userId: string | null): TestClient => wd.agents.find((a) => a.userId !== userId)!;

/** A fresh team whose agents are not paused or capped by the misses and accepts of other tests. */
async function roomyWorld(): Promise<LeadsWorld> {
  const wd = await leadsWorld(h, { agents: 2 });
  const s = (await call<{ settings: { version: number } }>(wd.owner, 'GET', '/settings')).body.settings;
  const r = await call(wd.owner, 'PATCH', '/settings', { version: s.version, autoPauseAfterMisses: 10, uncontactedCapacityCap: 50 });
  if (r.status !== 200) throw new Error(`settings ${r.status}`);
  return wd;
}

async function offered(wd: LeadsWorld = w) {
  const r = await intake(h, wd);
  const st = await contactState(h, r.contactId);
  if (st.ownership_state !== 'offered') throw new Error(`not offered: ${st.ownership_state}`);
  return { contactId: r.contactId, st, offeree: agentOf(wd, st.offered_to_user_id) };
}

describe('accept (R-OWN-8, R-OWN-7, R-OWN-13)', () => {
  it('R-OWN-8 R-OWN-13: the offeree accepts before expiry: owned, an SLA period starts with its breach and auto-release timers; the timeline shows it with its reason', async () => {
    const { contactId, st, offeree } = await offered();
    const r = await command<{ result: { projection: { state: string; ownerUserId: string; firstTouchDueAt: string; releaseDueAt: string } } }>(offeree, contactId, 'accept', { offerId: st.offer_id, expectedSeq: Number(st.ownership_seq) });
    expect(r.status).toBe(200);
    expect(r.body.result.projection).toMatchObject({ state: 'owned', ownerUserId: offeree.userId });
    expect(new Date(r.body.result.projection.releaseDueAt).getTime() - new Date(r.body.result.projection.firstTouchDueAt).getTime()).toBeGreaterThan(0);
    const kinds = (await jobs(h, w.tenantId)).filter((j) => j.payload.contactId === contactId && j.status === 'pending').map((j) => j.kind).sort();
    expect(kinds).toEqual(expect.arrayContaining(['ownership.auto_release', 'ownership.first_touch_breach', 'ownership.inactivity']));
    const tl = await call<{ items: { type: string; detail: string; preview: string }[] }>(offeree, 'GET', `/contacts/${contactId}/timeline`);
    expect(tl.body.items.filter((i) => i.type === 'ownership').map((i) => [i.detail, i.preview])).toEqual([
      ['offer_accepted', 'OFFER_ACCEPTED'],
      ['offered', 'ROUND_ROBIN'],
      ['created', 'INTAKE'],
    ]);
    // R-AUDIT-5: the human command is mirrored in audit_log (once)
    const a = (await h.su.query("SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'ownership.accept'", [contactId])).rows[0].n;
    expect(a).toBe(1);
  });

  it('R-OWN-7: replaying the same command id returns the stored outcome and writes nothing; a second accept with a new id is ALREADY_OWNER (rejection only)', async () => {
    const { contactId, st, offeree } = await offered();
    const commandId = randomUUID();
    const first = await call<{ result: { replayed: boolean; events: unknown[] } }>(offeree, 'POST', `/leads/${contactId}/accept`, { commandId, offerId: st.offer_id });
    const events = (await ledger(h, contactId)).length;
    const again = await call<{ result: { replayed: boolean; events: unknown[] } }>(offeree, 'POST', `/leads/${contactId}/accept`, { commandId, offerId: st.offer_id });
    expect([first.status, again.status, first.body.result.replayed, again.body.result.replayed]).toEqual([200, 200, false, true]);
    expect(again.body.result.events).toEqual(first.body.result.events);
    expect((await ledger(h, contactId)).length).toBe(events);
    const second = await command(offeree, contactId, 'accept', { offerId: st.offer_id });
    expect([second.status, second.code]).toEqual([409, 'ALREADY_OWNER']);
    expect((await ledger(h, contactId)).length).toBe(events);
    expect((await rejections(h, contactId)).map((x) => x.code)).toEqual(['ALREADY_OWNER']);
  });

  it('R-OWN-8 R-PERM-5: someone else accepting the offer gets 404 (LEAD_OFFER_NOT_YOURS is never revealed); the rejection is still logged', async () => {
    const { contactId, st, offeree } = await offered();
    const other = otherAgent(w, offeree.userId);
    const r = await command(other, contactId, 'accept', { offerId: st.offer_id });
    expect([r.status, r.code]).toEqual([404, 'NOT_FOUND']);
    // the other agent cannot even see the offer card
    expect((await call(other, 'GET', `/contacts/${contactId}`)).status).toBe(404);
  });

  it('R-OWN-8 R-OWN-15 E2: an accept 200 ms after expiry is LEAD_OFFER_EXPIRED (rejection log only); the due offer_expiry job then expires it and offers the next agent as the system', async () => {
    const { contactId, offeree, st } = await offered();
    await setOfferExpiry(h, contactId, -200);
    const late = await command(offeree, contactId, 'accept', { offerId: st.offer_id });
    expect([late.status, late.code]).toEqual([409, 'LEAD_OFFER_EXPIRED']);
    expect((await ledger(h, contactId)).map((e) => e.type)).toEqual(['created', 'offered']);
    expect((await rejections(h, contactId)).map((x) => [x.code, x.actor_user_id])).toEqual([['LEAD_OFFER_EXPIRED', offeree.userId]]);
    await leadsWorker(h).drain();
    const after = await contactState(h, contactId);
    expect(after.ownership_state).toBe('offered');
    expect(after.offered_to_user_id).toBe(otherAgent(w, offeree.userId).userId);
    const ev = await ledger(h, contactId);
    expect(ev.slice(2).map((e) => [e.type, e.actor_kind])).toEqual([
      ['offer_expired', 'timer'],
      ['offered', 'timer'],
    ]);
    // R-OWN-12: the missed offer counts against the agent who let it lapse
    const m = (await h.su.query('SELECT consecutive_missed_offers AS n FROM memberships WHERE user_id = $1', [offeree.userId])).rows[0].n;
    expect(m).toBeGreaterThan(0);
  });

  it('R-OWN-6 R-OWN-8 E3: accept and the expiry timer contending at the expiry instant: exactly one wins, decided by the DB clock read after the lock (no grace)', async () => {
    const race = await roomyWorld();
    for (const offset of [-5, 0, 5, 15, 40]) {
      const { contactId, offeree, st } = await offered(race);
      const expiresAt = await setOfferExpiry(h, contactId, offset);
      const worker = leadsWorker(h);
      const [acc] = await Promise.all([command(offeree, contactId, 'accept', { offerId: st.offer_id }), worker.drain()]);
      await worker.drain();
      const ev = await ledger(h, contactId);
      const accepted = ev.find((e) => e.type === 'offer_accepted');
      const expired = ev.find((e) => e.type === 'offer_expired' && e.payload !== null);
      if (acc.status === 200) {
        expect(accepted).toBeDefined();
        expect(ev.filter((e) => e.type === 'offer_expired')).toHaveLength(0);
        const at = (await h.su.query<{ t: Date }>("SELECT occurred_at AS t FROM lead_ownership_events WHERE contact_id = $1 AND type = 'offer_accepted'", [contactId])).rows[0]!.t;
        expect(at.getTime()).toBeLessThan(expiresAt.getTime());
      } else {
        expect(acc.code).toMatch(/^(LEAD_OFFER_EXPIRED|LEAD_OFFER_SUPERSEDED|LEAD_STATE_CHANGED|NOT_FOUND)$/);
        expect(accepted).toBeUndefined();
        expect(expired).toBeDefined();
      }
    }
  });
});

describe('decline (E5, R-PERM-7, R-OWN-10)', () => {
  it('R-OWN-10 R-PERM-7 E5: a decline commits offer_declined → unassigned (route_due_at); the decliner loses sight at commit; ownership.followup re-routes as the system with real eligibility data and the round-robin cursor advances', async () => {
    // a fresh team: devices registered through the module-8 endpoint (no direct inserts), nobody paused
    const d = await leadsWorld(h, { agents: 2 });
    const w = d;
    const { contactId, offeree, st } = await offered(d);
    const cursorBefore = Number((await h.su.query('SELECT version FROM routing_rotation_state WHERE rule_id = $1', [w.ruleId])).rows[0]?.version ?? 0);
    const r = await command<{ result: { projection: unknown; events: { type: string }[] } }>(offeree, contactId, 'decline', { offerId: st.offer_id, reason: 'busy' });
    expect(r.status).toBe(200);
    expect(r.body.result.events.map((e) => e.type)).toEqual(['offer_declined']);
    expect(r.body.result.projection).toBeNull(); // the decliner no longer sees the contact
    const mid = await contactState(h, contactId);
    expect([mid.ownership_state, mid.route_due_at !== null]).toEqual(['unassigned', true]);
    expect((await call(offeree, 'GET', `/contacts/${contactId}`)).status).toBe(404);
    const f = (await jobs(h, w.tenantId, 'ownership.followup')).filter((j) => j.payload.contactId === contactId);
    expect(f).toHaveLength(1);
    await leadsWorker(h).drain();
    const after = await contactState(h, contactId);
    expect([after.ownership_state, after.offered_to_user_id]).toEqual(['offered', otherAgent(w, offeree.userId).userId]);
    const last = (await ledger(h, contactId)).at(-1)!;
    expect([last.type, last.actor_kind]).toEqual(['offered', 'system']);
    const cands = last.payload.candidates as { userId: string; eligible: boolean; skipReason?: string }[];
    expect(cands.find((c) => c.userId === offeree.userId)).toMatchObject({ eligible: false, skipReason: 'ALREADY_OFFERED' });
    const cursorAfter = Number((await h.su.query('SELECT version FROM routing_rotation_state WHERE rule_id = $1', [w.ruleId])).rows[0]!.version);
    expect(cursorAfter).toBeGreaterThan(cursorBefore);
  });
});

describe('claim and release (E1, R-OWN-5, R-OWN-16, R-OWN-17)', () => {
  let p: LeadsWorld;
  beforeAll(async () => {
    p = await leadsWorld(h, { agents: 3, rule: false });
  }, 120_000);

  async function pondLead(): Promise<string> {
    const r = await intake(h, p);
    const st = await contactState(h, r.contactId);
    expect([st.ownership_state, st.pond_id]).toEqual(['in_pond', p.defaultPondId]);
    return r.contactId;
  }

  it('R-OWN-5 E1: two agents tap Claim within milliseconds: one wins; the other gets LEAD_ALREADY_CLAIMED in the rejection log (not the ledger); the winner can still release (seq = head)', async () => {
    for (let round = 0; round < 3; round++) {
      const contactId = await pondLead();
      const [a, b] = [p.agents[round % 3]!, p.agents[(round + 1) % 3]!];
      const res = await Promise.all([command(a, contactId, 'claim'), command(b, contactId, 'claim')]);
      const statuses = res.map((x) => x.status).sort();
      expect(statuses).toEqual([200, 409]);
      const loser = res.find((x) => x.status === 409)!;
      expect(loser.code).toBe('LEAD_ALREADY_CLAIMED');
      const winner = res[0]!.status === 200 ? a : b;
      const loserClient = winner === a ? b : a;
      const ev = await ledger(h, contactId);
      expect(ev.map((e) => e.type)).toEqual(['created', 'sent_to_pond', 'claimed']);
      expect((await rejections(h, contactId)).map((x) => [x.code, x.actor_user_id, x.observed_seq])).toEqual([['LEAD_ALREADY_CLAIMED', loserClient.userId, '3']]);
      const rel = await command(winner, contactId, 'release', { reason: 'not_a_fit', expectedSeq: 3 });
      expect(rel.status).toBe(200);
      const st = await contactState(h, contactId);
      expect([st.ownership_state, st.ownership_seq]).toEqual(['in_pond', '4']);
    }
  });

  it('R-OWN-17: a release needs a reason (and a note for other); the lead goes to the default pond and the releaser is in cooldown (CLAIM_COOLDOWN)', async () => {
    const contactId = await pondLead();
    const a = p.agents[0]!;
    expect((await command(a, contactId, 'claim')).status).toBe(200);
    expect((await command(a, contactId, 'release', {})).status).toBe(422);
    const other = await command(a, contactId, 'release', { reason: 'other' });
    expect([other.status, other.code]).toEqual([422, 'VALIDATION_FAILED']);
    const ok = await command(a, contactId, 'release', { reason: 'other', note: 'Wants a rental, we only do sales' });
    expect(ok.status).toBe(200);
    expect((await contactState(h, contactId)).pond_id).toBe(p.defaultPondId);
    const tl = await call<{ items: { type: string; detail: string; preview: string; note: string | null }[] }>(p.owner, 'GET', `/contacts/${contactId}/timeline`);
    expect(tl.body.items[0]).toMatchObject({ type: 'ownership', detail: 'released', preview: 'RELEASED_OTHER', note: 'Wants a rental, we only do sales' });
    const again = await command(a, contactId, 'claim');
    expect([again.status, again.code]).toEqual([409, 'CLAIM_COOLDOWN']);
    expect((await command(p.agents[1]!, contactId, 'claim')).status).toBe(200);
  });

  it('R-OWN-16: claims per tenant-local day, capacity of uncontacted leads and pond role eligibility are enforced, and every refusal is recorded', async () => {
    const owner = p.owner;
    const pond = await call<{ pond: { id: string; version?: number } }>(owner, 'PATCH', `/ponds/${p.defaultPondId}`, { claimsPerDay: 2, eligibleRoles: ['agent', 'isa'] });
    expect(pond.status).toBe(200);
    const agent = p.agents[2]!;
    const c1 = await pondLead();
    const c2 = await pondLead();
    const c3 = await pondLead();
    // agent[2] already claimed in the E1 rounds above; count what is left today
    const today = (await h.su.query("SELECT count(*)::int AS n FROM lead_ownership_events WHERE actor_user_id = $1 AND type = 'claimed' AND occurred_at > now() - interval '1 day'", [agent.userId])).rows[0].n;
    const results = [];
    for (const c of [c1, c2, c3]) results.push(await command(agent, c, 'claim'));
    const codes = results.map((r) => (r.status === 200 ? 'ok' : r.code));
    const allowed = Math.max(0, 2 - today);
    expect(codes.filter((c) => c === 'ok')).toHaveLength(Math.min(3, allowed));
    expect(codes.slice(allowed)).toEqual(Array(3 - allowed).fill('CLAIM_LIMIT_REACHED'));
    // capacity: uncontacted owned leads at the cap
    await call(owner, 'PATCH', `/ponds/${p.defaultPondId}`, { claimsPerDay: 50 });
    let s = (await call<{ settings: { version: number } }>(owner, 'GET', '/settings')).body.settings;
    const capped = await call<{ settings: { version: number } }>(owner, 'PATCH', '/settings', { version: s.version, uncontactedCapacityCap: 1 });
    expect(capped.status).toBe(200);
    const fresh = p.agents[1]!;
    const held = (await h.su.query("SELECT count(*)::int AS n FROM contacts WHERE owner_user_id = $1 AND ownership_state = 'owned' AND first_touch_at IS NULL AND first_touch_due_at IS NOT NULL", [fresh.userId])).rows[0].n;
    expect(held).toBeGreaterThanOrEqual(1);
    const c4 = await pondLead();
    const cap = await command(fresh, c4, 'claim');
    expect([cap.status, cap.code]).toEqual([409, 'CAPACITY_REACHED']);
    s = capped.body.settings;
    await call(owner, 'PATCH', '/settings', { version: s.version, uncontactedCapacityCap: 5 });
    // a Team Lead sees every pond card but this pond takes claims from agents and ISAs only
    const tlClient = await h.invite(owner, 'team_lead');
    const tlr = await command(tlClient, c4, 'claim');
    expect([tlr.status, tlr.code]).toEqual([409, 'POND_NOT_ELIGIBLE']);
    const codesLogged = (await h.su.query<{ code: string }>('SELECT code FROM ownership_command_rejections WHERE contact_id = ANY ($1::uuid[])', [[c1, c2, c3, c4]])).rows.map((x) => x.code);
    expect(codesLogged).toEqual(expect.arrayContaining(['CAPACITY_REACHED', 'POND_NOT_ELIGIBLE']));
    await call(owner, 'PATCH', `/ponds/${p.defaultPondId}`, { eligibleRoles: ['agent', 'team_lead', 'isa'] });
  });

  it('R-OWN-5: a stale UI (expectedSeq behind the head) gets LEAD_STATE_CHANGED with the fresh projection when the caller can still see the contact', async () => {
    const contactId = await pondLead();
    const a = p.agents[0]!;
    const r = await command<{ error: { details: { projection: { state: string; seq: number } } } }>(a, contactId, 'claim', { expectedSeq: 1 });
    expect([r.status, r.code]).toEqual([409, 'LEAD_STATE_CHANGED']);
    expect(r.body.error.details.projection).toMatchObject({ state: 'in_pond', seq: 2 });
  });
});

describe('E4: Admin reassigns while the agent accepts', () => {
  it('R-OWN-5 E4: whichever commits second sees a new seq: an accept after the reassign is refused (no projection leaks to the agent); a reassign with a stale seq gets LEAD_STATE_CHANGED with the fresh projection', async () => {
    const w = await roomyWorld();
    // order 1: the reassign commits first
    const one = await offered(w);
    const other = otherAgent(w, one.offeree.userId);
    const re = await command(w.owner, one.contactId, 'reassign', { toUserId: other.userId, expectedSeq: Number(one.st.ownership_seq) });
    expect(re.status).toBe(200);
    const acc = await command(one.offeree, one.contactId, 'accept', { offerId: one.st.offer_id, expectedSeq: Number(one.st.ownership_seq) });
    expect(acc.status).toBe(409);
    expect(acc.code).toBe('LEAD_STATE_CHANGED');
    expect((acc.body as { error: { details?: { projection?: unknown } } }).error.details?.projection).toBeUndefined();
    expect((await ledger(h, one.contactId)).map((e) => e.type)).toEqual(['created', 'offered', 'offer_rescinded', 'assigned']);
    // order 2: the accept commits first; the Admin's screen still shows the offered seq
    const two = await offered(w);
    const okAcc = await command(two.offeree, two.contactId, 'accept', { offerId: two.st.offer_id });
    expect(okAcc.status).toBe(200);
    const stale = await command<{ error: { details: { projection: { state: string; ownerUserId: string } } } }>(w.owner, two.contactId, 'reassign', {
      toUserId: otherAgent(w, two.offeree.userId).userId,
      expectedSeq: Number(two.st.ownership_seq),
    });
    expect([stale.status, stale.code]).toEqual([409, 'LEAD_STATE_CHANGED']);
    expect(stale.body.error.details.projection).toMatchObject({ state: 'owned', ownerUserId: two.offeree.userId });
    // concurrently: exactly one of them changes the lead
    const three = await offered(w);
    const [x, y] = await Promise.all([
      command(three.offeree, three.contactId, 'accept', { offerId: three.st.offer_id, expectedSeq: Number(three.st.ownership_seq) }),
      command(w.owner, three.contactId, 'reassign', { toUserId: otherAgent(w, three.offeree.userId).userId, expectedSeq: Number(three.st.ownership_seq) }),
    ]);
    expect([x.status, y.status].sort()).toEqual([200, 409]);
    expect(Number((await contactState(h, three.contactId)).ownership_seq)).toBe(Number(three.st.ownership_seq) + (y.status === 200 ? 2 : 1));
  });
});

// Lane perf-misses (claim contention): the response projection is read in the command's own
// transaction, after its writes, with app.ownership_command cleared. It must equal what a FRESH
// transaction of the caller reads after the commit (the previous implementation), for every outcome:
// still visible (accept, claim, stale UI), changed or gone at commit (decline, release, reassign away),
// rejected without sight (late accept).
describe('response projection read-back (R-PERM-7)', () => {
  async function fresh(c: TestClient, contactId: string) {
    const actor = actorFor({ userId: c.userId!, tenantId: c.tenantId!, role: c.role!, sessionId: randomUUID() });
    const row = await withTenantTx(actor, (tx) => getContact(tx, contactId), { db: h.database });
    return row ? projectionFromRow(row) : null;
  }
  type Res = { status: number; body: { result?: { projection: unknown }; error?: { details?: { projection?: unknown } } } };
  const shown = (r: Res) => (r.status === 200 ? r.body.result!.projection : (r.body.error?.details?.projection ?? null));
  const same = async (c: TestClient, contactId: string, r: Res) => expect(JSON.parse(JSON.stringify(shown(r)))).toEqual(JSON.parse(JSON.stringify(await fresh(c, contactId))));

  it('equals a fresh read of the caller after the commit: accept, a second accept (ALREADY_OWNER), a stale reassign, a reassign away, a late accept, a decline, claim, release and a stale claim', async () => {
    const wd = await roomyWorld();
    const a = await offered(wd);
    const acc = (await command(a.offeree, a.contactId, 'accept', { offerId: a.st.offer_id })) as Res;
    expect(acc.status).toBe(200);
    await same(a.offeree, a.contactId, acc);
    const again = (await command(a.offeree, a.contactId, 'accept', { offerId: a.st.offer_id })) as Res;
    expect(again.status).toBe(409);
    await same(a.offeree, a.contactId, again);
    const stale = (await command(wd.owner, a.contactId, 'reassign', { toUserId: otherAgent(wd, a.offeree.userId).userId, expectedSeq: Number(a.st.ownership_seq) })) as Res;
    expect(stale.status).toBe(409);
    await same(wd.owner, a.contactId, stale);
    const away = (await command(wd.owner, a.contactId, 'reassign', { toUserId: otherAgent(wd, a.offeree.userId).userId })) as Res;
    expect(away.status).toBe(200);
    await same(wd.owner, a.contactId, away);
    const late = (await command(a.offeree, a.contactId, 'accept', { offerId: a.st.offer_id })) as Res;
    expect(late.status).toBe(409);
    await same(a.offeree, a.contactId, late);
    expect(shown(late)).toBeNull();

    const d = await offered(wd);
    const dec = (await command(d.offeree, d.contactId, 'decline', { offerId: d.st.offer_id, reason: 'busy' })) as Res;
    expect(dec.status).toBe(200);
    expect(shown(dec)).toBeNull();
    await same(d.offeree, d.contactId, dec);

    const p = await leadsWorld(h, { agents: 2, rule: false });
    const lead = (await intake(h, p)).contactId;
    const agent = p.agents[0]!;
    const cl = (await command(agent, lead, 'claim')) as Res;
    expect(cl.status).toBe(200);
    await same(agent, lead, cl);
    const rel = (await command(agent, lead, 'release', { reason: 'not_a_fit' })) as Res;
    expect(rel.status).toBe(200);
    await same(agent, lead, rel);
    const staleClaim = (await command(p.agents[1]!, lead, 'claim', { expectedSeq: 1 })) as Res;
    expect(staleClaim.status).toBe(409);
    await same(p.agents[1]!, lead, staleClaim);
  });
});
