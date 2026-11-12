// Shared vocabulary of core/priority (BUILD_PLAN module 5; DATA_MODEL §1.9, R-ACC-1/2/4/5,
// R-AST-12, R-AST-15, R-IMPORT-6).
//
// Every string union mirrors a CHECK constraint in packages/db/migrations/0001_init.sql, so values
// read from the database can be passed straight in after the API has validated them.
//
// R-AST-12 (fair housing): NO input type in this file has a field for contact attributes, protected
// proxies (VA, PCS, military status, source of income ...), sensitivity, demographics, or any open
// index signature that could carry them. `priority/types.test.ts` asserts this at compile time.
// VERIFY WITH COUNSEL (protected-class list per jurisdiction).
//
// There are no confidence or probability fields anywhere here (A2, R-AST-13): the feed explains
// itself with reasons, exceptions with evidence.
import type {
  ActionCategory,
  Channel,
} from '../compliance/index.js';
import type {
  AppointmentId,
  AssistantActionId,
  CallId,
  ContactId,
  DealDateId,
  DealId,
  IanaZone,
  Instant,
  LeadInquiryId,
  ListingId,
  LocalDate,
  MessageId,
  PondId,
  SavedSearchId,
  TaskId,
  UserId,
} from '../foundation/index.js';
import type { Locator, SourceType } from '../assistant/index.js';

// ---- shared fact pieces --------------------------------------------------------------------------

/** Who created a task / appointment (tasks.created_by_kind, appointments.created_by_kind). */
export type CreatedByKind = 'user' | 'assistant' | 'system' | 'import';

/**
 * One communication that may count as a human touch / an answer to the client.
 *
 * - `direction: 'outbound'`: an outbound message or call. It is a **touch** (R-OWN-14) only when it
 *   is human-initiated, not imported, and the send-time gate allowed it (`gateAllowed`: the message
 *   reached TX1 `dispatching`, or the dial-time decision allowed the call). A later provider failure
 *   does not undo a touch (it raises `failed_send`).
 * - `direction: 'inbound_answered'`: an inbound call a person picked up. It answers a waiting client
 *   in the feed but is never a scoreboard touch (touches are human outbound only, R-ACC-4).
 *
 * Assistant, system and imported rows never count (R-AST-15, R-IMPORT-6).
 */
export interface TouchFacts {
  kind: 'message' | 'call';
  direction: 'outbound' | 'inbound_answered';
  initiator: 'human' | 'assistant' | 'system' | 'import';
  imported: boolean;
  gateAllowed: boolean;
  at: Instant;
  byUserId: UserId | null;
}

/** Why a channel cannot be used right now for a contact (from the gate's last decision / points). */
export interface ChannelBlock {
  /**
   * deny: the gate would not let anyone send now (opted out, suppressed, …). `unavailable`: the
   * contact has no usable number or address for the channel.
   */
  outcome: 'deny' | 'unavailable';
  /** The gate's human explanation ("Opted out of texts"). */
  explanation: string;
}

/**
 * Per-contact summary of blocked channels for the feed (contacts absent from the map have no known
 * block). It is a display hint only: every send is re-checked by canContact at send time (R-GATE-1).
 */
export type GateSummary = Partial<Record<Channel, ChannelBlock>>;

// ---- feed inputs ---------------------------------------------------------------------------------

/** A live lead offer to a user (contacts.offer_* of an `offered` contact). */
export interface OfferFacts {
  contactId: ContactId;
  offerId: string;
  offeredToUserId: UserId;
  offeredAt: Instant;
  expiresAt: Instant;
  /** Lead source display name (lead_sources.name), shown as a reason. Never a person's name. */
  sourceName?: string | null;
}

/**
 * One ownership period that started a first-touch SLA (a `v_speed_to_lead` row joined with the
 * period's end). `firstTouchAt` is the ledger's `first_touch_recorded` instant, which only a human
 * touch writes (R-OWN-14); assistant, system and imported messages never produce it (R-AST-15).
 *
 * The period's first-touch window ends at whichever comes first: the lead leaving the agent
 * (`periodEndedAt`) or a re-inquiry starting a new period of theirs (`nextPeriodAt`, R-OWN-20, E68).
 * A touch after that is the later period's, never this one's (owner decision 2026-11-11, R-ACC-2).
 */
export interface SlaFacts {
  contactId: ContactId;
  ownerUserId: UserId;
  /** The ledger seq that started the period (contacts.ownership_period_seq while current). */
  periodSeq: number;
  ownedAt: Instant;
  firstTouchDueAt: Instant;
  /** The period's own first human touch: the first one before its first-touch window ended. */
  firstTouchAt: Instant | null;
  /** When the lead left this agent (release, auto-release, reassign, close ...); null while they hold it. */
  periodEndedAt: Instant | null;
  /**
   * When a re-inquiry started a new ownership period of the same owner while they still held the lead
   * (R-OWN-20, E68): it ends this period's first-touch window, but the lead did not leave the agent.
   * Null if none did (always null for the lead's current period).
   */
  nextPeriodAt: Instant | null;
  /** Auto-release instant (contacts.release_due_at) while current; null when disabled. */
  releaseDueAt?: Instant | null;
}

/**
 * The latest client communications waiting on a person, one row per inbound message or missed
 * call (not imported, not an auto-reply). The feed folds them per contact.
 */
export interface InboundFacts {
  /** messages.id, or calls.id for a missed call. */
  id: MessageId | CallId;
  kind: 'message' | 'missed_call';
  /** 'web_chat' (module 22): the client wrote in the website chat; the card offers a reply there */
  channel: 'sms' | 'mms' | 'email' | 'voice' | 'web_chat';
  contactId: ContactId;
  /** The contact's current owner (the user the feed item belongs to). */
  ownerUserId: UserId;
  at: Instant;
  imported: boolean;
  /** Out-of-office and similar auto-replies need no answer. */
  isAutoReply?: boolean;
  /** An opt-out/HELP keyword message is answered by the system confirmation (R-CONSENT-7). */
  isKeyword?: boolean;
  /** Outbound messages/calls and answered inbound calls on this contact after `at`. */
  laterTouches: TouchFacts[];
}

/** An open handback (assistant_actions kind `handback`, status `proposed`). */
export interface HandbackFacts {
  actionId: AssistantActionId;
  ownerUserId: UserId;
  contactId: ContactId;
  /** The inbound message that paused automation (R-AST-9). */
  inboundMessageId: MessageId | null;
  inboundChannel: 'sms' | 'mms' | 'email' | 'voice' | null;
  receivedAt: Instant;
  /** A proposed reply draft attached to the handback, if the assistant wrote one. */
  replyDraftActionId?: AssistantActionId | null;
  createdAt: Instant;
}

/** A proposed message draft waiting for the agent (assistant_actions kind `message_draft`). */
export interface DraftFacts {
  actionId: AssistantActionId;
  ownerUserId: UserId;
  contactId: ContactId;
  channel: 'sms' | 'email';
  category: ActionCategory | 'internal';
  /** assistant_actions.explanation: the one-line "why", verbatim (1..300 chars). */
  explanation: string;
  /** Some claim behind the draft needs the agent's check ("Check this"). */
  needsReview: boolean;
  createdAt: Instant;
}

/** Evidence attached to a task by its source claim (promise tasks, A5). */
export interface TaskEvidence {
  sourceType: SourceType;
  sourceId: string;
  locator: Locator;
  snippet: string;
}

/** A task (tasks row). */
export interface TaskFacts {
  taskId: TaskId;
  assigneeUserId: UserId;
  contactId: ContactId | null;
  dealId: DealId | null;
  kind: 'todo' | 'callback' | 'promise' | 'follow_up' | 'document';
  dueAt: Instant | null;
  dueAllDay: boolean;
  /** tasks.due_tz: needed to find the end of an all-day due date. */
  dueTz: IanaZone | null;
  status: 'open' | 'done' | 'canceled';
  completedAt: Instant | null;
  needsReview: boolean;
  createdByKind: CreatedByKind;
  createdAt: Instant;
  /** Verified evidence of the claim the promise came from (call offset, message ...). */
  evidence?: TaskEvidence[];
}

/** A contract date (deal_dates row) for the deal's owner and members. */
export interface DealDateFacts {
  dealDateId: DealDateId;
  dealId: DealId;
  /** Users the date is for: the deal owner and deal members (RLS-visible). */
  userIds: UserId[];
  kind: 'acceptance' | 'inspection' | 'appraisal' | 'financing' | 'closing' | 'possession' | 'custom';
  /** deal_dates.label (required for `custom`). A deal label, never a client's personal data. */
  label: string | null;
  dueOn: LocalDate;
  /** The tenant zone the date is a calendar day in. */
  zone: IanaZone;
  completedAt: Instant | null;
  createdAt: Instant;
}

/** An appointment (appointments row). */
export interface ApptFacts {
  appointmentId: AppointmentId;
  contactId: ContactId | null;
  userId: UserId;
  kind: 'buyer_consult' | 'listing_appointment' | 'consult' | 'other';
  startsAt: Instant;
  endsAt: Instant;
  status: 'scheduled' | 'held' | 'no_show' | 'canceled' | 'rescheduled';
  outcomeLoggedAt: Instant | null;
  createdByKind: CreatedByKind;
}

/** A re-inquiry on an owned lead (ledger `reinquiry`; ownership decide writes the feed row). */
export interface ReinquiryFacts {
  contactId: ContactId;
  ownerUserId: UserId;
  inquiryId: LeadInquiryId;
  at: Instant;
  /** The new first-touch deadline when the re-inquiry started an SLA, else null. */
  dueAt: Instant | null;
  /** A human touched the lead after the re-inquiry. */
  touchedSince: boolean;
}

/** An inactivity warning (ledger `inactivity_warned`) on a lead still owned in that period. */
export interface InactivityFacts {
  contactId: ContactId;
  ownerUserId: UserId;
  periodSeq: number;
  /** The warning fence instant (contacts.inactivity_warn_at when it fired). */
  warnAt: Instant;
  /** When the lead goes back to the pond if still untouched. */
  releaseAt: Instant;
}

/** A claimable lead in a pond the user may claim from. */
export interface PondLeadFacts {
  contactId: ContactId;
  pondId: PondId;
  /** Ledger seq of the event that put it in the pond (per-occurrence key). */
  enteredSeq: number;
  enteredAt: Instant;
  /** Users who may claim (pond members). */
  userIds: UserId[];
}

/** A proposed saved search waiting for the agent's approval (A4, R-AST-10). */
export interface SearchProposalFacts {
  savedSearchId: SavedSearchId;
  ownerUserId: UserId;
  contactId: ContactId;
  /** Criteria from needs-review claims, left unchecked (R-AST-5). */
  uncheckedCount: number;
  createdAt: Instant;
}

/**
 * Everything the Priority Feed is scored from. All arrays are the RLS-visible rows for `userId`;
 * core additionally keeps only the rows that belong to `userId`, so a stale row (e.g. after a
 * reassignment) never produces an item.
 *
 * NOTE: no protected-proxy fields exist on any input type (R-AST-12).
 */
export interface FeedInputs {
  now: Instant;
  userId: UserId;
  offers: OfferFacts[];
  slas: SlaFacts[];
  unansweredInbound: InboundFacts[];
  handbacks: HandbackFacts[];
  drafts: DraftFacts[];
  tasks: TaskFacts[];
  dealDates: DealDateFacts[];
  appointments: ApptFacts[];
  blockedChannels: Map<ContactId, GateSummary>;
  /** Spec correction (additive): the remaining `priority_feed_items.item_type`s. */
  reinquiries?: ReinquiryFacts[];
  inactivityWarnings?: InactivityFacts[];
  pondLeads?: PondLeadFacts[];
  searchProposals?: SearchProposalFacts[];
}

// ---- feed output ---------------------------------------------------------------------------------

/** priority_feed_items.item_type */
export type FeedItemType =
  | 'lead_offer'
  | 'first_touch_due'
  | 'unanswered_inbound'
  | 'handback'
  | 'assistant_draft'
  | 'task_due'
  | 'promise_due'
  | 'deal_date'
  | 'appointment_outcome'
  | 'reinquiry'
  | 'inactivity_warning'
  | 'pond_new'
  | 'saved_search_review'
  | 'missed_call'
  | ForeignFeedItemType;

/**
 * Phase 2/3 card types (module 18a). Each is MATERIALIZED by its owning module, which writes one
 * priority_feed_items row under its own key family (keys.ts `FOREIGN_FEED_KEY`); the scorer never
 * produces, refreshes or closes them (the Phase 1 extension point). The feed API only gives each one its
 * label and one-tap action on the way out.
 */
export type ForeignFeedItemType = 'seller_update' | 'marketing_review' | 'weekly_plan' | 'coaching_fix' | 'likely_to_move';
export const FOREIGN_FEED_ITEM_TYPES: readonly ForeignFeedItemType[] = ['seller_update', 'marketing_review', 'weekly_plan', 'coaching_fix', 'likely_to_move'];

export const FEED_ITEM_TYPES: readonly FeedItemType[] = [
  'lead_offer',
  'first_touch_due',
  'unanswered_inbound',
  'handback',
  'assistant_draft',
  'task_due',
  'promise_due',
  'deal_date',
  'appointment_outcome',
  'reinquiry',
  'inactivity_warning',
  'pond_new',
  'saved_search_review',
  'missed_call',
  ...FOREIGN_FEED_ITEM_TYPES,
];

/** priority_feed_items.subject_type as core writes it. */
export type FeedSubjectType = 'contact' | 'assistant_action' | 'task' | 'deal_date' | 'appointment' | 'saved_search' | 'message' | 'call';

/** One line of "why is this here" (shown on tap). `points` is its share of the score, if any. */
export interface FeedReason {
  code: string;
  label: string;
  points?: number;
}

/**
 * The one-tap actions a card offers (A1 tap targets). Every send is gate-checked again at send time;
 * `note` is an optional hint shown next to the action (the gate no longer asks for confirmations).
 */
export type OneTapAction =
  | { kind: 'accept_offer'; label: string; contactId: ContactId; offerId: string }
  | { kind: 'decline_offer'; label: string; contactId: ContactId; offerId: string }
  | { kind: 'claim'; label: string; contactId: ContactId; pondId: PondId }
  | { kind: 'call'; label: string; contactId: ContactId; note?: string }
  | { kind: 'text'; label: string; contactId: ContactId; draftActionId?: AssistantActionId; note?: string }
  | { kind: 'email'; label: string; contactId: ContactId; draftActionId?: AssistantActionId; note?: string }
  /** a reply in the website chat where the client wrote last (module 22): the thread with the box on web chat */
  | { kind: 'reply_chat'; label: string; contactId: ContactId }
  | { kind: 'send_draft'; label: string; actionId: AssistantActionId; note?: string }
  | { kind: 'edit_draft'; label: string; actionId: AssistantActionId }
  | { kind: 'review_handback'; label: string; actionId: AssistantActionId }
  | { kind: 'complete_task'; label: string; taskId: TaskId }
  | { kind: 'open_task'; label: string; taskId: TaskId }
  | { kind: 'log_outcome'; label: string; appointmentId: AppointmentId }
  | { kind: 'open_deal'; label: string; dealId: DealId }
  | { kind: 'complete_deal_date'; label: string; dealDateId: DealDateId }
  | { kind: 'review_search'; label: string; savedSearchId: SavedSearchId }
  | { kind: 'open_contact'; label: string; contactId: ContactId }
  /** the listing page (seller updates and marketing pieces belong to a listing) */
  | { kind: 'open_listing'; label: string; listingId: ListingId }
  /** opens the card's own details in place (what the owning module wrote on the card), no navigation */
  | { kind: 'show_details'; label: string };

export type OneTapKind = OneTapAction['kind'];

/**
 * One Priority Feed card. Spec correction (additive): `contactId`, `subjectType`, `subjectId`,
 * `assistantActionId`, `createdAt` and `scoreVersion` are carried so the API can persist the row
 * (priority_feed_items) and the tie-break on createdAt/id is reproducible.
 */
export interface FeedItem {
  itemType: FeedItemType;
  band: 'pinned' | 'scored';
  /** 0..100 integer: the clamped sum of the reasons' points. */
  score: number;
  scoreVersion: number;
  /** ≥ 1 reason (DB CHECK); shown on tap. */
  reasons: FeedReason[];
  dueAt: Instant | null;
  /** One open item per (user, dedupe_key) (DB unique). */
  dedupeKey: string;
  primaryAction: OneTapAction;
  alternatives: OneTapAction[];
  contactId: ContactId | null;
  subjectType: FeedSubjectType;
  subjectId: string;
  assistantActionId: AssistantActionId | null;
  createdAt: Instant;
}

// ---- exceptions ----------------------------------------------------------------------------------

/** exception_items.item_type */
export type ExceptionType = 'untouched_lead' | 'overdue_promise' | 'failed_send' | 'missing_outcome' | 'milestone_at_risk';
export const EXCEPTION_TYPES: readonly ExceptionType[] = ['untouched_lead', 'overdue_promise', 'failed_send', 'missing_outcome', 'milestone_at_risk'];

/** messages.status */
export type MessageStatus =
  | 'received'
  | 'scheduled'
  | 'queued'
  | 'dispatching'
  | 'sent'
  | 'delivered'
  | 'failed'
  | 'undelivered'
  | 'bounced'
  | 'blocked'
  | 'canceled'
  | 'dispatch_unknown';

/** An outbound message's current delivery state (messages row, direction `outbound`). */
export interface OutboundStatusFacts {
  messageId: MessageId;
  contactId: ContactId;
  /** Who answers for it: the human sender, the assistant action's owner, or the contact owner. */
  ownerUserId: UserId | null;
  channel: 'sms' | 'mms' | 'email';
  initiator: 'human' | 'assistant' | 'system' | 'import';
  imported: boolean;
  status: MessageStatus;
  /** When the message entered its current status (the latest message_status_events row). */
  statusAt: Instant;
  dispatchedAt: Instant | null;
  /** The gate explanation (blocked) or the provider error code (failed). Never PII. */
  statusReason?: string | null;
  /**
   * messages.marketing_piece_id: one recipient's row of an open-house invite (R-MKT-8). An invite that
   * an opt-out blocked is counted on the send ("Sent 41 of 45; 4 opted out"), never a failed_send.
   */
  marketingPieceId?: string | null;
}

/**
 * One milestone date (deal_dates row with its Phase 2 columns) for R-ACC-6 `milestone_at_risk`. Only
 * stored fields: `dueAt` is the instant module 31 computed at confirm time (end of the due day in the
 * tenant zone), `dueVersion` bumps whenever a confirmed date moves (so a moved date is a new occurrence).
 */
export interface MilestoneDateFacts {
  dealDateId: DealDateId;
  dealId: DealId;
  /** The deal owner: who answers for the date (R-ACC-6). */
  ownerUserId: UserId;
  /** Null while a confirmed date's stored instant is missing (module 31's reconcile repairs it). */
  dueAt: Instant | null;
  dueVersion: number;
  /** deal_dates.responsible; null = nobody named. */
  responsible: 'buyer' | 'seller' | 'lender' | 'title' | 'agent' | 'tc' | 'other' | null;
  completedAt: Instant | null;
  /** Only `confirmed` dates are ever at risk (R-TXN-2/3: a proposal drives nothing). */
  status: 'proposed' | 'confirmed' | 'waived';
  /** For the evidence wording only ("Inspection date"). */
  kind?: DealDateFacts['kind'];
}

/** One evidence entry on an exception (exception_items.evidence jsonb element). */
export interface ExceptionEvidence {
  sourceType: SourceType | 'ownership_period' | 'message_status' | 'deal_date';
  sourceId: string;
  /** Short, PII-free explanation shown to the Team Lead. */
  explanation: string;
  /** The instant the evidence is about; the UI formats it in the viewer's zone. */
  at?: Instant;
  /** Where in the source (a call offset, a char range ...), for "jump to the moment". */
  locator?: Locator;
  /** Verbatim snippet (from the source claim), when the evidence is a quote. */
  snippet?: string;
  /** milestone_at_risk: which R-ACC-6 predicate this entry shows. */
  predicate?: MilestonePredicate;
}

/** R-ACC-6: overdue (`due_at < now`), or due within 48 h with no responsible party. */
export type MilestonePredicate = 'overdue' | 'unassigned';

/** One exception_items row as core derives it (`computed_at` is stamped by the API). */
export interface ExceptionItemSpec {
  itemType: ExceptionType;
  subjectType: 'contact' | 'task' | 'message' | 'appointment' | 'deal_date';
  subjectId: string;
  contactId: ContactId | null;
  /** The agent who answers for it (R-ACC-2). Null only for a failed send with no owner at all. */
  ownerUserId: UserId | null;
  /** The instant the condition started holding: deterministic, so recompute never moves it. */
  detectedAt: Instant;
  dueAt: Instant | null;
  /** ≥ 1 entry (DB CHECK). */
  evidence: ExceptionEvidence[];
  /** Set when the condition no longer holds ("fixed late"); the item stays queued until handled. */
  conditionClearedAt: Instant | null;
  ruleVersion: number;
  /**
   * Per occurrence: `untouched:{contact}:{period}`, `promise:{task}`, `send:{message}`, `appt:{appointment}`,
   * `milestone:{deal_date}:{due_version}`.
   */
  dedupeKey: string;
  /**
   * untouched_lead only (exception_items.withdrawn_at): a stored item the current definitions derive no item for any
   * more, because its period's first-touch window ended before its deadline under the current rules (a re-inquiry
   * superseded it, or the lead left its owner) or its first touch was in time. It is never a late fix: it leaves the
   * live queue, its evidence says why, and its human events stand. Absent or null on every derived item.
   */
  withdrawnAt?: Instant | null;
}

export interface ExceptionSettings {
  /** missing_outcome: an appointment that ended more than this many hours ago (default 2). */
  missingOutcomeHours: number;
  /** failed_send: `dispatch_unknown` for more than this many minutes (default 10). */
  unknownDispatchMinutes: number;
  /** failed_send: `dispatching` for more than this many minutes (default 20, R-GATE-8). */
  dispatchingStaleMinutes?: number;
}

export interface ExceptionInputs {
  now: Instant;
  /** Every SLA ownership period from the ledger (`v_speed_to_lead`), current or ended. */
  ownedWithSla: SlaFacts[];
  promiseTasks: TaskFacts[];
  outbound: OutboundStatusFacts[];
  appointments: ApptFacts[];
  /** R-ACC-6: milestone dates (any status; core keeps the confirmed, uncompleted ones). */
  milestoneDates?: MilestoneDateFacts[];
  settings: ExceptionSettings;
  /**
   * Spec correction (additive): the exception_items rows already stored for the same scope. With
   * them, unchanged items are not upserted again (idempotent recompute) and stored items whose
   * subject vanished from the inputs are cleared.
   */
  existing?: ExceptionItemSpec[];
}

export interface ExceptionDerivation {
  /** Items to store by dedupe key, withdrawals of stored untouched_lead items included (`withdrawnAt` set). */
  upserts: ExceptionItemSpec[];
  /** Dedupe keys whose condition stopped holding: set condition_cleared_at = now if still null. */
  cleared: string[];
}

// ---- scoreboard ----------------------------------------------------------------------------------

/** One `v_speed_to_lead` row. */
export interface SpeedRow {
  userId: UserId;
  contactId: ContactId;
  ownedSeq: number;
  ownedAt: Instant;
  firstTouchDueAt: Instant;
  firstTouchAt: Instant | null;
}

export interface SpeedToLeadSummary {
  /** Median response time over the periods that got a response (null when none did). */
  medianSeconds: number | null;
  /** Periods whose first human touch came by the deadline. */
  withinSla: number;
  /** Periods with an outcome (responded, or past the deadline): the denominator of `withinSla`. */
  total: number;
  /** Periods that got a human response: the denominator of `medianSeconds`. */
  responded: number;
  /** Untouched periods whose deadline is still ahead (only when `now` is given); not in `total`. */
  pending: number;
}

export interface TouchCounts {
  touches: number;
  calls: number;
  textsAndEmails: number;
}
