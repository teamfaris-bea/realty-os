// OAuth state and PKCE for the per-person calendar connect (module 34; R-CAL-1). The same stateless design
// as api/integrations/oauthState.ts (a MAC-signed state, the PKCE verifier derived from the server secret,
// never sent anywhere but the token exchange), with its own key label so a calendar state can never be
// replayed as a tenant-connection state or the other way round.
//
//   state = base64url(JSON{v,t,u,p,f,e,n}) "." HMAC-SHA256(key, "calendar-state:" || body)
//     t tenant, u the person connecting (the callback requires the SAME signed-in person), p provider key,
//     f the person's link row fence (updated_at in microseconds, "0" when no row exists), e expiry, n nonce
//
// Single use: the callback writes the link row, which moves its updated_at, so a replayed state is STATE_STALE.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { CALENDAR_PROVIDER_KEYS, type CalendarProviderKey } from './catalog.js';

export const CALENDAR_STATE_TTL_MS = 10 * 60_000;

export interface CalendarOAuthState {
  tenantId: string;
  userId: string;
  provider: CalendarProviderKey;
  fence: string;
  expiresAt: number;
  nonce: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function key(secret: Uint8Array): Buffer {
  return createHmac('sha256', secret).update('realty:calendar:oauth-state-key:v1').digest();
}

function mac(secret: Uint8Array, purpose: string, value: string): string {
  return createHmac('sha256', key(secret)).update(`${purpose}:${value}`).digest('base64url');
}

export function signCalendarState(secret: Uint8Array, s: CalendarOAuthState): string {
  const body = Buffer.from(JSON.stringify({ v: 1, t: s.tenantId, u: s.userId, p: s.provider, f: s.fence, e: s.expiresAt, n: s.nonce })).toString('base64url');
  return `${body}.${mac(secret, 'calendar-state', body)}`;
}

export type CalendarStateCheck = { ok: true; state: CalendarOAuthState } | { ok: false; code: 'STATE_INVALID' | 'STATE_EXPIRED' };

export function verifyCalendarState(secret: Uint8Array, token: string, now: number): CalendarStateCheck {
  const m = /^([A-Za-z0-9_-]{16,2048})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return { ok: false, code: 'STATE_INVALID' };
  const expected = Buffer.from(mac(secret, 'calendar-state', m[1]!), 'base64url');
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
  const u = str('u');
  const p = str('p');
  const f = str('f');
  const n = str('n');
  const e = typeof j.e === 'number' && Number.isSafeInteger(j.e) ? j.e : null;
  if (j.v !== 1 || !t || !u || !UUID.test(t) || !UUID.test(u) || !p || !(CALENDAR_PROVIDER_KEYS as readonly string[]).includes(p) || !f || !/^\d{1,20}$/.test(f) || !n || e === null) {
    return { ok: false, code: 'STATE_INVALID' };
  }
  if (now > e) return { ok: false, code: 'STATE_EXPIRED' };
  return { ok: true, state: { tenantId: t, userId: u, provider: p as CalendarProviderKey, fence: f, expiresAt: e, nonce: n } };
}

export function calendarPkceVerifier(secret: Uint8Array, s: Pick<CalendarOAuthState, 'nonce' | 'userId' | 'provider'>): string {
  return mac(secret, 'calendar-pkce', `${s.nonce}:${s.userId}:${s.provider}`);
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}
