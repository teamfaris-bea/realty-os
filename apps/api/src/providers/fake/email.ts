// Deterministic email fakes: contact email (EmailProvider, used only by comms/dispatch.ts) and
// account email to users (AccountMailer: password reset, invites).
import { createHash } from 'node:crypto';
import { type AccountMailer, type EmailProvider, type EmailRequest, ProviderError, type ProviderMessageStatus } from '../types.js';
import type { FakeFailure } from './telephony.js';
import { makeMessageId } from '../email/mime.js';

const ref = (s: string) => 'EM' + createHash('sha256').update(s).digest('hex').slice(0, 30);

export class FakeEmail implements EmailProvider {
  readonly sent: (EmailRequest & { providerRef: string })[] = [];
  private readonly byKey = new Map<string, { providerRef: string; status: ProviderMessageStatus; rfcMessageId?: string }>();
  private failures: FakeFailure[] = [];
  /** domains that pass SPF+DKIM+DMARC (default: none until a test adds them) */
  readonly verifiedDomains = new Set<string>();

  failNext(kind: FakeFailure): void {
    this.failures.push(kind);
  }

  async sendEmail(r: EmailRequest) {
    const prior = this.byKey.get(r.idempotencyKey);
    if (prior) return prior;
    const f = this.failures.shift();
    if (f && f !== 'timeout_after_submit') throw new ProviderError(f);
    // the fake keeps the Message-ID we generate, as a plain SMTP relay does (module 22, R-GMAIL-12)
    let rfcMessageId: string | undefined;
    try {
      rfcMessageId = makeMessageId(r.idempotencyKey, r.from.address);
    } catch {
      rfcMessageId = undefined;
    }
    const out = { providerRef: ref(r.idempotencyKey), status: 'queued' as const, ...(rfcMessageId ? { rfcMessageId } : {}) };
    this.byKey.set(r.idempotencyKey, out);
    this.sent.push({ ...r, providerRef: out.providerRef });
    if (f === 'timeout_after_submit') throw new ProviderError('timeout');
    return out;
  }

  async lookupMessage(idempotencyKey: string) {
    return this.byKey.get(idempotencyKey) ?? null;
  }

  async verifyDomain(domain: string) {
    const d = domain.toLowerCase();
    const ok = this.verifiedDomains.has(d);
    const token = createHash('sha256').update(d).digest('hex').slice(0, 16);
    return {
      domain: d,
      spf: ok,
      dkim: ok,
      dmarc: ok,
      records: [
        { type: 'TXT' as const, name: d, value: 'v=spf1 include:mail.fake.invalid ~all' },
        { type: 'CNAME' as const, name: `rk1._domainkey.${d}`, value: `rk1.${token}.dkim.fake.invalid` },
        { type: 'TXT' as const, name: `_dmarc.${d}`, value: 'v=DMARC1; p=quarantine' },
      ],
    };
  }
}

export class FakeAccountMailer implements AccountMailer {
  readonly sent: { to: string; kind: 'password_reset' | 'invite'; link: string; expiresInMinutes: number }[] = [];
  async deliverAccountEmail(r: { to: string; kind: 'password_reset' | 'invite'; link: string; expiresInMinutes: number }) {
    this.sent.push({ ...r });
  }
  /** Test helper: the last link sent to `to`. */
  lastLink(to: string): string | null {
    for (let i = this.sent.length - 1; i >= 0; i--) if (this.sent[i]!.to.toLowerCase() === to.toLowerCase()) return this.sent[i]!.link;
    return null;
  }
}
