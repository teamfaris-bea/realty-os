// Inbound calls on real Twilio (comms/voice.ts), end to end on real Postgres with Twilio-signed requests
// (TELEPHONY_PROVIDER=twilio: each request is signed with the tenant subaccount's own token; the fake
// provider stands in for Twilio's REST API), plus the same flow with the fake provider's shared secret.
//   ring the owner (team number as caller ID, announcement first, recording on the Dial) → whisper →
//   accept on 1 → completed; unanswered ⇒ missed-call feed item + voicemail greeting + recording notice;
//   the voicemail is stored encrypted and transcribed; unknown callers ring the on-duty routing target;
//   Owner/Admin set the ring timeout and greeting (audited); forged refs and cross-tenant refs do nothing.
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, type TestClient, createApiHarness } from '../auth/testHarness.js';
import { suFixture } from '../leads/testing.js';
import { FakeTelephony } from '../providers/fake/telephony.js';
import { telephonySignature } from '../providers/webhooks.js';
import { type CommsWorld, call, commsWorld, ownedContact, randomPhone, runJobs, telephonyWebhook } from './testing.js';
import { DEFAULT_RING_TIMEOUT_S, VOICEMAIL_NOTICE } from './voice.js';

const MASTER = 'AC' + 'e'.repeat(32);

let h: ApiHarness;
let w: CommsWorld;
let w2: CommsWorld;
const subs = new Map<string, { sid: string; token: string }>();

async function useTwilioSubaccount(world: CommsWorld, hexChar: string): Promise<void> {
  const accountSid = 'AC' + hexChar.repeat(32);
  await suFixture(h, [{ text: "UPDATE provider_credentials SET external_account_ref = $2 WHERE tenant_id = $1 AND provider = 'telephony'", values: [world.tenantId, accountSid] }]);
  subs.set(world.tenantId, { sid: accountSid, token: (await new FakeTelephony().createSubaccount(world.tenantId, 'x')).secret });
}

async function alertPhone(c: TestClient): Promise<string> {
  const phone = randomPhone();
  const ch = await c.post('/api/me/alert-phone', { phone });
  const code = h.providers.telephony.verificationCodes.at(-1)!.code;
  const r = await c.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code });
  if (r.statusCode !== 200) throw new Error(`alert phone: ${r.statusCode} ${r.body}`);
  return phone;
}

let ownerPhone: string;

beforeAll(async () => {
  h = await createApiHarness({ config: { providers: { ai: 'fake', telephony: 'twilio', email: 'fake', storage: 'fake', push: 'fake' }, twilio: { accountSid: MASTER, authToken: 'master-auth-token-0000', numberCountry: 'US' } } });
  w = await commsWorld(h, { agents: 2 });
  w2 = await commsWorld(h, { agents: 1 });
  await useTwilioSubaccount(w, '3');
  await useTwilioSubaccount(w2, '4');
  // agents[0] can be rung; agents[1] has no verified phone (never rung)
  ownerPhone = await alertPhone(w.agents[0]!);
});
afterAll(async () => {
  await h?.close();
});

let seq = 0;
const sid = (p: string) => `${p}${(Date.now().toString(16) + String(++seq).padStart(8, '0') + randomUUID().replace(/-/g, '')).slice(0, 32)}`;

function twilio(world: CommsWorld, pathAndQuery: string, params: Record<string, string>) {
  const s = subs.get(world.tenantId)!;
  const all = { AccountSid: s.sid, ...params };
  const url = new URL(`/api${pathAndQuery}`, h.config.publicBaseUrl).toString();
  return h.app.inject({ method: 'POST', url: `/api${pathAndQuery}`, headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': telephonySignature(s.token, url, all) }, payload: new URLSearchParams(all).toString() });
}

/** The path + query of an absolute callback URL found in TwiML (attribute values are XML-escaped). */
function hookPath(twiml: string, attr: string): string {
  const m = new RegExp(`${attr}="([^"]+)"`).exec(twiml);
  if (!m) throw new Error(`no ${attr} in ${twiml}`);
  const u = new URL(m[1]!.replace(/&amp;/g, '&'));
  return u.pathname.replace(/^\/api/, '') + u.search;
}

const ringing = (world: CommsWorld, callSid: string, from: string) => twilio(world, '/webhooks/telephony/voice', { CallSid: callSid, From: from, To: world.mainNumber, CallStatus: 'ringing', Direction: 'inbound' });
const callRow = (callSid: string) => h.su.query('SELECT * FROM calls WHERE provider_call_ref = $1', [callSid]).then((r) => r.rows[0]);
const missedItems = (userId: string | null, contactId: string) => h.su.query<{ reasons: { code: string; text: string }[] }>("SELECT reasons FROM priority_feed_items WHERE user_id = $1 AND contact_id = $2 AND item_type = 'missed_call'", [userId, contactId]).then((r) => r.rows);

describe('inbound call: ring the owning agent', () => {
  it('R-CONSENT-16: rings the owner from the team number with the announcement first; a retried fetch gets the same answer; pressing 1 bridges; completed', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent, { consent: false });
    const callSid = sid('CA');
    const first = await ringing(w, callSid, c.phone);
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toContain('text/xml');
    const twiml = first.body;
    // the announcement is the first thing the caller hears, before the Dial
    expect(twiml.indexOf('<Say>This call may be recorded')).toBeGreaterThan(-1);
    expect(twiml.indexOf('<Say>This call may be recorded')).toBeLessThan(twiml.indexOf('<Dial'));
    expect(twiml).toContain(`callerId="${w.mainNumber}"`);
    expect(twiml).toContain(`timeout="${DEFAULT_RING_TIMEOUT_S}"`);
    expect(twiml).toContain('answerOnBridge="true"');
    expect(twiml).toContain('record="record-from-answer-dual"');
    expect(twiml).toContain(`>${ownerPhone}</Number>`);
    const row = await callRow(callSid);
    expect(row).toMatchObject({ direction: 'inbound', status: 'ringing', ring_user_id: agent.userId, recording_mode: 'announced_all_parties' });
    expect(row.recording_announced_at).not.toBeNull();
    // Twilio retries the voice URL: same TwiML, one call row
    const again = await ringing(w, callSid, c.phone);
    expect(again.body).toBe(twiml);
    expect((await h.su.query('SELECT count(*)::int AS n FROM calls WHERE provider_call_ref = $1', [callSid])).rows[0].n).toBe(1);

    // the agent leg's whisper, then a key press
    const child = sid('CA');
    const screen = await twilio(w, hookPath(twiml, 'url'), { CallSid: child, ParentCallSid: callSid, From: w.mainNumber, To: ownerPhone, CallStatus: 'in-progress', Direction: 'outbound-dial' });
    expect(screen.body).toMatch(/<Gather numDigits="1"[^>]*><Say>Call for [^<]*This call may be recorded\. Press 1 to answer\.<\/Say><\/Gather><Hangup\/>/);
    const acceptPath = hookPath(screen.body, 'action');
    const wrongKey = await twilio(w, acceptPath, { CallSid: child, ParentCallSid: callSid, Digits: '7' });
    expect(wrongKey.body).toContain('<Hangup/>');
    expect((await callRow(callSid)).status).toBe('ringing');
    const accept = await twilio(w, acceptPath, { CallSid: child, ParentCallSid: callSid, Digits: '1' });
    expect(accept.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
    expect(await callRow(callSid)).toMatchObject({ status: 'in_progress', agent_user_id: agent.userId });
    // a retried accept still bridges
    expect((await twilio(w, acceptPath, { CallSid: child, ParentCallSid: callSid, Digits: '1' })).body).not.toContain('Hangup');

    // the dial ends after the conversation: nothing more for the caller; the final status completes the call
    expect((await twilio(w, hookPath(twiml, 'action'), { CallSid: callSid, DialCallStatus: 'completed', DialCallDuration: '93' })).body).toContain('<Hangup/>');
    await twilio(w, '/webhooks/telephony/voice', { CallSid: callSid, From: c.phone, To: w.mainNumber, CallStatus: 'completed', CallDuration: '95', Direction: 'inbound' });
    expect(await callRow(callSid)).toMatchObject({ status: 'completed', duration_s: 95 });
    expect(await missedItems(agent.userId, c.id)).toHaveLength(0);
  });

  it('nobody presses 1 before the timeout: the call is missed (feed item + notification) and the caller gets the voicemail greeting, the fixed notice and the beep', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent, { consent: false });
    const callSid = sid('CA');
    const twiml = (await ringing(w, callSid, c.phone)).body;
    const vm = await twilio(w, hookPath(twiml, 'action'), { CallSid: callSid, DialCallStatus: 'no-answer' });
    expect(vm.body).toContain('We can&apos;t take your call right now');
    expect(vm.body).toContain(`<Say>${VOICEMAIL_NOTICE}</Say>`);
    expect(vm.body).toMatch(/<Record [^>]*playBeep="true"[^>]*recordingStatusCallback="https:\/\/[^"]+\/api\/webhooks\/telephony\/recording\?vm=/);
    expect(await callRow(callSid)).toMatchObject({ status: 'no_answer', handled_by: 'voicemail' });
    expect((await missedItems(agent.userId, c.id))[0]!.reasons[0]).toMatchObject({ code: 'MISSED_CALL', text: 'Missed call' });
    expect((await h.su.query("SELECT 1 FROM notifications WHERE user_id = $1 AND kind = 'missed_call' AND subject_id = $2", [agent.userId, (await callRow(callSid)).id])).rows).toHaveLength(1);
    // too late to accept now
    const screenUrl = hookPath(twiml, 'url');
    const acceptPath = screenUrl.replace('/voice/screen', '/voice/accept');
    expect((await twilio(w, acceptPath, { CallSid: sid('CA'), ParentCallSid: callSid, Digits: '1' })).body).toContain('This call has ended');
    // a retried dial-result replays the voicemail (and adds nothing)
    expect((await twilio(w, hookPath(twiml, 'action'), { CallSid: callSid, DialCallStatus: 'no-answer' })).body).toBe(vm.body);
    expect(await missedItems(agent.userId, c.id)).toHaveLength(1);

    // the caller leaves a message: the call becomes a voicemail, stored encrypted and transcribed
    const rec = sid('RE');
    const recPath = hookPath(vm.body, 'recordingStatusCallback');
    expect((await twilio(w, recPath, { CallSid: callSid, RecordingSid: rec, RecordingStatus: 'completed', RecordingDuration: '14', RecordingSource: 'RecordVerb' })).statusCode).toBe(200);
    expect((await callRow(callSid)).status).toBe('voicemail');
    expect((await missedItems(agent.userId, c.id))[0]!.reasons[0]!.text).toBe('Left a voicemail');
    expect((await twilio(w, hookPath(vm.body, 'action'), { CallSid: callSid, RecordingSid: rec })).body).toContain('Your message was saved');
    await runJobs(h, w.tenantId, ['comms.recording_copy']);
    const stored = (await h.su.query('SELECT id, status, consent_basis, duration_s, provider_copy_deleted_at FROM recordings WHERE call_id = $1', [(await callRow(callSid)).id])).rows[0]!;
    expect(stored).toMatchObject({ status: 'stored', consent_basis: 'announced_all_parties', duration_s: 14 });
    expect(stored.provider_copy_deleted_at).not.toBeNull();
    await runJobs(h, w.tenantId, ['comms.transcribe']);
    expect((await h.su.query('SELECT status FROM transcripts WHERE recording_id = $1', [stored.id])).rows[0]).toEqual({ status: 'ready' });
    // the final status after the voicemail keeps it a voicemail (never "completed" as if answered)
    await twilio(w, '/webhooks/telephony/voice', { CallSid: callSid, From: c.phone, To: w.mainNumber, CallStatus: 'completed', CallDuration: '40', Direction: 'inbound' });
    expect(await callRow(callSid)).toMatchObject({ status: 'voicemail', duration_s: 40 });
  });

  it('the caller hangs up while it rings: the final status marks the call missed (feed item), never completed', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent, { consent: false });
    const callSid = sid('CA');
    await ringing(w, callSid, c.phone);
    await twilio(w, '/webhooks/telephony/voice', { CallSid: callSid, From: c.phone, To: w.mainNumber, CallStatus: 'completed', CallDuration: '6', Direction: 'inbound' });
    expect((await callRow(callSid)).status).toBe('no_answer');
    expect(await missedItems(agent.userId, c.id)).toHaveLength(1);
  });

  it('a voicemail callback for a call that was answered (not sent to voicemail) is refused and deleted at the provider', async () => {
    const agent = w.agents[0]!;
    const c = await ownedContact(agent, { consent: false });
    const callSid = sid('CA');
    const twiml = (await ringing(w, callSid, c.phone)).body;
    const ref = new URL(/url="([^"]+)"/.exec(twiml)![1]!.replace(/&amp;/g, '&')).searchParams.get('c')!;
    await twilio(w, `/webhooks/telephony/voice/accept?c=${ref}`, { CallSid: sid('CA'), ParentCallSid: callSid, Digits: '1' });
    const rec = sid('RE');
    await twilio(w, `/webhooks/telephony/recording?vm=${ref}`, { CallSid: callSid, RecordingSid: rec, RecordingDuration: '9' });
    await runJobs(h, w.tenantId, ['comms.recording_copy']);
    expect((await h.su.query('SELECT 1 FROM recordings WHERE provider_recording_ref = $1', [rec])).rows).toHaveLength(0);
    expect(h.providers.telephony.deletedRecordings).toContain(rec);
    expect((await callRow(callSid)).status).toBe('in_progress');
  });
});

describe('inbound call: unknown callers and nobody to ring', () => {
  it('an unknown caller rings the on-duty target of the routing rules (the rule member with a verified phone), never a member without one', async () => {
    const callSid = sid('CA');
    const from = randomPhone();
    const twiml = (await ringing(w, callSid, from)).body;
    expect(twiml).toContain(`>${ownerPhone}</Number>`);
    const row = await callRow(callSid);
    expect(row.ring_user_id).toBe(w.agents[0]!.userId);
    // agent_user_id ("who was on the call") is set only when someone accepts
    expect(row.agent_user_id).toBeNull();
    expect((await h.su.query('SELECT display_name FROM contacts WHERE id = $1', [row.contact_id])).rows[0].display_name).toMatch(/^Unknown /);
  });

  it('a contact whose owner has no verified phone and a team with no routing rule: straight to voicemail, and the missed call is still in the owner\'s feed', async () => {
    const agent = w.agents[1]!; // no verified phone
    const c = await ownedContact(agent, { consent: false });
    await suFixture(h, [{ text: 'UPDATE routing_rules SET enabled = false WHERE tenant_id = $1', values: [w.tenantId] }]);
    try {
      const callSid = sid('CA');
      const twiml = (await ringing(w, callSid, c.phone)).body;
      expect(twiml).not.toContain('<Dial');
      expect(twiml).toContain('<Record ');
      expect(await callRow(callSid)).toMatchObject({ status: 'no_answer', handled_by: 'voicemail', ring_user_id: null, recording_mode: 'off' });
      expect(await missedItems(agent.userId, c.id)).toHaveLength(1);
    } finally {
      await suFixture(h, [{ text: 'UPDATE routing_rules SET enabled = true WHERE tenant_id = $1', values: [w.tenantId] }]);
    }
  });

  it('a blocked caller ID gets a short spoken reason and a hangup; nothing is stored', async () => {
    const callSid = sid('CA');
    const r = await twilio(w, '/webhooks/telephony/voice', { CallSid: callSid, From: 'anonymous', To: w.mainNumber, CallStatus: 'ringing', Direction: 'inbound' });
    expect(r.body).toContain('without blocking your number');
    expect(r.body).toContain('<Hangup/>');
    expect(await callRow(callSid)).toBeUndefined();
  });
});

describe('inbound call references are signed and tenant-bound', () => {
  it('a forged call ref is refused (422); a valid ref signed by ANOTHER tenant\'s subaccount changes nothing', async () => {
    expect((await twilio(w, '/webhooks/telephony/voice/accept?c=AAAA', { CallSid: sid('CA'), Digits: '1' })).statusCode).toBe(422);
    const c = await ownedContact(w.agents[0]!, { consent: false });
    const callSid = sid('CA');
    const twiml = (await ringing(w, callSid, c.phone)).body;
    const acceptPath = hookPath(twiml, 'url').replace('/voice/screen', '/voice/accept');
    // tenant B's subaccount signs a request carrying tenant A's call ref
    const cross = await twilio(w2, acceptPath, { CallSid: sid('CA'), ParentCallSid: callSid, Digits: '1' });
    expect(cross.body).toContain('<Hangup/>');
    expect((await twilio(w2, hookPath(twiml, 'action'), { CallSid: callSid, DialCallStatus: 'no-answer' })).body).not.toContain('<Record');
    expect((await callRow(callSid)).status).toBe('ringing');
    // and an unsigned request never reaches the handler
    const unsigned = await h.app.inject({ method: 'POST', url: `/api${acceptPath}`, headers: { 'content-type': 'application/x-www-form-urlencoded' }, payload: 'Digits=1' });
    expect(unsigned.statusCode).toBe(403);
  });
});

describe('voice settings (Owner/Admin)', () => {
  it('the ring timeout and greeting are set by an Admin, audited, used by the next call; agents cannot change them; a stale version is 409', async () => {
    const before = await call<{ settings: { version: number; ringTimeoutSeconds: number; voicemailGreeting: string | null; defaultGreeting: string; recordingNotice: string } }>(w.owner, 'GET', '/voice-settings');
    expect(before.status).toBe(200);
    expect(before.body.settings).toMatchObject({ version: 0, ringTimeoutSeconds: DEFAULT_RING_TIMEOUT_S, voicemailGreeting: null, recordingNotice: VOICEMAIL_NOTICE });
    expect((await call(w.agents[0]!, 'PUT', '/voice-settings', { version: 0, ringTimeoutSeconds: 30, voicemailGreeting: null })).status).toBe(404);
    expect((await call(w.owner, 'PUT', '/voice-settings', { version: 0, ringTimeoutSeconds: 4, voicemailGreeting: null })).status).toBe(422);
    const greeting = 'Thanks for calling the Harbor team. Leave a message & we will call you back.';
    const put = await call<{ settings: { version: number; ringTimeoutSeconds: number; voicemailGreeting: string } }>(w.owner, 'PUT', '/voice-settings', { version: 0, ringTimeoutSeconds: 35, voicemailGreeting: greeting });
    expect(put.status).toBe(200);
    expect(put.body.settings).toMatchObject({ version: 1, ringTimeoutSeconds: 35, voicemailGreeting: greeting });
    expect((await call(w.owner, 'PUT', '/voice-settings', { version: 0, ringTimeoutSeconds: 40, voicemailGreeting: null })).code).toBe('VERSION_CONFLICT');
    const audit = (await h.su.query("SELECT changes FROM audit_log WHERE tenant_id = $1 AND action = 'settings.changed' AND entity_type = 'voice_settings'", [w.tenantId])).rows;
    expect(audit).toHaveLength(1);
    expect(audit[0].changes).toMatchObject({ ring_timeout_seconds: { from: DEFAULT_RING_TIMEOUT_S, to: 35 }, voicemail_greeting: { changed: true } });

    const c = await ownedContact(w.agents[0]!, { consent: false });
    const callSid = sid('CA');
    const twiml = (await ringing(w, callSid, c.phone)).body;
    expect(twiml).toContain('timeout="35"');
    const vm = (await twilio(w, hookPath(twiml, 'action'), { CallSid: callSid, DialCallStatus: 'no-answer' })).body;
    expect(vm).toContain('Thanks for calling the Harbor team. Leave a message &amp; we will call you back.');
    // the recording notice cannot be edited away
    expect(vm).toContain(VOICEMAIL_NOTICE);
  });
});

describe('the same flow with the fake provider (shared webhook secret)', () => {
  let hf: ApiHarness;
  let wf: CommsWorld;
  beforeAll(async () => {
    hf = await createApiHarness();
    wf = await commsWorld(hf, { agents: 1 });
    const ch = await wf.agents[0]!.post('/api/me/alert-phone', { phone: randomPhone() });
    const code = hf.providers.telephony.verificationCodes.at(-1)!.code;
    await wf.agents[0]!.post('/api/me/alert-phone/verify', { challenge: (ch.json() as { challenge: string }).challenge, code });
  });
  afterAll(async () => {
    await hf?.close();
  });

  it('rings, then voicemail on no answer; signed with TELEPHONY_WEBHOOK_SECRET', async () => {
    const c = await ownedContact(wf.agents[0]!, { consent: false });
    const callSid = sid('CA');
    const r = await telephonyWebhook(hf, '/webhooks/telephony/voice', { CallSid: callSid, From: c.phone, To: wf.mainNumber, CallStatus: 'ringing', Direction: 'inbound' });
    expect(r.body).toContain('<Dial ');
    const m = /action="([^"]+)"/.exec(r.body)!;
    const u = new URL(m[1]!.replace(/&amp;/g, '&'));
    const vm = await telephonyWebhook(hf, u.pathname.replace(/^\/api/, '') + u.search, { CallSid: callSid, DialCallStatus: 'no-answer' });
    expect(vm.body).toContain('<Record ');
    expect((await hf.su.query('SELECT status FROM calls WHERE provider_call_ref = $1', [callSid])).rows[0]).toEqual({ status: 'no_answer' });
  });
});
