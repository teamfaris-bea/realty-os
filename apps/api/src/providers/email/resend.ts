// Resend inbound webhooks (b18 item i; owner 2026-11-14: Resend is the preferred inbound provider, untested; N24).
// Resend signs its webhooks the Standard Webhooks way (it uses Svix): three headers,
//   svix-id / svix-timestamp / svix-signature   (the Standard Webhooks names webhook-id / -timestamp / -signature
//                                                 are accepted too)
// and the signature header is a space-separated list of `v1,<base64 HMAC-SHA256>` over `${id}.${timestamp}.${rawBody}`,
// keyed with the base64 part of the `whsec_…` signing secret. A timestamp more than RESEND_TOLERANCE_S away from now
// is refused (replay protection; inside the window the lead-email pipeline is idempotent on Resend's email id).
//
// VERIFY against a live Resend account before any routing or DNS change (owner: stage and test first):
//   * the header names Resend sends (svix-* as Svix documents; webhook-* accepted in case);
//   * the 5-minute tolerance (Svix's documented default);
//   * the secret format (`whsec_` + base64) and that the HMAC key is the base64-decoded part after the prefix.
// Pure: no I/O, no clock (the caller passes now).
import { createHmac } from 'node:crypto';
import { constantTimeEqual } from '../../crypto/primitives.js';

/** Seconds a Resend delivery's timestamp may be away from now (either way). VERIFY (Svix default 5 minutes). */
export const RESEND_TOLERANCE_S = 300;
const SECRET = /^whsec_([A-Za-z0-9+/]+={0,2})$/;

const header = (h: Record<string, unknown>, name: string): string | null => {
  const v = h[name];
  return typeof v === 'string' && v.length > 0 && v.length <= 4096 ? v : null;
};

/** Verifies a Standard Webhooks / Svix signed delivery. Every malformed input is false, never a throw. */
export function verifyStandardWebhook(secret: string | undefined, headers: Record<string, unknown>, rawBody: string | undefined, nowS: number, toleranceS = RESEND_TOLERANCE_S): boolean {
  if (!secret || rawBody === undefined) return false;
  const m = SECRET.exec(secret);
  if (!m) return false;
  const key = Buffer.from(m[1]!, 'base64');
  if (key.length < 16) return false;
  const id = header(headers, 'svix-id') ?? header(headers, 'webhook-id');
  const ts = header(headers, 'svix-timestamp') ?? header(headers, 'webhook-timestamp');
  const sigs = header(headers, 'svix-signature') ?? header(headers, 'webhook-signature');
  if (id === null || ts === null || sigs === null || !/^\d{1,12}$/.test(ts)) return false;
  if (Math.abs(nowS - Number(ts)) > toleranceS) return false;
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${rawBody}`, 'utf8').digest('base64');
  let ok = false;
  for (const part of sigs.split(' ').slice(0, 10)) {
    const comma = part.indexOf(',');
    if (comma < 0 || part.slice(0, comma) !== 'v1') continue;
    if (constantTimeEqual(part.slice(comma + 1), expected)) ok = true;
  }
  return ok;
}
