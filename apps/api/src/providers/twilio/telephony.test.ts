// Twilio adapter against a mocked HTTP API (no live calls: the test network cannot reach Twilio).
import { describe, expect, it } from 'vitest';
import { ProviderError } from '../types.js';
import { telephonySignature } from '../webhooks.js';
import { TwilioCarrierLookup, TwilioTelephony, announcementTwiml, bridgeTwiml, mapTwilioMessageStatus } from './telephony.js';

const MASTER = 'AC' + '1'.repeat(32);
const SUB = 'AC' + '2'.repeat(32);
const account = { accountRef: SUB, secret: 'sub-token-secret' };
const hex = (c: string) => c.repeat(32);

interface Seen {
  method: string;
  url: URL;
  auth: string;
  form: URLSearchParams;
}

/** A scripted fetch: each call takes the next response (status + JSON, or a thrown error). */
function mock(responses: ({ status: number; json?: unknown; bytes?: Uint8Array } | Error)[]) {
  const seen: Seen[] = [];
  const f = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    seen.push({ method: init?.method ?? 'GET', url, auth: String((init?.headers as Record<string, string>).authorization), form: new URLSearchParams(String(init?.body ?? '')) });
    const r = responses.shift();
    if (!r) throw new Error('unexpected request');
    if (r instanceof Error) throw r;
    if (r.bytes) return new Response(r.bytes, { status: r.status, headers: { 'content-type': 'audio/wav' } });
    return new Response(r.json === undefined ? null : JSON.stringify(r.json), { status: r.status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { f, seen };
}

const tw = (f: typeof fetch, o: Partial<ConstructorParameters<typeof TwilioTelephony>[0]> = {}) =>
  new TwilioTelephony({ accountSid: MASTER, authToken: 'master-token', publicBaseUrl: 'https://api.example.test', fetch: f, sleep: async () => undefined, liveRequests: true, ...o });

const basic = (sid: string, token: string) => `Basic ${Buffer.from(`${sid}:${token}`).toString('base64')}`;

describe("Twilio's webhook signature scheme", () => {
  it("matches Twilio's published example (URL + sorted key/value pairs, HMAC-SHA1, base64)", () => {
    // Twilio security docs: auth token 12345, https://mycompany.com/myapp.php?foo=1&bar=2
    const params = { CallSid: 'CA1234567890ABCDE', Caller: '+12349013030', Digits: '1234', From: '+12349013030', To: '+18005551212' };
    expect(telephonySignature('12345', 'https://mycompany.com/myapp.php?foo=1&bar=2', params)).toBe('0/KCTR6DLpKmkAf8muzZqo1nDgQ=');
  });
});

describe('TwilioTelephony (mocked REST API)', () => {
  it('sendSms posts From/To/Body/StatusCallback with the SUBACCOUNT credentials and maps the status', async () => {
    const m = mock([{ status: 201, json: { sid: 'SM' + hex('a'), status: 'queued' } }]);
    const r = await tw(m.f).sendSms({ account, from: '+14155550100', to: '+14155550123', body: 'Hi there', idempotencyKey: 'msg-1', statusCallbackUrl: 'https://api.example.test/api/webhooks/telephony/status?m=msg-1' });
    expect(r).toEqual({ providerRef: 'SM' + hex('a'), status: 'queued' });
    expect(m.seen[0]!.method).toBe('POST');
    expect(m.seen[0]!.url.toString()).toBe(`https://api.twilio.com/2010-04-01/Accounts/${SUB}/Messages.json`);
    expect(m.seen[0]!.auth).toBe(basic(SUB, 'sub-token-secret'));
    expect(Object.fromEntries(m.seen[0]!.form)).toEqual({ From: '+14155550100', To: '+14155550123', Body: 'Hi there', StatusCallback: 'https://api.example.test/api/webhooks/telephony/status?m=msg-1' });
  });

  it('a recipient who texted STOP (Twilio 21610) is a rejected submit with code 21610, which dispatch treats as an opt-out', async () => {
    const m = mock([{ status: 400, json: { code: 21610, message: 'Attempt to send to unsubscribed recipient +14155550123', status: 400 } }]);
    const e = await tw(m.f).sendSms({ account, from: '+14155550100', to: '+14155550123', body: 'x', idempotencyKey: 'k' }).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ProviderError);
    expect(e).toMatchObject({ kind: 'rejected', providerCode: '21610' });
    expect((e as Error).message).not.toContain('+1415'); // vendor messages (with numbers) are never surfaced
  });

  it('a submit is never retried: a 5xx or a dropped connection is `timeout` (unknown, reconcile); a refused connection is a safe failure', async () => {
    const a = mock([{ status: 503, json: { code: 20503 } }]);
    await expect(tw(a.f).sendSms({ account, from: '+14155550100', to: '+14155550123', body: 'x', idempotencyKey: 'k' })).rejects.toMatchObject({ kind: 'timeout', providerCode: 'TWILIO_HTTP_503' });
    expect(a.seen).toHaveLength(1);
    const b = mock([new TypeError('fetch failed')]);
    await expect(tw(b.f).dialCall({ account, from: '+14155550100', agentPhone: '+14155550111', to: '+14155550123', idempotencyKey: 'c', record: false })).rejects.toMatchObject({ kind: 'timeout' });
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } });
    const c = mock([refused]);
    await expect(tw(c.f).sendSms({ account, from: '+14155550100', to: '+14155550123', body: 'x', idempotencyKey: 'k' })).rejects.toMatchObject({ kind: 'unavailable' });
    const d = mock([{ status: 401, json: { code: 20003 } }]);
    await expect(tw(d.f).sendSms({ account, from: '+14155550100', to: '+14155550123', body: 'x', idempotencyKey: 'k' })).rejects.toMatchObject({ kind: 'not_configured', providerCode: 'TWILIO_AUTH' });
  });

  it('safe reads retry 5xx/429 twice; malformed SIDs never reach a URL path', async () => {
    const m = mock([{ status: 500 }, { status: 429 }, { status: 200, json: { sid: 'RE' + hex('b'), duration: '42' } }, { status: 200, bytes: new Uint8Array([1, 2, 3]) }]);
    const rec = await tw(m.f).fetchRecording(account, 'RE' + hex('b'));
    expect(rec).toEqual({ bytes: new Uint8Array([1, 2, 3]), contentType: 'audio/wav', durationMs: 42_000 });
    expect(m.seen.map((s) => s.url.pathname)).toEqual([
      `/2010-04-01/Accounts/${SUB}/Recordings/RE${hex('b')}.json`,
      `/2010-04-01/Accounts/${SUB}/Recordings/RE${hex('b')}.json`,
      `/2010-04-01/Accounts/${SUB}/Recordings/RE${hex('b')}.json`,
      `/2010-04-01/Accounts/${SUB}/Recordings/RE${hex('b')}.wav`,
    ]);
    const none = mock([]);
    await expect(tw(none.f).fetchRecording(account, '../../Accounts/AC0/Messages')).rejects.toMatchObject({ kind: 'rejected', providerCode: 'TWILIO_RE_SID_INVALID' });
    await expect(tw(none.f).sendSms({ account: { accountRef: 'AC1/../x', secret: 's' }, from: '+14155550100', to: '+14155550123', body: 'x', idempotencyKey: 'k' })).rejects.toMatchObject({ providerCode: 'TWILIO_AC_SID_INVALID' });
    expect(none.seen).toHaveLength(0);
  });

  it('deleteRecording deletes the provider copy (an already-deleted one is fine)', async () => {
    const m = mock([{ status: 204 }, { status: 404, json: { code: 20404 } }]);
    await tw(m.f).deleteRecording(account, 'RE' + hex('c'));
    await tw(m.f).deleteRecording(account, 'RE' + hex('c'));
    expect(m.seen.map((s) => s.method)).toEqual(['DELETE', 'DELETE']);
  });

  it('dialCall rings the agent first and bridges the client from the tenant number with inline TwiML; recording + announcement on the client answer URL', async () => {
    const m = mock([{ status: 201, json: { sid: 'CA' + hex('d') } }]);
    const r = await tw(m.f).dialCall({
      account,
      from: '+14155550100',
      agentPhone: '+14155550111',
      to: '+14155550123',
      idempotencyKey: 'call-1',
      record: true,
      recordingAnnouncement: 'This call may be recorded.',
      statusCallbackUrl: 'https://api.example.test/api/webhooks/telephony/voice',
      answerUrl: 'https://api.example.test/api/webhooks/telephony/answer?c=abc&x=1',
      recordingStatusCallbackUrl: 'https://api.example.test/api/webhooks/telephony/recording',
    });
    expect(r).toEqual({ providerRef: 'CA' + hex('d') });
    const f = Object.fromEntries(m.seen[0]!.form);
    expect(f).toMatchObject({ To: '+14155550111', From: '+14155550100', StatusCallback: 'https://api.example.test/api/webhooks/telephony/voice' });
    expect(f.Twiml).toContain('<Dial callerId="+14155550100" timeout="30" record="record-from-answer-dual" recordingStatusCallback="https://api.example.test/api/webhooks/telephony/recording"');
    expect(f.Twiml).toContain('<Number url="https://api.example.test/api/webhooks/telephony/answer?c=abc&amp;x=1" method="POST"');
    expect(f.Twiml).toContain('>+14155550123</Number>');
  });

  it('E47: an announced recording without an answer URL to announce it is not requested; record=false never records', () => {
    const base = { from: '+14155550100', to: '+14155550123' };
    expect(bridgeTwiml({ ...base, record: true, recordingAnnouncement: 'This call may be recorded.' })).not.toContain('record=');
    expect(bridgeTwiml({ ...base, record: false })).not.toContain('record=');
    expect(bridgeTwiml({ ...base, record: true })).toContain('record="record-from-answer-dual"'); // one-party, no announcement owed
    expect(() => bridgeTwiml({ from: '+14155550100', to: '"/><Hangup/>', record: false })).toThrow(ProviderError);
    expect(announcementTwiml('Calls <may> be "recorded"')).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Say>Calls &lt;may&gt; be &quot;recorded&quot;</Say></Response>');
    expect(announcementTwiml(null)).toBe('<?xml version="1.0" encoding="UTF-8"?><Response></Response>');
  });

  it('R-GATE-8 reconciliation: a lost submit is found only when exactly one outbound message matches sender, recipient, body and the dispatch window', async () => {
    const t0 = Date.parse('2026-11-10T15:00:00Z');
    const msg = (sid: string, body: string, at: number, status = 'delivered') => ({ sid, body, status, direction: 'outbound-api', date_created: new Date(at).toUTCString() });
    const hint = { from: '+14155550100', to: '+14155550123', body: 'Hello', dispatchedAt: t0 };
    const one = mock([{ status: 200, json: { messages: [msg('SM' + hex('e'), 'Hello', t0 + 2_000), msg('SM' + hex('f'), 'Other', t0 + 3_000), msg('SM' + hex('9'), 'Hello', t0 - 3_600_000)] } }]);
    expect(await tw(one.f).lookupMessage(account, 'm1', hint)).toEqual({ providerRef: 'SM' + hex('e'), status: 'delivered' });
    expect(Object.fromEntries(one.seen[0]!.url.searchParams)).toEqual({ From: '+14155550100', To: '+14155550123', PageSize: '50' });
    const two = mock([{ status: 200, json: { messages: [msg('SM' + hex('e'), 'Hello', t0 + 2_000), msg('SM' + hex('f'), 'Hello', t0 + 4_000)] } }]);
    expect(await tw(two.f).lookupMessage(account, 'm1', hint)).toBeNull(); // ambiguous: never guess
    expect(await tw(mock([]).f).lookupMessage(account, 'm1')).toBeNull(); // no hint: cannot be queried by key
  });

  it('purchaseNumber searches local SMS+voice numbers and points their webhooks at the API', async () => {
    const m = mock([{ status: 200, json: { available_phone_numbers: [{ phone_number: '+14155550177' }] } }, { status: 201, json: { sid: 'PN' + hex('a'), phone_number: '+14155550177' } }]);
    expect(await tw(m.f).purchaseNumber(account, { areaCode: '415' })).toEqual({ e164: '+14155550177', providerRef: 'PN' + hex('a') });
    expect(m.seen[0]!.url.pathname).toBe(`/2010-04-01/Accounts/${SUB}/AvailablePhoneNumbers/US/Local.json`);
    expect(m.seen[0]!.url.searchParams.get('AreaCode')).toBe('415');
    expect(Object.fromEntries(m.seen[1]!.form)).toMatchObject({ PhoneNumber: '+14155550177', SmsUrl: 'https://api.example.test/api/webhooks/telephony/sms', VoiceUrl: 'https://api.example.test/api/webhooks/telephony/voice' });
    await expect(tw(mock([{ status: 200, json: { available_phone_numbers: [] } }]).f).purchaseNumber(account, {})).rejects.toMatchObject({ providerCode: 'NO_NUMBERS_AVAILABLE' });
  });

  it('createSubaccount uses the MASTER credentials and returns the new SID + token; sender registration maps 10DLC and toll-free statuses', async () => {
    const m = mock([{ status: 201, json: { sid: SUB, auth_token: 'new-sub-token' } }]);
    expect(await tw(m.f).createSubaccount('tenant-uuid', 'tenant-0001')).toEqual({ accountRef: SUB, secret: 'new-sub-token' });
    expect(m.seen[0]!.auth).toBe(basic(MASTER, 'master-token'));
    expect(m.seen[0]!.form.get('FriendlyName')).toBe('tenant-0001');
    const campaign = `MG${hex('a')}/QE${hex('b')}`;
    for (const [s, want] of [['VERIFIED', 'approved'], ['FAILED', 'rejected'], ['SUSPENDED', 'suspended'], ['IN_PROGRESS', 'pending']] as const) {
      const r = mock([{ status: 200, json: { campaign_status: s } }]);
      expect(await tw(r.f).senderRegistrationStatus(account, campaign)).toBe(want);
      expect(r.seen[0]!.url.toString()).toBe(`https://messaging.twilio.com/v1/Services/MG${hex('a')}/Compliance/Usa2p/QE${hex('b')}`);
    }
    expect(await tw(mock([{ status: 200, json: { status: 'TWILIO_APPROVED' } }]).f).senderRegistrationStatus(account, 'HH' + hex('c'))).toBe('approved');
    await expect(tw(mock([]).f).senderRegistrationStatus(account, 'nonsense')).rejects.toMatchObject({ providerCode: 'REGISTRATION_REF_INVALID' });
  });

  it('verification codes go from the platform sender on the master account (Messaging Service or number); none configured fails closed', async () => {
    const m = mock([{ status: 201, json: { sid: 'SM' + hex('1') } }]);
    await tw(m.f, { platformSender: 'MG' + hex('7') }).deliverVerificationCode({ to: '+14155550123', code: '482913' });
    expect(m.seen[0]!.auth).toBe(basic(MASTER, 'master-token'));
    expect(Object.fromEntries(m.seen[0]!.form)).toMatchObject({ To: '+14155550123', MessagingServiceSid: 'MG' + hex('7') });
    expect(m.seen[0]!.form.get('Body')).toContain('482913');
    await expect(tw(mock([]).f).deliverVerificationCode({ to: '+14155550123', code: '1' })).rejects.toMatchObject({ kind: 'not_configured' });
  });

  it('status vocabulary maps onto ours', () => {
    expect(['accepted', 'queued', 'sending', 'sent', 'delivered', 'read', 'undelivered', 'failed', 'canceled', 'weird'].map(mapTwilioMessageStatus)).toEqual(['queued', 'queued', 'queued', 'sent', 'delivered', 'delivered', 'undelivered', 'failed', 'failed', 'unknown']);
  });
});

describe('TwilioCarrierLookup', () => {
  it('maps Lookup v2 line_type_intelligence onto mobile/landline/voip/unknown', async () => {
    for (const [type, want] of [['mobile', 'mobile'], ['landline', 'landline'], ['nonFixedVoip', 'voip'], ['fixedVoip', 'voip'], ['tollFree', 'unknown']] as const) {
      const m = mock([{ status: 200, json: { line_type_intelligence: { type, carrier_name: 'Carrier X' } } }]);
      const l = new TwilioCarrierLookup({ accountSid: MASTER, authToken: 't', fetch: m.f, sleep: async () => undefined, liveRequests: true });
      expect(await l.lookup('+14155550123')).toEqual({ lineType: want, carrier: 'Carrier X' });
      expect(m.seen[0]!.url.toString()).toBe('https://lookups.twilio.com/v2/PhoneNumbers/%2B14155550123?Fields=line_type_intelligence');
    }
  });
});
