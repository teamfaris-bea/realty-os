// TOTP MFA (R-PERM-14). Owner/Admin (every role in mfa_required_roles) must enroll; until they do,
// their session is enrollment-only. A user with MFA enabled verifies it once per session.
//
//   POST /auth/mfa/enroll           → { secret, otpauthUri }   (secret stored encrypted, not active yet)
//   POST /auth/mfa/enroll/confirm   { code } → { recoveryCodes, session }   (activates; new session;
//                                   needs a password re-auth within 15 min, else REAUTH_REQUIRED)
//   POST /auth/mfa/verify           { code } | { recoveryCode } → new session with MFA verified
//   POST /auth/mfa/recovery-codes   → { recoveryCodes }  replaces every recovery code (MFA verified in
//                                   this session + password re-auth within 15 min, else REAUTH_REQUIRED)
//
// Neither refreshes reauthenticated_at: a second factor alone is not re-authentication (R-PERM-13);
// the new session carries the presented session's instant (set by the password login/re-auth).
//
// The TOTP secret is encrypted with the PLATFORM mfa key (users are global), AAD bound to the user
// row (R-DATA-1), and readable only through auth.mfa_secret() for the user themselves. A code is
// accepted once (users.mfa_last_used_step); recovery codes are single-use sha256 hashes.
import { REAUTH_WINDOW_MS, type UserId } from '@realty/core/foundation';
import { withPreTenant, withTenantTx } from '@realty/db';
import { audit } from '../audit.js';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { sha256 } from '../crypto/primitives.js';
import { AppError } from '../errors.js';
import type { Platform } from '../server.js';
import { LoginResponse, MfaConfirmResponse, MfaEnrollResponse, RecoveryCodesResponse, authEvent, platformOf } from './common.js';
import { startSession } from './flow.js';
import { enforceLimits } from './rateLimit.js';
import { actorFor } from './sessions.js';
import { newRecoveryCodes, newTotpSecret, normalizeRecoveryCode, otpauthUri, verifyTotp } from './totp.js';

function reauthFresh(s: { reauthenticatedAt: number | null; now: number }): boolean {
  if (s.reauthenticatedAt === null) return false;
  const age = s.now - s.reauthenticatedAt;
  return age >= 0 && age <= REAUTH_WINDOW_MS;
}

const secretAad = (userId: string) => ({ table: 'users', column: 'mfa_totp_secret_enc', rowId: userId });

async function readSecret(p: Platform, userId: UserId): Promise<string | null> {
  const enc = await withPreTenant(async (tx) => (await sql<{ s: Buffer | null }>`SELECT auth.mfa_secret() AS s`.execute(tx)).rows[0]?.s ?? null, {
    db: p.db,
    userId,
  });
  if (!enc) return null;
  return Buffer.from(p.envelope.decryptPlatform('mfa', secretAad(userId), new Uint8Array(enc))).toString('utf8');
}

/** Verifies a TOTP code (once per step) or a recovery code (once). */
export async function verifySecondFactor(p: Platform, userId: UserId, f: { code?: string; recoveryCode?: string }): Promise<boolean> {
  if (f.code !== undefined) {
    const secret = await readSecret(p, userId);
    if (!secret) return false;
    return withPreTenant(
      async (tx, now) => {
        const step = verifyTotp(secret, f.code!, now);
        if (step === null) return false;
        const r = await sql`UPDATE users SET mfa_last_used_step = ${step}
                             WHERE id = app.user_id() AND mfa_enabled_at IS NOT NULL
                               AND (mfa_last_used_step IS NULL OR mfa_last_used_step < ${step})`.execute(tx);
        return Number(r.numAffectedRows ?? 0) === 1;
      },
      { db: p.db, userId },
    );
  }
  if (f.recoveryCode !== undefined) {
    const h = Buffer.from(sha256(normalizeRecoveryCode(f.recoveryCode)));
    return withPreTenant(
      async (tx, now) => {
        const r = await sql`UPDATE mfa_recovery_codes SET used_at = ${new Date(now)}::timestamptz
                             WHERE user_id = app.user_id() AND code_hash = ${h} AND used_at IS NULL`.execute(tx);
        return Number(r.numAffectedRows ?? 0) === 1;
      },
      { db: p.db, userId },
    );
  }
  return false;
}

export async function registerMfaRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/auth/mfa/enroll',
    { config: { auth: 'session', allowPartial: ['enrollment'] }, schema: { response: { 200: MfaEnrollResponse } } },
    async (req) => {
      const p = platformOf(req);
      const s = req.authState!;
      if (s.mfaEnabled) throw new AppError('MFA_ALREADY_ENABLED');
      const secret = newTotpSecret();
      const enc = p.envelope.encryptPlatform('mfa', secretAad(s.userId), Buffer.from(secret, 'utf8'));
      const email = await withPreTenant(
        async (tx) => {
          await sql`UPDATE users SET mfa_totp_secret_enc = ${Buffer.from(enc)} WHERE id = app.user_id() AND mfa_enabled_at IS NULL`.execute(tx);
          return (await sql<{ email: string }>`SELECT email FROM users WHERE id = app.user_id()`.execute(tx)).rows[0]?.email ?? 'account';
        },
        { db: p.db, userId: s.userId },
      );
      return { secret, otpauthUri: otpauthUri(secret, email) };
    },
  );

  r.post(
    '/auth/mfa/enroll/confirm',
    {
      config: { auth: 'session', allowPartial: ['enrollment'] },
      schema: { body: z.object({ code: z.string().regex(/^\d{6}$/) }).strict(), response: { 200: MfaConfirmResponse } },
    },
    async (req, reply) => {
      const p = platformOf(req);
      const s = req.authState!;
      if (s.mfaEnabled) throw new AppError('MFA_ALREADY_ENABLED');
      // Changing the account's authenticators is a sensitive account change (ASVS 3.7.1): it needs a
      // password proof within the re-auth window, like the R-PERM-13 actions. Login/signup/invite
      // provide one; a stale (or stolen, idle) session re-authenticates first.
      if (!reauthFresh(s)) throw new AppError('REAUTH_REQUIRED');
      await enforceLimits(p.db, p.config.sessionSecret, [{ kind: 'mfa_user', parts: [s.userId], max: 5, windowSeconds: 300 }]);
      const secret = await readSecret(p, s.userId);
      if (!secret) throw new AppError('MFA_NOT_ENROLLED');
      const codes = newRecoveryCodes();
      const ok = await withPreTenant(
        async (tx, now) => {
          const step = verifyTotp(secret, req.body.code, now);
          if (step === null) return false;
          const u = await sql`UPDATE users SET mfa_enabled_at = ${new Date(now)}::timestamptz, mfa_last_used_step = ${step}
                               WHERE id = app.user_id() AND mfa_enabled_at IS NULL`.execute(tx);
          if (Number(u.numAffectedRows ?? 0) !== 1) return false;
          await sql`UPDATE mfa_recovery_codes SET used_at = ${new Date(now)}::timestamptz WHERE user_id = app.user_id() AND used_at IS NULL`.execute(tx);
          for (const c of codes) {
            await sql`INSERT INTO mfa_recovery_codes (user_id, code_hash, created_at) VALUES (app.user_id(), ${Buffer.from(sha256(normalizeRecoveryCode(c)))}, ${new Date(now)}::timestamptz)`.execute(tx);
          }
          return true;
        },
        { db: p.db, userId: s.userId },
      );
      if (!ok) {
        await authEvent(p, req, { event: 'mfa_failed', userId: s.userId });
        throw new AppError('MFA_CODE_INVALID');
      }
      await authEvent(p, req, { event: 'mfa_ok', userId: s.userId, tenantId: s.tenantId });
      const out = await startSession(req, reply, p, {
        userId: s.userId,
        tenant: s.tenantId !== null && s.role !== null ? { id: s.tenantId, role: s.role } : null,
        mfaVerified: true,
        reauthenticated: 'carry',
        auditAction: 'session.mfa_enrolled',
        requirePresented: true,
      });
      return { recoveryCodes: codes, session: out.session };
    },
  );

  r.post(
    '/auth/mfa/verify',
    {
      config: { auth: 'session', allowPartial: ['mfa_pending'] },
      schema: {
        body: z
          .object({ code: z.string().regex(/^\d{6}$/).optional(), recoveryCode: z.string().min(8).max(32).optional() })
          .strict()
          .refine((b) => (b.code === undefined) !== (b.recoveryCode === undefined), { message: 'exactly one of code, recoveryCode' }),
        response: { 200: LoginResponse },
      },
    },
    async (req, reply) => {
      const p = platformOf(req);
      const s = req.authState!;
      if (!s.mfaEnabled) throw new AppError('MFA_NOT_ENROLLED');
      await enforceLimits(p.db, p.config.sessionSecret, [{ kind: 'mfa_user', parts: [s.userId], max: 5, windowSeconds: 300 }]);
      const body = req.body;
      const ok = await verifySecondFactor(p, s.userId, body.code !== undefined ? { code: body.code } : { recoveryCode: body.recoveryCode! });
      if (!ok) {
        await authEvent(p, req, { event: 'mfa_failed', userId: s.userId });
        throw new AppError('MFA_CODE_INVALID');
      }
      await authEvent(p, req, { event: 'mfa_ok', userId: s.userId, tenantId: s.tenantId });
      return startSession(req, reply, p, {
        userId: s.userId,
        tenant: s.tenantId !== null && s.role !== null ? { id: s.tenantId, role: s.role } : null,
        mfaVerified: true,
        // a second factor alone is not re-authentication (R-PERM-13): keep the login-time instant
        reauthenticated: 'carry',
        auditAction: null,
        requirePresented: true,
      });
    },
  );
  r.post(
    '/auth/mfa/recovery-codes',
    // a fully verified session only (no partial states): MFA_REQUIRED while the factor is pending
    { config: { auth: 'session' }, schema: { response: { 200: RecoveryCodesResponse } } },
    async (req) => {
      const p = platformOf(req);
      const s = req.authState!;
      if (!s.mfaEnabled) throw new AppError('MFA_NOT_ENROLLED');
      // replacing an authenticator is a sensitive account change (ASVS 3.7.1), like enrollment
      if (!reauthFresh(s)) throw new AppError('REAUTH_REQUIRED');
      await enforceLimits(p.db, p.config.sessionSecret, [{ kind: 'mfa_codes_user', parts: [s.userId], max: 5, windowSeconds: 3600 }]);
      const codes = newRecoveryCodes();
      const replace = async (tx: Parameters<Parameters<typeof withPreTenant>[0]>[0], now: number) => {
        await sql`UPDATE mfa_recovery_codes SET used_at = ${new Date(now)}::timestamptz WHERE user_id = app.user_id() AND used_at IS NULL`.execute(tx);
        for (const c of codes) {
          await sql`INSERT INTO mfa_recovery_codes (user_id, code_hash, created_at) VALUES (app.user_id(), ${Buffer.from(sha256(normalizeRecoveryCode(c)))}, ${new Date(now)}::timestamptz)`.execute(tx);
        }
      };
      if (s.tenantId !== null && s.role !== null) {
        const actor = actorFor({ userId: s.userId, tenantId: s.tenantId, role: s.role, sessionId: s.sessionId });
        await withTenantTx(
          actor,
          async (tx, now) => {
            await replace(tx, now);
            await audit(tx, actor, { action: 'mfa.recovery_codes_regenerated', entity: { type: 'user', id: s.userId } });
          },
          { db: p.db },
        );
      } else {
        await withPreTenant((tx, now) => replace(tx, now), { db: p.db, userId: s.userId });
      }
      return { recoveryCodes: codes };
    },
  );
}
