// Amazon SES email events delivered by Amazon SNS (HTTPS subscription), and their verification.
//
//   SES configuration set → event destination: SNS topic → HTTPS subscription to
//   POST /webhooks/email/ses/events. SNS posts JSON with Content-Type text/plain.
//
// Verification (the webhook guard calls `snsVerifier.verify` before any handler runs):
//   - Type is Notification, SubscriptionConfirmation or UnsubscribeConfirmation; SignatureVersion 1
//     (SHA1withRSA) or 2 (SHA256withRSA) over AWS's canonical "Key\nValue\n" string (`snsStringToSign`)
//   - the signing certificate is fetched only from an https SigningCertURL on
//     sns.<region>.amazonaws.com(.cn) whose path ends in .pem (no port, no credentials, no redirects),
//     must be inside its validity period, and is cached in memory by URL
//   - TopicArn must be one of SES_SNS_TOPIC_ARNS: anyone can create an SNS topic and have AWS sign
//     its messages, so a valid signature alone proves nothing about the sender
//   - Timestamp is the time SNS first published the message and stays the same on every retry. SNS
//     retries an HTTPS delivery for up to an hour with a custom delivery policy, so the window is
//     SNS_TIMESTAMP_TOLERANCE_S (1 hour) old and SIGNATURE_FUTURE_SKEW_S in the future, not the 5
//     minutes of SIGNATURE_TOLERANCE_S. Inside that window a replay is a duplicate: the event id is
//     the SNS MessageId (idempotency in webhook_events).
//
// SES notifications: both the configuration-set event publishing format (`eventType`) and the
// identity notification format (`notificationType`) are read. Our signed ref comes from the message
// tag realty_ref (X-SES-MESSAGE-TAGS on the SMTP send), else from the X-Realty-Ref header that SES
// includes in mail.headers when "include original headers" is on.
//
// Field names follow AWS's public documentation. VERIFY against a live account before launch: an event
// this file does not know is reported as 'ignored', never guessed.
import { X509Certificate, verify as verifySignature } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import type { NormalizedEmailEvent, NormalizedEventType } from './inbound.js';

export const SNS_TIMESTAMP_TOLERANCE_S = 3600;
const FUTURE_SKEW_S = 30;
const SNS_HOST = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/;
const MAX_CERT_BYTES = 16_384;
const MAX_CACHED_CERTS = 32;
/** our signed ref header (X-Realty-Ref), compared lowercase */
const REALTY_REF_HEADER = 'x-realty-ref';

export type SnsType = 'Notification' | 'SubscriptionConfirmation' | 'UnsubscribeConfirmation';

export interface SnsMessage {
  Type: SnsType;
  MessageId: string;
  TopicArn: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: '1' | '2';
  Signature: string;
  SigningCertURL: string;
  Subject?: string;
  Token?: string;
  SubscribeURL?: string;
}

export type SnsFetch = (url: string, init: { method: 'GET'; redirect: 'error'; signal: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The body as an SNS message (all signed fields present and string-typed), or null. */
export function asSnsMessage(body: unknown): SnsMessage | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const type = str(b.Type);
  if (type !== 'Notification' && type !== 'SubscriptionConfirmation' && type !== 'UnsubscribeConfirmation') return null;
  for (const k of ['MessageId', 'TopicArn', 'Message', 'Timestamp', 'Signature', 'SigningCertURL']) if (typeof b[k] !== 'string') return null;
  if (b.SignatureVersion !== '1' && b.SignatureVersion !== '2') return null;
  if (type !== 'Notification' && (typeof b.Token !== 'string' || typeof b.SubscribeURL !== 'string')) return null;
  return b as unknown as SnsMessage;
}

/** AWS's canonical string to sign: "Key\nValue\n" for each signed key, in this order. */
export function snsStringToSign(m: SnsMessage): string {
  const keys =
    m.Type === 'Notification'
      ? ['Message', 'MessageId', ...(typeof m.Subject === 'string' ? ['Subject'] : []), 'Timestamp', 'TopicArn', 'Type']
      : ['Message', 'MessageId', 'SubscribeURL', 'Timestamp', 'Token', 'TopicArn', 'Type'];
  return keys.map((k) => `${k}\n${(m as unknown as Record<string, string>)[k]}\n`).join('');
}

/** An https URL on an SNS endpoint host (no port, no credentials); `pem` also requires a .pem path. */
export function isSnsUrl(raw: string, pem: boolean): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '' || !SNS_HOST.test(u.hostname)) return false;
  return !pem || (u.pathname.endsWith('.pem') && u.search === '');
}

/** Certificate cache + verification. `fetch` is injectable (tests never touch the network). */
export class SnsVerifier {
  private certs = new Map<string, Promise<X509Certificate | null>>();
  constructor(private fetchImpl: SnsFetch = (url, init) => fetch(url, init)) {}

  /** Test seam: replace the HTTP client (also clears the certificate cache). */
  setFetch(f: SnsFetch): void {
    this.fetchImpl = f;
    this.certs.clear();
  }

  private cert(url: string): Promise<X509Certificate | null> {
    let p = this.certs.get(url);
    if (!p) {
      p = this.download(url);
      if (this.certs.size >= MAX_CACHED_CERTS) this.certs.delete(this.certs.keys().next().value!);
      this.certs.set(url, p);
      // a failed download is not cached: the next delivery tries again
      void p.then((c) => {
        if (!c) this.certs.delete(url);
      });
    }
    return p;
  }

  private async download(url: string): Promise<X509Certificate | null> {
    try {
      const res = await this.fetchImpl(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return null;
      const pem = await res.text();
      if (pem.length > MAX_CERT_BYTES || !pem.includes('-----BEGIN CERTIFICATE-----')) return null;
      return new X509Certificate(pem);
    } catch {
      return null;
    }
  }

  /** True iff `body` is an SNS message for an allowed topic, fresh, and signed by an SNS certificate. */
  async verify(body: unknown, allowedTopics: readonly string[] | undefined, nowMs: number): Promise<boolean> {
    const m = asSnsMessage(body);
    if (!m || !allowedTopics?.includes(m.TopicArn)) return false;
    const t = Date.parse(m.Timestamp);
    if (!Number.isFinite(t) || nowMs - t > SNS_TIMESTAMP_TOLERANCE_S * 1000 || t - nowMs > FUTURE_SKEW_S * 1000) return false;
    if (!isSnsUrl(m.SigningCertURL, true)) return false;
    const cert = await this.cert(m.SigningCertURL);
    if (!cert) return false;
    if (nowMs < Date.parse(cert.validFrom) || nowMs > Date.parse(cert.validTo)) return false;
    const key: KeyObject = cert.publicKey;
    try {
      return verifySignature(m.SignatureVersion === '1' ? 'sha1' : 'sha256', Buffer.from(snsStringToSign(m), 'utf8'), key, Buffer.from(m.Signature, 'base64'));
    } catch {
      return false;
    }
  }

  /**
   * Confirms a (verified) SubscriptionConfirmation by GET to its SubscribeURL, only when that URL is https
   * on an SNS host and the topic is allowed. True when SNS accepted it.
   */
  async confirmSubscription(m: SnsMessage, allowedTopics: readonly string[] | undefined): Promise<boolean> {
    if (m.Type !== 'SubscriptionConfirmation' || !allowedTopics?.includes(m.TopicArn) || !m.SubscribeURL || !isSnsUrl(m.SubscribeURL, false)) return false;
    try {
      const res = await this.fetchImpl(m.SubscribeURL, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(10_000) });
      return res.ok;
    } catch {
      return false;
    }
  }
}

/** The process-wide verifier the webhook guard and the SES route use. */
export const snsVerifier = new SnsVerifier();

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s, (k, v: unknown) => (k === '__proto__' || k === 'constructor' || k === 'prototype' ? undefined : v));
  } catch {
    return null;
  }
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

function sesRef(mail: Record<string, unknown>): string | null {
  const tag = obj(mail.tags).realty_ref;
  if (Array.isArray(tag) && typeof tag[0] === 'string' && tag[0]) return tag[0];
  if (Array.isArray(mail.headers)) {
    for (const h of mail.headers as unknown[]) {
      const x = obj(h);
      if (str(x.name).toLowerCase() === REALTY_REF_HEADER && str(x.value)) return str(x.value).trim();
    }
  }
  return null;
}

const iso = (v: string): string | null => (v && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : null);

/**
 * One SES event from a verified SNS Notification. Null when the Message is not an SES notification.
 * A bounce or complaint can list several recipients, but our ref names our one message (each message we
 * send has one recipient), so one event per notification is right.
 */
export function parseSesNotification(m: SnsMessage): NormalizedEmailEvent | null {
  if (m.Type !== 'Notification') return null;
  const n = obj(safeJson(m.Message));
  const kind = str(n.eventType) || str(n.notificationType);
  const mail = obj(n.mail);
  if (!kind || !str(mail.messageId)) return null;
  let type: NormalizedEventType = 'ignored';
  let code: string | null = null;
  let at = '';
  switch (kind) {
    case 'Bounce': {
      const b = obj(n.bounce);
      type = str(b.bounceType) === 'Permanent' ? 'bounced' : 'ignored';
      code = `ses:Bounce:${str(b.bounceType) || '?'}/${str(b.bounceSubType) || '?'}`;
      at = str(b.timestamp);
      break;
    }
    case 'Complaint': {
      const c = obj(n.complaint);
      type = 'complained';
      code = `ses:Complaint:${str(c.complaintFeedbackType) || str(c.complaintSubType) || 'unspecified'}`;
      at = str(c.timestamp);
      break;
    }
    case 'Delivery':
      type = 'delivered';
      at = str(obj(n.delivery).timestamp);
      break;
    case 'Open':
      type = 'opened';
      at = str(obj(n.open).timestamp);
      break;
    case 'Click':
      type = 'clicked';
      at = str(obj(n.click).timestamp);
      break;
    case 'Reject':
      type = 'failed';
      code = 'ses:Reject';
      break;
    case 'Rendering Failure':
      type = 'failed';
      code = 'ses:RenderingFailure';
      break;
    case 'Subscription': {
      // SES subscription management (contact lists): an opt-out of everything or of any topic blocks
      const s = obj(n.subscription);
      const prefs = obj(s.newTopicPreferences);
      const topics = Array.isArray(prefs.topicSubscriptionStatus) ? (prefs.topicSubscriptionStatus as unknown[]).map((x) => str(obj(x).subscriptionStatus)) : [];
      if (prefs.unsubscribeAll === true || topics.includes('OptOut')) type = 'unsubscribed';
      at = str(s.timestamp);
      break;
    }
    default:
      type = 'ignored';
  }
  return { eventId: `ses:${m.MessageId}`.slice(0, 200), ref: sesRef(mail), type, occurredAt: iso(at) ?? iso(m.Timestamp), code };
}
