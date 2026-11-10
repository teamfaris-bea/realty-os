// Types of the lead ownership engine (BUILD_PLAN module 3; ARCHITECTURE §5; DATA_MODEL §1.3, R-OWN-*).
//
// The projection mirrors the guarded ownership columns of `contacts`; events mirror rows of the
// append-only, gapless `lead_ownership_events` ledger; rejections mirror `ownership_command_rejections`.
// Instants are epoch-ms UTC (`Instant`). Event payloads hold ids, codes and instants only (no PII).
import type {
  Actor,
  AuditAction,
  BusinessCalendar,
  ContactId,
  IanaZone,
  IdGenerator,
  Instant,
  LeadInquiryId,
  LeadSourceId,
  OwnershipRejectionId,
  PondId,
  Role,
  RuleId,
  UserId,
} from '../foundation/index.js';

// ---- states, reasons ------------------------------------------------------------------------

export const OWNERSHIP_STATES = ['unassigned', 'offered', 'owned', 'in_pond', 'closed'] as const;
export type OwnershipState = (typeof OWNERSHIP_STATES)[number];

/** contacts.closed_reason. `merged` and `deleted` are reached only through merge / soft_delete. */
export const CLOSE_REASONS = ['spam', 'merged', 'do_not_contact', 'not_a_lead', 'deleted'] as const;
export type CloseReason = (typeof CLOSE_REASONS)[number];
/** Reasons a `close` command may carry. */
export const MANUAL_CLOSE_REASONS = ['spam', 'do_not_contact', 'not_a_lead'] as const;

/** R-OWN-17: a release requires one of these (+ a note for `other`). */
export const RELEASE_REASONS = ['not_a_fit', 'wrong_area', 'duplicate', 'unresponsive', 'other'] as const;
export type ReleaseReason = (typeof RELEASE_REASONS)[number];

export const DECLINE_REASONS = ['busy', 'not_my_area', 'conflict', 'other'] as const;
export type DeclineReason = (typeof DECLINE_REASONS)[number];

/** Ledger `reason_code` / assign reasons: UPPER_SNAKE (DB CHECK `^[A-Z][A-Z0-9_]*$`). */
export type OwnershipReasonCode = string;
export const REASON_CODE_RE = /^[A-Z][A-Z0-9_]*$/;

export const CONTACT_STAGES = ['new', 'attempting', 'connected', 'nurture', 'active', 'under_contract', 'closed', 'lost'] as const;
export type ContactStage = (typeof CONTACT_STAGES)[number];
/** R-OWN-23: inactivity release applies only to these stages. */
export const INACTIVITY_STAGES: ReadonlySet<ContactStage> = new Set<ContactStage>(['new', 'attempting']);

export const MEMBERSHIP_STATUSES = ['invited', 'active', 'suspended', 'deactivating', 'removed'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

// ---- projection -----------------------------------------------------------------------------

/**
 * The ownership projection (the guarded columns of `contacts`). `seq` is always the ledger head.
 * `commandId` / `actorUserId` mirror `ownership_command_id` / `ownership_actor_user_id` (the command
 * and user actor of the last event), so `fold(ledger)` reproduces every guarded column.
 */
export interface OwnershipProjection {
  state: OwnershipState;
  ownerUserId: UserId | null;
  pondId: PondId | null;
  offerId: string | null;
  offeredToUserId: UserId | null;
  offerExpiresAt: Instant | null;
  offerRound: number;
  routingRuleId: RuleId | null;
  ownedAt: Instant | null;
  firstTouchDueAt: Instant | null;
  firstTouchAt: Instant | null;
  firstTouchBreachedAt: Instant | null;
  releaseDueAt: Instant | null;
  /** Seq that started the current ownership period (owned only): timer fences, draft binding. */
  periodSeq: number | null;
  /** Unassigned, awaiting system routing (after a decline, an expiry without routing, a reopen, an intake). */
  routeDueAt: Instant | null;
  closedReason: CloseReason | null;
  /** = ledger head. */
  seq: number;
  /** contacts.ownership_command_id: the command of the last event. */
  commandId: string;
  /** contacts.ownership_actor_user_id: the user actor of the last event (null for system). */
  actorUserId: UserId | null;
}

// ---- commands --------------------------------------------------------------------------------

export type TimerDeadline = 'offer_expiry' | 'first_touch_breach' | 'auto_release' | 'inactivity_warn' | 'inactivity_release';
export type OfferFence = { offerId: string };
export type PeriodFence = { periodSeq: number; dueAt: Instant };
export type TimerFence = OfferFence | PeriodFence;

export type ImportTarget = { userId: UserId } | { pondId: PondId } | 'unassigned';

export type OwnershipCommand =
  | { kind: 'create'; via: 'intake' | 'self' | 'inbound' }
  | { kind: 'route'; inquiryId?: string }
  | { kind: 'accept'; offerId: string }
  | { kind: 'decline'; offerId: string; reason?: DeclineReason }
  | { kind: 'claim'; pondId: PondId }
  | { kind: 'release'; reason: ReleaseReason; note?: string; toPondId?: PondId }
  | { kind: 'assign' | 'reassign'; toUserId: UserId; reason: OwnershipReasonCode; note?: string }
  | { kind: 'isa_handoff'; toUserId: UserId; note: string }
  | { kind: 'timer'; deadline: TimerDeadline; fence: TimerFence }
  | { kind: 'touch'; via: 'call' | 'sms' | 'email'; refId: string; at: Instant }
  | { kind: 'reinquiry'; inquiryId: string }
  | { kind: 'close'; reason: CloseReason }
  | { kind: 'reopen' }
  | { kind: 'soft_delete' }
  | { kind: 'merge'; survivorId: ContactId; loserId: ContactId; ownerChoice: UserId | null }
  | { kind: 'deactivate_owner'; destination: 'team_lead' | 'default_pond' | 'reroute'; deactivationId: string }
  | { kind: 'import_assign'; target: ImportTarget }
  /** R-IMPORT-10: reverting an import's ownership stage on its own puts the lead back where the
   *  contacts stage left it (unassigned, never routed), fenced on the ledger head the import wrote. */
  | { kind: 'import_unassign'; importSeq: number };

export type OwnershipCommandKind = OwnershipCommand['kind'];

// ---- events (ledger rows) ----------------------------------------------------------------------

export const OWNERSHIP_EVENT_TYPES = [
  'created', 'imported', 'offered', 'offer_accepted', 'offer_declined', 'offer_expired', 'offer_rescinded',
  'claimed', 'assigned', 'reassigned', 'released', 'sent_to_pond', 'auto_released', 'reinquiry',
  'first_touch_recorded', 'first_touch_breached', 'sla_waived', 'inactivity_warned', 'inactivity_released',
  'closed', 'reopened', 'merged_away', 'merged_in',
] as const;
export type OwnershipEventType = (typeof OWNERSHIP_EVENT_TYPES)[number];

/** lead_ownership_events.actor_kind */
export type LedgerActorKind = 'user' | 'system' | 'timer' | 'import' | 'provider';

/** Eligibility skip reasons, in R-OWN-11 order. */
export const SKIP_REASONS = [
  'MEMBERSHIP_INACTIVE',
  'ROLE_NOT_ELIGIBLE',
  'NOT_ACCEPTING_LEADS',
  'NO_CRITICAL_CHANNEL',
  'ALREADY_OFFERED',
  'RELEASE_COOLDOWN',
  'CAPACITY_REACHED',
] as const;
export type SkipReason = (typeof SKIP_REASONS)[number];

export interface ConsideredCandidate {
  userId: UserId;
  eligible: boolean;
  skipReason?: SkipReason;
}

/**
 * Payload fields core writes and fold reads. Instants are epoch ms. Unknown extra keys (e.g. moved
 * ids that db/client adds to `merged_in`) are ignored by fold.
 */
export interface OwnershipEventPayload {
  /** offered: 1-based round within the routing sequence. */
  round?: number;
  /** offered / sent_to_pond: every candidate considered, with the skip reason of the ineligible ones. */
  candidates?: ConsideredCandidate[];
  /** period start: the auto-release deadline (null = none). */
  releaseDueAt?: number | null;
  /** to unassigned: when system routing is due (null = not awaiting routing). */
  routeDueAt?: number | null;
  /** to closed. */
  closedReason?: CloseReason;
  /** owned → owned event that starts a new ownership period without an owner change (re-inquiry SLA). */
  newPeriod?: boolean;
  [k: string]: unknown;
}

export interface OwnershipEvent {
  eventId: string;
  contactId: ContactId;
  seq: number;
  type: OwnershipEventType;
  fromState: OwnershipState | null;
  toState: OwnershipState;
  /** Owner AFTER the event. */
  ownerUserId: UserId | null;
  prevOwnerUserId: UserId | null;
  /** Pond AFTER the event (claims record the source pond in the payload). */
  pondId: PondId | null;
  /** The offer this event creates, accepts, declines, expires or rescinds. */
  offerId: string | null;
  /** Offeree AFTER the event. */
  offeredToUserId: UserId | null;
  routingRuleId: RuleId | null;
  /** offered: offer expiry; ownership-period start: first-touch due (null = no SLA). */
  deadlineAt: Instant | null;
  actorKind: LedgerActorKind;
  actorUserId: UserId | null;
  reasonCode: OwnershipReasonCode;
  note: string | null;
  commandId: string;
  payload: OwnershipEventPayload;
  occurredAt: Instant;
}

// ---- rejections ---------------------------------------------------------------------------------

export const OWNERSHIP_ERROR_CODES = [
  'LEAD_OFFER_EXPIRED',
  'LEAD_OFFER_SUPERSEDED',
  'LEAD_OFFER_NOT_YOURS', // HTTP 404
  'MEMBERSHIP_INACTIVE',
  'LEAD_ALREADY_CLAIMED',
  'CLAIM_LIMIT_REACHED',
  'CLAIM_COOLDOWN',
  'CAPACITY_REACHED',
  'POND_NOT_ELIGIBLE',
  'ALREADY_OWNER',
  'LEAD_STATE_CHANGED', // 409 with the fresh projection
  'NOT_FOUND', // the actor may not issue this command on this contact (R-PERM-5: 404)
  'TARGET_NOT_ELIGIBLE', // assign/handoff/import target cannot own leads (TC, inactive, wrong role)
  'VALIDATION_FAILED', // malformed command (missing note, bad reason code, survivor = loser …)
  'MERGE_OWNER_REQUIRED', // R-OWN-24: different owners, a TL/Admin must choose
  'CONTACT_MERGED', // the contact was merged away: redirect to merged_into first (R-OWN-20)
] as const;
export type OwnershipErrorCode = (typeof OWNERSHIP_ERROR_CODES)[number];

/** A row for `ownership_command_rejections` (kept out of the gapless ledger). */
export interface RejectionSpec {
  id: OwnershipRejectionId;
  contactId: ContactId | null;
  commandId: string;
  commandKind: OwnershipCommandKind;
  code: OwnershipErrorCode;
  /** Ledger head seen under the lock (null when the contact has no ledger yet). */
  observedSeq: number | null;
  actorKind: LedgerActorKind;
  actorUserId: UserId | null;
  /** ids / codes only. */
  payload: Record<string, unknown>;
  occurredAt: Instant;
}

// ---- settings and context ------------------------------------------------------------------------

/** tenant_settings lead timers, read in the command transaction (rule overrides applied by core). */
export interface EffectiveLeadSettings {
  offerWindowSeconds: number; // 300
  maxOffers: number; // 3
  firstTouchSlaSeconds: number; // 900
  firstTouchReleaseSeconds: number | null; // 1800; null disables auto-release
  reinquirySlaAfterDays: number; // 7
  inactivityReleaseDays: number | null; // 30; null disables
  inactivityWarningHours: number; // 72
  autoPauseAfterMisses: number; // 3
  uncontactedCapacityCap: number; // 5
  isaAccessAfterHandoffDays: number; // 7
  softDeletePurgeDays: number; // 30
  defaultPondId: PondId;
  tenantZone: IanaZone;
}

export interface MemberFacts {
  userId: UserId;
  role: Role;
  status: MembershipStatus;
  acceptingLeads: boolean;
  /** The member is in a team the ACTOR leads (Team Lead reassignment, R-OWN-18). */
  inActorTeam?: boolean;
}

export interface PondFacts {
  pondId: PondId;
  isDefault: boolean;
  archived: boolean;
  openToAll: boolean;
  eligibleRoles: readonly Role[];
  /** The actor is a pond_members row of this pond (needed when not open_to_all). */
  actorIsMember: boolean;
  claimsPerDay: number;
  claimCooldownHours: number;
  reinquiry: 'reroute' | 'stay';
}

export type RoutingStrategy = 'round_robin' | 'weighted' | 'direct' | 'pond';

/** routing_rules.match (validated by `parseRoutingMatch`). Prices are integer cents. */
export interface RoutingMatch {
  sources?: LeadSourceId[];
  leadTypes?: InquiryType[];
  zips?: string[];
  priceMin?: number;
  priceMax?: number;
}

export type InquiryType = 'buy' | 'sell' | 'rent' | 'value' | 'general';

export interface RuleFacts {
  id: RuleId;
  position: number;
  name?: string;
  enabled: boolean;
  version: number;
  strategy: RoutingStrategy;
  match: RoutingMatch;
  directUserId: UserId | null;
  targetPondId: PondId | null;
  fallbackPondId: PondId | null;
  offerWindowSeconds: number | null;
  maxOffers: number | null;
}

export interface InquiryFacts {
  inquiryId?: LeadInquiryId | string;
  leadSourceId: LeadSourceId | null;
  inquiryType: InquiryType | null;
  postalCode: string | null;
  priceMinCents: number | null;
  priceMaxCents: number | null;
}

/** One routing_rule_members row joined with its eligibility inputs (read as system, FOR SHARE). */
export interface Candidate {
  userId: UserId;
  weight: number;
  role: Role;
  status: MembershipStatus;
  acceptingLeads: boolean;
  hasCriticalChannel: boolean;
  /** Already offered this lead in the current routing sequence (decide fills it from the snapshot). */
  alreadyOffered?: boolean;
  inReleaseCooldown: boolean;
  uncontactedOwned: number;
}

/** routing_rotation_state.cursor */
export interface RotationCursor {
  /** round_robin: the last user picked. */
  lastUserId?: UserId | null;
  /** weighted (smooth WRR): current weights per user. */
  current?: Record<string, number>;
}

/** What the system router read under its locks (ARCHITECTURE §5 step 2). */
export interface RoutingSnapshot {
  /** The matched rule (`matchRule`), or null for no match (default pond, NO_RULE_MATCH). */
  rule: RuleFacts | null;
  /** The rule's members with eligibility inputs (direct: the direct user). */
  candidates: readonly Candidate[];
  cursor: RotationCursor;
  /** Users offered this lead in the current sequence (`offeredInCurrentSequence(ledger)`). */
  alreadyOffered: readonly UserId[];
}

/** Recipients of escalation notifications. */
export interface PeopleFacts {
  admins: readonly UserId[];
  /** user id -> the team leads of that user's teams. */
  teamLeadsOf: Readonly<Record<string, readonly UserId[]>>;
}

export interface DeactivationFacts {
  /** The member being deactivated. */
  userId: UserId;
  /** Their team lead (active, may own leads), if any. */
  teamLeadUserId: UserId | null;
  /** Owner/Admin who previewed the deactivation: open-deal contacts and leaderless leads go here. */
  fallbackUserId: UserId;
}

export interface DecisionContext {
  /** DB clock_timestamp() read after the contact lock (R-OWN-6). */
  now: Instant;
  ids: IdGenerator;
  actor: Actor;
  /** Idempotency key (uuid). */
  commandId: string;
  /** The contact the projection belongs to. */
  contactId: ContactId;
  settings: EffectiveLeadSettings;
  /** Tenant routing hours (08:00–21:00 tenant zone by default). */
  calendar: BusinessCalendar;
  /** First contactable instant >= from for the contact (core/compliance window + zones). */
  nextContactableAt: (from: Instant) => Instant;
  /** The ledger head the user's UI observed (stale UI ⇒ LEAD_STATE_CHANGED). */
  expectedSeq?: number;
  routing?: RoutingSnapshot;
  claimStats?: { claimsToday: number; inCooldown: boolean; uncontactedOwned: number };
  pond?: PondFacts;
  dealOpen?: boolean;
  lastHumanTouchAt?: Instant | null;
  /** contacts.stage (inactivity applies to new/attempting only). */
  contactStage?: ContactStage;
  /** Stored inactivity deadlines of the contact row (non-guarded columns). */
  inactivity?: { warnAt: Instant | null; releaseAt: Instant | null };
  /** The actor's own membership (accept, claim). */
  actorMember?: MemberFacts;
  /** The target of assign / reassign / isa_handoff / import_assign. */
  targetMember?: MemberFacts;
  /** The current owner (for an `offered` lead: the offeree) is in a team the actor leads. */
  ownerInActorTeam?: boolean;
  /** The actor is a live collaborator on the contact (touch). */
  actorIsCollaborator?: boolean;
  /** Offeree's memberships.consecutive_missed_offers before this command (R-OWN-12). */
  offereeMissedOffers?: number;
  people?: PeopleFacts;
  deactivation?: DeactivationFacts;
  /** merge: the other contact's projection. */
  mergePeer?: OwnershipProjection;
  /** merge: the other contact's stored inactivity deadlines (timer clean-up only). */
  mergePeerInactivity?: { warnAt: Instant | null; releaseAt: Instant | null };
}

// ---- effects ------------------------------------------------------------------------------------

export type TimerKind = 'ownership.offer_expiry' | 'ownership.first_touch_breach' | 'ownership.auto_release' | 'ownership.inactivity';

/** Job payload of a timer (ids + fences only, R-TEN-7); maps 1:1 to a `timer` command. */
export type TimerJobFence =
  | { contactId: ContactId; deadline: 'offer_expiry'; offerId: string }
  | { contactId: ContactId; deadline: Exclude<TimerDeadline, 'offer_expiry'>; periodSeq: number; dueAt: Instant };

export type NotificationKind =
  | 'lead_offer'
  | 'first_touch_due'
  | 'first_touch_escalation'
  | 'pond_new'
  | 'exception'
  | 'reassigned_to_you'
  | 'reassigned_away'
  | 'inactivity_warning'
  | 'inbound_message'
  | 'system';

export interface NotificationSpec {
  kind: NotificationKind;
  priority: 'critical' | 'high' | 'normal' | 'low';
  subjectType: 'contact';
  subjectId: ContactId;
  /** UNIQUE (tenant, user, dedupe_key). */
  dedupeKey: string;
  /** Machine reason (UPPER_SNAKE); the API renders a PII-minimized title. */
  reasonCode: string;
}

export type FeedItemType = 'lead_offer' | 'first_touch_due' | 'reinquiry' | 'inactivity_warning' | 'pond_new';

export interface FeedItemSpec {
  userId: UserId;
  itemType: FeedItemType;
  band: 'pinned' | 'scored';
  contactId: ContactId;
  subjectType: 'contact';
  subjectId: string;
  dueAt: Instant | null;
  dedupeKey: string;
  reasons: string[];
}

export type Effect =
  | { kind: 'enqueueTimer'; jobKind: TimerKind; runAt: Instant; dedupeKey: string; fence: TimerJobFence }
  | { kind: 'cancelTimers'; dedupeKeys: string[] }
  | { kind: 'notify'; userId: UserId; notification: NotificationSpec }
  | { kind: 'upsertFeed'; item: FeedItemSpec }
  | { kind: 'resolveFeed'; dedupeKey: string; userId: UserId }
  | { kind: 'invalidateDrafts' }
  | { kind: 'pauseAgentEnrollments'; reason: 'owner_change' }
  | { kind: 'routingCursor'; ruleId: RuleId; cursor: RotationCursor }
  | { kind: 'membershipAutoPause'; userId: UserId }
  /** memberships.consecutive_missed_offers: +1 on a missed/declined offer, 0 on accept (R-OWN-12). */
  | { kind: 'missedOfferCounter'; userId: UserId; op: 'increment' | 'reset' }
  | { kind: 'addCollaborator'; userId: UserId; role: 'isa'; expiresAt: Instant }
  | { kind: 'rehomeHandbacks'; toUserId: UserId | null }
  | { kind: 'route' }
  /** Stored inactivity deadlines (non-guarded columns; must be null outside `owned`). */
  | { kind: 'setInactivityDeadlines'; warnAt: Instant | null; releaseAt: Instant | null }
  /** contacts.last_human_touch_at (R-OWN-14). */
  | { kind: 'recordHumanTouch'; at: Instant }
  /** soft delete: deleted_at = now, deleted_by = actor, purge_after (R-OWN-26). */
  | { kind: 'markDeleted'; purgeAfter: Instant }
  /** reopen of a soft-deleted contact: clear deleted_at / deleted_by / purge_after. */
  | { kind: 'clearDeleted' }
  /** merge loser: contacts.merged_into_contact_id. */
  | { kind: 'markMergedInto'; survivorId: ContactId }
  | { kind: 'audit'; action: AuditAction; reason?: string };

export type EffectKind = Effect['kind'];

// ---- decisions ---------------------------------------------------------------------------------------

export type Decision =
  | { ok: true; events: OwnershipEvent[]; next: OwnershipProjection; effects: Effect[] }
  | {
      ok: false;
      code: OwnershipErrorCode;
      rejection: RejectionSpec;
      /** Unchanged input (null when the contact has no ledger yet). */
      next: OwnershipProjection | null;
      effects: Effect[];
    };

export type AcceptedDecision = Extract<Decision, { ok: true }>;
export type RejectedDecision = Extract<Decision, { ok: false }>;
