// The client portal's cookie and CSRF token (R-PORTAL-9). Pure: no I/O.
//
// - Cookie `__Host-psid` (`psid` only when SESSION_COOKIE_SECURE=false, plain-http dev): httpOnly, Secure,
//   SameSite=Strict, Path=/, Max-Age = the session's absolute expiry. A staff cookie (`__Host-sid`) is a different
//   name, resolved by a different definer over a different table: neither ever authenticates the other (E148).
// - CSRF: a portal-only key is derived from SESSION_SECRET, key = HMAC-SHA256(secret, "realty:portal-csrf:v1"), and
//   the token is base64url(HMAC-SHA256(key, "portal-csrf:v1:" + sessionId)). The staff token is
//   HMAC(secret, "csrf:v1:" + sessionId) (auth/tokens.ts): another key and another label, so a staff token never
//   validates here, even for a colliding id (E647). Compared in constant time. VERIFY (Q-PORTAL-10): a separate secret.
import { base64url, constantTimeEqual, hmacSha256 } from '../../crypto/primitives.js';

export const portalCookieName = (secure: boolean): string => (secure ? '__Host-psid' : 'psid');

export function portalCookieOptions(secure: boolean, maxAgeSeconds: number) {
  return { httpOnly: true, secure, sameSite: 'strict' as const, path: '/', maxAge: Math.max(0, Math.floor(maxAgeSeconds)) };
}

export function portalCsrfKey(sessionSecret: Uint8Array): Uint8Array {
  return hmacSha256(sessionSecret, 'realty:portal-csrf:v1');
}

export function portalCsrfToken(sessionSecret: Uint8Array, sessionId: string): string {
  return base64url(hmacSha256(portalCsrfKey(sessionSecret), `portal-csrf:v1:${sessionId.toLowerCase()}`));
}

export function portalCsrfValid(sessionSecret: Uint8Array, sessionId: string, presented: unknown): boolean {
  if (typeof presented !== 'string' || presented.length === 0 || presented.length > 128) return false;
  return constantTimeEqual(portalCsrfToken(sessionSecret, sessionId), presented);
}

/** Q-PORTAL-3 / VERIFY 3: the session lengths module 43 stores (0023: idle 24 h, absolute 14 days), shown to the client. */
export const SESSION_POLICY = { idleHours: 24, absoluteDays: 14 } as const;
