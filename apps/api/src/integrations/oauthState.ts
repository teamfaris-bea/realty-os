// OAuth state and PKCE for the connect flow (R-INT-3, E160). Stateless by design: 0018 has no table for
// pending OAuth flows, and the plan forbids schema changes from modules, so the state is a MAC-signed
// token and the PKCE verifier is DERIVED from a server secret (never sent to the browser or provider).
//
//   state = base64url(JSON{v,t,c,u,k,a,f,e,n}) "." HMAC-SHA256(key, "oauth-state:" || body)
//     t tenant, c connection row, u the Owner/Admin who started, k kind, a the external account the
//     person asked to connect, f the row's updated_at fence (microseconds), e expiry (epoch ms), n nonce
//   code_verifier = base64url(HMAC-SHA256(key, "oauth-pkce:" || n || ":" || c))   (43 chars)
//
// Single use: the callback requires the row's updated_at to equal `f`; the callback's own write (success
// or refusal) moves updated_at, so a replayed state is refused (STATE_STALE). A forged or altered state
// fails the MAC; an expired one fails `e`. The tenant comes only from a verified state (resolver result),
// never from request input (R-TEN-3).
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { ConnectionKind } from '../providers/integrations/types.js';
import { CONNECTION_KINDS } from '../providers/integrations/types.js';

export const STATE_TTL_MS = 10 * 60_000;

export interface OAuthState {
  tenantId: string;
  connectionId: string;
  userId: string;
  kind: ConnectionKind;
  externalAccountId: string;
  /** integration_connections.updated_at in microseconds since the epoch, as a decimal string */
  fence: string;
  expiresAt: number;
  nonce: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function stateKey(secret: Uint8Array): Buffer {
  return createHmac('sha256', secret).update('realty:integrations:oauth-state-key:v1').digest();
}

function mac(secret: Uint8Array, purpose: string, value: string): string {
  return createHmac('sha256', stateKey(secret)).update(`${purpose}:${value}`).digest('base64url');
}

export function signState(secret: Uint8Array, s: OAuthState): string {
  const body = Buffer.from(JSON.stringify({ v: 1, t: s.tenantId, c: s.connectionId, u: s.userId, k: s.kind, a: s.externalAccountId, f: s.fence, e: s.expiresAt, n: s.nonce })).toString('base64url');
  return `${body}.${mac(secret, 'oauth-state', body)}`;
}

export type StateCheck = { ok: true; state: OAuthState } | { ok: false; code: 'STATE_INVALID' | 'STATE_EXPIRED' };

export function verifyState(secret: Uint8Array, token: string, now: number): StateCheck {
  const m = /^([A-Za-z0-9_-]{16,2048})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return { ok: false, code: 'STATE_INVALID' };
  const expected = Buffer.from(mac(secret, 'oauth-state', m[1]!), 'base64url');
  const got = Buffer.from(m[2]!, 'base64url');
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) return { ok: false, code: 'STATE_INVALID' };
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(Buffer.from(m[1]!, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    return { ok: false, code: 'STATE_INVALID' };
  }
  const str = (k: string) => (typeof j[k] === 'string' ? (j[k] as string) : null);
  const t = str('t');
  const c = str('c');
  const u = str('u');
  const k = str('k');
  const a = str('a');
  const f = str('f');
  const n = str('n');
  const e = typeof j.e === 'number' && Number.isSafeInteger(j.e) ? j.e : null;
  if (j.v !== 1 || !t || !c || !u || !UUID.test(t) || !UUID.test(c) || !UUID.test(u) || !k || !(CONNECTION_KINDS as readonly string[]).includes(k) || !a || !f || !/^\d{1,20}$/.test(f) || !n || e === null) {
    return { ok: false, code: 'STATE_INVALID' };
  }
  if (now > e) return { ok: false, code: 'STATE_EXPIRED' };
  return { ok: true, state: { tenantId: t, connectionId: c, userId: u, kind: k as ConnectionKind, externalAccountId: a, fence: f, expiresAt: e, nonce: n } };
}

/** The PKCE verifier of a flow: derived, never stored, never sent anywhere but the token exchange. */
export function pkceVerifier(secret: Uint8Array, s: Pick<OAuthState, 'nonce' | 'connectionId'>): string {
  return mac(secret, 'oauth-pkce', `${s.nonce}:${s.connectionId}`);
}

export function pkceChallengeOf(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}
