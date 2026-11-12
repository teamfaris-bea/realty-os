// Outbound rendering of human-composed messages and the email envelope (R-GATE-12, R-CONSENT-18).
//
// What the gate evaluates is exactly what is sent: the footer is added when the message is created
// (the compose preview shows it), stored in messages.body, and the send-time gate derives its
// rendered facts from that stored body.
//   - marketing SMS: the brokerage legal name is appended when the text does not already carry it
//   - every email: a footer with the brokerage legal name (and postal address when set)
//   - marketing email: plus an unsubscribe link in the body and one-click List-Unsubscribe headers
// The wording is a conservative placeholder. VERIFY WITH COUNSEL (advertising rules, CAN-SPAM).
import { containsName } from '@realty/core/compliance';
import { createHash } from 'node:crypto';
import { linkMac } from './runtime.js';

export interface RenderIdentity {
  brokerageLegalName: string;
  postalAddress: string | null;
}

const uuidBytes = (u: string) => Buffer.from(u.replace(/-/g, ''), 'hex');
const uuidOf = (b: Buffer) => {
  const x = b.toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
};

/**
 * A stateless, purpose-bound reference our own links and provider metadata carry:
 * base64url(tenant uuid ‖ id uuid) "." MAC — 76 characters, so it fits a URL path segment.
 */
export function signedRef(secret: Uint8Array, purpose: string, tenantId: string, id: string): string {
  const body = Buffer.concat([uuidBytes(tenantId), uuidBytes(id)]).toString('base64url');
  return `${body}.${linkMac(secret, purpose, `${tenantId.toLowerCase()}.${id.toLowerCase()}`)}`;
}

export function verifySignedRef(secret: Uint8Array, purpose: string, token: string): { tenantId: string; id: string } | null {
  const m = /^([A-Za-z0-9_-]{43})\.([A-Za-z0-9_-]{32})$/.exec(token);
  if (!m) return null;
  const raw = Buffer.from(m[1]!, 'base64url');
  if (raw.length !== 32) return null;
  const tenantId = uuidOf(raw.subarray(0, 16));
  const id = uuidOf(raw.subarray(16));
  const expected = linkMac(secret, purpose, `${tenantId}.${id}`);
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ m[2]!.charCodeAt(i);
  return diff === 0 ? { tenantId, id } : null;
}

export function unsubscribeUrl(publicBaseUrl: string, secret: Uint8Array, tenantId: string, messageId: string): string {
  return new URL(`/api/email/unsubscribe/${signedRef(secret, 'unsubscribe', tenantId, messageId)}`, publicBaseUrl).toString();
}

/** Header our outbound email carries; the email provider echoes it on delivery/bounce/open events. */
export const EMAIL_REF_HEADER = 'X-Realty-Ref';

export function renderHumanBody(body: string, o: { channel: 'sms' | 'email'; purpose: 'marketing' | 'informational'; identity: RenderIdentity; unsubscribe: string | null; signature?: string | null }): string {
  const text = body.trim();
  if (o.channel === 'sms') {
    if (o.purpose === 'marketing' && !containsName(text, o.identity.brokerageLegalName)) return text === '' ? `— ${o.identity.brokerageLegalName}` : `${text}\n— ${o.identity.brokerageLegalName}`;
    return text;
  }
  const footer = [o.identity.brokerageLegalName, ...(o.identity.postalAddress ? [o.identity.postalAddress] : [])];
  if (o.purpose === 'marketing' && o.unsubscribe) footer.push(`Unsubscribe: ${o.unsubscribe}`);
  // parity module 63 (R-PAR-25): the sender's plain-text signature, above the brokerage footer (never markup)
  const sig = (o.signature ?? '').replace(/\r\n?/g, '\n').trim();
  return `${text}${sig ? `\n\n${sig}` : ''}\n\n--\n${footer.join('\n')}`;
}

/** The deterministic reply token of a conversation (Reply-To r+{token}@in.{host}); only its SHA-256 is stored. */
export function replyToken(secret: Uint8Array, tenantId: string, conversationId: string): string {
  return linkMac(secret, 'reply', `${tenantId}.${conversationId}`);
}

export function replyTokenHash(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

export function replyAddress(publicBaseUrl: string, token: string): string {
  return `r+${token}@in.${new URL(publicBaseUrl).hostname}`;
}

/** The routing token of an inbound email's recipient address, or null. */
export function tokenFromRecipient(address: string): string | null {
  const m = /^r\+([A-Za-z0-9_-]{16,64})@/i.exec(address.trim());
  return m ? m[1]! : null;
}

export function listUnsubscribeHeaders(url: string): Record<string, string> {
  return { 'List-Unsubscribe': `<${url}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' };
}

/** E28: an automatic reply (out-of-office) by its headers (RFC 3834 and common vendor headers). */
export function autoReplyHeader(headers: Record<string, string>): { name: string; value: string } | null {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const auto = lower.get('auto-submitted');
  if (auto && auto.trim().toLowerCase() !== 'no') return { name: 'Auto-Submitted', value: auto.trim() };
  for (const h of ['x-autoreply', 'x-autorespond', 'x-auto-response-suppress']) {
    const v = lower.get(h);
    if (v) return { name: h, value: v.trim() };
  }
  const prec = lower.get('precedence');
  if (prec && /^(auto_reply|auto-reply|bulk|junk)$/i.test(prec.trim())) return { name: 'Precedence', value: prec.trim() };
  return null;
}
