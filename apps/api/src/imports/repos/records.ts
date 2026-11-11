// Queries for import_records: the per-record outcome and review list (BUILD_PLAN module 16;
// R-IMPORT-4, R-IMPORT-5, R-IMPORT-9). Upserts key on (stage, source_ref), so re-running a dry run
// never duplicates a record (R-IMPORT-9).
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export type RecordOutcomeDb = 'will_import' | 'imported' | 'needs_review' | 'rejected' | 'duplicate' | 'merged' | 'reverted' | 'skipped';

export interface RecordRow {
  id: string;
  stage_id: string;
  source_ref: string;
  normalized: unknown;
  outcome: RecordOutcomeDb;
  dry_run_outcome: 'will_import' | 'needs_review' | 'rejected' | 'duplicate' | null;
  issues: { code: string; severity: string; field?: string }[];
  match_contact_id: string | null;
  target_table: string | null;
  target_id: string | null;
  reviewed_by_user_id: string | null;
  review_decision: 'import' | 'merge' | 'reject' | null;
  plan: Record<string, unknown> | null;
  created_rows: CreatedRow[];
  raw_purged_at: Date | null;
}

export interface CreatedRow {
  table: string;
  id: string;
  contactId?: string;
  /** contacts: fingerprint of the editable fields the import left (a later edit changes it: "touched") */
  fp?: string;
  /**
   * contacts, and history rows (notes, messages, calls, recordings): the contact's ownership ledger head when the
   * import wrote it (later non-import events: "touched"). A history row's is the baseline only for a contact this
   * batch's contacts stage did not write (B6 review R1).
   */
  seq?: number;
  /** contacts: create | attach | update */
  action?: 'create' | 'attach' | 'update';
}

const COLS = sql`id, stage_id, source_ref, normalized, outcome, dry_run_outcome, issues, match_contact_id, target_table, target_id,
  reviewed_by_user_id, review_decision, plan, created_rows, raw_purged_at`;

export async function existingRecordIds(tx: Tx, stageId: string): Promise<Map<string, { id: string; outcome: RecordOutcomeDb }>> {
  const r = await sql<{ id: string; source_ref: string; outcome: RecordOutcomeDb }>`
    SELECT id, source_ref, outcome FROM import_records WHERE tenant_id = app.tenant_id() AND stage_id = ${stageId}`.execute(tx);
  return new Map(r.rows.map((x) => [x.source_ref, { id: x.id, outcome: x.outcome }]));
}

export interface RecordUpsert {
  id: string;
  sourceRef: string;
  rawEncHex: string;
  normalized: unknown;
  outcome: 'will_import' | 'needs_review' | 'rejected' | 'duplicate';
  issues: unknown[];
  matchContactId: string | null;
  plan: unknown;
}

/** Writes one dry run's records (≤ 1,000 per statement); clears any earlier review of the same ref. */
export async function upsertRecords(tx: Tx, stageId: string, rows: readonly RecordUpsert[]): Promise<void> {
  for (let i = 0; i < rows.length; i += 1000) {
    const part = rows.slice(i, i + 1000).map((r) => ({
      id: r.id,
      source_ref: r.sourceRef,
      raw: r.rawEncHex,
      normalized: r.normalized,
      outcome: r.outcome,
      issues: r.issues,
      match_contact_id: r.matchContactId,
      plan: r.plan,
    }));
    await sql`
      INSERT INTO import_records (tenant_id, id, stage_id, source_ref, raw_enc, normalized, outcome, dry_run_outcome, issues, match_contact_id, plan)
      SELECT app.tenant_id(), x.id, ${stageId}::uuid, x.source_ref, decode(x.raw, 'hex'), x.normalized, x.outcome, x.outcome, x.issues,
             x.match_contact_id, x.plan
        FROM jsonb_to_recordset(${JSON.stringify(part)}::jsonb)
             AS x(id uuid, source_ref text, raw text, normalized jsonb, outcome text, issues jsonb, match_contact_id uuid, plan jsonb)
      ON CONFLICT (tenant_id, stage_id, source_ref) DO UPDATE SET
        raw_enc = EXCLUDED.raw_enc, raw_purged_at = NULL, normalized = EXCLUDED.normalized, outcome = EXCLUDED.outcome,
        dry_run_outcome = EXCLUDED.dry_run_outcome, issues = EXCLUDED.issues, match_contact_id = EXCLUDED.match_contact_id,
        plan = EXCLUDED.plan, review_decision = NULL, reviewed_by_user_id = NULL, target_table = NULL, target_id = NULL,
        created_rows = '[]'::jsonb`.execute(tx);
  }
}

/** Records of an earlier dry run that are no longer in the snapshot (a delta snapshot): out of the stage. */
export async function markStale(tx: Tx, stageId: string, keepRefs: ReadonlySet<string>): Promise<void> {
  const r = await sql<{ id: string; source_ref: string }>`
    SELECT id, source_ref FROM import_records WHERE tenant_id = app.tenant_id() AND stage_id = ${stageId} AND outcome <> 'skipped'`.execute(tx);
  const stale = r.rows.filter((x) => !keepRefs.has(x.source_ref)).map((x) => x.id);
  if (stale.length === 0) return;
  await sql`UPDATE import_records SET outcome = 'skipped', dry_run_outcome = NULL, plan = NULL, review_decision = NULL, reviewed_by_user_id = NULL
             WHERE tenant_id = app.tenant_id() AND id = ANY (${stale}::uuid[])`.execute(tx);
}

export async function getRecord(tx: Tx, stageIds: readonly string[], id: string, o: { forUpdate?: boolean } = {}): Promise<RecordRow | null> {
  const lock = o.forUpdate ? sql`FOR UPDATE` : sql``;
  const r = await sql<RecordRow>`SELECT ${COLS} FROM import_records
                                  WHERE tenant_id = app.tenant_id() AND id = ${id} AND stage_id = ANY (${[...stageIds]}::uuid[]) ${lock}`.execute(tx);
  return r.rows[0] ?? null;
}

export async function getRecordsByRefs(tx: Tx, stageId: string, refs: readonly string[]): Promise<RecordRow[]> {
  if (refs.length === 0) return [];
  return (await sql<RecordRow>`SELECT ${COLS} FROM import_records WHERE tenant_id = app.tenant_id() AND stage_id = ${stageId}
                                 AND source_ref = ANY (${[...refs]}::text[])`.execute(tx)).rows;
}

/** The review list: one page in id (snapshot) order, optionally filtered by current outcome. */
export async function listRecords(tx: Tx, stageId: string, o: { outcome?: string; after?: string | null; limit: number }): Promise<RecordRow[]> {
  const outcome = o.outcome ? sql`AND outcome = ${o.outcome}` : sql`AND outcome <> 'skipped'`;
  const after = o.after ? sql`AND id > ${o.after}::uuid` : sql``;
  return (await sql<RecordRow>`SELECT ${COLS} FROM import_records WHERE tenant_id = app.tenant_id() AND stage_id = ${stageId} ${outcome} ${after}
                                 ORDER BY id LIMIT ${o.limit}`.execute(tx)).rows;
}

/** Every dry-run record of a stage (the commit plan input). */
export async function allPlannedRecords(tx: Tx, stageId: string): Promise<RecordRow[]> {
  return (await sql<RecordRow>`SELECT ${COLS} FROM import_records WHERE tenant_id = app.tenant_id() AND stage_id = ${stageId}
                                 AND dry_run_outcome IS NOT NULL ORDER BY id`.execute(tx)).rows;
}

export async function setReview(tx: Tx, id: string, decision: 'import' | 'merge' | 'reject' | null, mergeInto: string | null): Promise<void> {
  await sql`UPDATE import_records SET review_decision = ${decision}, reviewed_by_user_id = CASE WHEN ${decision}::text IS NULL THEN NULL ELSE app.user_id() END,
              plan = CASE WHEN ${decision}::text = 'merge' THEN plan || jsonb_build_object('mergeIntoContactId', ${mergeInto}::text)
                          ELSE plan - 'mergeIntoContactId' END
             WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

/**
 * The next commit chunk (R-IMPORT-4): records the commit plan applies that are not applied yet, in
 * snapshot (id) order. Resumable by construction: an applied record is `imported` (or failed:
 * `rejected` with COMMIT_FAILED) in the same transaction that applied it.
 */
export async function nextCommitChunk(tx: Tx, stageId: string, limit: number): Promise<RecordRow[]> {
  return (
    await sql<RecordRow>`SELECT ${COLS} FROM import_records
      WHERE tenant_id = app.tenant_id() AND stage_id = ${stageId} AND outcome IN ('will_import','needs_review')
        AND ((dry_run_outcome = 'will_import' AND review_decision IS DISTINCT FROM 'reject')
             OR (dry_run_outcome = 'needs_review' AND review_decision IN ('import','merge')))
      ORDER BY id LIMIT ${limit}`.execute(tx)
  ).rows;
}

export async function markImported(tx: Tx, id: string, target: { table: string; id: string } | null, created: readonly CreatedRow[], outcome: 'imported' | 'duplicate' = 'imported'): Promise<void> {
  await sql`UPDATE import_records SET outcome = ${outcome}, target_table = ${target?.table ?? null}, target_id = ${target?.id ?? null},
              created_rows = ${JSON.stringify(created)}::jsonb
             WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

export async function markCommitFailed(tx: Tx, id: string, code: string): Promise<void> {
  await sql`UPDATE import_records SET outcome = 'rejected',
              issues = issues || jsonb_build_array(jsonb_build_object('code', 'COMMIT_FAILED', 'severity', 'error', 'detail', ${code}::text))
             WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

/** After the last chunk: reviewer rejections become `rejected`; reviewed no-ops become `duplicate`. */
export async function settleUnapplied(tx: Tx, stageId: string): Promise<void> {
  await sql`UPDATE import_records SET outcome = 'rejected'
             WHERE tenant_id = app.tenant_id() AND stage_id = ${stageId} AND outcome IN ('will_import','needs_review') AND review_decision = 'reject'`.execute(tx);
}

export interface OutcomeCounts {
  source: number;
  imported: number;
  needs_review: number;
  rejected: number;
  duplicate: number;
}

/**
 * The database side of the R-IMPORT-5 recount. `imported` counts only records whose target row still
 * exists (a record marked imported whose row is gone is not imported).
 */
export async function recount(tx: Tx, stageId: string): Promise<OutcomeCounts & { importedMarked: number }> {
  const r = await sql<{ source: number; marked: number; imported: number; needs_review: number; rejected: number; duplicate: number }>`
    SELECT count(*) FILTER (WHERE dry_run_outcome IS NOT NULL)::int AS source,
           count(*) FILTER (WHERE outcome = 'imported')::int AS marked,
           count(*) FILTER (WHERE outcome = 'imported' AND (
             CASE r.target_table
               WHEN 'contacts' THEN EXISTS (SELECT 1 FROM contacts c WHERE c.tenant_id = r.tenant_id AND c.id = r.target_id AND c.deleted_at IS NULL)
               WHEN 'lead_ownership_events' THEN EXISTS (SELECT 1 FROM lead_ownership_events e WHERE e.tenant_id = r.tenant_id AND e.event_id = r.target_id)
               WHEN 'notes' THEN EXISTS (SELECT 1 FROM notes n WHERE n.tenant_id = r.tenant_id AND n.id = r.target_id AND n.import_record_id = r.id)
               WHEN 'messages' THEN EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id = r.tenant_id AND m.id = r.target_id AND m.import_record_id = r.id)
               WHEN 'calls' THEN EXISTS (SELECT 1 FROM calls k WHERE k.tenant_id = r.tenant_id AND k.id = r.target_id AND k.import_record_id = r.id)
               WHEN 'consent_events' THEN EXISTS (SELECT 1 FROM consent_events ce WHERE ce.tenant_id = r.tenant_id AND ce.id = r.target_id AND ce.import_record_id = r.id)
               WHEN 'suppressions' THEN EXISTS (SELECT 1 FROM suppressions s WHERE s.tenant_id = r.tenant_id AND s.id = r.target_id AND s.import_record_id = r.id)
               ELSE false END))::int AS imported,
           count(*) FILTER (WHERE outcome = 'needs_review' AND dry_run_outcome IS NOT NULL)::int AS needs_review,
           count(*) FILTER (WHERE outcome = 'rejected' AND dry_run_outcome IS NOT NULL)::int AS rejected,
           count(*) FILTER (WHERE outcome = 'duplicate' AND dry_run_outcome IS NOT NULL)::int AS duplicate
      FROM import_records r WHERE r.tenant_id = app.tenant_id() AND r.stage_id = ${stageId}`.execute(tx);
  const x = r.rows[0]!;
  return { source: x.source, imported: x.imported, needs_review: x.needs_review, rejected: x.rejected, duplicate: x.duplicate, importedMarked: x.marked };
}

export async function importedRecords(tx: Tx, stageId: string): Promise<RecordRow[]> {
  return (await sql<RecordRow>`SELECT ${COLS} FROM import_records WHERE tenant_id = app.tenant_id() AND stage_id = ${stageId} AND outcome = 'imported' ORDER BY id`.execute(tx)).rows;
}

export async function importedRecordsAfter(tx: Tx, stageId: string, afterId: string | null, limit: number): Promise<RecordRow[]> {
  const after = afterId ? sql`AND id > ${afterId}::uuid` : sql``;
  return (await sql<RecordRow>`SELECT ${COLS} FROM import_records WHERE tenant_id = app.tenant_id() AND stage_id = ${stageId} AND outcome = 'imported' ${after}
                                 ORDER BY id LIMIT ${limit}`.execute(tx)).rows;
}

export async function importedRefs(tx: Tx, stageId: string): Promise<string[]> {
  return (await sql<{ source_ref: string }>`SELECT source_ref FROM import_records WHERE tenant_id = app.tenant_id() AND stage_id = ${stageId} AND outcome = 'imported'`.execute(tx)).rows.map((r) => r.source_ref);
}

export async function markReverted(tx: Tx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await sql`UPDATE import_records SET outcome = 'reverted' WHERE tenant_id = app.tenant_id() AND id = ANY (${[...ids]}::uuid[])`.execute(tx);
}

/** The encrypted raw source object of a record (null once purged after 30 days). */
export async function rawOf(tx: Tx, id: string): Promise<Buffer | null> {
  const r = await sql<{ raw_enc: Buffer | null }>`SELECT raw_enc FROM import_records WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  return r.rows[0]?.raw_enc ?? null;
}

/** Contacts-stage plan of this batch for person refs not committed yet (later stages dry-run early). */
export async function contactsStageRecords(tx: Tx, batchId: string): Promise<RecordRow[]> {
  return (
    await sql<RecordRow>`SELECT ${COLS} FROM import_records r
      WHERE r.tenant_id = app.tenant_id() AND r.dry_run_outcome IS NOT NULL
        AND r.stage_id = (SELECT s.id FROM import_stages s WHERE s.tenant_id = app.tenant_id() AND s.batch_id = ${batchId} AND s.category = 'contacts')`.execute(tx)
  ).rows;
}

/** The contacts-stage records of a batch that wrote any of these contacts (revert baselines). */
export async function contactsStageRecordsFor(tx: Tx, batchId: string, contactIds: readonly string[]): Promise<RecordRow[]> {
  if (contactIds.length === 0) return [];
  return (
    await sql<RecordRow>`SELECT ${COLS} FROM import_records r
      WHERE r.tenant_id = app.tenant_id() AND r.target_id = ANY (${[...contactIds]}::uuid[]) AND r.target_table = 'contacts'
        AND r.stage_id = (SELECT s.id FROM import_stages s WHERE s.tenant_id = app.tenant_id() AND s.batch_id = ${batchId} AND s.category = 'contacts')`.execute(tx)
  ).rows;
}

/**
 * Consent-stage records of the current dry run that would apply a revocation or a do-not-contact flag
 * (R-CONSENT-3): the stage cannot be skipped while any is pending.
 */
export async function pendingOptOuts(tx: Tx, stageId: string): Promise<number> {
  const r = await sql<{ n: number }>`
    SELECT count(*)::int AS n FROM import_records
     WHERE tenant_id = app.tenant_id() AND stage_id = ${stageId} AND dry_run_outcome IN ('will_import','needs_review')
       AND review_decision IS DISTINCT FROM 'reject' AND plan->>'kind' = 'record_consent'
       AND (COALESCE((plan->>'revokes')::int, 0) > 0 OR COALESCE((plan->>'doNotContact')::int, 0) > 0)`.execute(tx);
  return r.rows[0]?.n ?? 0;
}
