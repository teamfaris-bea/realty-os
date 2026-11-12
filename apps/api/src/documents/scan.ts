// The scan pipeline and the reconcile (deliverable 4; R-DOC-3, R-DOC-7, R-DOC-9, E130, E402-E405, E415).
//
// documents.scan (standalone, as the system of the job's tenant):
//   1. no scanner configured: return; the document stays pending and nobody opens it (E402);
//   2. TX1 (short): the pending row with its live object, and the bytes;
//   3. the scan, outside any transaction; a ProviderError throws, the job retries, an error is never clean (E403);
//   4. TX2: UPDATE ... WHERE scan_status = 'pending' (only once, 0018 documents_guard):
//        clean   → stamp retention if the scope closed; supersede the open extraction of the version it replaces
//                  (E415); enqueue documents.extract for a clean PDF deal contract when an extractor is configured;
//        blocked → infected (final); the object is shredded unless the document is held (E405), and blob_delete
//                  removes the blob later;
//      and the audit row: verdict, reason and engine (never the name).
// documents.reconcile (per tenant, every 5 min at a 150 s offset, as the system):
//   1. re-enqueue scans pending for more than 2 minutes (only with a scanner configured);
//   2. stamp retention; 3. shred infected documents' objects once their hold is lifted;
//   4. backstop: supersede open extractions that have a clean newer version.
import type { Actor, Instant, TenantId } from '@realty/core/foundation';
import { type Tx, enqueueJob } from '@realty/db';
import { sql } from 'kysely';
import { audit, redactDiff } from '../audit.js';
import { getObject } from '../crypto/objects.js';
import type { ScanVerdict } from './provider.js';
import { stampRetentionInTx } from './manage.js';
import { extractable } from './read.js';
import { enqueueScan } from './upload.js';
import { DOCUMENT_JOBS, type DocumentDeps, SCAN_STALE_MS } from './types.js';

export type RunTx = <T>(fn: (tx: Tx, now: Instant) => Promise<T>) => Promise<T>;

export type ScanOutcome = { result: 'not_configured' } | { result: 'not_pending' } | { result: 'gone' } | { result: 'scanned'; verdict: ScanVerdict };

interface PendingRow {
  id: string;
  object_id: string;
  storage_key: string;
  dek_wrapped: Buffer;
  content_type: string;
  byte_size: string;
}

export async function scanDocument(deps: DocumentDeps, system: Actor, runTx: RunTx, documentId: string): Promise<ScanOutcome> {
  const scanner = deps.providers.scanner;
  if (!scanner.configured) return { result: 'not_configured' };
  const tenantId = system.tenantId as TenantId;
  const read = await runTx(async (tx) => {
    const r = await sql<PendingRow>`
      SELECT d.id, o.id AS object_id, o.storage_key, o.dek_wrapped, o.content_type, o.byte_size::text AS byte_size
        FROM documents d JOIN stored_objects o ON o.tenant_id = d.tenant_id AND o.id = d.object_id
       WHERE d.tenant_id = app.tenant_id() AND d.id = ${documentId} AND d.scan_status = 'pending'
         AND o.purpose = 'document' AND o.deleted_at IS NULL AND o.dek_wrapped IS NOT NULL`.execute(tx);
    const row = r.rows[0];
    if (!row) return null;
    const bytes = await getObject(deps.envelope.inTx(tx, tenantId), deps.providers.storage, tenantId, row.object_id, row.storage_key, new Uint8Array(row.dek_wrapped));
    return { row, bytes };
  });
  if (!read) return { result: 'not_pending' };
  if (!read.bytes) return { result: 'gone' }; // the blob is missing: stays pending (the reconcile retries), never clean
  // outside any transaction: a ProviderError propagates and the worker retries the job
  const verdict = await scanner.scan(read.bytes, { contentType: read.row.content_type, byteSize: Number(read.row.byte_size) });
  read.bytes.fill(0);
  const applied = await runTx((tx) => applyVerdictInTx(tx, deps, system, documentId, verdict, scanner.engine));
  return applied ? { result: 'scanned', verdict } : { result: 'not_pending' };
}

/** TX2 of the scan. Returns false when another run already moved the document out of pending. */
export async function applyVerdictInTx(tx: Tx, deps: Pick<DocumentDeps, 'providers'>, system: Actor, documentId: string, verdict: ScanVerdict, engine: string): Promise<boolean> {
  const status = verdict.verdict === 'clean' ? 'clean' : 'infected';
  const r = await sql<{ object_id: string; legal_hold: boolean; supersedes_id: string | null; deal_id: string | null; kind: string }>`
    UPDATE documents SET scan_status = ${status}, updated_at = now()
     WHERE tenant_id = app.tenant_id() AND id = ${documentId} AND scan_status = 'pending'
     RETURNING object_id, legal_hold, supersedes_id, deal_id, kind`.execute(tx);
  const d = r.rows[0];
  if (!d) return false;
  if (verdict.verdict === 'clean') {
    await stampRetentionInTx(tx, documentId);
    if (d.supersedes_id) await supersedePriorExtractionsInTx(tx, documentId);
    const ct = await sql<{ content_type: string }>`SELECT content_type FROM stored_objects WHERE tenant_id = app.tenant_id() AND id = ${d.object_id}`.execute(tx);
    if (deps.providers.textExtractor.configured && extractable({ deal_id: d.deal_id, kind: d.kind as never, content_type: ct.rows[0]?.content_type ?? null })) {
      await enqueueJob(tx, { queue: 'default', kind: DOCUMENT_JOBS.extract, payload: { documentId }, dedupeKey: `${DOCUMENT_JOBS.extract}:${documentId}` });
    }
  } else if (!d.legal_hold) {
    await shredObjectInTx(tx, d.object_id);
  }
  await audit(tx, system, {
    action: 'document.scanned',
    entity: { type: 'document', id: documentId },
    changes: redactDiff(null, { scan_status: status, blocked_reason_code: verdict.verdict === 'blocked' ? verdict.reason : null, engine_code: engine }),
  });
  return true;
}

async function shredObjectInTx(tx: Tx, objectId: string): Promise<void> {
  await sql`UPDATE stored_objects SET dek_wrapped = NULL, deleted_at = now()
             WHERE tenant_id = app.tenant_id() AND id = ${objectId} AND purpose = 'document' AND deleted_at IS NULL AND NOT legal_hold`.execute(tx);
}

/**
 * Marks 'superseded' every open contract_extraction of an older version of `documentId`'s chain once that newer
 * version is clean (E415): its dates are read from the newer contract. Decided claims keep their dates.
 */
export async function supersedePriorExtractionsInTx(tx: Tx, documentId: string): Promise<number> {
  const r = await sql`
    WITH RECURSIVE up(id) AS (
      SELECT d.supersedes_id FROM documents d WHERE d.tenant_id = app.tenant_id() AND d.id = ${documentId} AND d.supersedes_id IS NOT NULL
      UNION SELECT d.supersedes_id FROM up JOIN documents d ON d.tenant_id = app.tenant_id() AND d.id = up.id WHERE d.supersedes_id IS NOT NULL)
    UPDATE assistant_actions a SET status = 'superseded', updated_at = now()
     WHERE a.tenant_id = app.tenant_id() AND a.kind = 'contract_extraction' AND a.status IN ('proposed','approved')
       AND a.dedupe_key IN (SELECT 'contract_extraction:' || up.id::text FROM up)`.execute(tx);
  return Number(r.numAffectedRows ?? 0);
}

export interface ReconcileReport {
  requeued: number;
  stamped: number;
  shredded: number;
  superseded: number;
}

/** documents.reconcile, in one system transaction of one tenant. */
export async function reconcileInTx(tx: Tx, deps: Pick<DocumentDeps, 'providers'>, now: Instant): Promise<ReconcileReport> {
  let requeued = 0;
  if (deps.providers.scanner.configured) {
    const stale = await sql<{ id: string }>`
      SELECT id FROM documents WHERE tenant_id = app.tenant_id() AND scan_status = 'pending'
         AND created_at < ${new Date(now - SCAN_STALE_MS).toISOString()}::timestamptz
       ORDER BY created_at LIMIT 500`.execute(tx);
    for (const s of stale.rows) {
      await enqueueScan(tx, s.id);
      requeued += 1;
    }
  }
  const stamped = await stampRetentionInTx(tx);
  const shred = await sql`
    UPDATE stored_objects o SET dek_wrapped = NULL, deleted_at = now()
      FROM documents d
     WHERE d.tenant_id = app.tenant_id() AND o.tenant_id = d.tenant_id AND o.id = d.object_id
       AND d.scan_status = 'infected' AND NOT d.legal_hold
       AND o.purpose = 'document' AND o.deleted_at IS NULL AND NOT o.legal_hold`.execute(tx);
  const sup = await sql`
    UPDATE assistant_actions a SET status = 'superseded', updated_at = now()
      FROM documents d
     WHERE a.tenant_id = app.tenant_id() AND d.tenant_id = a.tenant_id AND a.kind = 'contract_extraction' AND a.status IN ('proposed','approved')
       AND a.dedupe_key = 'contract_extraction:' || d.id::text
       AND EXISTS (
         WITH RECURSIVE down(id) AS (
           SELECT n.id FROM documents n WHERE n.tenant_id = d.tenant_id AND n.supersedes_id = d.id
           UNION SELECT n.id FROM down JOIN documents n ON n.tenant_id = d.tenant_id AND n.supersedes_id = down.id)
         SELECT 1 FROM down JOIN documents c ON c.tenant_id = d.tenant_id AND c.id = down.id WHERE c.scan_status = 'clean')`.execute(tx);
  return { requeued, stamped, shredded: Number(shred.numAffectedRows ?? 0), superseded: Number(sup.numAffectedRows ?? 0) };
}

