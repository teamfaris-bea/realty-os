// Real TelephonyProvider and CarrierLookup over the Twilio REST API (TELEPHONY_PROVIDER=twilio).
//
// Accounts. The platform's MASTER account (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN) creates one subaccount
// per tenant (ARCHITECTURE §7) and sends account-security codes and line-type lookups. Everything a tenant
// does (numbers, messages, calls, recordings, 10DLC status) runs with that tenant's subaccount SID and auth
// token, which the caller decrypted from provider_credentials as the system actor.
//
// SMS/MMS. POST Messages.json with a StatusCallback (comms passes ?m={message id}). Twilio has no submit
// idempotency key, so `lookupMessage` reconciles a lost submit (R-GATE-8) by listing recent messages
// From→To and matching the body inside the dispatch window; it answers only when exactly one matches.
//
// Click-to-call. POST Calls.json rings the AGENT first (To = agent phone, From = tenant number). When the
// agent answers, inline TwiML <Dial>s the client from the tenant number. <Number url> is fetched when the
// client answers: comms answers it with the recording announcement (R-CONSENT-16) and records that it was
// played. Recording is requested only when there is no announcement to make or an answer URL exists to
// make it; otherwise the call goes unrecorded (E47's safe direction). VERIFY on a live test call that the
// recording starts after the announcement in your account's configuration.
//
// Recordings: fetched as WAV with the subaccount credentials, then deleted at Twilio once our encrypted
// copy is stored (deleteRecording). Line type: Lookup v2 line_type_intelligence.
import { ProviderError, type CallRequest, type CarrierLookup, type LineType, type ProviderMessageStatus, type SmsRequest, type SubmitHint, type TelephonyAccount, type TelephonyProvider } from '../types.js';
import { TwilioHttp, type TwilioCreds, type TwilioHttpOptions, assertSid, isSid } from './http.js';

export interface TwilioOptions extends TwilioHttpOptions {
  /** master account */
  accountSid: string;
  authToken: string;
  /** public base URL of the API (webhook URLs configured on purchased numbers) */
  publicBaseUrl: string;
  /** sender for account-security codes: an E.164 number or a Messaging Service SID (MG…) of the master account */
  platformSender?: string;
  /** ISO country for number search (default US) */
  numberCountry?: string;
  apiBase?: string;
  lookupsBase?: string;
  messagingBase?: string;
}

export function mapTwilioMessageStatus(s: unknown): ProviderMessageStatus {
  switch (String(s ?? '').toLowerCase()) {
    case 'accepted':
    case 'scheduled':
    case 'queued':
    case 'sending':
      return 'queued';
    case 'sent':
      return 'sent';
    case 'delivered':
    case 'read':
      return 'delivered';
    case 'undelivered':
      return 'undelivered';
    case 'failed':
    case 'canceled':
      return 'failed';
    default:
      return 'unknown';
  }
}

export function mapTwilioLineType(t: unknown): LineType {
  switch (String(t ?? '')) {
    case 'mobile':
      return 'mobile';
    case 'landline':
      return 'landline';
    case 'fixedVoip':
    case 'nonFixedVoip':
      return 'voip';
    default:
      return 'unknown';
  }
}

const xml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const E164 = /^\+[1-9][0-9]{6,14}$/;

function e164(v: string, code: string): string {
  if (!E164.test(v)) throw new ProviderError('rejected', code);
  return v;
}

/** The inline TwiML of the agent leg: say what is happening, then bridge the client. */
export function bridgeTwiml(r: Pick<CallRequest, 'from' | 'to' | 'record' | 'recordingAnnouncement' | 'answerUrl' | 'recordingStatusCallbackUrl' | 'statusCallbackUrl'>): string {
  const announce = !!r.recordingAnnouncement;
  const record = r.record && (!announce || !!r.answerUrl);
  const dialAttrs = [`callerId="${xml(e164(r.from, 'TWILIO_FROM_INVALID'))}"`, 'timeout="30"'];
  if (record) {
    dialAttrs.push('record="record-from-answer-dual"');
    if (r.recordingStatusCallbackUrl) dialAttrs.push(`recordingStatusCallback="${xml(r.recordingStatusCallbackUrl)}"`, 'recordingStatusCallbackMethod="POST"', 'recordingStatusCallbackEvent="completed"');
  }
  const numAttrs: string[] = [];
  if (r.answerUrl) numAttrs.push(`url="${xml(r.answerUrl)}"`, 'method="POST"');
  if (r.statusCallbackUrl) numAttrs.push(`statusCallback="${xml(r.statusCallbackUrl)}"`, 'statusCallbackMethod="POST"', 'statusCallbackEvent="completed"');
  return `<?xml version="1.0" encoding="UTF-8"?><Response><Say>Connecting your call.</Say><Dial ${dialAttrs.join(' ')}><Number${numAttrs.length ? ' ' + numAttrs.join(' ') : ''}>${xml(e164(r.to, 'TWILIO_TO_INVALID'))}</Number></Dial></Response>`;
}

/** TwiML that plays the announcement to the answering client (comms serves it from the answer URL). */
export function announcementTwiml(announcement: string | null): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${announcement ? `<Say>${xml(announcement)}</Say>` : ''}</Response>`;
}

export class TwilioTelephony implements TelephonyProvider {
  private readonly http: TwilioHttp;
  private readonly master: TwilioCreds;
  private readonly api: string;
  private readonly messaging: string;

  constructor(private readonly opts: TwilioOptions) {
    this.http = new TwilioHttp(opts);
    this.master = { sid: assertSid('AC', opts.accountSid), token: opts.authToken };
    this.api = (opts.apiBase ?? 'https://api.twilio.com').replace(/\/$/, '');
    this.messaging = (opts.messagingBase ?? 'https://messaging.twilio.com').replace(/\/$/, '');
  }

  private creds(a: TelephonyAccount): TwilioCreds {
    return { sid: assertSid('AC', a.accountRef), token: a.secret };
  }

  private acct(sid: string, path: string): string {
    return `${this.api}/2010-04-01/Accounts/${sid}/${path}`;
  }

  private hook(path: string): string {
    return new URL(`/api/webhooks/telephony/${path}`, this.opts.publicBaseUrl).toString();
  }

  async createSubaccount(tenantId: string, friendlyName: string) {
    void tenantId; // never sent to the vendor
    const r = await this.http.request(this.master, 'POST', `${this.api}/2010-04-01/Accounts.json`, { form: { FriendlyName: friendlyName.slice(0, 64) } });
    const sid = String(r?.json?.sid ?? '');
    const token = String(r?.json?.auth_token ?? '');
    if (!isSid('AC', sid) || !token) throw new ProviderError('unavailable', 'TWILIO_BAD_RESPONSE');
    return { accountRef: sid, secret: token };
  }

  async sendSms(r: SmsRequest) {
    const c = this.creds(r.account);
    const res = await this.http.request(c, 'POST', this.acct(c.sid, 'Messages.json'), {
      submit: true,
      form: { From: e164(r.from, 'TWILIO_FROM_INVALID'), To: e164(r.to, 'TWILIO_TO_INVALID'), Body: r.body, StatusCallback: r.statusCallbackUrl },
    });
    const sid = String(res?.json?.sid ?? '');
    // the submit was accepted even if the response is odd: report unknown so it is reconciled, never resent
    if (!isSid('SM', sid)) throw new ProviderError('timeout', 'TWILIO_BAD_RESPONSE');
    return { providerRef: sid, status: mapTwilioMessageStatus(res?.json?.status) };
  }

  async dialCall(r: CallRequest) {
    const c = this.creds(r.account);
    const res = await this.http.request(c, 'POST', this.acct(c.sid, 'Calls.json'), {
      submit: true,
      form: {
        To: e164(r.agentPhone, 'TWILIO_AGENT_PHONE_INVALID'),
        From: e164(r.from, 'TWILIO_FROM_INVALID'),
        Twiml: bridgeTwiml(r),
        Timeout: 30,
        StatusCallback: r.statusCallbackUrl,
        StatusCallbackMethod: r.statusCallbackUrl ? 'POST' : undefined,
      },
    });
    const sid = String(res?.json?.sid ?? '');
    if (!isSid('CA', sid)) throw new ProviderError('timeout', 'TWILIO_BAD_RESPONSE');
    return { providerRef: sid };
  }

  async lookupMessage(account: TelephonyAccount, idempotencyKey: string, hint?: SubmitHint) {
    void idempotencyKey; // Twilio cannot be queried by our key; the hint narrows to one submit
    if (!hint || !E164.test(hint.from) || !E164.test(hint.to)) return null;
    const c = this.creds(account);
    const q = new URLSearchParams({ From: hint.from, To: hint.to, PageSize: '50' });
    const res = await this.http.request(c, 'GET', `${this.acct(c.sid, 'Messages.json')}?${q.toString()}`);
    const list = Array.isArray(res?.json?.messages) ? (res!.json!.messages as Record<string, unknown>[]) : [];
    const lo = hint.dispatchedAt - 60_000;
    const hi = hint.dispatchedAt + 20 * 60_000;
    const matches = list.filter((m) => {
      const t = Date.parse(String(m.date_created ?? ''));
      return Number.isFinite(t) && t >= lo && t <= hi && m.body === hint.body && m.direction !== 'inbound';
    });
    if (matches.length !== 1) return null;
    const m = matches[0]!;
    const sid = String(m.sid ?? '');
    return isSid('SM', sid) ? { providerRef: sid, status: mapTwilioMessageStatus(m.status) } : null;
  }

  async purchaseNumber(account: TelephonyAccount, opts: { areaCode?: string }) {
    const c = this.creds(account);
    const country = /^[A-Z]{2}$/.test(this.opts.numberCountry ?? '') ? this.opts.numberCountry! : 'US';
    const q = new URLSearchParams({ SmsEnabled: 'true', VoiceEnabled: 'true', PageSize: '1' });
    if (opts.areaCode && /^[2-9]\d{2}$/.test(opts.areaCode)) q.set('AreaCode', opts.areaCode);
    const avail = await this.http.request(c, 'GET', `${this.acct(c.sid, `AvailablePhoneNumbers/${country}/Local.json`)}?${q.toString()}`);
    const first = Array.isArray(avail?.json?.available_phone_numbers) ? (avail!.json!.available_phone_numbers as Record<string, unknown>[])[0] : undefined;
    const candidate = String(first?.phone_number ?? '');
    if (!E164.test(candidate)) throw new ProviderError('rejected', 'NO_NUMBERS_AVAILABLE');
    const bought = await this.http.request(c, 'POST', this.acct(c.sid, 'IncomingPhoneNumbers.json'), {
      form: {
        PhoneNumber: candidate,
        SmsUrl: this.hook('sms'),
        SmsMethod: 'POST',
        VoiceUrl: this.hook('voice'),
        VoiceMethod: 'POST',
        StatusCallback: this.hook('voice'),
        StatusCallbackMethod: 'POST',
      },
    });
    const sid = String(bought?.json?.sid ?? '');
    const num = String(bought?.json?.phone_number ?? '');
    if (!isSid('PN', sid) || !E164.test(num)) throw new ProviderError('unavailable', 'TWILIO_BAD_RESPONSE');
    return { e164: num, providerRef: sid };
  }

  async releaseNumber(account: TelephonyAccount, providerRef: string) {
    const c = this.creds(account);
    const r = await this.http.request(c, 'DELETE', this.acct(c.sid, `IncomingPhoneNumbers/${assertSid('PN', providerRef)}.json`), { allow404: true });
    if (r === null) throw new ProviderError('rejected', 'NUMBER_NOT_FOUND');
  }

  /**
   * registrationRef: `MG…/QE…` (A2P 10DLC campaign on a Messaging Service) or `HH…` (toll-free verification).
   * VERIFY the status vocabulary against your Twilio account before launch.
   */
  async senderRegistrationStatus(account: TelephonyAccount, registrationRef: string) {
    const c = this.creds(account);
    if (isSid('HH', registrationRef)) {
      const r = await this.http.request(c, 'GET', `${this.messaging}/v1/Tollfree/Verifications/${registrationRef}`);
      const s = String(r?.json?.status ?? '').toUpperCase();
      return s === 'TWILIO_APPROVED' ? 'approved' : s === 'TWILIO_REJECTED' ? 'rejected' : 'pending';
    }
    const [svc, campaign] = registrationRef.split('/');
    if (!svc || !campaign || !isSid('MG', svc) || !isSid('QE', campaign)) throw new ProviderError('rejected', 'REGISTRATION_REF_INVALID');
    const r = await this.http.request(c, 'GET', `${this.messaging}/v1/Services/${svc}/Compliance/Usa2p/${campaign}`);
    const s = String(r?.json?.campaign_status ?? '').toUpperCase();
    if (s === 'VERIFIED') return 'approved';
    if (s === 'FAILED') return 'rejected';
    if (s === 'SUSPENDED') return 'suspended';
    return 'pending';
  }

  async fetchRecording(account: TelephonyAccount, recordingRef: string) {
    const c = this.creds(account);
    const sid = assertSid('RE', recordingRef);
    const meta = await this.http.request(c, 'GET', this.acct(c.sid, `Recordings/${sid}.json`), { allow404: true });
    if (!meta) throw new ProviderError('rejected', 'RECORDING_NOT_FOUND');
    const audio = await this.http.request(c, 'GET', this.acct(c.sid, `Recordings/${sid}.wav`), { binary: true });
    const seconds = Number(meta.json?.duration ?? 0);
    return { bytes: audio?.bytes ?? new Uint8Array(), contentType: 'audio/wav', durationMs: Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0 };
  }

  async deleteRecording(account: TelephonyAccount, recordingRef: string) {
    const c = this.creds(account);
    await this.http.request(c, 'DELETE', this.acct(c.sid, `Recordings/${assertSid('RE', recordingRef)}.json`), { allow404: true });
  }

  async deliverVerificationCode(r: { to: string; code: string }) {
    const sender = this.opts.platformSender;
    if (!sender) throw new ProviderError('not_configured', 'TWILIO_PLATFORM_SENDER_MISSING');
    const res = await this.http.request(this.master, 'POST', this.acct(this.master.sid, 'Messages.json'), {
      submit: true,
      form: {
        To: e164(r.to, 'TWILIO_TO_INVALID'),
        ...(isSid('MG', sender) ? { MessagingServiceSid: sender } : { From: e164(sender, 'TWILIO_FROM_INVALID') }),
        Body: `Your verification code is ${r.code}. Do not share it with anyone.`,
      },
    });
    const sid = String(res?.json?.sid ?? '');
    if (!isSid('SM', sid)) throw new ProviderError('timeout', 'TWILIO_BAD_RESPONSE');
    return { providerRef: sid };
  }
}

export class TwilioCarrierLookup implements CarrierLookup {
  private readonly http: TwilioHttp;
  private readonly master: TwilioCreds;
  private readonly base: string;
  constructor(opts: Pick<TwilioOptions, 'accountSid' | 'authToken' | 'lookupsBase' | 'fetch' | 'timeoutMs' | 'sleep'>) {
    this.http = new TwilioHttp(opts);
    this.master = { sid: assertSid('AC', opts.accountSid), token: opts.authToken };
    this.base = (opts.lookupsBase ?? 'https://lookups.twilio.com').replace(/\/$/, '');
  }
  async lookup(n: string) {
    const r = await this.http.request(this.master, 'GET', `${this.base}/v2/PhoneNumbers/${encodeURIComponent(e164(n, 'TWILIO_NUMBER_INVALID'))}?Fields=line_type_intelligence`, { allow404: true });
    const lti = (r?.json?.line_type_intelligence ?? null) as { type?: unknown; carrier_name?: unknown } | null;
    return { lineType: mapTwilioLineType(lti?.type), carrier: typeof lti?.carrier_name === 'string' ? lti.carrier_name : null };
  }
}
