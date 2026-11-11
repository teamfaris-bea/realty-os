// Queries for import batches, stages, user mappings, the FUB credential and snapshot objects
// (BUILD_PLAN module 16). Every query runs inside the caller's withTenantTx: RLS (Owner/Admin/system,
// 0001 Layer 2 (b)) decides what is visible; tenant_id always comes from app.tenant_id().
import type { NotImportedStep, ParityOptions, ParitySummary } from '@realty/core/import';
import { type Category, CATEGORIES, categorySeq } from '@realty/core/import';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export type BatchSource = 'csv' | 'fub_api' | 'fub_export';
export type BatchStatus = 'connection_test' | 'snapshotting' | 'dry_run' | 'committing' | 'committed' | 'partially_committed' | 'reverting' | 'reverted' | 'abandoned';
export type StageStatus =
  | 'pending'
  | 'dry_run_running'
  | 'dry_run_ready'
  | 'approved'
  | 'committing'
  | 'committed'
  | 'verified'
  | 'skipped'
  | 'reverting'
  | 'reverted'
  | 'failed';

export interface BatchRow {
  id: string;
  source: BatchSource;
  status: BatchStatus;
  source_counts: Record<string, number | null>;
  source_snapshot_sha256: string | null;
  source_snapshot_at: Date | null;
  credential_id: string | null;
  file_object_id: string | null;
  created_by_user_id: string;
  created_at: Date;
  updated_at: Date;
  reverted_at: Date | null;
  options: BatchOptions;
}

/** import_batches.options: no contact PII (header names, mapping targets, FUB agent labels). */
export interface BatchOptions {
  fileLabel?: string;
  headers?: string[];
  mapping?: unknown[];
  /** FUB users and ponds the snapshot references, with how many people each holds (for the mapping screen) */
  sourceUsers?: { ref: string; label: string; people: number }[];
  sourcePonds?: { ref: string; label: string; people: number }[];
  /** snapshot recordings: FUB call id → stored object id (copied at snapshot time, R-IMPORT-1) */
  recordings?: Record<string, string>;
  /** the snapshot job's last failure code (no PII) */
  snapshotError?: string | null;
  /** PARITY 65 (R-PAR-46): the Admin's stage map, keep-stage-as-tag switch and custom field mapping */
  parity?: ParityOptions;
  /** PARITY 65: the contacts dry run's parity summary (stage labels, tag and field plan; no contact PII) */
  paritySummary?: ParitySummary;
  /** PARITY 65: catalog rows this batch created (revert removes the unused ones) */
  parityCreated?: { tagIds?: string[]; fieldIds?: string[] };
  /** PARITY 65: what the contacts commit wrote (tag links, values, stages set, kept) */
  parityCommitted?: Record<string, number>;
  /**
   * Owner decision B7 (E233): how many tasks and appointments Follow Up Boss holds (never imported), from the
   * connection test, the latest snapshot, or the export file; null where a count could not be read.
   */
  notImported?: NotImportedOption;
}

export interface NotImportedOption {
  tasks: number | null;
  appointments: number | null;
  /** the step that counted last (the connection test, the latest snapshot, or the export file) */
  countedAt: 'connection_test' | 'snapshot' | 'export_file';
  /**
   * Review F4: a count that step could not read again, kept from an earlier step: the step that counted it. Absent
   * when every number is that step's own.
   */
  keptFrom?: Partial<Record<'tasks' | 'appointments', NotImportedStep>>;
}

export interface StageRow {
  id: string;
  batch_id: string;
  category: Category;
  seq: number;
  status: StageStatus;
  count_source: number | null;
  count_will_import: number | null;
  count_imported: number | null;
  count_needs_review: number | null;
  count_rejected: number | null;
  count_duplicate: number | null;
  dry_run_completed_at: Date | null;
  approved_by_user_id: string | null;
  approved_at: Date | null;
  committed_at: Date | null;
  verified_by_user_id: string | null;
  verified_at: Date | null;
  verification: Record<string, unknown> | null;
  updated_at: Date;
  dry_run_sha256: string | null;
  expected_counts: Record<string, number> | null;
  blockers: { code: string; severity: string }[];
  consent_summary: Record<string, number> | null;
  revert_report: Record<string, unknown> | null;
}

const BATCH_COLS = sql`id, source, status, source_counts, source_snapshot_sha256, source_snapshot_at, credential_id, file_object_id,
  created_by_user_id, created_at, updated_at, reverted_at, options`;
const STAGE_COLS = sql`id, batch_id, category, seq, status, count_source, count_will_import, count_imported, count_needs_review,
  count_rejected, count_duplicate, dry_run_completed_at, approved_by_user_id, approved_at, committed_at, verified_by_user_id,
  verified_at, verification, updated_at, dry_run_sha256, expected_counts, blockers, consent_summary, revert_report`;

export async function insertBatch(
  tx: Tx,
  b: { id: string; source: BatchSource; sourceCounts: Record<string, number | null>; credentialId: string | null; fileObjectId: string | null; options: BatchOptions },
): Promise<void> {
  await sql`
    INSERT INTO import_batches (tenant_id, id, source, status, source_counts, credential_id, file_object_id, created_by_user_id, options)
    VALUES (app.tenant_id(), ${b.id}, ${b.source}, 'connection_test', ${JSON.stringify(b.sourceCounts)}::jsonb, ${b.credentialId},
            ${b.fileObjectId}, app.user_id(), ${JSON.stringify(b.options)}::jsonb)`.execute(tx);
}

export async function insertStages(tx: Tx, batchId: string, categories: readonly Category[], ids: () => string): Promise<void> {
  for (const c of categories) {
    await sql`INSERT INTO import_stages (tenant_id, id, batch_id, category, seq, status)
              VALUES (app.tenant_id(), ${ids()}, ${batchId}, ${c}, ${categorySeq(c)}, 'pending')`.execute(tx);
  }
}

export async function getBatch(tx: Tx, id: string, o: { forUpdate?: boolean } = {}): Promise<BatchRow | null> {
  const lock = o.forUpdate ? sql`FOR UPDATE` : sql``;
  const r = await sql<BatchRow>`SELECT ${BATCH_COLS} FROM import_batches WHERE tenant_id = app.tenant_id() AND id = ${id} ${lock}`.execute(tx);
  return r.rows[0] ?? null;
}

export async function listBatches(tx: Tx, limit = 50): Promise<BatchRow[]> {
  return (await sql<BatchRow>`SELECT ${BATCH_COLS} FROM import_batches WHERE tenant_id = app.tenant_id() ORDER BY created_at DESC, id DESC LIMIT ${limit}`.execute(tx)).rows;
}

export async function setBatchStatus(tx: Tx, id: string, status: BatchStatus, extra: { revertedAt?: boolean; clearReverted?: boolean } = {}): Promise<void> {
  await sql`UPDATE import_batches SET status = ${status},
              reverted_at = CASE WHEN ${extra.revertedAt === true} THEN now() WHEN ${extra.clearReverted === true} THEN NULL ELSE reverted_at END
             WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

export async function setSnapshot(tx: Tx, id: string, s: { sha256: string; fileObjectId: string; options: BatchOptions }): Promise<void> {
  await sql`UPDATE import_batches SET status = 'dry_run', source_snapshot_sha256 = ${s.sha256}, source_snapshot_at = now(),
              file_object_id = ${s.fileObjectId}, options = ${JSON.stringify(s.options)}::jsonb
             WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

export async function setBatchOptions(tx: Tx, id: string, options: BatchOptions): Promise<void> {
  await sql`UPDATE import_batches SET options = ${JSON.stringify(options)}::jsonb WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
}

export async function getStages(tx: Tx, batchId: string): Promise<StageRow[]> {
  return (await sql<StageRow>`SELECT ${STAGE_COLS} FROM import_stages WHERE tenant_id = app.tenant_id() AND batch_id = ${batchId} ORDER BY seq`.execute(tx)).rows;
}

export async function getStage(tx: Tx, batchId: string, category: Category, o: { forUpdate?: boolean } = {}): Promise<StageRow | null> {
  const lock = o.forUpdate ? sql`FOR UPDATE` : sql``;
  const r = await sql<StageRow>`SELECT ${STAGE_COLS} FROM import_stages
                                 WHERE tenant_id = app.tenant_id() AND batch_id = ${batchId} AND category = ${category} ${lock}`.execute(tx);
  return r.rows[0] ?? null;
}

export async function getStageById(tx: Tx, stageId: string, o: { forUpdate?: boolean } = {}): Promise<StageRow | null> {
  const lock = o.forUpdate ? sql`FOR UPDATE` : sql``;
  const r = await sql<StageRow>`SELECT ${STAGE_COLS} FROM import_stages WHERE tenant_id = app.tenant_id() AND id = ${stageId} ${lock}`.execute(tx);
  return r.rows[0] ?? null;
}

/** Locks every stage row of a batch in seq order (one lock order for all stage writers). */
export async function lockStages(tx: Tx, batchId: string): Promise<StageRow[]> {
  return (await sql<StageRow>`SELECT ${STAGE_COLS} FROM import_stages WHERE tenant_id = app.tenant_id() AND batch_id = ${batchId} ORDER BY seq FOR UPDATE`.execute(tx)).rows;
}

/** Conditional status transition: true when the stage was in one of `from` and moved to `to`. */
export async function transitionStage(tx: Tx, stageId: string, from: readonly StageStatus[], to: StageStatus): Promise<boolean> {
  const r = await sql`UPDATE import_stages SET status = ${to} WHERE tenant_id = app.tenant_id() AND id = ${stageId} AND status = ANY (${[...from]}::text[])`.execute(tx);
  return Number(r.numAffectedRows ?? 0) === 1;
}

export async function resetStageDryRun(tx: Tx, stageId: string, status: 'pending' | 'dry_run_running' | 'dry_run_ready'): Promise<void> {
  await sql`UPDATE import_stages SET status = ${status}, approved_at = NULL, approved_by_user_id = NULL, expected_counts = NULL,
              dry_run_completed_at = CASE WHEN ${status} = 'dry_run_ready' THEN dry_run_completed_at ELSE NULL END,
              dry_run_sha256 = CASE WHEN ${status} = 'dry_run_ready' THEN dry_run_sha256 ELSE NULL END
             WHERE tenant_id = app.tenant_id() AND id = ${stageId}`.execute(tx);
}

export interface DryRunCounts {
  source: number;
  will_import: number;
  needs_review: number;
  rejected: number;
  duplicate: number;
}

export async function setDryRunResult(
  tx: Tx,
  stageId: string,
  r: { counts: DryRunCounts; sha256: string; blockers: unknown[]; consentSummary: Record<string, number> | null },
): Promise<void> {
  await sql`UPDATE import_stages SET status = 'dry_run_ready', dry_run_completed_at = now(), dry_run_sha256 = ${r.sha256},
              count_source = ${r.counts.source}, count_will_import = ${r.counts.will_import}, count_needs_review = ${r.counts.needs_review},
              count_rejected = ${r.counts.rejected}, count_duplicate = ${r.counts.duplicate}, count_imported = NULL,
              blockers = ${JSON.stringify(r.blockers)}::jsonb, consent_summary = ${r.consentSummary === null ? null : JSON.stringify(r.consentSummary)}::jsonb,
              approved_at = NULL, approved_by_user_id = NULL, expected_counts = NULL
             WHERE tenant_id = app.tenant_id() AND id = ${stageId}`.execute(tx);
}

export async function approveStage(tx: Tx, stageId: string, expected: Record<string, number>): Promise<boolean> {
  const r = await sql`UPDATE import_stages SET status = 'approved', approved_at = now(), approved_by_user_id = app.user_id(),
                        expected_counts = ${JSON.stringify(expected)}::jsonb
                       WHERE tenant_id = app.tenant_id() AND id = ${stageId} AND status = 'dry_run_ready'`.execute(tx);
  return Number(r.numAffectedRows ?? 0) === 1;
}

export async function clearApproval(tx: Tx, stageId: string): Promise<void> {
  await sql`UPDATE import_stages SET status = 'dry_run_ready', approved_at = NULL, approved_by_user_id = NULL, expected_counts = NULL
             WHERE tenant_id = app.tenant_id() AND id = ${stageId} AND status = 'approved'`.execute(tx);
}

export async function finishCommit(tx: Tx, stageId: string, c: { imported: number; needs_review: number; rejected: number; duplicate: number; source: number }): Promise<void> {
  await sql`UPDATE import_stages SET status = 'committed', committed_at = now(), count_imported = ${c.imported},
              count_needs_review = ${c.needs_review}, count_rejected = ${c.rejected}, count_duplicate = ${c.duplicate}, count_source = ${c.source}
             WHERE tenant_id = app.tenant_id() AND id = ${stageId} AND status = 'committing'`.execute(tx);
}

export async function verifyStage(tx: Tx, stageId: string, verification: unknown): Promise<boolean> {
  const r = await sql`UPDATE import_stages SET status = 'verified', verified_at = now(), verified_by_user_id = app.user_id(),
                        verification = ${JSON.stringify(verification)}::jsonb
                       WHERE tenant_id = app.tenant_id() AND id = ${stageId} AND status = 'committed'`.execute(tx);
  return Number(r.numAffectedRows ?? 0) === 1;
}

export async function setRevertReport(tx: Tx, stageId: string, report: unknown): Promise<void> {
  await sql`UPDATE import_stages SET status = 'reverted', revert_report = ${JSON.stringify(report)}::jsonb
             WHERE tenant_id = app.tenant_id() AND id = ${stageId} AND status = 'reverting'`.execute(tx);
}

export async function setRevertReportProgress(tx: Tx, stageId: string, report: unknown): Promise<void> {
  await sql`UPDATE import_stages SET revert_report = ${JSON.stringify(report)}::jsonb
             WHERE tenant_id = app.tenant_id() AND id = ${stageId} AND status = 'reverting'`.execute(tx);
}

// ---- user mappings (R-IMPORT-8) -------------------------------------------------------------------

export interface MappingRow {
  source_user_ref: string;
  source_user_label: string;
  target_kind: 'user' | 'pond' | 'unassigned';
  target_user_id: string | null;
  target_pond_id: string | null;
}

export async function listMappings(tx: Tx, batchId: string): Promise<MappingRow[]> {
  return (
    await sql<MappingRow>`SELECT source_user_ref, source_user_label, target_kind, target_user_id, target_pond_id
                            FROM import_user_mappings WHERE tenant_id = app.tenant_id() AND batch_id = ${batchId} ORDER BY source_user_ref`.execute(tx)
  ).rows;
}

export async function upsertMapping(tx: Tx, batchId: string, m: MappingRow): Promise<void> {
  await sql`
    INSERT INTO import_user_mappings (tenant_id, batch_id, source_user_ref, source_user_label, target_kind, target_user_id, target_pond_id)
    VALUES (app.tenant_id(), ${batchId}, ${m.source_user_ref}, ${m.source_user_label}, ${m.target_kind}, ${m.target_user_id}, ${m.target_pond_id})
    ON CONFLICT (tenant_id, batch_id, source_user_ref) DO UPDATE
      SET source_user_label = EXCLUDED.source_user_label, target_kind = EXCLUDED.target_kind,
          target_user_id = EXCLUDED.target_user_id, target_pond_id = EXCLUDED.target_pond_id`.execute(tx);
}

/** Active members who may receive a lead (not TC, R-PERM-15) and the tenant's ponds, for mapping validation. */
export async function mappingTargets(tx: Tx): Promise<{ users: Map<string, { role: string; eligible: boolean }>; ponds: Set<string> }> {
  const m = await sql<{ user_id: string; role: string; status: string }>`SELECT user_id, role, status FROM memberships WHERE tenant_id = app.tenant_id()`.execute(tx);
  const p = await sql<{ id: string }>`SELECT id FROM ponds WHERE tenant_id = app.tenant_id()`.execute(tx);
  return {
    users: new Map(m.rows.map((r) => [r.user_id, { role: r.role, eligible: r.status === 'active' && r.role !== 'tc' }])),
    ponds: new Set(p.rows.map((r) => r.id)),
  };
}

/**
 * These members' display names and their membership as it is now (E230): the reason a planned assignment came in
 * unassigned names its member, and is said in the present only while their status and role still show it (review
 * B4-R2). A member without a membership here is left out (said as it was when the owners were imported).
 */
export async function memberNames(tx: Tx, userIds: readonly string[]): Promise<Map<string, { name: string; status: string; role: string }>> {
  if (userIds.length === 0) return new Map();
  const r = await sql<{ user_id: string; display_name: string; status: string; role: string }>`
    SELECT m.user_id, u.display_name, m.status, m.role FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.tenant_id = app.tenant_id() AND m.user_id = ANY (${[...new Set(userIds)]}::uuid[])`.execute(tx);
  return new Map(r.rows.map((x) => [x.user_id, { name: x.display_name, status: x.status, role: x.role }]));
}

// ---- FUB credential (R-IMPORT-11, R-DATA-1) ---------------------------------------------------------

export async function insertCredential(tx: Tx, id: string, secretEnc: Uint8Array, keyVersion: number): Promise<void> {
  await sql`INSERT INTO provider_credentials (tenant_id, id, provider, secret_enc, key_version, created_by_user_id)
            VALUES (app.tenant_id(), ${id}, 'fub', ${Buffer.from(secretEnc)}, ${keyVersion}, app.user_id())`.execute(tx);
}

export async function loadCredential(tx: Tx, id: string): Promise<{ secret_enc: Buffer | null; status: string; purge_after: Date | null } | null> {
  const r = await sql<{ secret_enc: Buffer | null; status: string; purge_after: Date | null }>`
    SELECT secret_enc, status, purge_after FROM provider_credentials WHERE tenant_id = app.tenant_id() AND id = ${id} AND provider = 'fub'`.execute(tx);
  return r.rows[0] ?? null;
}

/** Schedules the purge (the retention sweep nulls the secret at purge_after); never moves it later. */
export async function schedulePurge(tx: Tx, id: string, days: number): Promise<void> {
  await sql`UPDATE provider_credentials SET purge_after = LEAST(COALESCE(purge_after, 'infinity'::timestamptz), now() + make_interval(days => ${days}))
             WHERE tenant_id = app.tenant_id() AND id = ${id} AND status <> 'purged'`.execute(tx);
}

export async function purgeCredentialNow(tx: Tx, id: string): Promise<void> {
  await sql`UPDATE provider_credentials SET secret_enc = NULL, status = 'purged', purged_at = now(), purge_after = COALESCE(purge_after, now())
             WHERE tenant_id = app.tenant_id() AND id = ${id} AND status <> 'purged'`.execute(tx);
}

// ---- stored objects (snapshot file, recordings) -------------------------------------------------------

export async function insertStoredObject(
  tx: Tx,
  o: { id: string; purpose: 'import_file' | 'recording'; storageKey: string; contentType: string; byteSize: number; sha256: Uint8Array; dekWrapped: Uint8Array; keyVersion: number; retentionUntil?: Date | null },
): Promise<void> {
  await sql`INSERT INTO stored_objects (tenant_id, id, purpose, storage_key, content_type, byte_size, sha256, dek_wrapped, key_version, retention_until, created_by_user_id)
            VALUES (app.tenant_id(), ${o.id}, ${o.purpose}, ${o.storageKey}, ${o.contentType}, ${o.byteSize}, ${Buffer.from(o.sha256)},
                    ${Buffer.from(o.dekWrapped)}, ${o.keyVersion}, ${o.retentionUntil ?? null},
                    CASE WHEN app.actor_kind() = 'user' THEN app.user_id() ELSE NULL END)`.execute(tx);
}

export async function loadStoredObject(tx: Tx, id: string): Promise<{ storage_key: string; dek_wrapped: Buffer | null; sha256: Buffer; content_type: string } | null> {
  const r = await sql<{ storage_key: string; dek_wrapped: Buffer | null; sha256: Buffer; content_type: string }>`
    SELECT storage_key, dek_wrapped, sha256, content_type FROM stored_objects WHERE tenant_id = app.tenant_id() AND id = ${id} AND deleted_at IS NULL`.execute(tx);
  return r.rows[0] ?? null;
}

export async function markObjectsDeleted(tx: Tx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await sql`UPDATE stored_objects SET deleted_at = now() WHERE tenant_id = app.tenant_id() AND id = ANY (${[...ids]}::uuid[]) AND deleted_at IS NULL`.execute(tx);
}

/** The ids among `ids` that no recordings row references (safe to drop). */
export async function unreferencedObjects(tx: Tx, ids: readonly string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const r = await sql<{ id: string }>`
    SELECT x::text AS id FROM unnest(${[...ids]}::uuid[]) x
     WHERE NOT EXISTS (SELECT 1 FROM recordings r WHERE r.tenant_id = app.tenant_id() AND r.object_id = x)`.execute(tx);
  return r.rows.map((x) => x.id);
}

/** Tenant settings the import reads. */
export async function importSettings(tx: Tx): Promise<{ recordingRetentionDays: number; transcribeImported: boolean }> {
  const r = await sql<{ recording_retention_days: number; transcribe_imported_recordings: boolean }>`
    SELECT recording_retention_days, transcribe_imported_recordings FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx);
  const s = r.rows[0];
  return { recordingRetentionDays: s?.recording_retention_days ?? 730, transcribeImported: s?.transcribe_imported_recordings ?? false };
}

export { CATEGORIES };
