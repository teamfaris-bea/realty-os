// OAuth state and PKCE for the per-user Gmail connect (R-GMAIL-2, R-GMAIL-3, E225; PHASE2_3_PLAN §5.4 #68).
//
//   state = base64url(JSON{v,t,u,d,e,n}) "." HMAC-SHA256(key, "mail-oauth-state:" || body)
//     t tenant, u the user who started (the link is theirs and nobody else's), d the SHA-256 of the disclosure
//     they accepted, e expiry (epoch ms, 10 minutes), n a 128-bit nonce
//   code_verifier = base64url(HMAC-SHA256(key, "mail-oauth-pkce:" || n || ":" || t || ":" || u))   (43 chars)
//
// Its own key purpose (never module 21's), so an integrations state is never a Gmail state and vice versa.
// Single use: the callback consumes the nonce (webhook_events, provider 'gmail_oauth_state', the existing
// replay table) BEFORE anything else happens, so a replayed state is refused whatever the first outcome was. A forged
// or altered state fails the MAC; a state delivered by a browser without the starter's binder cookie (an attacker who
// sends their authorize URL to someone else, so that person's Gmail would land on the attacker's account) is refused; an expired one fails `e`; the verifier is derived from the state, so a code issued
// for one flow cannot be exchanged with another flow's verifier. The tenant and user come only from a verified state.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const MAIL_STATE_TTL_MS = 10 * 60_000;

export interface MailOAuthState {
  tenantId: string;
  userId: string;
  disclosureSha256: string;
  /** SHA-256 hex of the browser binder: a random value set as an HttpOnly cookie in the browser that started the flow */
  binderSha256: string;
  expiresAt: number;
  nonce: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function key(secret: Uint8Array): Buffer {
  return createHmac('sha256', secret).update('realty:mail-sync:oauth-state-key:v1').digest();
}
function mac(secret: Uint8Array, purpose: string, value: string): string {
  return createHmac('sha256', key(secret)).update(`${purpose}:${value}`).digest('base64url');
}

export function newNonce(): string {
  return randomBytes(16).toString('base64url');
}

export function signMailState(secret: Uint8Array, s: MailOAuthState): string {
  const body = Buffer.from(JSON.stringify({ v: 1, t: s.tenantId, u: s.userId, d: s.disclosureSha256, b: s.binderSha256, e: s.expiresAt, n: s.nonce })).toString('base64url');
  return `${body}.${mac(secret, 'mail-oauth-state', body)}`;
}

export type MailStateCheck = { ok: true; state: MailOAuthState } | { ok: false; code: 'STATE_INVALID' | 'STATE_EXPIRED' };

export function verifyMailState(secret: Uint8Array, token: string, now: number): MailStateCheck {
  const m = /^([A-Za-z0-9_-]{16,2048})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return { ok: false, code: 'STATE_INVALID' };
  const expected = Buffer.from(mac(secret, 'mail-oauth-state', m[1]!), 'base64url');
  const got = Buffer.from(m[2]!, 'base64url');
  // canonical encoding only: a different last character that decodes to the same bytes is still a different state
  if (got.toString('base64url') !== m[2]) return { ok: false, code: 'STATE_INVALID' };
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return { ok: false, code: 'STATE_INVALID' };
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return { ok: false, code: 'STATE_INVALID' };
  }
  const t = typeof j.t === 'string' ? j.t : '';
  const u = typeof j.u === 'string' ? j.u : '';
  const d = typeof j.d === 'string' ? j.d : '';
  const n = typeof j.n === 'string' ? j.n : '';
  const b = typeof j.b === 'string' ? j.b : '';
  const e = typeof j.e === 'number' && Number.isSafeInteger(j.e) ? j.e : null;
  if (j.v !== 1 || !UUID.test(t) || !UUID.test(u) || !/^[0-9a-f]{64}$/.test(d) || !/^[0-9a-f]{64}$/.test(b) || !/^[A-Za-z0-9_-]{16,64}$/.test(n) || e === null) return { ok: false, code: 'STATE_INVALID' };
  if (now > e) return { ok: false, code: 'STATE_EXPIRED' };
  return { ok: true, state: { tenantId: t, userId: u, disclosureSha256: d, binderSha256: b, expiresAt: e, nonce: n } };
}

/** The PKCE verifier of a flow: derived, never stored, never sent anywhere but the token exchange. */
export function mailPkceVerifier(secret: Uint8Array, s: Pick<MailOAuthState, 'nonce' | 'tenantId' | 'userId'>): string {
  return mac(secret, 'mail-oauth-pkce', `${s.nonce}:${s.tenantId}:${s.userId}`);
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** The replay-table key of a state (webhook_events.provider_event_id): its nonce's hash, never the nonce itself. */
export function stateReplayKey(s: Pick<MailOAuthState, 'nonce'>): string {
  return createHash('sha256').update(`mail-oauth-state:${s.nonce}`).digest('hex');
}

/** A fresh browser binder (the cookie value) and its hash (carried in the state). */
export function newBinder(): { binder: string; sha256: string } {
  const binder = randomBytes(32).toString('base64url');
  return { binder, sha256: binderHash(binder) };
}
export function binderHash(binder: string): string {
  return createHash('sha256').update(`mail-oauth-binder:${binder}`).digest('hex');
}
/** Does the cookie the callback received bind this state to the browser that started it? (timing-safe) */
export function binderMatches(s: Pick<MailOAuthState, 'binderSha256'>, cookie: string | null | undefined): boolean {
  if (typeof cookie !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(cookie)) return false;
  const a = Buffer.from(binderHash(cookie), 'hex');
  const b = Buffer.from(s.binderSha256, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
