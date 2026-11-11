// Types of core/insights (PHASE2_3_PLAN module 32; DATA_MODEL R-OWNER-1..5, R-PLAN-1..3).
//
// Inputs mirror the DB rows the API reads (deals, deal_financials, lead_source_costs,
// deal_stage_history, agent_goals, app.stage_dwell_norms()) with camelCase names, Instants for
// timestamptz and LocalDates for date columns. Money is integer cents everywhere.
//
// R-OWNER-4: no output type here has a per-deal probability, a confidence or a score field.
import type {
  AgentGoalId,
  AppointmentId,
  ContactId,
  DealId,
  IanaZone,
  Instant,
  LeadSourceId,
  LocalDate,
  TaskId,
  UserId,
} from '../foundation/index.js';

// ---- deals ----------------------------------------------------------------------------------
export const DEAL_STAGES = ['prospect', 'agreement_signed', 'active', 'under_contract', 'closed', 'lost'] as const;
export type DealStage = (typeof DEAL_STAGES)[number];
/** The stages a deal can still close from (the forecast's stages). */
export const OPEN_STAGES = ['prospect', 'agreement_signed', 'active', 'under_contract'] as const;
export type OpenStage = (typeof OPEN_STAGES)[number];
export type DealSide = 'buy' | 'sell' | 'dual' | 'lease';
export type CommissionStatus = 'estimated' | 'confirmed' | 'paid';

/** A `deals` row as the owner view needs it. `closedAt` is set exactly when stage = closed (DB CHECK). */
export interface InsightDeal {
  readonly id: DealId;
  readonly side: DealSide;
  readonly stage: DealStage;
  readonly stageEnteredAt: Instant;
  readonly closedAt: Instant | null;
  /** Immutable attribution copied at creation (A7d); null when the deal has no source. */
  readonly leadSourceId: LeadSourceId | null;
}

/** A `deal_financials` row. A deal with no row is treated like a null commission. */
export interface DealFinancialRow {
  readonly dealId: DealId;
  readonly grossCommissionCents: number | null;
  readonly commissionStatus: CommissionStatus;
}

/** A `lead_source_costs` row; `month` is the first day of the month. */
export interface SourceCostRow {
  readonly leadSourceId: LeadSourceId;
  readonly month: LocalDate;
  readonly amountCents: number;
  readonly origin: 'manual' | 'ads_sync';
}

/**
 * A reporting period as local dates, half-open: `[start, endExclusive)`. A deal is in the period
 * when the tenant-zone local date of its `closedAt` is; a cost row is in the period when its
 * `month` (first of month) is. Month-aligned periods therefore line up exactly.
 */
export interface InsightPeriod {
  readonly start: LocalDate;
  readonly endExclusive: LocalDate;
  readonly zone: IanaZone;
}

// ---- dollars by source (R-OWNER-2) ----------------------------------------------------------
export interface SourceRow {
  readonly leadSourceId: LeadSourceId;
  /** Denominator: deals of this source closed in the period (with or without commission). */
  readonly closings: number;
  /** Denominator of `commissionCents`: closed deals of this source whose commission is known. */
  readonly dealsWithCommission: number;
  /** Closed deals of this source left out of `commissionCents` (E107), also listed in `excluded`. */
  readonly missingCommission: number;
  readonly commissionCents: number;
  readonly costCents: number;
  readonly costByOrigin: { readonly manual: number; readonly adsSync: number };
  /** Number of cost rows (source-months by origin) behind `costCents`; 0 means no cost entered. */
  readonly costRows: number;
  /** cost / closings, half-up to whole cents; null with zero closings (E108) or no cost entered. */
  readonly costPerClosingCents: number | null;
  /** The cost per closing in words, e.g. "$450.00 per closing (4 closings)" or "— (0 closings)". */
  readonly costPerClosingWords: string;
}

export interface ExcludedDeals {
  readonly count: number;
  readonly dealIds: readonly DealId[];
}

export interface SourceDollars {
  readonly rows: readonly SourceRow[];
  /** R-OWNER-1: closed-in-period deals left out of the dollars, counted and listed. */
  readonly excluded: {
    /** E107: closed with no known commission (no financials row or a null amount). */
    readonly missingCommission: ExcludedDeals;
    /** Closed with no lead source: not attributable to any row. */
    readonly noSource: ExcludedDeals;
  };
  /** Denominator for the whole table: deals closed in the period. */
  readonly closedInPeriod: number;
}

// ---- forecast (R-OWNER-3) -------------------------------------------------------------------
export type ForecastUnit = 'closings' | 'commission_cents';

/** An open deal to forecast. `expectedCommissionCents` is its `gross_commission_cents` (or null). */
export interface ForecastOpenDeal {
  readonly id: DealId;
  readonly stage: OpenStage;
  readonly leadSourceId: LeadSourceId | null;
  readonly expectedCommissionCents: number | null;
}

/** A `deal_stage_history` row (append-only). Pass every row from at least now - 365 d onward. */
export interface StageEntry {
  readonly dealId: DealId;
  readonly toStage: DealStage;
  readonly changedAt: Instant;
}

export interface StageSample {
  readonly stage: OpenStage;
  readonly n: number;
  readonly k: number;
}

export interface Forecast {
  readonly low: number;
  /** The sum of k/n over counted deals (the "expected value" of R-OWNER-3). */
  readonly expected: number;
  readonly high: number;
  readonly horizonDays: 90;
  readonly unit: ForecastUnit;
  /** One plain sentence saying how the numbers were made and what was left out. */
  readonly method: string;
  readonly samples: readonly StageSample[];
  /** Denominator: open deals whose stage share was used (and, for commission, that had one). */
  readonly countedDeals: number;
  /** True when no open stage had `minSample` entries with a known outcome: low = expected = high = 0. */
  readonly notEnoughHistory: boolean;
  readonly excluded: {
    /** E109: stages with n < minSample; their open deals are not counted. */
    readonly thinStages: readonly OpenStage[];
    /** Open deals left out because their stage is thin. */
    readonly thinStageDeals: number;
    /** commission unit only: open deals in counted stages with no expected commission. */
    readonly noCommission: number;
    /** Informational: open deals with no lead source (they are still forecast). */
    readonly noSource: number;
  };
}

// ---- goals and pace (R-PLAN-2) ---------------------------------------------------------------
export type GoalPeriodKind = 'week' | 'month' | 'quarter' | 'year';
export type GoalMetric = 'appointments_set' | 'appointments_held' | 'agreements_signed' | 'closings' | 'touches';

/** An `agent_goals` row. */
export interface AgentGoal {
  readonly id: AgentGoalId;
  readonly userId: UserId;
  readonly periodKind: GoalPeriodKind;
  readonly periodStart: LocalDate;
  readonly metric: GoalMetric;
  readonly target: number;
}

/** The count for the goal's metric over the goal's period, from the scoreboard definers (R-PLAN-2). */
export interface GoalScoreboard {
  readonly actual: number;
}

export type PaceStatus = 'ahead' | 'on_track' | 'behind' | 'done';

export interface Pace {
  readonly goalId: AgentGoalId;
  readonly metric: GoalMetric;
  readonly periodStart: LocalDate;
  readonly periodEndExclusive: LocalDate;
  readonly actual: number;
  readonly target: number;
  /** target × elapsed fraction of the period, rounded to one decimal. */
  readonly expectedByNow: number;
  /** Whole units below the linear pace: max(0, ceil(target × elapsed) − actual). */
  readonly behindBy: number;
  readonly remaining: number;
  /** Local days left in the period counting today (0 once it has ended). */
  readonly daysLeft: number;
  readonly status: PaceStatus;
  /** e.g. "3 of 10 closings; 4.5 expected by now; 7 to go in 12 days". */
  readonly words: string;
}

// ---- weekly plan (R-PLAN-1, R-PLAN-3) -------------------------------------------------------
export interface SlowDealFacts {
  readonly dealId: DealId;
  readonly contactId: ContactId | null;
  readonly name: string;
  readonly stage: OpenStage;
  readonly dwellDays: number;
  readonly medianDays: number;
  readonly sampleSize: number;
  /** Person-level do-not-contact on the deal's primary contact (R-PLAN-3). */
  readonly doNotContact: boolean;
}

export interface PromiseFacts {
  readonly taskId: TaskId;
  readonly contactId: ContactId | null;
  readonly title: string;
  readonly dueAt: Instant | null;
  readonly doNotContact: boolean;
}

export interface ApptFacts {
  readonly appointmentId: AppointmentId;
  readonly contactId: ContactId | null;
  readonly startsAt: Instant;
  readonly doNotContact: boolean;
}

export type PlanTaskKind = 'todo' | 'callback' | 'promise' | 'follow_up' | 'document';

export interface PlanTaskFacts {
  readonly taskId: TaskId;
  readonly kind: PlanTaskKind;
  readonly contactId: ContactId | null;
  readonly dealId: DealId | null;
  readonly title: string;
  readonly dueAt: Instant | null;
  readonly doNotContact: boolean;
}

export type PlanSourceType = 'task' | 'appointment' | 'deal';

export interface PlanEvidence {
  readonly sourceType: PlanSourceType;
  readonly sourceId: string;
  readonly reason: string;
}

export type PlanItemKind = 'keep_promise' | 'do_task' | 'log_outcome' | 'move_deal';

export interface PlanItem {
  readonly kind: PlanItemKind;
  readonly title: string;
  readonly contactId: ContactId | null;
  readonly dealId: DealId | null;
  /** The item's own deadline (a task's due_at), or null. Deadlines rank first (R-PLAN-1). */
  readonly deadline: Instant | null;
  /** The goal metric this item moves, or null. */
  readonly metric: GoalMetric | null;
  /** Units behind pace on that metric's goals (0 with no goal): the second ranking key. */
  readonly gap: number;
  readonly evidence: readonly PlanEvidence[];
}

export type PlanBasis = 'goals_and_pipeline' | 'pipeline_only';

export interface WeeklyPlan {
  /** 0–5 items: up to 5, and fewer than 3 only when fewer candidates exist (no filler). */
  readonly items: readonly PlanItem[];
  readonly basis: PlanBasis;
  /** One sentence for the plan header (E110 says the plan is built from the pipeline only). */
  readonly note: string;
  /** Candidates considered (after do-not-contact drops and de-duplication). */
  readonly candidates: number;
  /** Candidates dropped because the contact is person-level do-not-contact (R-PLAN-3). */
  readonly droppedDoNotContact: number;
}

// ---- velocity (R-OWNER-3) -------------------------------------------------------------------
/** A row of `app.stage_dwell_norms()`; numeric median as a JS number (the API converts it). */
export interface StageDwellNorm {
  readonly stage: string;
  readonly medianDays: number;
  readonly sampleSize: number;
}

export interface VelocityRow {
  readonly stage: string;
  readonly medianDays: number;
  readonly sampleSize: number;
  /** e.g. "median 12 days (n=34)". */
  readonly words: string;
}
