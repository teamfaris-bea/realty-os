// Starting a session after a successful credential check (login, signup, MFA, re-auth, tenant switch,
// invite acceptance): one place that rotates the presented session, sets the cookie, writes the
// tenant audit row in the session's transaction and builds the response payload.
import type { AuditAction, Instant, Role, TenantId, UserId } from '@realty/core/foundation';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { audit } from '../audit.js';
import { AppError } from '../errors.js';
import type { Platform } from '../server.js';
import { type SessionInfo, clientIp, mfaFacts, sessionInfo, setSessionCookie, userAgent } from './common.js';
import { loadAuthState } from './guard.js';
import { actorFor, issueSessionTx } from './sessions.js';

export type NextStep = 'ready' | 'mfa_verify' | 'mfa_enroll';

export interface StartSessionOptions {
  userId: UserId;
  tenant: { id: TenantId; role: Role } | null;
  mfaVerified: boolean;
  /** keep the presented session's MFA verification (tenant switch) */
  carryMfa?: boolean;
  /**
   * true: this request proved the password (login, signup, re-auth, new-user invite) ⇒ now.
   * 'carry': keep the presented session's instant (a second factor alone is not re-authentication,
   * R-PERM-13). false: none.
   */
  reauthenticated: boolean | 'carry';
  /** the presented session must still be live when the new one is issued (see issueSessionTx) */
  requirePresented?: boolean;
  /** tenant audit action written in the session's transaction (R-AUDIT-5) */
  auditAction: Extract<AuditAction, 'session.login' | 'session.tenant_switched' | 'session.mfa_enrolled'> | null;
  rotationReason?: 'rotation' | 'tenant_switch';
}

export async function startSession(req: FastifyRequest, reply: FastifyReply, p: Platform, o: StartSessionOptions): Promise<{ next: NextStep; session: SessionInfo }> {
  const presented = await loadAuthState(req);
  const replaces = presented && presented.userId === o.userId ? { sessionId: presented.sessionId, reason: o.rotationReason ?? ('rotation' as const) } : undefined;
  const mfa = await mfaFacts(p.db, o.userId, o.tenant);
  if (o.requirePresented && !replaces) throw new AppError('UNAUTHENTICATED');
  const carried: Instant | null | undefined = o.carryMfa ? (presented?.mfaVerifiedAt ?? null) : undefined;
  const carriedReauth: Instant | null | undefined = o.reauthenticated === 'carry' ? (replaces ? (presented?.reauthenticatedAt ?? null) : null) : undefined;
  const issued = await issueSessionTx(
    p.db,
    p.ids,
    {
      userId: o.userId,
      tenant: o.tenant,
      mfaVerified: o.mfaVerified,
      reauthenticated: o.reauthenticated === true,
      ip: clientIp(req),
      userAgent: userAgent(req),
      ...(replaces ? { replaces } : {}),
      ...(carried !== undefined ? { carryMfaVerifiedAt: carried } : {}),
      ...(carriedReauth !== undefined ? { carryReauthenticatedAt: carriedReauth } : {}),
      ...(o.requirePresented ? { requireReplaced: true } : {}),
    },
    async (tx, _now, sessionId) => {
      if (o.tenant && o.auditAction) {
        const actor = actorFor({ userId: o.userId, tenantId: o.tenant.id, role: o.tenant.role, sessionId });
        await audit(tx, actor, { action: o.auditAction, entity: { type: 'session', id: sessionId } });
      }
    },
  );
  setSessionCookie(reply, p, issued);
  const mfaVerifiedAt = carried !== undefined ? carried : o.mfaVerified ? issued.issuedAt : null;
  const info = await sessionInfo(p.db, p, {
    sessionId: issued.sessionId,
    userId: o.userId,
    tenantId: o.tenant?.id ?? null,
    role: o.tenant?.role ?? null,
    reauthenticatedAt: carriedReauth !== undefined ? carriedReauth : o.reauthenticated ? issued.issuedAt : null,
    mfaVerifiedAt,
    mfaEnabled: mfa.enabled,
    mfaRequiredForRole: mfa.required,
  });
  const next: NextStep = mfa.enabled && mfaVerifiedAt === null ? 'mfa_verify' : mfa.required && !mfa.enabled ? 'mfa_enroll' : 'ready';
  return { next, session: info };
}
