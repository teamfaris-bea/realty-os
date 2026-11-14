// Deterministic telephony fake (dev + tests). Same inputs ⇒ same outputs: refs are hashes of the
// idempotency key, numbers come from a counter, and nothing depends on the wall clock.
// - Idempotent submits: a second sendSms/dialCall with the same idempotencyKey returns the first
//   result and records no second message (the provider-side dedupe the dispatch protocol relies on).
// - Failure injection: `failNext('timeout' | 'rejected' | 'unavailable')` makes the next outbound
//   call throw ProviderError. With 'timeout_after_submit' the message IS recorded but the call throws
//   a timeout, which is exactly the dispatch_unknown case (R-GATE-8, E7).
import { createHash } from 'node:crypto';
import {
  type CallRequest,
  type MediaRef,
  ProviderError,
  type ProviderMessageStatus,
  type SmsRequest,
  type TelephonyAccount,
  type TelephonyProvider,
} from '../types.js';

const ref = (prefix: string, s: string) => prefix + createHash('sha256').update(s).digest('hex').slice(0, 30);

/** A valid 1×1 PNG (the fake's default MMS media). */
export const FAKE_PNG = new Uint8Array(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64'));

export type FakeFailure = 'timeout' | 'rejected' | 'unavailable' | 'timeout_after_submit' | { kind: ProviderError['kind']; code: string };

/** The ProviderError of an injected failure ({ kind, code }: a provider code, e.g. 21610 or 30032). */
function failure(f: Exclude<FakeFailure, 'timeout_after_submit'>): ProviderError {
  return typeof f === 'string' ? new ProviderError(f) : new ProviderError(f.kind, f.code);
}

export interface FakeSms {
  providerRef: string;
  accountRef: string;
  from: string;
  to: string;
  body: string;
  idempotencyKey: string;
  /** D5a: the media URLs of a photo text, in order (empty for a plain text) */
  mediaUrls: string[];
}

/** Twilio's accepted outbound MMS types (what pullMedia checks a fetched item against). */
const FAKE_MMS_ACCEPTED: Record<string, (b: Uint8Array) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => Buffer.from(b.subarray(0, 8)).toString('hex') === '89504e470d0a1a0a',
  'image/gif': (b) => /^GIF8[79]a$/.test(Buffer.from(b.subarray(0, 6)).toString('latin1')),
  'video/mp4': (b) => Buffer.from(b.subarray(4, 8)).toString('latin1') === 'ftyp',
  'video/quicktime': (b) => Buffer.from(b.subarray(4, 8)).toString('latin1') === 'ftyp',
};

export interface FakeCall {
  providerRef: string;
  accountRef: string;
  from: string;
  agentPhone: string;
  to: string;
  record: boolean;
  recordingAnnouncement: string | null;
  answerUrl: string | null;
  idempotencyKey: string;
}

/** How many fictional numbers (555-0150 to 555-0176) the fake sells in one area code. */
export const FAKE_NUMBERS_PER_AREA = 27;
/**
 * Where the fake goes on once an area code's 27 are sold: every line (555-0100 to 555-0199) of these area codes, in
 * order, shared by every area code asked for. No test writes a number in them (@realty/core/testing RESERVED_AREAS
 * lists them, so bulk test numbers come to them last).
 */
export const FAKE_OVERFLOW_AREAS = ['210', '214', '215', '216', '217'] as const;

export class FakeTelephony implements TelephonyProvider {
  readonly sms: FakeSms[] = [];
  readonly calls: FakeCall[] = [];
  readonly verificationCodes: { to: string; code: string; providerRef: string }[] = [];
  readonly numbers = new Map<string, { e164: string; accountRef: string; released: boolean }>();
  private readonly byKey = new Map<string, { providerRef: string; status: ProviderMessageStatus }>();
  private failures: FakeFailure[] = [];
  /** numbers bought so far, per area code */
  private readonly boughtIn = new Map<string, number>();
  private overflowSold = 0;
  /** registrationRef → status (default 'approved') */
  readonly registrations = new Map<string, 'pending' | 'approved' | 'rejected' | 'suspended'>();

  failNext(kind: FakeFailure): void {
    this.failures.push(kind);
  }

  private takeFailure(): FakeFailure | undefined {
    return this.failures.shift();
  }

  async createSubaccount(tenantId: string, friendlyName: string) {
    void friendlyName;
    return { accountRef: ref('AC', `sub:${tenantId}`), secret: ref('sk_', `secret:${tenantId}`) };
  }

  async sendSms(r: SmsRequest) {
    const prior = this.byKey.get(`sms:${r.idempotencyKey}`);
    if (prior) return prior;
    const f = this.takeFailure();
    if (f && f !== 'timeout_after_submit') throw failure(f);
    const media = [...(r.mediaUrls ?? [])];
    if (media.length > 10) throw new ProviderError('rejected', '21623');
    // a photo text gets an MM ref of Twilio's shape (MM + 32 hex); a plain text keeps the fake's SM ref
    const out = { providerRef: media.length > 0 ? 'MM' + createHash('sha256').update(`mms:${r.idempotencyKey}`).digest('hex').slice(0, 32) : ref('SM', r.idempotencyKey), status: 'queued' as const };
    this.byKey.set(`sms:${r.idempotencyKey}`, out);
    this.sms.push({ providerRef: out.providerRef, accountRef: r.account.accountRef, from: r.from, to: r.to, body: r.body, idempotencyKey: r.idempotencyKey, mediaUrls: media });
    if (media.length > 0) {
      this.sentAt.set(out.providerRef, this.now());
      this.providerMedia.set(out.providerRef, media.map((_, i) => 'ME' + createHash('sha256').update(`${out.providerRef}:${i}`).digest('hex').slice(0, 32)));
    }
    if (f === 'timeout_after_submit') throw new ProviderError('timeout');
    return out;
  }

  async dialCall(r: CallRequest) {
    const prior = this.byKey.get(`call:${r.idempotencyKey}`);
    if (prior) return { providerRef: prior.providerRef };
    const f = this.takeFailure();
    if (f && f !== 'timeout_after_submit') throw failure(f);
    const providerRef = ref('CA', r.idempotencyKey);
    this.byKey.set(`call:${r.idempotencyKey}`, { providerRef, status: 'queued' });
    this.calls.push({
      providerRef,
      accountRef: r.account.accountRef,
      from: r.from,
      agentPhone: r.agentPhone,
      to: r.to,
      record: r.record,
      recordingAnnouncement: r.recordingAnnouncement ?? null,
      answerUrl: r.answerUrl ?? null,
      idempotencyKey: r.idempotencyKey,
    });
    if (f === 'timeout_after_submit') throw new ProviderError('timeout');
    return { providerRef };
  }

  /** D5a test switch: the reconcile lookup finds nothing (so a timeout_after_submit ends DISPATCH_UNKNOWN_UNRESOLVED) */
  lookupMiss = false;

  async lookupMessage(account: TelephonyAccount, idempotencyKey: string) {
    void account;
    if (this.lookupMiss) return null;
    return this.byKey.get(`sms:${idempotencyKey}`) ?? null;
  }

  // ---- D5a: the provider's stored copies of sent media (R-MMS-7) ----

  /** the clock the fake stamps photo texts with (tests may replace it); epoch ms */
  now: () => number = () => Date.now();
  /** MM ref → the ME refs the fake "keeps" for it */
  readonly providerMedia = new Map<string, string[]>();
  private readonly sentAt = new Map<string, number>();
  readonly listMediaCalls: string[] = [];
  readonly listOutboundCalls: { from: string; createdFrom: number; createdTo: number }[] = [];

  async listMessageMedia(account: TelephonyAccount, messageRef: string): Promise<string[]> {
    void account;
    this.listMediaCalls.push(messageRef);
    return (this.providerMedia.get(messageRef) ?? []).filter((me) => !this.deletedMedia.includes(me));
  }

  async listOutboundMediaMessages(account: TelephonyAccount, q: { from: string; createdFrom: number; createdTo: number }): Promise<{ refs: string[]; complete: boolean }> {
    void account;
    this.listOutboundCalls.push({ ...q });
    const refs = this.sms.filter((m) => m.from === q.from && m.mediaUrls.length > 0 && (this.sentAt.get(m.providerRef) ?? -1) >= q.createdFrom && (this.sentAt.get(m.providerRef) ?? Infinity) <= q.createdTo).map((m) => m.providerRef);
    return { refs, complete: true };
  }

  /**
   * Test helper (VERIFY 1): fetch every media URL of the photo text sent with `idempotencyKey` as Twilio is reported
   * to: HEAD, then GET, through `fetch` (tests build it on app.inject). Each must answer 200 with the same
   * Content-Type on both, a type Twilio accepts, and bytes that are that type. Returns the bytes, in order.
   */
  async pullMedia(idempotencyKey: string, fetch: (method: 'HEAD' | 'GET', url: string) => Promise<{ status: number; headers: Record<string, string | undefined>; body: Uint8Array }>): Promise<{ contentType: string; bytes: Uint8Array }[]> {
    const m = this.sms.find((x) => x.idempotencyKey === idempotencyKey);
    if (!m) throw new Error('pullMedia: no such message');
    const out: { contentType: string; bytes: Uint8Array }[] = [];
    for (const url of m.mediaUrls) {
      const head = await fetch('HEAD', url);
      const get = await fetch('GET', url);
      if (head.status !== 200 || get.status !== 200) throw new ProviderError('rejected', '11200');
      const type = String(get.headers['content-type'] ?? '');
      if (type !== String(head.headers['content-type'] ?? '')) throw new ProviderError('rejected', '12300');
      const sniff = FAKE_MMS_ACCEPTED[type];
      if (!sniff || !sniff(get.body)) throw new ProviderError('rejected', '12300');
      out.push({ contentType: type, bytes: get.body });
    }
    return out;
  }

  /** Test helper: move a submitted message to a later status (status callbacks are comms' job). */
  setStatus(idempotencyKey: string, status: ProviderMessageStatus): void {
    const m = this.byKey.get(`sms:${idempotencyKey}`);
    if (m) m.status = status;
  }

  /**
   * b17 (B17R-2): a bought number is fictional, +1 <area> 555-0150 to 555-0176, in the requested area code (else 555),
   * handed out in order per area code. The numbers tests write themselves sit below 555-0150 or from 555-0177 up, so a
   * bought number never equals one of them. Once an area code's 27 are sold, the fake goes on in FAKE_OVERFLOW_AREAS (a
   * test file's harness buys more than 27 team numbers in 415); when those run out too it refuses, as Twilio refuses an
   * area code with nothing left, rather than reuse a number.
   */
  async purchaseNumber(account: TelephonyAccount, opts: { areaCode?: string }) {
    const area = /^[2-9]\d{2}$/.test(opts.areaCode ?? '') ? opts.areaCode! : '555';
    const n = this.boughtIn.get(area) ?? 0;
    let e164: string;
    if (n < FAKE_NUMBERS_PER_AREA) {
      this.boughtIn.set(area, n + 1);
      e164 = `+1${area}55501${50 + n}`;
    } else {
      const k = this.overflowSold;
      const over = FAKE_OVERFLOW_AREAS[Math.floor(k / 100)];
      if (over === undefined) throw new ProviderError('rejected', 'FAKE_NO_NUMBERS_LEFT');
      this.overflowSold = k + 1;
      e164 = `+1${over}55501${String(k % 100).padStart(2, '0')}`;
    }
    const providerRef = ref('PN', `${account.accountRef}:${e164}`);
    this.numbers.set(providerRef, { e164, accountRef: account.accountRef, released: false });
    return { e164, providerRef };
  }

  async releaseNumber(account: TelephonyAccount, providerRef: string) {
    const n = this.numbers.get(providerRef);
    if (!n || n.accountRef !== account.accountRef) throw new ProviderError('rejected', 'NUMBER_NOT_FOUND');
    n.released = true;
  }

  async senderRegistrationStatus(account: TelephonyAccount, registrationRef: string) {
    void account;
    return this.registrations.get(registrationRef) ?? 'approved';
  }

  async fetchRecording(account: TelephonyAccount, recordingRef: string) {
    void account;
    // Deterministic pseudo-audio: 1 KiB derived from the ref.
    const seed = createHash('sha256').update(recordingRef).digest();
    const bytes = new Uint8Array(1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = seed[i % seed.length]!;
    return { bytes, contentType: 'audio/wav', durationMs: 60_000 };
  }

  /** inbound MMS media the fake serves (tests set it); unknown refs get a tiny PNG */
  readonly media = new Map<string, { bytes: Uint8Array; contentType: string } | 'missing'>();
  readonly deletedMedia: string[] = [];
  async fetchMedia(account: TelephonyAccount, ref: MediaRef) {
    void account;
    const m = this.media.get(ref.mediaRef);
    if (m === 'missing') throw new ProviderError('rejected', '20404');
    return m ?? { bytes: FAKE_PNG, contentType: 'image/png' };
  }
  async deleteMedia(account: TelephonyAccount, ref: MediaRef) {
    void account;
    if (!this.deletedMedia.includes(ref.mediaRef)) this.deletedMedia.push(ref.mediaRef);
  }

  /** recording refs whose provider copy was deleted (after our encrypted copy, or because it may not be kept) */
  readonly deletedRecordings: string[] = [];
  async deleteRecording(account: TelephonyAccount, recordingRef: string) {
    void account;
    if (!this.deletedRecordings.includes(recordingRef)) this.deletedRecordings.push(recordingRef);
  }

  async deliverVerificationCode(r: { to: string; code: string }) {
    const f = this.takeFailure();
    if (f && f !== 'timeout_after_submit') throw failure(f);
    const providerRef = ref('VC', `${r.to}:${r.code}:${this.verificationCodes.length}`);
    this.verificationCodes.push({ to: r.to, code: r.code, providerRef });
    return { providerRef };
  }
}
