// api/leads: reassign / ISA handoff / close / reopen / soft delete / merge through the API
// (R-OWN-18, R-OWN-19, R-OWN-24, R-OWN-26, E62, R-PERM-15).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type LeadsWorld, call, command, contactState, intake, jobs, ledger, leadsWorker, leadsWorld, randomPhone, registerPush } from './testing.js';
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';

let h: ApiHarness;
let w: LeadsWorld & { others: TestClient[] };
let outsider: TestClient; // an agent who is not in the Team Lead's team
let isa: TestClient;
let tc: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  w = await leadsWorld(h, { agents: 2, teamLead: true, others: ['agent', 'isa', 'tc'] });
  [outsider, isa, tc] = w.others as [TestClient, TestClient, TestClient];
  await registerPush(outsider);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

async function ownedBy(agent: TestClient): Promise<string> {
  const r = await call<{ contact: { id: string } }>(agent, 'POST', '/contacts', { commandId: randomUUID(), displayName: `Owned ${randomUUID().slice(0, 6)}`, phones: [randomPhone()] });
  if (r.status !== 201) throw new Error(`create: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.contact.id;
}

describe('self-created contacts (R-OWN-19)', () => {
  it('R-OWN-19 R-PERM-15: an agent, ISA or TL creating a contact owns it (SELF_CREATED, no SLA); a TC cannot create one', async () => {
    for (const c of [w.agents[0]!, isa, w.teamLead!]) {
      const id = await ownedBy(c);
      const st = await contactState(h, id);
      expect([st.ownership_state, st.owner_user_id, st.first_touch_due_at, st.release_due_at]).toEqual(['owned', c.userId, null, null]);
      expect((await ledger(h, id)).map((e) => [e.type, e.reason_code])).toEqual([['created', 'SELF_CREATED']]);
    }
    const r = await call(tc, 'POST', '/contacts', { commandId: randomUUID(), displayName: 'Nope' });
    expect(r.status).toBe(404);
  });

  it('R-OWN-25 R-PERM-12: creating a contact whose phone already belongs to another agent\'s contact is refused with only the owner\'s name; confirmDistinct creates it with a duplicate candidate', async () => {
    const phone = randomPhone();
    const a = w.agents[0]!;
    const b = w.agents[1]!;
    const mine = await call<{ contact: { id: string } }>(a, 'POST', '/contacts', { commandId: randomUUID(), displayName: 'Sam Spouse', phones: [phone] });
    const dup = await call<{ error: { details: { matches: { contactId: string | null; ownerDisplayName: string }[] } } }>(b, 'POST', '/contacts', { commandId: randomUUID(), displayName: 'Sam Spouse', phones: [phone] });
    expect([dup.status, dup.code]).toEqual([409, 'DUPLICATE_CONTACT']);
    expect(dup.body.error.details.matches).toEqual([{ contactId: null, ownerDisplayName: 'Member agent' }]);
    expect(JSON.stringify(dup.body)).not.toContain(phone);
    const forced = await call<{ contact: { id: string } }>(b, 'POST', '/contacts', { commandId: randomUUID(), displayName: 'Alex Spouse', phones: [phone], confirmDistinct: true });
    expect(forced.status).toBe(201);
    const [x, y] = [mine.body.contact.id, forced.body.contact.id].sort();
    expect((await h.su.query('SELECT match_reason FROM contact_duplicate_candidates WHERE contact_a_id = $1 AND contact_b_id = $2', [x, y])).rows).toEqual([{ match_reason: 'shared_phone' }]);
    // the agent's own existing contact is named to them
    const own = await call<{ error: { details: { matches: { contactId: string | null }[] } } }>(a, 'POST', '/contacts', { commandId: randomUUID(), displayName: 'Sam Again', phones: [phone] });
    expect(own.body.error.details.matches.map((m) => m.contactId)).toContain(mine.body.contact.id);
    // a replayed create returns the same contact
    const commandId = randomUUID();
    const one = await call<{ contact: { id: string } }>(a, 'POST', '/contacts', { commandId, displayName: 'Replay Me' });
    const two = await call<{ contact: { id: string }; replayed: boolean }>(a, 'POST', '/contacts', { commandId, displayName: 'Replay Me' });
    expect([one.status, two.status, two.body.replayed, two.body.contact.id]).toEqual([201, 200, true, one.body.contact.id]);
  });
});

describe('reassign and handoff (R-OWN-18)', () => {
  it('R-OWN-18: Owner/Admin reassign anywhere; a TL only when the owner and the target are in a team they lead; an agent never; never to a TC', async () => {
    const lead = await ownedBy(w.agents[0]!);
    const tl = w.teamLead!;
    // TL within team: agent0 → agent1
    const ok = await command(tl, lead, 'reassign', { toUserId: w.agents[1]!.userId, note: 'Covering for the weekend' });
    expect(ok.status).toBe(200);
    expect((await contactState(h, lead)).owner_user_id).toBe(w.agents[1]!.userId);
    // TL to an agent outside the team
    const out = await command(tl, lead, 'reassign', { toUserId: outsider.userId });
    expect([out.status, out.code]).toEqual([403, 'TARGET_NOT_ELIGIBLE']);
    // TL on a lead owned outside the team: invisible
    const foreign = await ownedBy(outsider);
    expect((await command(tl, foreign, 'reassign', { toUserId: w.agents[0]!.userId })).status).toBe(404);
    // an agent cannot reassign their own lead
    const own = await ownedBy(w.agents[0]!);
    expect((await command(w.agents[0]!, own, 'reassign', { toUserId: w.agents[1]!.userId })).status).toBe(404);
    // never to a TC (R-PERM-15)
    const toTc = await command(w.owner, own, 'reassign', { toUserId: tc.userId });
    expect([toTc.status, toTc.code]).toEqual([403, 'TARGET_NOT_ELIGIBLE']);
    // Owner anywhere; both the old and the new owner are notified
    const any = await command(w.owner, foreign, 'reassign', { toUserId: w.agents[0]!.userId });
    expect(any.status).toBe(200);
    const notes = (await h.su.query<{ user_id: string; kind: string }>("SELECT user_id, kind FROM notifications WHERE subject_id = $1 AND kind IN ('reassigned_to_you','reassigned_away') ORDER BY kind", [foreign])).rows;
    expect(notes).toEqual([
      { user_id: outsider.userId, kind: 'reassigned_away' },
      { user_id: w.agents[0]!.userId, kind: 'reassigned_to_you' },
    ]);
    // the previous owner lost sight in the same transaction (R-PERM-7)
    expect((await call(outsider, 'GET', `/contacts/${foreign}`)).status).toBe(404);
    // every change is on the timeline with its reason
    const t = await call<{ items: { detail: string; preview: string }[] }>(w.owner, 'GET', `/contacts/${lead}/timeline`);
    expect(t.body.items.filter((i) => i.detail !== 'created').map((i) => [i.detail, i.preview])).toEqual([['reassigned', 'MANUAL_REASSIGN']]);
  });

  it('R-OWN-18: reassigning an offered lead writes offer_rescinded then assigned', async () => {
    const r = await intake(h, w);
    expect((await contactState(h, r.contactId)).ownership_state).toBe('offered');
    const res = await command<{ result: { events: { type: string }[] } }>(w.owner, r.contactId, 'reassign', { toUserId: outsider.userId });
    expect(res.status).toBe(200);
    expect(res.body.result.events.map((e) => e.type)).toEqual(['offer_rescinded', 'assigned']);
    expect((await contactState(h, r.contactId)).owner_user_id).toBe(outsider.userId);
  });

  it('R-OWN-18: an ISA hands off only their own lead, only to an agent or TL, with a note, and keeps collaborator access for 7 days', async () => {
    const lead = await ownedBy(isa);
    const noNote = await command(isa, lead, 'handoff', { toUserId: w.agents[0]!.userId });
    expect(noNote.status).toBe(422);
    const toIsa = await command(isa, lead, 'handoff', { toUserId: isa.userId, note: 'x' });
    expect([toIsa.status, toIsa.code]).toEqual([403, 'TARGET_NOT_ELIGIBLE']);
    const ok = await command(isa, lead, 'handoff', { toUserId: w.agents[0]!.userId, note: 'Pre-approved, wants tours Saturday' });
    expect(ok.status).toBe(200);
    const st = await contactState(h, lead);
    expect(st.owner_user_id).toBe(w.agents[0]!.userId);
    // the collaborator row is written by ownership.followup as the system
    await leadsWorker(h).drain();
    const collab = (await h.su.query<{ role: string; days: number }>("SELECT role, round(extract(epoch FROM expires_at - now()) / 86400) AS days FROM contact_collaborators WHERE contact_id = $1 AND user_id = $2", [lead, isa.userId])).rows;
    expect(collab.map((c) => [c.role, Number(c.days)])).toEqual([['isa', 7]]);
    // still sees the full record as a collaborator
    const view = await call<{ contact: { view: string } }>(isa, 'GET', `/contacts/${lead}`);
    expect(view.body.contact.view).toBe('full');
    // an ISA cannot hand off someone else's lead
    const other = await ownedBy(w.agents[1]!);
    expect((await command(isa, other, 'handoff', { toUserId: w.agents[0]!.userId, note: 'x' })).status).toBe(404);
  });
});

describe('close, reopen, soft delete (R-OWN-26, E62)', () => {
  it('R-OWN-26 E62: deleting a contact that holds an offer and feed items is an ownership command: closed/deleted with purge_after = +30 d, the offer and its timer cancelled, the feed item hidden by visibility', async () => {
    const r = await intake(h, w);
    const st = await contactState(h, r.contactId);
    const offeree = w.agents.find((a) => a.userId === st.offered_to_user_id)!;
    // the offeree's feed item exists (RLS: their own, contact visible)
    const feedCount = () => withTenantTx(offeree.actor(), async (tx) => (await sql<{ n: number }>`SELECT count(*)::int AS n FROM priority_feed_items WHERE contact_id = ${r.contactId}::uuid`.execute(tx)).rows[0]!.n, { db: h.database });
    expect(await feedCount()).toBe(1);
    const del = await command<{ result: { events: { type: string; reasonCode: string }[] } }>(w.owner, r.contactId, 'delete');
    expect(del.status).toBe(200);
    expect(del.body.result.events.map((e) => [e.type, e.reasonCode])).toEqual([['closed', 'SOFT_DELETED']]);
    const after = (await h.su.query<{ ownership_state: string; closed_reason: string; days: string; offer_id: string | null }>("SELECT ownership_state, closed_reason, offer_id, round(extract(epoch FROM purge_after - deleted_at) / 86400)::text AS days FROM contacts WHERE id = $1", [r.contactId])).rows[0];
    expect(after).toEqual({ ownership_state: 'closed', closed_reason: 'deleted', offer_id: null, days: '30' });
    expect((await jobs(h, w.tenantId, 'ownership.offer_expiry')).filter((j) => j.payload.contactId === r.contactId && j.status === 'pending')).toHaveLength(0);
    expect(await feedCount()).toBe(0);
    // the former offeree's stale tap: refused, and they learn nothing about the contact (no projection)
    const late = await command<{ error: { details?: { projection?: unknown } } }>(offeree, r.contactId, 'accept', { offerId: st.offer_id });
    expect([late.status, late.code, late.body.error.details?.projection]).toEqual([409, 'LEAD_STATE_CHANGED', undefined]);
    expect((await call(offeree, 'GET', `/contacts/${r.contactId}`)).status).toBe(404);
    const audit = (await h.su.query("SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'ownership.soft_delete'", [r.contactId])).rows[0].n;
    expect(audit).toBe(1);
  });

  it('R-OWN-26: an agent may delete and close only their own lead; reopening is TL/Admin/Owner and routes the lead again', async () => {
    const a = w.agents[0]!;
    const mine = await ownedBy(a);
    const theirs = await ownedBy(w.agents[1]!);
    expect((await command(a, theirs, 'close', { reason: 'not_a_lead' })).status).toBe(404);
    expect((await command(a, mine, 'close', { reason: 'not_a_lead' })).status).toBe(200);
    expect((await contactState(h, mine)).closed_reason).toBe('not_a_lead');
    // closed contacts are no longer the agent's to see or reopen
    expect((await command(a, mine, 'reopen')).status).toBe(404);
    const re = await command(w.owner, mine, 'reopen');
    expect(re.status).toBe(200);
    expect((await contactState(h, mine)).ownership_state).toBe('unassigned');
    await leadsWorker(h).drain();
    expect(['offered', 'in_pond']).toContain((await contactState(h, mine)).ownership_state);
  });
});

describe('merge (R-OWN-24)', () => {
  it('R-OWN-24: two contacts with different owners need the Owner/TL to choose (earliest owned_at preselected); the loser closes as merged, the survivor gets merged_in, the losing owner is notified', async () => {
    const x = await ownedBy(w.agents[0]!);
    const y = await ownedBy(w.agents[1]!);
    const need = await command<{ error: { details: { preselectedOwnerUserId: string } } }>(w.owner, x, 'merge', { loserId: y });
    expect([need.status, need.code]).toEqual([409, 'MERGE_OWNER_REQUIRED']);
    expect(need.body.error.details.preselectedOwnerUserId).toBe(w.agents[0]!.userId);
    const ok = await command<{ result: { events: { type: string }[] } }>(w.owner, x, 'merge', { loserId: y, ownerChoice: w.agents[1]!.userId });
    expect(ok.status).toBe(200);
    const sx = await contactState(h, x);
    const sy = (await h.su.query('SELECT ownership_state, closed_reason, merged_into_contact_id FROM contacts WHERE id = $1', [y])).rows[0];
    expect(sx.owner_user_id).toBe(w.agents[1]!.userId);
    expect(sy).toEqual({ ownership_state: 'closed', closed_reason: 'merged', merged_into_contact_id: x });
    expect((await ledger(h, x)).at(-1)!.type).toBe('merged_in');
    expect((await ledger(h, y)).at(-1)!.type).toBe('merged_away');
    const n = (await h.su.query("SELECT user_id FROM notifications WHERE subject_id = $1 AND kind = 'reassigned_away'", [x])).rows;
    expect(n).toEqual([{ user_id: w.agents[0]!.userId }]);
    // an agent cannot merge a contact they see only as an offer card
    const offer = await intake(h, w);
    const st = await contactState(h, offer.contactId);
    const offeree = w.agents.find((a) => a.userId === st.offered_to_user_id)!;
    const mine = await ownedBy(offeree);
    expect((await command(offeree, mine, 'merge', { loserId: offer.contactId })).status).toBe(404);
  });
});

// Lane perf-misses (claim contention): accept / decline / claim / release read their facts with the narrow
// read of repos/ownership.ts instead of getContact. (1) For these actions core's can() reads only the
// offer / pond / own facts: exhaustively, for every role and every combination of the six relation facts,
// the decision with the narrow facts equals the decision with all of them. (2) The narrow read returns the
// row exactly when getContact does, with the same relation values and projection, for every role and row
// variant (offered, owned, in a pond after a release, closed, absent).
describe('narrow command facts (lane perf-misses)', () => {
  it('can() for lead.accept / lead.decline / lead.claim / lead.release is decided by the offer, pond and own facts alone (every role, all 64 combinations)', async () => {
    const { can } = await import('@realty/core/foundation');
    const roles = ['owner', 'admin', 'team_lead', 'agent', 'isa', 'tc'] as const;
    const keys = ['own', 'collaborator', 'team', 'pond', 'offer', 'deal'] as const;
    const reauth = { reauthenticatedAt: 0, now: 0 } as never;
    let checked = 0;
    for (const action of ['lead.accept', 'lead.decline', 'lead.claim', 'lead.release'] as const) {
      for (const role of roles) {
        const actor = { kind: 'user', tenantId: randomUUID(), userId: randomUUID(), role, sessionId: randomUUID() } as never;
        for (let m = 0; m < 64; m++) {
          const full = Object.fromEntries(keys.map((k, i) => [k, (m & (1 << i)) !== 0])) as Record<(typeof keys)[number], boolean>;
          const narrow = { own: full.own, pond: full.pond, offer: full.offer };
          expect(can(actor, action, { ...narrow, reauth })).toEqual(can(actor, action, { ...full, reauth }));
          checked++;
        }
      }
    }
    expect(checked).toBe(4 * 6 * 64);
  });

  it('commandContact / projectionRow see exactly the rows getContact sees, with the same relations and projection (Owner, agents, Team Lead, an agent outside the team, ISA, TC; offered, owned, in a pond, closed, absent)', async () => {
    const { actorFor } = await import('../auth/sessions.js');
    const repo = await import('./repos/contacts.js');
    const narrow = await import('./repos/ownership.js');
    const { projectionFromRow } = await import('./views.js');
    const offered = (await intake(h, w)).contactId;
    const st = await contactState(h, offered);
    const offeree = [...w.agents, outsider].find((a) => a.userId === st.offered_to_user_id) ?? w.agents[0]!;
    const accepted = (await intake(h, w)).contactId;
    const acc = await contactState(h, accepted);
    const accepter = [...w.agents, outsider].find((a) => a.userId === acc.offered_to_user_id)!;
    expect((await command(accepter, accepted, 'accept', { offerId: acc.offer_id })).status).toBe(200);
    const released = (await intake(h, w)).contactId;
    const rs = await contactState(h, released);
    const releaser = [...w.agents, outsider].find((a) => a.userId === rs.offered_to_user_id)!;
    expect((await command(releaser, released, 'accept', { offerId: rs.offer_id })).status).toBe(200);
    expect((await command(releaser, released, 'release', { reason: 'not_a_fit' })).status).toBe(200);
    const own = await ownedBy(w.agents[0]!);
    const closed = await ownedBy(w.agents[1]!);
    expect((await command(w.agents[1]!, closed, 'close', { reason: 'spam' })).status).toBe(200);
    const contacts = [offered, accepted, released, own, closed, randomUUID()];
    const clients = [w.owner, ...w.agents, w.teamLead!, outsider, isa, tc, offeree];
    let visible = 0;
    for (const c of clients) {
      const actor = actorFor({ userId: c.userId!, tenantId: c.tenantId!, role: c.role!, sessionId: randomUUID() });
      for (const id of contacts) {
        const [full, n, p] = await withTenantTx(actor, async (tx) => [await repo.getContact(tx, id), await narrow.commandContact(tx, id), await narrow.projectionRow(tx, id)] as const, { db: h.database });
        expect(n === null).toBe(full === null);
        expect(p === null).toBe(full === null);
        if (!full || !n || !p) continue;
        visible++;
        expect([n.rel_own, n.rel_offer, n.rel_pond]).toEqual([full.rel_own, full.rel_offer, full.rel_pond]);
        expect(narrow.projectionOfRow(p)).toEqual(projectionFromRow(full));
        expect(narrow.projectionOfRow(n)).toEqual(projectionFromRow(full));
      }
    }
    expect(visible).toBeGreaterThan(clients.length); // the Owner sees every real contact; agents see their own
  });
});
