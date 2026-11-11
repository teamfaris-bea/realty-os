// Opaque sessions (ARCHITECTURE §3 step 3; R-AUTH, R-PERM-14, R-TEN-3).
//
// - Cookie `__Host-sid` (httpOnly, Secure, SameSite=Lax, Path=/) holds 32 random bytes; the DB keeps
//   only sha256(token). `sid` without Secure only when SESSION_COOKIE_SECURE=false (plain-http dev).
// - Idle / absolute expiry come from tenant_settings (168 h / 30 d by default); idle slides on use
//   (at most once a minute), never past the absolute expiry.
// - Rotation: login, MFA verification/enrollment, re-authentication, tenant switch and invite
//   acceptance always issue a NEW session and revoke the presented one (`rotation` / `tenant_switch`)
//   in the same transaction, so a fixated or stolen pre-elevation token gains nothing.
// - Resolution: auth.resolve_session (pre-tenant definer) → the active membership's role; a removed
//   or suspended membership, disabled user, suspended tenant or revoked/expired session ⇒ no row ⇒
//   401. The Actor is built ONLY from this row (R-TEN-3).
import { randomInt } from 'node:crypto';
import type { IdGenerator, Instant, Role, TenantId, UserActor, UserId } from '@realty/core/foundation';
import { instantFromDate, isRole } from '@realty/core/foundation';
import { type Database, type Tx, withPreTenant, withPreTenantThenTenant, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { AppError } from '../errors.js';
import { newOpaqueToken, opaqueTokenHash } from './tokens.js';

export const DEFAULT_IDLE_HOURS = 168;
export const DEFAULT_ABSOLUTE_DAYS = 30;
const SLIDE_EVERY_MS = 60_000;

export function sessionCookieName(secure: boolean): string {
  return secure ? '__Host-sid' : 'sid';
}

export function sessionCookieOptions(secure: boolean, maxAgeSeconds: number) {
  return { httpOnly: true, secure, sameSite: 'lax' as const, path: '/', maxAge: Math.max(0, Math.floor(maxAgeSeconds)) };
}

export interface ResolvedSession {
  sessionId: string;
  userId: UserId;
  tenantId: TenantId | null;
  role: Role | null;
  mfaVerifiedAt: Instant | null;
  reauthenticatedAt: Instant | null;
  idleExpiresAt: Instant;
  lastSeenAt: Instant;
}

/** Everything the guard needs about the caller (req.authState). */
export interface AuthState extends ResolvedSession {
  /** DB clock of the resolving transaction (reauth freshness, MFA steps) */
  now: Instant;
  mfaEnabled: boolean;
  /** the active tenant requires MFA for this role (mfa_required_roles ⊇ owner, admin) */
  mfaRequiredForRole: boolean;
}

interface ResolveRow {
  session_id: string;
  user_id: string;
  tenant_id: string | null;
  role: string | null;
  mfa_verified_at: Date | null;
  reauthenticated_at: Date | null;
  idle_expires_at: Date;
  last_seen_at: Date;
}

const inst = (d: Date | null): Instant | null => (d === null ? null : instantFromDate(d));

/** A user actor for a resolved session (the ONLY place request actors come from). */
export function actorFor(s: { userId: UserId; tenantId: TenantId; role: Role; sessionId: string }): UserActor {
  return { kind: 'user', userId: s.userId, tenantId: s.tenantId, role: s.role, sessionId: s.sessionId };
}

/** Resolves a cookie token to its session and the caller's MFA/settings state, or null. */
function baseOf(row: ResolveRow): ResolvedSession | null {
  const role = row.role !== null && isRole(row.role) ? row.role : null;
  if (row.tenant_id !== null && role === null) return null;
  return {
    sessionId: row.session_id,
    userId: row.user_id as UserId,
    tenantId: row.tenant_id as TenantId | null,
    role,
    mfaVerifiedAt: inst(row.mfa_verified_at),
    reauthenticatedAt: inst(row.reauthenticated_at),
    idleExpiresAt: instantFromDate(row.idle_expires_at),
    lastSeenAt: instantFromDate(row.last_seen_at),
  };
}

async function slide(tx: Tx, base: ResolvedSession, now: Instant, idleHours: number): Promise<void> {
  if (now - base.lastSeenAt < SLIDE_EVERY_MS) return;
  await sql`UPDATE sessions SET last_seen_at = ${new Date(now)}::timestamptz,
                   idle_expires_at = LEAST(${new Date(now)}::timestamptz + make_interval(hours => ${idleHours}), absolute_expires_at)
             WHERE id = ${base.sessionId}::uuid AND revoked_at IS NULL`.execute(tx);
}

/**
 * The presented session, or null. A session with an active tenant (every request of the app) is
 * resolved in ONE transaction (withPreTenantThenTenant, lane perf-misses): auth.resolve_session without
 * tenant context, then the tenant step (MFA state, idle window, slide) under the actor that the session
 * row names, exactly as the former second transaction did.
 */
export async function resolveSession(db: Database, token: string | undefined): Promise<AuthState | null> {
  const hash = opaqueTokenHash(token);
  if (!hash) return null;
  const { pre, result } = await withPreTenantThenTenant(
    async (tx, now) => {
      const r = await sql<ResolveRow>`SELECT * FROM auth.resolve_session(${Buffer.from(hash)}, ${new Date(now)}::timestamptz)`.execute(tx);
      const row = r.rows[0];
      return { base: row ? baseOf(row) : null };
    },
    ({ base }) =>
      base && base.tenantId !== null && base.role !== null ? actorFor({ userId: base.userId, tenantId: base.tenantId, role: base.role, sessionId: base.sessionId }) : null,
    async (tx, now, { base }): Promise<AuthState | null> => {
      const b = base!;
      const r = await sql<{ mfa_enabled: boolean; required: boolean; idle: number }>`
        SELECT u.mfa_enabled_at IS NOT NULL AS mfa_enabled,
               ${b.role}::text = ANY (ts.mfa_required_roles) AS required,
               ts.session_idle_hours AS idle
          FROM users u CROSS JOIN tenant_settings ts
         WHERE u.id = app.user_id() AND ts.tenant_id = app.tenant_id()`.execute(tx);
      const s = r.rows[0];
      if (!s) return null;
      await slide(tx, b, now, s.idle);
      return { ...b, now, mfaEnabled: s.mfa_enabled, mfaRequiredForRole: s.required };
    },
    { db },
  );
  const base = pre.base;
  if (!base) return null;
  if (base.tenantId !== null) return result;
  return withPreTenant(
    async (tx, now) => {
      const r = await sql<{ mfa_enabled: boolean }>`SELECT mfa_enabled_at IS NOT NULL AS mfa_enabled FROM users WHERE id = app.user_id()`.execute(tx);
      const s = r.rows[0];
      if (!s) return null;
      await slide(tx, base, now, DEFAULT_IDLE_HOURS);
      return { ...base, now, mfaEnabled: s.mfa_enabled, mfaRequiredForRole: false };
    },
    { db, userId: base.userId },
  );
}

export interface IssueOptions {
  userId: UserId;
  /** the session's active tenant (must be an active membership), or null */
  tenant: { id: TenantId; role: Role } | null;
  mfaVerified: boolean;
  reauthenticated: boolean;
  ip: string | null;
  userAgent: string | null;
  /** the presented session this one replaces (revoked in the same transaction) */
  replaces?: { sessionId: string; reason: 'rotation' | 'tenant_switch' };
  /** keep the replaced session's MFA verification instant instead of now/null */
  carryMfaVerifiedAt?: Instant | null;
  /** keep the replaced session's re-authentication instant instead of now/null (R-PERM-13) */
  carryReauthenticatedAt?: Instant | null;
  /**
   * The replaced session is the authority for this new one (tenant switch, re-auth, MFA): when it
   * was revoked or expired in the meantime (logout, password reset revoke-all), nothing is issued
   * and the call fails with UNAUTHENTICATED. Without it (login, signup) revoking it is best effort.
   */
  requireReplaced?: boolean;
}

export interface IssuedSession {
  token: string;
  sessionId: string;
  maxAgeSeconds: number;
  /** DB clock at issue (mfa_verified_at / reauthenticated_at when set) */
  issuedAt: Instant;
}

/**
 * Issues a session in one transaction: revokes the replaced one, inserts the new one (sessions RLS:
 * self only), then runs `inTx` (audit rows) in the same transaction.
 */
export async function issueSessionTx(
  db: Database,
  ids: IdGenerator,
  o: IssueOptions,
  inTx?: (tx: Tx, now: Instant, sessionId: string) => Promise<void>,
): Promise<IssuedSession> {
  const sessionId = ids.next<'SessionId'>();
  const { token, hash } = newOpaqueToken();
  const run = async (tx: Tx, now: Instant, idleHours: number, absoluteDays: number): Promise<IssuedSession> => {
    if (o.replaces) {
      // Row lock + re-check under READ COMMITTED: a concurrent revoke-all (password reset) or logout
      // that commits first leaves 0 rows here, so a rotation can never outlive a revocation.
      const r = await sql`UPDATE sessions SET revoked_at = ${new Date(now)}::timestamptz, revoked_reason = ${o.replaces.reason}
                 WHERE id = ${o.replaces.sessionId}::uuid AND user_id = app.user_id() AND revoked_at IS NULL
                   AND idle_expires_at > ${new Date(now)}::timestamptz AND absolute_expires_at > ${new Date(now)}::timestamptz`.execute(tx);
      if (o.requireReplaced && Number(r.numAffectedRows ?? 0) !== 1) throw new AppError('UNAUTHENTICATED');
    } else if (o.requireReplaced) {
      throw new AppError('UNAUTHENTICATED');
    }
    const nowD = new Date(now);
    const absolute = new Date(now + absoluteDays * 86_400_000);
    const idle = new Date(Math.min(now + idleHours * 3_600_000, absolute.getTime()));
    const mfaAt = o.carryMfaVerifiedAt !== undefined ? (o.carryMfaVerifiedAt === null ? null : new Date(o.carryMfaVerifiedAt)) : o.mfaVerified ? nowD : null;
    const reauthAt =
      o.carryReauthenticatedAt !== undefined ? (o.carryReauthenticatedAt === null ? null : new Date(o.carryReauthenticatedAt)) : o.reauthenticated ? nowD : null;
    await sql`
      INSERT INTO sessions (id, token_hash, user_id, active_tenant_id, created_at, last_seen_at, idle_expires_at, absolute_expires_at,
                            mfa_verified_at, reauthenticated_at, ip, user_agent)
      VALUES (${sessionId}::uuid, ${Buffer.from(hash)}, ${o.userId}::uuid, ${o.tenant?.id ?? null}::uuid, ${nowD}, ${nowD}, ${idle}, ${absolute},
              ${mfaAt}, ${reauthAt}, ${o.ip}::inet, ${o.userAgent ? o.userAgent.slice(0, 300) : null})`.execute(tx);
    if (inTx) await inTx(tx, now, sessionId);
    return { token, sessionId, maxAgeSeconds: absoluteDays * 86_400, issuedAt: now };
  };
  if (o.tenant) {
    const actor = actorFor({ userId: o.userId, tenantId: o.tenant.id, role: o.tenant.role, sessionId });
    return withTenantTx(
      actor,
      async (tx, now) => {
        const s = await sql<{ idle: number; abs: number }>`
          SELECT session_idle_hours AS idle, session_absolute_days AS abs FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx);
        const row = s.rows[0];
        if (!row) throw new Error('tenant settings not visible: membership is not active');
        return run(tx, now, row.idle, row.abs);
      },
      { db },
    );
  }
  return withPreTenant((tx, now) => run(tx, now, DEFAULT_IDLE_HOURS, DEFAULT_ABSOLUTE_DAYS), { db, userId: o.userId });
}

/** Revokes one of the caller's sessions (logout). Returns false when it was already gone. */
export async function revokeSession(db: Database, userId: UserId, sessionId: string, reason: 'logout' | 'rotation' | 'suspicious'): Promise<boolean> {
  return withPreTenant(
    async (tx, now) => {
      const r = await sql`UPDATE sessions SET revoked_at = ${new Date(now)}::timestamptz, revoked_reason = ${reason}
                           WHERE id = ${sessionId}::uuid AND user_id = app.user_id() AND revoked_at IS NULL`.execute(tx);
      return Number(r.numAffectedRows ?? 0) > 0;
    },
    { db, userId },
  );
}

/** The active tenants of a user (auth.user_tenants, ordered by name). */
export async function userTenants(db: Database, userId: UserId): Promise<{ tenantId: TenantId; slug: string; name: string; role: Role }[]> {
  return withPreTenant(
    async (tx) => {
      const r = await sql<{ tenant_id: string; slug: string; name: string; role: string }>`SELECT * FROM auth.user_tenants()`.execute(tx);
      return r.rows.filter((x) => isRole(x.role)).map((x) => ({ tenantId: x.tenant_id as TenantId, slug: x.slug, name: x.name, role: x.role as Role }));
    },
    { db, userId },
  );
}

/** A uniformly random 6-digit code (alert-phone verification). */
export function sixDigitCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}
