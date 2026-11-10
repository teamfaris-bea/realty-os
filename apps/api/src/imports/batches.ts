// Import batches: the connection/export test, the snapshot, user mappings, abandon (BUILD_PLAN
// module 16; ARCHITECTURE §13; R-IMPORT-1, R-IMPORT-4, R-IMPORT-8, R-IMPORT-11, R-DATA-1).
//
//   createImport   FUB API: decrypts nothing, reads COUNTS ONLY (one-record pages) and stores the key
//                  encrypted (provider_credentials, AAD bound to the row). CSV / FUB export file: the
//                  bytes are stored encrypted (per-object DEK) and only counted. Nothing is promised
//                  before this step and nothing is imported by it (R-IMPORT-1).
//   takeSnapshot   (job) FUB API: reads every collection once, copies recordings into encrypted storage,
//                  and stores the whole snapshot encrypted with its sha256. Every later step reads the
//                  snapshot, never live FUB (R-IMPORT-1, R-IMPORT-4). Files: the uploaded bytes are the
//                  snapshot. A new snapshot (a delta, E42) resets every stage that has not committed.
//   abandon        purges the FUB key at once (R-IMPORT-11) and drops the snapshot objects.
import { createHash } from 'node:crypto';
import type { TenantId, UserActor } from '@realty/core/foundation';
import {
  type Category,
  CATEGORIES,
  type ColumnMapping,
  type FubCollection,
  FubPersonSchema,
  type ImportTarget,
  type NormalizedRecord,
  type RecordOutcome,
  type UserMapping,
  fubConnectionCounts,
  mapFub,
} from '@realty/core/import';
import type { PondId, UserId } from '@realty/core/foundation';
import { type Tx, enqueueJob, withTenantTx } from '@realty/db';
import { getObject, putObject } from '../crypto/objects.js';
import { AppError } from '../errors.js';
import { systemActor } from '../worker/systemActor.js';
import { CSV_CATEGORIES, type StageSource, fileLabelOf, inspectCsv } from './csv.js';
import { FUB_COLLECTIONS, FubAccessError, readCollection } from './fub.js';
import * as repo from './repos/batches.js';
import type { ImportDeps } from './types.js';

export const SNAPSHOT_JOB = { kind: 'imports.snapshot' as const, queue: 'bulk' as const };

const sha256Hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const credAad = (id: string) => ({ table: 'provider_credentials', column: 'secret_enc', rowId: id });

export type CreateImportInput =
  | { source: 'fub_api'; apiKey: string }
  | { source: 'csv'; fileName: string; fileBase64: string; mapping?: ColumnMapping }
  | { source: 'fub_export'; fileName: string; fileBase64: string };

export interface FubSnapshot {
  version: 1;
  collections: Partial<Record<FubCollection, unknown[]>>;
}

function decodeFile(b64: string): Uint8Array {
  const bytes = Buffer.from(b64, 'base64');
  if (bytes.length === 0) throw new AppError('IMPORT_FILE_INVALID', { reason: 'EMPTY' });
  return new Uint8Array(bytes);
}

/** A FUB export file: `{ people: [...], notes: [...], ... }` or `{ collections: {...} }`. */
export function parseFubExport(bytes: Uint8Array): FubSnapshot | null {
  let v: unknown;
  try {
    v = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return null;
  }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const root = ((v as { collections?: unknown }).collections ?? v) as Record<string, unknown>;
  const collections: FubSnapshot['collections'] = {};
  let any = false;
  for (const c of FUB_COLLECTIONS) {
    const x = root[c];
    if (x === undefined) continue;
    if (!Array.isArray(x)) return null;
    collections[c] = x;
    any = true;
  }
  return any ? { version: 1, collections } : null;
}

function exportCounts(s: FubSnapshot): Record<Category, number | null> {
  const n = (c: FubCollection) => s.collections[c]?.length ?? 0;
  return { contacts: n('people'), ownership: n('people'), notes: n('notes'), messages: n('textMessages') + n('emails'), call_recordings: n('calls'), consent: n('people') };
}

async function storeFile(deps: ImportDeps, tx: Tx, tenantId: TenantId, bytes: Uint8Array, contentType: string): Promise<string> {
  const id = deps.ids.next<'StoredObjectId'>();
  const env = deps.envelope.inTx(tx, tenantId);
  const sealed = await putObject(env, deps.storage, tenantId, id, 'import_file', bytes, contentType);
  await repo.insertStoredObject(tx, { id, purpose: 'import_file', storageKey: sealed.storageKey, contentType, byteSize: sealed.byteSize, sha256: sealed.sha256, dekWrapped: sealed.dekWrapped, keyVersion: sealed.keyVersion });
  return id;
}

/** POST /imports: the connection/export test (counts only). */
export async function createImport(deps: ImportDeps, actor: UserActor, input: CreateImportInput): Promise<{ batchId: string; counts: Record<string, number | null> }> {
  const batchId = deps.ids.next<'ImportBatchId'>();
  if (input.source === 'fub_api') {
    const client = deps.fub(input.apiKey);
    const pages: Partial<Record<FubCollection, unknown>> = {};
    for (const c of FUB_COLLECTIONS) {
      try {
        pages[c] = await client.countPage(c);
      } catch (e) {
        if (e instanceof FubAccessError && e.code === 'FUB_UNAUTHORIZED') throw new AppError('FUB_KEY_INVALID');
        if (e instanceof FubAccessError && e.code === 'FUB_UNAVAILABLE' && e.status === 404) continue; // not countable: reported as null
        throw new AppError('PROVIDER_UNAVAILABLE');
      }
    }
    if (pages.people === undefined) throw new AppError('PROVIDER_UNAVAILABLE');
    const counts = fubConnectionCounts(pages).categories;
    await withTenantTx(
      actor,
      async (tx) => {
        const credId = deps.ids.next<'ProviderCredentialId'>();
        const env = deps.envelope.inTx(tx, actor.tenantId);
        const enc = await env.encrypt(actor.tenantId, credAad(credId), new TextEncoder().encode(input.apiKey));
        await repo.insertCredential(tx, credId, enc, 1);
        await repo.insertBatch(tx, { id: batchId, source: 'fub_api', sourceCounts: counts, credentialId: credId, fileObjectId: null, options: {} });
        await repo.insertStages(tx, batchId, CATEGORIES, () => deps.ids.next<'ImportStageId'>());
      },
      { db: deps.db },
    );
    return { batchId, counts };
  }
  const bytes = decodeFile(input.fileBase64);
  const fileLabel = fileLabelOf(input.fileName);
  if (input.source === 'csv') {
    const ins = inspectCsv(bytes);
    if (!ins.ok) throw new AppError('IMPORT_FILE_INVALID', { reason: ins.code, ...(ins.line !== undefined ? { line: ins.line } : {}), ...(ins.limit !== undefined ? { limit: ins.limit } : {}) });
    const mapping = input.mapping ?? ins.mapping;
    if (mapping.length !== ins.headers.length) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/mapping', code: 'length' }] });
    const counts = { contacts: ins.rows, consent: ins.rows };
    await withTenantTx(
      actor,
      async (tx) => {
        const fileId = await storeFile(deps, tx, actor.tenantId, bytes, 'text/csv');
        await repo.insertBatch(tx, { id: batchId, source: 'csv', sourceCounts: counts, credentialId: null, fileObjectId: fileId, options: { fileLabel, headers: ins.headers, mapping } });
        await repo.insertStages(tx, batchId, CSV_CATEGORIES, () => deps.ids.next<'ImportStageId'>());
      },
      { db: deps.db },
    );
    return { batchId, counts };
  }
  const snap = parseFubExport(bytes);
  if (!snap) throw new AppError('IMPORT_FILE_INVALID', { reason: 'FUB_EXPORT_UNREADABLE' });
  const counts = exportCounts(snap);
  await withTenantTx(
    actor,
    async (tx) => {
      const fileId = await storeFile(deps, tx, actor.tenantId, bytes, 'application/json');
      await repo.insertBatch(tx, { id: batchId, source: 'fub_export', sourceCounts: counts, credentialId: null, fileObjectId: fileId, options: { fileLabel } });
      await repo.insertStages(tx, batchId, CATEGORIES, () => deps.ids.next<'ImportStageId'>());
    },
    { db: deps.db },
  );
  return { batchId, counts };
}

const RESETTABLE: readonly repo.StageStatus[] = ['pending', 'dry_run_ready', 'approved', 'failed'];
const BUSY: readonly repo.StageStatus[] = ['dry_run_running', 'committing', 'reverting'];

/** POST /imports/:id/snapshot: queues the snapshot (first one, or a delta after FUB changed, E42). */
export async function requestSnapshot(deps: ImportDeps, actor: UserActor, batchId: string): Promise<void> {
  await withTenantTx(
    actor,
    async (tx) => {
      const b = await repo.getBatch(tx, batchId, { forUpdate: true });
      if (!b) throw new AppError('NOT_FOUND');
      if (!['connection_test', 'dry_run', 'partially_committed'].includes(b.status)) throw new AppError('IMPORT_STATE_CONFLICT', { status: b.status });
      const stages = await repo.lockStages(tx, batchId);
      if (stages.some((s) => BUSY.includes(s.status))) throw new AppError('IMPORT_STATE_CONFLICT', { status: 'stage_busy' });
      await repo.setBatchStatus(tx, batchId, 'snapshotting');
      await enqueueJob(tx, { queue: SNAPSHOT_JOB.queue, kind: SNAPSHOT_JOB.kind, payload: { batchId }, dedupeKey: `imports.snapshot:${batchId}` });
    },
    { db: deps.db },
  );
}

async function apiKeyOf(deps: ImportDeps, tx: Tx, tenantId: TenantId, credentialId: string): Promise<string> {
  const c = await repo.loadCredential(tx, credentialId);
  if (!c || c.secret_enc === null || c.status !== 'active') throw new AppError('IMPORT_STATE_CONFLICT', { status: 'credential_purged' });
  const pt = await deps.envelope.inTx(tx, tenantId).decrypt(tenantId, credAad(credentialId), new Uint8Array(c.secret_enc));
  return new TextDecoder().decode(pt);
}

function sourceUsers(s: FubSnapshot): { users: { ref: string; label: string; people: number }[]; ponds: { ref: string; label: string; people: number }[] } {
  const labels = new Map<string, string>();
  for (const u of s.collections.users ?? []) {
    const o = u as { id?: unknown; name?: unknown; firstName?: unknown; lastName?: unknown };
    if (typeof o.id !== 'string' && typeof o.id !== 'number') continue;
    const name = typeof o.name === 'string' ? o.name : [o.firstName, o.lastName].filter((x) => typeof x === 'string').join(' ');
    labels.set(String(o.id), name.trim().slice(0, 120) || `FUB user ${String(o.id)}`);
  }
  const users = new Map<string, number>();
  const ponds = new Map<string, number>();
  for (const raw of s.collections.people ?? []) {
    const p = FubPersonSchema.safeParse(raw);
    if (!p.success) continue;
    if (p.data.assignedUserId !== null && p.data.assignedUserId !== undefined) users.set(p.data.assignedUserId, (users.get(p.data.assignedUserId) ?? 0) + 1);
    else if (p.data.assignedPondId !== null && p.data.assignedPondId !== undefined) ponds.set(p.data.assignedPondId, (ponds.get(p.data.assignedPondId) ?? 0) + 1);
  }
  for (const c of ['notes', 'textMessages', 'emails', 'calls'] as const) {
    for (const raw of s.collections[c] ?? []) {
      const o = raw as { userId?: unknown; createdById?: unknown };
      for (const v of [o.userId, o.createdById]) if (typeof v === 'string' || typeof v === 'number') if (!users.has(String(v))) users.set(String(v), 0);
    }
  }
  return {
    users: [...users.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([ref, people]) => ({ ref, label: labels.get(ref) ?? `FUB user ${ref}`, people })),
    ponds: [...ponds.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([ref, people]) => ({ ref, label: `FUB pond ${ref}`, people })),
  };
}

/** The snapshot job (imports.snapshot). Runs as the system actor of the batch's tenant. */
export async function takeSnapshot(deps: ImportDeps, tenantId: string, batchId: string): Promise<'done' | 'skipped'> {
  const actor = systemActor(tenantId, 'import');
  const tid = actor.tenantId;
  const pre = await withTenantTx(actor, async (tx) => {
    const b = await repo.getBatch(tx, batchId);
    if (!b || b.status !== 'snapshotting') return null;
    return { batch: b, apiKey: b.source === 'fub_api' && b.credential_id ? await apiKeyOf(deps, tx, tid, b.credential_id) : null, settings: await repo.importSettings(tx) };
  }, { db: deps.db });
  if (!pre) return 'skipped';
  const { batch } = pre;
  let fileObjectId: string;
  let sha: string;
  const options: repo.BatchOptions = { ...batch.options, snapshotError: null };
  if (batch.source === 'fub_api') {
    const client = deps.fub(pre.apiKey as string);
    const snap: FubSnapshot = { version: 1, collections: {} };
    try {
      for (const c of FUB_COLLECTIONS) {
        try {
          snap.collections[c] = await readCollection(client, c);
        } catch (e) {
          if (e instanceof FubAccessError && e.code === 'FUB_UNAVAILABLE' && e.status === 404) snap.collections[c] = [];
          else throw e;
        }
      }
    } catch (e) {
      const code = e instanceof FubAccessError ? e.code : 'SNAPSHOT_FAILED';
      await withTenantTx(actor, async (tx) => {
        await repo.setBatchOptions(tx, batchId, { ...batch.options, snapshotError: code });
        await repo.setBatchStatus(tx, batchId, batch.source_snapshot_sha256 ? 'dry_run' : 'connection_test');
      }, { db: deps.db });
      return 'done';
    }
    // Recordings are copied now, into encrypted storage, so no later step needs live FUB (R-IMPORT-1).
    const recordings: Record<string, string> = {};
    for (const raw of snap.collections.calls ?? []) {
      const o = raw as { id?: unknown; recordingUrl?: unknown };
      if (typeof o.recordingUrl !== 'string' || o.recordingUrl === '' || (typeof o.id !== 'string' && typeof o.id !== 'number')) continue;
      let rec;
      try {
        rec = await client.fetchRecording(o.recordingUrl);
      } catch {
        rec = null; // not available now: the call is imported without its recording (said so in the review list)
      }
      if (!rec) continue;
      const objectId = deps.ids.next<'StoredObjectId'>();
      await withTenantTx(actor, async (tx) => {
        const sealed = await putObject(deps.envelope.inTx(tx, tid), deps.storage, tid, objectId, 'recording', rec.bytes, rec.contentType);
        await repo.insertStoredObject(tx, {
          id: objectId,
          purpose: 'recording',
          storageKey: sealed.storageKey,
          contentType: rec.contentType,
          byteSize: sealed.byteSize,
          sha256: sealed.sha256,
          dekWrapped: sealed.dekWrapped,
          keyVersion: sealed.keyVersion,
          retentionUntil: new Date(Date.now() + pre.settings.recordingRetentionDays * 86_400_000),
        });
      }, { db: deps.db });
      recordings[String(o.id)] = objectId;
    }
    const bytes = new TextEncoder().encode(JSON.stringify(snap));
    sha = sha256Hex(bytes);
    const su = sourceUsers(snap);
    options.sourceUsers = su.users;
    options.sourcePonds = su.ponds;
    // a delta snapshot replaces the recordings map; objects of the old one that no stage used are dropped below
    const oldRecordings = Object.values(batch.options.recordings ?? {});
    options.recordings = recordings;
    fileObjectId = await withTenantTx(actor, async (tx) => {
      const id = await storeFile(deps, tx, tid, bytes, 'application/json');
      await repo.markObjectsDeleted(tx, await repo.unreferencedObjects(tx, oldRecordings.filter((x) => !Object.values(recordings).includes(x))));
      if (batch.file_object_id) await repo.markObjectsDeleted(tx, [batch.file_object_id]);
      return id;
    }, { db: deps.db });
  } else {
    fileObjectId = batch.file_object_id as string;
    const bytes = await withTenantTx(actor, (tx) => readObjectBytes(deps, tx, tid, fileObjectId), { db: deps.db });
    sha = sha256Hex(bytes);
    if (batch.source === 'fub_export') {
      const snap = parseFubExport(bytes) as FubSnapshot;
      const su = sourceUsers(snap);
      options.sourceUsers = su.users;
      options.sourcePonds = su.ponds;
    }
  }
  await withTenantTx(actor, async (tx) => {
    const b = await repo.getBatch(tx, batchId, { forUpdate: true });
    if (!b || b.status !== 'snapshotting') return;
    const stages = await repo.lockStages(tx, batchId);
    for (const s of stages) if (RESETTABLE.includes(s.status)) await repo.resetStageDryRun(tx, s.id, 'pending');
    await repo.setSnapshot(tx, batchId, { sha256: sha, fileObjectId, options });
    // a batch with committed stages keeps saying so
    if (stages.some((s) => ['committed', 'verified'].includes(s.status))) await repo.setBatchStatus(tx, batchId, 'partially_committed');
  }, { db: deps.db });
  return 'done';
}

export async function readObjectBytes(deps: ImportDeps, tx: Tx, tenantId: TenantId, objectId: string): Promise<Uint8Array> {
  const o = await repo.loadStoredObject(tx, objectId);
  if (!o || o.dek_wrapped === null) throw new Error('IMPORT_SNAPSHOT_MISSING');
  const bytes = await getObject(deps.envelope.inTx(tx, tenantId), deps.storage, tenantId, objectId, o.storage_key, new Uint8Array(o.dek_wrapped));
  if (bytes === null) throw new Error('IMPORT_SNAPSHOT_MISSING');
  return bytes;
}

/** The batch's snapshot bytes, checked against the recorded sha256 (R-IMPORT-4). */
export async function readSnapshot(deps: ImportDeps, tx: Tx, tenantId: TenantId, batch: repo.BatchRow): Promise<Uint8Array> {
  if (!batch.file_object_id || !batch.source_snapshot_sha256) throw new Error('IMPORT_SNAPSHOT_MISSING');
  const bytes = await readObjectBytes(deps, tx, tenantId, batch.file_object_id);
  if (sha256Hex(bytes) !== batch.source_snapshot_sha256) throw new Error('IMPORT_SNAPSHOT_TAMPERED');
  return bytes;
}

/** The records of one FUB stage, from the snapshot, with each record's raw source object. */
export function fubStageRecords(s: FubSnapshot, category: Category, users: UserMapping): StageSource {
  const c = s.collections;
  const raws =
    category === 'notes' ? (c.notes ?? []) : category === 'messages' ? [...(c.textMessages ?? []), ...(c.emails ?? [])] : category === 'call_recordings' ? (c.calls ?? []) : (c.people ?? []);
  const outcomes: RecordOutcome<NormalizedRecord>[] = [];
  const map = new Map<string, unknown>();
  for (const raw of raws) {
    const o = mapFub(category, raw, users);
    outcomes.push(o);
    if (!map.has(o.sourceRef)) map.set(o.sourceRef, raw);
  }
  return { outcomes, raws: map };
}

/** import_user_mappings → core UserMapping (ponds are stored with a `pond:` ref prefix). */
export async function userMapping(tx: Tx, batchId: string): Promise<UserMapping> {
  const rows = await repo.listMappings(tx, batchId);
  const users = new Map<string, ImportTarget>();
  const ponds = new Map<string, ImportTarget>();
  for (const r of rows) {
    const target: ImportTarget = r.target_kind === 'user' ? { userId: r.target_user_id as UserId } : r.target_kind === 'pond' ? { pondId: r.target_pond_id as PondId } : 'unassigned';
    if (r.source_user_ref.startsWith('pond:')) ponds.set(r.source_user_ref.slice(5), target);
    else users.set(r.source_user_ref, target);
  }
  return { users, ponds };
}

export type MappingInput = { sourceRef: string; kind: 'user' | 'pond'; target: { kind: 'user'; userId: string } | { kind: 'pond'; pondId: string } | { kind: 'unassigned' } };

/** PUT /imports/:id/user-mappings (R-IMPORT-8). A changed mapping invalidates the ownership dry run. */
export async function setUserMappings(deps: ImportDeps, actor: UserActor, batchId: string, mappings: readonly MappingInput[]): Promise<void> {
  await withTenantTx(
    actor,
    async (tx) => {
      const b = await repo.getBatch(tx, batchId, { forUpdate: true });
      if (!b) throw new AppError('NOT_FOUND');
      if (b.source === 'csv') throw new AppError('IMPORT_STATE_CONFLICT', { status: 'csv_has_no_users' });
      const stages = await repo.lockStages(tx, batchId);
      const known = new Map([...(b.options.sourceUsers ?? []).map((u) => [u.ref, u.label] as const), ...(b.options.sourcePonds ?? []).map((p) => [`pond:${p.ref}`, p.label] as const)]);
      const targets = await repo.mappingTargets(tx);
      for (const m of mappings) {
        const ref = m.kind === 'pond' ? `pond:${m.sourceRef}` : m.sourceRef;
        const label = known.get(ref);
        if (label === undefined) throw new AppError('IMPORT_MAPPING_INVALID', { sourceRef: m.sourceRef, reason: 'UNKNOWN_SOURCE_REF' });
        if (m.target.kind === 'user' && targets.users.get(m.target.userId)?.eligible !== true) throw new AppError('IMPORT_MAPPING_INVALID', { sourceRef: m.sourceRef, reason: 'TARGET_NOT_ELIGIBLE' });
        if (m.target.kind === 'pond' && !targets.ponds.has(m.target.pondId)) throw new AppError('IMPORT_MAPPING_INVALID', { sourceRef: m.sourceRef, reason: 'POND_UNKNOWN' });
        await repo.upsertMapping(tx, batchId, {
          source_user_ref: ref,
          source_user_label: label,
          target_kind: m.target.kind,
          target_user_id: m.target.kind === 'user' ? m.target.userId : null,
          target_pond_id: m.target.kind === 'pond' ? m.target.pondId : null,
        });
      }
      // the mapping feeds ownership and the authors of history: those dry runs are no longer current
      for (const s of stages) if (['ownership', 'notes', 'messages', 'call_recordings'].includes(s.category) && ['dry_run_ready', 'approved'].includes(s.status)) await repo.resetStageDryRun(tx, s.id, 'pending');
    },
    { db: deps.db },
  );
}

/** PUT /imports/:id/csv-mapping: a new column mapping resets the CSV dry runs that have not committed. */
export async function setCsvMapping(deps: ImportDeps, actor: UserActor, batchId: string, mapping: ColumnMapping): Promise<void> {
  await withTenantTx(
    actor,
    async (tx) => {
      const b = await repo.getBatch(tx, batchId, { forUpdate: true });
      if (!b) throw new AppError('NOT_FOUND');
      if (b.source !== 'csv') throw new AppError('IMPORT_STATE_CONFLICT', { status: 'not_csv' });
      if (mapping.length !== (b.options.headers ?? []).length) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/mapping', code: 'length' }] });
      const stages = await repo.lockStages(tx, batchId);
      if (stages.some((s) => !RESETTABLE.includes(s.status) && s.status !== 'skipped')) throw new AppError('IMPORT_STATE_CONFLICT', { status: 'stage_committed' });
      await repo.setBatchOptions(tx, batchId, { ...b.options, mapping });
      for (const s of stages) if (RESETTABLE.includes(s.status)) await repo.resetStageDryRun(tx, s.id, 'pending');
    },
    { db: deps.db },
  );
}

/** POST /imports/:id/abandon: nothing committed (or everything reverted); the FUB key is purged now (R-IMPORT-11). */
export async function abandonImport(deps: ImportDeps, actor: UserActor, batchId: string): Promise<void> {
  await withTenantTx(
    actor,
    async (tx) => {
      const b = await repo.getBatch(tx, batchId, { forUpdate: true });
      if (!b) throw new AppError('NOT_FOUND');
      if (b.status === 'abandoned') return;
      const stages = await repo.lockStages(tx, batchId);
      if (stages.some((s) => ['dry_run_running', 'committing', 'committed', 'verified', 'reverting'].includes(s.status))) {
        throw new AppError('IMPORT_STATE_CONFLICT', { status: 'revert_first' });
      }
      // (a reverted batch keeps its stages' revert reports; the batch row's CHECK ties reverted_at to `reverted`)
      await repo.setBatchStatus(tx, batchId, 'abandoned', { clearReverted: true });
      if (b.credential_id) await repo.purgeCredentialNow(tx, b.credential_id);
      const unused = await repo.unreferencedObjects(tx, Object.values(b.options.recordings ?? {}));
      await repo.markObjectsDeleted(tx, [...unused, ...(b.file_object_id ? [b.file_object_id] : [])]);
    },
    { db: deps.db },
  );
}
