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
const ConfirmationNotSent = z.enum(['by_hand', 'unreachable', 'not_needed']).nullable();
/** b14 to-do: the handoff's pending post-handoff message: an appointment confirmation or a holding line (null: none). Optional so older clients' fixtures stay valid. */
const PendingKind = z.enum(['confirmation', 'holding_line']).nullable().optional();
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
  /** the approved version, with (R-ISA-33) its number and its words by section: what the assistant may and may not do */
  policy: z.object({ versionId: z.uuid(), versionSha: z.string(), capabilities: z.array(z.string()), channels: z.array(z.string()), versionNo: z.number().int().nullable(),
    sections: z.array(z.object({ key: z.string(), title: z.string(), may: z.array(z.string()), mayNot: z.array(z.string()) })) }).nullable(),
  /** R-ISA-34: what changed since the version this agent confirmed, and what it did to their care; null when they confirmed the current one (or never opted in) */
  policyChange: z.object({ state: z.enum(['narrowed', 'widened', 'revoked']), fromVersionNo: z.number().int().nullable(),
    diff: z.object({ adds: z.array(z.string()), removes: z.array(z.string()), changes: z.array(z.string()), wider: z.boolean() }).nullable(), sentence: z.string() }).nullable(),
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
  link: z.number().int().min(1).max(11), // b18: link 11 "Lead source" (item f); link 10 "Seller home" (ISA-3 H5) was above the old max(9)
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
  // b18 review item 3: whether the viewer may tap Continue AI care now, and why not when a lead-source setting refuses it
  canContinue: z.boolean(),
  continueRefusal: z.object({ code: z.string(), sentence: z.string() }).nullable(),
  chain: z.array(ChainLink),
  // b13 review B13S-2: built says this tree implements it (isa/sentences.ts ISA_BUILT_CAPABILITIES); the web reads it
  // b14 to-do (B13S-2 low): calendarConnected on the book_appointments row only (the owner's calendar is live now)
  capabilities: z.array(z.object({ capability: z.string(), allowed: z.boolean(), built: z.boolean(), calendarConnected: z.boolean().optional(), sentence: z.string() })),
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
  // b13 review B13S-3: confirmationNotSent says why a confirmation did not go out (by hand, unreachable, not needed)
  // b14 to-do (b13 review F8-ui low): pendingKind says what the post-handoff message is (confirmationStatus covers both)
  handoff: z.strictObject({ id: z.uuid(), reason: z.string(), slaClass: z.enum(SLA_CLASSES), slaDueAt: Iso, slaMetAt: Iso.nullable(), overdue: z.boolean(), confirmationStatus: z.string(), confirmationNotSent: ConfirmationNotSent, closedReason: HandoffClosedReason, pendingKind: PendingKind }).nullable(),
  // batch 13 isa-4 (b12 recheck R16 follow-up): the person's newest still-open handoff of an EARLIER assignment (a
  // restart with no human touch leaves it open, and its deadline still alerts); null when there is none
  earlierHandoff: z.strictObject({ id: z.uuid(), reason: z.string(), slaClass: z.enum(SLA_CLASSES), slaDueAt: Iso, slaMetAt: Iso.nullable(), overdue: z.boolean(), confirmationStatus: z.string(), confirmationNotSent: ConfirmationNotSent, closedReason: HandoffClosedReason, pendingKind: PendingKind }).nullable(),
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

// ---- the team AI policy (R-ISA-33, R-ISA-34; isa/policy.ts) --------------------------------------------------------
const Sha = z.string().regex(/^[0-9a-f]{64}$/);
/** The content as stored and as sent: one AiIsaContent. Its shape is core's to judge (validateAiIsaContent), so a
 *  refusal comes back per field in words (422 AI_ISA_POLICY_INVALID) rather than as a bare 400. */
const PolicyContent = z.record(z.string(), z.unknown());
export const PolicyField = z.object({
  key: z.string(),
  path: z.array(z.string()),
  section: z.string(),
  kind: z.enum(['options', 'choice', 'toggle', 'int', 'time', 'text']),
  label: z.string(),
  help: z.string().optional(),
  options: z.array(z.object({ value: z.union([z.string(), z.number()]), label: z.string() })).optional(),
  locked: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  unit: z.string().optional(),
  maxLength: z.number().optional(),
});
const PolicySection = z.object({ key: z.string(), title: z.string(), may: z.array(z.string()), mayNot: z.array(z.string()) });
const PolicyDiff = z.object({ adds: z.array(z.string()), removes: z.array(z.string()), changes: z.array(z.string()), wider: z.boolean() });
const PolicyIssue = z.object({ code: z.string(), field: z.string().nullable(), sentence: z.string() });
export const POLICY_EFFECTS = ['first', 'narrower', 'wider', 'after_revoke'] as const;
const PolicyVersion = z.object({
  versionId: z.uuid(),
  versionNo: z.number().int(),
  contentSha256: z.string(),
  /** null when the stored content no longer passes the validator (it is then not shown as words either) */
  content: PolicyContent.nullable(),
  sections: z.array(PolicySection),
  decidedAt: Iso.nullable(),
  decidedBy: z.string().nullable(),
  decidedByRole: z.string().nullable(),
});
export const PolicyView = z.object({
  state: z.enum(['none', 'draft_only', 'approved', 'approved_with_draft', 'revoked', 'revoked_with_draft']),
  sentence: z.string(),
  /** the validator's field list (core AI_ISA_POLICY_FIELDS): the edit form is built from it */
  fields: z.array(PolicyField),
  textVersion: z.string(),
  /** live AI care now, and agents opted in: what a pause would reach */
  underCare: z.number().int(),
  optedIn: z.number().int(),
  approved: PolicyVersion.nullable(),
  /** the last revoked version, only while nothing is approved */
  revoked: PolicyVersion.nullable(),
  draft: z.object({
    versionId: z.uuid(),
    versionNo: z.number().int(),
    contentSha256: z.string(),
    content: PolicyContent,
    sections: z.array(PolicySection),
    savedAt: Iso,
    savedBy: z.string(),
    issues: z.array(PolicyIssue),
    /** what approving it does; null while it has issues */
    effect: z.enum(POLICY_EFFECTS).nullable(),
    effectSentence: z.string(),
    /** against the approved version; null when none is approved */
    diff: PolicyDiff.nullable(),
    /** the exact text the Owner accepts to approve it (sent back verbatim); null while it has issues */
    approvalText: z.string().nullable(),
  }).nullable(),
  /** the exact text accepted to revoke the approved version; null when none is approved */
  revokeText: z.string().nullable(),
  /** what THIS viewer may do now: a control the server would refuse is never offered */
  can: z.object({ create: z.boolean(), saveDraft: z.boolean(), approve: z.boolean(), revoke: z.boolean() }),
  /** true for an Admin: only the Owner approves */
  approveOwnerOnly: z.boolean(),
});
export const PolicyCreateResult = z.object({ created: z.boolean(), policy: PolicyView });
export const PolicyDraftBody = z.strictObject({ content: PolicyContent });
export const PolicyDecisionBody = z.strictObject({ versionId: z.uuid(), contentSha256: Sha, attestation: z.string().min(20).max(600) });
export const PolicyApproveResult = z.object({
  effect: z.enum(POLICY_EFFECTS),
  /** true: running AI care continues (first, narrower); false: it is paused until each agent re-confirms */
  careContinues: z.boolean(),
  pausedCare: z.number().int(),
  agentsToReconfirm: z.number().int(),
  sentence: z.string(),
  replayed: z.boolean(),
  policy: PolicyView,
});
export const PolicyRevokeResult = z.object({ pausedCare: z.number().int(), sentence: z.string(), replayed: z.boolean(), policy: PolicyView });
