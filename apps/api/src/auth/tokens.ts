// Opaque tokens, CSRF tokens and hashed rate-limit keys.
//
// - Session / reset / invite tokens: 32 random bytes, base64url in the cookie or link; only
//   sha256(token bytes) is stored (sessions.token_hash, auth_tokens.token_hash, invites.token_hash).
// - CSRF: x-csrf-token = HMAC-SHA256(server secret, session_id), base64url (ARCHITECTURE §3 step 4).
// - Rate-limit and auth-event keys are HMACs with the server secret, never raw emails or IPs.
import { base64url, constantTimeEqual, fromBase64url, hmacSha256, hmacSha256Hex, randomBytes, sha256 } from '../crypto/primitives.js';

export function newOpaqueToken(): { token: string; hash: Uint8Array } {
  const raw = randomBytes(32);
  return { token: base64url(raw), hash: sha256(raw) };
}

/** sha256 of the token's bytes, or null when the token is not 32 bytes of base64url. */
export function opaqueTokenHash(token: string | undefined | null): Uint8Array | null {
  if (typeof token !== 'string' || token.length !== 43) return null;
  const raw = fromBase64url(token);
  if (!raw || raw.length !== 32) return null;
  return sha256(raw);
}

export function csrfTokenFor(secret: Uint8Array, sessionId: string): string {
  return base64url(hmacSha256(secret, `csrf:v1:${sessionId.toLowerCase()}`));
}

export function csrfTokenValid(secret: Uint8Array, sessionId: string, presented: unknown): boolean {
  if (typeof presented !== 'string' || presented.length === 0 || presented.length > 128) return false;
  return constantTimeEqual(csrfTokenFor(secret, sessionId), presented);
}

/** `kind:<64 hex>` (auth_attempts.key CHECK `^[a-z_]+:[0-9a-f]{64}$`). */
export function rateKey(secret: Uint8Array, kind: string, ...parts: string[]): string {
  if (!/^[a-z_]+$/.test(kind)) throw new TypeError('rate key kind must be [a-z_]+');
  return `${kind}:${hmacSha256Hex(secret, `rate:${kind}:${parts.map((p) => p.toLowerCase()).join('\u0000')}`)}`;
}

/** auth_events.email_attempted_hash: keyed hash of the normalized email (never plaintext). */
export function emailAttemptHash(secret: Uint8Array, email: string): string {
  return hmacSha256Hex(secret, `email:${email.trim().toLowerCase()}`);
}
