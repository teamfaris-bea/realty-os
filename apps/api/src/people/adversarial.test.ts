// Adversarial cases for api/people (critical module 57): tenancy, card-only sight, opt-outs on removed
// points (R-PAR-12, E168), ownership never patched, mentions never granting access, TCs and support.
import { randomUUID } from 'node:crypto';
import { mentionToken } from '@realty/core/parity/people';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, commsWorld, grantConsent, inboundSms, ownedContact, sendText } from '../comms/testing.js';
import { call, contactState, intake, leadsWorld, randomPhone } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';

let h: ApiHarness;
let w: CommsWorld;
let agent: TestClient;
let agent2: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, rule: false, others: ['tc'] });
  [agent, agent2] = w.agents as [TestClient, TestClient];
}, 180_000);
afterAll(async () => {
  await h?.close();
});

async function pointIdOf(contactId: string, address: string): Promise<string> {
  return (await h.su.query<{ id: string }>('SELECT id FROM contact_points WHERE contact_id = $1 AND address = $2', [contactId, address])).rows[0]!.id;
}

describe('adversarial: api/people', () => {
  it('R-PAR-12 R-CONSENT-7 E168 a removed phone that texted STOP keeps blocking texts to the person’s other phone: the send-time gate refuses it with a clean blocked answer and its reason (never a 500), and the DB guard refuses it with core bypassed', async () => {
    const c = await ownedContact(agent);
    expect((await inboundSms(h, c.phone, w.mainNumber, 'STOP')).statusCode).toBe(200);
    const work = randomPhone();
    expect((await call(agent, 'POST', `/contacts/${c.id}/points`, { kind: 'phone', address: work, label: 'work' })).status).toBe(201);
    const stopped = await pointIdOf(c.id, c.phone);
    // "editing" the opted-out number: remove it (old) and replace (both keep blocking)
    expect((await call(agent, 'POST', `/contacts/${c.id}/points/${stopped}/remove`, { reason: 'old' })).status).toBe(200);
    expect((await call(agent, 'POST', `/contacts/${c.id}/points/${await pointIdOf(c.id, work)}/primary`)).status).toBe(200);
    await grantConsent(agent, c.id, 'sms').catch(() => undefined);
    // The send-time gate reads the guards' own fan-out (removed phones count unless removed as a confirmed
    // wrong number), so canContact refuses up front: a blocked message with the opt-out reason and its
    // blocked-send record. Nothing reaches the provider.
    const r = await sendText(agent, c.id, 'Checking in');
    expect(r.status).toBe(200);
    expect(r.body.result).toBe('blocked');
    expect(r.body.message).toMatchObject({ status: 'blocked', statusReason: 'CONSENT_REVOKED' });
    expect(r.body.decision).toMatchObject({ id: expect.any(String), outcome: 'deny', reasons: ['CONSENT_REVOKED'], phase: 'send' });
    expect((await h.su.query('SELECT reason_codes FROM gate_decisions WHERE message_id = $1', [r.body.message!.id])).rows).toEqual([{ reason_codes: ['CONSENT_REVOKED'] }]);
    expect((await h.su.query("SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND direction = 'outbound' AND status IN ('sent','delivered','dispatching')", [c.id])).rows[0].n).toBe(0);
    expect(h.providers.telephony.sms.filter((m) => m.to === work)).toEqual([]);
    // core bypassed: a message row to the work phone, moved to dispatching by the system, is refused by the guard
    const mid = randomUUID();
    await h.su.query(
      `INSERT INTO messages (tenant_id, id, contact_id, conversation_id, channel, direction, initiator, initiated_by_user_id, purpose, action_category, body, phone_number_id, from_address, to_address, status, occurred_at)
       SELECT c.tenant_id, $2, c.id, (SELECT id FROM conversations WHERE contact_id = c.id LIMIT 1), 'sms', 'outbound', 'human', $3, 'informational', 'none', 'x', $4, $5, $6, 'queued', now()
         FROM contacts c WHERE c.id = $1`,
      [c.id, mid, agent.userId, w.mainNumberId, w.mainNumber, work],
    );
    await expect(withTenantTx(systemActor(w.tenantId, 'worker'), (tx) => sql`UPDATE messages SET status = 'dispatching', dispatched_at = now() WHERE id = ${mid}`.execute(tx), { db: h.database })).rejects.toThrow(/RECIPIENT_OPTED_OUT/);
    // the details explain the over-block with the removed number's tail only
    const d = await call<{ details: { removedPoints: { tail: string; stillBlocks: boolean }[] } }>(agent, 'GET', `/contacts/${c.id}/details`);
    expect(d.body.details.removedPoints).toEqual([expect.objectContaining({ tail: `•••${c.phone.slice(-4)}`, stillBlocks: true, optedOut: true })]);
    // a removed opted-out point cannot be "fixed" back into a clean row: re-adding restores the same HMAC row, STOP intact
    expect((await call(agent, 'POST', `/contacts/${c.id}/points`, { kind: 'phone', address: c.phone })).status).toBe(201);
    expect((await h.su.query("SELECT removed_at FROM contact_points WHERE id = $1", [stopped])).rows[0].removed_at).toBeNull();
    expect((await h.su.query("SELECT status FROM consent_state WHERE address_hmac = (SELECT address_hmac FROM contact_points WHERE id = $1) AND channel = 'sms'", [stopped])).rows.every((x) => x.status === 'revoked')).toBe(true);
  });

  it('R-PAR-12 a removal reason cannot be rewritten to wrong_number through RLS without the ledger record', async () => {
    const c = await ownedContact(agent, { consent: false });
    const pid = await pointIdOf(c.id, c.phone);
    await call(agent, 'POST', `/contacts/${c.id}/points/${pid}/remove`, { reason: 'old' });
    await expect(withTenantTx(agent.actor(), (tx) => sql`UPDATE contact_points SET removed_reason = 'wrong_number' WHERE id = ${pid}::uuid`.execute(tx), { db: h.database })).rejects.toThrow(/REMOVED_REASON/);
  });

  it('R-PERM-6 a pond card is never patched, noted, logged, linked or staged: 404 for every write', async () => {
    const lw = await leadsWorld(h, { agents: 1, rule: false });
    const lead = (await intake(h, lw)).contactId;
    expect((await contactState(h, lead)).ownership_state).toBe('in_pond');
    const a = lw.agents[0]!;
    expect((await call<{ contact: { view: string } }>(a, 'GET', `/contacts/${lead}`)).body.contact.view).toBe('card');
    const writes: [string, string, unknown][] = [
      ['PATCH', `/contacts/${lead}`, { rowVersion: 1, firstName: 'X' }],
      ['POST', `/contacts/${lead}/stage`, { stage: 'nurture' }],
      ['POST', `/contacts/${lead}/notes`, { body: 'hi' }],
      ['POST', `/contacts/${lead}/activities`, { kind: 'call', at: new Date().toISOString() }],
      ['POST', `/contacts/${lead}/points`, { kind: 'phone', address: randomPhone() }],
      ['POST', `/contacts/${lead}/addresses`, { kind: 'home', city: 'X' }],
      ['POST', `/contacts/${lead}/do-not-contact`, {}],
      ['GET', `/contacts/${lead}/details`, undefined],
      ['GET', `/contacts/${lead}/notes`, undefined],
    ];
    for (const [m, u, b] of writes) expect((await call(a, m as 'POST', u, b)).status, `${m} ${u}`).toBe(404);
  });

  it('R-TEN-3 another tenant’s contact and note ids are 404 everywhere; a tenant id in a body is refused', async () => {
    const other = await leadsWorld(h, { agents: 1, rule: false });
    const theirs = (await call<{ contact: { id: string } }>(other.agents[0]!, 'POST', '/contacts', { commandId: randomUUID(), displayName: 'Foreign', phones: [randomPhone()] })).body.contact.id;
    const note = (await call<{ note: { id: string } }>(other.agents[0]!, 'POST', `/contacts/${theirs}/notes`, { body: 'theirs' })).body.note.id;
    for (const c of [agent, w.owner]) {
      expect((await call(c, 'GET', `/contacts/${theirs}/details`)).status).toBe(404);
      expect((await call(c, 'PATCH', `/contacts/${theirs}`, { rowVersion: 1, firstName: 'X' })).status).toBe(404);
      expect((await call(c, 'PATCH', `/notes/${note}`, { body: 'x' })).status).toBe(404);
      expect((await call(c, 'DELETE', `/notes/${note}`)).status).toBe(404);
    }
    const mine = (await ownedContact(agent, { consent: false })).id;
    expect((await call(agent, 'POST', `/contacts/${mine}/relationships`, { relatedContactId: theirs, kind: 'family' })).status).toBe(404);
    expect((await call(agent, 'POST', `/contacts/${mine}/notes`, { body: 'x', tenantId: other.tenantId })).status).toBe(422);
    // a mention of another tenant's user is dropped (not a member): nobody there is told
    const r = await call<{ mentions: unknown[] }>(agent, 'POST', `/contacts/${mine}/notes`, { body: `hi ${mentionToken(other.agents[0]!.userId!, 'x')}` });
    expect(r.body.mentions).toEqual([]);
    expect((await h.su.query("SELECT count(*)::int AS n FROM notifications WHERE kind = 'mention' AND user_id = $1", [other.agents[0]!.userId])).rows[0].n).toBe(0);
  });

  it('R-PAR-43 ownership never changes through a patch, even with a crafted body, and the guard backs it up', async () => {
    const c = await ownedContact(agent, { consent: false });
    for (const body of [{ rowVersion: 1, ownerUserId: agent2.userId }, { rowVersion: 1, owner_user_id: agent2.userId }, { rowVersion: 1, ownershipState: 'in_pond' }]) {
      expect((await call(agent, 'PATCH', `/contacts/${c.id}`, body)).status).toBe(422);
    }
    await expect(withTenantTx(agent.actor(), (tx) => sql`UPDATE contacts SET owner_user_id = ${agent2.userId}::uuid WHERE id = ${c.id}::uuid`.execute(tx), { db: h.database })).rejects.toThrow(/OWNERSHIP_UNAUDITED/);
    expect((await contactState(h, c.id)).owner_user_id).toBe(agent.userId);
  });

  it('R-PAR-2 mentioning someone without access writes no notification and grants nothing; TCs edit, log and stage nothing', async () => {
    const c = await ownedContact(agent, { consent: false });
    const r = await call<{ mentions: { status: string }[] }>(agent, 'POST', `/contacts/${c.id}/notes`, { body: `see ${mentionToken(agent2.userId!, 'A')}` });
    expect(r.body.mentions).toEqual([expect.objectContaining({ status: 'no_access' })]);
    expect((await h.su.query("SELECT count(*)::int AS n FROM notifications WHERE kind = 'mention' AND user_id = $1", [agent2.userId])).rows[0].n).toBe(0);
    expect((await call(agent2, 'GET', `/contacts/${c.id}/notes`)).status).toBe(404);
    const tc = w.others[0]!;
    expect((await call(tc, 'PATCH', `/contacts/${c.id}`, { rowVersion: 1, firstName: 'X' })).status).toBe(404);
    expect((await call(tc, 'POST', `/contacts/${c.id}/activities`, { kind: 'call', at: new Date().toISOString() })).status).toBe(404);
  });

  it('R-PAR-14 the stage guard holds with the API bypassed: an agent writing the stage directly through RLS is refused', async () => {
    const lw = await leadsWorld(h, { agents: 1 });
    const lead = (await intake(h, lw)).contactId;
    const st = await contactState(h, lead);
    const a = lw.agents[0]!;
    await call(a, 'POST', `/leads/${lead}/accept`, { commandId: randomUUID(), offerId: st.offer_id });
    await expect(withTenantTx(a.actor(), (tx) => sql`UPDATE contacts SET stage = 'lost' WHERE id = ${lead}::uuid`.execute(tx), { db: h.database })).rejects.toThrow(/STAGE_NEEDS_CONTACT/);
  });
});
