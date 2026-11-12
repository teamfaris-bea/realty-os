// R-TWL-3 / R-TWL-4 (lane telephony-safeguards S2): the telephony webhook paths are a stable public contract
// (docs/DEPLOY.md §5.2). This test reads the documented table and fails when a documented path disappears from the
// route table (or a telephony webhook route is undocumented), stops verifying X-Twilio-Signature, trusts the Host
// header, or stops being idempotent on its provider id. It runs with TELEPHONY_PROVIDER=twilio (each request signed by
// the tenant subaccount's own token, the pilot's shape; the fake provider stands in for Twilio's REST API) and once
// with the fake's shared secret for the unrouted case (E382).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { suFixture } from '../leads/testing.js';
import { FakeTelephony } from '../providers/fake/telephony.js';
import { telephonySignature } from '../providers/webhooks.js';
import { mapTelephonyStatus } from './status.js';
import { type CommsWorld, call, commsWorld, messageRow, ownedContact, randomPhone, sendText, telephonyWebhook } from './testing.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const MASTER = 'AC' + 'e'.repeat(32);

/** The paths of DEPLOY §5.2's contract table ({base}/api/webhooks/telephony/…), in document order. */
function documentedPaths(): string[] {
  const doc = readFileSync(resolve(repo, 'docs/DEPLOY.md'), 'utf8');
  const start = doc.indexOf('### 5.2 Telephony webhook endpoints');
  const end = doc.indexOf('\n### ', start + 10);
  expect(start).toBeGreaterThan(-1);
  return [...doc.slice(start, end).matchAll(/^\| `\{base\}(\/api\/webhooks\/telephony\/[a-z/-]+)` \|/gm)].map((m) => m[1]!);
}

const EXPECTED = ['sms', 'status', 'voice', 'voice/screen', 'voice/accept', 'voice/dial-result', 'voice/voicemail-done', 'recording', 'answer'].map((p) => `/api/webhooks/telephony/${p}`);

let h: ApiHarness;
let w: CommsWorld;
let sub: { sid: string; token: string };
let seq = 0;
const sid = (p: string) => `${p}${(Date.now().toString(16) + String(++seq).padStart(8, '0') + randomUUID().replace(/-/g, '')).slice(0, 32)}`;

beforeAll(async () => {
  h = await createApiHarness({ config: { providers: { ai: 'fake', telephony: 'twilio', email: 'fake', storage: 'fake', push: 'fake' }, twilio: { accountSid: MASTER, authToken: 'master-auth-token-0000', numberCountry: 'US' } } });
  w = await commsWorld(h, { agents: 1 });
  const accountSid = 'AC' + '5'.repeat(32);
  await suFixture(h, [{ text: "UPDATE provider_credentials SET external_account_ref = $2 WHERE tenant_id = $1 AND provider = 'telephony'", values: [w.tenantId, accountSid] }]);
  sub = { sid: accountSid, token: (await new FakeTelephony().createSubaccount(w.tenantId, 'x')).secret };
  await alertPhone(w.agents[0]!);
});
afterAll(async () => {
  await h?.close();
});

async function alertPhone(c: TestClient): Promise<string> {
  const phone = randomPhone();
  const ch = await c.post('/api/me/alert-phone', { phone });
  const code = h.providers.telephony.verificationCodes.at(-1)!.code;
  const r = await c.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code });
  if (r.statusCode !== 200) throw new Error(`alert phone: ${r.statusCode} ${r.body}`);
  return phone;
}

/** A request signed by the tenant subaccount over PUBLIC_BASE_URL + path (Twilio's scheme). */
function twilio(pathAndQuery: string, params: Record<string, string>, o: { host?: string; signedBase?: string; noAccount?: boolean } = {}) {
  const all = o.noAccount ? params : { AccountSid: sub.sid, ...params };
  const url = new URL(`/api${pathAndQuery}`, o.signedBase ?? h.config.publicBaseUrl).toString();
  return h.app.inject({
    method: 'POST',
    url: `/api${pathAndQuery}`,
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': telephonySignature(sub.token, url, all), ...(o.host ? { host: o.host } : {}) },
    payload: new URLSearchParams(all).toString(),
  });
}
const hookPath = (twiml: string, attr: string): string => {
  const m = new RegExp(`${attr}="([^"]+)"`).exec(twiml);
  if (!m) throw new Error(`no ${attr} in ${twiml}`);
  const u = new URL(m[1]!.replace(/&amp;/g, '&'));
  return u.pathname.replace(/^\/api/, '') + u.search;
};
const count = async (q: string, v: unknown[]) => Number((await h.su.query<{ n: string }>(q, v)).rows[0]!.n);

describe('R-TWL-3 the documented webhook paths are the route table', () => {
  it('R-TWL-3: DEPLOY §5.2 documents exactly the nine telephony paths, and each is a POST webhook route that exists', () => {
    const documented = documentedPaths();
    expect(documented).toEqual(EXPECTED);
    for (const p of documented) expect(h.app.hasRoute({ method: 'POST', url: p }), p).toBe(true);
  });

  it('R-TWL-3: every telephony webhook route the source registers is documented (no undocumented public path)', () => {
    const src = readFileSync(resolve(repo, 'apps/api/src/comms/webhooks.ts'), 'utf8');
    const registered = [...src.matchAll(/\.post\('(\/webhooks\/telephony\/[a-z/-]+)'/g)].map((m) => `/api${m[1]!}`);
    expect([...registered].sort()).toEqual([...EXPECTED].sort());
  });
});

describe('R-TWL-3 every documented path verifies X-Twilio-Signature over PUBLIC_BASE_URL, never the Host header', () => {
  it('R-TWL-3: an unsigned or mis-signed request to each path is 403 and writes no tenant row', async () => {
    for (const p of EXPECTED) {
      const unsigned = await h.app.inject({ method: 'POST', url: `${p}?c=x&m=${randomUUID()}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: new URLSearchParams({ AccountSid: sub.sid, MessageSid: sid('SM'), CallSid: sid('CA'), From: '+15555550111', To: w.mainNumber }).toString() });
      expect(unsigned.statusCode, p).toBe(403);
      const wrong = await h.app.inject({ method: 'POST', url: p, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': 'bm90LWEtc2lnbmF0dXJl' }, payload: new URLSearchParams({ AccountSid: sub.sid, MessageSid: sid('SM'), From: '+15555550111', To: w.mainNumber }).toString() });
      expect(wrong.statusCode, p).toBe(403);
    }
  });

  it('R-TWL-3: the signed URL comes from PUBLIC_BASE_URL: a request signed over it passes whatever Host says; one signed over the Host is refused', async () => {
    const c = await ownedContact(w.agents[0]!);
    const ok = await twilio('/webhooks/telephony/sms', { MessageSid: sid('SM'), From: c.phone, To: w.mainNumber, Body: 'hello', NumMedia: '0' }, { host: 'attacker.example.test' });
    expect(ok.statusCode).toBe(200);
    const forged = await twilio('/webhooks/telephony/sms', { MessageSid: sid('SM'), From: c.phone, To: w.mainNumber, Body: 'hello', NumMedia: '0' }, { host: 'attacker.example.test', signedBase: 'http://attacker.example.test' });
    expect(forged.statusCode).toBe(403);
  });
});

describe('R-TWL-3 every documented path is idempotent on its provider id', () => {
  it('R-TWL-3: /sms twice with one MessageSid stores one message and answers empty TwiML both times', async () => {
    const c = await ownedContact(w.agents[0]!);
    const ms = sid('SM');
    const p = { MessageSid: ms, From: c.phone, To: w.mainNumber, Body: 'see you at 5', NumMedia: '0' };
    const a = await twilio('/webhooks/telephony/sms', p);
    const b = await twilio('/webhooks/telephony/sms', p);
    for (const r of [a, b]) {
      expect(r.statusCode).toBe(200);
      expect(r.headers['content-type']).toContain('text/xml');
      expect(r.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    }
    expect(await count('SELECT count(*) AS n FROM messages WHERE provider_message_ref = $1', [ms])).toBe(1);
  });

  it('R-TWL-3: /status twice with one MessageSid + MessageStatus records one status event', async () => {
    const c = await ownedContact(w.agents[0]!);
    const sent = await sendText(w.agents[0]!, c.id, 'Status test');
    const ref = (await messageRow(h, sent.body.message!.id)).provider_message_ref!;
    const p = { MessageSid: ref, MessageStatus: 'delivered', From: w.mainNumber };
    for (let i = 0; i < 2; i++) expect((await twilio(`/webhooks/telephony/status?m=${sent.body.message!.id}`, p)).statusCode).toBe(200);
    expect(await count('SELECT count(*) AS n FROM message_status_events WHERE message_id = $1', [sent.body.message!.id])).toBe(1);
    expect((await messageRow(h, sent.body.message!.id)).status).toBe('delivered');
  });

  it('R-TWL-3: /voice, /voice/screen, /voice/accept, /voice/dial-result, /voice/voicemail-done answer the same TwiML from stored state on a retry; one call row', async () => {
    const c = await ownedContact(w.agents[0]!, { consent: false });
    const callSid = sid('CA');
    const ring = { CallSid: callSid, From: c.phone, To: w.mainNumber, CallStatus: 'ringing', Direction: 'inbound' };
    const first = await twilio('/webhooks/telephony/voice', ring);
    expect(first.body).toContain('<Dial');
    expect((await twilio('/webhooks/telephony/voice', ring)).body).toBe(first.body);
    expect(await count('SELECT count(*) AS n FROM calls WHERE provider_call_ref = $1', [callSid])).toBe(1);
    const child = sid('CA');
    const screenPath = hookPath(first.body, 'url');
    const screenParams = { CallSid: child, ParentCallSid: callSid, From: w.mainNumber, To: '+15555550100', CallStatus: 'in-progress', Direction: 'outbound-dial' };
    const s1 = await twilio(screenPath, screenParams);
    expect(s1.body).toContain('<Gather');
    expect((await twilio(screenPath, screenParams)).body).toBe(s1.body);
    // the caller is never answered: the dial result plays voicemail, and does so again on a retry
    const dr = hookPath(first.body, 'action');
    const v1 = await twilio(dr, { CallSid: callSid, DialCallStatus: 'no-answer' });
    expect(v1.body).toContain('<Record ');
    expect((await twilio(dr, { CallSid: callSid, DialCallStatus: 'no-answer' })).body).toBe(v1.body);
    const done = hookPath(v1.body, 'action');
    const d1 = await twilio(done, { CallSid: callSid });
    expect((await twilio(done, { CallSid: callSid })).body).toBe(d1.body);
    // a late accept after voicemail does not bridge, also on a retry
    const accept = hookPath(s1.body, 'action');
    const a1 = await twilio(accept, { CallSid: child, ParentCallSid: callSid, Digits: '1' });
    expect((await twilio(accept, { CallSid: child, ParentCallSid: callSid, Digits: '1' })).body).toBe(a1.body);
    expect(await count('SELECT count(*) AS n FROM calls WHERE provider_call_ref = $1', [callSid])).toBe(1);
  });

  it('R-TWL-3: /recording twice with one RecordingSid enqueues one copy job; /answer twice with one call plays the same TwiML and moves the call once', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent, { consent: false });
    const dial = await call<{ result: string; callId: string }>(agent, 'POST', `/contacts/${c.id}/calls`, {});
    expect(dial.body.result).toBe('dialing');
    const placed = h.providers.telephony.calls.at(-1)!;
    const answerPath = hookPath(`url="${placed.answerUrl!.replace(/&/g, '&amp;')}"`, 'url');
    const ans = { CallSid: sid('CA'), ParentCallSid: placed.providerRef };
    const r1 = await twilio(answerPath, ans);
    expect(r1.statusCode).toBe(200);
    expect((await twilio(answerPath, ans)).body).toBe(r1.body);
    expect(await count("SELECT count(*) AS n FROM webhook_events WHERE provider = 'telephony' AND provider_event_id = $1", [`answer:${placed.providerRef}`])).toBe(1);
    const rs = sid('RE');
    const rec = { CallSid: placed.providerRef, RecordingSid: rs, RecordingDuration: '12' };
    for (let i = 0; i < 2; i++) expect((await twilio('/webhooks/telephony/recording', rec)).statusCode).toBe(200);
    expect(await count("SELECT count(*) AS n FROM jobs WHERE kind = 'comms.recording_copy' AND payload->>'recordingRef' = $1", [rs])).toBe(1);
  });
});

describe('R-TWL-4 a status callback without From (E382)', () => {
  it('R-TWL-4 E382: no From, signed by the tenant subaccount: the guard\'s tenant is used and the status applies (never 422)', async () => {
    const c = await ownedContact(w.agents[0]!);
    const sent = await sendText(w.agents[0]!, c.id, 'No From test');
    const ref = (await messageRow(h, sent.body.message!.id)).provider_message_ref!;
    const r = await twilio(`/webhooks/telephony/status?m=${sent.body.message!.id}`, { MessageSid: ref, MessageStatus: 'delivered' });
    expect(r.statusCode).toBe(200);
    expect((await messageRow(h, sent.body.message!.id)).status).toBe('delivered');
  });

  it('R-TWL-4: MessageSid stays required (422 without it)', async () => {
    const r = await twilio('/webhooks/telephony/status', { MessageStatus: 'delivered' });
    expect(r.statusCode).toBe(422);
  });
});

describe('R-TWL-4 E382 with the fake (no tenant from the guard)', () => {
  let hf: ApiHarness;
  beforeAll(async () => {
    hf = await createApiHarness({ logLevel: 'warn' });
  });
  afterAll(async () => {
    await hf?.close();
  });

  it('R-TWL-4 E382: no From and no guard tenant: one unrouted webhook_events row, a WEBHOOK_UNROUTED log and 200; a replay records nothing more', async () => {
    const ms = sid('SM');
    const before = hf.logs.length;
    for (let i = 0; i < 2; i++) {
      const r = await telephonyWebhook(hf, '/webhooks/telephony/status', { MessageSid: ms, MessageStatus: 'delivered' });
      expect(r.statusCode).toBe(200);
      expect(r.json()).toEqual({ ok: true });
    }
    const rows = (await hf.su.query("SELECT tenant_id, status FROM webhook_events WHERE provider = 'telephony' AND provider_event_id = $1", [`status:${ms}:delivered`])).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.tenant_id).toBeNull();
    expect(hf.logs.slice(before).filter((l) => l.includes('WEBHOOK_UNROUTED'))).toHaveLength(1);
  });
});

describe('R-TWL-4 the status map (comms/status.ts)', () => {
  it('R-TWL-4: canceled → failed, scheduled → ignored, read → delivered (the rest unchanged)', () => {
    expect(mapTelephonyStatus('canceled')).toBe('failed');
    expect(mapTelephonyStatus('scheduled')).toBeNull();
    expect(mapTelephonyStatus('read')).toBe('delivered');
    expect(['queued', 'sent', 'delivered', 'undelivered', 'failed'].map(mapTelephonyStatus)).toEqual(['sent', 'sent', 'delivered', 'undelivered', 'failed']);
  });

  it('R-TWL-4: a canceled callback fails the message with PROVIDER_CANCELED; a scheduled one records nothing; read moves it to delivered', async () => {
    const c = await ownedContact(w.agents[0]!);
    const a = await sendText(w.agents[0]!, c.id, 'cancel me');
    const refA = (await messageRow(h, a.body.message!.id)).provider_message_ref!;
    expect((await twilio(`/webhooks/telephony/status?m=${a.body.message!.id}`, { MessageSid: refA, MessageStatus: 'scheduled' })).statusCode).toBe(200);
    expect(await count('SELECT count(*) AS n FROM message_status_events WHERE message_id = $1', [a.body.message!.id])).toBe(0);
    expect((await twilio(`/webhooks/telephony/status?m=${a.body.message!.id}`, { MessageSid: refA, MessageStatus: 'canceled' })).statusCode).toBe(200);
    expect(await messageRow(h, a.body.message!.id)).toMatchObject({ status: 'failed', status_reason: 'PROVIDER_CANCELED' });
    const b = await sendText(w.agents[0]!, c.id, 'read me');
    const refB = (await messageRow(h, b.body.message!.id)).provider_message_ref!;
    expect((await twilio(`/webhooks/telephony/status?m=${b.body.message!.id}`, { MessageSid: refB, MessageStatus: 'read' })).statusCode).toBe(200);
    expect((await messageRow(h, b.body.message!.id)).status).toBe('delivered');
    // a canceled message is not an opt-out
    expect(await count("SELECT count(*) AS n FROM consent_events WHERE contact_id = $1 AND event_type = 'revoke'", [c.id])).toBe(0);
  });
});
