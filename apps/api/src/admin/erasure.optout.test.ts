// A person's do-not-contact outlives the person (D1; R-DATA-4, R-DATA-5, R-CHAN-2 E140; migration 0037 §2b).
//
// The person-level do-not-contact is a column of the person's rows. POST /contacts/:id/do-not-contact revokes only the
// points the record had then, and a merge copies only the flag onto the survivor, so the survivor's own phone and
// email, and a point added later, had no revoke in the HMAC-keyed ledger, which is all an erasure or a purge keeps.
// Before the fix a review probe erased (or soft-deleted and swept) such a survivor and texted a contact re-created
// with the survivor's phone: 'sent'. Now the erase route and the worker's pass before the sweep carry the
// do-not-contact onto every address first, and the database refuses the deletion while one is missing. Real Postgres
// as app_user through the real server and worker code, fake providers.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, call, commsWorld, ownedContact, randomPhone, sendText } from '../comms/testing.js';
import { command, suFixture } from '../leads/testing.js';
import { createMaintenance } from '../worker/maintenance.js';
import { memoryAlerts, memoryLogger } from '../worker/observability.js';
import { HandlerRegistry } from '../worker/registry.js';
import { optOutCarryDue, retentionSweep } from '../worker/repos/jobs.js';
import { auditRows, freshReauth } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let owner: TestClient;
let agent: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 1, rule: false });
  owner = w.owner;
  agent = w.agents[0]!;
  // the dialer needs the agent's verified alert phone before it gates a call
  const ch = await agent.post('/api/me/alert-phone', { phone: randomPhone() });
  const code = h.providers.telephony.verificationCodes.at(-1)!.code;
  const v = await agent.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code });
  expect(v.statusCode).toBe(200);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const exists = async (id: string) => (await h.su.query('SELECT 1 FROM contacts WHERE id = $1', [id])).rowCount === 1;
/** The HMAC of an address while a point carries it (hex); consent stays keyed by it after the point is gone. */
const hmacs = new Map<string, string>();
async function hmacOf(address: string): Promise<string> {
  const known = hmacs.get(address);
  if (known) return known;
  const r = await h.su.query<{ h: string }>("SELECT DISTINCT encode(address_hmac, 'hex') AS h FROM contact_points WHERE address = $1", [address]);
  expect(r.rows, address).toHaveLength(1);
  hmacs.set(address, r.rows[0]!.h);
  return r.rows[0]!.h;
}
/** consent_state revoked rows for an address, per channel and purpose. */
const revoked = async (address: string) =>
  (
    await h.su.query<{ k: string }>(
      `SELECT cs.channel || ':' || cs.purpose AS k FROM consent_state cs
        WHERE cs.status = 'revoked' AND cs.address_hmac = decode($1, 'hex') ORDER BY 1`,
      [await hmacOf(address)],
    )
  ).rows.map((r) => r.k);
const ALL_PHONE = ['sms:informational', 'sms:marketing', 'voice:informational', 'voice:marketing'];
const ALL_EMAIL = ['email:informational', 'email:marketing'];
const sendEmail = (contactId: string) =>
  call<{ result: string; decision: { reasons: string[] } | null }>(agent, 'POST', `/contacts/${contactId}/messages`, { channel: 'email', subject: 'Hello', body: 'Checking in.', idempotencyKey: `e-${randomUUID()}` });
const dial = (contactId: string) => call<{ result: string; decision: { outcome: string; reasons: string[] } }>(agent, 'POST', `/contacts/${contactId}/calls`, {});
const smsTo = (phone: string) => h.providers.telephony.sms.filter((m) => m.to === phone).length;
const callsTo = (phone: string) => h.providers.telephony.calls.filter((c) => c.to === phone).length;

/**
 * The review's case: duplicate L asks not to be contacted (its own phone and email are revoked), then is merged into
 * survivor S; afterwards S gets another phone. S's own phone and email and the later phone have no revoke: only the
 * flag the merge copied onto S blocks them.
 */
async function survivorOfAskingDuplicate(): Promise<{ survivor: { id: string; phone: string; email: string }; later: string; dupPhone: string }> {
  const s = await ownedContact(agent, { consent: false });
  const l = await ownedContact(agent, { consent: false });
  expect((await call(agent, 'POST', `/contacts/${l.id}/do-not-contact`, { reason: 'asked_on_call' })).status).toBe(200);
  const m = await command(agent, s.id, 'merge', { loserId: l.id });
  expect(m.status, JSON.stringify(m.body)).toBe(200);
  const later = randomPhone();
  expect((await call(agent, 'POST', `/contacts/${s.id}/points`, { kind: 'phone', address: later })).status).toBe(201);
  // the facts behind the finding: nothing in the ledger for S's own phone and email or the later phone
  expect([await revoked(s.phone), await revoked(s.email), await revoked(later)]).toEqual([[], [], []]);
  expect(await revoked(l.phone)).toEqual(ALL_PHONE);
  expect((await sendText(agent, s.id, 'Hi')).body).toMatchObject({ result: 'blocked', decision: { reasons: expect.arrayContaining(['PERSON_DO_NOT_CONTACT']) } });
  return { survivor: s, later, dupPhone: l.phone };
}

/** A contact re-created with `phone` (or an email) after the person is gone is still not texted, emailed or called. */
async function expectStillBlocked(o: { phone?: string; email?: string }): Promise<void> {
  const again = await ownedContact(agent, { consent: false, ...(o.phone ? { phone: o.phone } : {}), ...(o.email ? { email: o.email } : {}) });
  if (o.phone) {
    expect((await sendText(agent, again.id, 'Hello again')).body, o.phone).toMatchObject({ result: 'blocked', decision: { reasons: ['CONSENT_REVOKED'] } });
    expect((await dial(again.id)).body, o.phone).toMatchObject({ result: 'gate', decision: { outcome: 'deny', reasons: ['CONSENT_REVOKED'] } });
    expect([smsTo(o.phone), callsTo(o.phone)]).toEqual([0, 0]);
  }
  if (o.email) {
    // this tenant's email sender is not set up either (domain, postal address): the opt-out is the reason that matters
    expect((await sendEmail(again.id)).body.decision?.reasons, o.email).toContain('CONSENT_REVOKED');
    const control = await ownedContact(agent, { consent: false });
    expect((await sendEmail(control.id)).body.decision?.reasons).not.toContain('CONSENT_REVOKED');
  }
}

describe('D1: a person-level do-not-contact outlives the person (migration 0037 §2b)', () => {
  it('D1 R-DATA-4 R-CHAN-2 E140: erasing the survivor of a duplicate that asked not to be contacted first carries the do-not-contact onto the survivor’s own phone and email and onto a phone added later (as the Owner, citing the do-not-contact, audited); contacts re-created with any of them stay blocked: texts, calls and email, with nothing reaching the fake providers', async () => {
    const p = await survivorOfAskingDuplicate();
    const email = p.survivor.email;
    const dnc = (await h.su.query<{ e: string }>('SELECT do_not_contact_event_id AS e FROM contacts WHERE id = $1', [p.survivor.id])).rows[0]!.e;
    await freshReauth(h, owner);
    const r = await call(owner, 'POST', `/contacts/${p.survivor.id}/erase`, { reason: 'PRIVACY_REQUEST' });
    expect([r.status, r.body]).toEqual([200, { erased: true }]);
    expect(await exists(p.survivor.id)).toBe(false);
    for (const phone of [p.survivor.phone, p.later, p.dupPhone]) expect(await revoked(phone), phone).toEqual(ALL_PHONE);
    expect(await revoked(email)).toEqual(ALL_EMAIL);
    // the carried revokes: staff (the Owner), every purpose, citing the person-level do-not-contact (ids only)
    const carried = (
      await h.su.query<{ channel: string; purpose: string; source: string; actor_user_id: string; evidence: Record<string, unknown>; contact_id: string }>(
        `SELECT channel, purpose, source, actor_user_id, evidence, contact_id FROM consent_events
          WHERE tenant_id = $1 AND evidence ->> 'carries_do_not_contact_event_id' = $2 ORDER BY channel`,
        [w.tenantId, dnc],
      )
    ).rows;
    // S's own phone (sms, voice) and email, and the later phone (sms, voice); L's were revoked when L asked
    expect(carried.map((c) => c.channel)).toEqual(['email', 'sms', 'sms', 'voice', 'voice']);
    for (const c of carried) expect(c).toMatchObject({ purpose: 'all', source: 'agent_revoke', actor_user_id: owner.userId, contact_id: p.survivor.id, evidence: { scope: 'person' } });
    const audited = (await auditRows(h, w.tenantId, 'consent.recorded')).filter((a) => a.entity_id === p.survivor.id);
    expect(audited.map((a) => [a.actor_user_id, a.reason, a.changes.revoked_count])).toEqual([[owner.userId, 'PERSON_DO_NOT_CONTACT_CARRIED', { from: null, to: 5 }]]);
    await expectStillBlocked({ phone: p.survivor.phone, email });
    await expectStillBlocked({ phone: p.later });
  });

  it('D1 R-DATA-5: a soft-deleted survivor of a duplicate that asked is skipped by the sweep until the worker carries the do-not-contact (as the system, before the sweep in the same maintenance pass); then it is purged, and contacts re-created with its own phone or the later one stay blocked', async () => {
    const p = await survivorOfAskingDuplicate();
    await freshReauth(h, owner);
    expect((await command(owner, p.survivor.id, 'delete')).status).toBe(200);
    await suFixture(h, [{ text: "UPDATE contacts SET purge_after = now() - interval '1 minute' WHERE id = $1", values: [p.survivor.id] }]);
    // the sweep alone may not drop the do-not-contact: it skips the person (and still runs for everyone else)
    await retentionSweep(h.database, Date.now() as never);
    expect(await exists(p.survivor.id)).toBe(true);
    expect((await optOutCarryDue(h.database, Date.now() as never)).map((d) => d.contactId)).toContain(p.survivor.id);

    const alerts = memoryAlerts();
    const report = await createMaintenance({ db: h.database, registry: new HandlerRegistry(), log: memoryLogger(), alerts, periodicEveryMs: Number.MAX_SAFE_INTEGER }).runOnce();
    expect(report.failedSteps).toEqual([]);
    expect(alerts.alerts).toEqual([]);
    expect(report.optOutsCarried).toBeGreaterThanOrEqual(5);
    expect(report.retention?.contacts_purged).toBeGreaterThanOrEqual(1);
    expect(await exists(p.survivor.id)).toBe(false);
    expect((await optOutCarryDue(h.database, Date.now() as never)).map((d) => d.contactId)).not.toContain(p.survivor.id);
    // recorded by the system actor (no user), citing the do-not-contact
    const actors = await h.su.query<{ actor_kind: string; n: number }>(
      `SELECT actor_kind, count(*)::int AS n FROM consent_events WHERE tenant_id = $1 AND contact_id = $2 AND evidence ? 'carries_do_not_contact_event_id' GROUP BY 1`,
      [w.tenantId, p.survivor.id],
    );
    expect(actors.rows).toEqual([{ actor_kind: 'system', n: 5 }]);
    await expectStillBlocked({ phone: p.survivor.phone });
    await expectStillBlocked({ phone: p.later });
  });

  it('D1: a person who asked themselves keeps every address blocked after erasure, a removed old phone included; a person who never asked gets no revoke from erasure', async () => {
    const asked = await ownedContact(agent, { consent: false });
    expect((await call(agent, 'POST', `/contacts/${asked.id}/do-not-contact`, {})).status).toBe(200);
    const old = randomPhone();
    expect((await call(agent, 'POST', `/contacts/${asked.id}/points`, { kind: 'phone', address: old })).status).toBe(201);
    const oldId = (await h.su.query<{ id: string }>('SELECT id FROM contact_points WHERE contact_id = $1 AND address = $2', [asked.id, old])).rows[0]!.id;
    expect((await call(agent, 'POST', `/contacts/${asked.id}/points/${oldId}/remove`, { reason: 'old' })).status).toBe(200);
    expect(await revoked(old)).toEqual([]);
    const never = await ownedContact(agent, { consent: false });
    expect(await revoked(never.phone)).toEqual([]);
    await freshReauth(h, owner);
    for (const id of [asked.id, never.id]) expect((await call(owner, 'POST', `/contacts/${id}/erase`, { reason: 'PRIVACY_REQUEST' })).status).toBe(200);
    expect(await revoked(old)).toEqual(ALL_PHONE);
    await expectStillBlocked({ phone: old });
    expect(await revoked(never.phone)).toEqual([]);
    const again = await ownedContact(agent, { phone: never.phone, consent: false });
    expect((await sendText(agent, again.id, 'Hello')).body.result).toBe('sent');
  });

  it('D1 fail closed: an address the carry cannot take (a Messenger identity, out of scope since D2) refuses the erasure with PERSON_DO_NOT_CONTACT_UNCARRIED and erases and records nothing; the worker carries the rest, alerts once, and the sweep skips that person', async () => {
    const c = await ownedContact(agent, { consent: false });
    expect((await call(agent, 'POST', `/contacts/${c.id}/do-not-contact`, {})).status).toBe(200);
    const before = Number((await h.su.query<{ n: string }>('SELECT count(*) AS n FROM consent_events WHERE tenant_id = $1', [w.tenantId])).rows[0]!.n);
    // no application path makes a Messenger point any more (D2): the superuser builds the legacy state
    await suFixture(h, [{ text: "INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac) VALUES ($1, $2, $3, 'messenger', 'fb:1:2', decode(repeat('ab', 32), 'hex'))", values: [w.tenantId, randomUUID(), c.id] }]);
    // a phone added after the do-not-contact is carried in the same transaction, and rolled back with it
    const later = randomPhone();
    expect((await call(agent, 'POST', `/contacts/${c.id}/points`, { kind: 'phone', address: later })).status).toBe(201);
    await freshReauth(h, owner);
    const r = await call(owner, 'POST', `/contacts/${c.id}/erase`, { reason: 'PRIVACY_REQUEST' });
    expect([r.status, r.code]).toEqual([409, 'PERSON_DO_NOT_CONTACT_UNCARRIED']);
    expect(await exists(c.id)).toBe(true);
    expect(Number((await h.su.query<{ n: string }>('SELECT count(*) AS n FROM consent_events WHERE tenant_id = $1', [w.tenantId])).rows[0]!.n)).toBe(before);

    expect((await command(owner, c.id, 'delete')).status).toBe(200);
    await suFixture(h, [{ text: "UPDATE contacts SET purge_after = now() - interval '1 minute' WHERE id = $1", values: [c.id] }]);
    const alerts = memoryAlerts();
    const m = createMaintenance({ db: h.database, registry: new HandlerRegistry(), log: memoryLogger(), alerts, periodicEveryMs: Number.MAX_SAFE_INTEGER, retentionEveryMs: 0 });
    const report = await m.runOnce();
    expect(report.failedSteps).toEqual([]);
    expect(await exists(c.id)).toBe(true);
    expect((await optOutCarryDue(h.database, Date.now() as never)).map((d) => d.contactId)).toContain(c.id);
    // the system carried what it could (the later phone); the Messenger identity keeps the person from being purged
    expect(await revoked(later)).toEqual(ALL_PHONE);
    expect(alerts.alerts.map((a) => [a.severity, a.code, a.tenantId, a.details])).toEqual([['P2', 'WORKER_ERROR', w.tenantId, { step: 'retention_optout_carry', contactId: c.id, error: 'PERSON_DO_NOT_CONTACT_UNCARRIED' }]]);
    // the next pass lists the person again and still does not purge them, without a second alert
    expect((await m.runOnce()).failedSteps).toEqual([]);
    expect(await exists(c.id)).toBe(true);
    expect(alerts.alerts).toHaveLength(1);
  });
});
