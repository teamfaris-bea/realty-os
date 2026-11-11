// Request and response schemas of api/insights (module 33). R-OWNER-4 / R-AST-13: no response has a per-deal
// probability, a confidence or a score field, and none carries a tenant id (snapshot in schemas.test.ts).
// Every owner-view number travels with its denominator and the section's method sentence (R-OWNER-1).
import { z } from 'zod';
import { ISO_WEEK_RE } from './common.js';

const Id = z.uuid();
const Cents = z.number().int().nonnegative();
const Count = z.number().int().nonnegative();
export const YearMonth = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/);
export const Week = z.string().regex(ISO_WEEK_RE);

export const PeriodQuery = z.strictObject({ from: YearMonth.optional(), to: YearMonth.optional() });

const DealRef = z.object({ dealId: Id, name: z.string() });

export const SourcesResponse = z.object({
  period: z.object({ from: YearMonth, to: YearMonth, zone: z.string() }),
  method: z.string(),
  /** denominator of the whole table: deals closed in the period */
  closedInPeriod: Count,
  rows: z.array(
    z.object({
      leadSourceId: Id,
      leadSourceName: z.string(),
      closings: Count,
      dealsWithCommission: Count,
      missingCommission: Count,
      commissionCents: Cents,
      commissionWords: z.string(),
      costCents: Cents,
      costManualCents: Cents,
      costAdsSyncCents: Cents,
      costRows: Count,
      costWords: z.string(),
      costPerClosingCents: Cents.nullable(),
      costPerClosingWords: z.string(),
    }),
  ),
  excluded: z.object({
    missingCommission: z.object({ count: Count, deals: z.array(DealRef) }),
    noSource: z.object({ count: Count, deals: z.array(DealRef) }),
  }),
});

export const VelocityResponse = z.object({
  method: z.string(),
  minSample: Count,
  rows: z.array(z.object({ stage: z.string(), medianDays: z.number().nonnegative(), sampleSize: Count, words: z.string() })),
  excluded: z.object({ thinStages: z.array(z.object({ stage: z.string(), sampleSize: Count })) }),
});

const ForecastUnit = z.object({
  unit: z.enum(['closings', 'commission_cents']),
  horizonDays: z.literal(90),
  low: z.number().nonnegative(),
  expected: z.number().nonnegative(),
  high: z.number().nonnegative(),
  rangeWords: z.string(),
  method: z.string(),
  countedDeals: Count,
  notEnoughHistory: z.boolean(),
  samples: z.array(z.object({ stage: z.string(), n: Count, k: Count })),
  excluded: z.object({ thinStages: z.array(z.string()), thinStageDeals: Count, noCommission: Count, noSource: Count }),
});
export const ForecastResponse = z.object({ asOf: z.string(), minSample: Count, openDeals: Count, closings: ForecastUnit, commission: ForecastUnit });

export const CostsResponse = z.object({
  sources: z.array(z.object({ id: Id, name: z.string(), active: z.boolean() })),
  costs: z.array(
    z.object({
      id: Id,
      leadSourceId: Id,
      month: YearMonth,
      amountCents: Cents,
      origin: z.enum(['manual', 'ads_sync']),
      note: z.string().nullable(),
      enteredByUserId: Id.nullable(),
      updatedAt: z.string(),
    }),
  ),
});
export const PutCostBody = z.strictObject({
  leadSourceId: Id,
  month: YearMonth,
  amountCents: z.number().int().nonnegative().max(100_000_000_00),
  note: z.string().trim().max(500).nullable().optional(),
});
export const PutCostResponse = z.object({ cost: z.object({ id: Id, month: YearMonth, closedMonth: z.boolean(), previousCents: Cents.nullable(), amountCents: Cents }) });

const Metric = z.enum(['appointments_set', 'appointments_held', 'agreements_signed', 'closings', 'touches']);
const PeriodKind = z.enum(['week', 'month', 'quarter', 'year']);
const LocalDay = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const Goal = z.object({
  id: Id,
  userId: Id,
  periodKind: PeriodKind,
  periodStart: LocalDay,
  periodEndExclusive: LocalDay,
  metric: Metric,
  target: Count,
  pace: z.object({
    actual: Count,
    expectedByNow: z.number().nonnegative(),
    behindBy: Count,
    remaining: Count,
    daysLeft: Count,
    status: z.enum(['ahead', 'on_track', 'behind', 'done']),
    words: z.string(),
    method: z.string(),
  }),
});
export const GoalsQuery = z.strictObject({ userId: Id.optional() });
export const GoalsResponse = z.object({
  zone: z.string(),
  members: z.array(z.object({ userId: Id, name: z.string(), role: z.string(), canManage: z.boolean() })),
  goals: z.array(Goal),
});
export const CreateGoalBody = z.strictObject({ userId: Id, periodKind: PeriodKind, periodStart: LocalDay, metric: Metric, target: z.number().int().min(1).max(100_000) });
export const UpdateGoalBody = z.strictObject({ target: z.number().int().min(1).max(100_000) });
export const GoalResponse = z.object({ goal: Goal });
export const OkResponse = z.object({ ok: z.literal(true) });

const Evidence = z.object({ sourceType: z.enum(['task', 'appointment', 'deal']), sourceId: Id, reason: z.string() });
const PlanItem = z.object({
  kind: z.enum(['keep_promise', 'do_task', 'log_outcome', 'move_deal']),
  title: z.string(),
  contactId: Id.nullable(),
  dealId: Id.nullable(),
  deadline: z.string().nullable(),
  metric: Metric.nullable(),
  gap: Count,
  evidence: z.array(Evidence),
});
export const PlanResponse = z.object({
  week: Week,
  exists: z.boolean(),
  basis: z.enum(['goals_and_pipeline', 'pipeline_only']).optional(),
  note: z.string().optional(),
  builtAt: z.string().optional(),
  items: z.array(z.object({ index: z.number().int().min(0).max(4), accepted: z.boolean(), item: PlanItem })).optional(),
  droppedSinceBuilt: Count.optional(),
  accepted: z.object({ at: z.string(), taskIds: z.array(Id) }).nullable().optional(),
});
export const AcceptPlanBody = z.strictObject({ itemIndexes: z.array(z.number().int().min(0).max(4)).min(1).max(5) });

/** Response schemas, for the R-OWNER-4 / R-AST-13 / R-TEN-3 snapshot test. */
export const INSIGHTS_RESPONSE_SCHEMAS = {
  SourcesResponse,
  VelocityResponse,
  ForecastResponse,
  CostsResponse,
  PutCostResponse,
  GoalsResponse,
  GoalResponse,
  PlanResponse,
};
