// Shared vocabulary of core/assistant (BUILD_PLAN module 4; DATA_MODEL §1.6, §1.7, R-AST-*).
//
// Every string union mirrors a CHECK constraint in packages/db/migrations/0001_init.sql, so values
// read from the database can be passed straight in after the API has validated them.
//
// There are deliberately no confidence fields anywhere in this module (A2, R-AST-13): the agent
// sees evidence (source + locator + snippet + a short explanation) and a needs-review flag.
import type { AssistantClaimId, IanaZone, Instant } from '../foundation/index.js';

/**
 * evidence_refs.source_type. 'home_valuation' (module 26, a home-value note's claim: R-AVM-1) is in the union
 * only, not in SOURCE_TYPES: core/priority's evidence enum spreads SOURCE_TYPES, and a model never cites it.
 * 'document' (module 42, a contract date's claim: R-DOC-2) is in the union only, for the same reasons.
 */
export type SourceType = 'call' | 'message' | 'email' | 'note' | 'listing' | 'import' | 'behavior_event' | 'deal' | 'task' | 'appointment' | 'home_valuation' | 'document';
export const SOURCE_TYPES: readonly SourceType[] = ['call', 'message', 'email', 'note', 'listing', 'import', 'behavior_event', 'deal', 'task', 'appointment'];

/** evidence_refs.locator (jsonb with a `kind` key). */
export type Locator =
  | { kind: 'transcript_offset'; startMs: number; endMs: number }
  | { kind: 'message' }
  | { kind: 'char_range'; start: number; end: number }
  | { kind: 'field'; name: string };

/** A pointer from a claim to the exact words in a source (A2). `snippet` is verbatim. */
export interface EvidenceRef {
  sourceType: SourceType;
  sourceId: string;
  locator: Locator;
  snippet: string;
}

/** An evidence ref after `verifyQuote` ran (evidence_refs.verbatim_verified). */
export interface CheckedEvidenceRef extends EvidenceRef {
  verified: boolean;
  /** Why verification failed (absent when verified). */
  reason?: QuoteFailure;
}

export type QuoteFailure = 'NOT_FOUND' | 'OUT_OF_RANGE';

/** assistant_claims.claim_kind */
export type ClaimKind = 'commitment' | 'preference' | 'date_time' | 'fact' | 'qualification' | 'client_statement' | 'sent_summary' | 'suggestion';
export const CLAIM_KINDS: readonly ClaimKind[] = ['commitment', 'preference', 'date_time', 'fact', 'qualification', 'client_statement', 'sent_summary', 'suggestion'];

/** Resolved date of a date-bearing claim (R-AST-2: both the quote and the resolved date are shown). */
export interface ResolvedDue {
  /** Local start of day when `allDay`. */
  at: Instant;
  allDay: boolean;
  zone: IanaZone;
  /** The phrase as the client said it (it appears in a verified snippet). */
  phrase: string;
  /** The instant the words were said: the source timestamp the phrase was resolved against. */
  saidAt: Instant;
  /** Agent-facing rendering, e.g. "Thu Nov 12, 4 PM". */
  display: string;
}

/**
 * One atomic statement shown to the agent (assistant_claims + evidence_refs).
 *
 * Spec corrections (reported): the BUILD_PLAN sketch had no `id`/`ordinal` and used plain
 * `EvidenceRef[]`. The id is needed to bind saved-search criteria to claims
 * (`saved_searches.criterion_evidence`) and promise tasks to their claim; the per-ref `verified`
 * flag is what the API stores in `evidence_refs.verbatim_verified` (R-AST-1).
 */
export interface Claim {
  id: AssistantClaimId;
  ordinal: number;
  kind: ClaimKind;
  /** 1..300 chars (DB CHECK). */
  text: string;
  structured?: ClaimStructured;
  evidence: CheckedEvidenceRef[];
  needsReview: boolean;
  /** Machine-readable reasons the claim needs review (never shown as a score). */
  reviewReasons: ReviewReason[];
}

export type ReviewReason =
  | 'NO_EVIDENCE'
  | 'QUOTE_NOT_VERIFIED'
  | 'MODEL_FLAGGED'
  | 'DATE_UNRESOLVED'
  | 'DATE_AMBIGUOUS'
  | 'DATE_PHRASE_NOT_QUOTED'
  | 'DATE_MISMATCH'
  | 'TEXT_TRUNCATED'
  | 'UNKNOWN_KIND'
  | 'STRUCTURED_INVALID'
  | 'CRITERION_NOT_QUOTED';

/** `assistant_claims.structured`: validated, never raw model output. */
export interface ClaimStructured {
  due?: ResolvedDue | null;
  /** A saved-search criterion this claim supports (search proposals, A4). */
  criterion?: { key: string; value: unknown };
  [k: string]: unknown;
}

/** ai_runs.purpose */
export type AiPurpose =
  | 'draft'
  | 'call_summary'
  | 'claims_extraction'
  | 'handback_enrichment'
  | 'lead_summary'
  | 'first_response'
  | 'search_proposal'
  | 'pond_summary'
  | 'opt_out_review';
export const AI_PURPOSES: readonly AiPurpose[] = [
  'draft',
  'call_summary',
  'claims_extraction',
  'handback_enrichment',
  'lead_summary',
  'first_response',
  'search_proposal',
  'pond_summary',
  'opt_out_review',
];

/**
 * Tenant and sender identity the assistant speaks for (tenant_settings + the playbook scope).
 * `teamName` is tenant_settings.team_name, or the tenant name when that is null.
 */
export interface IdentityFacts {
  brokerageLegalName: string;
  teamName: string;
  /** First name of the agent the assistant works for (agent-scoped playbooks and drafts). */
  agentFirstName: string | null;
  /** Whose assistant this is: the team's (team playbooks) or the agent's (agent playbooks). */
  scope: 'team' | 'agent';
  /** Hosts the assistant may link to (the team's own sites). Anything else is an unknown link. */
  allowedLinkHosts: readonly string[];
  brokeragePostalAddress: string | null;
}

/** Codes core/assistant returns as `{ ok: false, code }` (CONVENTIONS §7). */
export type AssistantErrorCode =
  | 'DRAFT_STALE'
  | 'DRAFT_INVALIDATED'
  | 'SLOT_MISSING'
  | 'SLOT_NEEDS_REVIEW'
  | 'STEP_CHANNEL_UNAVAILABLE'
  | 'ENROLLMENT_REPLACE_NEEDS_CONFIRMATION'
  | 'ALREADY_ENROLLED'
  | 'PLAYBOOK_INVALID';

/** DB limits mirrored here so core output always fits (0001_init.sql). */
export const CLAIM_TEXT_MAX = 300;
export const EXPLANATION_MAX = 300;
export const SNIPPET_MAX = 500;
