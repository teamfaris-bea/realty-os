// Real-vendor webhook paths end to end (real Postgres, fake provider HTTP):
//   - TELEPHONY_PROVIDER=twilio: each request is verified with the auth token of the subaccount it names;
//     replays are idempotent no-ops; a subaccount cannot deliver into another tenant
//   - click-to-call: the client answer URL plays the announcement before recording is kept (R-CONSENT-16)
//   - recordings: Twilio's callback (no From) is routed by the signing subaccount; the provider copy is
//     deleted once ours is stored
//   - email: Postmark and SendGrid inbound + event formats with their own authentication; bounces,
//     complaints and provider unsubscribes feed suppressions / opt-outs; RFC 8058 one-click unsubscribe
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { type CommsWorld, call, commsWorld, ownedContact, randomPhone, runJobs } from '../comms/testing.js';
import { EMAIL_REF_HEADER } from '../comms/render.js';
import { suFixture } from '../leads/testing.js';
import { FakeTelephony } from './fake/telephony.js';
import { telephonySignature } from './webhooks.js';

const MASTER = 'AC' + 'f'.repeat(32);
const MASTER_TOKEN = 'master-auth-token-0000';
const BASIC = { username: 'vendor-hook', password: 'basic-password-0123456789' };
const ec = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const SENDGRID_KEY = ec.publicKey.export({ format: 'der', type: 'spki' }).toString('base64');

let h: ApiHarness;
let w: CommsWorld;
let w2: CommsWorld;
const subs = new Map<string, { sid: string; token: string }>();

async function useTwilioSubaccount(world: CommsWorld, hexChar: string): Promise<void> {
  // the fake created the tenant's subaccount; give it a Twilio-shaped SID (the secret stays the stored one)
  const sid = 'AC' + hexChar.repeat(32);
  await suFixture(h, [{ text: "UPDATE provider_credentials SET external_account_ref = $2 WHERE tenant_id = $1 AND provider = 'telephony'", values: [world.tenantId, sid] }]);
  subs.set(world.tenantId, { sid, token: (await new FakeTelephony().createSubaccount(world.tenantId, 'x')).secret });
}

beforeAll(async () => {
  h = await createApiHarness({
    config: {
      providers: { ai: 'fake', telephony: 'twilio', email: 'fake', storage: 'fake', push: 'fake' },
      twilio: { accountSid: MASTER, authToken: MASTER_TOKEN, numberCountry: 'US' },
      emailInbound: { formats: ['postmark', 'sendgrid'], basicAuth: BASIC, sendgridEventPublicKey: SENDGRID_KEY },
    },
  });
  w = await commsWorld(h, { agents: 1 });
  w2 = await commsWorld(h, { agents: 1 });
  await useTwilioSubaccount(w, '1');
  await useTwilioSubaccount(w2, '2');
  h.providers.email.verifiedDomains.add('mail.vendor.test');
  const dom = await call<{ domain: { id: string } }>(w.owner, 'POST', '/sending-domains', { domain: 'mail.vendor.test' });
  await call(w.owner, 'POST', `/sending-domains/${dom.body.domain.id}/verify`);
  await call(w.owner, 'POST', '/email-identities', { fromAddress: `a-${randomUUID().slice(0, 6)}@mail.vendor.test`, displayName: 'Agent', userId: w.agents[0]!.userId, domainId: dom.body.domain.id });
  await suFixture(h, [{ text: "UPDATE tenant_settings SET brokerage_postal_address = '1 Main St, Springfield' WHERE tenant_id = $1", values: [w.tenantId] }]);
});
afterAll(async () => {
  await h?.close();
});

let seq = 0;
const sid = (p: string) => `${p}${(Date.now().toString(16) + String(++seq).padStart(8, '0') + randomUUID().replace(/-/g, '')).slice(0, 32)}`;

/** A Twilio-signed form POST: signature over the full public URL + sorted params, with the given token. */
function twilio(pathAndQuery: string, params: Record<string, string>, token: string) {
  const url = new URL(`/api${pathAndQuery}`, h.config.publicBaseUrl).toString();
  return h.app.inject({ method: 'POST', url: `/api${pathAndQuery}`, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': telephonySignature(token, url, params) }, payload: new URLSearchParams(params).toString() });
}

const inboundCount = (tenantId: string, ref: string) => h.su.query('SELECT count(*)::int AS n FROM messages WHERE tenant_id = $1 AND provider_message_ref = $2', [tenantId, ref]).then((r) => r.rows[0].n as number);

describe('TELEPHONY_PROVIDER=twilio: per-subaccount signatures', () => {
  it("an inbound SMS signed with the tenant subaccount's own token is delivered once; a replay of the same signed request is a no-op", async () => {
    const s = subs.get(w.tenantId)!;
    const ref = sid('SM');
    const params = { AccountSid: s.sid, MessageSid: ref, From: randomPhone(), To: w.mainNumber, Body: 'Is the house still available?', NumMedia: '0' };
    const first = await twilio('/webhooks/telephony/sms', params, s.token);
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toContain('text/xml');
    expect(await inboundCount(w.tenantId, ref)).toBe(1);
    expect((await twilio('/webhooks/telephony/sms', params, s.token)).statusCode).toBe(200);
    expect(await inboundCount(w.tenantId, ref)).toBe(1);
    const ev = await h.su.query("SELECT tenant_id, signature_valid FROM webhook_events WHERE provider_event_id = $1", [`sms:${ref}`]);
    expect(ev.rows).toEqual([{ tenant_id: w.tenantId, signature_valid: true }]);
  });

  it('the wrong token, an unknown AccountSid, a missing AccountSid, the fake shared secret or a tampered body is 403 with a tenant-less rejected row', async () => {
    const s = subs.get(w.tenantId)!;
    const before = (await h.su.query("SELECT count(*)::int AS n FROM webhook_events WHERE status = 'rejected'")).rows[0].n as number;
    const base = { MessageSid: sid('SM'), From: randomPhone(), To: w.mainNumber, Body: 'hi' };
    const attempts = [
      twilio('/webhooks/telephony/sms', { ...base, AccountSid: s.sid }, MASTER_TOKEN),
      twilio('/webhooks/telephony/sms', { ...base, AccountSid: s.sid }, subs.get(w2.tenantId)!.token),
      twilio('/webhooks/telephony/sms', { ...base, AccountSid: 'AC' + '9'.repeat(32) }, s.token),
      twilio('/webhooks/telephony/sms', base, s.token),
      twilio('/webhooks/telephony/sms', { ...base, AccountSid: s.sid }, h.config.webhookSecrets.telephony),
    ];
    for (const r of await Promise.all(attempts)) {
      expect(r.statusCode).toBe(403);
      expect(r.json().error.code).toBe('WEBHOOK_SIGNATURE_INVALID');
    }
    const p = { ...base, AccountSid: s.sid };
    const url = new URL('/api/webhooks/telephony/sms', h.config.publicBaseUrl).toString();
    const tampered = await h.app.inject({ method: 'POST', url: '/api/webhooks/telephony/sms', headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': telephonySignature(s.token, url, p) }, payload: new URLSearchParams({ ...p, Body: 'STOP' }).toString() });
    expect(tampered.statusCode).toBe(403);
    expect(await inboundCount(w.tenantId, base.MessageSid)).toBe(0);
    const rows = await h.su.query("SELECT tenant_id, payload_enc FROM webhook_events WHERE status = 'rejected' ORDER BY received_at DESC LIMIT 6");
    expect((await h.su.query("SELECT count(*)::int AS n FROM webhook_events WHERE status = 'rejected'")).rows[0].n - before).toBe(6);
    for (const r of rows.rows) expect(r).toEqual({ tenant_id: null, payload_enc: null });
  });

  it("R-TEN-8: a subaccount cannot deliver into another tenant: an SMS signed by tenant A's subaccount to tenant B's number is unrouted", async () => {
    const a = subs.get(w.tenantId)!;
    const ref = sid('SM');
    const r = await twilio('/webhooks/telephony/sms', { AccountSid: a.sid, MessageSid: ref, From: randomPhone(), To: w2.mainNumber, Body: 'hello' }, a.token);
    expect(r.statusCode).toBe(200);
    expect(await inboundCount(w2.tenantId, ref)).toBe(0);
    expect(await inboundCount(w.tenantId, ref)).toBe(0);
    expect((await h.su.query('SELECT tenant_id FROM webhook_events WHERE provider_event_id = $1', [`sms:${ref}`])).rows).toEqual([{ tenant_id: null }]);
  });
});

async function alertPhone(c: TestClient): Promise<void> {
  const ch = await c.post('/api/me/alert-phone', { phone: randomPhone() });
  const code = h.providers.telephony.verificationCodes.at(-1)!.code;
  const r = await c.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code });
  if (r.statusCode !== 200) throw new Error(`alert phone: ${r.statusCode} ${r.body}`);
}

describe('click-to-call announcement and recordings (Twilio shapes)', () => {
  it('R-CONSENT-16: the client answer URL plays the announcement and marks it played; the recording callback (no From) is routed by subaccount, stored encrypted, then deleted at the provider', async () => {
    const agent = w.agents[0]!;
    await alertPhone(agent);
    const c = await ownedContact(agent, { consent: false });
    const r = await call<{ result: string; callId: string }>(agent, 'POST', `/contacts/${c.id}/calls`, {});
    expect(r.body.result).toBe('dialing');
    const placed = h.providers.telephony.calls.find((x) => x.idempotencyKey === r.body.callId)!;
    expect(placed.answerUrl).toMatch(/^https:\/\/api\.test\.invalid\/api\/webhooks\/telephony\/answer\?c=/);
    const s = subs.get(w.tenantId)!;
    const answerPath = new URL(placed.answerUrl!).pathname.replace(/^\/api/, '') + new URL(placed.answerUrl!).search;
    const child = sid('CA');
    // a forged call reference is refused before anything happens
    expect((await twilio('/webhooks/telephony/answer?c=AAAA', { AccountSid: s.sid, CallSid: child, ParentCallSid: placed.providerRef, From: w.mainNumber, To: c.phone }, s.token)).statusCode).toBe(422);
    const ans = await twilio(answerPath, { AccountSid: s.sid, CallSid: child, ParentCallSid: placed.providerRef, From: w.mainNumber, To: c.phone, Direction: 'outbound-dial', CallStatus: 'in-progress' }, s.token);
    expect(ans.statusCode).toBe(200);
    expect(ans.body).toMatch(/<Say>This call may be recorded/);
    // a retried fetch of the same answer URL still announces (and changes nothing else)
    const again = await twilio(answerPath, { AccountSid: s.sid, CallSid: child, ParentCallSid: placed.providerRef, From: w.mainNumber, To: c.phone, Direction: 'outbound-dial', CallStatus: 'in-progress' }, s.token);
    expect(again.body).toMatch(/<Say>This call may be recorded/);
    const row = (await h.su.query('SELECT status, recording_mode, recording_announced_at FROM calls WHERE id = $1', [r.body.callId])).rows[0]!;
    expect(row.status).toBe('in_progress');
    expect(row.recording_mode).toBe('announced_all_parties');
    expect(row.recording_announced_at).not.toBeNull();
    // the client leg's completion (a child call) updates the parent call we stored
    expect((await twilio('/webhooks/telephony/voice', { AccountSid: s.sid, CallSid: child, ParentCallSid: placed.providerRef, From: w.mainNumber, To: c.phone, Direction: 'outbound-dial', CallStatus: 'completed', CallDuration: '61' }, s.token)).statusCode).toBe(200);
    expect((await h.su.query('SELECT status, duration_s FROM calls WHERE id = $1', [r.body.callId])).rows[0]).toEqual({ status: 'completed', duration_s: 61 });
    const rec = sid('RE');
    expect((await twilio('/webhooks/telephony/recording', { AccountSid: s.sid, CallSid: placed.providerRef, RecordingSid: rec, RecordingStatus: 'completed', RecordingDuration: '60', RecordingSource: 'DialVerb' }, s.token)).statusCode).toBe(200);
    await runJobs(h, w.tenantId, ['comms.recording_copy']);
    const stored = (await h.su.query('SELECT status, provider_copy_deleted_at FROM recordings WHERE call_id = $1', [r.body.callId])).rows[0]!;
    expect(stored.status).toBe('stored');
    expect(stored.provider_copy_deleted_at).not.toBeNull();
    expect(h.providers.telephony.deletedRecordings).toContain(rec);
  });

  it('E47: a recording of a call whose announcement never played is refused and deleted at the provider too', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent, { consent: false });
    const r = await call<{ result: string; callId: string }>(agent, 'POST', `/contacts/${c.id}/calls`, {});
    const placed = h.providers.telephony.calls.find((x) => x.idempotencyKey === r.body.callId)!;
    const s = subs.get(w.tenantId)!;
    // the agent leg completes without the client answer URL ever being fetched
    await twilio('/webhooks/telephony/voice', { AccountSid: s.sid, CallSid: placed.providerRef, From: w.mainNumber, To: '+14155550000', Direction: 'outbound-api', CallStatus: 'completed' }, s.token);
    const rec = sid('RE');
    await twilio('/webhooks/telephony/recording', { AccountSid: s.sid, CallSid: placed.providerRef, RecordingSid: rec, RecordingDuration: '30' }, s.token);
    await runJobs(h, w.tenantId, ['comms.recording_copy']);
    expect((await h.su.query('SELECT 1 FROM recordings WHERE call_id = $1', [r.body.callId])).rows).toHaveLength(0);
    expect(h.providers.telephony.deletedRecordings).toContain(rec);
  });
});

// ---- email -------------------------------------------------------------------------------------------

const sendEmail = (c: TestClient, contactId: string) =>
  call<{ result: string; message: { id: string } | null; decision: { reasons: string[] } | null }>(c, 'POST', `/contacts/${contactId}/messages`, { channel: 'email', subject: 'New homes', body: 'Fresh listings for you.', idempotencyKey: `e-${randomUUID()}` });
const sentMail = (messageId: string) => h.providers.email.sent.find((m) => m.idempotencyKey === messageId)!;
const auth = (u = BASIC.username, p = BASIC.password) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
const json = (path: string, body: unknown, headers: Record<string, string> = {}) => h.app.inject({ method: 'POST', url: `/api${path}`, headers: { 'content-type': 'application/json', ...headers }, payload: JSON.stringify(body) });

function sendgridSigned(path: string, body: unknown, ts = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(body);
  const signature = sign('sha256', Buffer.from(String(ts) + raw), ec.privateKey).toString('base64');
  return h.app.inject({ method: 'POST', url: `/api${path}`, headers: { 'content-type': 'application/json', 'x-twilio-email-event-webhook-signature': signature, 'x-twilio-email-event-webhook-timestamp': String(ts) }, payload: raw });
}

const suppression = (email: string, reason: string) =>
  h.su.query("SELECT 1 FROM suppressions WHERE tenant_id = $1 AND reason = $2 AND address_hint LIKE $3 AND lifted_at IS NULL", [w.tenantId, reason, `${email.slice(0, 1)}•••@%`]).then((r) => r.rows.length);

describe('inbound email in vendor formats', () => {
  it('a Postmark inbound reply (Basic auth) lands in the conversation; wrong credentials are 403; a retried delivery is not ingested twice', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const sent = await sendEmail(agent, c.id);
    const replyTo = sentMail(sent.body.message!.id).replyTo!;
    const pm = { MessageID: randomUUID(), From: c.email, FromFull: { Email: c.email, Name: 'Jane' }, To: replyTo, ToFull: [{ Email: replyTo }], OriginalRecipient: replyTo, Subject: 'Re: New homes', TextBody: 'Yes, Saturday works.', Headers: [{ Name: 'X-Test', Value: '1' }] };
    expect((await json('/webhooks/email/postmark/inbound', pm, { authorization: auth('vendor-hook', 'wrong-password-0000000') })).statusCode).toBe(403);
    expect((await json('/webhooks/email/postmark/inbound', pm)).statusCode).toBe(403);
    const ok = await json('/webhooks/email/postmark/inbound', pm, { authorization: auth() });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, routed: true });
    await json('/webhooks/email/postmark/inbound', pm, { authorization: auth() });
    const rows = await h.su.query("SELECT body FROM messages WHERE contact_id = $1 AND direction = 'inbound' AND channel = 'email'", [c.id]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]!.body).toContain('Saturday works');
  });

  it('a SendGrid Inbound Parse post (multipart, Basic auth) lands in the conversation', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const sent = await sendEmail(agent, c.id);
    const replyTo = sentMail(sent.body.message!.id).replyTo!;
    const fd = new FormData();
    fd.set('headers', `Message-ID: <${randomUUID()}@mail.example>\r\nFrom: Jane <${c.email}>\r\nTo: ${replyTo}\r\nSubject: Re: New homes`);
    fd.set('from', `Jane <${c.email}>`);
    fd.set('to', replyTo);
    fd.set('subject', 'Re: New homes');
    fd.set('text', 'Can we see it Sunday?');
    fd.set('envelope', JSON.stringify({ to: [replyTo], from: c.email }));
    const req = new Request('http://x.invalid', { method: 'POST', body: fd });
    const payload = Buffer.from(await req.arrayBuffer());
    const ct = req.headers.get('content-type')!;
    expect((await h.app.inject({ method: 'POST', url: '/api/webhooks/email/sendgrid/inbound', headers: { 'content-type': ct }, payload })).statusCode).toBe(403);
    const ok = await h.app.inject({ method: 'POST', url: '/api/webhooks/email/sendgrid/inbound', headers: { 'content-type': ct, authorization: auth() }, payload });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ ok: true, routed: true });
    const rows = await h.su.query("SELECT body FROM messages WHERE contact_id = $1 AND direction = 'inbound' AND channel = 'email'", [c.id]);
    expect(rows.rows.map((x) => x.body)).toEqual([expect.stringContaining('Sunday')]);
  });
});

describe('email events in vendor formats feed suppressions and opt-outs (R-CONSENT-9, R-CONSENT-18)', () => {
  it('R-CONSENT-9: a SendGrid hard bounce (ECDSA-signed) suppresses the address; a bad signature or a stale timestamp is 403', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const sent = await sendEmail(agent, c.id);
    const ref = sentMail(sent.body.message!.id).headers![EMAIL_REF_HEADER]!;
    const events = [{ email: c.email, event: 'bounce', type: 'bounce', sg_event_id: randomUUID(), timestamp: Math.floor(Date.now() / 1000), realty_ref: ref }];
    expect((await sendgridSigned('/webhooks/email/sendgrid/events', events, Math.floor(Date.now() / 1000) - 3600)).statusCode).toBe(403);
    const forged = await h.app.inject({ method: 'POST', url: '/api/webhooks/email/sendgrid/events', headers: { 'content-type': 'application/json', 'x-twilio-email-event-webhook-signature': 'MEUCIQ' + 'A'.repeat(90), 'x-twilio-email-event-webhook-timestamp': String(Math.floor(Date.now() / 1000)) }, payload: JSON.stringify(events) });
    expect(forged.statusCode).toBe(403);
    expect(await suppression(c.email, 'hard_bounce')).toBe(0);
    expect((await sendgridSigned('/webhooks/email/sendgrid/events', events)).statusCode).toBe(200);
    expect(await suppression(c.email, 'hard_bounce')).toBe(1);
    expect((await h.su.query('SELECT status FROM messages WHERE id = $1', [sent.body.message!.id])).rows[0]!.status).toBe('bounced');
    expect((await sendEmail(agent, c.id)).body.decision!.reasons).toContain('SUPPRESSED');
  });

  it('R-CONSENT-18: an unsubscribe reported by SendGrid is the person\'s opt-out: the next marketing email is denied', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const sent = await sendEmail(agent, c.id);
    const ref = sentMail(sent.body.message!.id).headers![EMAIL_REF_HEADER]!;
    const r = await sendgridSigned('/webhooks/email/sendgrid/events', [{ email: c.email, event: 'unsubscribe', sg_event_id: randomUUID(), timestamp: Math.floor(Date.now() / 1000), realty_ref: ref }, { event: 'processed', sg_event_id: randomUUID() }]);
    expect(r.statusCode).toBe(200);
    expect((await h.su.query("SELECT source, purpose FROM consent_events WHERE contact_id = $1 AND event_type = 'revoke'", [c.id])).rows).toEqual([{ source: 'provider_report', purpose: 'marketing' }]);
    expect((await sendEmail(agent, c.id)).body.decision!.reasons).toContain('CONSENT_REVOKED');
  });

  it('R-CONSENT-9: a Postmark spam complaint is a never-liftable suppression; a soft bounce changes nothing', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const sent = await sendEmail(agent, c.id);
    const ref = sentMail(sent.body.message!.id).headers![EMAIL_REF_HEADER]!;
    const hardBefore = await suppression(c.email, 'hard_bounce');
    const spamBefore = await suppression(c.email, 'spam_complaint');
    const soft = { RecordType: 'Bounce', ID: 1, Type: 'SoftBounce', MessageID: randomUUID(), BouncedAt: new Date().toISOString(), Metadata: { realty_ref: ref } };
    expect((await json('/webhooks/email/postmark/events', soft, { authorization: auth() })).statusCode).toBe(200);
    expect(await suppression(c.email, 'hard_bounce')).toBe(hardBefore);
    expect((await h.su.query('SELECT status FROM messages WHERE id = $1', [sent.body.message!.id])).rows[0]!.status).not.toBe('bounced');
    const spam = { RecordType: 'SpamComplaint', ID: 2, Type: 'SpamComplaint', MessageID: randomUUID(), BouncedAt: new Date().toISOString(), Metadata: { realty_ref: ref } };
    expect((await json('/webhooks/email/postmark/events', spam)).statusCode).toBe(403);
    expect((await json('/webhooks/email/postmark/events', spam, { authorization: auth() })).statusCode).toBe(200);
    expect(await suppression(c.email, 'spam_complaint')).toBe(spamBefore + 1);
  });

  it('R-CONSENT-18: RFC 8058 one-click unsubscribe works as a mailbox provider sends it (POST, no Origin, no cookie)', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent);
    const sent = await sendEmail(agent, c.id);
    const mail = sentMail(sent.body.message!.id);
    expect(mail.headers!['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
    const url = new URL(/^<(.+)>$/.exec(mail.headers!['List-Unsubscribe']!)![1]!);
    const post = await h.app.inject({ method: 'POST', url: url.pathname, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'List-Unsubscribe=One-Click' });
    expect(post.statusCode).toBe(200);
    expect((await sendEmail(agent, c.id)).body.decision!.reasons).toContain('CONSENT_REVOKED');
    // the exemption covers only this capability route: other public POSTs still need an allowed Origin
    expect((await h.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: '{}' })).json().error.code).toBe('CSRF_INVALID');
    // a person clicking the page's button gets a page back
    const page = await h.app.inject({ method: 'POST', url: url.pathname, headers: { accept: 'text/html' } });
    expect(page.headers['content-type']).toContain('text/html');
  });
});
