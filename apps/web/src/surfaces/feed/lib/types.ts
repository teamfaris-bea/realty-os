// View types of the API responses the agent surfaces read. They mirror the Zod response schemas of
// api/workspace (schemas.ts), api/leads (schemas.ts), api/comms (schemas.ts) and api/assistant
// (schemas.ts) field for field; apps/web may import @realty/api types only (lint), and those modules
// export Zod values rather than inferred types, so the shapes are restated here. There are no
// confidence fields and no scores on any of them (R-AST-13): the feed shows reasons, the assistant
// shows evidence.
import type { OneTapAction as CoreOneTapAction } from '@realty/core/priority';
import type { ReachReason } from '../../../reasons/index.js';

/** core's branded ids arrive as plain strings over JSON: same union, ids typed as string. */
type Plain<T> = T extends unknown ? { [K in keyof T]: NonNullable<T[K]> extends { readonly __brand: unknown } ? string | Exclude<T[K], NonNullable<T[K]>> : T[K] } : never;
export type OneTapAction = Plain<CoreOneTapAction>;
export type OneTapKind = OneTapAction['kind'];

// ---- feed (GET /feed) ----------------------------------------------------------------------------

export interface FeedReasonView {
  code: string;
  label: string;
}

export interface FeedCard {
  id: string;
  itemType: string;
  band: 'pinned' | 'scored';
  dueAt: string | null;
  contact: { id: string; name: string } | null;
  /** a task or promise card: the task it is about */
  task?: { id: string; title: string } | null;
  reasons: FeedReasonView[];
  primaryAction: OneTapAction;
  alternatives: OneTapAction[];
  subjectType: string;
  subjectId: string;
  assistantActionId: string | null;
  createdAt: string;
  // warm follow-up (R-TODAY-1): set on a follow-up card about a person, null or absent on every other card
  /** why the person is due: the card's own reason sentences */
  why?: string[] | null;
  stage?: { key: string; label: string } | null;
  lastTouch?: LastTouchView | null;
  lastAutomatic?: LastAutomaticView | null;
  importedHistoryAt?: string | null;
  nextPromise?: NextPromiseView | null;
  /** the latest human CONTACT, only when `lastTouch` is something newer that is not contact (a manual note) */
  lastConversation?: LastTouchView | null;
  /** R-TODAY-14: what stands at the one instant the Due line and the Last line are worded from (the server's story) */
  quiet?: QuietView | null;
}

export interface QuietView {
  basis: 'contact' | 'undelivered' | 'failed_dial' | 'touch_only' | 'imported' | 'never';
  at: string | null;
  attempt: { kind: 'text' | 'email' | 'call'; at: string; what: 'undelivered' | 'failed_dial' } | null;
}

/** The most recent HUMAN contact with the person the viewer may see (never an automated message). */
export interface LastTouchView {
  kind: 'call' | 'text' | 'email' | 'chat' | 'note' | 'appointment';
  at: string;
  byName: string | null;
  byMe: boolean;
  direction: 'inbound' | 'outbound' | null;
  outcome: string | null;
  snippet: string | null;
  /** the agent's own report of something that happened outside the app: always labelled "Logged by …" */
  reported: boolean;
}
export interface LastAutomaticView {
  kind: 'text' | 'email' | 'chat';
  at: string;
  bulk: boolean;
}
export interface NextPromiseView {
  taskId: string;
  text: string;
  kind: string;
  dueAt: string | null;
  dueAllDay: boolean;
  /** R-TODAY-19: for an all-day task, the zone its day is in (the task's, else the team's); null or absent otherwise */
  dueZone?: string | null;
  /** when it stops being on time (an all-day task: the end of its local day); absent on an older server's answer */
  deadlineAt?: string | null;
  overdue: boolean;
}

/** One person of the daily plan (R-TODAY-6), shaped like a card; `id` is the person's id. */
export type FollowUpTodayCard = FeedCard & {
  /** the person's tasks due today or earlier; the first is the one the row leads with (a due promise when there is one) */
  taskIds: string[];
  /** R-TODAY-15: the other due tasks the row names in its "Also due" line, and how many more it only counts */
  alsoDue?: { taskId: string; title: string }[];
  alsoDueMore?: number;
};

export interface FeedResponse {
  pinned: FeedCard[];
  scored: FeedCard[];
  total: number;
  generatedAt: string;
  /** the daily plan; absent on an answer of a server that does not send it */
  /**
   * `checked` / `complete` (R-TODAY-13): how many people the bounded read looked at, and whether it read every
   * candidate. Absent on an older server's answer: then `totalIsMinimum` alone says the read was not complete.
   */
  followUpToday?: { people: FollowUpTodayCard[]; total: number; totalIsMinimum: boolean; checked?: number; complete?: boolean };
}

// ---- contacts (GET /contacts/:id, /ponds/:id/cards, /contacts/:id/timeline) ----------------------

export type OwnershipState = 'unassigned' | 'offered' | 'owned' | 'in_pond' | 'closed';

export interface SourceView {
  id: string;
  name: string;
  kind: string;
}

export interface ContactCardView {
  id: string;
  view: 'card';
  displayName: string;
  intent: string | null;
  source: SourceView | null;
  createdAt: string;
  pondSummary: string | null;
  ownership: {
    state: OwnershipState;
    pondId: string | null;
    pondName: string | null;
    offerId: string | null;
    offerExpiresAt: string | null;
    offeredToMe: boolean;
    seq: number;
  };
}

export interface PointView {
  id: string;
  address: string;
  label: string;
  lineType: string;
  status: string;
  isPrimary: boolean;
}

export interface ProjectionView {
  state: OwnershipState;
  ownerUserId: string | null;
  pondId: string | null;
  offerId: string | null;
  offeredToUserId: string | null;
  offerExpiresAt: string | null;
  offerRound: number;
  ownedAt: string | null;
  firstTouchDueAt: string | null;
  firstTouchAt: string | null;
  firstTouchBreachedAt: string | null;
  releaseDueAt: string | null;
  closedReason: string | null;
  seq: number;
}

/** What a visitor typed in the contact's website chat (module 22, E77, E154): never a point; "typed in chat, not verified". */
export interface TypedInChat {
  kind: 'phone' | 'email';
  address: string;
  typedAt: string;
}

export interface ContactFullView {
  id: string;
  view: 'full';
  displayName: string;
  firstName: string | null;
  lastName: string | null;
  intent: string | null;
  stage: string;
  contactType: string;
  timezone: string | null;
  tags: string[];
  createdAt: string;
  lastHumanTouchAt: string | null;
  pondSummary: string | null;
  source: SourceView | null;
  attribution: { leadSourceId: string | null; campaignRef: string | null; adRef: string | null; sourceDetail: Record<string, unknown> };
  owner: { userId: string; displayName: string | null } | null;
  ownership: ProjectionView & { pondName: string | null; offeredToMe: boolean; ownedByMe: boolean };
  phones: PointView[];
  emails: PointView[];
  /** module 22: absent from an API older than it */
  typedInChat?: TypedInChat[];
  inquiries: {
    id: string;
    receivedAt: string;
    inquiryType: string;
    source: string | null;
    postalCode: string | null;
    priceMinCents: number | null;
    priceMaxCents: number | null;
    campaignRef: string | null;
    adRef: string | null;
    propertyText: string | null;
    message: string | null;
    outcome: string;
    /** b18 review B18S-2 (R-PORTAL-20): a quoted sign-in token removed at intake ('stored') or hidden here ('display');
     *  absent from an older API */
    redaction?: 'stored' | 'display' | null;
  }[];
  /**
   * R-OWN-24: merged into another record, so nothing is sent from this one (CONTACT_MERGED). `mergedIntoContactId` is
   * the record the person lives on now, only when this viewer may open it (R-PERM-5: null to the loser's collaborator).
   */
  merged: boolean;
  mergedIntoContactId: string | null;
}

export type ContactView = ContactCardView | ContactFullView;

export interface TimelineItem {
  id: string;
  type: string;
  occurredAt: string;
  actor: { userId: string; displayName: string | null } | null;
  detail: string | null;
  preview: string | null;
  /**
   * messages only (b18 Q-PORTAL-16): 'stored' = a quoted sign-in token was removed before the message was stored (the
   * record is not the exact original); 'display' = the token is hidden here only (an older record, unchanged)
   */
  redaction?: 'stored' | 'display' | null;
  note: string | null;
  provenance: string;
  /** messages only: the delivery status (sent, delivered, scheduled, blocked, failed, ...) */
  status?: string | null;
  /** messages only: why it was blocked, failed, canceled or is held (messages.status_reason) */
  statusReason?: string | null;
  /** messages only: the provider's error code on a failed or undelivered message */
  providerErrorCode?: string | null;
  /** blocked messages only: the opt-out the send-time decision rested on */
  blockedBy?: ReachReason | null;
  /** D5b: this inbound text is a phone's reaction to the team's text `targetMessageId` (R-REACT-6) */
  reaction?: TimelineReaction | null;
  /** D5b: the reaction in force on this team text (R-REACT-6) */
  reactedWith?: { reaction: TimelineReaction['reaction']; emoji: string | null; at: string } | null;
}

export interface TimelineReaction {
  action: 'add' | 'remove';
  reaction: 'love' | 'like' | 'dislike' | 'laugh' | 'emphasize' | 'question' | 'sticker' | 'emoji';
  emoji: string | null;
  targetMessageId: string;
  /** the team text's first 120 code points, "…" when cut */
  quote: string;
  /** what the phone sent, verbatim (at most 1,600 characters) */
  raw: string;
  /** the whole text would have read as an opt-out or a wrong number; it was not */
  narrowed: boolean;
}

export interface TimelineResponse {
  items: TimelineItem[];
  nextCursor: string | null;
}

export interface PondCardsResponse {
  pond: { id: string; name: string; claimable: boolean };
  cards: ContactCardView[];
  nextCursor: string | null;
}

/** GET /me/ponds (api/leads MyPondsResponse): the ponds I may claim from, and what blocks a claim there now. */
export interface MyPondsResponse {
  ponds: { id: string; name: string; isDefault: boolean; claimsPerDay: number; blockedBy: 'CLAIM_LIMIT_REACHED' | 'CAPACITY_REACHED' | null }[];
  claimsToday: number;
  uncontactedOwned: number;
  capacityCap: number;
}

export interface OwnershipResultResponse {
  result: { contactId: string; replayed: boolean; events: { seq: number; type: string; reasonCode: string; occurredAt: string }[]; projection: ProjectionView | null };
}

// ---- comms (messages, calls) -------------------------------------------------------------------

/**
 * A send-time (or preview) gate decision (core-compliance/2.0.0): allow or deny, nothing in between.
 * `id` names the stored blocked-send row (gate_decisions); allowed sends and previews are not stored.
 */
export interface DecisionView {
  id: string | null;
  outcome: 'allow' | 'deny';
  reasons: string[];
  explanation: string;
  phase: 'preview' | 'send';
}

export interface MessageView {
  id: string;
  /** 'web_chat' (module 22): a reply in the contact's website chat */
  channel: 'sms' | 'mms' | 'email' | 'web_chat';
  status: string;
  statusReason: string | null;
  purpose: 'marketing' | 'informational' | null;
  body: string;
  subject: string | null;
  scheduledFor: string | null;
  dispatchedAt: string | null;
}

export interface ComposeResponse {
  message: MessageView | null;
  decision: DecisionView | null;
  result: string;
}

export interface PreviewResponse {
  decision: DecisionView;
  body: string;
  /** D5a: the kind of number the text would go from (parts split at 152/66 on toll-free); optional in the schema, always sent */
  textSender?: 'local' | 'toll_free' | null;
}

export interface CallResponse {
  result: 'dialing' | 'gate' | 'failed';
  callId: string | null;
  bridgeToken: string | null;
  reason: string | null;
  decision: DecisionView;
}

export type CallOutcome = 'connected' | 'left_voicemail' | 'no_answer' | 'wrong_number' | 'bad_number' | 'do_not_call_request' | 'callback_requested';

export interface CallOutcomeResponse {
  callId: string;
  outcome: string;
  recordedAs: 'call' | 'task_for_current_owner';
  /** R-STG-2: the stage this outcome suggests, to confirm (the route never changes a stage); null: nothing */
  suggestedStage?: { stage: string; why: string; locked: boolean; alsoOffer: { stage: string; locked: boolean }[] } | null;
}

// ---- assistant (GET /assistant/inbox, approve, claims, saved searches) --------------------------

export interface EvidenceApiView {
  sourceType: string;
  sourceId: string;
  locator: Record<string, unknown>;
  snippet: string | null;
  verified: boolean;
  sourceAvailable: boolean;
  label: string;
}

export interface ClaimApiView {
  id: string;
  kind: string;
  text: string;
  needsReview: boolean;
  reviewStatus: string;
  due: { at: string; display: string; allDay: boolean } | null;
  evidence: EvidenceApiView[];
}

export interface ActionView {
  id: string;
  kind: string;
  category: string;
  status: string;
  contactId: string | null;
  contactName: string | null;
  explanation: string;
  primaryAction: 'send' | 'acknowledge';
  /** module 22: an approved draft may answer in web chat (the API's ActionView: sms, email or web_chat) */
  draft: { channel: 'sms' | 'email' | 'web_chat'; subject: string | null; body: string } | null;
  claims: ClaimApiView[];
  createdAt: string;
}

export interface ApproveResponse {
  actionId: string;
  status: string;
  result: string;
  messageId: string | null;
  decision: DecisionView | null;
  /** a replay (result 'noop'): the status of the message the first approval made */
  messageStatus?: string | null;
}

export interface SavedSearchListing {
  id: string;
  addressLine1: string;
  city: string;
  postalCode: string;
  status: string;
  listPriceCents: number | null;
  beds: number | null;
  bathsX10: number | null;
  sqft: number | null;
  propertyType: string | null;
}

export interface SavedSearchView {
  id: string;
  contactId: string;
  name: string;
  status: string;
  criteria: Record<string, unknown>;
  /** criterion → claim id */
  criterionEvidence: Record<string, string>;
  /** criteria that came from needs-review claims: shown, prefilled, but not checked (R-AST-5) */
  unchecked: string[];
  prefill: Record<string, unknown>;
  alertChannel: string;
  alertFrequency: string;
  matches: SavedSearchListing[];
  /** R-MLS-7: why a size criterion matches no MLS listing (the MLS gives no size), or some none; null: nothing to say */
  sizeNote?: string | null;
}

// ---- workspace (tasks, appointments, deals, listings, search) -----------------------------------

export interface WorkspaceEvidence {
  sourceType: string;
  sourceId: string;
  locator: Record<string, unknown>;
  snippet: string | null;
  verified: boolean;
  sourceAvailable: boolean;
  label: string;
}

export interface TaskView {
  id: string;
  kind: 'todo' | 'callback' | 'promise' | 'follow_up' | 'document';
  title: string;
  notes: string | null;
  dueAt: string | null;
  dueAllDay: boolean;
  dueTz: string | null;
  status: 'open' | 'done' | 'canceled';
  completedAt: string | null;
  assigneeUserId: string;
  contact: { id: string; name: string } | null;
  dealId: string | null;
  listingId: string | null;
  createdByKind: 'user' | 'assistant' | 'system' | 'import';
  needsReview: boolean;
  source: { actionId: string | null; claimText: string | null; evidence: WorkspaceEvidence[] } | null;
  createdAt: string;
}

export type AppointmentResult = 'agreement_signed' | 'follow_up' | 'not_a_fit' | 'no_decision' | 'no_show';

export interface AppointmentView {
  id: string;
  kind: 'buyer_consult' | 'listing_appointment' | 'consult' | 'other';
  startsAt: string;
  endsAt: string;
  location: string | null;
  status: 'scheduled' | 'held' | 'no_show' | 'canceled' | 'rescheduled';
  outcome: string | null;
  outcomeNote: string | null;
  outcomeLoggedAt: string | null;
  userId: string;
  contact: { id: string; name: string } | null;
  dealId: string | null;
  awaitingOutcome: boolean;
  createdByKind: string;
}

export type DealStage = 'prospect' | 'agreement_signed' | 'active' | 'under_contract' | 'closed' | 'lost';
export type DealSide = 'buy' | 'sell' | 'dual' | 'lease';

export interface DealView {
  id: string;
  name: string;
  side: DealSide;
  stage: DealStage;
  stageEnteredAt: string;
  /** `deleted`: soft-deleted (only an Owner or Admin sees one; for anyone else the contact is null) */
  primaryContact: { id: string; name: string; deleted: boolean } | null;
  ownerUserId: string;
  listingId: string | null;
  priceCents: number | null;
  expectedCloseDate: string | null;
  agreementSignedAt: string | null;
  underContractAt: string | null;
  closedAt: string | null;
  lostReason: string | null;
  attribution: { leadSourceId: string | null; leadSourceName: string | null; campaignRef: string | null; adRef: string | null; sourceInquiryId: string | null };
  rowVersion: number;
  createdAt: string;
}

export interface DealDateView {
  id: string;
  kind: string;
  label: string | null;
  dueOn: string;
  completedAt: string | null;
}

export interface DealDetailView extends DealView {
  dates: DealDateView[];
  members: { userId: string; role: 'co_agent' | 'tc' | 'isa' }[];
  contacts: { contactId: string; role: string }[];
  history: { fromStage: string | null; toStage: string; changedAt: string; byUserId: string | null }[];
}

export interface FinancialsView {
  grossCommissionCents: number | null;
  commissionRateBps: number | null;
  teamSplitBps: number | null;
  agentSplitBps: number | null;
  referralFeeCents: number | null;
  commissionStatus: 'estimated' | 'confirmed' | 'paid';
  updatedByUserId: string;
  updatedAt: string;
}

export interface ListingView {
  id: string;
  source: 'team' | 'mls';
  mlsNumber: string | null;
  status: 'coming_soon' | 'active' | 'pending' | 'sold' | 'withdrawn' | 'expired';
  addressLine1: string;
  addressLine2: string | null;
  city: string;
  region: string;
  postalCode: string;
  listPriceCents: number | null;
  beds: number | null;
  bathsX10: number | null;
  sqft: number | null;
  propertyType: string | null;
  listingAgentUserId: string | null;
  description: string | null;
  listDate: string | null;
  editable: boolean;
  createdAt: string;
}

export interface ListingDetailView extends ListingView {
  priceHistory: { priceCents: number; changedAt: string }[];
  contacts: { contactId: string; role: string }[];
  showings: { total: number; completed: number; withFeedback: number };
}

export interface ShowingView {
  id: string;
  listingId: string;
  startsAt: string;
  endsAt: string | null;
  buyerAgentName: string | null;
  buyerAgentBrokerage: string | null;
  buyerContactId: string | null;
  status: 'scheduled' | 'completed' | 'canceled' | 'no_show';
  source: string;
  feedback: { id: string; rating: number | null; comments: string | null; source: string; receivedAt: string }[];
}

export type SearchGroup = 'contacts' | 'listings' | 'deals' | 'notes' | 'messages';

export interface SearchResponse {
  contacts: { id: string; name: string; view: 'full' | 'card'; ownershipState: string; matchedOn: 'name' | 'phone' | 'email' | 'address' }[];
  listings: { id: string; address: string; city: string; status: string; listPriceCents: number | null }[];
  deals: { id: string; name: string; stage: string }[];
  notes: { id: string; contactId: string | null; dealId: string | null; snippet: string; createdAt: string }[];
  messages: { id: string; contactId: string; channel: string; direction: string; snippet: string; occurredAt: string }[];
  incomplete: SearchGroup[];
}
