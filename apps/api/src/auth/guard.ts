// The session guards installed by server.ts in front of every non-public route (rbac.ts).
//
//   requireSession  valid session (tenant optional) + CSRF on unsafe methods + MFA state
//   requireActor    requireSession + an active tenant ⇒ req.actor (built only from the session)
//
// CSRF (ARCHITECTURE §3 step 4): every non-GET/HEAD/OPTIONS request with a session must carry
// x-csrf-token = HMAC(server secret, session_id); the Origin allowlist check runs earlier, in
// server.ts, for every unsafe request (including public ones such as login).
// MFA (R-PERM-14): a user with MFA enabled must verify it in this session (401 MFA_REQUIRED); an
// Owner/Admin (any role in mfa_required_roles) without MFA gets an enrollment-only session
// (403 MFA_ENROLLMENT_REQUIRED) until enrollment is confirmed. Routes opt into the partial states
// with config.allowPartial.
import type { UserActor } from '@realty/core/foundation';
import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import { AppError } from '../errors.js';
import type { PartialAllowance } from '../rbac.js';
import { tagGuard } from '../rbac.js';
import type { Platform } from '../server.js';
import { type AuthState, actorFor, resolveSession, sessionCookieName } from './sessions.js';
import { csrfTokenValid } from './tokens.js';

declare module 'fastify' {
  interface FastifyRequest {
    authState?: AuthState;
    actor?: UserActor;
    authorizedAction?: string;
  }
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function platformOf(req: FastifyRequest): Platform {
  return req.server.platform;
}

export function sessionToken(req: FastifyRequest): string | undefined {
  const p = platformOf(req);
  return req.cookies?.[sessionCookieName(p.config.cookieSecure)];
}

const resolved = new WeakMap<FastifyRequest, Promise<AuthState | null>>();

/** Resolves (once per request, including a miss) the presented session, or null. */
export async function loadAuthState(req: FastifyRequest): Promise<AuthState | null> {
  if (req.authState) return req.authState;
  let pending = resolved.get(req);
  if (!pending) {
    const p = platformOf(req);
    pending = resolveSession(p.db, sessionToken(req));
    resolved.set(req, pending);
    pending.catch(() => resolved.delete(req));
  }
  const s = await pending;
  if (s) req.authState = s;
  return s;
}

function allowed(req: FastifyRequest, what: PartialAllowance): boolean {
  return (req.routeOptions.config.allowPartial ?? []).includes(what);
}

async function sessionGuard(req: FastifyRequest): Promise<AuthState> {
  const s = await loadAuthState(req);
  if (!s) throw new AppError('UNAUTHENTICATED');
  if (!SAFE.has(req.method) && !csrfTokenValid(platformOf(req).config.sessionSecret, s.sessionId, req.headers['x-csrf-token'])) {
    throw new AppError('CSRF_INVALID');
  }
  if (s.mfaEnabled && s.mfaVerifiedAt === null) {
    if (!allowed(req, 'mfa_pending')) throw new AppError('MFA_REQUIRED');
  } else if (s.mfaRequiredForRole && !s.mfaEnabled) {
    if (!allowed(req, 'enrollment')) throw new AppError('MFA_ENROLLMENT_REQUIRED');
  }
  return s;
}

export const requireSession: preHandlerHookHandler = tagGuard(async function requireSession(req) {
  await sessionGuard(req);
}, 'session');

export const requireActor: preHandlerHookHandler = tagGuard(async function requireActor(req) {
  const s = await sessionGuard(req);
  if (s.tenantId === null || s.role === null) throw new AppError('TENANT_REQUIRED');
  req.actor = actorFor({ userId: s.userId, tenantId: s.tenantId, role: s.role, sessionId: s.sessionId });
}, 'actor');
