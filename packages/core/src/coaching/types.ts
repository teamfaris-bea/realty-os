// Shared vocabulary of core/coaching (PHASE2_3_PLAN module 35; DATA_MODEL "Coaching", R-COACH-1…7).
//
// String unions mirror CHECK constraints: `call_scores.items[].status` and `rubric_version`
// (0018_phase2_3_schema.sql), `recordings.consent_basis` / `recordings.source` and
// `calls.handled_by` (0001_init.sql, widened by 0018).
//
// R-COACH-6: there is deliberately no numeric overall score, percentage, grade, rank, leaderboard,
// voice-tone or sentiment field anywhere in this module. A call review is a list of observable
// checks with verified quotes, summarised as "6 of 8 checks".
import type { AssistantClaimId, CallId, Instant, LocalDate } from '../foundation/index.js';
import type { EvidenceRef, SourceText } from '../assistant/index.js';

/** `call_scores.rubric_version` (CHECK `^rubric/[0-9]+$`). */
export type RubricVersion = `rubric/${number}`;
export const RUBRIC_VERSION_RE = /^rubric\/[0-9]+$/;

/** One observable, behaviour-based check (R-COACH-6: never tone, sentiment or personality). */
export interface RubricItem {
  /** Stable snake_case key, stored in `call_scores.items[].key` and `coaching_rubric_disabled`. */
  key: string;
  /** Short label shown on the card ("Asked about timeline"). */
  label: string;
  /** One line: what good looks like on a call. */
  good: string;
  /** A short, concrete thing to try next call. */
  tip: string;
}

export interface Rubric {
  version: RubricVersion;
  items: readonly RubricItem[];
}

// ---- eligibility (R-COACH-1, R-COACH-3, E104) ---------------------------------------------------

/** calls.handled_by */
export type CallHandledBy = 'human' | 'voicemail' | 'assistant';
/** recordings.consent_basis */
export type ConsentBasis = 'announced_all_parties' | 'one_party_policy' | 'unknown_imported';
/** recordings.source */
export type RecordingSource = 'provider' | 'import_fub';

/** What the API knows about one call when deciding whether to review it. */
export interface CallReviewFacts {
  handledBy: CallHandledBy;
  /** calls.imported */
  imported: boolean;
  /** The call's recording, or null when there is none. */
  recording: { source: RecordingSource; consentBasis: ConsentBasis } | null;
  /** A transcript exists for the recording. */
  hasTranscript: boolean;
  /** tenant_settings.call_scoring_enabled (the Owner's switch). */
  callScoringEnabled: boolean;
  /** `platform:coaching` pack is cleared (app.platform_cleared). */
  coachingPackCleared: boolean;
}

export type IneligibleReason =
  | 'pack_not_cleared'
  | 'scoring_off'
  | 'not_human_handled'
  | 'imported_call'
  | 'no_recording'
  | 'imported_recording'
  | 'consent_basis_not_allowed'
  | 'no_transcript';

export type ReviewEligibility = { eligible: true } | { eligible: false; reason: IneligibleReason };

// ---- scoring (R-COACH-2, E105) ------------------------------------------------------------------

/** A call transcript (the only source a call review may quote). */
export type CallTranscript = Extract<SourceText, { kind: 'transcript' }>;

/** What the model may claim about one rubric item. */
export type ClaimedStatus = 'met' | 'missed' | 'not_applicable';

/** One model output for one rubric item (an `assistant_claims` row of the review action). */
export interface RubricClaim {
  itemKey: string;
  status: ClaimedStatus;
  evidence: readonly EvidenceRef[];
  claimId: AssistantClaimId;
}

/** `call_scores.items[].status` */
export type ItemStatus = 'met' | 'missed' | 'not_applicable' | 'needs_review';

export interface ScoredItem {
  key: string;
  status: ItemStatus;
  claimId: AssistantClaimId | null;
  /** Verified evidence refs only (empty for needs_review). */
  quotes: EvidenceRef[];
}

/**
 * One call's review, matching a `call_scores` row. `scoredCount` counts met + missed items (the
 * denominator); needs_review and not_applicable items leave it. Always `metCount <= scoredCount`.
 */
export interface CallScore {
  rubricVersion: RubricVersion;
  items: ScoredItem[];
  metCount: number;
  scoredCount: number;
}

export interface ScoreOptions {
  /** tenant_settings.coaching_rubric_disabled: items turned off are omitted. */
  disabledKeys?: readonly string[];
}

// ---- daily fix (R-COACH-4, E106) ----------------------------------------------------------------

/** One scored call of the agent, as the API loads it. */
export interface ScoredCall {
  callId: CallId;
  /** When the call happened (calls.started_at). */
  occurredAt: Instant;
  score: CallScore;
}

/** A tap-to-play quote: the call and the verified ref inside it. */
export interface FixQuote {
  callId: CallId;
  ref: EvidenceRef;
}

export interface Fix {
  /** The agent's local day this fix is for (one per agent per local day). */
  localDate: LocalDate;
  itemKey: string;
  label: string;
  tip: string;
  /** Calls among the considered ones where this item was missed. */
  missedIn: number;
  /** Scored calls considered (3..10). */
  callsConsidered: number;
  /** "Missed in 4 of the last 10 calls". */
  text: string;
  /** Up to two verified quotes from the most recent misses. */
  quotes: FixQuote[];
}

export type NoFixReason = 'not_enough_calls' | 'nothing_missed' | 'all_dismissed';

export type DailyFixResult = { fix: Fix } | { fix: null; reason: NoFixReason };

export interface DailyFixOptions {
  /** Labels and tips come from this rubric; keys not in it are ignored. Default RUBRIC_V1. */
  rubric?: Rubric;
  /** Items turned off by the tenant are never suggested. */
  disabledKeys?: readonly string[];
}

// ---- trend (R-COACH-7) --------------------------------------------------------------------------

export type TrendDirection = 'improving' | 'slipping' | 'steady' | 'not_enough_data';

/** One item in one window: how many scored calls met it, out of how many scored it (n). */
export interface TrendWindow {
  met: number;
  n: number;
  /** met / n as a fraction 0..1 for this one item, or null when n = 0 (never an overall score). */
  metRate: number | null;
}

/** Aggregates only (R-COACH-7): no quotes, call ids or contact ids. */
export interface TrendItem {
  key: string;
  label: string;
  before: TrendWindow;
  after: TrendWindow;
  direction: TrendDirection;
}

export interface TrendOptions {
  /** The rubric both windows were scored with. Default RUBRIC_V1. */
  rubric?: Rubric;
  /** Minimum scored calls (met or missed) for the item in EACH window. Default 5. */
  minScored?: number;
  /** A met-rate change smaller than this many percentage points is steady. Default 10. */
  steadyBelowPoints?: number;
  /** Items turned off by the tenant are omitted. */
  disabledKeys?: readonly string[];
}
