// Follow Up Boss deal stages (B7 amended 2026-11-21). The map lives on the batch
// (`options.dealStageMap`): each stage name the import saw, the Realty OS stage it lands as, or
// `ignore` (those deals are left out). A name in neither the map nor the built-in words is held
// (`STAGE_UNMAPPED`) and is not guessed.
//
//   GET /imports/:id/deal-stages   every stage name in the snapshot, with how many deals, the
//                                  built-in suggestion, the saved choice, and how many deals are
//                                  waiting on STAGE_UNMAPPED
//   PUT /imports/:id/deal-stages   saves the map and re-resolves the deals that are waiting (and
//                                  deals an earlier save left out). A deal already imported is not
//                                  written again (external_refs). The change is audited.
//
// Owner/Admin only, the same `import.run` re-authentication as the rest of the import.
import type { DealStage, DealStageChoice, Issue, NormalizedDeal } from '@realty/core/import';
import { dealStageChoice } from '@realty/core/import';
import type { Instant, UserActor } from '@realty/core/foundation';
import { toIso } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit, redactDiff } from '../audit.js';
import { AppError } from '../errors.js';
import * as brepo from './repos/batches.js';
import * as rrepo from './repos/records.js';
import * as w from './repos/writes.js';
import { stageSource } from './stages.js';
import { SOURCE_SYSTEM, type ImportDeps } from './types.js';

const DEAL_STAGES: readonly DealStage[] = ['prospect', 'agreement_signed', 'active', 'under_contract', 'closed', 'lost'];

export interface DealStageRow {
  label: string;
  deals: number;
  /** The built-in word match, when there is one. Absent from the saved map. */
  suggested: DealStage | null;
  /** The saved choice. Null means "use the built-in match", which may itself be none. */
  choice: DealStageChoice | null;
}

export interface DealStagesView {
  stages: DealStageRow[];
  unmappedDeals: number;
  dealStageMap: Record<string, DealStageChoice>;
  /** Deals this save wrote. Zero on a read, and on a save that changed nothing. */
  importedNow: number;
  /** Deals this save left out. */
  ignoredNow: number;
  /** Deals that will be imported the next time the deals step is imported. Zero once that step has already been imported. */
  plannedNow: number;
  /** The deals step had been approved, and this save changed it, so it has to be approved again. */
  approvalCleared: boolean;
}

function savedMap(b: brepo.BatchRow): Record<string, DealStageChoice> {
  const out: Record<string, DealStageChoice> = {};
  for (const [k, v] of Object.entries(b.options.dealStageMap ?? {})) {
    if (v === 'ignore' || (DEAL_STAGES as readonly string[]).includes(v)) out[k] = v;
  }
  return out;
}

function asInstant(v: unknown, fallback: Instant): Instant {
  return typeof v === 'number' && Number.isFinite(v) ? (v as Instant) : fallback;
}

function asInstantOrNull(v: unknown): Instant | null {
  return typeof v === 'number' && Number.isFinite(v) ? (v as Instant) : null;
}

/** Drop the stage issues this screen owns, and keep everything else the dry run recorded. */
function withoutStageChoice(issues: readonly Issue[]): Issue[] {
  return issues.filter((i) => i.code !== 'STAGE_UNMAPPED' && i.code !== 'STAGE_IGNORED');
}

function hasReview(issues: readonly Issue[]): boolean {
  return issues.some((i) => i.severity === 'review' || (i.severity === 'error' && i.field !== undefined));
}

async function liveContactId(tx: Tx, system: 'fub' | 'csv', personRef: string): Promise<{ id: string; seq: number; ownerUserId: string | null } | null> {
  let cur = await w.externalRef(tx, system, 'contact', personRef);
  if (cur === null) return null;
  for (let i = 0; i < 8; i++) {
    const c = await w.liveContact(tx, cur);
    if (!c) return null;
    if (c.merged_into_contact_id) {
      cur = c.merged_into_contact_id;
      continue;
    }
    if (c.deleted_at !== null || c.closed_reason === 'deleted') return null;
    const owner = await sql<{ owner_user_id: string | null }>`SELECT owner_user_id FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${cur}`.execute(tx);
    return { id: cur, seq: Number(c.ownership_seq), ownerUserId: owner.rows[0]?.owner_user_id ?? null };
  }
  return null;
}

/**
 * The dates a closed or lost stage needs, filled from what the snapshot already carried.
 * The first mapping left them empty because the stage was unknown.
 */
function placeStage(n: NormalizedDeal, stage: DealStage, now: Instant): NormalizedDeal {
  const entered = asInstant(n.stageEnteredAt, now);
  const acceptance = asInstantOrNull(n.agreementSignedAt);
  const next: NormalizedDeal = { ...n, stage, stageEnteredAt: entered };
  if ((stage === 'under_contract' || stage === 'closed') && next.underContractAt === null) next.underContractAt = acceptance;
  if (stage === 'closed') next.closedAt = asInstantOrNull(n.closedAt) ?? entered;
  else next.closedAt = null;
  if (stage === 'lost') next.lostReason = n.lostReason && n.lostReason !== '' ? n.lostReason : 'Imported from Follow Up Boss';
  else next.lostReason = null;
  return next;
}

async function insertDeal(
  deps: ImportDeps,
  tx: Tx,
  actor: UserActor,
  batch: brepo.BatchRow,
  n: NormalizedDeal,
  contact: { id: string; seq: number },
  ownerUserId: string,
  now: Instant,
): Promise<string> {
  const id = deps.ids.next<'DealId'>();
  const entered = asInstant(n.stageEnteredAt, now);
  await w.insertDeal(tx, {
    id,
    name: n.name,
    side: n.side as string,
    stage: n.stage as string,
    stageEnteredAt: toIso(entered),
    primaryContactId: contact.id,
    ownerUserId,
    priceCents: n.priceCents,
    expectedCloseDate: n.expectedCloseDate,
    agreementSignedAt: asInstantOrNull(n.agreementSignedAt) !== null ? toIso(asInstantOrNull(n.agreementSignedAt) as Instant) : null,
    underContractAt: asInstantOrNull(n.underContractAt) !== null ? toIso(asInstantOrNull(n.underContractAt) as Instant) : null,
    closedAt: asInstantOrNull(n.closedAt) !== null ? toIso(asInstantOrNull(n.closedAt) as Instant) : null,
    lostReason: n.lostReason,
    createdByUserId: actor.userId,
  });
  const linked = new Set<string>([contact.id]);
  const system = SOURCE_SYSTEM[batch.source];
  const primary = n.people.find((p) => p.personRef === n.primaryPersonRef) ?? n.people[0];
  if (primary) await w.insertDealContact(tx, id, contact.id, primary.role);
  for (const p of n.people) {
    if (p.personRef === n.primaryPersonRef) continue;
    const other = await liveContactId(tx, system, p.personRef);
    if (other === null || linked.has(other.id)) continue;
    linked.add(other.id);
    await w.insertDealContact(tx, id, other.id, p.role);
  }
  const members = await w.memberIds(tx);
  for (const uid of n.memberUserIds) {
    if (members.has(uid) && uid !== ownerUserId) await w.insertDealMember(tx, id, uid);
  }
  for (const date of n.dates) {
    await w.insertDealDate(tx, { id: deps.ids.next<'DealId'>(), dealId: id, kind: date.kind, label: date.label, dueOn: date.dueOn });
  }
  const fin = n.financials;
  if (fin && fin.grossCommissionCents !== null) {
    await w.insertDealFinancials(tx, {
      dealId: id,
      grossCents: fin.grossCommissionCents,
      rateBps: fin.commissionRateBps,
      teamBps: fin.teamSplitBps,
      agentBps: fin.agentSplitBps,
      updatedBy: actor.userId,
    });
  }
  await w.insertExternalRef(tx, { system, entityType: 'deal', externalId: n.externalId, entityId: id, batchId: batch.id });
  return id;
}

async function refreshCounts(tx: Tx, stage: brepo.StageRow): Promise<void> {
  const committed = stage.status === 'committed' || stage.status === 'verified';
  if (committed) {
    await sql`UPDATE import_stages SET
                count_imported = (SELECT count(*)::int FROM import_records WHERE tenant_id = app.tenant_id() AND stage_id = ${stage.id} AND outcome = 'imported'),
                count_needs_review = (SELECT count(*)::int FROM import_records WHERE tenant_id = app.tenant_id() AND stage_id = ${stage.id} AND outcome = 'needs_review'),
                count_rejected = (SELECT count(*)::int FROM import_records WHERE tenant_id = app.tenant_id() AND stage_id = ${stage.id} AND outcome = 'rejected'),
                count_duplicate = (SELECT count(*)::int FROM import_records WHERE tenant_id = app.tenant_id() AND stage_id = ${stage.id} AND outcome = 'duplicate')
               WHERE tenant_id = app.tenant_id() AND id = ${stage.id}`.execute(tx);
    return;
  }
  if (stage.status === 'dry_run_ready' || stage.status === 'approved') {
    await sql`UPDATE import_stages SET
                count_will_import = (SELECT count(*)::int FROM import_records WHERE tenant_id = app.tenant_id() AND stage_id = ${stage.id} AND dry_run_outcome = 'will_import'),
                count_needs_review = (SELECT count(*)::int FROM import_records WHERE tenant_id = app.tenant_id() AND stage_id = ${stage.id} AND dry_run_outcome = 'needs_review'),
                count_rejected = (SELECT count(*)::int FROM import_records WHERE tenant_id = app.tenant_id() AND stage_id = ${stage.id} AND dry_run_outcome = 'rejected'),
                count_duplicate = (SELECT count(*)::int FROM import_records WHERE tenant_id = app.tenant_id() AND stage_id = ${stage.id} AND dry_run_outcome = 'duplicate')
               WHERE tenant_id = app.tenant_id() AND id = ${stage.id}`.execute(tx);
    if (stage.status === 'approved') await brepo.clearApproval(tx, stage.id);
  }
}

async function viewIn(deps: ImportDeps, tx: Tx, actor: UserActor, b: brepo.BatchRow): Promise<DealStagesView> {
  const map = savedMap(b);
  const stage = (await brepo.getStages(tx, b.id)).find((s) => s.category === 'deals');
  const unmappedDeals = stage ? await rrepo.unmappedDealCount(tx, stage.id) : 0;
  if (!b.source_snapshot_sha256 || b.source === 'csv') return { stages: [], unmappedDeals, dealStageMap: map, importedNow: 0, ignoredNow: 0, plannedNow: 0, approvalCleared: false };
  const src = await stageSource(deps, tx, actor.tenantId, b, 'deals');
  const counts = new Map<string, number>();
  for (const o of src.outcomes) {
    const rec = o.record;
    if (!rec || rec.category !== 'deals') continue;
    const label = rec.stageLabel?.trim() ?? '';
    if (label === '') continue;
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const stages: DealStageRow[] = [...counts.entries()]
    .map(([label, deals]) => ({ label, deals, suggested: dealStageChoice(label, {}).stage, choice: Object.hasOwn(map, label) ? (map[label] ?? null) : null }))
    .sort((a, b) => b.deals - a.deals || a.label.localeCompare(b.label));
  return { stages, unmappedDeals, dealStageMap: map, importedNow: 0, ignoredNow: 0, plannedNow: 0, approvalCleared: false };
}

function canon(m: Record<string, DealStageChoice>): string {
  return JSON.stringify(Object.fromEntries(Object.entries(m).sort(([a], [b]) => a.localeCompare(b))));
}

export async function getDealStages(deps: ImportDeps, actor: UserActor, batchId: string): Promise<DealStagesView> {
  return withTenantTx(
    actor,
    async (tx) => {
      const b = await brepo.getBatch(tx, batchId);
      if (!b) throw new AppError('NOT_FOUND');
      return viewIn(deps, tx, actor, b);
    },
    { db: deps.db },
  );
}

export async function setDealStages(deps: ImportDeps, actor: UserActor, batchId: string, input: Record<string, DealStageChoice>): Promise<DealStagesView> {
  return withTenantTx(
    actor,
    async (tx, now) => {
      const b = await brepo.getBatch(tx, batchId, { forUpdate: true });
      if (!b) throw new AppError('NOT_FOUND');
      if (['abandoned', 'reverting', 'reverted'].includes(b.status)) throw new AppError('IMPORT_STATE_CONFLICT', { status: b.status });
      const stages = await brepo.lockStages(tx, batchId);
      const stage = stages.find((s) => s.category === 'deals');
      if (stage?.status === 'committing' || stage?.status === 'reverting') throw new AppError('IMPORT_STATE_CONFLICT', { status: stage.status });
      const before = savedMap(b);
      const next: Record<string, DealStageChoice> = {};
      for (const [k, v] of Object.entries(input)) {
        const label = k.trim();
        if (label === '') continue;
        if (v === 'ignore' || (DEAL_STAGES as readonly string[]).includes(v)) next[label] = v;
      }
      const nb: brepo.BatchRow = { ...b, options: { ...b.options, dealStageMap: next } };
      await brepo.setBatchOptions(tx, batchId, nb.options);

      let importedNow = 0;
      let ignoredNow = 0;
      let plannedNow = 0;
      let changed = 0;
      const unmappedBefore = stage ? await rrepo.unmappedDealCount(tx, stage.id) : 0;
      const writable = stage && ['dry_run_ready', 'approved', 'committed', 'verified', 'failed'].includes(stage.status);
      if (stage && writable) {
        const committed = stage.status === 'committed' || stage.status === 'verified';
        const system = SOURCE_SYSTEM[b.source];
        const members = await w.memberIds(tx);
        const held = await rrepo.dealsAwaitingStage(tx, stage.id);
        for (const rec of held) {
          const raw = rec.normalized as NormalizedDeal | null;
          if (!raw || raw.category !== 'deals') continue;
          const choice = dealStageChoice(raw.stageLabel, next);
          if (!choice.ignored && choice.stage === null) continue;
          const baseIssues = withoutStageChoice(rec.issues as Issue[]);
          if (choice.ignored) {
            if (rec.outcome === 'rejected' && (rec.issues as Issue[]).some((i) => i.code === 'STAGE_IGNORED')) continue;
            const issues: Issue[] = [...baseIssues, { code: 'STAGE_IGNORED', severity: 'error' }];
            const normalized: NormalizedDeal = { ...raw, stage: null };
            await rrepo.writeDealResolution(tx, rec.id, {
              normalized,
              issues,
              outcome: 'rejected',
              dryRunOutcome: committed ? rec.dry_run_outcome : 'rejected',
              plan: null,
              targetTable: null,
              targetId: null,
              created: [],
            });
            ignoredNow += 1;
            changed += 1;
            continue;
          }
          const normalized = placeStage(raw, choice.stage as DealStage, now);
          const issues = baseIssues;
          const blocked = hasReview(issues) || normalized.side === null || normalized.primaryPersonRef === null;
          if (blocked || !committed) {
            const owner = normalized.ownerUserId;
            const canPlan = !blocked && owner !== null && normalized.primaryPersonRef !== null;
            await rrepo.writeDealResolution(tx, rec.id, {
              normalized,
              issues,
              outcome: canPlan ? 'will_import' : 'needs_review',
              dryRunOutcome: committed ? rec.dry_run_outcome : canPlan ? 'will_import' : 'needs_review',
              plan: canPlan ? { kind: 'insert_deal', contact: { pendingPersonRef: normalized.primaryPersonRef }, ownerUserId: owner } : null,
              targetTable: null,
              targetId: null,
              created: [],
            });
            if (canPlan) plannedNow += 1;
            changed += 1;
            continue;
          }
          const contact = await liveContactId(tx, system, normalized.primaryPersonRef as string);
          const mappedOwner = normalized.ownerUserId !== null && members.has(normalized.ownerUserId) ? normalized.ownerUserId : null;
          const contactOwner = contact?.ownerUserId && members.has(contact.ownerUserId) ? contact.ownerUserId : null;
          const owner = mappedOwner ?? contactOwner;
          if (contact === null || owner === null) {
            const extra: Issue[] = [...issues];
            if (contact === null && !extra.some((i) => i.code === 'PARENT_NOT_FOUND')) extra.push({ code: 'PARENT_NOT_FOUND', severity: 'review' });
            if (owner === null && !extra.some((i) => i.code === 'ASSIGNEE_UNMAPPED')) extra.push({ code: 'ASSIGNEE_UNMAPPED', severity: 'review', field: 'users' });
            await rrepo.writeDealResolution(tx, rec.id, {
              normalized,
              issues: extra,
              outcome: 'needs_review',
              dryRunOutcome: rec.dry_run_outcome,
              plan: null,
              targetTable: null,
              targetId: null,
              created: [],
            });
            changed += 1;
            continue;
          }
          const existing = await w.liveExternalRef(tx, system, 'deal', normalized.externalId);
          if (existing) {
            await rrepo.writeDealResolution(tx, rec.id, {
              normalized,
              issues,
              outcome: 'duplicate',
              dryRunOutcome: rec.dry_run_outcome,
              plan: { kind: 'skip', existingId: existing },
              targetTable: 'deals',
              targetId: existing,
              created: [],
            });
            changed += 1;
            continue;
          }
          const id = await insertDeal(deps, tx, actor, nb, normalized, contact, owner, now);
          await rrepo.writeDealResolution(tx, rec.id, {
            normalized,
            issues,
            outcome: 'imported',
            dryRunOutcome: rec.dry_run_outcome,
            plan: { kind: 'insert_deal', contact: { pendingPersonRef: normalized.primaryPersonRef }, ownerUserId: owner },
            targetTable: 'deals',
            targetId: id,
            created: [{ table: 'deals', id, contactId: contact.id, seq: contact.seq }],
          });
          importedNow += 1;
          changed += 1;
        }
        if (changed > 0) await refreshCounts(tx, stage);
      }

      const after = await viewIn(deps, tx, actor, nb);
      const approvalCleared = stage?.status === 'approved' && changed > 0;
      await audit(tx, actor, {
        action: 'settings.changed',
        entity: { type: 'import_batch', id: batchId },
        changes: redactDiff(
          { deal_stage_map: canon(before), unmapped_count: unmappedBefore, imported_count: 0, ignored_count: 0 },
          { deal_stage_map: canon(next), unmapped_count: after.unmappedDeals, imported_count: importedNow, ignored_count: ignoredNow },
        ),
        reason: 'DEAL_STAGE_MAP',
      });
      return { ...after, importedNow, ignoredNow, plannedNow, approvalCleared };
    },
    { db: deps.db },
  );
}
