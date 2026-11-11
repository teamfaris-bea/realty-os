// Inbound lead-email shapes, normalized (pure). The webhook guard authenticated the request first.
//
//   generic   our signed JSON format (X-Realty-Signature, EMAIL_WEBHOOK_SECRET): the shape the fake email provider
//             posts, and the one a bridge in front of any real provider would post. The `dkim` array IS the
//             receiving provider's verdict (in tests and the fake: the simulated receiving server's).
//   postmark  Postmark inbound webhook JSON (Basic auth). DKIM verdict: ONLY the topmost Authentication-Results
//             header, and only when its authserv-id equals LEAD_EMAIL_AUTHSERV_ID (RFC 8601 §5: a receiver adds
//             its own header on top; anything below it may be the sender's). Without the setting, no verdict
//             (every Postmark lead email is held). VERIFY: whether Postmark adds Authentication-Results with DKIM
//             results to inbound JSON, and its authserv-id.
//   sendgrid  SendGrid Inbound Parse, default mode (multipart, Basic auth). DKIM verdict: the `dkim` form field
//             SendGrid itself computes, e.g. `{@zillow.com : pass}`. VERIFY the exact field format.
// Attachments are never read, decoded, stored or fetched; links are never followed. HTML is converted to text by
// the parser (linear, capped).
import { createHash } from 'node:crypto';
import { addressList, bareAddress, parseHeaderBlock } from '../providers/email/inbound.js';
import { type DkimVerdict, normalizeDomain } from './trust.js';

export type ProviderFormat = 'generic' | 'postmark' | 'sendgrid';

export interface LeadEmailInbound {
  format: ProviderFormat;
  /** the provider's message id (Postmark MessageID; the Message-ID header; a content digest as a last resort) */
  messageId: string;
  /** the RFC 5322 From address (bare), or null when absent / more than one */
  from: string | null;
  recipients: string[];
  subject: string | null;
  text: string | null;
  html: string | null;
  /** the RECEIVING provider's DKIM results (never read from the message's own headers) */
  dkim: DkimVerdict[];
}

/** Every text field is capped here, before anything else looks at it. */
export const MAX_FIELD_CHARS = 200_000;
const cap = (s: unknown, n = MAX_FIELD_CHARS): string | null => (typeof s === 'string' && s.length > 0 ? s.slice(0, n) : null);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const uniq = (xs: string[]) => [...new Set(xs.map((x) => x.trim().toLowerCase()).filter(Boolean))].slice(0, 50);

function singleFrom(raw: string): string | null {
  const list = addressList(raw.slice(0, 2000));
  return list.length === 1 ? list[0]! : null;
}

function digestId(parts: unknown[]): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(parts)).digest('hex')}`;
}

function verdict(domain: unknown, result: unknown): DkimVerdict | null {
  if (typeof domain !== 'string' || typeof result !== 'string') return null;
  const d = normalizeDomain(domain.replace(/^@/, ''));
  if (!d || d.length > 253 || !/^[a-z0-9.-]+$/.test(d)) return null;
  return { domain: d, result: result.trim().toLowerCase().slice(0, 20) };
}

/** Our generic signed shape. Null when malformed. */
export function parseGenericLeadEmail(body: unknown): LeadEmailInbound | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const messageId = str(b.messageId).trim();
  if (!messageId || messageId.length > 300) return null;
  const to = Array.isArray(b.to) ? b.to.map(str) : [str(b.to)];
  const dkim = Array.isArray(b.dkim) ? b.dkim.slice(0, 20).map((v) => verdict((v as Record<string, unknown>)?.domain, (v as Record<string, unknown>)?.result)).filter((v): v is DkimVerdict => v !== null) : [];
  return { format: 'generic', messageId, from: singleFrom(str(b.from)), recipients: uniq(to.flatMap((t) => addressList(t))), subject: cap(b.subject, 998), text: cap(b.text), html: cap(b.html), dkim };
}

/**
 * The topmost Authentication-Results header's DKIM results, if its authserv-id is the configured one.
 * `Authentication-Results: mx.example; dkim=pass header.d=zillow.com header.s=s1; spf=pass ...` (RFC 8601).
 */
export function dkimFromAuthResults(headerValues: readonly string[], authservId: string | null): DkimVerdict[] {
  if (!authservId || headerValues.length === 0) return [];
  const top = headerValues[0]!.slice(0, 4000);
  const parts = top.split(';').map((p) => p.trim());
  const id = (parts[0] ?? '').split(/\s+/)[0] ?? '';
  if (id.toLowerCase() !== authservId.toLowerCase()) return [];
  const out: DkimVerdict[] = [];
  for (const p of parts.slice(1)) {
    const m = /^dkim\s*=\s*([a-z]+)\b(.*)$/i.exec(p);
    if (!m) continue;
    const d = /\bheader\.d\s*=\s*([A-Za-z0-9.-]+)/i.exec(m[2]!) ?? /\bheader\.i\s*=\s*[^@\s]*@([A-Za-z0-9.-]+)/i.exec(m[2]!);
    const v = d ? verdict(d[1], m[1]) : null;
    if (v) out.push(v);
  }
  return out.slice(0, 20);
}

/** Postmark inbound JSON (VERIFY field names against a live account). Null when it is not one. */
export function parsePostmarkLeadEmail(body: unknown, authservId: string | null): LeadEmailInbound | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  const b = body as Record<string, unknown>;
  const messageId = str(b.MessageID).trim();
  if (!messageId || messageId.length > 300) return null;
  const full = (v: unknown) => (Array.isArray(v) ? v.slice(0, 50).map((x) => str((x as Record<string, unknown>)?.Email)) : []);
  const recipients = uniq([str(b.OriginalRecipient), ...full(b.ToFull), ...full(b.CcFull), ...full(b.BccFull), ...addressList(str(b.To).slice(0, 4000))]);
  const auth: string[] = [];
  if (Array.isArray(b.Headers)) {
    for (const h of (b.Headers as Record<string, unknown>[]).slice(0, 500)) if (str(h?.Name).toLowerCase() === 'authentication-results') auth.push(str(h?.Value));
  }
  const fromFull = (b.FromFull ?? {}) as Record<string, unknown>;
  const fromHeader = str(b.From);
  // FromFull is Postmark's parse of the From header; a From header naming several addresses is refused
  const from = addressList(fromHeader.slice(0, 2000)).length > 1 ? null : str(fromFull.Email) ? bareAddress(str(fromFull.Email)) : singleFrom(fromHeader);
  return { format: 'postmark', messageId: `postmark:${messageId}`, from, recipients, subject: cap(b.Subject, 998), text: cap(b.TextBody), html: cap(b.HtmlBody), dkim: dkimFromAuthResults(auth, authservId) };
}

/** SendGrid's `dkim` field: `{@zillow.com : pass, @sendgrid.net : pass}` (VERIFY). */
export function dkimFromSendgridField(raw: string): DkimVerdict[] {
  const inner = raw.slice(0, 4000).replace(/^\s*\{/, '').replace(/\}\s*$/, '');
  const out: DkimVerdict[] = [];
  for (const part of inner.split(',')) {
    const m = /^\s*@?([A-Za-z0-9.-]+)\s*:\s*([a-z]+)\s*$/i.exec(part);
    const v = m ? verdict(m[1], m[2]) : null;
    if (v) out.push(v);
  }
  return out.slice(0, 20);
}

/** SendGrid Inbound Parse form fields (default mode; VERIFY). Null when required fields are missing. */
export function parseSendgridLeadEmail(fields: Record<string, string>): LeadEmailInbound | null {
  const headers = parseHeaderBlock((fields.headers ?? '').slice(0, 64_000));
  let envelope: { to?: unknown } = {};
  try {
    envelope = JSON.parse((fields.envelope ?? '{}').slice(0, 64_000)) as typeof envelope;
  } catch {
    envelope = {};
  }
  const envTo = Array.isArray(envelope.to) ? envelope.to.slice(0, 50).map(str) : [];
  const recipients = uniq([...envTo, ...addressList((fields.to ?? '').slice(0, 4000)), ...addressList((fields.cc ?? '').slice(0, 4000))]);
  if (recipients.length === 0) return null;
  // the header From (RFC 5322.From) is what alignment is about, never the SMTP envelope sender
  const from = singleFrom(fields.from ?? headers.From ?? '');
  const mid = (headers['Message-ID'] ?? headers['Message-Id'] ?? headers['message-id'] ?? '').trim();
  const messageId = mid && mid.length <= 300 ? `sendgrid:${mid}` : `sendgrid:${digestId([from, recipients, fields.subject ?? '', (fields.text ?? '').slice(0, 10_000)])}`;
  return { format: 'sendgrid', messageId, from, recipients, subject: cap(fields.subject, 998), text: cap(fields.text), html: cap(fields.html), dkim: dkimFromSendgridField(fields.dkim ?? '') };
}

// ---- inbound addresses ---------------------------------------------------------------------------------

/** 160-bit lowercase hex key: case-insensitive mail systems cannot corrupt it. */
export const KEY_RE = /^[0-9a-f]{40}$/;

export function inboundAddress(key: string, domain: string): string {
  return `leads+${key}@${domain}`;
}

/** The key of the first recipient shaped `leads+<key>@<our inbound domain>`, or null. */
export function keyFromRecipients(recipients: readonly string[], domain: string | null): string | null {
  if (!domain) return null;
  for (const r of recipients) {
    const m = /^leads\+([0-9a-f]{40})@([a-z0-9.-]+)$/.exec(r.trim().toLowerCase());
    if (m && m[2] === domain.toLowerCase()) return m[1]!;
  }
  return null;
}
