// Shared helpers of api/people (PARITY_PLAN module 57).
import type { Instant, ResourceFacts, UserActor } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors.js';
import { actorOf, mapLeadsDbError, platformOf } from '../leads/common.js';
import { factsOf } from '../leads/contacts.js';
import * as leads from '../leads/repos/contacts.js';

export { actorOf, platformOf };

interface PgErrorLike {
  code?: string;
  message?: string;
  constraint?: string;
  table?: string;
}

/** The Postgres errors an api/people request can legitimately hit, as stable codes (null: unexpected). */
export function mapPeopleDbError(e: unknown): AppError | null {
  if (e instanceof AppError) return e;
  const pe = (e && typeof e === 'object' ? e : {}) as PgErrorLike;
  const msg = pe.message ?? '';
  if (msg.startsWith('STAGE_NEEDS_CONTACT')) return new AppError('STAGE_NEEDS_CONTACT');
  if (msg.startsWith('CONTACT_POINT_IMMUTABLE')) return new AppError('VALIDATION_FAILED', { issues: [{ path: '/address', code: 'immutable' }] });
  if (msg.startsWith('REMOVED_REASON_WRONG_NUMBER')) return new AppError('WRONG_NUMBER_NOT_RECORDED');
  if (msg.startsWith('REMOVED_REASON_IMMUTABLE')) return new AppError('WRONG_NUMBER_FINAL');
  if (msg.startsWith('NOTE_READ_ONLY')) return new AppError('NOTE_READ_ONLY');
  if (msg.startsWith('NOTE_AUTHOR_ONLY')) return new AppError('NOTE_AUTHOR_ONLY');
  if (msg.startsWith('STAGE_LABEL_INVALID')) return new AppError('STAGE_LABEL_INVALID');
  if (msg.startsWith('PERSON_OPT_OUT')) return new AppError('NOT_FOUND');
  if (pe.code === '23514' && pe.constraint === 'notes_activity_at_window') return new AppError('ACTIVITY_OUT_OF_WINDOW');
  if (pe.code === '23505' && pe.table === 'contact_relationships') return new AppError('RELATIONSHIP_EXISTS');
  if (pe.code === '23505' && pe.table === 'contact_points') return new AppError('POINT_EXISTS');
  if (pe.code === '23505' && pe.table === 'notes') return new AppError('COMMAND_ID_REUSED');
  if (pe.code === '23514' && pe.table === 'contact_relationships') return new AppError('VALIDATION_FAILED', { issues: [{ path: '/relatedContactId', code: 'invalid' }] });
  return mapLeadsDbError(e);
}

/** One request transaction as the session actor (RLS-bound), with DB errors mapped. */
export async function peopleTx<T>(req: FastifyRequest, fn: (tx: Tx, now: Instant, actor: UserActor) => Promise<T>): Promise<T> {
  const actor = actorOf(req);
  try {
    return await withTenantTx(actor, (tx, now) => fn(tx, now, actor), { db: platformOf(req).db, retries: 2 });
  } catch (e) {
    const mapped = mapPeopleDbError(e);
    if (mapped) throw mapped;
    throw e;
  }
}

export function idOf(req: FastifyRequest): string {
  return (req.params as { id: string }).id;
}

/**
 * The caller's §3 relation to a contact whose DETAIL they see; null (404) for a card-only or invisible
 * contact (R-PERM-5, R-PERM-6): a pond card is never edited, noted or linked.
 */
export function detailFacts(req: FastifyRequest, id: (req: FastifyRequest) => string = idOf): Promise<ResourceFacts | null> {
  return peopleTx(req, async (tx) => {
    const row = await leads.getContact(tx, id(req));
    return row && row.detail_visible ? factsOf(row) : null;
  });
}

/**
 * As detailFacts, for a write: the contact must also be live. A merged-away loser (still visible to tenant-wide
 * roles) takes no new notes, points, links or edits, which would be stranded on it (security review, R-PAR-45).
 * The one exception is a write that only records an opt-out, the person-level do-not-contact (contacts.ts
 * optOutAuth): it only tightens, and the DB carries it to the survivor (app.contacts_dnc_follow_merge, E140).
 */
export function liveDetailFacts(req: FastifyRequest, id: (req: FastifyRequest) => string = idOf): Promise<ResourceFacts | null> {
  return peopleTx(req, async (tx) => {
    const row = await leads.getContact(tx, id(req));
    return row && row.detail_visible && row.merged_into_contact_id === null ? factsOf(row) : null;
  });
}

/** Whether the role sees every contact of the tenant (Owner/Admin). */
export function tenantWide(actor: UserActor): boolean {
  return actor.role === 'owner' || actor.role === 'admin';
}

export function encodeCursor(v: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(v)).toString('base64url');
}

export function decodeCursor<T>(s: string, check: (v: unknown) => v is T): T | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));
    return check(v) ? v : null;
  } catch {
    return null;
  }
}
