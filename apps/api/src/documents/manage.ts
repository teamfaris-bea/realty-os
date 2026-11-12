// Share, legal hold and retention (deliverable 5; R-DOC-1, R-DOC-4, R-DOC-8, R-DOC-9, E409-E411, E419).
//
// Share: clean deal and listing documents only; the database re-checks who may (0069 documents_integrity_guard:
// deal_writable / listing_writable, so TCs and ISAs never share). Unsharing stops portal downloads at once (module
// 43's per-download re-check); the client's portal item is retracted by module 45, never here.
// Hold and retention: a human Owner or Admin, as themselves (0018 documents_guard), audited with before and after.
// The system stamp (scan.ts, the reconcile) only fills an empty retention_until: a value a person set, a shorter one
// included, is never overwritten, and contact documents are never stamped (E419).
import type { UserActor } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { audit, redactDiff } from '../audit.js';
import { AppError } from '../errors.js';
import * as R from './repos.js';
import { DOCUMENT_RETENTION_MAX_YEARS, DOCUMENT_RETENTION_MIN_YEARS, DOCUMENT_RETENTION_YEARS } from './types.js';

export async function setShared(tx: Tx, actor: UserActor, id: string, shared: boolean): Promise<R.DocRow> {
  const d = await R.docById(tx, id, { lock: true });
  if (!d) throw new AppError('NOT_FOUND');
  if (shared && (d.scan_status !== 'clean' || d.contact_id !== null)) throw new AppError('DOCUMENT_NOT_SHAREABLE');
  if (d.shared_to_portal !== shared) {
    await sql`UPDATE documents SET shared_to_portal = ${shared}, updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
    await audit(tx, actor, { action: shared ? 'document.shared' : 'document.unshared', entity: { type: 'document', id } });
  }
  return { ...d, shared_to_portal: shared };
}

export async function setHold(tx: Tx, actor: UserActor, id: string, hold: boolean, reason: string): Promise<R.DocRow> {
  const d = await R.docById(tx, id, { lock: true });
  if (!d) throw new AppError('NOT_FOUND');
  if (d.legal_hold !== hold) {
    await sql`UPDATE documents SET legal_hold = ${hold}, updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
    await audit(tx, actor, { action: hold ? 'document.hold_placed' : 'document.hold_lifted', entity: { type: 'document', id }, reason });
  }
  return { ...d, legal_hold: hold };
}

/** The instant retention is counted from: the scope's close, else the upload (deal: closed_at; listing: its latest closed listing-side deal). */
export async function retentionBase(tx: Tx, d: R.DocRow): Promise<Date> {
  if (d.deal_id) {
    const r = await sql<{ c: Date | null }>`SELECT closed_at AS c FROM deals WHERE tenant_id = app.tenant_id() AND id = ${d.deal_id}`.execute(tx);
    return r.rows[0]?.c ?? d.created_at;
  }
  if (d.listing_id) {
    const r = await sql<{ c: Date | null }>`
      SELECT max(closed_at) AS c FROM deals WHERE tenant_id = app.tenant_id() AND listing_id = ${d.listing_id} AND side IN ('sell','dual') AND closed_at IS NOT NULL`.execute(tx);
    return r.rows[0]?.c ?? d.created_at;
  }
  return d.created_at;
}

const addYears = (t: Date, n: number) => {
  const x = new Date(t.getTime());
  x.setUTCFullYear(x.getUTCFullYear() + n);
  return x;
};

/** Retention is 3-10 years after the base instant (R-DATA-6 range; VERIFY WITH COUNSEL). */
export function retentionInRange(base: Date, until: Date): boolean {
  return until.getTime() >= addYears(base, DOCUMENT_RETENTION_MIN_YEARS).getTime() && until.getTime() <= addYears(base, DOCUMENT_RETENTION_MAX_YEARS).getTime();
}

export async function setRetention(tx: Tx, actor: UserActor, id: string, until: Date): Promise<R.DocRow> {
  const d = await R.docById(tx, id, { lock: true });
  if (!d) throw new AppError('NOT_FOUND');
  const base = await retentionBase(tx, d);
  if (!retentionInRange(base, until)) {
    throw new AppError('DOCUMENT_RETENTION_OUT_OF_RANGE', { from: addYears(base, DOCUMENT_RETENTION_MIN_YEARS).toISOString(), to: addYears(base, DOCUMENT_RETENTION_MAX_YEARS).toISOString() });
  }
  await sql`UPDATE documents SET retention_until = ${until.toISOString()}::timestamptz, updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  await audit(tx, actor, { action: 'document.retention_changed', entity: { type: 'document', id }, changes: redactDiff({ retention_until: d.retention_until }, { retention_until: until }) });
  return { ...d, retention_until: until };
}

/**
 * As the system: stamps closed_at + 7 years on clean deal documents of closed deals and on listing documents of a
 * listing whose latest listing-side deal closed, only where retention_until is empty; never contact documents.
 * `documentId` limits it to one document (the scan's clean verdict). Returns the number stamped.
 */
export async function stampRetentionInTx(tx: Tx, documentId: string | null = null): Promise<number> {
  const one = documentId === null ? sql`` : sql`AND d.id = ${documentId}`;
  const r = await sql`
    UPDATE documents d SET retention_until = s.closed_at + make_interval(years => ${DOCUMENT_RETENTION_YEARS}), updated_at = now()
      FROM (SELECT d2.id, COALESCE(dl.closed_at,
                     (SELECT max(x.closed_at) FROM deals x WHERE x.tenant_id = d2.tenant_id AND x.listing_id = d2.listing_id
                         AND x.side IN ('sell','dual') AND x.closed_at IS NOT NULL)) AS closed_at
              FROM documents d2 LEFT JOIN deals dl ON dl.tenant_id = d2.tenant_id AND dl.id = d2.deal_id
             WHERE d2.tenant_id = app.tenant_id() AND d2.contact_id IS NULL AND d2.retention_until IS NULL AND d2.scan_status = 'clean') s
     WHERE d.tenant_id = app.tenant_id() AND d.id = s.id AND s.closed_at IS NOT NULL AND d.retention_until IS NULL ${one}`.execute(tx);
  return Number(r.numAffectedRows ?? 0);
}
