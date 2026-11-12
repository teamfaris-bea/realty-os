// ads/dispatch.ts: THE path that changes money on Google Ads (module 52; R-ADS-2, R-ADS-3, R-ADS-5, R-ADS-7..10, R-GATE-15;
// D-ADS, D7; E124, E145, E161, E440-E448, E457, E459). The only caller of AdsProvider.applyBudgetChange and pauseCampaign
// (lint realty/no-provider-outbound, ads/architecture.test.ts). Nothing here sends anything to a contact (D1).
//
// Approve (one Owner/Admin tap, D-ADS):
//   TX1  as the person who tapped (FORCE RLS): lock the ad_reallocation; it must be ownerless, contactless and proposed;
//        the pack cleared (a pre-check: the DB gates decide); the connection a live ads_google; the cap version in force
//        the one the proposal used and every changed campaign still eligibility-clean with countedDailyCents equal to its
//        fromDailyCents (otherwise the proposal is superseded in its own transaction: ADS_PROPOSAL_STALE); the tenant-wide
//        total ≤ the ceiling. Then the decision, one planned row per change (one new run) and the audit row. At COMMIT the
//        deferred cap check (0018) may still refuse: nothing is recorded and the person gets the DB's code (409).
//   then, per planned row, OUTSIDE any transaction: the pack re-checked as the system (withdrawn ⇒ failed PACK_WITHDRAWN,
//        no call, E442), the token decrypted in a short system transaction, applyBudgetChange with the planned event's id
//        as idempotency key, waited for at most APPLY_TIMEOUT_MS.
//   TX2  as the system: applied (provider ref) or failed (code) at the planned amount; the budget mirror; the status only
//        for a resume, never to active over a pause recorded since the plan; `executed` once every planned row of the run
//        has an outcome. An unknown outcome writes nothing: the hourly reconcile resolves it by readback (resolveOpenPlans).
// Reject: the person's decision, audited. Resume: one tap creates AND approves a one-change ad_reallocation (kind
//   'resume') in TX1, plans RESUMED, and applies with resume=true.
// pauseForMonthlyCap: the only automatic money action (R-ADS-5): a pause at the monthly cap, recorded as a paused row.
import { type AllocationChange, type Campaign, countedDailyCents, eligibility, tenantDailyTotal } from '@realty/core/ads';
import { type Instant, type TenantId, type UserActor } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit, redactSnapshot } from '../audit.js';
import { AppError, type ErrorCode } from '../errors.js';
import { ProviderError } from '../providers/types.js';
import { systemActor } from '../worker/systemActor.js';
import type { AdsAccount, AdsCampaignReport, AdsChangeResult } from './provider.js';
import * as repo from './repo.js';
import { type AdsDeps, account, asSystem, clockOf, safeCode, withinBound } from './runtime.js';
import { ADS_KIND, APPLY_TIMEOUT_MS, OUTCOME_UNKNOWN_AFTER_MS, STALE_PLANNED_MS, dollars } from './settings.js';

// ---- the stored proposal ---------------------------------------------------------------------------------------------

export interface StoredRow {
  campaignId: string;
  fromDailyCents: number;
  toDailyCents: number;
  changed: boolean;
  reasonCode: string;
}

export interface StoredProposal {
  v: 1;
  kind: 'weekly' | 'resume';
  connectionId: string;
  capVersionId: string;
  capVersionNo: number;
  changes: AllocationChange[];
  rows: StoredRow[];
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const isInt = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x >= 0;

/** The payload of a stored ad_reallocation, or null when it is not a plannable proposal (a hold, a foreign shape). */
export function storedProposal(p: Record<string, unknown>): StoredProposal | null {
  if (p.v !== 1 || 'hold' in p) return null;
  const changes = p.changes;
  const rows = p.rows;
  if (typeof p.connection_id !== 'string' || !UUID.test(p.connection_id) || typeof p.cap_version_id !== 'string' || !UUID.test(p.cap_version_id)) return null;
  if (!Array.isArray(changes) || changes.length === 0 || !Array.isArray(rows)) return null;
  const ch: AllocationChange[] = [];
  for (const c of changes as unknown[]) {
    const o = c as Record<string, unknown>;
    if (!o || typeof o.campaign_id !== 'string' || !UUID.test(o.campaign_id) || !isInt(o.to_daily_cents)) return null;
    ch.push({ campaign_id: o.campaign_id, to_daily_cents: o.to_daily_cents });
  }
  const rs: StoredRow[] = [];
  for (const r of rows as unknown[]) {
    const o = r as Record<string, unknown>;
    if (!o || typeof o.campaignId !== 'string' || !isInt(o.fromDailyCents) || !isInt(o.toDailyCents) || typeof o.reasonCode !== 'string') return null;
    rs.push({ campaignId: o.campaignId, fromDailyCents: o.fromDailyCents, toDailyCents: o.toDailyCents, changed: o.changed === true, reasonCode: safeCode(o.reasonCode, 'APPROVED_SHIFT') });
  }
  for (const c of ch) if (!rs.some((r) => r.campaignId === c.campaign_id && r.toDailyCents === c.to_daily_cents)) return null;
  return {
    v: 1,
    kind: p.kind === 'resume' ? 'resume' : 'weekly',
    connectionId: p.connection_id,
    capVersionId: p.cap_version_id,
    capVersionNo: isInt(p.cap_version_no) ? p.cap_version_no : 0,
    changes: ch,
    rows: rs,
  };
}

// ---- the run's state (what the tap returns) ---------------------------------------------------------------------------

export interface RunRowState {
  campaignId: string;
  fromDailyCents: number;
  toDailyCents: number;
  reasonCode: string;
  outcome: 'pending' | 'applied' | 'failed';
  outcomeCode: string | null;
  providerRef: string | null;
}

export interface RunState {
  actionId: string;
  status: string;
  runId: string | null;
  rows: RunRowState[];
}

async function runState(tx: Tx, actionId: string): Promise<RunState> {
  const a = await repo.reallocation(tx, actionId);
  const ev = await repo.actionEvents(tx, actionId);
  const planned = ev.filter((e) => e.eventKind === 'planned');
  return {
    actionId,
    status: a?.status ?? 'unknown',
    runId: planned[0]?.runId ?? null,
    rows: planned.map((p) => {
      const out = ev.find((e) => e.runId === p.runId && e.campaignId === p.campaignId && (e.eventKind === 'applied' || e.eventKind === 'failed'));
      return {
        campaignId: p.campaignId, fromDailyCents: p.fromDailyCents, toDailyCents: p.toDailyCents, reasonCode: p.reasonCode,
        outcome: out ? (out.eventKind as 'applied' | 'failed') : 'pending', outcomeCode: out ? out.reasonCode : null, providerRef: out?.providerRef ?? null,
      };
    }),
  };
}

// ---- DB refusals → API codes (same code in DB and API) -----------------------------------------------------------------

const DB_CODES: readonly ErrorCode[] = [
  'ADS_NOT_CLEARED', 'ADS_GOOGLE_ONLY', 'ADS_CONNECTION_NOT_LIVE', 'AD_APPROVAL_FROZEN', 'AD_CAP_EXCEEDED', 'AD_CAP_VERSION_STALE', 'AD_SHIFT_NOT_IN_APPROVAL',
  'AD_SHIFT_NOT_APPROVED', 'AD_CREATIVE_NOT_APPROVED', 'AD_BUDGET_THROUGH_LEDGER', 'AD_APPLY_WITHOUT_PLAN',
];

/** Maps a database refusal of an ads write to its API code (null: not an ads refusal). */
export function mapAdsDbError(e: unknown): AppError | null {
  if (e instanceof AppError) return e;
  const pe = (e && typeof e === 'object' ? e : {}) as { message?: string; code?: string; constraint?: string };
  const msg = pe.message ?? '';
  for (const c of DB_CODES) if (msg.startsWith(c)) return new AppError(c);
  if (msg.startsWith('OWNER_ONLY_AD_CAP')) return new AppError('NOT_FOUND');
  if (msg.startsWith('DECISION_ACTOR')) return new AppError('NOT_FOUND');
  if (pe.code === '23505' && pe.constraint === 'ad_allocation_events_approval_once') return new AppError('ACTION_NOT_PENDING', { status: 'approved' });
  return null;
}

async function asPerson<T>(d: AdsDeps, actor: UserActor, fn: (tx: Tx, now: Instant) => Promise<T>): Promise<T> {
  try {
    return await withTenantTx(actor, fn, { db: d.db, retries: 2 });
  } catch (e) {
    const m = mapAdsDbError(e);
    if (m) throw m;
    throw e;
  }
}

// ---- approve / reject ------------------------------------------------------------------------------------------------

type Tx1 = { kind: 'planned'; runId: string } | { kind: 'replay' } | { kind: 'stale'; reason: string };

/** Loads every campaign (core shape) and checks a stored proposal against the live facts. */
async function staleness(tx: Tx, p: StoredProposal, campaigns: readonly repo.CampaignRow[]): Promise<{ reason: string } | null> {
  const cap = await repo.capInForce(tx);
  if (!cap || cap.id !== p.capVersionId) return { reason: 'CAP_VERSION_CHANGED' };
  for (const ch of p.changes) {
    const row = campaigns.find((c) => c.id === ch.campaign_id);
    const stored = p.rows.find((r) => r.campaignId === ch.campaign_id);
    if (!row || !stored || row.connectionId !== p.connectionId) return { reason: 'CAMPAIGN_CHANGED' };
    const core = repo.toCoreCampaign(row);
    const blockers = eligibility(core).blockers.filter((b) => !(p.kind === 'resume' && b === 'PAUSED'));
    if (blockers.length > 0) return { reason: 'CAMPAIGN_NOT_ELIGIBLE' };
    if (countedDailyCents(core) !== stored.fromDailyCents) return { reason: 'PLATFORM_CHANGED' };
  }
  return null;
}

async function liveConnection(tx: Tx, id: string): Promise<repo.AdsConnection | null> {
  const c = (await repo.adsConnections(tx)).find((x) => x.id === id);
  return c && (c.status === 'connected' || c.status === 'degraded') ? c : null;
}

/** One Owner/Admin tap on a proposal: TX1 (decision + planned rows), then the apply of each planned row. */
export async function approveShift(d: AdsDeps, actor: UserActor, actionId: string): Promise<RunState> {
  const r1 = await asPerson<Tx1>(d, actor, async (tx) => {
    const a = await repo.reallocation(tx, actionId, { forUpdate: true });
    if (!a || a.ownerUserId !== null || a.contactId !== null) throw new AppError('NOT_FOUND');
    if (a.status !== 'proposed') {
      const planned = (await repo.actionEvents(tx, a.id)).some((e) => e.eventKind === 'planned');
      // E444: an approval made outside this path (or by anyone, without planned rows) is never planned
      if ((a.status === 'approved' || a.status === 'executed') && !planned) throw new AppError('ADS_APPROVAL_NOT_FROM_ADS');
      // a double tap by the same person returns the run's state; anyone else learns it was handled (E457)
      if ((a.status === 'approved' || a.status === 'executed') && a.decidedByUserId === actor.userId) return { kind: 'replay' };
      throw new AppError('ACTION_NOT_PENDING', { status: a.status });
    }
    const p = storedProposal(a.payload);
    if (!p || a.editedPayload !== null) throw new AppError('ACTION_NOT_PENDING', { status: a.status });
    if (!(await repo.packCleared(tx))) throw new AppError('ADS_NOT_CLEARED');
    const conn = await liveConnection(tx, p.connectionId);
    if (!conn) throw new AppError('ADS_CONNECTION_NOT_LIVE');
    // b11 sends-gates/F2: without a lead source the spend is no longer recorded, so no money moves
    if (conn.leadSourceId === null) throw new AppError('ADS_NO_LEAD_SOURCE');
    const campaigns = await repo.campaignRows(tx);
    const stale = await staleness(tx, p, campaigns);
    if (stale) return { kind: 'stale', reason: stale.reason };
    const cap = (await repo.capInForce(tx))!;
    const core: Campaign[] = campaigns.map(repo.toCoreCampaign);
    if (tenantDailyTotal(core, p.changes) > cap.dailyCeilingCents) throw new AppError('AD_CAP_EXCEEDED');
    await repo.decide(tx, a.id, 'approved', actor.userId);
    const runId = d.ids.next<'AdRunId'>();
    for (const ch of p.changes) {
      const row = p.rows.find((r) => r.campaignId === ch.campaign_id)!;
      await repo.insertEvent(tx, { id: d.ids.next<'AdAllocationEventId'>(), runId, campaignId: ch.campaign_id, kind: 'planned', capVersionId: cap.id, actionId: a.id,
        fromDailyCents: row.fromDailyCents, toDailyCents: ch.to_daily_cents, reasonCode: row.reasonCode, providerRef: null });
    }
    await audit(tx, actor, { action: 'ads.shift_approved', entity: { type: 'assistant_action', id: a.id },
      changes: redactSnapshot({ run_id: runId, cap_version_no: cap.versionNo, change_count: p.changes.length }) });
    return { kind: 'planned', runId };
  });
  if (r1.kind === 'stale') {
    await asPerson(d, actor, (tx) => repo.supersede(tx, actionId));
    throw new AppError('ADS_PROPOSAL_STALE', { reason: r1.reason });
  }
  if (r1.kind === 'planned') await applyRun(d, actor.tenantId, r1.runId, false);
  return asPerson(d, actor, (tx) => runState(tx, actionId));
}

/** The person rejects a proposal (their decision, audited); nothing is planned. */
export async function rejectShift(d: AdsDeps, actor: UserActor, actionId: string): Promise<{ actionId: string; status: string }> {
  return asPerson(d, actor, async (tx) => {
    const a = await repo.reallocation(tx, actionId, { forUpdate: true });
    if (!a || a.ownerUserId !== null || a.contactId !== null) throw new AppError('NOT_FOUND');
    if (a.status !== 'proposed') throw new AppError('ACTION_NOT_PENDING', { status: a.status });
    await repo.decide(tx, a.id, 'rejected', actor.userId);
    await audit(tx, actor, { action: 'ads.shift_rejected', entity: { type: 'assistant_action', id: a.id }, changes: redactSnapshot({ status: 'rejected' }) });
    return { actionId: a.id, status: 'rejected' };
  });
}

// ---- resume (one tap; still the person's approval, D-ADS) ---------------------------------------------------------------

/** One tap: a one-change ad_reallocation (kind 'resume') created AND approved by the person, planned RESUMED, applied. */
export async function resumeCampaign(d: AdsDeps, actor: UserActor, campaignId: string, monthToDateCents: (tx: Tx) => Promise<number>): Promise<RunState> {
  const r1 = await asPerson(d, actor, async (tx) => {
    const all = await repo.campaignRows(tx);
    const row = all.find((c) => c.id === campaignId);
    if (!row) throw new AppError('NOT_FOUND');
    if (!(await repo.packCleared(tx))) throw new AppError('ADS_NOT_CLEARED');
    if (row.connectionKind !== ADS_KIND) throw new AppError('ADS_GOOGLE_ONLY');
    const conn = await liveConnection(tx, row.connectionId);
    if (!conn) throw new AppError('ADS_CONNECTION_NOT_LIVE');
    // b11 sends-gates/F2: the E459 guard reads recorded spend, which stops without a lead source
    if (conn.leadSourceId === null) throw new AppError('ADS_NO_LEAD_SOURCE');
    const cap = await repo.capInForce(tx);
    if (!cap) throw new AppError('ADS_NO_CAP');
    // E459: at or over the monthly cap, a resume would only be paused again
    if ((await monthToDateCents(tx)) >= cap.monthlyCapCents) throw new AppError('ADS_MONTHLY_CAP_REACHED');
    const core = repo.toCoreCampaign(row);
    const e = eligibility(core);
    const other = e.blockers.filter((b) => b !== 'PAUSED');
    if (!e.blockers.includes('PAUSED') || other.length > 0 || row.dailyBudgetCents <= 0) {
      throw new AppError('ADS_CAMPAIGN_NOT_ELIGIBLE', { blockers: e.blockers.includes('PAUSED') ? other : ['NOT_PAUSED', ...other] });
    }
    const change: AllocationChange = { campaign_id: row.id, to_daily_cents: row.dailyBudgetCents };
    if (tenantDailyTotal(all.map(repo.toCoreCampaign), [change]) > cap.dailyCeilingCents) throw new AppError('AD_CAP_EXCEEDED');
    const from = countedDailyCents(core);
    const actionId = d.ids.next<'AssistantActionId'>();
    const payload = {
      v: 1, kind: 'resume', connection_id: row.connectionId, cap_version_id: cap.id, cap_version_no: cap.versionNo, changes: [change],
      rows: [{ campaignId: row.id, fromDailyCents: from, toDailyCents: change.to_daily_cents, changed: true, reasonCode: 'RESUMED' }],
    };
    await repo.insertReallocation(tx, { id: actionId, status: 'approved', explanation: `Resume one paused campaign at its ${dollars(change.to_daily_cents)} daily budget.`, payload, dedupeKey: null, decidedByUserId: actor.userId });
    const runId = d.ids.next<'AdRunId'>();
    await repo.insertEvent(tx, { id: d.ids.next<'AdAllocationEventId'>(), runId, campaignId: row.id, kind: 'planned', capVersionId: cap.id, actionId,
      fromDailyCents: from, toDailyCents: change.to_daily_cents, reasonCode: 'RESUMED', providerRef: null });
    await audit(tx, actor, { action: 'ads.campaign_resumed', entity: { type: 'ad_campaign', id: row.id }, changes: redactSnapshot({ run_id: runId, assistant_action_id: actionId, cap_version_no: cap.versionNo }) });
    return { actionId, runId };
  });
  await applyRun(d, actor.tenantId, r1.runId, true);
  return asPerson(d, actor, (tx) => runState(tx, r1.actionId));
}

// ---- apply (outside any transaction) and TX2 ----------------------------------------------------------------------------

function outcomeOf(e: unknown): AdsChangeResult {
  if (e instanceof ProviderError && e.kind === 'rejected') return { outcome: 'rejected', code: safeCode(e.providerCode, 'ADS_REJECTED') };
  return { outcome: 'unknown' };
}

async function callApply(d: AdsDeps, acct: AdsAccount, ext: string, plan: repo.LedgerRow, resume: boolean): Promise<AdsChangeResult> {
  try {
    return await withinBound(d.ads.applyBudgetChange({ account: acct, externalCampaignId: ext, toDailyCents: plan.toDailyCents, resume, idempotencyKey: plan.id }), d.applyTimeoutMs ?? APPLY_TIMEOUT_MS);
  } catch (e) {
    return outcomeOf(e);
  }
}

/** TX2 (system): the outcome of one planned row, at the planned amount; idempotent; `executed` when the run is complete. */
async function recordOutcome(d: AdsDeps, tenantId: string, plan: repo.LedgerRow, r: AdsChangeResult, o: { resume: boolean; reason?: string }): Promise<'applied' | 'failed' | 'none'> {
  if (r.outcome === 'unknown') return 'none';
  return asSystem(d, tenantId, async (tx) => {
    await sql`SELECT pg_advisory_xact_lock(hashtextextended('ads:' || app.tenant_id()::text, 0))`.execute(tx);
    const run = await repo.runEvents(tx, plan.runId);
    if (run.some((e) => e.campaignId === plan.campaignId && (e.eventKind === 'applied' || e.eventKind === 'failed'))) return 'none';
    const base = { runId: plan.runId, campaignId: plan.campaignId, capVersionId: plan.capVersionId, actionId: null, fromDailyCents: plan.fromDailyCents, toDailyCents: plan.toDailyCents };
    let kind: 'applied' | 'failed';
    if (r.outcome === 'applied') {
      kind = 'applied';
      await repo.insertEvent(tx, { ...base, id: d.ids.next<'AdAllocationEventId'>(), kind, reasonCode: o.reason ?? 'APPLIED', providerRef: r.providerRef.slice(0, 200) });
      // the mirror takes the planned amount; a resume becomes active unless a pause was recorded since the plan
      const paused = await repo.pausedSince(tx, plan.campaignId, plan.occurredAt);
      await repo.mirrorBudget(tx, plan.campaignId, plan.toDailyCents, o.resume && !paused ? 'active' : undefined);
    } else {
      kind = 'failed';
      await repo.insertEvent(tx, { ...base, id: d.ids.next<'AdAllocationEventId'>(), kind, reasonCode: safeCode(o.reason ?? r.code, 'ADS_REJECTED'), providerRef: null });
    }
    const planned = run.filter((e) => e.eventKind === 'planned');
    const done = new Set(run.filter((e) => e.eventKind === 'applied' || e.eventKind === 'failed').map((e) => e.campaignId));
    done.add(plan.campaignId);
    if (plan.assistantActionId && planned.every((p) => done.has(p.campaignId))) await repo.markExecuted(tx, plan.assistantActionId);
    return kind;
  });
}

/** Applies every planned row of a run that has no outcome yet (outside any transaction between the calls). */
export async function applyRun(d: AdsDeps, tenantId: TenantId | string, runId: string, resume: boolean): Promise<void> {
  const ctx = await asSystem(d, tenantId, async (tx) => {
    const run = await repo.runEvents(tx, runId);
    const open = run.filter((p) => p.eventKind === 'planned' && !run.some((e) => e.campaignId === p.campaignId && (e.eventKind === 'applied' || e.eventKind === 'failed')));
    const campaigns = await repo.campaignRows(tx, { ids: open.map((p) => p.campaignId) });
    const conns = await repo.adsConnections(tx);
    return { open, campaigns, conns };
  });
  for (const plan of ctx.open) {
    const camp = ctx.campaigns.find((c) => c.id === plan.campaignId);
    const conn = ctx.conns.find((c) => c.id === camp?.connectionId);
    // E442: the pack withdrawn after the tap: no call, the plan fails
    if (!(await asSystem(d, tenantId, (tx) => repo.packCleared(tx)))) {
      await recordOutcome(d, tenantId, plan, { outcome: 'rejected', code: 'PACK_WITHDRAWN' }, { resume });
      continue;
    }
    if (!camp || !conn || (conn.status !== 'connected' && conn.status !== 'degraded')) {
      await recordOutcome(d, tenantId, plan, { outcome: 'rejected', code: 'ADS_CONNECTION_NOT_LIVE' }, { resume });
      continue;
    }
    const acct = await account(d, tenantId, conn);
    if (!acct) {
      await recordOutcome(d, tenantId, plan, { outcome: 'rejected', code: 'CREDENTIAL_UNAVAILABLE' }, { resume });
      continue;
    }
    const r = await callApply(d, acct, camp.externalCampaignId, plan, resume);
    await recordOutcome(d, tenantId, plan, r, { resume });
  }
}

// ---- readback (the hourly reconcile, E447) --------------------------------------------------------------------------------

export interface ResolveReport {
  looked: number;
  applied: number;
  failed: number;
  reapplied: number;
  waiting: number;
}

/**
 * Planned rows of this connection with no outcome after STALE_PLANNED_MS, resolved against what Google Ads reports now:
 *   the planned amount (for a resume: and serving again) ⇒ applied READBACK; after OUTCOME_UNKNOWN_AFTER_MS ⇒ failed OUTCOME_UNKNOWN; another amount ⇒ failed
 *   PLATFORM_CHANGED (the mirror takes it); the from amount ⇒ failed PACK_WITHDRAWN when the pack is no longer cleared,
 *   otherwise ONE re-apply (claimed first in trigger_ref.reapplied, and only while the plan is still the campaign's latest
 *   event; absolute amounts are idempotent by value, VERIFY), else wait. Never a second planned row per approval.
 */
export async function resolveOpenPlans(d: AdsDeps, tenantId: string, connectionId: string, acct: AdsAccount, reports: readonly AdsCampaignReport[]): Promise<ResolveReport> {
  const now = clockOf(d);
  const rep: ResolveReport = { looked: 0, applied: 0, failed: 0, reapplied: 0, waiting: 0 };
  const ctx = await asSystem(d, tenantId, async (tx) => {
    const open = await repo.openPlans(tx);
    const campaigns = await repo.campaignRows(tx, { ids: open.map((p) => p.campaignId) });
    return { open, campaigns, cleared: await repo.packCleared(tx) };
  });
  for (const plan of ctx.open) {
    const camp = ctx.campaigns.find((c) => c.id === plan.campaignId);
    if (!camp || camp.connectionId !== connectionId) continue;
    const age = now - Date.parse(plan.occurredAt);
    if (age < STALE_PLANNED_MS) continue;
    rep.looked += 1;
    const action = plan.assistantActionId ? await asSystem(d, tenantId, (tx) => repo.reallocation(tx, plan.assistantActionId!)) : null;
    const resume = action ? storedProposal(action.payload)?.kind === 'resume' : false;
    const report = reports.find((x) => x.externalCampaignId === camp.externalCampaignId);
    const onPlatform = report?.dailyBudgetCents ?? null;
    // a resume keeps the budget: it took effect only if the campaign is serving again, and is untouched while still paused
    const tookEffect = onPlatform === plan.toDailyCents && (!resume || report?.platformStatus === 'enabled');
    const untouched = resume ? onPlatform === plan.toDailyCents && report?.platformStatus === 'paused' : onPlatform === plan.fromDailyCents;
    const record = async (r: AdsChangeResult, reason?: string) => {
      const k = await recordOutcome(d, tenantId, plan, r, { resume, ...(reason ? { reason } : {}) });
      if (k === 'applied') rep.applied += 1;
      else if (k === 'failed') rep.failed += 1;
    };
    if (tookEffect) {
      await record({ outcome: 'applied', providerRef: 'READBACK', dailyBudgetCents: plan.toDailyCents }, 'READBACK');
    } else if (age >= OUTCOME_UNKNOWN_AFTER_MS) {
      await record({ outcome: 'rejected', code: 'OUTCOME_UNKNOWN' });
    } else if (onPlatform === null) {
      rep.waiting += 1;
    } else if (!untouched) {
      await record({ outcome: 'rejected', code: 'PLATFORM_CHANGED' });
    } else if (!(await asSystem(d, tenantId, (tx) => repo.packCleared(tx)))) {
      await record({ outcome: 'rejected', code: 'PACK_WITHDRAWN' });
    } else if (camp.latestEvent?.id === plan.id && action && (await asSystem(d, tenantId, (tx) => repo.markReapplied(tx, action.id, camp.id)))) {
      rep.reapplied += 1;
      const r = await callApply(d, acct, camp.externalCampaignId, plan, resume);
      await record(r);
      if (r.outcome === 'unknown') rep.waiting += 1;
    } else {
      rep.waiting += 1;
    }
  }
  return rep;
}

// ---- the monthly-cap safety pause (R-ADS-5, E124) ---------------------------------------------------------------------------

export interface PauseReport {
  paused: number;
  unknown: number;
  refused: number;
  /** campaigns not paused because the pack was withdrawn during the pass (R-ADS-7: no provider write while dark) */
  withdrawn: number;
}

/**
 * Pauses each given mirrored campaign of the connection on Google Ads (key run:campaign) and, on success, records a paused
 * row (to 0, the cap in force, MONTHLY_CAP_REACHED, the provider ref), sets the mirror to paused and audits it, as the
 * system. An unknown result is retried by the next hourly pass. The caller checked the pack (dark ⇒ never called), and
 * the pack is re-checked as the system before each call (b11 ads-16): once withdrawn, no further pause is sent.
 * VERIFY WITH COUNSEL (C3): auto-pausing at the cap, unmanaged campaigns included (Q-ADS-3).
 */
export async function pauseForMonthlyCap(d: AdsDeps, tenantId: string, acct: AdsAccount, campaigns: readonly repo.CampaignRow[], cap: repo.CapRow): Promise<PauseReport> {
  const rep: PauseReport = { paused: 0, unknown: 0, refused: 0, withdrawn: 0 };
  const runId = d.ids.next<'AdRunId'>();
  for (const [i, c] of campaigns.entries()) {
    if (!(await asSystem(d, tenantId, (tx) => repo.packCleared(tx)))) {
      rep.withdrawn = campaigns.length - i;
      break;
    }
    let r: AdsChangeResult;
    try {
      r = await withinBound(d.ads.pauseCampaign({ account: acct, externalCampaignId: c.externalCampaignId, idempotencyKey: `${runId}:${c.id}` }), d.applyTimeoutMs ?? APPLY_TIMEOUT_MS);
    } catch (e) {
      r = outcomeOf(e);
    }
    if (r.outcome === 'unknown') {
      rep.unknown += 1;
      continue;
    }
    if (r.outcome === 'rejected') {
      rep.refused += 1;
      continue;
    }
    const providerRef = r.providerRef.slice(0, 200);
    await asSystem(d, tenantId, async (tx) => {
      const sys = systemActor(tenantId, 'provider');
      await repo.insertEvent(tx, { id: d.ids.next<'AdAllocationEventId'>(), runId, campaignId: c.id, kind: 'paused', capVersionId: cap.id, actionId: null,
        fromDailyCents: countedDailyCents(repo.toCoreCampaign(c)), toDailyCents: 0, reasonCode: 'MONTHLY_CAP_REACHED', providerRef });
      await repo.setCampaignStatus(tx, c.id, 'paused');
      await audit(tx, sys, { action: 'ads.campaign_paused', entity: { type: 'ad_campaign', id: c.id }, changes: redactSnapshot({ run_id: runId, cap_version_no: cap.versionNo }), reason: 'MONTHLY_CAP_REACHED' });
    });
    rep.paused += 1;
  }
  return rep;
}
