// Route schemas of module 75 (docs/AI_ISA.md §9.1; D12 proposed). The web lane (ISA-4) builds against these.
// No response carries a confidence or score field (R-AST-13, R-ISA-22). Every id is a uuid; every free text a client
// sends is bounded; nothing names a recipient, a channel address, a tenant or a status the server sets.
import { z } from 'zod';

export const IdParams = z.strictObject({ id: z.uuid() });
const EmptyBody = z.strictObject({}).optional();
export { EmptyBody };

export const SIDES = ['buyer', 'seller', 'both'] as const;
export const CHANNELS = ['sms', 'email'] as const;
export const CAPABILITIES = ['converse', 'share_listings', 'propose_saved_search', 'seller_competition', 'seller_sold_comps', 'book_appointments'] as const;
export const STATES = ['starting', 'awaiting_reply', 'engaged', 'nurture', 'scheduling', 'booking', 'awaiting_agent', 'paused', 'ended'] as const;
export const LINK_EFFECTS = ['ok', 'hold', 'pause', 'end'] as const;
/** b12 recheck R19: the CHECK of ai_isa_handoffs.closed_reason (0081). b12 recheck R23: care_continued. */
export const HANDOFF_CLOSE_REASONS = ['deadline_met', 'acknowledged', 'lead_closed', 'care_restarted', 'care_continued'] as const;

const Iso = z.string();
/** Why the system closed a handoff (isa/handoff.ts closeHandoffInTx; ai_isa_handoffs.closed_reason, 0081), or null. */
const HandoffClosedReason = z.enum(HANDOFF_CLOSE_REASONS).nullable();
/** A handoff's deadline class (0080), with 0081's 'none': no human touch can clear it, so it has no deadline (B12X-2). */
export const SLA_CLASSES = ['critical', 'high', 'normal', 'low', 'none'] as const;

// ---- tenant (settings.ai_isa) -------------------------------------------------------------------------------
export const AdminView = z.object({
  enabled: z.boolean(),
  aiEnabled: z.boolean(),
  dailyCap: z.number().int(),
  sentToday: z.number().int(),
  packCleared: z.boolean(),
  liveSends: z.boolean(),
  /** "Waiting on counsel review" etc.; null when nothing holds sending */
  holdSentence: z.string().nullable(),
  enabledByUserId: z.uuid().nullable(),
  enabledAt: Iso.nullable(),
  overdueHandoffs: z.number().int(),
  underCare: z.number().int(),
  noticeSentence: z.string(),
});
export const AdminPutBody = z.strictObject({
  enabled: z.boolean(),
  dailyCap: z.number().int().min(0).max(1000),
  /** required when turning on or raising the cap (R-ISA-32) */
  attestation: z.string().trim().min(20).max(1000).optional(),
});

// ---- the agent (ai_isa.optin) -------------------------------------------------------------------------------
export const AvailabilityWindow = z.strictObject({
  weekday: z.number().int().min(1).max(7),
  start: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
  end: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),
});
export const OptInBody = z.strictObject({
  versionId: z.uuid(),
  capabilities: z.array(z.enum(CAPABILITIES)).min(1).max(CAPABILITIES.length),
  channels: z.array(z.enum(CHANNELS)).min(1).max(2),
  timezone: z.string().min(3).max(64),
  availability: z.array(AvailabilityWindow).max(28),
  bookingKinds: z.array(z.enum(['buyer_consult', 'listing_appointment', 'consult'])).max(3),
});
export const OptInView = z.object({
  id: z.uuid(),
  versionId: z.uuid(),
  capabilities: z.array(z.string()),
  channels: z.array(z.string()),
  timezone: z.string(),
  availability: z.array(AvailabilityWindow),
  bookingKinds: z.array(z.string()),
  createdAt: Iso,
});
export const MeView = z.object({
  optIn: OptInView.nullable(),
  policy: z.object({ versionId: z.uuid(), versionSha: z.string(), capabilities: z.array(z.string()), channels: z.array(z.string()) }).nullable(),
  /** the canonical attestation text the opt-in will hash (it embeds the version hash) */
  attestationText: z.string().nullable(),
  needsReattest: z.boolean(),
  calendarLive: z.boolean(),
  /** b13 review B13S-2: the capabilities this tree implements (the opt-in form enables only these) */
  builtCapabilities: z.array(z.string()),
  underCare: z.number().int(),
  sentence: z.string(),
});
export const OptInResult = z.object({ optInId: z.uuid(), change: z.enum(['created', 'narrowed', 'superseded']) });
export const RevokeResult = z.object({ ended: z.number().int() });
export const PauseAllResult = z.object({ paused: z.number().int() });
export const ReattestBody = z.strictObject({ versionId: z.uuid() });
export const ReattestResult = z.object({
  continued: z.array(z.object({ contactId: z.uuid(), assignmentId: z.uuid() })),
  notContinued: z.array(z.object({ contactId: z.uuid(), code: z.string(), sentence: z.string() })),
});

// ---- leads ---------------------------------------------------------------------------------------------------
export const ListQuery = z.strictObject({
  scope: z.enum(['mine', 'team', 'all']).default('mine'),
  state: z.enum(['live', 'paused', 'ended', 'held', 'any']).default('live'),
});
export const StateChip = z.object({ kind: z.enum(['active', 'waiting_reply', 'reply_scheduled', 'scheduling', 'waiting_on_agent', 'paused', 'held', 'ended']), sentence: z.string() });
export const ListRow = z.object({
  assignmentId: z.uuid(),
  contactId: z.uuid(),
  name: z.string(),
  side: z.enum(SIDES),
  chip: StateChip,
  lastAction: z.object({ code: z.string(), at: Iso, sentence: z.string() }).nullable(),
  nextTouchAt: Iso.nullable(),
  capsSentence: z.string(),
  inactivityReleaseAt: Iso.nullable(),
  ownerUserId: z.uuid(),
  ownerName: z.string(),
  handoffOverdue: z.boolean(),
});
export const ListResponse = z.object({ rows: z.array(ListRow), holdSentence: z.string().nullable() });

export const ChainLink = z.object({
  link: z.number().int().min(1).max(9),
  name: z.string(),
  effect: z.enum(LINK_EFFECTS),
  code: z.string().nullable(),
  sentence: z.string(),
});
export const PanelResponse = z.object({
  contactId: z.uuid(),
  assignment: z
    .object({
      id: z.uuid(),
      side: z.enum(SIDES),
      state: z.enum(STATES),
      chip: StateChip,
      epoch: z.number().int(),
      startedAt: Iso,
      pausedAt: Iso.nullable(),
      pauseReason: z.string().nullable(),
      pausedSentence: z.string().nullable(),
      endedAt: Iso.nullable(),
      endReason: z.string().nullable(),
      undoUntil: Iso.nullable(),
      ownerUserId: z.uuid(),
    })
    .nullable(),
  canStart: z.boolean(),
  startRefusal: z.object({ code: z.string(), sentence: z.string() }).nullable(),
  canResume: z.boolean(),
  chain: z.array(ChainLink),
  // b13 review B13S-2: built says this tree implements it (isa/sentences.ts ISA_BUILT_CAPABILITIES); the web reads it
  capabilities: z.array(z.object({ capability: z.string(), allowed: z.boolean(), built: z.boolean(), sentence: z.string() })),
  consent: z.array(z.object({ channel: z.enum(CHANNELS), sentence: z.string() })),
  zones: z.object({ zones: z.array(z.string()), source: z.enum(['explicit', 'union']), sentence: z.string() }),
  nextAllowedSendAt: Iso.nullable(),
  capsSentence: z.string(),
  lastDecision: z.object({ status: z.string(), codes: z.array(z.string()), at: Iso, sentence: z.string() }).nullable(),
  factsSent: z.array(z.object({ factKind: z.string(), listingId: z.uuid().nullable(), sentAt: Iso, source: z.string().nullable(), asOf: Iso.nullable() })),
  openOffer: z.object({ id: z.uuid(), status: z.string(), slots: z.array(z.object({ startsAt: Iso, endsAt: Iso })), expiresAt: Iso }).nullable(),
  heldTopics: z.array(z.object({ class: z.string(), since: Iso, sentence: z.string() })),
  // b12 recheck R19: closedReason says why the system closed it (null while open), so a lead-closed handoff is told
  // apart from one a sweep has not reached
  handoff: z.strictObject({ id: z.uuid(), reason: z.string(), slaClass: z.enum(SLA_CLASSES), slaDueAt: Iso, slaMetAt: Iso.nullable(), overdue: z.boolean(), confirmationStatus: z.string(), closedReason: HandoffClosedReason }).nullable(),
  // batch 13 isa-4 (b12 recheck R16 follow-up): the person's newest still-open handoff of an EARLIER assignment (a
  // restart with no human touch leaves it open, and its deadline still alerts); null when there is none
  earlierHandoff: z.strictObject({ id: z.uuid(), reason: z.string(), slaClass: z.enum(SLA_CLASSES), slaDueAt: Iso, slaMetAt: Iso.nullable(), overdue: z.boolean(), confirmationStatus: z.string(), closedReason: HandoffClosedReason }).nullable(),
  inactivityReleaseAt: Iso.nullable(),
  inactivitySentence: z.string().nullable(),
  block: z.object({ reason: z.string(), since: Iso, sentence: z.string() }).nullable(),
});
export const TurnRow = z.object({
  id: z.uuid(),
  seq: z.number().int(),
  epoch: z.number().int(),
  attempt: z.number().int(),
  triggerKind: z.string(),
  status: z.string(),
  stateBefore: z.string(),
  stateAfter: z.string().nullable(),
  channel: z.enum(CHANNELS).nullable(),
  messageKind: z.enum(['reply', 'initiated']).nullable(),
  messageId: z.uuid().nullable(),
  notBefore: Iso.nullable(),
  zones: z.array(z.string()).nullable(),
  decision: z.record(z.string(), z.unknown()),
  denied: z.array(z.unknown()),
  versions: z.object({ rules: z.string(), policy: z.string(), prompt: z.string() }),
  createdAt: Iso,
});
export const TurnsResponse = z.object({ turns: z.array(TurnRow) });

export const StartBody = z.strictObject({
  side: z.enum(SIDES),
  channels: z.array(z.enum(CHANNELS)).min(1).max(2).optional(),
  fromHandbackId: z.uuid().optional(),
});
export const ControlResult = z.object({
  assignmentId: z.uuid(),
  state: z.enum(STATES),
  epoch: z.number().int(),
  /** "1 message was already on its way at 10:02:13" (E22 pattern): what may still reach the person */
  inFlight: z.array(z.object({ messageId: z.uuid(), at: Iso, sentence: z.string() })),
  canceled: z.number().int(),
  undoUntil: Iso.nullable(),
  sentence: z.string(),
});
export const StartResult = ControlResult.extend({ stoppedEnrollment: z.boolean(), supersededProposals: z.number().int() });
export const PauseBody = z.strictObject({ reason: z.enum(['user']).optional() });
export const LiftBlockBody = z.strictObject({ inboundMessageId: z.uuid(), attestation: z.string().trim().min(20).max(2000) });
export const LiftBlockResult = z.object({ lifted: z.boolean() });
export const AckResult = z.strictObject({ handoffId: z.uuid(), acknowledgedAt: Iso, slaMet: z.boolean(), confirmationStatus: z.string(), closedReason: HandoffClosedReason });
export const ResolveResult = z.object({ assignmentId: z.uuid(), cleared: z.string() });
export const EscalationParams = z.strictObject({ id: z.uuid() });
export const ResolveBody = z.strictObject({ class: z.string().regex(/^[a-z_]{2,40}$/) });
