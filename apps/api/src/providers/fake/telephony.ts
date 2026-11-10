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
  ProviderError,
  type ProviderMessageStatus,
  type SmsRequest,
  type TelephonyAccount,
  type TelephonyProvider,
} from '../types.js';

const ref = (prefix: string, s: string) => prefix + createHash('sha256').update(s).digest('hex').slice(0, 30);

export type FakeFailure = 'timeout' | 'rejected' | 'unavailable' | 'timeout_after_submit';

export interface FakeSms {
  providerRef: string;
  accountRef: string;
  from: string;
  to: string;
  body: string;
  idempotencyKey: string;
}

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

export class FakeTelephony implements TelephonyProvider {
  readonly sms: FakeSms[] = [];
  readonly calls: FakeCall[] = [];
  readonly verificationCodes: { to: string; code: string; providerRef: string }[] = [];
  readonly numbers = new Map<string, { e164: string; accountRef: string; released: boolean }>();
  private readonly byKey = new Map<string, { providerRef: string; status: ProviderMessageStatus }>();
  private failures: FakeFailure[] = [];
  private numberSeq = 0;
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
    if (f && f !== 'timeout_after_submit') throw new ProviderError(f);
    const out = { providerRef: ref('SM', r.idempotencyKey), status: 'queued' as const };
    this.byKey.set(`sms:${r.idempotencyKey}`, out);
    this.sms.push({ providerRef: out.providerRef, accountRef: r.account.accountRef, from: r.from, to: r.to, body: r.body, idempotencyKey: r.idempotencyKey });
    if (f === 'timeout_after_submit') throw new ProviderError('timeout');
    return out;
  }

  async dialCall(r: CallRequest) {
    const prior = this.byKey.get(`call:${r.idempotencyKey}`);
    if (prior) return { providerRef: prior.providerRef };
    const f = this.takeFailure();
    if (f && f !== 'timeout_after_submit') throw new ProviderError(f);
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

  async lookupMessage(account: TelephonyAccount, idempotencyKey: string) {
    void account;
    return this.byKey.get(`sms:${idempotencyKey}`) ?? null;
  }

  /** Test helper: move a submitted message to a later status (status callbacks are comms' job). */
  setStatus(idempotencyKey: string, status: ProviderMessageStatus): void {
    const m = this.byKey.get(`sms:${idempotencyKey}`);
    if (m) m.status = status;
  }

  async purchaseNumber(account: TelephonyAccount, opts: { areaCode?: string }) {
    this.numberSeq += 1;
    const area = /^[2-9]\d{2}$/.test(opts.areaCode ?? '') ? opts.areaCode! : '555';
    const e164 = `+1${area}${String(2_000_000 + this.numberSeq).padStart(7, '0')}`;
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

  /** recording refs whose provider copy was deleted (after our encrypted copy, or because it may not be kept) */
  readonly deletedRecordings: string[] = [];
  async deleteRecording(account: TelephonyAccount, recordingRef: string) {
    void account;
    if (!this.deletedRecordings.includes(recordingRef)) this.deletedRecordings.push(recordingRef);
  }

  async deliverVerificationCode(r: { to: string; code: string }) {
    const f = this.takeFailure();
    if (f && f !== 'timeout_after_submit') throw new ProviderError(f);
    const providerRef = ref('VC', `${r.to}:${r.code}:${this.verificationCodes.length}`);
    this.verificationCodes.push({ to: r.to, code: r.code, providerRef });
    return { providerRef };
  }
}
