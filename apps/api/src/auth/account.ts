// Account lifecycle routes: signup (tenant provisioning), password reset, invite acceptance.
//
// - Signup creates the user (users RLS: insert self) and provisions the tenant through
//   app.provision_tenant with freshly generated tenant keys wrapped by the KEK, in ONE transaction.
//   The new Owner gets an enrollment-only session (R-PERM-14).
// - Password reset: always 202 (no enumeration); the token is single-use, 30 minutes, stored hashed;
//   consuming it changes the password and revokes EVERY session of the user (auth definer).
//   The link carries the token in the URL fragment so it never reaches server logs.
// - Invite acceptance: auth.accept_invite (hashed token, ≤ 7 days); existing users accept while
//   signed in as themselves; a session in the invited tenant is issued (rotation).
import type { PolicyVersionId, PondId, TeamId, TenantId, UserId } from '@realty/core/foundation';
import { ianaZone, normalizeEmail } from '@realty/core/foundation';
import { withPreTenant } from '@realty/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { generateTenantKeys, wrapTenantKeys } from '../crypto/envelope.js';
import { AppError } from '../errors.js';
import { LoginResponse, OkResponse, authEvent, clearSessionCookie, clientIp, platformOf } from './common.js';
import { startSession } from './flow.js';
import { loadAuthState } from './guard.js';
import { checkPasswordPolicy, hashPassword } from './password.js';
import { enforceLimits } from './rateLimit.js';
import { userTenants } from './sessions.js';
import { newOpaqueToken, opaqueTokenHash } from './tokens.js';

function pgError(e: unknown): { code?: string; constraint?: string; message?: string } {
  return (e ?? {}) as { code?: string; constraint?: string; message?: string };
}

const DisplayName = z.string().trim().min(1).max(120);

export async function registerAccountRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/auth/signup',
    {
      config: { auth: 'public' },
      schema: {
        body: z
          .object({
            email: z.string().trim().min(3).max(320),
            password: z.string().min(1).max(256),
            displayName: DisplayName,
            teamName: z.string().trim().min(1).max(120),
            slug: z.string().regex(/^[a-z0-9][a-z0-9-]{1,40}$/),
            timezone: z.string().min(1).max(64),
            brokerageLegalName: z.string().trim().min(1).max(200),
          })
          .strict(),
        response: { 201: LoginResponse },
      },
    },
    async (req, reply) => {
      const p = platformOf(req);
      const b = req.body;
      await enforceLimits(p.db, p.config.sessionSecret, [{ kind: 'signup_ip', parts: [clientIp(req)], max: 10, windowSeconds: 3600 }]);
      const em = normalizeEmail(b.email);
      if (!em.ok) throw new AppError('EMAIL_INVALID');
      const policy = checkPasswordPolicy(b.password, em.email);
      if (!policy.ok) throw new AppError('PASSWORD_TOO_WEAK', { rule: policy.rule });
      if (ianaZone(b.timezone) === null) throw new AppError('TIMEZONE_INVALID');
      const hash = await hashPassword(b.password);
      const userId = p.ids.next<'UserId'>() as UserId;
      const tenantId = p.ids.next<'TenantId'>() as TenantId;
      const keys = generateTenantKeys();
      const wrapped = await wrapTenantKeys(p.envelope.kek, tenantId, keys);
      try {
        await withPreTenant(
          async (tx, now) => {
            await sql`INSERT INTO users (id, email, display_name, password_hash, password_changed_at)
                      VALUES (${userId}::uuid, ${em.email}::citext, ${b.displayName}, ${hash}, ${new Date(now)}::timestamptz)`.execute(tx);
            await sql`SELECT app.provision_tenant(${tenantId}::uuid, ${b.slug}::citext, ${b.teamName}, ${b.timezone}, ${b.brokerageLegalName},
                        ${userId}::uuid, ${p.ids.next<'PolicyVersionId'>() as PolicyVersionId}::uuid, ${p.ids.next<'TeamId'>() as TeamId}::uuid,
                        ${p.ids.next<'PondId'>() as PondId}::uuid, ${Buffer.from(wrapped.field)}, ${Buffer.from(wrapped.object)},
                        ${Buffer.from(wrapped.hmac)}, ${p.envelope.kek.ref})`.execute(tx);
          },
          { db: p.db, userId },
        );
      } catch (e) {
        const pe = pgError(e);
        if (pe.code === '23505' && pe.constraint === 'tenants_slug_key') throw new AppError('SLUG_TAKEN');
        if (pe.code === '23505') throw new AppError('SIGNUP_UNAVAILABLE');
        if (pe.code === '22023' || pe.code === '23514') throw new AppError('VALIDATION_FAILED');
        throw e;
      }
      p.envelope.prime(tenantId, keys);
      const out = await startSession(req, reply, p, {
        userId,
        tenant: { id: tenantId, role: 'owner' },
        mfaVerified: false,
        reauthenticated: true,
        auditAction: 'session.login',
      });
      await authEvent(p, req, { event: 'login_ok', userId, tenantId });
      reply.status(201);
      return out;
    },
  );

  r.post(
    '/auth/password/reset',
    { config: { auth: 'public' }, schema: { body: z.object({ email: z.string().trim().min(3).max(320) }).strict(), response: { 202: OkResponse } } },
    async (req, reply) => {
      const p = platformOf(req);
      const em = normalizeEmail(req.body.email);
      const email = em.ok ? em.email : req.body.email.trim().toLowerCase();
      await enforceLimits(p.db, p.config.sessionSecret, [
        { kind: 'reset_ip', parts: [clientIp(req)], max: 10, windowSeconds: 3600 },
        { kind: 'reset_email', parts: [email], max: 3, windowSeconds: 3600 },
      ]);
      const { token, hash } = newOpaqueToken();
      const userId = await withPreTenant(
        async (tx, now) => {
          const u = await sql<{ user_id: string; disabled_at: Date | null }>`SELECT user_id, disabled_at FROM auth.login_lookup(${email}::citext)`.execute(tx);
          await sql`SELECT auth.issue_password_reset(${email}::citext, ${Buffer.from(hash)}, ${new Date(now)}::timestamptz)`.execute(tx);
          const row = u.rows[0];
          return row && row.disabled_at === null ? (row.user_id as UserId) : null;
        },
        { db: p.db },
      );
      await authEvent(p, req, { event: 'password_reset_requested', userId, email });
      if (userId !== null) {
        const link = `${p.config.webOrigins[0]}/reset-password#token=${token}`;
        // fire-and-forget: the response time must not reveal whether the account exists
        void p.providers.accountMail.deliverAccountEmail({ to: email, kind: 'password_reset', link, expiresInMinutes: 30 }).catch((e: unknown) => {
          req.log.warn({ code: 'ACCOUNT_MAIL_FAILED', err: e }, 'password reset email failed');
        });
      }
      reply.status(202);
      return { ok: true as const };
    },
  );

  r.post(
    '/auth/password/reset/confirm',
    {
      config: { auth: 'public' },
      schema: { body: z.object({ token: z.string().min(10).max(100), password: z.string().min(1).max(256) }).strict(), response: { 200: OkResponse } },
    },
    async (req, reply) => {
      const p = platformOf(req);
      await enforceLimits(p.db, p.config.sessionSecret, [{ kind: 'reset_confirm_ip', parts: [clientIp(req)], max: 20, windowSeconds: 3600 }]);
      const tokenHash = opaqueTokenHash(req.body.token);
      if (!tokenHash) throw new AppError('RESET_TOKEN_INVALID');
      const policy = checkPasswordPolicy(req.body.password);
      if (!policy.ok) throw new AppError('PASSWORD_TOO_WEAK', { rule: policy.rule });
      const pwHash = await hashPassword(req.body.password);
      const uid = await withPreTenant(
        async (tx, now) =>
          (await sql<{ uid: string | null }>`SELECT auth.consume_password_reset(${Buffer.from(tokenHash)}, ${pwHash}, ${new Date(now)}::timestamptz) AS uid`.execute(tx))
            .rows[0]?.uid ?? null,
        { db: p.db },
      );
      if (uid === null) throw new AppError('RESET_TOKEN_INVALID');
      await authEvent(p, req, { event: 'password_changed', userId: uid as UserId });
      await authEvent(p, req, { event: 'session_revoked', userId: uid as UserId });
      clearSessionCookie(reply, p);
      return { ok: true as const };
    },
  );

  r.post(
    '/auth/invites/:token/accept',
    {
      config: { auth: 'public' },
      schema: {
        params: z.object({ token: z.string().min(10).max(100) }),
        body: z.object({ displayName: DisplayName.optional(), password: z.string().min(1).max(256).optional() }).strict(),
        response: { 200: LoginResponse },
      },
    },
    async (req, reply) => {
      const p = platformOf(req);
      await enforceLimits(p.db, p.config.sessionSecret, [{ kind: 'invite_ip', parts: [clientIp(req)], max: 20, windowSeconds: 3600 }]);
      const tokenHash = opaqueTokenHash(req.params.token);
      if (!tokenHash) throw new AppError('INVITE_INVALID');
      const presented = await loadAuthState(req);
      const signedIn = presented && (!presented.mfaEnabled || presented.mfaVerifiedAt !== null) ? presented : null;
      let pwHash: string | null = null;
      if (req.body.password !== undefined) {
        const policy = checkPasswordPolicy(req.body.password);
        if (!policy.ok) throw new AppError('PASSWORD_TOO_WEAK', { rule: policy.rule });
        pwHash = await hashPassword(req.body.password);
      }
      const newUserId = p.ids.next<'UserId'>();
      let accepted: { o_tenant_id: string; o_user_id: string; o_created_user: boolean } | undefined;
      try {
        accepted = await withPreTenant(
          async (tx, now) =>
            (
              await sql<{ o_tenant_id: string; o_user_id: string; o_created_user: boolean }>`
                SELECT * FROM auth.accept_invite(${Buffer.from(tokenHash)}, ${newUserId}::uuid, ${req.body.displayName ?? null},
                                                 ${pwHash}, ${new Date(now)}::timestamptz)`.execute(tx)
            ).rows[0],
          signedIn ? { db: p.db, userId: signedIn.userId } : { db: p.db },
        );
      } catch (e) {
        const pe = pgError(e);
        if (pe.message?.startsWith('PASSWORD_REQUIRED')) throw new AppError('PASSWORD_REQUIRED');
        if (pe.message?.startsWith('LOGIN_REQUIRED')) throw new AppError('LOGIN_REQUIRED');
        if (pe.code === '23502') throw new AppError('VALIDATION_FAILED');
        throw e;
      }
      if (!accepted) throw new AppError('INVITE_INVALID');
      const userId = accepted.o_user_id as UserId;
      const t = (await userTenants(p.db, userId)).find((x) => x.tenantId === accepted.o_tenant_id);
      if (!t) throw new AppError('INVITE_INVALID');
      const out = await startSession(req, reply, p, {
        userId,
        tenant: { id: t.tenantId, role: t.role },
        mfaVerified: signedIn !== null && signedIn.userId === userId && signedIn.mfaVerifiedAt !== null,
        reauthenticated: accepted.o_created_user,
        auditAction: 'session.login',
      });
      await authEvent(p, req, { event: 'invite_accepted', userId, tenantId: t.tenantId });
      return out;
    },
  );
}
