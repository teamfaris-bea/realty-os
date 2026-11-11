// Shared request helpers of api/lists (PARITY_PLAN module 60).
import type { Instant, UserActor } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import type { FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { AppError, type ErrorCode, isErrorCode } from '../errors.js';
import type { Platform } from '../server.js';

/** R-PAR-29: a list run (page, count, selection) has 3 s; past it the run is LIST_TOO_SLOW. */
export const LIST_STATEMENT_TIMEOUT_MS = 3_000;

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

/** Trigger messages ("CODE: sentence") the lists tables raise, mapped to the same API code. */
const TRIGGER_CODES = new Set<ErrorCode>([
  'TAG_LIMIT',
  'CONTACT_TAG_LIMIT',
  'AUDIENCE_PROTECTED_PROXY',
  'TAG_PROTECTION_OWNER_ONLY',
  'TAG_MERGE_INVALID',
  'CUSTOM_FIELD_LIMIT',
  'CUSTOM_FIELD_IMMUTABLE',
  'CUSTOM_FIELD_OPTION_REMOVED',
  'CUSTOM_FIELD_OPTIONS_INVALID',
  'CUSTOM_FIELD_ARCHIVED',
  'CUSTOM_VALUE_TYPE',
  'CUSTOM_VALUE_OPTION',
  'SMART_LIST_IMMUTABLE',
]);

/** Maps the Postgres errors a lists request can legitimately hit to stable codes (null: unexpected). */
export function mapListsDbError(e: unknown): AppError | null {
  if (e instanceof AppError) return e;
  const pe = (e && typeof e === 'object' ? e : {}) as PgErrorLike;
  const prefix = /^([A-Z][A-Z0-9_]+):/.exec(pe.message ?? '')?.[1];
  if (prefix && isErrorCode(prefix) && TRIGGER_CODES.has(prefix)) return new AppError(prefix);
  if (prefix === 'TAG_MANAGE_REQUIRED') return new AppError('NOT_FOUND');
  switch (pe.code) {
    case '57014': // statement_timeout (R-PAR-29)
      return new AppError('LIST_TOO_SLOW');
    case '23505':
      if (pe.constraint === 'custom_field_defs_label_live') return new AppError('CUSTOM_FIELD_LABEL_TAKEN');
      if (pe.constraint === 'custom_field_defs_tenant_id_key_key') return new AppError('CUSTOM_FIELD_KEY_INVALID');
      if (pe.constraint === 'tags_tenant_id_name_key_key') return new AppError('TAG_NAME_TAKEN');
      return null;
    case '23514': // a CHECK constraint (e.g. the built-in protected keys of custom_field_defs)
      if (pe.constraint === 'custom_field_defs_key_check1') return new AppError('CUSTOM_FIELD_PROTECTED');
      if (pe.constraint === 'custom_field_defs_key_check') return new AppError('CUSTOM_FIELD_KEY_INVALID');
      if (pe.constraint === 'smart_lists_definition_check') return new AppError('LIST_DEFINITION_TOO_LARGE');
      return null;
    case '42501': // RLS refused the row: the caller may not write it
    case '23503': // an id that is not a row of this tenant
      return new AppError('NOT_FOUND');
    default:
      return null;
  }
}

/** One request transaction as the session actor (RLS-bound), with DB errors mapped. */
export async function listsTx<T>(req: FastifyRequest, fn: (tx: Tx, now: Instant, actor: UserActor) => Promise<T>): Promise<T> {
  const actor = actorOf(req);
  try {
    return await withTenantTx(actor, (tx, now) => fn(tx, now, actor), { db: platformOf(req).db, retries: 2 });
  } catch (e) {
    const mapped = mapListsDbError(e);
    if (mapped) throw mapped;
    throw e;
  }
}

/** R-PAR-29: bounds every following statement of this transaction to 3 s (SET LOCAL semantics). */
export async function limitListStatement(tx: Tx, ms = LIST_STATEMENT_TIMEOUT_MS): Promise<void> {
  await sql`SELECT set_config('statement_timeout', ${String(Math.max(1, Math.floor(ms)))}, true)`.execute(tx);
}
