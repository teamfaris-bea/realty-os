// Auth routes (BUILD_PLAN module 8), mounted under /api:
//   POST /auth/signup, /auth/login, /auth/logout, /auth/reauth, /auth/tenant-switch, GET /auth/session
//   POST /auth/mfa/enroll, /auth/mfa/enroll/confirm, /auth/mfa/verify            (mfa.ts)
//   POST /auth/password/reset, /auth/password/reset/confirm, /auth/invites/:token/accept (account.ts)
//
// Login (ASVS L2 V2/V3): uniform LOGIN_FAILED for unknown email, wrong password, locked or disabled
// accounts, with the same argon2id work in every case (dummy hash); lockout after 10 consecutive
// failures for 15 minutes (auth.record_login_result); DB-backed limits 5/min per IP+email,
// 20/h per email, 100/h per IP; a NEW session on every login (the presented one is revoked).
import type { UserId } from '@realty/core/foundation';
import { instantFromDate, normalizeEmail } from '@realty/core/foundation';
import { withPreTenant, withTenantTx } from '@realty/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { audit } from '../audit.js';
import { AppError } from '../errors.js';
import type { RouteModule } from '../routes.js';
import { registerAccountRoutes } from './account.js';
import { LoginResponse, LogoutAllResponse, OkResponse, SessionInfo, authEvent, clearSessionCookie, clientIp, platformOf, sessionInfo } from './common.js';
import { startSession } from './flow.js';
import { registerMfaRoutes, verifySecondFactor } from './mfa.js';
import { verifyDummy, verifyPassword } from './password.js';
import { LOGIN_LIMITS, enforceLimits } from './rateLimit.js';
import { actorFor, revokeSession, userTenants } from './sessions.js';

interface LookupRow {
  user_id: string;
  password_hash: string | null;
  locked_until: Date | null;
  disabled_at: Date | null;
  mfa_enabled: boolean;
}

export async function loginLookup(p: ReturnType<typeof platformOf>, email: string) {
  return withPreTenant(
    async (tx, now) => {
      const r = await sql<LookupRow>`SELECT * FROM auth.login_lookup(${email}::citext)`.execute(tx);
      return { row: r.rows[0] ?? null, now };
    },
    { db: p.db },
  );
}

/** Verifies a password for an email with uniform timing; records the result (lockout counter). */
export async function checkCredentials(p: ReturnType<typeof platformOf>, email: string, password: string): Promise<{ ok: true; userId: UserId } | { ok: false; userId: UserId | null; locked: boolean }> {
  const { row, now } = await loginLookup(p, email);
  const lockedNow = row?.locked_until != null && instantFromDate(row.locked_until) > now;
  if (!row || !row.password_hash || row.disabled_at !== null || lockedNow) {
    await verifyDummy(password);
    return { ok: false, userId: (row?.user_id as UserId | undefined) ?? null, locked: lockedNow };
  }
  const ok = await verifyPassword(row.password_hash, password);
  await withPreTenant(
    async (tx, t) => {
      await sql`SELECT auth.record_login_result(${row.user_id}::uuid, ${ok}, ${new Date(t)}::timestamptz)`.execute(tx);
    },
    { db: p.db },
  );
  if (ok) return { ok: true, userId: row.user_id as UserId };
  const after = await loginLookup(p, email);
  const lockedAfter = after.row?.locked_until != null && instantFromDate(after.row.locked_until) > after.now;
  return { ok: false, userId: row.user_id as UserId, locked: lockedAfter };
}

const Email = z.string().trim().min(3).max(320);

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/auth/login',
    {
      config: { auth: 'public' },
      schema: { body: z.object({ email: Email, password: z.string().min(1).max(1024) }).strict(), response: { 200: LoginResponse } },
    },
    async (req, reply) => {
      const p = platformOf(req);
      const norm = normalizeEmail(req.body.email);
      const email = norm.ok ? norm.email : req.body.email.trim().toLowerCase();
      await enforceLimits(p.db, p.config.sessionSecret, LOGIN_LIMITS(clientIp(req), email));
      const res = await checkCredentials(p, email, req.body.password);
      if (!res.ok) {
        await authEvent(p, req, { event: res.locked ? 'locked' : 'login_failed', userId: res.userId, email });
        throw new AppError('LOGIN_FAILED');
      }
      const tenants = await userTenants(p.db, res.userId);
      const t = tenants[0] ?? null;
      const out = await startSession(req, reply, p, {
        userId: res.userId,
        tenant: t ? { id: t.tenantId, role: t.role } : null,
        mfaVerified: false,
        reauthenticated: true,
        auditAction: 'session.login',
      });
      await authEvent(p, req, { event: 'login_ok', userId: res.userId, tenantId: t?.tenantId ?? null });
      return out;
    },
  );

  r.post(
    '/auth/logout',
    { config: { auth: 'session', allowPartial: ['mfa_pending', 'enrollment'] }, schema: { response: { 200: OkResponse } } },
    async (req, reply) => {
      const p = platformOf(req);
      const s = req.authState!;
      if (s.tenantId !== null && s.role !== null) {
        const actor = actorFor({ userId: s.userId, tenantId: s.tenantId, role: s.role, sessionId: s.sessionId });
        await withTenantTx(
          actor,
          async (tx, now) => {
            await sql`UPDATE sessions SET revoked_at = ${new Date(now)}::timestamptz, revoked_reason = 'logout'
                       WHERE id = ${s.sessionId}::uuid AND user_id = app.user_id() AND revoked_at IS NULL`.execute(tx);
            await audit(tx, actor, { action: 'session.logout', entity: { type: 'session', id: s.sessionId } });
          },
          { db: p.db },
        );
      } else {
        await revokeSession(p.db, s.userId, s.sessionId, 'logout');
      }
      await authEvent(p, req, { event: 'logout', userId: s.userId, tenantId: s.tenantId });
      clearSessionCookie(reply, p);
      return { ok: true as const };
    },
  );

  // "Log out of all sessions": every live session of the user, on every device and in every tenant,
  // including this one. Needs a fully verified session (a password alone cannot sign the user out
  // everywhere); enrollment-only sessions may use it (they have no second factor yet).
  r.post(
    '/auth/logout-all',
    { config: { auth: 'session', allowPartial: ['enrollment'] }, schema: { response: { 200: LogoutAllResponse } } },
    async (req, reply) => {
      const p = platformOf(req);
      const s = req.authState!;
      const revokeAll = async (tx: Parameters<Parameters<typeof withPreTenant>[0]>[0], now: number) =>
        Number(
          (
            await sql`UPDATE sessions SET revoked_at = ${new Date(now)}::timestamptz, revoked_reason = 'logout'
                       WHERE user_id = app.user_id() AND revoked_at IS NULL`.execute(tx)
          ).numAffectedRows ?? 0,
        );
      let revoked: number;
      if (s.tenantId !== null && s.role !== null) {
        const actor = actorFor({ userId: s.userId, tenantId: s.tenantId, role: s.role, sessionId: s.sessionId });
        revoked = await withTenantTx(
          actor,
          async (tx, now) => {
            const n = await revokeAll(tx, now);
            await audit(tx, actor, { action: 'session.revoked_all', entity: { type: 'session', id: s.sessionId } });
            return n;
          },
          { db: p.db },
        );
      } else {
        revoked = await withPreTenant((tx, now) => revokeAll(tx, now), { db: p.db, userId: s.userId });
      }
      await authEvent(p, req, { event: 'session_revoked', userId: s.userId, tenantId: s.tenantId });
      clearSessionCookie(reply, p);
      return { ok: true as const, revoked };
    },
  );

  r.get(
    '/auth/session',
    { config: { auth: 'session', allowPartial: ['mfa_pending', 'enrollment'] }, schema: { response: { 200: SessionInfo } } },
    async (req) => {
      const p = platformOf(req);
      const s = req.authState!;
      return sessionInfo(p.db, p, s);
    },
  );

  r.post(
    '/auth/tenant-switch',
    {
      config: { auth: 'session', allowPartial: ['enrollment'] },
      // the target is named by slug; the session's tenant is never taken from input (R-TEN-3)
      schema: { body: z.object({ slug: z.string().min(2).max(42) }).strict(), response: { 200: LoginResponse } },
    },
    async (req, reply) => {
      const p = platformOf(req);
      const s = req.authState!;
      const target = (await userTenants(p.db, s.userId)).find((t) => t.slug.toLowerCase() === req.body.slug.toLowerCase());
      if (!target) throw new AppError('NOT_FOUND');
      const out = await startSession(req, reply, p, {
        userId: s.userId,
        tenant: { id: target.tenantId, role: target.role },
        mfaVerified: false,
        carryMfa: true,
        reauthenticated: false,
        auditAction: 'session.tenant_switched',
        rotationReason: 'tenant_switch',
        requirePresented: true,
      });
      await authEvent(p, req, { event: 'tenant_switched', userId: s.userId, tenantId: target.tenantId });
      return out;
    },
  );

  r.post(
    '/auth/reauth',
    {
      // enrollment-only sessions may re-authenticate (their login re-auth can go stale before
      // enrollment, which requires a fresh one); MFA-pending sessions verify the factor first
      config: { auth: 'session', allowPartial: ['enrollment'] },
      schema: { body: z.object({ password: z.string().min(1).max(1024), code: z.string().regex(/^\d{6}$/).optional() }).strict(), response: { 200: LoginResponse } },
    },
    async (req, reply) => {
      const p = platformOf(req);
      const s = req.authState!;
      await enforceLimits(p.db, p.config.sessionSecret, [{ kind: 'reauth_user', parts: [s.userId], max: 5, windowSeconds: 300 }]);
      const email = await withPreTenant(async (tx) => (await sql<{ email: string }>`SELECT email FROM users WHERE id = app.user_id()`.execute(tx)).rows[0]?.email, {
        db: p.db,
        userId: s.userId,
      });
      const res = email ? await checkCredentials(p, email, req.body.password) : ({ ok: false } as const);
      if (!res.ok || res.userId !== s.userId) {
        await authEvent(p, req, { event: 'login_failed', userId: s.userId });
        throw new AppError('LOGIN_FAILED');
      }
      if (s.mfaEnabled) {
        if (!req.body.code || !(await verifySecondFactor(p, s.userId, { code: req.body.code }))) {
          await authEvent(p, req, { event: 'mfa_failed', userId: s.userId });
          throw new AppError('MFA_CODE_INVALID');
        }
      }
      const out = await startSession(req, reply, p, {
        userId: s.userId,
        tenant: s.tenantId !== null && s.role !== null ? { id: s.tenantId, role: s.role } : null,
        mfaVerified: s.mfaEnabled,
        carryMfa: !s.mfaEnabled,
        reauthenticated: true,
        auditAction: null,
        requirePresented: true,
      });
      await authEvent(p, req, { event: 'reauth_ok', userId: s.userId, tenantId: s.tenantId });
      return out;
    },
  );

  await registerMfaRoutes(app);
  await registerAccountRoutes(app);
}

export const authRoutes: RouteModule = { name: 'auth', register };
