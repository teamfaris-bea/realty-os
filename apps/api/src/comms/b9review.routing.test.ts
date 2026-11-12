// Batch 9 interaction review, group comms/routing/opt-outs: tracked numbers (R-TRK-3) meeting MMS text parts
// (R-TWL-11), shared phones, the pond card and a source turned off mid-delivery. Real Postgres, fake telephony.
//   sends/F2 (= db-public/B9-DB-1, ownership-data/F1, ui/F2)  E595 with the opt-out only in a text part
//   ownership-data/F2  shared phone: the tracked inquiry lands on the contact the call was threaded on
//   ownership-data/F5  a source turned off while a tracked text waits on its lock: stored, never lost
//   ownership-data/F6  a tracked call keeps a pond person's card summary
import { randomBytes } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { identifiersOf } from '../leads/intake.js';
import { command, contactState, intake } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { readTextParts } from './mmsTextJob.js';
import { type CommsWorld, call, commsWorld, freshReauth, inboundSms, ownedContact, randomPhone, sendText, sid, telephonyWebhook } from './testing.js';

let h: ApiHarness;
let w: CommsWorld;
let yard: { id: string };
let tracking: { id: string; e164: string };

const hex32 = () => randomBytes(16).toString('hex');
const utf8 = (s: string) => new Uint8Array(Buffer.from(s, 'utf8'));
const ring = (from: string, to: string) => telephonyWebhook(h, '/webhooks/telephony/voice', { CallSid: sid('CA'), From: from, To: to, CallStatus: 'ringing', Direction: 'inbound' });
const inquiriesOf = async (contactId: string) => (await h.su.query<{ lead_source_id: string; outcome: string }>('SELECT lead_source_id, outcome FROM lead_inquiries WHERE contact_id = $1 ORDER BY received_at', [contactId])).rows.map((r) => [r.lead_source_id, r.outcome]);
const phoneOf = async (contactId: string) => (await h.su.query("SELECT address FROM contact_points WHERE contact_id = $1 AND kind = 'phone'", [contactId])).rows[0]!.address as string;

/** An inbound MMS whose text sits in text/plain parts the fake serves by SID ('missing' = unreadable). */
async function mms(from: string, to: string, body: string, parts: (string | 'missing')[]) {
  const mm = `MM${hex32()}`;
  const form: Record<string, string> = { MessageSid: mm, From: from, To: to, Body: body, NumMedia: String(parts.length) };
  parts.forEach((p, i) => {
    const me = `ME${hex32()}`;
    form[`MediaUrl${i}`] = `https://api.twilio.com/2010-04-01/Accounts/AC${'1'.repeat(32)}/Messages/${mm}/Media/${me}`;
    form[`MediaContentType${i}`] = 'text/plain';
    h.providers.telephony.media.set(me, p === 'missing' ? 'missing' : { bytes: utf8(p), contentType: 'text/plain' });
  });
  const r = await telephonyWebhook(h, '/webhooks/telephony/sms', form);
  expect(r.statusCode).toBe(200);
  return (await h.su.query<{ id: string }>('SELECT id FROM messages WHERE provider_message_ref = $1', [mm])).rows[0]!.id;
}
async function runPartJob(messageId: string) {
  const j = (await h.su.query<{ payload: { messageRef: string; parts: { position: number; ref: string | null }[]; trackedInquiry?: unknown } }>("SELECT payload FROM jobs WHERE kind = 'comms.mms_text' AND payload->>'messageId' = $1", [messageId])).rows[0]!.payload;
  return readTextParts(systemActor(w.tenantId, 'provider'), { messageId, ...j } as never, w.deps);
}
async function pondPerson(extra: Record<string, unknown> = {}) {
  const p = await intake(h, w, { inquiryType: 'sell', fullName: 'Pond Person', phones: [randomPhone()], ...extra });
  expect((await contactState(h, p.contactId)).ownership_state).toBe('in_pond');
  return { id: p.contactId, phone: await phoneOf(p.contactId) };
}

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { rule: false, agents: 2 });
  await freshReauth(h, w.owner);
  const src = await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Yard sign', kind: 'sign_call', consentDisclosure: { text: 'Yard sign consent text.', namesSeller: 'The team' } });
  yard = { id: src.body.source.id };
  const n = await call<{ number: { id: string; e164: string } }>(w.owner, 'POST', '/numbers', { purpose: 'tracking', areaCode: '415', leadSourceId: yard.id });
  expect(n.status).toBe(201);
  tracking = n.body.number;
  expect((await call(w.owner, 'POST', '/routing-rules', { name: 'Yard sign leads', strategy: 'direct', directUserId: w.agents[0]!.userId, match: { sources: [yard.id] } })).status).toBe(201);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('b9 comms sends/F2: text parts on a tracked number (R-TRK-3, R-TWL-11, E595)', () => {
  it('b9 comms sends/F2 (db-public/B9-DB-1, ownership-data/F1, ui/F2) R-TRK-3 E595: a pond person\'s MMS with STOP, opt-out language or a wrong-number reply only in a part makes no inquiry and no routing, before or after the job', async () => {
    for (const text of ['STOP', 'please stop texting me', 'wrong number']) {
      const p = await pondPerson();
      const messageId = await mms(p.phone, tracking.e164, '', [text]);
      expect(await inquiriesOf(p.id), text).toEqual([[w.sourceId, 'new_contact']]);
      expect((await contactState(h, p.id)).ownership_state, text).toBe('in_pond');
      const r = await runPartJob(messageId);
      expect(r.revoked, text).toHaveLength(1);
      expect(await inquiriesOf(p.id), text).toEqual([[w.sourceId, 'new_contact']]);
      expect((await contactState(h, p.id)).ownership_state, text).toBe('in_pond');
    }
  });

  it('b9 comms sends/F2 R-TRK-3 R-OWN-20: a harmless part makes ONE inquiry, after the job has read every part (a re-run adds none)', async () => {
    const p = await pondPerson();
    const messageId = await mms(p.phone, tracking.e164, '', ['Is the house on Elm still for sale?']);
    expect(await inquiriesOf(p.id)).toEqual([[w.sourceId, 'new_contact']]); // not at ingestion
    expect(await runPartJob(messageId)).toMatchObject({ read: 1, skipped: 0, revoked: [] });
    expect(await inquiriesOf(p.id)).toEqual([[w.sourceId, 'new_contact'], [yard.id, 'reinquiry']]);
    expect((await contactState(h, p.id)).offered_to_user_id).toBe(w.agents[0]!.userId);
    await runPartJob(messageId);
    expect(await inquiriesOf(p.id)).toHaveLength(2);
  });

  it('b9 comms sends/F2 R-TRK-3 E387: a part that could not be read makes no inquiry, and the handler\'s notice says so', async () => {
    const p = await pondPerson();
    const messageId = await mms(p.phone, tracking.e164, '', ['missing']);
    expect(await runPartJob(messageId)).toMatchObject({ skipped: 1 });
    expect(await inquiriesOf(p.id)).toEqual([[w.sourceId, 'new_contact']]);
    expect((await contactState(h, p.id)).ownership_state).toBe('in_pond');
    const n = (await h.su.query<{ body: string | null }>('SELECT body FROM notifications WHERE dedupe_key = $1', [`text_part_unreadable:${messageId}`])).rows;
    expect(n).toHaveLength(1);
    expect(n[0]!.body).toMatch(/tracking number/i);
    expect(n[0]!.body).toMatch(/not counted as a new inquiry/i);
  });

  it('b9 comms sends/F2: an owned client\'s MMS on a tracked number is only threaded (no deferred inquiry either)', async () => {
    const c = await ownedContact(w.agents[1]!);
    const messageId = await mms(c.phone, tracking.e164, '', ['Quick question about Saturday']);
    await runPartJob(messageId);
    expect(await inquiriesOf(c.id)).toEqual([]);
    expect((await contactState(h, c.id)).owner_user_id).toBe(w.agents[1]!.userId);
  });
});

describe('b9 comms ownership-data/F2: a shared phone on a tracked number', () => {
  it('b9 comms ownership-data/F2 R-TRK-3 R-OWN-20 Q-LI-2: the tracked inquiry goes to the contact the call was threaded on (the pond record), never to the owned record sharing the phone', async () => {
    const a = await ownedContact(w.agents[0]!, { firstName: 'Ann' });
    const b = await ownedContact(w.agents[1]!, { firstName: 'Ben', phone: a.phone, confirmDistinct: true });
    expect((await sendText(w.agents[1]!, b.id, 'Checking in')).body.result).toBe('sent');
    expect((await command(w.agents[1]!, b.id, 'release', { reason: 'not_a_fit' })).status).toBe(200);
    expect((await contactState(h, b.id)).ownership_state).toBe('in_pond');
    expect((await ring(a.phone, tracking.e164)).statusCode).toBe(200);
    const threaded = (await h.su.query("SELECT contact_id FROM calls WHERE client_address = $1 AND direction = 'inbound' ORDER BY started_at DESC LIMIT 1", [a.phone])).rows[0]!.contact_id;
    expect(threaded).toBe(b.id);
    expect(await inquiriesOf(a.id)).toEqual([]);
    expect(await inquiriesOf(b.id)).toEqual([[yard.id, 'reinquiry']]);
    expect((await contactState(h, a.id)).owner_user_id).toBe(w.agents[0]!.userId);
    expect((await contactState(h, b.id)).ownership_state).toBe('offered');
  });
});

describe('b9 comms ownership-data/F6: the pond card', () => {
  it('b9 comms ownership-data/F6 R-PERM-6 R-TRK-3: a tracked call keeps a pond person\'s card summary (it carries no structured facts)', async () => {
    const p = await pondPerson({ postalCode: '29401', priceMinCents: 40_000_000, priceMaxCents: 50_000_000 });
    const before = (await h.su.query('SELECT pond_summary FROM contacts WHERE id = $1', [p.id])).rows[0]!.pond_summary as string;
    expect(before).toMatch(/29401/);
    expect((await ring(p.phone, tracking.e164)).statusCode).toBe(200);
    expect((await contactState(h, p.id)).ownership_state).toBe('offered');
    expect((await h.su.query('SELECT pond_summary FROM contacts WHERE id = $1', [p.id])).rows[0]!.pond_summary).toBe(before);
  });
});

describe('b9 comms ownership-data/F5: a source turned off while a tracked text waits on its lock', () => {
  it('b9 comms ownership-data/F5 R-TRK-3 R-LSRC-2: the text is stored (threaded, no inquiry), never answered 404 and lost', async () => {
    const s = await call<{ source: { id: string } }>(w.owner, 'POST', '/lead-sources', { name: 'Flyer', kind: 'other' });
    await freshReauth(h, w.owner);
    const n = await call<{ number: { id: string; e164: string } }>(w.owner, 'POST', '/numbers', { purpose: 'tracking', areaCode: '415', leadSourceId: s.body.source.id });
    const from = randomPhone();
    const hmac = await withTenantTx(systemActor(w.tenantId, 'provider'), async (tx) => (await identifiersOf(tx, w.deps.envelope, w.tenantId as never, [from], [])).phones[0]!.hmac, { db: w.deps.db });
    const holder = await h.su.connect();
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT set_config('app.tenant_id', $1, true)", [w.tenantId]);
      await holder.query("SELECT app.lock_address(decode($1, 'hex'))", [hmac]);
      const msgSid = sid();
      const pending = inboundSms(h, from, n.body.number.e164, 'Is the flyer house still available?', msgSid);
      await new Promise((r) => setTimeout(r, 400));
      // the Owner turns the source off while the text waits (with the fix, this waits for the text's transaction only
      // if the text already read the source under its lock; here the text is still waiting on the address lock)
      const off = h.su.query('UPDATE lead_sources SET active = false WHERE id = $1', [s.body.source.id]);
      await new Promise((r) => setTimeout(r, 300));
      await holder.query('COMMIT');
      const [res] = await Promise.all([pending, off]);
      expect(res.statusCode).toBe(200);
      const stored = (await h.su.query<{ contact_id: string }>('SELECT contact_id FROM messages WHERE provider_message_ref = $1', [msgSid])).rows;
      expect(stored).toHaveLength(1);
      expect(await inquiriesOf(stored[0]!.contact_id)).toEqual([]);
    } finally {
      holder.release();
    }
  });
});
