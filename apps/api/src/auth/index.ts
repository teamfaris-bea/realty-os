// Public interface of the auth part of api/platform (BUILD_PLAN module 8).
import type { TenantId, UserId } from '@realty/core/foundation';
import { type Database, getDatabase } from '@realty/db';
import { randomBytes } from 'node:crypto';
import { instant, uuidv7Generator } from '@realty/core/foundation';
import { issueSessionTx, userTenants } from './sessions.js';

export { hashPassword, verifyPassword, checkPasswordPolicy, ARGON2_OPTIONS } from './password.js';
export { requireActor, requireSession, loadAuthState } from './guard.js';
export { type AuthState, actorFor, resolveSession, sessionCookieName } from './sessions.js';
export { csrfTokenFor } from './tokens.js';
export { totpCode, verifyTotp, base32Decode } from './totp.js';
export { authRoutes } from './routes.js';
export { devicesRoutes } from './devices.js';

const defaultIds = uuidv7Generator({ now: () => instant(Date.now()) }, (n) => new Uint8Array(randomBytes(n)));

/**
 * BUILD_PLAN signature: issues a session for `userId` in `tenantId` (an active membership) or with
 * no tenant. Returns the cookie VALUE (the opaque token) and the session id. MFA is not marked
 * verified; callers that already verified it use the auth routes instead.
 */
export async function issueSession(userId: UserId, tenantId: TenantId | null, opts: { db?: Database } = {}): Promise<{ cookie: string; sessionId: string }> {
  const db = opts.db ?? getDatabase();
  let tenant: { id: TenantId; role: Awaited<ReturnType<typeof userTenants>>[number]['role'] } | null = null;
  if (tenantId !== null) {
    const t = (await userTenants(db, userId)).find((x) => x.tenantId === tenantId);
    if (!t) throw new Error('issueSession: no active membership in that tenant');
    tenant = { id: t.tenantId, role: t.role };
  }
  const s = await issueSessionTx(db, defaultIds, { userId, tenant, mfaVerified: false, reauthenticated: false, ip: null, userAgent: null });
  return { cookie: s.token, sessionId: s.sessionId };
}
