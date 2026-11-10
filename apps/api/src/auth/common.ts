// Shared helpers and response schemas for the auth and device routes.
import type { Instant, Role, TenantId, UserId } from '@realty/core/foundation';
import { toIso } from '@realty/core/foundation';
import { type Database, withPreTenant, withTenantTx } from '@realty/db';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { z } from 'zod';
import type { Platform } from '../server.js';
import { platformOf } from './guard.js';
import { type AuthState, type IssuedSession, actorFor, sessionCookieName, sessionCookieOptions, userTenants } from './sessions.js';
import { csrfTokenFor, emailAttemptHash } from './tokens.js';

export type AuthEventKind =
  | 'login_ok'
  | 'login_failed'
  | 'locked'
  | 'logout'
  | 'mfa_ok'
  | 'mfa_failed'
  | 'password_reset_requested'
  | 'password_changed'
  | 'session_revoked'
  | 'tenant_switched'
  | 'reauth_ok'
  | 'invite_accepted';

export function clientIp(req: FastifyRequest): string {
  return req.ip || '0.0.0.0';
}

export function userAgent(req: FastifyRequest): string | null {
  const ua = req.headers['user-agent'];
  return typeof ua === 'string' ? ua.slice(0, 300) : null;
}

/** auth_events (append-only, global): ids, keyed email hash, ip, ua; never plaintext emails. */
export async function authEvent(
  p: Platform,
  req: FastifyRequest,
  e: { event: AuthEventKind; userId?: UserId | null; tenantId?: TenantId | null; email?: string },
): Promise<void> {
  await withPreTenant(
    async (tx, now) => {
      await sql`INSERT INTO auth_events (id, occurred_at, event, user_id, email_attempted_hash, tenant_id, ip, user_agent)
                VALUES (${p.ids.next<'AuthEventId'>()}::uuid, ${new Date(now)}::timestamptz, ${e.event}, ${e.userId ?? null}::uuid,
                        ${e.email ? emailAttemptHash(p.config.sessionSecret, e.email) : null}, ${e.tenantId ?? null}::uuid,
                        ${clientIp(req)}::inet, ${userAgent(req)})`.execute(tx);
    },
    { db: p.db },
  );
}

export function setSessionCookie(reply: FastifyReply, p: Platform, s: IssuedSession): void {
  reply.setCookie(sessionCookieName(p.config.cookieSecure), s.token, sessionCookieOptions(p.config.cookieSecure, s.maxAgeSeconds));
}

export function clearSessionCookie(reply: FastifyReply, p: Platform): void {
  reply.clearCookie(sessionCookieName(p.config.cookieSecure), { path: '/', secure: p.config.cookieSecure, httpOnly: true, sameSite: 'lax' });
}

// ---- response schemas (snapshot-tested: no confidence*, no tenant_id input fields) -------------

export const TenantSummary = z.object({ id: z.uuid(), name: z.string(), slug: z.string(), role: z.enum(['owner', 'admin', 'team_lead', 'agent', 'isa', 'tc']) });

export const SessionInfo = z.object({
  user: z.object({ id: z.uuid(), email: z.string(), displayName: z.string() }),
  tenant: TenantSummary.nullable(),
  tenants: z.array(TenantSummary),
  mfa: z.object({ enabled: z.boolean(), verified: z.boolean(), enrollmentRequired: z.boolean(), recoveryCodesRemaining: z.number().int().nullable() }),
  reauthenticatedAt: z.string().nullable(),
  csrfToken: z.string(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const LoginResponse = z.object({ next: z.enum(['ready', 'mfa_verify', 'mfa_enroll']), session: SessionInfo });

export const OkResponse = z.object({ ok: z.literal(true) });

export const MfaEnrollResponse = z.object({ secret: z.string(), otpauthUri: z.string() });
export const MfaConfirmResponse = z.object({ recoveryCodes: z.array(z.string()), session: SessionInfo });
export const RecoveryCodesResponse = z.object({ recoveryCodes: z.array(z.string()) });
export const LogoutAllResponse = z.object({ ok: z.literal(true), revoked: z.number().int() });

export const PushSubscriptionResponse = z.object({ id: z.uuid() });
export const AlertPhoneChallengeResponse = z.object({ challenge: z.string(), expiresAt: z.string(), maskedPhone: z.string() });
export const AlertPhoneVerifiedResponse = z.object({ maskedPhone: z.string(), verifiedAt: z.string() });

/** Every response schema the platform routes use (schema snapshot test). */
export const PLATFORM_RESPONSE_SCHEMAS = {
  SessionInfo,
  LoginResponse,
  OkResponse,
  MfaEnrollResponse,
  MfaConfirmResponse,
  RecoveryCodesResponse,
  LogoutAllResponse,
  PushSubscriptionResponse,
  AlertPhoneChallengeResponse,
  AlertPhoneVerifiedResponse,
} as const;

export function maskPhone(e164: string): string {
  return `${'•'.repeat(Math.max(0, e164.length - 4))}${e164.slice(-4)}`;
}

/** The session payload the web app needs (`GET /auth/session` and every login-like response). */
export async function sessionInfo(db: Database, p: Platform, s: Pick<AuthState, 'sessionId' | 'userId' | 'tenantId' | 'role' | 'reauthenticatedAt' | 'mfaVerifiedAt'> & { mfaEnabled: boolean; mfaRequiredForRole: boolean }): Promise<SessionInfo> {
  const user = await withPreTenant(
    async (tx) =>
      (
        await sql<{ email: string; display_name: string; codes: number }>`
          SELECT email, display_name,
                 (SELECT count(*)::int FROM mfa_recovery_codes WHERE user_id = app.user_id() AND used_at IS NULL) AS codes
            FROM users WHERE id = app.user_id()`.execute(tx)
      ).rows[0],
    { db, userId: s.userId },
  );
  const tenants = await userTenants(db, s.userId);
  const list = tenants.map((t) => ({ id: t.tenantId, name: t.name, slug: t.slug, role: t.role }));
  return {
    user: { id: s.userId, email: user?.email ?? '', displayName: user?.display_name ?? '' },
    tenant: list.find((t) => t.id === s.tenantId) ?? null,
    tenants: list,
    mfa: {
      enabled: s.mfaEnabled,
      verified: s.mfaVerifiedAt !== null,
      enrollmentRequired: s.mfaRequiredForRole && !s.mfaEnabled,
      recoveryCodesRemaining: s.mfaEnabled ? (user?.codes ?? 0) : null,
    },
    reauthenticatedAt: s.reauthenticatedAt === null ? null : toIso(s.reauthenticatedAt),
    csrfToken: csrfTokenFor(p.config.sessionSecret, s.sessionId),
  };
}

/** MFA facts for a user in a tenant: MFA enabled; the tenant's mfa_required_roles covers the role. */
export async function mfaFacts(db: Database, userId: UserId, tenant: { id: TenantId; role: Role } | null): Promise<{ enabled: boolean; required: boolean }> {
  const enabled = await withPreTenant(
    async (tx) => (await sql<{ e: boolean }>`SELECT mfa_enabled_at IS NOT NULL AS e FROM users WHERE id = app.user_id()`.execute(tx)).rows[0]?.e ?? false,
    { db, userId },
  );
  if (!tenant) return { enabled, required: false };
  const required = await withTenantTx(
    actorFor({ userId, tenantId: tenant.id, role: tenant.role, sessionId: 'pending' }),
    async (tx) =>
      (await sql<{ r: boolean }>`SELECT ${tenant.role}::text = ANY (mfa_required_roles) AS r FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx)).rows[0]?.r ??
      true,
    { db },
  );
  return { enabled, required };
}

export function nowIso(t: Instant): string {
  return toIso(t);
}

export { platformOf };
