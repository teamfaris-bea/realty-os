// Inbound-email and email-event webhook formats of common vendors, normalized to the shapes the generic
// comms handlers take (pure functions; the webhook guard authenticates the request first).
//
//   Postmark   inbound JSON (Inbound webhook) and the Delivery / Bounce / SpamComplaint / Open / Click /
//              SubscriptionChange webhooks; our signed ref travels as Metadata.realty_ref
//              (X-PM-Metadata-realty_ref on the SMTP send).
//   SendGrid   Inbound Parse (multipart/form-data, "default" not "raw" mode) and the Event Webhook (JSON
//              array); our ref travels as the unique arg realty_ref (X-SMTPAPI on the SMTP send).
//
// Field names follow the vendors' public documentation. VERIFY against a live account before launch:
// vendors add fields over time, and an event this file does not know is reported as 'ignored', never
// guessed.
import { createHash } from 'node:crypto';

export interface NormalizedInbound {
  /** vendor message id, stable across retries (idempotency) */
  eventId: string;
  from: string;
  /** every recipient address we could find, best first: the routing token is in one of them */
  recipients: string[];
  subject: string | null;
  text: string;
  headers: Record<string, string>;
  /** module 22 (flagged, ISA-2b): every Authentication-Results value the provider reported, in order (Postmark; VERIFY vendor) */
  authResults?: string[];
  /** module 22 (flagged, ISA-2b): SendGrid Inbound Parse's `dkim` field, raw (VERIFY vendor) */
  dkimField?: string;
}

export type NormalizedEventType = 'delivered' | 'bounced' | 'complained' | 'opened' | 'clicked' | 'failed' | 'unsubscribed' | 'ignored';

export interface NormalizedEmailEvent {
  eventId: string;
  /** our signed X-Realty-Ref as echoed by the vendor, or null */
  ref: string | null;
  type: NormalizedEventType;
  occurredAt: string | null;
  /** the vendor's own reason, vendor-prefixed (e.g. `ses:Bounce:Permanent/NoEmail`, `mailgun:failed:permanent/bounce/550`), or null */
  code?: string | null;
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const MAX_TEXT = 200_000;

/** The bare address of `Name <a@b>` or `a@b`; null when there is none. */
export function bareAddress(v: string): string | null {
  const angle = /<([^<>\s]+@[^<>\s]+)>/.exec(v);
  const a = (angle ? angle[1]! : v).trim().replace(/^mailto:/i, '');
  return /^[^\s@<>,;]+@[^\s@<>,;]+$/.test(a) ? a : null;
}

/** Addresses of a header-style list (commas outside quotes and angle brackets). */
export function addressList(v: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  let angle = 0;
  for (const ch of v) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '<') angle++;
    if (!quoted && ch === '>') angle = Math.max(0, angle - 1);
    if (ch === ',' && !quoted && angle === 0) {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out.map(bareAddress).filter((a): a is string => a !== null);
}

/** Raw RFC 5322 header block → map (unfolded; the first occurrence of a name wins). */
export function parseHeaderBlock(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  const lines = raw.replace(/\r\n/g, '\n').split('\n');
  let name: string | null = null;
  let value = '';
  const flush = () => {
    if (name && !(name in out)) out[name] = value.trim();
  };
  for (const line of lines) {
    if (/^[ \t]/.test(line) && name) {
      value += ' ' + line.trim();
      continue;
    }
    flush();
    const m = /^([!-9;-~]+):(.*)$/.exec(line);
    name = m ? m[1]! : null;
    value = m ? m[2]! : '';
  }
  flush();
  return out;
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
    .trim();
}

const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim()).filter(Boolean))];

// ---- Postmark ---------------------------------------------------------------------------------------

/** Postmark inbound webhook JSON. Null when it is not a Postmark inbound payload. */
export function parsePostmarkInbound(body: unknown): NormalizedInbound | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const messageId = str(b.MessageID);
  const fromFull = (b.FromFull ?? {}) as Record<string, unknown>;
  const from = str(fromFull.Email) || bareAddress(str(b.From)) || '';
  if (!messageId || !from) return null;
  const full = (v: unknown) => (Array.isArray(v) ? v.map((x) => str((x as Record<string, unknown>)?.Email)) : []);
  const recipients = uniq([str(b.OriginalRecipient), ...full(b.ToFull), ...full(b.CcFull), ...full(b.BccFull), ...addressList(str(b.To)), ...addressList(str(b.Cc))]);
  const headers: Record<string, string> = {};
  const authResults: string[] = [];
  if (Array.isArray(b.Headers)) {
    for (const h of (b.Headers as Record<string, unknown>[]).slice(0, 500)) {
      const n = str(h?.Name);
      if (n && !(n in headers)) headers[n] = str(h?.Value);
      if (n.toLowerCase() === 'authentication-results') authResults.push(str(h?.Value));
    }
  }
  const text = str(b.TextBody) || htmlToText(str(b.HtmlBody));
  return { eventId: `postmark:${messageId}`, from, recipients, subject: str(b.Subject) || null, text: text.slice(0, MAX_TEXT), headers, ...(authResults.length > 0 ? { authResults } : {}) };
}

const POSTMARK_HARD = new Set(['HardBounce', 'BadEmailAddress', 'ManuallyDeactivated']);
const POSTMARK_SPAM = new Set(['SpamNotification', 'SpamComplaint']);

/** One Postmark webhook (any RecordType). Null when it is not a Postmark event payload. */
export function parsePostmarkEvent(body: unknown): NormalizedEmailEvent | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const record = str(b.RecordType);
  const messageId = str(b.MessageID);
  if (!record || !messageId) return null;
  const meta = (b.Metadata ?? {}) as Record<string, unknown>;
  const ref = str(meta.realty_ref) || null;
  const at = str(b.DeliveredAt) || str(b.BouncedAt) || str(b.ReceivedAt) || str(b.ChangedAt) || null;
  const id = String(b.ID ?? '') || at || '';
  let type: NormalizedEventType = 'ignored';
  if (record === 'Delivery') type = 'delivered';
  else if (record === 'Bounce') type = POSTMARK_HARD.has(str(b.Type)) ? 'bounced' : POSTMARK_SPAM.has(str(b.Type)) ? 'complained' : 'ignored';
  else if (record === 'SpamComplaint') type = 'complained';
  else if (record === 'Open') type = 'opened';
  else if (record === 'Click') type = 'clicked';
  else if (record === 'SubscriptionChange' && b.SuppressSending === true) {
    const reason = str(b.SuppressionReason);
    type = reason === 'HardBounce' ? 'bounced' : reason === 'SpamComplaint' ? 'complained' : 'unsubscribed';
  }
  return { eventId: `postmark:${record}:${messageId}:${id}`.slice(0, 200), ref, type, occurredAt: at && !Number.isNaN(Date.parse(at)) ? new Date(at).toISOString() : null };
}

// ---- SendGrid ---------------------------------------------------------------------------------------

/** SendGrid Inbound Parse (default mode) form fields. Null when required fields are missing. */
export function parseSendgridInbound(fields: Record<string, string>): NormalizedInbound | null {
  const headers = parseHeaderBlock(fields.headers ?? '');
  let envelope: { to?: unknown; from?: unknown } = {};
  try {
    envelope = JSON.parse(fields.envelope ?? '{}') as typeof envelope;
  } catch {
    envelope = {};
  }
  const from = bareAddress(str(envelope.from)) ?? addressList(fields.from ?? '')[0] ?? '';
  const envTo = Array.isArray(envelope.to) ? envelope.to.map(str) : [];
  const recipients = uniq([...envTo, ...addressList(fields.to ?? ''), ...addressList(fields.cc ?? '')]);
  if (!from || recipients.length === 0) return null;
  const text = fields.text || htmlToText(fields.html ?? '');
  const mid = headers['Message-ID'] ?? headers['Message-Id'] ?? headers['message-id'];
  const eventId = mid
    ? `sendgrid:${mid.trim().slice(0, 180)}`
    : `sendgrid:sha256:${createHash('sha256').update(JSON.stringify([from, recipients, fields.subject ?? '', text])).digest('hex')}`;
  return { eventId, from, recipients, subject: fields.subject ?? null, text: text.slice(0, MAX_TEXT), headers, ...(fields.dkim !== undefined ? { dkimField: fields.dkim } : {}) };
}

/** SendGrid Event Webhook: a JSON array of events. Null when the body is not one. */
export function parseSendgridEvents(body: unknown): NormalizedEmailEvent[] | null {
  if (!Array.isArray(body)) return null;
  const out: NormalizedEmailEvent[] = [];
  for (const e of body as Record<string, unknown>[]) {
    if (!e || typeof e !== 'object') continue;
    const id = str(e.sg_event_id);
    const ev = str(e.event);
    if (!id || !ev) continue;
    let type: NormalizedEventType = 'ignored';
    if (ev === 'delivered') type = 'delivered';
    else if (ev === 'bounce') type = str(e.type) === 'blocked' ? 'ignored' : 'bounced';
    else if (ev === 'dropped') type = 'failed';
    else if (ev === 'spamreport') type = 'complained';
    else if (ev === 'unsubscribe' || ev === 'group_unsubscribe') type = 'unsubscribed';
    else if (ev === 'open') type = 'opened';
    else if (ev === 'click') type = 'clicked';
    const ts = typeof e.timestamp === 'number' ? e.timestamp : Number(e.timestamp);
    out.push({ eventId: `sendgrid:${id}`.slice(0, 200), ref: str(e.realty_ref) || null, type, occurredAt: Number.isFinite(ts) && ts > 0 ? new Date(ts * 1000).toISOString() : null });
  }
  return out;
}
