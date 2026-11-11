// Mailgun email events (JSON webhooks), and their verification.
//
//   Mailgun → Sending → Webhooks: each event type posts to POST /webhooks/email/mailgun/events as
//   { "signature": { "timestamp", "token", "signature" }, "event-data": { … } }.
//
// Verification (the webhook guard): signature = hex HMAC-SHA256(MAILGUN_WEBHOOK_SIGNING_KEY,
// timestamp + token), compared in constant time, with timestamp within ±SIGNATURE_TOLERANCE_S. Inside
// that window a replay is a duplicate: the event id is event-data.id (idempotency in webhook_events).
//
// Our signed ref travels as the custom variable realty_ref (X-Mailgun-Variables on the SMTP send) and
// comes back as event-data["user-variables"].realty_ref.
//
// Field names follow Mailgun's public documentation. VERIFY against a live account before launch: an
// event this file does not know is reported as 'ignored', never guessed.
import { createHmac } from 'node:crypto';
import { constantTimeEqual } from '../../crypto/primitives.js';
import type { NormalizedEmailEvent, NormalizedEventType } from './inbound.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

export function mailgunSignature(signingKey: string, timestamp: string, token: string): string {
  return createHmac('sha256', signingKey).update(timestamp + token, 'utf8').digest('hex');
}

/** True iff body.signature is Mailgun's HMAC over timestamp + token with a timestamp inside the window. */
export function verifyMailgunSignature(signingKey: string | undefined, body: unknown, nowS: number, toleranceS: number): boolean {
  if (!signingKey) return false;
  const s = obj(obj(body).signature);
  const timestamp = typeof s.timestamp === 'number' ? String(s.timestamp) : str(s.timestamp);
  const token = str(s.token);
  const signature = str(s.signature);
  if (!/^\d{1,12}$/.test(timestamp) || !/^[A-Za-z0-9]{1,256}$/.test(token) || !/^[0-9a-f]{64}$/.test(signature)) return false;
  if (Math.abs(nowS - Number(timestamp)) > toleranceS) return false;
  return constantTimeEqual(mailgunSignature(signingKey, timestamp, token), signature);
}

/** One Mailgun webhook (a verified body). Null when it carries no event-data. */
export function parseMailgunEvent(body: unknown): NormalizedEmailEvent | null {
  const b = obj(body);
  const e = obj(b['event-data']);
  const ev = str(e.event);
  const id = str(e.id) || str(obj(b.signature).token);
  if (!ev || !id) return null;
  let type: NormalizedEventType;
  let code: string | null = null;
  const status = obj(e['delivery-status']);
  const smtp = typeof status.code === 'number' || typeof status.code === 'string' ? String(status.code) : '';
  switch (ev) {
    case 'failed': {
      const severity = str(e.severity);
      type = severity === 'permanent' ? 'bounced' : 'ignored';
      code = `mailgun:failed:${severity || '?'}/${str(e.reason) || '?'}${smtp ? `/${smtp}` : ''}`;
      break;
    }
    case 'complained':
      type = 'complained';
      break;
    case 'unsubscribed':
      type = 'unsubscribed';
      break;
    case 'delivered':
      type = 'delivered';
      break;
    case 'opened':
      type = 'opened';
      break;
    case 'clicked':
      type = 'clicked';
      break;
    case 'rejected':
      type = 'failed';
      code = `mailgun:rejected${str(obj(e.reject).reason) ? `:${str(obj(e.reject).reason)}` : ''}`;
      break;
    default:
      type = 'ignored';
  }
  const ts = typeof e.timestamp === 'number' ? e.timestamp : Number(e.timestamp);
  const ref = str(obj(e['user-variables']).realty_ref) || null;
  return { eventId: `mailgun:${id}`.slice(0, 200), ref, type, occurredAt: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : null, code: code ? code.slice(0, 120) : null };
}
