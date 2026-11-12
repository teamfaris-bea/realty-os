// Calls and texts to a tracking number tied to a lead source (module 22; DATA_MODEL R-TRK-1..3, E320–E325, E340,
// E348, E349, E352) through the real server and the fake telephony provider.
import { sha256Hex } from '@realty/core/compliance';
import { addressLockOrder, inquiryFingerprint } from '@realty/core/ownership';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { identifiersOf, intakeLockKeys } from '../leads/intake.js';
import { contactState, importedUnassigned, intake, postIntake } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { type CommsWorld, call, commsWorld, freshReauth, inboundSms, ownedContact, randomPhone, sid, telephonyWebhook } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let yard: { id: string; token: string };
let tracking: { id: string; e164: string };

const ring = (from: string, to: string, callSid = sid('CA')) => telephonyWebhook(h, '/webhooks/telephony/voice', { CallSid: callSid, From: from, To: to, CallStatus: 'ringing', Direction: 'inbound' });
const contactsOn = async (phone: string) => (await h.su.query<{ contact_id: string }>('SELECT DISTINCT contact_id FROM contact_points WHERE tenant_id = $1 AND address = $2', [w.tenantId, phone])).rows.map((r) => r.contact_id);
const inquiriesOf = async (contactId: string) => (await h.su.query<{ lead_source_id: string; outcome: string; consent_disclosure_id: string | null; source_detail: Record<string, unknown>; external_id: string }>('SELECT lead_source_id, outcome, consent_disclosure_id, source_detail, external_id FROM lead_inquiries WHERE contact_id = $1 ORDER BY received_at', [contactId])).rows;

beforeAll(async () => {
  h = await createApiHarness();
  // no catch-all rule: a lead the source's rule does not take goes to the default pond
  w = await commsWorld(h, { rule: false, agents: 2 });
  await freshReauth(h, w.owner);
  const src = await call<{ source: { id: string }; ingestToken: string }>(w.owner, 'POST', '/lead-sources', { name: 'Yard sign', kind: 'sign_call', consentDisclosure: { text: 'Yard sign consent text.', namesSeller: 'The team' } });
  yard = { id: src.body.source.id, token: src.body.ingestToken };
  const n = await call<{ number: { id: string; e164: string; leadSourceId: string | null } }>(w.owner, 'POST', '/numbers', { purpose: 'tracking', areaCode: '415', leadSourceId: yard.id });
  expect(n.status).toBe(201);
  expect(n.body.number.leadSourceId).toBe(yard.id);
  tracking = n.body.number;
  const rule = await call<{ rule: { id: string } }>(w.owner, 'POST', '/routing-rules', { name: 'Yard sign leads', strategy: 'direct', directUserId: w.agents[0]!.userId, match: { sources: [yard.id] } });
  expect(rule.status).toBe(201);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('R-TRK-2 an unknown caller or texter on a tracked number becomes a lead', () => {
  it('R-TRK-2 E320: a new caller: a contact credited to the source, offered by its rule, no 60-second reply, no cited text or grant; the call stored as today', async () => {
    const from = randomPhone();
    const callSid = sid('CA');
    expect((await ring(from, tracking.e164, callSid)).statusCode).toBe(200);
    const [contactId] = await contactsOn(from);
    expect(contactId).toBeDefined();
    const c = (await h.su.query('SELECT display_name, original_lead_source_id, pond_summary FROM contacts WHERE id = $1', [contactId])).rows[0]!;
    expect(c).toMatchObject({ original_lead_source_id: yard.id, pond_summary: 'Called in' });
    expect(c.display_name).toMatch(/^Unknown \(415\)/);
    const st = await contactState(h, contactId!);
    expect([st.ownership_state, st.offered_to_user_id]).toEqual(['offered', w.agents[0]!.userId]);
    const inq = await inquiriesOf(contactId!);
    expect(inq).toEqual([{ lead_source_id: yard.id, outcome: 'new_contact', consent_disclosure_id: null, source_detail: { channel: 'tracking_number', via: 'call', phone_number_id: tracking.id }, external_id: `tracking:call:${callSid}` }]);
    expect((await h.su.query("SELECT count(*)::int AS n FROM jobs WHERE tenant_id = $1 AND kind = 'assistant.first_response' AND payload->>'contactId' = $2", [w.tenantId, contactId])).rows[0]!.n).toBe(0);
    expect((await h.su.query("SELECT count(*)::int AS n FROM consent_events WHERE contact_id = $1 AND event_type = 'grant'", [contactId])).rows[0]!.n).toBe(0);
    expect((await h.su.query("SELECT label, is_primary FROM contact_points WHERE contact_id = $1 AND kind = 'phone'", [contactId])).rows).toEqual([{ label: 'mobile', is_primary: true }]);
    expect((await h.su.query('SELECT phone_number_id, contact_id FROM calls WHERE provider_call_ref = $1', [callSid])).rows).toEqual([{ phone_number_id: tracking.id, contact_id: contactId }]);
    // the ownership command setting is cleared afterwards (the transaction wrote the call row as the plain system)
    expect((await h.su.query("SELECT count(*)::int AS n FROM lead_ownership_events WHERE contact_id = $1", [contactId])).rows[0]!.n).toBe(2);
  });

  it('R-TRK-2 R-CONSENT-4: a new texter: a lead; the first-text informational grant is the only grant (no grant citing a text)', async () => {
    const from = randomPhone();
    expect((await inboundSms(h, from, tracking.e164, 'Is the house on Oak for sale?')).statusCode).toBe(200);
    const [contactId] = await contactsOn(from);
    expect((await inquiriesOf(contactId!))[0]).toMatchObject({ lead_source_id: yard.id, outcome: 'new_contact', consent_disclosure_id: null });
    const grants = (await h.su.query("SELECT source, disclosure_id FROM consent_events WHERE contact_id = $1 AND event_type = 'grant'", [contactId])).rows;
    expect(grants).toEqual([{ source: 'inbound_first_contact', disclosure_id: null }]);
  });

  it('R-TRK-2 R-CONSENT-1 E340: a first text STOP from a new number: a lead with no grant, the opt-out recorded as for any unknown texter', async () => {
    const from = randomPhone();
    expect((await inboundSms(h, from, tracking.e164, 'STOP')).statusCode).toBe(200);
    const [contactId] = await contactsOn(from);
    expect((await inquiriesOf(contactId!))).toHaveLength(1);
    const evs = (await h.su.query('SELECT event_type, source FROM consent_events WHERE contact_id = $1 ORDER BY occurred_at', [contactId])).rows.map((r) => r.event_type);
    expect(evs).not.toContain('grant');
    expect(evs).toContain('revoke');
    // the same STOP to an untracked number gives the same opt-out and the same replies
    const other = randomPhone();
    await inboundSms(h, other, w.mainNumber, 'STOP');
    const [otherId] = await contactsOn(other);
    const outbound = async (id: string) => (await h.su.query("SELECT count(*)::int AS n FROM messages WHERE contact_id = $1 AND direction = 'outbound'", [id])).rows[0]!.n;
    expect(await outbound(contactId!)).toBe(await outbound(otherId!));
  });
});

describe('R-TRK-3 a known person on a tracked number', () => {
  it('R-TRK-3 E321: an owned client\'s text and an offered lead\'s call are only threaded: no inquiry, owner unchanged', async () => {
    const c = await ownedContact(w.agents[1]!);
    expect((await inboundSms(h, c.phone, tracking.e164, 'Hi, quick question')).statusCode).toBe(200);
    expect(await inquiriesOf(c.id)).toEqual([]);
    expect((await contactState(h, c.id)).owner_user_id).toBe(w.agents[1]!.userId);
    const from = randomPhone();
    await ring(from, tracking.e164);
    const [offered] = await contactsOn(from);
    await ring(from, tracking.e164);
    expect(await inquiriesOf(offered!)).toHaveLength(1);
  });

  it('R-TRK-3 R-OWN-20 E348: a pond person\'s call is one inquiry from the source, routed once; an import-unassigned person with no route due is routed', async () => {
    const pond = await intake(h, w, { inquiryType: 'sell', fullName: 'Pond Person', phones: [randomPhone()] });
    expect((await contactState(h, pond.contactId)).ownership_state).toBe('in_pond');
    const phone = (await h.su.query("SELECT address FROM contact_points WHERE contact_id = $1 AND kind = 'phone'", [pond.contactId])).rows[0]!.address as string;
    expect((await ring(phone, tracking.e164)).statusCode).toBe(200);
    const inq = await inquiriesOf(pond.contactId);
    expect(inq.map((i) => [i.lead_source_id, i.outcome])).toEqual([[w.sourceId, 'new_contact'], [yard.id, 'reinquiry']]);
    expect(await contactsOn(phone)).toEqual([pond.contactId]); // the intake attached to the contact in `sharing`
    expect((await contactState(h, pond.contactId)).offered_to_user_id).toBe(w.agents[0]!.userId);

    const imported = randomPhone();
    const id = await importedUnassigned(h, w.tenantId, { firstName: 'Ima', lastName: 'Ported', phones: [imported] });
    expect((await ring(imported, tracking.e164)).statusCode).toBe(200);
    expect((await inquiriesOf(id)).map((i) => i.outcome)).toEqual(['reinquiry']);
    expect((await contactState(h, id)).ownership_state).toBe('offered');
  });

  it('R-TRK-3 R-CONSENT-1 E349: a pond person who texts STOP, opt-out language or a wrong-number reply is no inquiry', async () => {
    for (const body of ['STOP', 'please stop texting me', 'wrong number']) {
      const pond = await intake(h, w, { inquiryType: 'sell', fullName: `Quiet ${body.length}`, phones: [randomPhone()] });
      const phone = (await h.su.query("SELECT address FROM contact_points WHERE contact_id = $1 AND kind = 'phone'", [pond.contactId])).rows[0]!.address as string;
      expect((await inboundSms(h, phone, tracking.e164, body)).statusCode).toBe(200);
      expect((await inquiriesOf(pond.contactId)).map((i) => i.lead_source_id), body).toEqual([w.sourceId]);
      expect((await contactState(h, pond.contactId)).ownership_state, body).toBe('in_pond');
    }
  });

  it('R-TRK-3 E322: an untied number, an off source and a released number keep today\'s path', async () => {
    const a = randomPhone();
    await ring(a, w.mainNumber);
    const [ca] = await contactsOn(a);
    expect((await h.su.query('SELECT original_lead_source_id FROM contacts WHERE id = $1', [ca])).rows[0]!.original_lead_source_id).toBeNull();
    expect(await inquiriesOf(ca!)).toEqual([]);

    await freshReauth(h, w.owner);
    await call(w.owner, 'POST', `/lead-sources/${yard.id}/off`);
    const b = randomPhone();
    await ring(b, tracking.e164);
    const [cb] = await contactsOn(b);
    expect(await inquiriesOf(cb!)).toEqual([]);
    expect((await h.su.query('SELECT display_name FROM contacts WHERE id = $1', [cb])).rows[0]!.display_name).toMatch(/^Unknown/);
    await call(w.owner, 'POST', `/lead-sources/${yard.id}/on`);
  });
});

describe('R-TRK-1 tying a number to a source', () => {
  it('R-TRK-1 E325: only a live tracking number takes a source (API and the DB CHECK)', async () => {
    await freshReauth(h, w.owner);
    const r = await call(w.owner, 'PATCH', `/numbers/${w.mainNumberId}/lead-source`, { leadSourceId: yard.id });
    expect([r.status, r.code]).toEqual([422, 'NUMBER_NOT_TRACKING']);
    const b = await call(w.owner, 'POST', '/numbers', { purpose: 'team_main', leadSourceId: yard.id });
    expect([b.status, b.code]).toEqual([422, 'VALIDATION_FAILED']);
    await expect(h.su.query('UPDATE phone_numbers SET lead_source_id = $2 WHERE id = $1', [w.mainNumberId, yard.id])).rejects.toThrow(/phone_numbers_lead_source_tracking/);
    // tie, move and untie: audited with from/to
    const untie = await call<{ number: { leadSourceId: string | null } }>(w.owner, 'PATCH', `/numbers/${tracking.id}/lead-source`, { leadSourceId: null });
    expect(untie.body.number.leadSourceId).toBeNull();
    expect((await call(w.owner, 'PATCH', `/numbers/${tracking.id}/lead-source`, { leadSourceId: yard.id })).status).toBe(200);
    const aud = (await h.su.query("SELECT changes FROM audit_log WHERE entity_id = $1 AND action = 'number.lead_source_changed' ORDER BY occurred_at", [tracking.id])).rows;
    expect(aud).toHaveLength(2);
  });

  it('R-TRK-1 E352: the source turned off between the check and the insert: the number is bought and saved untied, and the answer says so', async () => {
    const s = await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Flyer', kind: 'other' });
    const fake = h.providers.telephony;
    const original = fake.purchaseNumber.bind(fake);
    fake.purchaseNumber = async (...args: Parameters<typeof original>) => {
      await h.su.query('UPDATE lead_sources SET active = false WHERE id = $1', [s.body.source.id]);
      return original(...args);
    };
    try {
      await freshReauth(h, w.owner);
      const r = await call<{ number: { id: string; leadSourceId: string | null }; notice?: string }>(w.owner, 'POST', '/numbers', { purpose: 'tracking', areaCode: '415', leadSourceId: s.body.source.id });
      expect(r.status).toBe(201);
      expect(r.body.number.leadSourceId).toBeNull();
      expect(r.body.notice).toBe('Bought, but not tied to Flyer: that source was turned off.');
      expect((await h.su.query("SELECT count(*)::int AS n FROM audit_log WHERE entity_id = $1 AND action = 'number.acquired'", [r.body.number.id])).rows[0]!.n).toBe(1);
    } finally {
      fake.purchaseNumber = original;
    }
    const off = await call(w.owner, 'POST', '/numbers', { purpose: 'tracking', leadSourceId: s.body.source.id });
    expect([off.status, off.code]).toEqual([409, 'LEAD_SOURCE_OFF']);
  });
});

describe('concurrency (R-TRK-2, R-OWN-25)', () => {
  it('R-TRK-2 E323 E118: a call and a text from one new number at once: one contact, one inquiry', async () => {
    const from = randomPhone();
    const [a, b] = await Promise.all([ring(from, tracking.e164), inboundSms(h, from, tracking.e164, 'Hello?')]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    const ids = await contactsOn(from);
    expect(ids).toHaveLength(1);
    expect(await inquiriesOf(ids[0]!)).toHaveLength(1);
  });

  it('R-TRK-2 E324: a tracked call racing a signed webhook lead with the same phone and source: no deadlock, one contact', async () => {
    for (let i = 0; i < 3; i++) {
      const from = randomPhone();
      const [a, b] = await Promise.all([ring(from, tracking.e164), postIntake(h, yard.token, { fullName: 'Web Lead', phones: [from], inquiryType: 'buy' })]);
      expect(a.statusCode).toBe(200);
      expect([200, 201]).toContain(b.statusCode);
      expect(await contactsOn(from)).toHaveLength(1);
    }
  });

  it('R-TRK-2: intakeLockKeys is exactly the lock set the intake takes (identifier HMACs, fingerprint, external key)', async () => {
    const from = randomPhone();
    const input = { leadSourceId: yard.id, externalId: 'tracking:call:CAx', phones: [from], inquiryType: 'general' as const };
    const keys = await withTenantTx(systemActor(w.tenantId, 'provider'), async (tx) => {
      const ids = await identifiersOf(tx, h.app.platform.envelope, w.tenantId as never, [from], []);
      const person = { phoneHmacs: ids.phones.map((p) => p.hmac), emailHmacs: [], displayName: null, postalCode: null };
      const expected = [...addressLockOrder(person), inquiryFingerprint({ leadSourceId: yard.id as never, identifierHmacs: person.phoneHmacs, inquiryType: 'general' }), sha256Hex(`intake.external:${yard.id}:tracking:call:CAx`)];
      return { got: await intakeLockKeys(tx, h.app.platform.envelope, w.tenantId as never, input), expected };
    }, { db: h.database });
    expect(keys.got).toEqual(keys.expected);
  });
});

