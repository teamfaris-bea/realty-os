// Types of core/transactions (PHASE2_3_PLAN module 30; DATA_MODEL §6.2 `deal_dates`, R-TXN-1..6).
//
// A milestone is a `deal_dates` row. A template proposes dates; a person confirms them; confirming
// computes the stored instants (`due_at`, `reminder_at`) once, in the tenant zone, and records the
// zone in `basis` (R-TXN-2, R-OWN-27). Nothing here reads a clock: `now` is always passed in.
import type { DealDateId, Instant, LocalDate, UserId, Weekday } from '../foundation/index.js';

/** deal_dates.kind (0001). */
export type MilestoneKind = 'acceptance' | 'inspection' | 'appraisal' | 'financing' | 'closing' | 'possession' | 'custom';
export const MILESTONE_KINDS: readonly MilestoneKind[] = ['acceptance', 'inspection', 'appraisal', 'financing', 'closing', 'possession', 'custom'];

/** deal_dates.responsible (0018). */
export type Responsible = 'buyer' | 'seller' | 'lender' | 'title' | 'agent' | 'tc' | 'other';
export const RESPONSIBLE_PARTIES: readonly Responsible[] = ['buyer', 'seller', 'lender', 'title', 'agent', 'tc', 'other'];

/** deal_dates.source (0018). */
export type DateSource = 'manual' | 'template' | 'document' | 'import';

/** deal_dates.status (0018). Completion is `completed_at` alone, never a status. */
export type DateStatus = 'proposed' | 'confirmed' | 'waived';

/** deals.side (0001). */
export type DealSide = 'buy' | 'sell' | 'dual' | 'lease';

/**
 * How a template rule counts days from the anchor. **VERIFY WITH COUNSEL** (C9): contract forms
 * differ on whether "N days" means calendar or business days, which days are business days, which
 * holidays count, and whether a deadline on a weekend or holiday rolls. The template states it; core
 * never assumes a state's convention and never rolls a date on its own (E95).
 */
export type DayCount = 'calendar' | 'business';

/** One rule of a milestone template: "inspection 10 business days after acceptance". */
export interface TemplateRule {
  /** Stable key within the template (also the trigger step suffix). */
  key: string;
  kind: MilestoneKind;
  /** Required for `custom`. */
  label?: string;
  /** Days after the anchor date (0 = the anchor date itself). */
  offsetDays: number;
  dayCount: DayCount;
  responsible?: Responsible;
  /** Days before the due date the reminder fires; absent = no reminder. */
  reminderDaysBefore?: number;
}

/**
 * Tenant data (`tenant_settings.milestone_templates`), per side and jurisdiction. Shipped and
 * entered templates are unreviewed until counsel reviews them (R-TXN-6, **VERIFY WITH COUNSEL**);
 * `reviewed` is shown, never assumed.
 */
export interface MilestoneTemplate {
  id: string;
  version: number;
  name: string;
  side: DealSide;
  /** e.g. 'US-TX'; free text matched exactly, never inferred. */
  jurisdiction: string;
  reviewed: boolean;
  rules: TemplateRule[];
}

/**
 * Which local dates are business days for counting. **VERIFY WITH COUNSEL** (C9): the weekday set
 * and the holiday list are data supplied by the tenant (or a reviewed pack), never hard-coded here.
 */
export interface BusinessDayCalendar {
  days: ReadonlySet<Weekday>;
  /** Local date → holiday name. */
  holidays: ReadonlyMap<LocalDate, string>;
  /** Where the calendar came from (shown in the basis), e.g. 'tenant_settings'. */
  source: string;
  reviewed: boolean;
}

/** What a proposed date was computed from (stored in `deal_dates.basis`). */
export interface TemplateBasis {
  kind: 'template';
  templateId: string;
  templateVersion: number;
  templateReviewed: boolean;
  ruleKey: string;
  /** One sentence, e.g. "10 business days after acceptance (2026-03-02)". */
  rule: string;
  anchorDate: LocalDate;
  offsetDays: number;
  dayCount: DayCount;
  calendarSource?: string;
  calendarReviewed?: boolean;
}

export interface ManualBasis {
  kind: 'manual';
}

export interface DocumentBasis {
  kind: 'document';
  /** assistant_claims.id holding the page/char-range evidence (R-DOC-2). */
  claimId: string;
}

export interface ImportBasis {
  kind: 'import';
  importBatchId?: string;
}

export type ProposalBasis = TemplateBasis | ManualBasis | DocumentBasis | ImportBasis;

/** The basis stored at confirm time: the proposal basis plus the instants' rule and zone. */
export type Basis = ProposalBasis & {
  /** tenant_settings.default_timezone at confirm time (R-TXN-2). */
  zone: string;
  dueRule: 'end_of_local_day';
  reminderRule: { daysBefore: number; localTime: string } | null;
};

/** A date that lands on a day that is not a business day. Shown, never acted on (E95). */
export interface NonBusinessDayNote {
  reason: 'weekend' | 'holiday';
  /** Holiday name when `reason = 'holiday'`. */
  holiday?: string;
  /** Plain sentence for the confirm screen. */
  note: string;
}

/** A template proposal: drives nothing until a person confirms it (R-TXN-1). */
export interface ProposedDate {
  status: 'proposed';
  source: 'template';
  ruleKey: string;
  kind: MilestoneKind;
  label: string;
  dueOn: LocalDate;
  responsible: Responsible | null;
  reminderDaysBefore: number | null;
  basis: TemplateBasis;
  nonBusinessDay: NonBusinessDayNote | null;
}

/** The stored fields of an existing deal date that confirmDate and the risk rule read. */
export interface DealDate {
  id: DealDateId;
  kind: MilestoneKind;
  label: string | null;
  dueOn: LocalDate;
  source: DateSource;
  status: DateStatus;
  dueVersion: number;
  dueAt: Instant | null;
  reminderAt: Instant | null;
  completedAt: Instant | null;
  responsible: Responsible | null;
  basis: Basis | ProposalBasis | Record<string, never>;
}

/** Who is writing. The database enforces the same (`deal_dates_confirm_guard`). */
export type DateActor = { kind: 'user'; userId: UserId } | { kind: 'system' };

export interface ConfirmInput {
  actor: DateActor;
  dueOn: LocalDate;
  /** The row's source; for a new row this is the source it is created with. */
  source: DateSource;
  /** null/absent = no reminder. */
  reminderDaysBefore?: number | null;
  /** Local time of the reminder, 'HH:MM'. Default 09:00. */
  reminderLocalTime?: string;
  /** The proposal basis (template rule, document claim); absent = the previous basis or manual. */
  basis?: ProposalBasis;
  now: Instant;
}

export type TransactionErrorCode =
  | 'DATE_HUMAN_CONFIRMATION' // a person confirms, enters (manual) and moves confirmed dates (R-TXN-1)
  | 'DATE_COMPLETED' // a completed milestone is not re-confirmed
  | 'DATE_WAIVED' // a waived milestone is not confirmed again (re-propose it instead)
  | 'REMINDER_INVALID'
  | 'TEMPLATE_INVALID'
  | 'TEMPLATE_SIDE_MISMATCH';

export interface ConfirmedInstants {
  dueAt: Instant;
  reminderAt: Instant | null;
  dueVersion: number;
  basis: Basis;
}

/** R-ACC-6 predicates. */
export type RiskPredicate = 'overdue' | 'due_soon_unassigned';

export interface MilestoneRisk {
  /** exception_items key `milestone:{deal_date}:{due_version}`. */
  key: string;
  dealDateId: DealDateId;
  dueVersion: number;
  /** The predicates that hold, the primary first (`overdue` before `due_soon_unassigned`). */
  predicates: RiskPredicate[];
  /** When the primary predicate started holding, from stored fields only. */
  detectedAt: Instant;
  /** Plain sentence naming which predicate holds (the evidence). */
  evidence: string;
}
