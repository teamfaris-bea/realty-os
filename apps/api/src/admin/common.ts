// Shared helpers for the admin routes (BUILD_PLAN module 10).
//
// - adminTx(): the request transaction (withTenantTx as the session actor) with the admin DB-error
//   mapping, so trigger refusals become stable codes instead of 500s:
//     memberships_guard   ROLE_CHANGE_FORBIDDEN → NOT_FOUND, OWNER_ROLE_REQUIRES_OWNER → OWNER_REQUIRED,
//                         LAST_OWNER → LAST_OWNER                                          (R-PERM-2)
//     tenant_settings_guard / compliance_policy_guard OWNER_ONLY_* → OWNER_REQUIRED       (R-PERM-3)
//     teams_guard DEFAULT_TEAM_PROTECTED, ponds default CHECK → DEFAULT_POND_PROTECTED
//   The API checks the same rules first with core.can() and explicit reads; the triggers are the
//   backstop for races and for anything the API missed.
// - recheck(): core.can() again INSIDE the write transaction, on facts read under the row lock, so a
//   target that changed between authorize() (its own read) and the write is judged on fresh facts.
// - adminLock(): a per-tenant advisory lock that serializes one kind of admin write (rule positions,
//   policy version numbers). Admin transactions take no contact locks, so this sits outside the
//   global contact lock order (ARCHITECTURE §10) and cannot form a cycle with it.
import type { Action, ResourceFacts, UserActor } from '@realty/core/foundation';
import { can, toIso } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import type { Instant } from '@realty/core/foundation';
import type { FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { AppError, type ErrorDetails, isErrorCode } from '../errors.js';
import type { Platform } from '../server.js';

export function platformOf(req: FastifyRequest): Platform {
  return req.server.platform;
}

export function actorOf(req: FastifyRequest): UserActor {
  const a = req.actor;
  if (!a) throw new AppError('UNAUTHENTICATED');
  return a;
}

interface PgErrorLike {
  code?: string;
  constraint?: string;
  message?: string;
}

function pgError(e: unknown): PgErrorLike {
  return (e && typeof e === 'object' ? e : {}) as PgErrorLike;
}

/** Maps the admin-relevant Postgres errors to AppErrors (null: not an admin-mapped error). */
export function mapAdminDbError(e: unknown): AppError | null {
  if (e instanceof AppError) return e;
  const pe = pgError(e);
  const msg = pe.message ?? '';
  if (msg.startsWith('LAST_OWNER')) return new AppError('LAST_OWNER');
  if (msg.startsWith('OWNER_ROLE_REQUIRES_OWNER') || msg.startsWith('OWNER_ONLY_')) return new AppError('OWNER_REQUIRED');
  if (msg.startsWith('ROLE_CHANGE_FORBIDDEN')) return new AppError('NOT_FOUND');
  if (msg.startsWith('DEFAULT_TEAM_PROTECTED')) return new AppError('DEFAULT_TEAM_PROTECTED');
  switch (pe.code) {
    case '23514': // check_violation
      if (pe.constraint === 'ponds_check') return new AppError('DEFAULT_POND_PROTECTED');
      return new AppError('VALIDATION_FAILED', { issues: [{ path: '/', code: 'constraint' }] });
    case '23505': // unique_violation
      if (pe.constraint === 'invites_one_pending') return new AppError('INVITE_PENDING');
      return new AppError('VERSION_CONFLICT');
    case '23503': // foreign_key_violation: an id that is not a row of this tenant
      return new AppError('NOT_FOUND');
    case '22023': // invalid_parameter_value (unknown time zone in tenant_settings_guard)
      if (/time zone/i.test(msg)) return new AppError('TIMEZONE_INVALID');
      return null;
    case '42501': // insufficient_privilege: RLS refused the row
      return new AppError('NOT_FOUND');
    default:
      return null;
  }
}

/** One admin request transaction as the session actor, with DB errors mapped to stable codes. */
export async function adminTx<T>(req: FastifyRequest, fn: (tx: Tx, now: Instant, actor: UserActor) => Promise<T>): Promise<T> {
  const p = platformOf(req);
  const actor = actorOf(req);
  try {
    return await withTenantTx(actor, (tx, now) => fn(tx, now, actor), { db: p.db, retries: 2 });
  } catch (e) {
    const mapped = mapAdminDbError(e);
    if (mapped) throw mapped;
    throw e;
  }
}

/** Re-authorizes inside the write transaction with facts read under the row lock. */
export function recheck(req: FastifyRequest, action: Action, facts: ResourceFacts, details?: ErrorDetails): void {
  const actor = actorOf(req);
  const state = req.authState;
  if (!state) throw new AppError('UNAUTHENTICATED');
  const r = can(actor, action, { ...facts, reauth: { reauthenticatedAt: state.reauthenticatedAt, now: state.now } });
  if (!r.ok) throw new AppError(isErrorCode(r.code) ? r.code : 'NOT_FOUND', r.code === 'NOT_FOUND' ? undefined : details);
}

export type AdminLockScope = 'routing_rules' | 'policy' | 'ponds' | 'teams';

/** Serializes one kind of admin write per tenant until the transaction ends. */
export async function adminLock(tx: Tx, scope: AdminLockScope): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(app.tenant_id()::text || ':admin:' || ${scope}::text, 0))`.execute(tx);
}

export function iso(d: Date | null | undefined): string | null {
  return d ? toIso(d.getTime() as Instant) : null;
}

/** 'HH:MM:SS' from Postgres → 'HH:MM' (or 'HH:MM:SS' when seconds are not zero). */
export function hhmm(t: string): string {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?/.exec(t);
  if (!m) return t;
  return m[3] && m[3] !== '00' ? `${m[1]}:${m[2]}:${m[3]}` : `${m[1]}:${m[2]}`;
}

/** Seconds since midnight of 'HH:MM[:SS]'. */
export function timeSeconds(t: string): number {
  const m = /^(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t.slice(0, 8));
  if (!m) throw new TypeError(`not a time: ${t}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
}
