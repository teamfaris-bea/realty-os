// Stages: dry run, review, approval, skip and verification (BUILD_PLAN module 16; ARCHITECTURE §13;
// R-IMPORT-2, R-IMPORT-3, R-IMPORT-4, R-IMPORT-5, R-IMPORT-7, R-IMPORT-8, R-IMPORT-9, E39, E41, E42).
//
// - Dry run (job imports.dry_run, system actor 'import'): reads the encrypted snapshot (sha-checked),
//   normalizes the stage's records, matches them against the tenant's data (core dryRun) and stores
//   one import_records row per source record: the outcome, the issues, the planned action and the raw
//   source object field-encrypted (R-DATA-1). Nothing else is written. Re-running upserts on
//   (stage, source_ref) (R-IMPORT-9) and clears earlier reviews of the changed records.
// - Review: needs_review records take import / merge / reject; a will_import record may be rejected.
//   A review after approval clears the approval (the reviewed plan changed).
// - Approve (Owner/Admin 🔒, audited): only a dry run with no blockers, presented with the digest the
//   reviewer saw (E42: SNAPSHOT_CHANGED otherwise), and newer than every earlier stage's commit. The
//   commit plan's expected counts are stored with the approval (the R-IMPORT-5 recount compares them).
// - Verify (Owner/Admin 🔒, audited): recount (expected vs DB, exact reconciliation) plus 20 spot checks
//   the verifier confirmed side by side; recorded with the verifier (DB CHECK + trigger). The expected
//   counts are the approval's with the documented commit outcomes applied (owner decision B4, E230: a
//   planned assignment brought in unassigned because its member could no longer hold leads is not imported
//   for that reason, never a mismatch); the stored verification keeps both, and the documented counts.
import type { AddressKind, Channel } from '@realty/core/compliance';
import type { ContactId, TenantId, UserActor } from '@realty/core/foundation';
import {
  type Category,
  type ContactsStagePlan,
  type Counts,
  type DocumentedOutcomes,
  type ExistingIndex,
  type FubConsentFields,
  type Issue,
  type NormalizedRecord,
  type PlanAction,
  type PlannedRecord,
  type Review,
  type StageDryRun,
  addSkippedDuplicates,
  buildExistingIndex,
  buildVerification,
  commitPlan,
  dryRun,
  expectedAfterCommit,
  importedOptOuts,
  mapFub,
  personRefOf,
  skippedDuplicateOf,
  spotCheckSample,
} from '@realty/core/import';
import { type Tx, enqueueJob, withTenantTx } from '@realty/db';
import { audit } from '../audit.js';
import { AppError } from '../errors.js';
import { systemActor } from '../worker/systemActor.js';
import { fubStageRecords, parseFubExport, readSnapshot, userMapping } from './batches.js';
import { csvStageRecords, type StageSource } from './csv.js';
import * as brepo from './repos/batches.js';
import * as existing from './repos/existing.js';
import * as rrepo from './repos/records.js';
import * as vrepo from './repos/verify.js';
import { summarize } from './parity.js';
import { FUB_KEY_PURGE_DAYS, type ImportDeps, SOURCE_SYSTEM } from './types.js';
import { documentedView } from './views.js';

export const DRY_RUN_JOB = { kind: 'imports.dry_run' as const, queue: 'bulk' as const };

const rawAad = (id: string) => ({ table: 'import_records', column: 'raw_enc', rowId: id });

// ---- small helpers ----------------------------------------------------------------------------------

export async function loadBatchAndStage(tx: Tx, batchId: string, category: Category, o: { lock?: boolean } = {}): Promise<{ batch: brepo.BatchRow; stage: brepo.StageRow; stages: brepo.StageRow[] }> {
  const batch = await brepo.getBatch(tx, batchId, { forUpdate: o.lock === true });
  if (!batch) throw new AppError('NOT_FOUND');
  const stages = o.lock ? await brepo.lockStages(tx, batchId) : await brepo.getStages(tx, batchId);
  const stage = stages.find((s) => s.category === category);
  if (!stage) throw new AppError('NOT_FOUND');
  return { batch, stage, stages };
}

function conflict(status: string): AppError {
  return new AppError('IMPORT_STATE_CONFLICT', { status });
}

/** Every normalized phone / email a record carries (for the HMAC precomputation). */
function addressesOf(r: NormalizedRecord): { kind: AddressKind; address: string }[] {
  if (r.category === 'contacts') {
    const out = [...r.phones.map((p) => ({ kind: 'phone' as const, address: p.e164 })), ...r.emails.map((e) => ({ kind: 'email' as const, address: e.email }))];
    if (r.consent) out.push(...r.consent.fields.addresses.map((a) => ({ kind: a.kind, address: a.address })));
    return out;
  }
  if (r.category === 'consent') return r.fields.addresses.map((a) => ({ kind: a.kind, address: a.address }));
  return [];
}

/** A synchronous keyOf for core: every address is HMAC'd up front (stored point HMACs are reused). */
export async function hmacIndex(deps: ImportDeps, tx: Tx, tenantId: TenantId, known: Map<string, string>, addrs: Iterable<{ kind: AddressKind; address: string }>): Promise<(kind: AddressKind, n: string) => string> {
  const env = deps.envelope.inTx(tx, tenantId);
  for (const a of addrs) {
    const k = `${a.kind}:${a.address}`;
    if (!known.has(k)) known.set(k, Buffer.from(await env.hmacAddress(tenantId, a.address)).toString('hex'));
  }
  return (kind, n) => {
    const v = known.get(`${kind}:${n}`);
    if (v === undefined) throw new Error('IMPORT_HMAC_MISSING');
    return v;
  };
}

function personRefOfRecord(r: rrepo.RecordRow): string | null {
  const n = r.normalized as NormalizedRecord | null;
  if (n && n.category === 'contacts') return personRefOf(n);
  const fub = /^fub:people\/(.+)$/.exec(r.source_ref);
  return fub ? (fub[1] as string) : r.source_ref;
}

/** Contacts-stage statuses whose dry run is a plan that still happens (or happened): the later stages plan against it. */
const CONTACTS_PLAN_CURRENT: ReadonlySet<brepo.StageStatus> = new Set(['dry_run_ready', 'approved', 'committing', 'committed', 'verified']);
/** From these on, a record the plan does not apply never will be in this batch (no review, no new dry run). */
const CONTACTS_PLAN_FINAL: ReadonlySet<brepo.StageStatus> = new Set(['committing', 'committed', 'verified']);

/**
 * The contacts-stage plan for person refs not committed yet (later stages may dry-run first, R-IMPORT-3), and for
 * the people skipped as duplicates: a skip is never committed and writes no external_ref, so a later stage needs to
 * know what the skip points at (B6, R-IMPORT-4; core skippedDuplicateOf, the same rule as core contactsStagePlan).
 *
 * Only a plan that can still happen counts (B6 review R3): a contacts stage skipped after its dry run, or reset to
 * pending by a new snapshot or mapping (or failed, or running again), has no current plan, so the later stages see
 * only what is committed (external_refs), exactly what their commit will find. And once the contacts stage commits,
 * a record it left undecided can never be decided in this batch (B6 review R4): it is planned as not imported
 * (`rejected`), never as waiting for a review (PARENT_NOT_LINKED), so no review decision can make a later stage's
 * commit differ from its dry run.
 */
export async function contactsStageMap(tx: Tx, batchId: string): Promise<Map<string, ContactsStagePlan>> {
  const out = new Map<string, ContactsStagePlan>();
  const status = (await brepo.getStages(tx, batchId)).find((s) => s.category === 'contacts')?.status;
  if (status === undefined || !CONTACTS_PLAN_CURRENT.has(status)) return out;
  const final = CONTACTS_PLAN_FINAL.has(status);
  const recs = await rrepo.contactsStageRecords(tx, batchId);
  const refOf = new Map<string, string>();
  for (const r of recs) {
    const ref = personRefOfRecord(r);
    if (ref !== null) refOf.set(r.source_ref, ref);
  }
  const skips: { personRef: string; sameAs: ReturnType<typeof skippedDuplicateOf> }[] = [];
  for (const r of recs) {
    if (r.outcome === 'imported') continue; // committed: external_refs knows it
    const ref = personRefOfRecord(r);
    if (ref === null) continue;
    const plan = r.plan as PlanAction | null;
    if (r.dry_run_outcome === 'rejected' || r.review_decision === 'reject' || r.outcome === 'rejected') out.set(ref, 'rejected');
    else if (r.dry_run_outcome === 'needs_review' && r.review_decision === null) out.set(ref, final ? 'rejected' : 'needs_review');
    else if (plan?.kind === 'create_contact' && r.review_decision !== 'merge') out.set(ref, 'create');
    else if (plan?.kind === 'skip') skips.push({ personRef: ref, sameAs: skippedDuplicateOf({ action: plan, issues: r.issues as Issue[] }, (s) => refOf.get(s)) });
    else out.set(ref, 'attach');
  }
  addSkippedDuplicates(out, skips);
  return out;
}

/** The stage's records from the snapshot. */
export async function stageSource(deps: ImportDeps, tx: Tx, tenantId: TenantId, batch: brepo.BatchRow, category: Category): Promise<StageSource> {
  const bytes = await readSnapshot(deps, tx, tenantId, batch);
  if (batch.source === 'csv') {
    return csvStageRecords(bytes, (batch.options.mapping ?? []) as never, batch.options.fileLabel ?? 'file.csv', category);
  }
  const snap = batch.source === 'fub_export' ? parseFubExport(bytes) : (JSON.parse(Buffer.from(bytes).toString('utf8')) as Parameters<typeof fubStageRecords>[0]);
  if (!snap) throw new Error('IMPORT_SNAPSHOT_UNREADABLE');
  return fubStageRecords(snap, category, await userMapping(tx, batch.id));
}

/** Builds the core ExistingIndex for a batch (system actor: tenant-wide). */
export async function existingIndexFor(deps: ImportDeps, tx: Tx, tenantId: TenantId, batch: brepo.BatchRow, records: Iterable<NormalizedRecord>, category: Category): Promise<ExistingIndex> {
  const snap = await existing.loadContacts(tx);
  const addrs: { kind: AddressKind; address: string }[] = [];
  for (const r of records) addrs.push(...addressesOf(r));
  const keyOf = await hmacIndex(deps, tx, tenantId, snap.hmacs, addrs);
  return buildExistingIndex({
    batchId: batch.id,
    keyOf,
    contacts: snap.contacts,
    externalRefs: await existing.loadExternalRefs(tx, SOURCE_SYSTEM[batch.source]),
    contactsStage: category === 'contacts' ? new Map() : await contactsStageMap(tx, batch.id),
    optedOut: await existing.loadOptedOut(tx),
    importedConsent: await existing.loadImportedConsentKeys(tx),
  });
}

// ---- dry run ------------------------------------------------------------------------------------------

/** POST /imports/:id/stages/:category/dry-run: queues the dry run of one stage. */
export async function requestDryRun(deps: ImportDeps, actor: UserActor, batchId: string, category: Category): Promise<void> {
  await withTenantTx(
    actor,
    async (tx) => {
      const { batch, stage, stages } = await loadBatchAndStage(tx, batchId, category, { lock: true });
      if (!['dry_run', 'committing', 'partially_committed', 'committed'].includes(batch.status) || !batch.source_snapshot_sha256) throw conflict(batch.status);
      if (!['pending', 'dry_run_ready', 'approved', 'failed', 'skipped'].includes(stage.status)) throw conflict(stage.status);
      if (stage.status === 'skipped' && stages.some((s) => s.seq > stage.seq && ['committing', 'committed', 'verified'].includes(s.status))) throw conflict('later_stage_committed');
      await brepo.resetStageDryRun(tx, stage.id, 'dry_run_running');
      await enqueueJob(tx, { queue: DRY_RUN_JOB.queue, kind: DRY_RUN_JOB.kind, payload: { stageId: stage.id }, dedupeKey: `imports.dry_run:${stage.id}` });
    },
    { db: deps.db },
  );
}

/** The opt-outs a contacts-stage record carries over at commit (stored with its plan as `optOuts`). */
export interface ContactOptOuts {
  fields: FubConsentFields;
  provenance: Record<string, unknown>;
}

const NO_USERS = { users: new Map(), ponds: new Map() };

/**
 * outbound-2 / R-CONSENT-3 / E40: the person's imported revocations and do-not-contact flags, read at
 * the contacts dry run (CSV: the row's consent columns; FUB: the person's consent indicators), so the
 * contacts commit applies them with the contact itself instead of leaving the contact sendable until
 * the last (consent) stage commits.
 */
export function contactOptOuts(source: brepo.BatchRow['source'], p: PlannedRecord, raw: unknown): ContactOptOuts | null {
  const n = p.normalized;
  if (n?.category !== 'contacts') return null;
  let fields: FubConsentFields;
  let provenance: Record<string, unknown>;
  if (source === 'csv') {
    if (!n.consent) return null;
    fields = importedOptOuts(n.consent.fields, n.consent.issues);
    provenance = { source: 'csv', sourceRef: p.sourceRef, indicators: fields.addresses.map((a) => ({ kind: a.kind, revokes: a.revokes, doNotContact: a.doNotContact })) };
  } else {
    if (raw === null || raw === undefined) return null;
    const o = mapFub('consent', raw, NO_USERS);
    if (o.record?.category !== 'consent') return null;
    fields = importedOptOuts(o.record.fields, o.issues);
    provenance = o.record.provenance;
  }
  return fields.addresses.length > 0 ? { fields, provenance } : null;
}

function planOf(p: PlannedRecord, optOuts: ContactOptOuts | null = null): unknown {
  return p.action === null ? null : { ...p.action, staysOptedOut: p.staysOptedOut, ...(optOuts ? { optOuts } : {}) };
}

/** The dry-run job (imports.dry_run). One transaction: the stage's records are all written or none. */
export async function runDryRun(deps: ImportDeps, tenantId: string, stageId: string): Promise<'done' | 'skipped' | 'failed'> {
  const actor = systemActor(tenantId, 'import');
  try {
    return await withTenantTx(
      actor,
      async (tx) => {
        const stage = await brepo.getStageById(tx, stageId, { forUpdate: true });
        if (!stage || stage.status !== 'dry_run_running') return 'skipped';
        const batch = (await brepo.getBatch(tx, stage.batch_id)) as brepo.BatchRow;
        const src = await stageSource(deps, tx, actor.tenantId, batch, stage.category);
        const index = await existingIndexFor(deps, tx, actor.tenantId, batch, src.outcomes.flatMap((o) => (o.record ? [o.record] : [])), stage.category);
        const dry = dryRun(stage.category, src.outcomes, index);
        const ids = await rrepo.existingRecordIds(tx, stage.id);
        const env = deps.envelope.inTx(tx, actor.tenantId);
        const rows: rrepo.RecordUpsert[] = [];
        for (const p of dry.records) {
          const prev = ids.get(p.sourceRef);
          if (prev && !['will_import', 'needs_review', 'rejected', 'duplicate', 'skipped'].includes(prev.outcome)) continue; // applied earlier: never rewritten
          const id = prev?.id ?? deps.ids.next<'ImportRecordId'>();
          const raw = src.raws.get(p.sourceRef) ?? null;
          const enc = await env.encrypt(actor.tenantId, rawAad(id), new TextEncoder().encode(JSON.stringify(raw)));
          const optOuts = stage.category === 'contacts' ? contactOptOuts(batch.source, p, raw) : null;
          rows.push({ id, sourceRef: p.sourceRef, rawEncHex: Buffer.from(enc).toString('hex'), normalized: p.normalized, outcome: p.outcome, issues: p.issues, matchContactId: p.matchContactId, plan: planOf(p, optOuts) });
        }
        await rrepo.upsertRecords(tx, stage.id, rows);
        await rrepo.markStale(tx, stage.id, new Set(dry.records.map((r) => r.sourceRef)));
        // PARITY 65 (R-PAR-46): the contacts dry run also plans stages, tags and custom fields; a stage label
        // nobody mapped, a catalog over 1,000 tags or more than 50 live fields blocks the approval
        const parityBlockers: { code: string; severity: string }[] = [];
        if (stage.category === 'contacts') {
          const summary = await summarize(tx, batch, src.outcomes.flatMap((o) => (o.record && o.record.category === 'contacts' ? [o.record] : [])));
          await brepo.setBatchOptions(tx, batch.id, { ...batch.options, paritySummary: summary });
          for (const code of summary.blockers) parityBlockers.push({ code, severity: 'error' });
        }
        await brepo.setDryRunResult(tx, stage.id, {
          counts: dry.counts,
          sha256: dry.snapshotSha256,
          blockers: [...dry.blockers, ...parityBlockers],
          consentSummary: dry.consentSummary as Record<string, number> | null,
        });
        return 'done' as const;
      },
      { db: deps.db },
    );
  } catch (e) {
    await withTenantTx(actor, (tx) => brepo.transitionStage(tx, stageId, ['dry_run_running'], 'failed'), { db: deps.db });
    void e;
    return 'failed';
  }
}

// ---- review ---------------------------------------------------------------------------------------------

export async function reviewRecord(deps: ImportDeps, actor: UserActor, batchId: string, recordId: string, decision: 'import' | 'merge' | 'reject', mergeIntoContactId: string | null): Promise<rrepo.RecordRow> {
  return withTenantTx(
    actor,
    async (tx) => {
      const batch = await brepo.getBatch(tx, batchId, { forUpdate: true });
      if (!batch) throw new AppError('NOT_FOUND');
      const stages = await brepo.lockStages(tx, batchId);
      const rec = await rrepo.getRecord(tx, stages.map((s) => s.id), recordId, { forUpdate: true });
      if (!rec) throw new AppError('NOT_FOUND');
      const stage = stages.find((s) => s.id === rec.stage_id) as brepo.StageRow;
      if (!['dry_run_ready', 'approved'].includes(stage.status)) throw conflict(stage.status);
      if (rec.outcome === 'skipped' || rec.dry_run_outcome === null) throw new AppError('IMPORT_REVIEW_INVALID', { reason: 'NOT_IN_DRY_RUN' });
      let stored: 'import' | 'merge' | 'reject' | null = decision;
      if (rec.dry_run_outcome === 'will_import') {
        if (decision === 'merge') throw new AppError('IMPORT_REVIEW_INVALID', { reason: 'MERGE_NOT_OFFERED' });
        if (decision === 'import') stored = null; // undo an earlier reject
      } else if (rec.dry_run_outcome !== 'needs_review') {
        throw new AppError('IMPORT_REVIEW_INVALID', { reason: 'NOT_REVIEWABLE' });
      }
      if (decision === 'merge') {
        const n = rec.normalized as NormalizedRecord | null;
        const plan = rec.plan as (PlanAction & { duplicateCandidates?: { contactId: string }[] }) | null;
        const candidates = new Set([...(rec.match_contact_id ? [rec.match_contact_id] : []), ...(plan?.duplicateCandidates ?? []).map((d) => d.contactId)]);
        if (n?.category !== 'contacts' || mergeIntoContactId === null || !candidates.has(mergeIntoContactId)) throw new AppError('IMPORT_REVIEW_INVALID', { reason: 'MERGE_TARGET_NOT_A_CANDIDATE' });
      }
      if (stage.status === 'approved') await brepo.clearApproval(tx, stage.id);
      await rrepo.setReview(tx, rec.id, stored, decision === 'merge' ? mergeIntoContactId : null);
      return (await rrepo.getRecord(tx, [stage.id], rec.id)) as rrepo.RecordRow;
    },
    { db: deps.db },
  );
}

// ---- approve ----------------------------------------------------------------------------------------------

/** Rebuilds the stored dry run as core's StageDryRun (the commit plan input). */
export function storedDryRun(stage: brepo.StageRow, records: readonly rrepo.RecordRow[]): { dry: StageDryRun; reviews: Review[] } {
  const planned: PlannedRecord[] = records.map((r) => {
    const plan = r.plan === null ? null : ({ ...r.plan } as Record<string, unknown>);
    if (plan) {
      delete plan.staysOptedOut;
      delete plan.mergeIntoContactId;
      delete plan.optOuts;
    }
    return {
      sourceRef: r.source_ref,
      outcome: r.dry_run_outcome as PlannedRecord['outcome'],
      action: plan as PlanAction | null,
      issues: r.issues as Issue[],
      matchContactId: r.match_contact_id as ContactId | null,
      normalized: r.normalized as NormalizedRecord | null,
      staysOptedOut: [],
    };
  });
  const reviews: Review[] = records
    .filter((r) => r.review_decision !== null)
    .map((r) => ({
      sourceRef: r.source_ref,
      decision: r.review_decision as Review['decision'],
      ...(r.review_decision === 'merge' ? { mergeIntoContactId: (r.plan as { mergeIntoContactId?: string } | null)?.mergeIntoContactId as ContactId } : {}),
    }));
  const counts = { source: planned.length, will_import: 0, needs_review: 0, rejected: 0, duplicate: 0 };
  for (const p of planned) counts[p.outcome] += 1;
  return {
    dry: { category: stage.category, counts, records: planned, blockers: stage.blockers as Issue[], snapshotSha256: stage.dry_run_sha256 ?? '', consentSummary: null },
    reviews,
  };
}

export async function approveStage(deps: ImportDeps, actor: UserActor, batchId: string, category: Category, presentedSha256: string): Promise<Counts> {
  return withTenantTx(
    actor,
    async (tx) => {
      const { batch, stage, stages } = await loadBatchAndStage(tx, batchId, category, { lock: true });
      if (['abandoned', 'reverting', 'reverted', 'snapshotting'].includes(batch.status)) throw conflict(batch.status);
      if (stage.status !== 'dry_run_ready') throw conflict(stage.status);
      if (presentedSha256 !== stage.dry_run_sha256) throw new AppError('SNAPSHOT_CHANGED');
      if (stage.blockers.length > 0) throw new AppError('IMPORT_STAGE_BLOCKED', { blockers: stage.blockers.map((b) => b.code) });
      const ranAt = stage.dry_run_completed_at?.getTime() ?? 0;
      if (stages.some((s) => s.seq < stage.seq && s.committed_at !== null && s.committed_at.getTime() > ranAt)) throw new AppError('IMPORT_DRY_RUN_STALE');
      const records = await rrepo.allPlannedRecords(tx, stage.id);
      const { dry, reviews } = storedDryRun(stage, records);
      const mergeTargets = reviews.flatMap((r) => (r.mergeIntoContactId ? [r.mergeIntoContactId] : []));
      const targets = mergeTargets.length > 0 ? (await existing.loadContacts(tx, mergeTargets)).contacts : [];
      const index = buildExistingIndex({ batchId, keyOf: () => '', contacts: targets });
      const plan = commitPlan(dry, reviews, presentedSha256, index);
      if (!plan.ok) {
        if (plan.code === 'SNAPSHOT_CHANGED') throw new AppError('SNAPSHOT_CHANGED');
        if (plan.code === 'STAGE_BLOCKED') throw new AppError('IMPORT_STAGE_BLOCKED');
        throw new AppError('IMPORT_REVIEW_INVALID', { reason: plan.code, sourceRefs: plan.sourceRefs.slice(0, 50) });
      }
      if (!(await brepo.approveStage(tx, stage.id, plan.expected as unknown as Record<string, number>))) throw conflict('changed');
      await audit(tx, actor, { action: 'import.approved', entity: { type: 'import_stage', id: stage.id }, reason: `${category.toUpperCase()}_APPROVED` });
      return plan.expected;
    },
    { db: deps.db, retries: 1 },
  );
}

/** CSV column fields that can carry a revocation or a do-not-contact flag (core csv ColumnTarget.field). */
const CSV_CONSENT_TARGETS: ReadonlySet<string> = new Set(['consent_sms', 'consent_email', 'consent_voice', 'opted_out', 'unsubscribed', 'do_not_contact']);

/**
 * R-CONSENT-3 / E40: imported opt-outs, unsubscribes and DNC flags take effect at full strength, so the
 * consent stage may be skipped only when it has none to apply: the contacts stage was skipped (nothing
 * of this source is in the tenant), a CSV maps no consent column, or the current consent dry run plans
 * no revocation and no do-not-contact flag.
 */
async function consentSkipBlocker(tx: Tx, batch: brepo.BatchRow, stage: brepo.StageRow, stages: readonly brepo.StageRow[]): Promise<string | null> {
  if (stages.find((s) => s.category === 'contacts')?.status === 'skipped') return null;
  if (batch.source === 'csv' && !(batch.options.mapping ?? []).some((t) => CSV_CONSENT_TARGETS.has(String((t as { field?: unknown } | null)?.field ?? '')))) return null;
  if (!['dry_run_ready', 'approved'].includes(stage.status)) return 'consent_dry_run_required';
  return (await rrepo.pendingOptOuts(tx, stage.id)) > 0 ? 'consent_opt_outs_pending' : null;
}

/** POST …/skip: a stage the team does not import (R-IMPORT-3 lets later stages commit after it). */
export async function skipStage(deps: ImportDeps, actor: UserActor, batchId: string, category: Category): Promise<void> {
  await withTenantTx(
    actor,
    async (tx) => {
      const { batch, stage, stages } = await loadBatchAndStage(tx, batchId, category, { lock: true });
      if (['abandoned', 'reverting', 'reverted', 'snapshotting'].includes(batch.status)) throw conflict(batch.status);
      if (category === 'consent') {
        const why = await consentSkipBlocker(tx, batch, stage, stages);
        if (why) throw conflict(why);
      }
      if (!(await brepo.transitionStage(tx, stage.id, ['pending', 'dry_run_ready', 'approved', 'failed'], 'skipped'))) throw conflict(stage.status);
      // B6 review R3 (R-IMPORT-4): every later stage plans its parents against the contacts plan, which a skip discards;
      // a later dry run made against it is no longer current (a new one plans against what is committed)
      if (category === 'contacts') {
        for (const s of stages) if (s.seq > stage.seq && ['dry_run_ready', 'approved'].includes(s.status)) await brepo.resetStageDryRun(tx, s.id, 'pending');
      }
      await audit(tx, actor, { action: 'import.approved', entity: { type: 'import_stage', id: stage.id }, reason: `${category.toUpperCase()}_SKIPPED` });
      await settleIfLast(tx, batch, stages.map((s) => (s.id === stage.id ? 'skipped' : s.status)));
    },
    { db: deps.db },
  );
}

/**
 * The last stage settled (verified or skipped): the batch is complete and the FUB key purge is scheduled
 * (R-IMPORT-11: at most 30 days after the last stage is verified), whichever action settled it.
 */
async function settleIfLast(tx: Tx, batch: brepo.BatchRow, statuses: readonly brepo.StageStatus[]): Promise<void> {
  if (!statuses.every((s) => s === 'verified' || s === 'skipped')) return;
  if (statuses.some((s) => s === 'verified')) await brepo.setBatchStatus(tx, batch.id, 'committed');
  if (batch.credential_id) await brepo.schedulePurge(tx, batch.credential_id, FUB_KEY_PURGE_DAYS);
}

// ---- verification -------------------------------------------------------------------------------------------

export interface SideBySide {
  sourceRef: string;
  recordId: string;
  source: Record<string, unknown>;
  imported: Record<string, unknown> | null;
  same: boolean;
}

export interface VerificationView {
  /** what the approval expected, with the documented commit outcomes applied (owner decision B4, E230) */
  expected: Counts;
  /** what the approval expected */
  approved: Counts;
  /** the commit outcomes the approved plan could not predict, each documented on its records, in words */
  documented: { code: string; count: number; sentence: string }[];
  db: Counts;
  matches: boolean;
  diffs: { key: string; source: number; db: number }[];
  sample: SideBySide[];
}

function sourceSide(n: NormalizedRecord | null): Record<string, unknown> {
  if (!n) return {};
  switch (n.category) {
    case 'contacts':
      return { displayName: n.displayName, firstName: n.firstName, lastName: n.lastName, phones: n.phones.map((p) => p.e164).sort(), emails: n.emails.map((e) => e.email).sort() };
    case 'ownership':
      return { target: n.target };
    case 'notes':
      return { body: n.body, occurredAt: new Date(n.occurredAt).toISOString() };
    case 'messages':
      return { channel: n.channel, direction: n.direction, body: n.body, occurredAt: new Date(n.occurredAt).toISOString() };
    case 'call_recordings':
      return { direction: n.direction, startedAt: new Date(n.startedAt).toISOString(), durationS: n.durationS, status: n.status, recording: n.recording ? 'recording notice unknown' : null };
    case 'consent':
      return {
        grants: n.fields.addresses.flatMap((a) => a.grants.filter((c) => !a.revokes.includes(c)).map((c) => `grant:${c}:imported_unverified`)).sort(),
        revokes: n.fields.addresses.flatMap((a) => a.revokes.map((c) => `revoke:${c}:none`)).sort(),
        doNotContact: n.fields.addresses.some((a) => a.doNotContact),
      };
  }
}

/** Whether the DB row says what the source said (a convenience for the verifier, who still decides). */
function same(n: NormalizedRecord | null, dbRow: Record<string, unknown> | null): boolean {
  if (!n || !dbRow) return false;
  const s = sourceSide(n);
  switch (n.category) {
    case 'contacts': {
      const phones = (dbRow.phones as string[]) ?? [];
      const emails = (dbRow.emails as string[]) ?? [];
      return (s.phones as string[]).every((p) => phones.includes(p)) && (s.emails as string[]).every((e) => emails.includes(e)) && dbRow.deleted === false;
    }
    case 'ownership': {
      const t = n.target;
      if (t === 'unassigned') return dbRow.state === 'unassigned';
      if ('userId' in t) return dbRow.state === 'owned' && dbRow.ownerUserId === t.userId;
      return dbRow.state === 'in_pond' && dbRow.pondId === t.pondId;
    }
    case 'notes':
      return dbRow.body === s.body;
    case 'messages':
      return dbRow.body === s.body && dbRow.direction === s.direction && dbRow.occurredAt === s.occurredAt;
    case 'call_recordings':
      return dbRow.startedAt === s.startedAt && dbRow.durationS === s.durationS && dbRow.direction === s.direction;
    case 'consent': {
      const ev = new Set(dbRow.events as string[]);
      return [...(s.grants as string[]), ...(s.revokes as string[])].every((x) => ev.has(x)) && dbRow.doNotContact === s.doNotContact;
    }
  }
}

async function verificationIn(tx: Tx, stage: brepo.StageRow): Promise<VerificationView & { documentedCounts: DocumentedOutcomes }> {
  const approved = stage.expected_counts as unknown as Counts;
  const r = await rrepo.recount(tx, stage.id);
  // owner decision B4 (E230): planned assignments brought in unassigned for a documented reason count as not imported;
  // batch 6 review F3: also those whose person left the import's creation state, and those kept as a person set them
  const documentedCounts: DocumentedOutcomes = { unassigned: r.unassigned, kept: r.kept };
  const expected = expectedAfterCommit(approved, documentedCounts);
  const db: Counts = { source: r.source, imported: r.imported, needs_review: r.needs_review, rejected: r.rejected, duplicate: r.duplicate };
  const keys = ['source', 'imported', 'needs_review', 'rejected', 'duplicate'] as const;
  const diffs = keys.filter((k) => expected[k] !== db[k]).map((k) => ({ key: k, source: expected[k], db: db[k] }));
  const reconciles = (c: Counts) => c.source === c.imported + c.needs_review + c.rejected + c.duplicate;
  const refs = await rrepo.importedRefs(tx, stage.id);
  const sampleRefs = spotCheckSample(refs, stage.id);
  const recs = await rrepo.getRecordsByRefs(tx, stage.id, sampleRefs);
  const byRef = new Map(recs.map((x) => [x.source_ref, x]));
  const sample: SideBySide[] = [];
  for (const ref of sampleRefs) {
    const rec = byRef.get(ref);
    if (!rec) continue;
    const dbRow = await vrepo.dbSide(tx, rec);
    sample.push({ sourceRef: ref, recordId: rec.id, source: sourceSide(rec.normalized as NormalizedRecord | null), imported: dbRow, same: same(rec.normalized as NormalizedRecord | null, dbRow) });
  }
  return { expected, approved, documented: documentedView(documentedCounts, { person: r.unassignedPerson }), documentedCounts, db, matches: diffs.length === 0 && reconciles(expected) && reconciles(db), diffs, sample };
}

/** GET …/verification: the recount and the 20 side-by-side spot checks (deterministic per stage). */
export async function verificationView(deps: ImportDeps, actor: UserActor, batchId: string, category: Category): Promise<VerificationView> {
  return withTenantTx(
    actor,
    async (tx) => {
      const { stage } = await loadBatchAndStage(tx, batchId, category);
      if (!['committed', 'verified'].includes(stage.status)) throw conflict(stage.status);
      const { documentedCounts, ...view } = await verificationIn(tx, stage);
      void documentedCounts;
      return view;
    },
    { db: deps.db },
  );
}

/** POST …/verify: R-IMPORT-5. On the last stage, schedules the FUB key purge (R-IMPORT-11). */
export async function verifyStage(deps: ImportDeps, actor: UserActor, batchId: string, category: Category, spotChecks: readonly { sourceRef: string; matches: boolean }[]): Promise<void> {
  await withTenantTx(
    actor,
    async (tx, now) => {
      const { batch, stage, stages } = await loadBatchAndStage(tx, batchId, category, { lock: true });
      if (stage.status !== 'committed') throw conflict(stage.status);
      const v = await verificationIn(tx, stage);
      const res = buildVerification({ expected: v.approved, documented: v.documentedCounts, db: v.db, sample: v.sample.map((s) => s.sourceRef), spotChecks, verifierUserId: actor.userId, at: now });
      if (!res.ok) {
        if (res.code === 'RECOUNT_MISMATCH') throw new AppError('RECOUNT_MISMATCH', { diffs: res.diffs ?? [] });
        if (res.code === 'SPOT_CHECKS_INCOMPLETE') throw new AppError('SPOT_CHECKS_INCOMPLETE', { sourceRefs: (res.sourceRefs ?? []).slice(0, 50) });
        throw new AppError('SPOT_CHECK_FAILED', { sourceRefs: (res.sourceRefs ?? []).slice(0, 50) });
      }
      if (!(await brepo.verifyStage(tx, stage.id, res.verification))) throw conflict('changed');
      await audit(tx, actor, { action: 'import.verified', entity: { type: 'import_stage', id: stage.id }, reason: `${category.toUpperCase()}_VERIFIED` });
      await settleIfLast(tx, batch, stages.map((s) => (s.id === stage.id ? 'verified' : s.status)));
    },
    { db: deps.db },
  );
}

export type { Channel };
