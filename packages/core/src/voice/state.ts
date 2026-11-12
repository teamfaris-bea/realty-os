// The session state of one AI-answered call (the policy machine's state; see ./machine.ts).
import type { CallId, Instant, UserId } from '../foundation/index.js';
import type { InboundClassification } from '../compliance/index.js';
import type { ScopeCategory } from './lexicon.js';
import type { AppointmentKind, LedgerRow, MessageTopic, OfferedSlot, TransferOutcome, VerifiedClaim, VoiceEndReason, VoiceOutcome, VoiceReasonCode } from './types.js';

export type VoicePhase = 'disclosing' | 'announcing' | 'conversing' | 'transferring' | 'ended';

/** What the session is waiting for (the "never silent" bound runs on it). */
export interface Waiting {
  for: 'platform' | 'model' | 'caller' | 'booking' | 'transfer';
  since: Instant;
}

/** One logged tool request: exactly what module 48 writes to voice_tool_calls. */
export interface LedgerEntry {
  seq: number;
  at: Instant;
  decision: 'allow' | 'deny';
  reason: VoiceReasonCode;
  /** null: the tool is outside the closed set (where it is recorded is module 48's question, gap (f)). */
  row: LedgerRow | null;
}

/** A detail the agent must check before trusting it (R-VOICE-7, R-AST-5): never an appointment time. */
export type NeedsReviewItem =
  | { code: 'POSSIBLE_OPT_OUT' }
  | { code: 'UNCONFIRMED_SLOT'; slot: OfferedSlot }
  | { code: 'SLOT_NOT_OFFERED'; slot: OfferedSlot | null }
  | { code: 'CLAIM_NEEDS_REVIEW'; claimId: string };

export interface HeardOptOut {
  kind: 'stop' | 'opt_out_language';
  scope: NonNullable<InboundClassification['scope']>;
  /** The channel record_opt_out is logged with: 'voice' for a keyword, 'all' for person scope. */
  channel: 'voice' | 'all';
  classification: InboundClassification;
}

export interface VoiceState {
  callId: CallId;
  phase: VoicePhase;
  startedAt: Instant;
  disclosedAt: Instant | null;
  announcedAt: Instant | null;
  waiting: Waiting;
  reprompts: number;
  optOut: HeardOptOut | null;
  booking: { slot: OfferedSlot; kind: AppointmentKind; status: 'pending' | 'booked' } | null;
  failedSlots: OfferedSlot[];
  transfer: { userId: UserId; holdEndsAt: Instant; outcome: TransferOutcome | null } | null;
  messageTaken: boolean;
  messageTopics: MessageTopic[];
  categories: (ScopeCategory | 'fair_housing' | 'language')[];
  agentNotes: string[];
  needsReview: NeedsReviewItem[];
  /** In-call claims (module 48 normalizes them from the transcript). */
  claims: VerifiedClaim[];
  ledger: LedgerEntry[];
  outcome: VoiceOutcome | null;
  endReason: VoiceEndReason | null;
}
