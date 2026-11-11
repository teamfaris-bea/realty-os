// GET /contacts/:id/reachability (lane optout-visibility item 1). Real Postgres, the real inbound STOP,
// unsubscribe, do-not-call, bounce and staff paths; every summary is compared with what the send-time
// gate says for the same contact at the same moment (the compose preview for texts and email, and
// evaluateGate for calls), so the summary can never claim a person is reachable when a send would be
// blocked, or the reverse.
import { randomUUID } from 'node:crypto';
import { REACHABILITY_REASONS } from '@realty/core/compliance';
import { type TenantId } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { suFixture } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { evaluateGate } from './gateInput.js';
import { type CommsWorld, call, commsWorld, emailWebhook, freshReauth, inboundSms, randomEmail, randomPhone } from './testing.js';
import { EMAIL_REF_HEADER } from './render.js';

let h: ApiHarness;
let w: CommsWorld;
let tc: TestClient;

beforeAll(async () => {
  h = await createApiHarness();
  w = await commsWorld(h, { agents: 2, others: ['tc'] });
  tc = w.others[0]!;
  h.providers.email.verifiedDomains.add('mail.reach.test');
  const dom = await call<{ domain: { id: string } }>(w.owner, 'POST', '/sending-domains', { domain: 'mail.reach.test' });
  await call(w.owner, 'POST', `/sending-domains/${dom.body.domain.id}/verify`);
  for (const a of w.agents) await call(w.owner, 'POST', '/email-identities', { fromAddress: `a-${randomUUID().slice(0, 6)}@mail.reach.test`, displayName: 'Agent', userId: a.userId, domainId: dom.body.domain.id });
  await suFixture(h, [{ text: "UPDATE tenant_settings SET brokerage_postal_address = '1 Main St, Springfield' WHERE tenant_id = $1", values: [w.tenantId] }]);
});
afterAll(async () => {
  await h?.close();
});

interface Reason {
  code: string;
  source: string;
  purposes: string[];
  at: string | null;
  keyword: string | null;
  recordedBy: { userId: string; displayName: string | null } | null;
  importBatchId: string | null;
  suppressionReason: string | null;
  addressHint: string | null;
  otherAddress: boolean;
  evidence: { consentEventId: string | null; inboundMessageId: string | null; callId: string | null; suppressionId: string | null };
}
interface ChannelReach {
  hasAddress: boolean;
  defaultPointId: string | null;
  blocked: boolean;
  reasons: Reason[];
  points: { pointId: string; addressHint: string; blocked: boolean; reasons: Reason[] }[];
}
interface Reach {
  contactId: string;
  purposeNow: 'marketing' | 'informational';
  channels: { sms: ChannelReach; voice: ChannelReach; email: ChannelReach };
}

const reach = async (c: TestClient, id: string) => call<{ reachability: Reach }>(c, 'GET', `/contacts/${id}/reachability`);
const PREDICTED = new Set<string>(REACHABILITY_REASONS);

async function contactWith(agent: TestClient, phones: string[], emails: string[]): Promise<string> {
  const r = await call<{ contact: { id: string } }>(agent, 'POST', '/contacts', { commandId: randomUUID(), firstName: 'Owen', lastName: 'Price', phones, emails });
  if (r.status !== 201 && r.status !== 200) throw new Error(`contact: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.contact.id;
}

async function points(id: string): Promise<{ id: string; kind: string; address: string; hmac: string }[]> {
  return (await h.su.query("SELECT id, kind, address, encode(address_hmac, 'hex') AS hmac FROM contact_points WHERE contact_id = $1 AND removed_at IS NULL ORDER BY is_primary DESC, created_at, id", [id])).rows;
}

/** The send-time gate for the summary's default point of each channel, right now. */
async function gateReasons(agent: TestClient, contactId: string, r: Reach): Promise<Record<'sms' | 'voice' | 'email', string[]>> {
  const out = { sms: [] as string[], voice: [] as string[], email: [] as string[] };
  for (const ch of ['sms', 'email'] as const) {
    if (!r.channels[ch].hasAddress) continue;
    const p = await call<{ decision: { reasons: string[] } }>(agent, 'POST', `/contacts/${contactId}/messages/preview`, { channel: ch, body: 'Checking in about the house.', ...(ch === 'email' ? { subject: 'The house' } : {}) });
    expect(p.status).toBe(200);
    out[ch] = p.body.decision.reasons;
  }
  if (r.channels.voice.hasAddress) {
    const pt = (await points(contactId)).find((p) => p.id === r.channels.voice.defaultPointId)!;
    const d = await withTenantTx(systemActor(w.tenantId as TenantId, 'worker'), async (tx, now) =>
      evaluateGate(tx, { contactId, recipient: { kind: 'contact', addressHmac: pt.hmac, channel: 'voice', pointId: pt.id }, purpose: r.purposeNow, initiator: 'human', category: 'none', sender: { phoneNumberId: w.mainNumberId, emailIdentityId: null }, body: null }, now),
      { db: h.database },
    );
    out.voice = d.decision.reasons;
  }
  return out;
}

/** The summary agrees with the gate: the default point's reasons are exactly the gate's opt-out/point reasons. */
async function expectAgrees(agent: TestClient, contactId: string): Promise<Reach> {
  const r = (await reach(agent, contactId)).body.reachability;
  const gate = await gateReasons(agent, contactId, r);
  for (const ch of ['sms', 'voice', 'email'] as const) {
    const predicted = gate[ch].filter((x) => PREDICTED.has(x)).sort();
    expect(r.channels[ch].reasons.map((x) => x.code).sort(), ch).toEqual(predicted);
    expect(r.channels[ch].blocked, ch).toBe(predicted.length > 0);
  }
  return r;
}

describe('reachability summary agrees with the send-time gate', () => {
  it('a new contact is reachable on every channel and the summary says nothing', async () => {
    const agent = w.agents[0]!;
    const id = await contactWith(agent, [randomPhone()], [randomEmail()]);
    const r = await expectAgrees(agent, id);
    for (const ch of ['sms', 'voice', 'email'] as const) expect(r.channels[ch]).toMatchObject({ hasAddress: true, blocked: false, reasons: [] });
    expect(r.channels.sms.points[0]!.addressHint).toMatch(/^•••-•••-\d{4}$/);
  });

  it('R-CONSENT-7: STOP texted from the mobile blocks texts to every phone, names the keyword, the date and the inbound message; email and calls stay open', async () => {
    const agent = w.agents[0]!;
    const mobile = randomPhone();
    const work = randomPhone();
    const id = await contactWith(agent, [mobile, work], [randomEmail()]);
    const sms = await inboundSms(h, mobile, w.mainNumber, 'STOP');
    expect(sms.statusCode).toBe(200);
    const inbound = (await h.su.query<{ id: string }>("SELECT id FROM messages WHERE contact_id = $1 AND direction = 'inbound' ORDER BY created_at DESC LIMIT 1", [id])).rows[0]!.id;
    const r = await expectAgrees(agent, id);
    expect(r.channels.sms.blocked).toBe(true);
    expect(r.channels.sms.reasons).toHaveLength(1);
    const why = r.channels.sms.reasons[0]!;
    expect(why).toMatchObject({ code: 'CONSENT_REVOKED', source: 'keyword', keyword: 'STOP', otherAddress: false, recordedBy: null, addressHint: `•••-•••-${mobile.slice(-4)}` });
    expect(why.purposes.sort()).toEqual(['informational', 'marketing']);
    expect(why.evidence.inboundMessageId).toBe(inbound);
    expect(why.evidence.consentEventId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Date.parse(why.at!)).toBeGreaterThan(Date.now() - 60_000);
    // the work phone is blocked for texts too (the STOP revoked every phone), citing the same inbound STOP
    const workPoint = r.channels.sms.points.find((p) => p.addressHint.endsWith(work.slice(-4)))!;
    expect(workPoint.blocked).toBe(true);
    expect(workPoint.reasons[0]).toMatchObject({ code: 'CONSENT_REVOKED', source: 'keyword', keyword: 'STOP' });
    expect(workPoint.reasons[0]!.evidence.inboundMessageId).toBe(inbound);
    expect(r.channels.email.blocked).toBe(false);
    expect(r.channels.voice.blocked).toBe(false);
  });

  it('an agent-recorded do-not-call blocks calls to every phone and names who recorded it and when; texts stay open', async () => {
    const agent = w.agents[0]!;
    const id = await contactWith(agent, [randomPhone(), randomPhone()], []);
    const pts = await points(id);
    const rev = await call(agent, 'POST', `/contacts/${id}/consent`, { kind: 'revoke', pointId: pts[1]!.id, channel: 'voice', purpose: 'all', evidence: {} });
    expect(rev.status).toBe(200);
    const r = await expectAgrees(agent, id);
    expect(r.channels.voice.blocked).toBe(true);
    expect(r.channels.voice.reasons[0]).toMatchObject({ code: 'CONSENT_REVOKED', source: 'agent_recorded', recordedBy: { userId: agent.userId }, otherAddress: true });
    expect(r.channels.voice.reasons[0]!.recordedBy!.displayName).toEqual(expect.any(String));
    expect(r.channels.sms.blocked).toBe(false);
    expect(r.channels.email.hasAddress).toBe(false);
  });

  it('R-PAR-12 R-CONSENT-7 E168: a STOP texted from a phone that was later removed still blocks texts to the live phone; the summary agrees with the gate, names the removed number’s STOP and never lists the removed number', async () => {
    const agent = w.agents[0]!;
    const mobile = randomPhone();
    const id = await contactWith(agent, [mobile], [randomEmail()]);
    expect((await inboundSms(h, mobile, w.mainNumber, 'STOP')).statusCode).toBe(200);
    const work = randomPhone();
    expect((await call(agent, 'POST', `/contacts/${id}/points`, { kind: 'phone', address: work, label: 'work' })).status).toBe(201);
    const gone = (await points(id)).find((p) => p.address === mobile)!;
    expect((await call(agent, 'POST', `/contacts/${id}/points/${gone.id}/remove`, { reason: 'old' })).status).toBe(200);
    const r = await expectAgrees(agent, id);
    expect(r.channels.sms.blocked).toBe(true);
    expect(r.channels.sms.points.map((p) => p.addressHint)).toEqual([`•••-•••-${work.slice(-4)}`]);
    expect(r.channels.sms.reasons).toEqual([expect.objectContaining({ code: 'CONSENT_REVOKED', source: 'keyword', keyword: 'STOP', otherAddress: true, addressHint: `•••-•••-${mobile.slice(-4)}` })]);
    expect(r.channels.voice.blocked).toBe(false);
    expect(r.channels.email.blocked).toBe(false);
  });

  it('R-PAR-12 E169: a phone removed as a confirmed wrong number no longer blocks the person: the summary and the gate both say the live phone is reachable', async () => {
    const agent = w.agents[0]!;
    const mobile = randomPhone();
    const id = await contactWith(agent, [mobile], []);
    expect((await inboundSms(h, mobile, w.mainNumber, 'STOP')).statusCode).toBe(200);
    expect((await inboundSms(h, mobile, w.mainNumber, 'Wrong number')).statusCode).toBe(200);
    expect((await call(agent, 'POST', `/contacts/${id}/points`, { kind: 'phone', address: randomPhone(), label: 'work' })).status).toBe(201);
    const gone = (await points(id)).find((p) => p.address === mobile)!;
    expect((await call(agent, 'POST', `/contacts/${id}/points/${gone.id}/remove`, { reason: 'wrong_number' })).status).toBe(200);
    const r = await expectAgrees(agent, id);
    expect(r.channels.sms).toMatchObject({ hasAddress: true, blocked: false, reasons: [] });
    expect(r.channels.voice).toMatchObject({ hasAddress: true, blocked: false, reasons: [] });
  });

  it('R-CONSENT-18: an email unsubscribe blocks marketing email only, and says so for the marketing purpose', async () => {
    const agent = w.agents[1]!;
    const email = randomEmail();
    const id = await contactWith(agent, [randomPhone()], [email]);
    const sent = await call<{ message: { id: string } | null; result: string }>(agent, 'POST', `/contacts/${id}/messages`, { channel: 'email', subject: 'New homes', body: 'Fresh listings for you.', idempotencyKey: `e-${randomUUID()}` });
    expect(sent.body.result).toBe('sent');
    const mail = h.providers.email.sent.find((m) => m.idempotencyKey === sent.body.message!.id)!;
    const url = new URL(/^<(.+)>$/.exec(mail.headers!['List-Unsubscribe']!)![1]!);
    expect((await h.app.inject({ method: 'POST', url: url.pathname, headers: { origin: 'http://localhost:5173' } })).statusCode).toBe(200);
    const r = await expectAgrees(agent, id);
    expect(r.purposeNow).toBe('marketing');
    expect(r.channels.email.blocked).toBe(true);
    expect(r.channels.email.reasons[0]).toMatchObject({ code: 'CONSENT_REVOKED', source: 'unsubscribe', purposes: ['marketing'] });
    expect(r.channels.email.reasons[0]!.evidence.consentEventId).toEqual(expect.any(String));
    expect(r.channels.sms.blocked).toBe(false);
  });

  it('R-CONSENT-9: a hard bounce is an active suppression with its reason and date; a lifted one no longer blocks', async () => {
    const agent = w.agents[1]!;
    const id = await contactWith(agent, [randomPhone()], [randomEmail()]);
    const sent = await call<{ message: { id: string } | null }>(agent, 'POST', `/contacts/${id}/messages`, { channel: 'email', subject: 'Hello', body: 'Hello there.', idempotencyKey: `e-${randomUUID()}` });
    const ref = h.providers.email.sent.find((m) => m.idempotencyKey === sent.body.message!.id)!.headers![EMAIL_REF_HEADER]!;
    await emailWebhook(h, '/webhooks/email/events', { eventId: randomUUID(), ref, type: 'bounced' });
    const r = await expectAgrees(agent, id);
    expect(r.channels.email.reasons[0]).toMatchObject({ code: 'SUPPRESSED', source: 'suppression', suppressionReason: 'hard_bounce' });
    const sid = r.channels.email.reasons[0]!.evidence.suppressionId!;
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'POST', `/suppressions/${sid}/lift`, { reason: 'mailbox fixed' })).status).toBe(200);
    expect((await expectAgrees(agent, id)).channels.email.blocked).toBe(false);
  });

  it('a wrong-number outcome marks the phone: texts and calls to it are blocked and the summary says why', async () => {
    const agent = w.agents[0]!;
    const id = await contactWith(agent, [randomPhone()], []);
    await h.su.query("UPDATE contact_points SET status = 'wrong_number' WHERE contact_id = $1", [id]);
    const r = await expectAgrees(agent, id);
    expect(r.channels.sms.reasons.map((x) => x.code)).toEqual(['WRONG_NUMBER']);
    expect(r.channels.voice.reasons.map((x) => x.code)).toEqual(['WRONG_NUMBER']);
  });

  it('E-import: an imported do-not-contact is a suppression named as imported, with its import batch when the caller may see imports', async () => {
    const agent = w.agents[0]!;
    const phone = randomPhone();
    const id = await contactWith(agent, [phone], []);
    const pt = (await points(id))[0]!;
    const batch = randomUUID();
    const stage = randomUUID();
    const rec = randomUUID();
    await h.su.query("INSERT INTO import_batches (tenant_id, id, source, status, created_by_user_id, source_snapshot_sha256) VALUES ($1,$2,'csv','committed',$3,$4)", [w.tenantId, batch, w.owner.userId, 'a'.repeat(64)]);
    await h.su.query("INSERT INTO import_stages (tenant_id, id, batch_id, category, seq, status) VALUES ($1,$2,$3,'consent',6,'pending')", [w.tenantId, stage, batch]);
    await h.su.query("INSERT INTO import_records (tenant_id, id, stage_id, source_ref, outcome, raw_purged_at, target_id) VALUES ($1,$2,$3,'file.csv#row=2','imported',now(),$4)", [w.tenantId, rec, stage, id]);
    await h.su.query("INSERT INTO suppressions (tenant_id, id, address_kind, address_hmac, address_hint, channel, reason, imported, import_record_id) VALUES ($1,$2,'phone',decode($3,'hex'),$4,'all','import_dnc',true,$5)", [w.tenantId, randomUUID(), pt.hmac, `•••-•••-${phone.slice(-4)}`, rec]);
    const asAgent = await expectAgrees(agent, id);
    expect(asAgent.channels.sms.reasons[0]).toMatchObject({ code: 'SUPPRESSED', source: 'imported', suppressionReason: 'import_dnc' });
    const asOwner = (await reach(w.owner, id)).body.reachability;
    expect(asOwner.channels.voice.reasons[0]).toMatchObject({ code: 'SUPPRESSED', source: 'imported', importBatchId: batch });
  });
});

describe('role visibility (R-PERM-1, R-PERM-5)', () => {
  it('only callers who see the contact detail get the summary; others get 404, never a hint that the person exists', async () => {
    const agent = w.agents[0]!;
    const id = await contactWith(agent, [randomPhone()], [randomEmail()]);
    expect((await reach(agent, id)).status).toBe(200);
    expect((await reach(w.owner, id)).status).toBe(200);
    expect((await reach(w.agents[1]!, id)).status).toBe(404);
    expect((await reach(tc, id)).status).toBe(404);
    expect((await reach(agent, randomUUID())).status).toBe(404);
  });
  it('the summary carries no full address, no tenant id and no confidence field', async () => {
    const agent = w.agents[0]!;
    const phone = randomPhone();
    const email = randomEmail();
    const id = await contactWith(agent, [phone], [email]);
    const raw = JSON.stringify((await reach(agent, id)).body);
    expect(raw).not.toContain(phone);
    expect(raw).not.toContain(email);
    expect(raw).not.toMatch(/tenant|confidence/i);
  });
});

describe('GET /reachability (the feed: many contacts in one request)', () => {
  it('returns the same summary as the single route for each visible contact, and silently leaves out contacts the caller does not see in detail', async () => {
    const [a, b] = w.agents as [TestClient, TestClient];
    const mobile = randomPhone();
    const mine = await contactWith(a, [mobile], [randomEmail()]);
    await inboundSms(h, mobile, w.mainNumber, 'STOP');
    const mine2 = await contactWith(a, [randomPhone()], []);
    const theirs = await contactWith(b, [randomPhone()], []);
    const r = await call<{ reachability: Reach[] }>(a, 'GET', `/reachability?contactIds=${[mine, mine2, theirs, randomUUID()].join(',')}`);
    expect(r.status).toBe(200);
    expect(r.body.reachability.map((x) => x.contactId).sort()).toEqual([mine, mine2].sort());
    for (const x of r.body.reachability) expect(x).toEqual((await reach(a, x.contactId)).body.reachability);
    expect(r.body.reachability.find((x) => x.contactId === mine)!.channels.sms.blocked).toBe(true);
  });
  it('validates the id list (1 to 50 uuids)', async () => {
    const a = w.agents[0]!;
    expect((await call(a, 'GET', '/reachability?contactIds=nope')).status).toBe(422);
    expect((await call(a, 'GET', `/reachability?contactIds=${Array.from({ length: 51 }, () => randomUUID()).join(',')}`)).status).toBe(422);
  });
});
