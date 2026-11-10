// Shared request helpers of api/accountability (BUILD_PLAN module 15).
//
// Every request runs in ONE withTenantTx as the session actor, so RLS decides which exception items,
// deals and contacts exist for the caller (exception_items: tenant-wide, own, or a Team Lead's team);
// an invisible item is 404 (R-PERM-5). Postgres errors a request can legitimately hit map to stable
// codes; anything else is a 500 without SQL or PII (CONVENTIONS §7).
import type { Instant, UserActor } from '@realty/core/foundation';
import { type Tx, type TenantTxOptions, withTenantTx } from '@realty/db';
import type { FastifyRequest } from 'fastify';
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

/** Maps the Postgres errors an accountability request can legitimately hit to stable codes (null: unexpected). */
export function mapAccountabilityDbError(e: unknown): AppError | null {
  if (e instanceof AppError) return e;
  const pe = (e && typeof e === 'object' ? e : {}) as PgErrorLike;
  const msg = pe.message ?? '';
  // F7 trigger (R-ACC-3): the reassignment the event cites is not in the ledger. The API only ever
  // cites the command it just ran, so this is a lost race or a bug, never a user input problem.
  if (msg.startsWith('EXCEPTION_REASSIGN_UNPROVEN')) return new AppError('EXCEPTION_STATE_CONFLICT', { reason: 'REASSIGN_UNPROVEN' });
  switch (pe.code) {
    case '42501': // RLS refused the row (an item the caller may not act on as their true role)
    case '23503':
      return new AppError('NOT_FOUND');
    case '23514':
      return new AppError('VALIDATION_FAILED', { reason: 'CHECK_VIOLATION', constraint: pe.constraint ?? null });
    case '22P02':
    case '22007':
    case '22008':
      return new AppError('VALIDATION_FAILED', { reason: 'INVALID_VALUE' });
    default:
      return null;
  }
}

/** One request transaction as the session actor (RLS-bound), with DB errors mapped. */
export async function accTx<T>(req: FastifyRequest, fn: (tx: Tx, now: Instant, actor: UserActor) => Promise<T>, o: Omit<TenantTxOptions, 'db'> = {}): Promise<T> {
  const actor = actorOf(req);
  try {
    return await withTenantTx(actor, (tx, now) => fn(tx, now, actor), { retries: 2, ...o, db: platformOf(req).db });
  } catch (e) {
    const mapped = mapAccountabilityDbError(e);
    if (mapped) throw mapped;
    throw e;
  }
}

export const iso = (d: Date | string | number): string => new Date(d).toISOString();
export const isoOrNull = (d: Date | string | number | null | undefined): string | null => (d === null || d === undefined ? null : iso(d));
export const ms = (d: Date | string): Instant => new Date(d).getTime() as Instant;
export const msOrNull = (d: Date | string | null | undefined): Instant | null => (d === null || d === undefined ? null : ms(d));
