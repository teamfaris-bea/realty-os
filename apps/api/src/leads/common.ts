// Shared request helpers of api/leads.
import type { Instant, UserActor } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
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
}

/** Maps the Postgres errors a leads request can legitimately hit to stable codes (null: unexpected). */
export function mapLeadsDbError(e: unknown): AppError | null {
  if (e instanceof AppError) return e;
  const pe = (e && typeof e === 'object' ? e : {}) as PgErrorLike;
  const msg = pe.message ?? '';
  if (msg.startsWith('LAST_OWNER')) return new AppError('LAST_OWNER');
  if (msg.startsWith('OWNER_ROLE_REQUIRES_OWNER')) return new AppError('OWNER_REQUIRED');
  switch (pe.code) {
    case '42501': // RLS refused the row: the caller may not write it
    case '23503': // an id that is not a row of this tenant
      return new AppError('NOT_FOUND');
    default:
      return null;
  }
}

/** One request transaction as the session actor (RLS-bound), with DB errors mapped. */
export async function leadsTx<T>(req: FastifyRequest, fn: (tx: Tx, now: Instant, actor: UserActor) => Promise<T>, o: { ownershipCommand?: string } = {}): Promise<T> {
  const actor = actorOf(req);
  try {
    return await withTenantTx(actor, (tx, now) => fn(tx, now, actor), { db: platformOf(req).db, retries: 2, ...o });
  } catch (e) {
    const mapped = mapLeadsDbError(e);
    if (mapped) throw mapped;
    throw e;
  }
}

/** A nil uuid for commands whose target is unknown to the caller (the engine rejects them precisely). */
export const NIL_UUID = '00000000-0000-0000-0000-000000000000';
