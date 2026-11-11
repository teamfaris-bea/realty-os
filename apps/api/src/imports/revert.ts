// Revert, per batch or per stage in reverse order (BUILD_PLAN module 16; R-IMPORT-10, R-CONSENT-3, E43).
//
//   requestRevert (Owner/Admin 🔒, audited): the stage(s) go `reverting`; a later stage that is still
//                 committed blocks a per-stage revert (IMPORT_REVERT_ORDER).
//   runRevert     (job imports.revert, system actor 'worker'): for each reverting stage, latest first,
//                 in chunks of ≤ 1,000 records:
//                   - core planRevert decides per row: untouched rows are deleted (contacts: soft
//                     delete through the ownership engine; history and points through the definer
//                     app.import_revert_delete, which only deletes rows this stage wrote), or
//                     compensated (append-only consent: `import_revert` voids imported grants);
//                   - touched rows (edited, messaged, reassigned since import) and rows something now
//                     references are listed for a human decision, never deleted;
//                   - imported revocations and DNC flags stay (R-CONSENT-3); ownership ledger rows are
//                     history, and an untouched import assignment is compensated: an `import_unassign`
//                     (import actor, fenced on the import's own seq) puts the lead back to unassigned.
//                 The stage's revert_report says what happened, in ids and codes.
import type { Category, ImportedRow } from '@realty/core/import';
import { planRevert, revertOrder } from '@realty/core/import';
import type { ContactId, UserActor } from '@realty/core/foundation';
import { type Tx, applyOwnershipCommandInTx, derivedCommandId, enqueueJob, recordConsentEvent, setOwnershipCommand, withTenantTx } from '@realty/db';
import { audit } from '../audit.js';
import { AppError } from '../errors.js';
import { systemActor } from '../worker/systemActor.js';
import * as brepo from './repos/batches.js';
import * as prepo from './repos/parity.js';
import * as rrepo from './repos/records.js';
import * as rv from './repos/revert.js';
import { FUB_KEY_PURGE_DAYS, type ImportDeps } from './types.js';

export const REVERT_JOB = { kind: 'imports.revert' as const, queue: 'bulk' as const };
const REVERTIBLE: readonly brepo.StageStatus[] = ['committed', 'verified'];
const CHUNK = 1000;
const LIST_CAP = 500;

export interface RevertReport {
  afterId: string | null;
  removed: number;
  compensated: number;
  /** rows that stay by rule (revocations, DNC, ownership history) */
  kept: number;
  /** records with rows left for a human decision */
  needsDecision: number;
  reasons: Record<string, number>;
  /** why rows stayed by rule (REVOCATION_KEPT, DNC_KEPT, LEDGER_APPEND_ONLY) */
  keptReasons: Record<string, number>;
  /** the first records left for a human (ids + reason codes; the review list shows them all) */
  manual: { recordId: string; sourceRef: string; reason: string }[];
  /** PARITY 65: what the contacts revert removed of the parity rows (R-PAR-46 "removes exactly the batch's rows") */
  parity?: { tagLinks: number; values: number; tags: number; fields: number };
  /** `removed` by table (people, phone numbers and emails, notes ...), so the report can say what it removed */
  removedByTable?: Record<string, number>;
  done?: boolean;
}

/** POST /imports/:id/revert { category? } */
export async function requestRevert(deps: ImportDeps, actor: UserActor, batchId: string, category: Category | null): Promise<string[]> {
  return withTenantTx(
    actor,
    async (tx) => {
      const b = await brepo.getBatch(tx, batchId, { forUpdate: true });
      if (!b) throw new AppError('NOT_FOUND');
      const stages = await brepo.lockStages(tx, batchId);
      if (stages.some((s) => ['committing', 'reverting', 'dry_run_running'].includes(s.status))) throw new AppError('IMPORT_STATE_CONFLICT', { status: 'stage_busy' });
      let targets: brepo.StageRow[];
      if (category === null) {
        targets = stages.filter((s) => REVERTIBLE.includes(s.status));
      } else {
        const s = stages.find((x) => x.category === category);
        if (!s) throw new AppError('NOT_FOUND');
        if (!REVERTIBLE.includes(s.status)) throw new AppError('IMPORT_STATE_CONFLICT', { status: s.status });
        if (stages.some((x) => x.seq > s.seq && REVERTIBLE.includes(x.status))) throw new AppError('IMPORT_REVERT_ORDER');
        targets = [s];
      }
      if (targets.length === 0) throw new AppError('IMPORT_STATE_CONFLICT', { status: 'nothing_committed' });
      for (const s of targets) {
        if (!(await brepo.transitionStage(tx, s.id, REVERTIBLE, 'reverting'))) throw new AppError('IMPORT_STATE_CONFLICT', { status: 'changed' });
        await audit(tx, actor, { action: 'import.reverted', entity: { type: 'import_stage', id: s.id }, reason: `${s.category.toUpperCase()}_REVERT_STARTED` });
      }
      await brepo.setBatchStatus(tx, batchId, 'reverting');
      await enqueueJob(tx, { queue: REVERT_JOB.queue, kind: REVERT_JOB.kind, payload: { batchId }, dedupeKey: `imports.revert:${batchId}` });
      return targets.map((s) => s.category);
    },
    { db: deps.db },
  );
}

function importedRowsOf(rec: rrepo.RecordRow, consent: Map<string, rv.ImportedConsentRow>): ImportedRow[] {
  const out: ImportedRow[] = [];
  for (const c of rec.created_rows) {
    switch (c.table) {
      case 'contacts':
        out.push({ table: 'contacts', id: c.id, action: c.action ?? 'attach' });
        break;
      case 'contact_points':
      case 'contact_addresses':
      case 'lead_ownership_events':
      case 'notes':
      case 'messages':
      case 'calls':
      case 'recordings':
        out.push({ table: c.table, id: c.id, contactId: c.contactId ?? '' });
        break;
      case 'consent_events': {
        const e = consent.get(c.id);
        if (e) {
          out.push({
            table: 'consent_events',
            id: c.id,
            event: {
              id: e.id,
              // a grant already voided by an earlier revert is not voided twice
              eventType: e.voided ? 'import_revert' : e.event_type,
              imported: e.imported,
              channel: e.channel,
              purpose: e.purpose,
              addressKind: e.address_kind,
              addressHmac: e.hmac,
              addressHint: e.address_hint,
              source: e.source as never,
              contactId: e.contact_id,
              importRecordId: e.import_record_id,
            },
          });
        }
        break;
      }
      case 'suppressions':
        out.push({ table: 'suppressions', id: c.id });
        break;
      default:
        break;
    }
  }
  return out;
}

const DELETABLE = ['notes', 'messages', 'calls', 'contact_points', 'contact_addresses'] as const;

/**
 * The import's baseline for every contact these records touch: from the contacts stage's own
 * created_rows (what the import left), or, for history attached to a contact, that contact's baseline.
 */
async function contactBaselines(tx: Tx, batchId: string, recs: readonly rrepo.RecordRow[]): Promise<Map<string, rv.ContactBaseline>> {
  const out = new Map<string, rv.ContactBaseline>();
  const ids = new Set<string>();
  for (const r of recs) for (const c of r.created_rows) ids.add(c.table === 'contacts' ? c.id : (c.contactId ?? ''));
  ids.delete('');
  for (const r of await rrepo.contactsStageRecordsFor(tx, batchId, [...ids])) {
    for (const c of r.created_rows) if (c.table === 'contacts' && ids.has(c.id) && !out.has(c.id)) out.set(c.id, { fp: c.fp ?? null, seq: c.seq ?? 1 });
  }
  for (const id of ids) if (!out.has(id)) out.set(id, { fp: null, seq: 1 });
  return out;
}

/** One chunk of one stage. Returns false when the stage is finished. */
async function revertChunk(deps: ImportDeps, tenantId: string, stageId: string): Promise<boolean> {
  const actor = systemActor(tenantId, 'worker');
  return withTenantTx(
    actor,
    async (tx, now) => {
      const stage = await brepo.getStageById(tx, stageId, { forUpdate: true });
      if (!stage || stage.status !== 'reverting') return false;
      const prev = (stage.revert_report ?? {}) as Partial<RevertReport>;
      const report: RevertReport = {
        afterId: prev.afterId ?? null,
        removed: prev.removed ?? 0,
        compensated: prev.compensated ?? 0,
        kept: prev.kept ?? 0,
        needsDecision: prev.needsDecision ?? 0,
        reasons: { ...(prev.reasons ?? {}) },
        keptReasons: { ...(prev.keptReasons ?? {}) },
        manual: [...(prev.manual ?? [])],
      };
      if (prev.parity) report.parity = { ...prev.parity };
      report.removedByTable = { ...(prev.removedByTable ?? {}) };
      const recs = await rrepo.importedRecordsAfter(tx, stage.id, report.afterId, CHUNK);
      if (recs.length === 0) {
        // PARITY 65: catalog tags and fields this batch created that nobody uses any more go too
        if (stage.category === 'contacts') {
          const batch = await brepo.getBatch(tx, stage.batch_id);
          const p = report.parity ?? { tagLinks: 0, values: 0, tags: 0, fields: 0 };
          p.tags += await prepo.removeUnusedCreatedTags(tx, stage.batch_id);
          p.fields += await prepo.archiveUnusedCreatedFields(tx, batch?.options.parityCreated?.fieldIds ?? []);
          report.parity = p;
        }
        await brepo.setRevertReport(tx, stage.id, { ...report, done: true });
        return false;
      }
      const consentIds = recs.flatMap((r) => r.created_rows.filter((c) => c.table === 'consent_events').map((c) => c.id));
      const consent = new Map((await rv.consentEventsByIds(tx, consentIds)).map((e) => [e.id, e]));
      const rows = recs.flatMap((r) => importedRowsOf(r, consent));
      // touched: contacts (ledger / activity / edits) and history rows edited after the commit
      const baseline = await contactBaselines(tx, stage.batch_id, recs);
      const touched = await rv.touchedContacts(tx, stage.batch_id, baseline, stage.approved_at ?? stage.committed_at ?? new Date(0));
      const since = stage.committed_at ?? new Date(0);
      // history rows edited after the commit (points/addresses follow their contact: system updates such
      // as a bounce marking a point are not a human touch)
      for (const t of ['notes', 'messages', 'calls'] as const) {
        const ids = rows.filter((x) => x.table === t).map((x) => x.id);
        for (const id of await rv.touchedRows(tx, t, ids, since)) touched.add(id);
      }
      const plan = planRevert(stage.category, rows, touched, { ids: deps.ids, now });
      // PARITY 65 (R-PAR-46): the batch's tag links and imported values leave every contact nobody touched
      // since (a touched contact keeps them with the rest of its import, for a human decision); a value
      // someone edited carries their provenance, so it never matches the batch
      if (stage.category === 'contacts') {
        const untouched = [...new Set(rows.filter((x) => x.table === 'contacts' && !touched.has(x.id)).map((x) => x.id))];
        const r = await prepo.removeBatchRows(tx, stage.batch_id, untouched);
        const p = report.parity ?? { tagLinks: 0, values: 0, tags: 0, fields: 0 };
        p.tagLinks += r.tagLinks;
        p.values += r.values;
        report.parity = p;
      }
      const deleteSet = new Set(plan.delete);
      const removed = new Set<string>();
      // history and points through the definer (only rows this stage wrote)
      for (const t of DELETABLE) {
        const ids = rows.filter((x) => x.table === t && deleteSet.has(x.id)).map((x) => x.id);
        for (const id of await rv.revertDelete(tx, stage.id, t, ids)) removed.add(id);
      }
      // contacts the import created and nobody touched: soft delete through the ownership engine
      for (const x of rows) {
        if (x.table !== 'contacts' || !deleteSet.has(x.id)) continue;
        const r = await applyOwnershipCommandInTx(tx, actor, x.id as ContactId, { kind: 'soft_delete' }, { commandId: derivedCommandId('import.revert', stage.id, x.id), ids: deps.ids });
        await setOwnershipCommand(tx, null);
        if (r.outcome.ok) removed.add(x.id);
      }
      // consent: void imported grants (append-only ledger: a compensating import_revert)
      for (const spec of plan.compensate) {
        await recordConsentEvent(tx, spec);
        if (spec.revertsEventId) removed.add(spec.revertsEventId);
      }
      report.compensated += plan.compensate.length;
      // ownership (append-only ledger): an untouched import assignment goes back to where the contacts stage
      // left the lead (unassigned, not routed), fenced on the import's own event; a lead whose ledger moved
      // on since is a human's decision (ownership-1, R-IMPORT-10)
      const seqs = await rv.ownershipEventSeqs(tx, plan.unassign.map((u) => u.eventId));
      const importer = systemActor(tenantId, 'import');
      for (const u of plan.unassign) {
        const importSeq = seqs.get(u.eventId);
        if (importSeq === undefined) continue;
        const r = await applyOwnershipCommandInTx(tx, importer, u.contactId as ContactId, { kind: 'import_unassign', importSeq }, { commandId: derivedCommandId('import.revert.unassign', stage.id, u.eventId), ids: deps.ids });
        await setOwnershipCommand(tx, null);
        if (r.outcome.ok) {
          removed.add(u.eventId);
          report.compensated += 1;
        } else {
          plan.reasons[u.eventId] = 'TOUCHED';
        }
      }
      report.kept += plan.kept.length;
      const keptSet = new Set(plan.kept);
      const revertedRecords: string[] = [];
      for (const r of recs) {
        const mine = importedRowsOf(r, consent);
        // a recording goes with its call (FK cascade)
        if (mine.some((x) => x.table === 'calls' && removed.has(x.id))) for (const x of mine) if (x.table === 'recordings') removed.add(x.id);
        const left = mine.filter((x) => !removed.has(x.id) && !keptSet.has(x.id));
        // a compensated assignment is undone, not removed: the ledger row stays as history
        const gone = mine.filter((x) => removed.has(x.id) && x.table !== 'lead_ownership_events');
        report.removed += gone.length;
        for (const x of gone) report.removedByTable![x.table] = (report.removedByTable![x.table] ?? 0) + 1;
        if (left.length === 0) {
          revertedRecords.push(r.id);
          continue;
        }
        report.needsDecision += 1;
        const reason = left.map((x) => plan.reasons[x.id] ?? (deleteSet.has(x.id) ? 'REFERENCED' : 'TOUCHED'))[0] as string;
        report.reasons[reason] = (report.reasons[reason] ?? 0) + 1;
        if (report.manual.length < LIST_CAP) report.manual.push({ recordId: r.id, sourceRef: r.source_ref, reason });
      }
      for (const k of plan.kept) {
        const why = plan.reasons[k] ?? 'KEPT';
        report.keptReasons[why] = (report.keptReasons[why] ?? 0) + 1;
      }
      await rrepo.markReverted(tx, revertedRecords);
      report.afterId = (recs[recs.length - 1] as rrepo.RecordRow).id;
      await brepo.setRevertReportProgress(tx, stage.id, report);
      return true;
    },
    { db: deps.db, retries: 2 },
  );
}

/** The revert job (imports.revert): every reverting stage of the batch, latest stage first. */
export async function runRevert(deps: ImportDeps, tenantId: string, batchId: string, o: { maxChunks?: number } = {}): Promise<'done' | 'more' | 'skipped'> {
  const actor = systemActor(tenantId, 'worker');
  const stages = await withTenantTx(actor, (tx) => brepo.getStages(tx, batchId), { db: deps.db });
  const reverting = stages.filter((s) => s.status === 'reverting');
  if (reverting.length === 0) return 'skipped';
  const order = revertOrder(reverting.map((s) => s.category));
  let budget = o.maxChunks ?? 20;
  for (const cat of order) {
    const s = reverting.find((x) => x.category === cat) as brepo.StageRow;
    while (await revertChunk(deps, tenantId, s.id)) {
      budget -= 1;
      if (budget <= 0) return 'more';
    }
  }
  await withTenantTx(
    actor,
    async (tx) => {
      const all = await brepo.lockStages(tx, batchId);
      if (all.some((s) => s.status === 'reverting')) return;
      const anyLeft = all.some((s) => ['committed', 'verified'].includes(s.status));
      await brepo.setBatchStatus(tx, batchId, anyLeft ? 'partially_committed' : 'reverted', anyLeft ? {} : { revertedAt: true });
      // a reverted batch can never snapshot or commit again: its FUB key goes too (R-IMPORT-11, ≤ 30 days)
      if (!anyLeft) {
        const b = await brepo.getBatch(tx, batchId);
        if (b?.credential_id) await brepo.schedulePurge(tx, b.credential_id, FUB_KEY_PURGE_DAYS);
      }
    },
    { db: deps.db },
  );
  return 'done';
}
