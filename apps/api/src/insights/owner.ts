// The owner view (PHASE2_3_PLAN module 33; DATA_MODEL R-OWNER-1…5; E107–E109).
//
//   sources(period)   dollars by lead source from v_owner_source_dollars (M33) + lead_source_costs, summed by
//                     core sourceDollars: every row carries its denominators (closings, deals with a known
//                     commission, cost rows); deals left out (no commission E107, no source) are counted and listed;
//                     cost per closing with zero closings is words, never $0 or ∞ (E108).
//   velocity()        median stage dwell with sample sizes from app.stage_dwell_norms() (Phase 1, no new view);
//                     stages with fewer than VELOCITY_MIN_SAMPLE dwell samples are left out and listed.
//   forecast(now)     core forecastBoth over open deals and the trailing 365 days of deal_stage_history; stages
//                     with n < 10 are left out and listed (E109); the method is one sentence; no per-deal number.
//   costs / putCost   manual cost rows as the Owner/Admin themselves (R-OWNER-5); audited.
//
// Money visibility: every function takes a UserActor and runs in that human's transaction; deal_financials and
// lead_source_costs RLS do the rest (the system actor reads no commission and no manual cost). Routes allow only
// Owner/Admin (owner_view.view / source_cost.edit, no system via, no support).
//
// R-OWNER-4: no response here has a per-deal probability or a confidence field (schemas.ts snapshot).
import {
  type DealFinancialRow,
  FORECAST_MIN_SAMPLE,
  type ForecastOpenDeal,
  type InsightDeal,
  OPEN_STAGES,
  type OpenStage,
  type SourceCostRow,
  type StageEntry,
  forecastBoth,
  forecastRangeWords,
  formatCents,
  sourceDollars,
  velocityRows,
} from '@realty/core/insights';
import { type IdGenerator, type Instant, type LeadSourceId, type UserActor, can, instantFromDate, localDate, toIso } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { audit, redactSnapshot } from '../audit.js';
import { AppError } from '../errors.js';
import { monthOf, monthStart, nextMonthStart, tenantZone } from './common.js';

/** Velocity medians from fewer dwell samples than this are left out (the v_pipeline_momentum "slow" floor). */
export const VELOCITY_MIN_SAMPLE = 5;

export const SOURCES_METHOD =
  'Commission of deals closed in the period (by closing date in the team time zone), summed by the lead source each deal was created with. ' +
  'Each row says how many closings it counts and how many of them have a commission entered; closed deals with no commission or no source are counted and listed below. ' +
  'Cost is every cost entered for the source in the period’s months; cost per closing is cost divided by closings.';

export const VELOCITY_METHOD = `Median days deals stayed in each stage before moving on, over stage changes in the last 180 days. Stages with fewer than ${VELOCITY_MIN_SAMPLE} such moves are left out.`;

const lit = (v: unknown) => v as never;

function periodOf(from: string, to: string) {
  if (to < from) throw new AppError('VALIDATION_FAILED', { reason: 'PERIOD_REVERSED' });
  return { start: monthStart(from), endExclusive: nextMonthStart(to) };
}

// ---- dollars by source ------------------------------------------------------------------------

export async function sources(tx: Tx, from: string, to: string) {
  const zone = await tenantZone(tx);
  const p = periodOf(from, to);
  const period = { ...p, zone };
  // closings read a day of margin either side; core decides membership by the local closing date
  const deals = await sql<{ deal_id: string; deal_name: string; lead_source_id: string | null; closed_at: Date; gross_commission_cents: string | null; commission_status: string | null }>`
    SELECT deal_id, deal_name, lead_source_id, closed_at, gross_commission_cents, commission_status
      FROM v_owner_source_dollars
     WHERE tenant_id = app.tenant_id()
       AND closed_at >= (${p.start}::date - 1)::timestamp AT TIME ZONE 'UTC'
       AND closed_at <  (${p.endExclusive}::date + 1)::timestamp AT TIME ZONE 'UTC'`.execute(tx);
  const costs = await sql<{ lead_source_id: string; month: string; amount_cents: string; origin: 'manual' | 'ads_sync' }>`
    SELECT lead_source_id, month::text AS month, amount_cents, origin FROM lead_source_costs
     WHERE tenant_id = app.tenant_id() AND month >= ${p.start}::date AND month < ${p.endExclusive}::date`.execute(tx);
  const names = await sql<{ id: string; name: string }>`SELECT id, name FROM lead_sources WHERE tenant_id = app.tenant_id()`.execute(tx);
  const nameOf = new Map(names.rows.map((r) => [r.id, r.name]));
  const dealName = new Map(deals.rows.map((d) => [d.deal_id, d.deal_name]));

  const insightDeals: InsightDeal[] = deals.rows.map((d) => ({
    id: lit(d.deal_id),
    side: 'buy',
    stage: 'closed',
    stageEnteredAt: instantFromDate(d.closed_at),
    closedAt: instantFromDate(d.closed_at),
    leadSourceId: d.lead_source_id as LeadSourceId | null,
  }));
  const financials: DealFinancialRow[] = deals.rows
    .filter((d) => d.commission_status !== null)
    .map((d) => ({ dealId: lit(d.deal_id), grossCommissionCents: d.gross_commission_cents === null ? null : Number(d.gross_commission_cents), commissionStatus: d.commission_status as never }));
  const costRows: SourceCostRow[] = costs.rows.map((c) => ({ leadSourceId: c.lead_source_id as LeadSourceId, month: localDate(c.month), amountCents: Number(c.amount_cents), origin: c.origin }));
  const out = sourceDollars(insightDeals, financials, costRows, period);
  const listed = (ids: readonly string[]) => ids.map((id) => ({ dealId: id, name: dealName.get(id) ?? 'Deal' }));
  return {
    period: { from, to, zone: zone as string },
    method: SOURCES_METHOD,
    closedInPeriod: out.closedInPeriod,
    rows: out.rows.map((r) => ({
      leadSourceId: r.leadSourceId as string,
      leadSourceName: nameOf.get(r.leadSourceId) ?? 'Lead source',
      closings: r.closings,
      dealsWithCommission: r.dealsWithCommission,
      missingCommission: r.missingCommission,
      commissionCents: r.commissionCents,
      commissionWords: `${formatCents(r.commissionCents)} from ${r.dealsWithCommission} of ${r.closings} ${r.closings === 1 ? 'closing' : 'closings'} with a commission entered`,
      costCents: r.costCents,
      costManualCents: r.costByOrigin.manual,
      costAdsSyncCents: r.costByOrigin.adsSync,
      costRows: r.costRows,
      costWords: r.costRows === 0 ? 'No cost entered' : `${formatCents(r.costCents)} over ${r.costRows} ${r.costRows === 1 ? 'monthly entry' : 'monthly entries'}`,
      costPerClosingCents: r.costPerClosingCents,
      costPerClosingWords: r.costPerClosingWords,
    })),
    excluded: {
      missingCommission: { count: out.excluded.missingCommission.count, deals: listed(out.excluded.missingCommission.dealIds) },
      noSource: { count: out.excluded.noSource.count, deals: listed(out.excluded.noSource.dealIds) },
    },
  };
}

// ---- velocity -----------------------------------------------------------------------------------

export async function velocity(tx: Tx) {
  const r = await sql<{ stage: string; median_days: string; sample_size: number }>`SELECT stage, median_days, sample_size FROM app.stage_dwell_norms()`.execute(tx);
  const open = new Set<string>(OPEN_STAGES);
  const rows = velocityRows(r.rows.filter((x) => open.has(x.stage)).map((x) => ({ stage: x.stage, medianDays: Number(x.median_days), sampleSize: x.sample_size })));
  const shown = rows.filter((x) => x.sampleSize >= VELOCITY_MIN_SAMPLE);
  const seen = new Map(rows.map((x) => [x.stage, x.sampleSize]));
  const thin = OPEN_STAGES.filter((s) => (seen.get(s) ?? 0) < VELOCITY_MIN_SAMPLE).map((s) => ({ stage: s, sampleSize: seen.get(s) ?? 0 }));
  return {
    method: VELOCITY_METHOD,
    minSample: VELOCITY_MIN_SAMPLE,
    rows: shown.map((x) => ({ stage: x.stage, medianDays: x.medianDays, sampleSize: x.sampleSize, words: x.words })),
    excluded: { thinStages: thin },
  };
}

// ---- forecast -----------------------------------------------------------------------------------

export async function forecastView(tx: Tx, now: Instant) {
  const open = await sql<{ id: string; stage: string; lead_source_id: string | null; gross_commission_cents: string | null }>`
    SELECT d.id, d.stage, d.lead_source_id, f.gross_commission_cents
      FROM deals d LEFT JOIN deal_financials f ON f.tenant_id = d.tenant_id AND f.deal_id = d.id
     WHERE d.tenant_id = app.tenant_id() AND d.stage NOT IN ('closed','lost')`.execute(tx);
  const hist = await sql<{ deal_id: string; to_stage: string; changed_at: Date }>`
    SELECT deal_id, to_stage, changed_at FROM deal_stage_history
     WHERE tenant_id = app.tenant_id() AND changed_at >= ${toIso(now)}::timestamptz - interval '366 days'`.execute(tx);
  const openDeals: ForecastOpenDeal[] = open.rows.map((d) => ({
    id: lit(d.id),
    stage: d.stage as OpenStage,
    leadSourceId: d.lead_source_id as LeadSourceId | null,
    expectedCommissionCents: d.gross_commission_cents === null ? null : Number(d.gross_commission_cents),
  }));
  const entries: StageEntry[] = hist.rows.map((h) => ({ dealId: lit(h.deal_id), toStage: h.to_stage as never, changedAt: instantFromDate(h.changed_at) }));
  const both = forecastBoth(openDeals, entries, now, FORECAST_MIN_SAMPLE);
  const shape = (f: (typeof both)['closings']) => ({
    unit: f.unit,
    horizonDays: f.horizonDays,
    low: f.low,
    expected: f.expected,
    high: f.high,
    rangeWords: forecastRangeWords(f),
    method: f.method,
    countedDeals: f.countedDeals,
    notEnoughHistory: f.notEnoughHistory,
    samples: f.samples.map((s) => ({ stage: s.stage, n: s.n, k: s.k })),
    excluded: { thinStages: [...f.excluded.thinStages], thinStageDeals: f.excluded.thinStageDeals, noCommission: f.excluded.noCommission, noSource: f.excluded.noSource },
  });
  return { asOf: toIso(now), minSample: FORECAST_MIN_SAMPLE, openDeals: openDeals.length, closings: shape(both.closings), commission: shape(both.commission) };
}

// ---- source costs (R-OWNER-5) -------------------------------------------------------------------

export async function listCosts(tx: Tx, from: string, to: string) {
  const p = periodOf(from, to);
  const r = await sql<{ id: string; lead_source_id: string; month: string; amount_cents: string; origin: 'manual' | 'ads_sync'; note: string | null; entered_by_user_id: string | null; updated_at: Date }>`
    SELECT id, lead_source_id, month::text AS month, amount_cents, origin, note, entered_by_user_id, updated_at FROM lead_source_costs
     WHERE tenant_id = app.tenant_id() AND month >= ${p.start}::date AND month < ${p.endExclusive}::date
     ORDER BY month, lead_source_id, origin`.execute(tx);
  const src = await sql<{ id: string; name: string; active: boolean }>`SELECT id, name, active FROM lead_sources WHERE tenant_id = app.tenant_id() ORDER BY name, id`.execute(tx);
  return {
    sources: src.rows.map((s) => ({ id: s.id, name: s.name, active: s.active })),
    costs: r.rows.map((c) => ({
      id: c.id,
      leadSourceId: c.lead_source_id,
      month: c.month.slice(0, 7),
      amountCents: Number(c.amount_cents),
      origin: c.origin,
      note: c.note,
      enteredByUserId: c.entered_by_user_id,
      updatedAt: c.updated_at.toISOString(),
    })),
  };
}

/** Whether `month` ('YYYY-MM') has ended in the tenant zone (a closed month needs re-auth to edit). */
export async function costMonthState(tx: Tx, month: string, now: Instant): Promise<'closed' | 'open' | 'future'> {
  const current = monthOf(now, await tenantZone(tx));
  return month < current ? 'closed' : month === current ? 'open' : 'future';
}

export async function putCost(
  tx: Tx,
  actor: UserActor,
  ids: IdGenerator,
  now: Instant,
  b: { leadSourceId: string; month: string; amountCents: number; note?: string | null | undefined },
  reauth: { reauthenticatedAt: Instant | null; now: Instant },
) {
  const state = await costMonthState(tx, b.month, now);
  if (state === 'future') throw new AppError('COST_MONTH_IN_FUTURE');
  // The route's preHandler decided with the clock of its own read; the month may have closed since. Decide again with
  // this transaction's clock, so a month that closed in between still needs the re-auth (R-PERM-13).
  const again = can(actor, 'source_cost.edit', { closedPeriod: state === 'closed', reauth });
  if (!again.ok) throw new AppError(again.code === 'REAUTH_REQUIRED' ? 'REAUTH_REQUIRED' : 'NOT_FOUND');
  const src = await sql<{ id: string }>`SELECT id FROM lead_sources WHERE tenant_id = app.tenant_id() AND id = ${b.leadSourceId}`.execute(tx);
  if (!src.rows[0]) throw new AppError('NOT_FOUND');
  const month = monthStart(b.month);
  const before = await sql<{ amount_cents: string }>`
    SELECT amount_cents FROM lead_source_costs
     WHERE tenant_id = app.tenant_id() AND lead_source_id = ${b.leadSourceId} AND month = ${month}::date AND origin = 'manual' FOR UPDATE`.execute(tx);
  const prev = before.rows[0] ? Number(before.rows[0].amount_cents) : null;
  // a manual row is written by the person as themselves (RLS costs_owner_admin WITH CHECK, R-OWNER-5)
  const r = await sql<{ id: string }>`
    INSERT INTO lead_source_costs (tenant_id, id, lead_source_id, month, amount_cents, origin, note, entered_by_user_id)
    VALUES (app.tenant_id(), ${ids.next<'LeadSourceCostId'>()}, ${b.leadSourceId}, ${month}::date, ${b.amountCents}, 'manual', ${b.note ?? null}, ${actor.userId})
    ON CONFLICT (tenant_id, lead_source_id, month, origin) DO UPDATE
      SET amount_cents = EXCLUDED.amount_cents, note = EXCLUDED.note, entered_by_user_id = EXCLUDED.entered_by_user_id
    RETURNING id`.execute(tx);
  const id = r.rows[0]!.id;
  await audit(tx, actor, {
    action: 'source_cost.changed',
    entity: { type: 'lead_source_cost', id },
    changes: redactSnapshot(
      { lead_source_id: b.leadSourceId, month: b.month, before_cents: prev, after_cents: b.amountCents, closed_month: state === 'closed' },
      { entity: 'lead_source_cost' },
    ),
    reason: state === 'closed' ? 'CLOSED_MONTH' : 'OPEN_MONTH',
  });
  return { id, month: b.month, closedMonth: state === 'closed', previousCents: prev, amountCents: b.amountCents };
}
