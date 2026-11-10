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

export function unsubscribeUrl(publicBaseUrl: string, secret: Uint8Array, tenantId: string, messageId: string): string {
  const v = `${tenantId}.${messageId}`;
  return new URL(`/api/email/unsubscribe/${v}.${linkMac(secret, 'unsubscribe', v)}`, publicBaseUrl).toString();
}

export function verifyUnsubscribeToken(secret: Uint8Array, token: string): { tenantId: string; messageId: string } | null {
  const m = /^([0-9a-f-]{36})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{32})$/.exec(token);
  if (!m) return null;
  const v = `${m[1]}.${m[2]}`;
  const expected = linkMac(secret, 'unsubscribe', v);
  if (expected.length !== m[3]!.length) return null;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ m[3]!.charCodeAt(i);
  return diff === 0 ? { tenantId: m[1]!, messageId: m[2]! } : null;
}

export function renderHumanBody(body: string, o: { channel: 'sms' | 'email'; purpose: 'marketing' | 'informational'; identity: RenderIdentity; unsubscribe: string | null }): string {
  const text = body.trim();
  if (o.channel === 'sms') {
    if (o.purpose === 'marketing' && !containsName(text, o.identity.brokerageLegalName)) return `${text}\n— ${o.identity.brokerageLegalName}`;
    return text;
  }
  const footer = [o.identity.brokerageLegalName, ...(o.identity.postalAddress ? [o.identity.postalAddress] : [])];
  if (o.purpose === 'marketing' && o.unsubscribe) footer.push(`Unsubscribe: ${o.unsubscribe}`);
  return `${text}\n\n--\n${footer.join('\n')}`;
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
