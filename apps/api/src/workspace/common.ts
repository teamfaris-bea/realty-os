// Shared request helpers of api/workspace (BUILD_PLAN module 14).
//
// Every request runs in ONE withTenantTx as the session actor, so RLS decides which rows exist for the
// caller (R-PERM-4); an invisible row is 404 (R-PERM-5). Postgres errors a request can legitimately hit
// map to stable codes; anything else is a 500 without SQL or PII (CONVENTIONS §7).
import type { Instant, UserActor } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import type { FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { AppError } from '../errors.js';
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
  message?: string;
  constraint?: string;
}

/** Maps the Postgres errors a workspace request can legitimately hit to stable codes (null: unexpected). */
export function mapWorkspaceDbError(e: unknown): AppError | null {
  if (e instanceof AppError) return e;
  const pe = (e && typeof e === 'object' ? e : {}) as PgErrorLike;
  const msg = pe.message ?? '';
  if (msg.startsWith('ATTRIBUTION_IMMUTABLE')) return new AppError('VALIDATION_FAILED', { reason: 'ATTRIBUTION_IMMUTABLE' });
  switch (pe.code) {
    case '42501': // RLS refused the row: the caller may not write it
    case '23503': // a reference that is not a row of this tenant (or not visible)
      return new AppError('NOT_FOUND');
    case '23514': // a CHECK the API did not pre-validate (shape rules stay in the DB)
      if (pe.constraint === 'notification_preferences_check') return new AppError('NOTIFICATION_CRITICAL');
      return new AppError('VALIDATION_FAILED', { reason: 'CHECK_VIOLATION', constraint: pe.constraint ?? null });
    case '22P02': // invalid text representation (bad enum/uuid that slipped through)
    case '22007': // invalid datetime
    case '22008':
      return new AppError('VALIDATION_FAILED', { reason: 'INVALID_VALUE' });
    default:
      return null;
  }
}

/** One request transaction as the session actor (RLS-bound), with DB errors mapped. */
export async function wsTx<T>(req: FastifyRequest, fn: (tx: Tx, now: Instant, actor: UserActor) => Promise<T>): Promise<T> {
  const actor = actorOf(req);
  try {
    return await withTenantTx(actor, (tx, now) => fn(tx, now, actor), { db: platformOf(req).db, retries: 2 });
  } catch (e) {
    const mapped = mapWorkspaceDbError(e);
    if (mapped) throw mapped;
    throw e;
  }
}

export const isoOrNull = (d: Date | string | null | undefined): string | null => (d === null || d === undefined ? null : new Date(d).toISOString());
export const iso = (d: Date | string): string => new Date(d).toISOString();

/** The caller's active role and team relation to another member (assignment rules). */
export async function memberRelation(tx: Tx, userId: string): Promise<{ active: boolean; role: string | null; inMyTeam: boolean } | null> {
  const r = await sql<{ status: string; role: string; in_team: boolean }>`
    SELECT status, role, user_id = ANY (app.my_team_member_ids()) AS in_team
      FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = ${userId}`.execute(tx);
  const m = r.rows[0];
  if (!m) return null;
  return { active: m.status === 'active', role: m.role, inMyTeam: m.in_team === true };
}

/**
 * Who the caller may assign work (a task, an appointment, a deal) to: themselves; Owner/Admin anyone
 * active; a Team Lead the members of the teams they lead. TCs are never deal owners (R-PERM-15).
 */
export async function assertAssignable(tx: Tx, actor: UserActor, userId: string, o: { canOwnLeads?: boolean } = {}): Promise<void> {
  if (userId === actor.userId && !(o.canOwnLeads && actor.role === 'tc')) return;
  const m = await memberRelation(tx, userId);
  const allowedRole = actor.role === 'owner' || actor.role === 'admin' || (actor.role === 'team_lead' && m?.inMyTeam === true);
  if (!m || !m.active || !allowedRole || (o.canOwnLeads && m.role === 'tc')) throw new AppError('ASSIGNEE_NOT_ELIGIBLE');
}

/** PII-free short snippet of free text for lists (search, cards): collapses whitespace, clips. */
export function snippet(s: string | null | undefined, max = 120): string | null {
  if (s === null || s === undefined) return null;
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`;
}
