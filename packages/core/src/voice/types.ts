// Shared vocabulary of core/voice (PHASE2_3_PLAN §5.4 module 47; DATA_MODEL R-VOICE-1…10).
//
// Every closed set here mirrors a CHECK in the 0018 schema (calls, voice_tool_calls, appointments);
// packages/db/test/voice_core_equivalence.test.ts compares them with a freshly migrated catalog, so a
// drift on either side fails a test. There are deliberately no confidence fields (R-AST-13).
import type { Claim, IdentityFacts } from '../assistant/index.js';
import type { Keywords, ReachabilityInput } from '../compliance/index.js';
import type { FairHousingPack } from '../fairhousing/index.js';
import type { BusinessCalendar, CallId, ContactId, Instant, PlaybookVersionId } from '../foundation/index.js';
import type { MemberFacts } from '../ownership/index.js';
import type { VoiceContent } from '../assistant/index.js';

// ---- closed sets (DB mirrors) ---------------------------------------------------------------------

/** voice_tool_calls.tool CHECK: the closed set of ledger tools (R-VOICE-4). */
export const VOICE_LEDGER_TOOLS = ['check_availability', 'book_appointment', 'warm_transfer', 'take_message', 'record_opt_out', 'end_call'] as const;
export type VoiceLedgerTool = (typeof VOICE_LEDGER_TOOLS)[number];

/** calls.voice_outcome CHECK. */
export const VOICE_OUTCOMES = ['booked', 'transferred', 'message_taken', 'caller_ended', 'opted_out', 'fallback_voicemail', 'error'] as const;
export type VoiceOutcome = (typeof VOICE_OUTCOMES)[number];

/** calls.transfer_outcome CHECK. */
export const TRANSFER_OUTCOMES = ['connected', 'no_answer', 'declined'] as const;
export type TransferOutcome = (typeof TRANSFER_OUTCOMES)[number];

/** appointments.kind CHECK (book_appointment's optional `kind`). */
export const APPOINTMENT_KINDS = ['buyer_consult', 'listing_appointment', 'consult', 'other'] as const;
export type AppointmentKind = (typeof APPOINTMENT_KINDS)[number];

/** record_opt_out's `channel` (app.voice_tool_args_ok). */
export const OPT_OUT_TOOL_CHANNELS = ['voice', 'sms', 'all'] as const;
export type OptOutToolChannel = (typeof OPT_OUT_TOOL_CHANNELS)[number];

/** tenant_settings.voice_answer_when CHECK. */
export const VOICE_ANSWER_WHEN = ['missed_and_after_hours', 'after_hours_only'] as const;
export type VoiceAnswerWhen = (typeof VOICE_ANSWER_WHEN)[number];

/**
 * take_message's `topic`: a closed set of codes, stricter than the DB's any-code pattern, so a model
 * cannot spell a caller's name or number into the ledger as a "code".
 */
export const MESSAGE_TOPICS = ['GENERAL', 'CALLBACK', 'SHOWING', 'BUYING', 'SELLING', 'LISTING', 'PRICE', 'OFFER', 'CONTRACT', 'COMMISSION', 'LEGAL', 'LENDING', 'AREA_QUESTION', 'LANGUAGE'] as const;
export type MessageTopic = (typeof MESSAGE_TOPICS)[number];

/** end_call's `reason_code`: a closed set, for the same reason. */
export const END_CALL_REASONS = ['CALLER_DONE', 'GOODBYE', 'MESSAGE_TAKEN', 'BOOKED', 'OPTED_OUT'] as const;
export type EndCallReason = (typeof END_CALL_REASONS)[number];

// ---- reason codes (voice_tool_calls.reason_code ^[A-Z][A-Z0-9_]*$) -----------------------------

/** Why core allowed a tool request (an allow carries a code too). */
export const VOICE_ALLOW_REASONS = ['ALLOW_AVAILABILITY', 'ALLOW_OFFERED_SLOT', 'ALLOW_OWNER_TRANSFER', 'ALLOW_MESSAGE', 'ALLOW_OPT_OUT_HEARD', 'ALLOW_END_CALL'] as const;
export type VoiceAllowReason = (typeof VOICE_ALLOW_REASONS)[number];

/**
 * Codes core/voice returns for a refusal (CONVENTIONS §7): every deny reason of decideToolCall.
 * VOICE_TOOL_BEFORE_DISCLOSURE is the DB guard's own code (app.voice_tool_calls_guard).
 */
export const VOICE_ERROR_CODES = [
  'VOICE_SESSION_ENDED',
  'VOICE_TOOL_BEFORE_DISCLOSURE',
  'VOICE_TOOL_UNKNOWN',
  'VOICE_TOOL_ARGS_INVALID',
  'VOICE_TOOL_NOT_ENABLED',
  'VOICE_TRANSFER_PENDING',
  'VOICE_OPTED_OUT',
  'CONTACT_NOT_OWNED',
  'SLOT_NOT_OFFERED',
  'ALREADY_BOOKED',
  'BOOKING_PENDING',
  'TRANSFER_NOT_OWNER',
  'TRANSFER_UNAVAILABLE',
  'TRANSFER_ALREADY_TRIED',
  'CALLER_NOT_HOT',
  'OPT_OUT_NOT_HEARD',
] as const;
export type VoiceErrorCode = (typeof VOICE_ERROR_CODES)[number];

export type VoiceReasonCode = VoiceAllowReason | VoiceErrorCode;
export const VOICE_REASON_CODES: readonly VoiceReasonCode[] = [...VOICE_ALLOW_REASONS, ...VOICE_ERROR_CODES];

/** Why a session ended (handback reason; codes only). */
export const VOICE_END_REASONS = [
  'CALLER_HUNG_UP',
  'MODEL_ENDED_CALL',
  'TRANSFER_CONNECTED',
  'MAX_CALL_SECONDS',
  'SILENCE',
  'VENDOR_ERROR',
  'TURN_LATENCY',
  'DISCLOSURE_FAILED',
  'ANNOUNCEMENT_FAILED',
  'ANNOUNCEMENT_DECLINED',
  'PLAYBACK_TIMEOUT',
  'UNCOVERED_LANGUAGE',
] as const;
export type VoiceEndReason = (typeof VOICE_END_REASONS)[number];

// ---- facts ------------------------------------------------------------------------------------------

/** playbook_versions.status */
export type PlaybookVersionStatus = 'draft' | 'approved' | 'superseded' | 'revoked';

/** The voice playbook version a call would run under (read in the call-start transaction). */
export interface VoicePlaybookFacts {
  versionId: PlaybookVersionId;
  /** playbooks.kind; anything but `voice_answering` is refused. */
  kind: string;
  status: PlaybookVersionStatus;
  /** playbook_versions.steps as stored (a PlaybookContent object of kind 'voice'). */
  content: unknown;
}

/** The call-start facts shouldAnswer needs (calls row being created). */
export interface CallFacts {
  callId: CallId;
  direction: 'inbound' | 'outbound';
  /** calls.initiator */
  initiator: 'human' | 'assistant' | 'system' | 'client' | 'import';
  /** The tenant's voice_answering version, if any. */
  playbook: VoicePlaybookFacts | null;
  /** The identity the assistant speaks for: the content's disclosure must not claim to be a person. */
  identity?: IdentityFacts;
}

/** The `platform:voice` clearance pack (R-INT-6): cleared = published + reviewed_by_counsel_at + rules.vendor_ready_at. */
export interface PlatformVoicePack {
  status: 'draft' | 'published' | 'retired';
  reviewedByCounselAt: Instant | null;
  /** rules.vendor_ready_at (set once a real vendor passed the latency spike, N12). */
  vendorReadyAt: string | null;
}

/** What shouldAnswer reads from tenant_settings, the active compliance policy and the platform pack. */
export interface VoiceSettings {
  /** tenant_settings.voice_answer_after_seconds (10–60, default 20). */
  answerAfterSeconds: number;
  /** tenant_settings.voice_answer_when. */
  answerWhen: VoiceAnswerWhen;
  /** compliance_policy_versions.voice_answering_enabled of the active policy (Owner only, R-VOICE-9). */
  answeringEnabled: boolean;
  /** compliance_policy_versions.voice_answering_attestation. */
  attestation: string | null;
  platform: PlatformVoicePack;
}

/** One slot the owner's free/busy offered (module 34 supplies it; core never invents one). */
export interface OfferedSlot {
  start: Instant;
  end: Instant;
}

/** The contact the call is about (transferTarget, booking). */
export interface ContactFacts {
  /** null: the caller is not (yet) a contact the tenant knows. */
  contactId: ContactId | null;
  /** The contact's current owner, with membership status and accepting_leads; null when unowned. */
  owner: MemberFacts | null;
  /** The tenant routing hours (08:00–21:00 tenant zone by default). */
  routingHours: BusinessCalendar;
  /**
   * How long a hot caller holds for the owner (R-VOICE-6). Module 48 resolves the source (the pack's
   * `voice_transfer_hold_seconds`, else the content's transferHoldSeconds). VERIFY (pack value). Default 20.
   */
  holdSeconds?: number;
}

/** core/assistant's Claim with its review status (assistant_claims.review_status). */
export type ClaimReviewStatus = 'unreviewed' | 'confirmed' | 'corrected' | 'rejected';
export type VerifiedClaim = Claim & { reviewStatus: ClaimReviewStatus };

/**
 * One hot-lead criterion over usable claims (claim kinds and structured criteria only). It cannot
 * express a contact attribute, a prediction band or a call score (R-PRED-4, R-COACH-5): those fields
 * do not exist and parseHotRule rejects any other key.
 */
export interface HotCriterion {
  /** The claim kind that counts. */
  claimKind: Claim['kind'];
  /** Only claims whose structured criterion has this key (and, when given, one of these values). */
  criterionKey?: string;
  criterionValues?: readonly (string | number | boolean)[];
  /** How many usable claims must match (default 1). */
  atLeast?: number;
}

/** The hot-lead rule: hot when ANY criterion holds. No default ships (an Owner or product decision). */
export interface HotRule {
  anyOf: readonly HotCriterion[];
}

/** The person-level and address-level opt-out facts of the caller's contact (E112, R-PAR-12). */
export interface OptOutFacts {
  /** The content-independent reachability input (removed phones that still count included). */
  reach: ReachabilityInput;
  /** contacts.do_not_contact (person-level, R-CHAN-3). */
  personDoNotContact: boolean;
}

/** Everything core/voice reads during one session. Read at session start; never re-read (E150). */
export interface VoiceFacts {
  callId: CallId;
  /** The approved content the session runs under (approvedVoiceContent). */
  content: VoiceContent;
  contact: ContactFacts;
  /** Claims known before the call (in-call claims arrive as `claims` events). */
  claims: readonly VerifiedClaim[];
  /** null: no hot rule configured, so nobody is transferred live. */
  hotRule: HotRule | null;
  /** Slots from the owner's free/busy; book_appointment can only take one of these. */
  offeredSlots: readonly OfferedSlot[];
  keywords: Keywords;
  optOuts: OptOutFacts;
  /** Languages the content covers (E119; VoiceContent names none). Codes as the STT reports them. */
  coveredLanguages: readonly string[];
  /** platform:voice rules.max_turn_latency_ms (seeded 1500). VERIFY (vendor, N12). */
  maxTurnLatencyMs: number;
  identity: IdentityFacts;
  fairHousing?: FairHousingPack;
  /** Silence before a re-prompt when the vendor sends no silence event. Default 8. VERIFY (vendor). */
  silenceSeconds?: number;
  /** Re-prompts before voicemail. Default 2. */
  maxSilenceReprompts?: number;
  /** How long the disclosure or the announcement may take to report played. Default 60. VERIFY (vendor). */
  playbackTimeoutSeconds?: number;
}

/** A tool request from the voice model: untrusted (any tool name, any arguments). */
export interface ToolRequest {
  tool: string;
  args: unknown;
  at: Instant;
}

/** The voice_tool_calls row a request is logged as (null when the tool is outside the closed set). */
export interface LedgerRow {
  tool: VoiceLedgerTool;
  /** Allowlisted keys with valid string values only: always passes app.voice_tool_args_ok. */
  args: Record<string, string>;
}

export interface ToolDecision {
  decision: 'allow' | 'deny';
  reason: VoiceReasonCode;
  /** Added to the plan's signature: the allowlisted ledger projection of the request. */
  ledger: LedgerRow | null;
}

