// Every code module 75 sends, in words (CONVENTIONS §7: the web never shows a raw code; R-ISA-22). The Records over
// core's ISA_END_REASONS, ISA_PAUSE_REASONS and ESCALATION_CLASSES, the block reasons, the turn statuses and triggers
// are exhaustive at compile time; words.test.ts proves the rest cover every code the API defines. An unknown code
// becomes "Another check", with no claim about where its details are.
//
// Copy rules (docs/AI_ISA.md §10 "As built (ISA-4)"):
// - say only what the API states; "Not available yet" for anything unbuilt;
// - no "you/your" sentence reaches someone it is not about: anything about the lead's owner takes a `Viewer`;
// - R-ISA-23: no sentence lets the AI near money, price, value, offers, negotiation, commission, contracts, legal or
//   lending, now or after "I've handled it" (that continues the conversation, never the topic);
// - the assistant is never a person: "{Owner first}'s AI assistant" or "the AI assistant", never a name alone.
// Imports from core are type-only: core's runtime would pull zod and the authz matrix into the phone bundle.
import type { EscalationClass, IsaEndReason, IsaLineId, IsaPauseReason } from '@realty/core/isa';
import { messageFor } from '../../shell/index.js';
import type { HandoffClosedReason, SlaClass } from './api.js';

/** Who reads a sentence about the lead's owner. */
export interface Viewer {
  isOwner: boolean;
  /** the owner's first name, or a neutral fallback */
  ownerFirst: string;
}

export const OTHER_CHECK = 'Another check';

/** "you" for the owner, else the owner's first name. */
export const ownerWho = (v: Viewer) => (v.isOwner ? 'you' : v.ownerFirst);
export const ownerWhoCap = (v: Viewer) => (v.isOwner ? 'You' : v.ownerFirst);

export function firstOf(name: string | null | undefined, fallback = 'The owner'): string {
  const n = (name ?? '').trim();
  return n === '' ? fallback : n.split(/\s+/)[0]!;
}

// ---- end, pause, escalation ---------------------------------------------------------------------------------------

export const END_WORDS: Record<IsaEndReason, string> = {
  appointment_booked: 'An appointment was booked.',
  ready_buyer: 'They look ready to buy, so it came back to a person.',
  ready_seller: 'They look ready to sell, so it came back to a person.',
  escalated: 'They raised something a person must answer.',
  opted_out: 'They opted out.',
  suppressed: 'Their phone or email is suppressed.',
  do_not_contact: 'They asked not to be contacted.',
  wrong_number: 'It was the wrong number.',
  owner_change: 'The lead moved to another owner.',
  merged: 'The record was merged into another.',
  owner_inactive: 'The owner is no longer active on the team.',
  tenant_off: 'The team turned the AI assistant off.',
  optin_revoked: 'The owner withdrew their AI assistant opt-in.',
  policy_updated: 'The team changed the AI rules.',
  inactivity_warning: 'They are close to returning to the pond.',
  dormant: 'They stopped answering, so it stopped following up.',
  limit_reached: 'It reached the message or day limit of the team policy.',
  delivery_problem: 'Two messages in a row were not delivered.',
  listed_elsewhere: 'Their home is listed with another brokerage.',
  active_client: 'They are a client on an open deal or an active listing.',
  shared_address: 'Another person shares one of their phone numbers or emails.',
  point_removed: 'A phone or email bound at the start was removed.',
  pause_expired: 'It stayed paused for 72 hours.',
  ended_by_user: 'Someone on the team ended it.',
  taken_over: 'Someone on the team took over.',
  has_agent: 'They said they already have an agent.',
  not_interested: 'They said they are not interested.',
  not_a_lead: 'They are not a lead.',
  reinquiry_period: 'Continued as a new AI care period.',
  zone_windows_do_not_overlap: 'No hour is outside quiet hours in every time zone they may be in.',
};

export const PAUSE_WORDS: Record<IsaPauseReason, string> = {
  user: 'Someone on the team paused it.',
  human_contact: 'Someone on the team texted, emailed or called them.',
  unverified_sender: 'A message came from an address that could not be verified as theirs.',
  call: 'There was a call with them.',
  chat: 'They wrote in the website chat.',
  synced_mail: 'An email with them was synced from a mailbox.',
  media: 'They sent a photo or file.',
  pack_withdrawn: 'Counsel review was withdrawn.',
  ai_off: 'AI features were turned off for the team.',
  approval_revoked: 'The team policy approval was revoked.',
  policy_updated: 'The team changed the AI rules.',
  reinquiry: 'They inquired again.',
  possible_listing: 'Their home may be listed; it needs a check.',
  check_this: 'Something needs a person to check.',
  taking_over: 'Someone on the team is taking over.',
  ending: 'Someone on the team is ending it.',
};

/** The always-human topics (R-ISA-23): their sentences never say the AI may come back to them. */
export const ALWAYS_HUMAN: readonly EscalationClass[] = ['pricing_negotiation', 'financial', 'legal_contract', 'fair_housing'];

export const ESCALATION_WORDS: Record<EscalationClass, { topic: string; sentence: string }> = {
  opt_out: { topic: 'opting out', sentence: 'They opted out.' },
  wrong_number: { topic: 'wrong number', sentence: 'They said it is the wrong number.' },
  possible_opt_out: { topic: 'maybe opting out', sentence: 'They may want to stop hearing from the team.' },
  safety: { topic: 'safety', sentence: 'They wrote something about their safety. Reach them now.' },
  fraud_risk: { topic: 'a possible scam', sentence: 'Their message may involve a scam or a money transfer.' },
  consent_dispute: { topic: 'consent', sentence: 'They questioned whether they agreed to be contacted.' },
  privacy_request: { topic: 'their data', sentence: 'They asked about their personal data.' },
  ai_declined: { topic: 'not wanting AI', sentence: 'They did not want to talk with an AI assistant.' },
  complaint: { topic: 'a complaint', sentence: 'They complained.' },
  human_request: { topic: 'talking to a person', sentence: 'They asked to talk to a person.' },
  fair_housing: { topic: 'the area', sentence: 'They asked about the area or who lives there. Answer this yourself.' },
  legal_contract: {
    topic: 'contracts or legal questions',
    sentence: 'They asked about a contract or a legal question. The AI assistant never discusses contracts or legal questions; marking it handled lets it continue the conversation, never this topic.',
  },
  third_party: { topic: 'someone else', sentence: 'Someone other than the lead wrote.' },
  other_agent: { topic: 'another agent', sentence: 'They mentioned working with another agent.' },
  pricing_negotiation: {
    topic: 'price or value',
    sentence: 'They asked about price or value. The AI assistant never discusses price; it stays off this topic, and marking it handled lets it continue the conversation, never this topic.',
  },
  financial: {
    topic: 'money or lending',
    sentence: 'They asked about money or lending. The AI assistant never discusses money or lending; marking it handled lets it continue the conversation, never this topic.',
  },
  sensitive_personal: { topic: 'something personal', sentence: 'They shared something personal.' },
  language: { topic: 'another language', sentence: 'They wrote in a language the AI assistant does not write.' },
  data_unavailable: { topic: 'market data', sentence: 'They asked for data the AI assistant does not have.' },
  booking_unavailable: { topic: 'booking', sentence: 'A time could not be booked.' },
  uncertain: { topic: 'an unclear message', sentence: 'The AI assistant could not tell what they meant.' },
  limit: { topic: 'a limit', sentence: 'A limit of the team policy was reached.' },
  flood: { topic: 'many messages', sentence: 'They sent many messages in a short time.' },
};

export const escalationTopic = (c: string) => (ESCALATION_WORDS as Record<string, { topic: string; sentence: string }>)[c]?.topic ?? 'something to check';
export const escalationSentence = (c: string) => (ESCALATION_WORDS as Record<string, { topic: string; sentence: string }>)[c]?.sentence ?? OTHER_CHECK;
export const endWords = (r: string | null | undefined) => (r ? ((END_WORDS as Record<string, string>)[r] ?? OTHER_CHECK) : OTHER_CHECK);
export const pauseWords = (r: string | null | undefined) => (r ? ((PAUSE_WORDS as Record<string, string>)[r] ?? OTHER_CHECK) : OTHER_CHECK);

// ---- who holds a handoff (batch 13 isa-4 F4; ISA-2b Q1: isa/handoff.ts recipientFor) ---------------------------------

/**
 * Who holds a handoff, for this reader. ISA-2b's recipient is the assignment's owner, the lead's new owner after a move,
 * or whoever took over. "you" for the reader; a first name only where the web knows it (the assignment's owner, the
 * contact's current owner); "the person who took over" after a take over; otherwise "someone else on the team". Null
 * when nobody is the recipient: the card went to the previous owner's team lead and Owner/Admin.
 */
export function handoffHolder(o: {
  recipientUserId: string | null;
  viewerUserId: string | null;
  ownerUserId: string | null | undefined;
  ownerFirst: string;
  currentOwner?: { userId: string; displayName: string | null } | null;
  tookOver: boolean;
}): string | null {
  const r = o.recipientUserId;
  if (!r) return null;
  if (r === o.viewerUserId) return 'you';
  if (o.ownerUserId && r === o.ownerUserId) return o.ownerFirst;
  if (o.currentOwner && r === o.currentOwner.userId) return firstOf(o.currentOwner.displayName, "the lead's owner");
  return o.tookOver ? 'the person who took over' : 'someone else on the team';
}
export const NO_RECIPIENT_WORDS = 'The handoff went to the team leads and Owner/Admin.';

// ---- ISA-2b's package fields (isa/handoff.ts, isa/booking/book.ts; batch 13 isa-4 F6) -------------------------------

export const APPOINTMENT_KIND_WORDS: Record<string, string> = { buyer_consult: 'A buyer consultation', listing_appointment: 'A listing appointment', consult: 'A consultation' };
export const appointmentKindWords = (k: string | null | undefined) => (k ? APPOINTMENT_KIND_WORDS[k] : undefined) ?? 'An appointment';
/** The AI-origin saved search as it stood when care ended (the package is frozen). */
export const SAVED_SEARCH_WORDS: Record<string, string> = {
  proposed: 'The AI assistant suggested a saved search; it was waiting for approval when AI care ended.',
  approved: 'A saved search the AI assistant suggested was approved but not started when AI care ended.',
  active: 'A saved search the AI assistant suggested was sending alerts when AI care ended.',
  paused: 'A saved search the AI assistant suggested was paused when AI care ended.',
};
export const savedSearchWords = (s: string) => SAVED_SEARCH_WORDS[s] ?? OTHER_CHECK;

// ---- ISA-2b's booking cards (isa/booking/book.ts bookedCardInTx; batch 13 isa-4 F1) ---------------------------------

/**
 * The booked time from the card's own sentence ("Booked {time} after AI care ended; …"): core formatSlot's line in the
 * organizer's zone with its zone label. Null when the sentence has no time (the API's "the agreed time") or changed.
 */
export function bookedWhen(label: string | null | undefined): string | null {
  const t = /^Booked (.+?) after AI care ended;/.exec(label ?? '')?.[1] ?? null;
  return t === null || t === 'the agreed time' ? null : t;
}
/** What a booking card says: AFTER_END is a booking after care ended; NOT_HANDED_BACK is one care did not hand back (it pauses care). */
export function bookedWords(type: 'booked_after_end' | 'booked_not_handed_back', when: string | null): string {
  const at = when ? ` for ${when}` : '';
  const then = 'The confirmation was not sent: confirm or cancel it yourself.';
  return type === 'booked_after_end' ? `An appointment was booked${at} after AI care ended. ${then}` : `An appointment was booked${at}. ${then}`;
}
/** The state care is in now, from the panel (never assumed from a card). */
export const CARE_STATE_WORDS: Record<'live' | 'paused' | 'ended', string> = {
  live: 'AI care is on.',
  paused: 'AI care is paused, so nobody is following up automatically.',
  ended: 'AI care has ended.',
};

/** A handoff reason is an end reason; an escalation handoff may carry the class instead. */
export function handoffWhy(reason: string, escalation?: string | null): string {
  if (escalation) return escalationSentence(escalation);
  return (END_WORDS as Record<string, string>)[reason] ?? escalationSentence(reason);
}

// ---- blocks (0080_ai_isa.sql, ai_isa_person_blocks.reason; V18) -----------------------------------------------------

export const BLOCK_REASONS = ['opted_out', 'possible_opt_out', 'complaint', 'wrong_number', 'has_agent', 'ai_declined', 'consent_dispute', 'do_not_contact'] as const;
export type BlockReason = (typeof BLOCK_REASONS)[number];
/** These never lift, not even by the system (controls.ts; the person-blocks guard of 0080 and 0081). */
export const NOT_LIFTABLE: ReadonlySet<string> = new Set(['opted_out', 'do_not_contact', 'wrong_number']);

export const BLOCK_WORDS: Record<BlockReason, string> = {
  opted_out: "They opted out. AI care can't restart for them.",
  do_not_contact: "They asked not to be contacted. AI care can't restart for them.",
  wrong_number: "It was the wrong number. AI care can't restart for them.",
  possible_opt_out: 'They may have asked to stop. AI care restarts only after a new message from them and the owner’s written confirmation.',
  complaint: 'They complained. AI care restarts only after a new message from them and the owner’s written confirmation.',
  has_agent: 'They said they have an agent. AI care restarts only after a new message from them and the owner’s written confirmation.',
  ai_declined: 'They did not want an AI assistant. AI care restarts only after a new message from them and the owner’s written confirmation.',
  consent_dispute: 'They questioned their consent. AI care restarts only after a new message from them and the owner’s written confirmation.',
};
export const blockWords = (r: string) => (BLOCK_WORDS as Record<string, string>)[r] ?? OTHER_CHECK;

// ---- turns (0080_ai_isa.sql, ai_isa_turns.trigger_kind and status) --------------------------------------------------

export const TURN_TRIGGERS = ['start', 'inbound', 'timer', 'listing_event', 'offer', 'booking', 'control', 'sweep'] as const;
export const TURN_STATUSES = ['deciding', 'sending', 'sent', 'deferred', 'no_reply', 'stale', 'canceled_paused', 'blocked', 'canceled', 'unknown', 'escalated', 'handed_off'] as const;

export const TRIGGER_WORDS: Record<(typeof TURN_TRIGGERS)[number], string> = {
  start: 'First message',
  inbound: 'Reply to their message',
  timer: 'Follow-up',
  listing_event: 'Follow-up about a listing',
  offer: 'Times offered',
  booking: 'With the booking',
  control: 'After a resume',
  sweep: 'Follow-up',
};
export const STATUS_WORDS: Record<(typeof TURN_STATUSES)[number], string> = {
  deciding: 'Still deciding.',
  sending: 'Handed to sending.',
  sent: 'Sent.',
  deferred: 'Waiting until sending is allowed.',
  no_reply: 'Decided not to write.',
  stale: 'Dropped: something newer came in.',
  canceled_paused: 'Dropped: AI care was paused.',
  blocked: 'Not sent: a send check refused it.',
  canceled: 'Canceled.',
  unknown: 'The outcome is not known yet.',
  escalated: 'Handed to a person.',
  handed_off: 'Handed back with a handoff.',
};
export const triggerWords = (t: string) => (TRIGGER_WORDS as Record<string, string>)[t] ?? 'Follow-up';
export const statusWords = (s: string) => (STATUS_WORDS as Record<string, string>)[s] ?? OTHER_CHECK;

/** A denied entry is "CODE:item"; only the CODE part is said. */
export const DECISION_CODE_WORDS: Record<string, string> = {
  ISA_QUIET_HOURS: 'Quiet hours where they may be',
  ISA_CAP_REACHED: 'A daily limit was reached',
  ISA_MIN_GAP: 'Too soon after the last message',
  ISA_CHANNEL_NOT_ALLOWED: 'That channel is not allowed',
  ISA_CONSENT_EVIDENCE_MISSING: 'The consent it needs is not recorded',
  ISA_DNC_UNVERIFIED: 'No fresh Do Not Call check',
  ISA_REPLY_WINDOW_CLOSED: 'The 24-hour reply window had closed',
  CAPABILITY_NOT_AVAILABLE: 'Not allowed by the policy or the opt-in',
  SIDE_MISMATCH: 'Not for this side (buyer or seller)',
  HANDLE_UNKNOWN: 'It referred to something it was not given',
  DUPLICATE_ACTION: 'Already done',
  TOPIC_HELD: 'The topic is waiting on a person',
  COMPS_UNAVAILABLE: 'Recent sales are not available',
  SAVED_SEARCH_NOT_ALLOWED: 'A saved search is not allowed here',
  CALENDAR_NOT_LIVE: 'The calendar is not connected',
  OFFER_LIVE: 'Times are already offered',
  NO_MEET_REQUEST: 'They did not ask to meet',
  SLOT_NOT_OFFERED: 'That time was not offered',
  OFFER_NOT_DELIVERED: 'The times were not delivered',
  QUOTE_BEFORE_OFFER: 'Their answer came before the times',
  OWN_TEXT_UNRELIABLE: 'It could not read its own earlier text reliably',
  SLOT_MISMATCH: 'Their answer does not match a time',
  SLOT_AMBIGUOUS: 'Their answer could mean more than one time',
  CONFIRMATION_TOO_LATE: 'Too late to confirm',
  QUOTE_NOT_VERIFIED: 'A quote could not be verified',
  QUOTE_NOT_CLIENT: 'A quote was not their words',
  QUOTE_IS_TEAM_TEXT: 'A quote was the team’s own text',
  VALUE_NOT_QUOTED: 'A value was not in their words',
  NOT_JSON: 'The AI answer could not be read',
  OVERSIZED: 'The AI answer was too long',
  SCHEMA: 'The AI answer was not in the expected form',
  MODEL_FAILED: 'The AI service did not answer',
  // ISA-2b offers, booking and the buyer bundle (isa/sentences.ts BOOKING_SENTENCES, BUNDLE_SENTENCES), reader-neutral
  CALENDAR_UNAVAILABLE: "The owner's calendar could not be read, so no times were offered",
  KIND_NOT_ALLOWED: 'That appointment kind is not allowed by the opt-in or the team policy',
  APPOINTMENT_ALREADY_SET: 'They already have an appointment with the team',
  NO_FREE_SLOT: 'No free time fits the availability, the notice period and their time zones',
  NO_AVAILABILITY: 'The availability leaves no hours to offer',
  OFFER_EXPIRED: 'The offered times expired before they answered',
  CARE_PAUSED: 'AI care was paused before the booking',
  CARE_NOT_LIVE: 'AI care ended before the booking',
  CONFIRMATION_ON_HOLD: 'Sending is on hold, so it did not book a time it could not confirm',
  SLOT_TAKEN: 'That time was just taken; new times were offered',
  SLOT_SOURCE_CHANGED: 'The calendar changed; new times were offered',
  CAPABILITY_OFF: 'Sharing listings is not on for this lead',
  CRITERIA_INCOMPLETE: 'Not enough of what they want yet to share a home',
  CONSENT_TIER_MISSING: 'No consent from their own form for messages they did not ask for',
  MLS_NOT_ELIGIBLE: 'No MLS feed may reach clients right now',
  LEASE_UNCHECKED: 'Matching MLS rows are not checked for leases yet',
  NO_MATCH: 'No current listing matches what they said',
  AI_ISA_CONFIRMATION_NOT_SENT: 'The confirmation was not sent',
};
export function decisionCodeWords(entry: unknown): string {
  const code = String(entry ?? '').split(':')[0]!;
  return DECISION_CODE_WORDS[code] ?? OTHER_CHECK;
}

// ---- the chain (repo.ts:229-263; V5: owner and non-owner variants) -------------------------------------------------

export const CHAIN_CODE_WORDS: Record<string, string> = {
  AI_ISA_LIVE_OFF: 'AI assistant sending is off on this deployment.',
  AI_ISA_NOT_CLEARED: 'Waiting on counsel review (platform:ai_isa).',
  AI_ISA_OFF: 'The team turned the AI assistant off.',
  AI_OFF: 'AI features are off for the team.',
  ISA_CAP_REACHED: "The team's daily AI assistant limit is reached; it continues on its own when the limit resets.",
  POLICY_UPDATED: 'The team updated the AI rules; the owner re-attests to continue.',
  AI_ISA_POLICY_NOT_APPROVED: 'The team policy approval was revoked.',
  AI_ISA_NO_OPTIN: 'The owner’s opt-in is no longer active.',
  AI_ISA_NOT_ROOT: 'The record was merged or deleted.',
  OWNER_CHANGED: 'The lead moved to another owner.',
  OWNER_INACTIVE: 'The owner is no longer active.',
  REINQUIRY: 'They inquired again; AI care is paused so the new inquiry is seen.',
  POINT_REMOVED: 'A phone or email bound at the start was removed.',
  ISA_STOPPED: 'They opted out, were suppressed or asked not to be contacted.',
  ISA_SHARED_ADDRESS: 'Another person shares one of their phone numbers or emails.',
  ISA_ACTIVE_CLIENT: 'They are a client on an open deal or an active listing.',
};

const LINK_OK: Record<number, (v: Viewer) => string> = {
  1: () => 'Sending is allowed on this deployment.',
  2: () => 'Counsel cleared the AI assistant.',
  3: () => 'The team turned the AI assistant on.',
  4: () => 'The team policy is approved.',
  5: (v) => (v.isOwner ? 'You opted in.' : `${v.ownerFirst} opted in.`),
  6: (v) => (v.isOwner ? 'You own this lead, and the phone and email bound at the start are live.' : `${v.ownerFirst} owns this lead, and the phone and email bound at the start are live.`),
  7: () => 'No opt-out since care started.',
  8: () => 'No shared phone or email and no open deal.',
};
export const LINK_NAME: Record<number, string> = { 1: 'Live sending', 2: 'Counsel review', 3: 'Team switch', 4: 'Team policy', 5: 'Opt-in', 6: 'Lead', 7: 'Opt-outs', 8: 'Exclusivity' };
export const EFFECT_WORDS: Record<string, string> = { ok: 'Holds', hold: 'Holding sending', pause: 'Pauses care', end: 'Ends care' };

export function chainLinkWords(l: { link: number; effect: string; code: string | null }, v: Viewer): string {
  if (l.effect === 'ok') return LINK_OK[l.link]?.(v) ?? 'Holds.';
  return (l.code && CHAIN_CODE_WORDS[l.code]) || OTHER_CHECK;
}

// ---- capabilities ---------------------------------------------------------------------------------------------------

export const CAPABILITY_WORDS: Record<string, string> = {
  converse: 'Talk with them by text and email',
  share_listings: 'Share listings that fit their search',
  propose_saved_search: 'Suggest a saved search for you to approve',
  seller_competition: 'Share competing listings with sellers',
  seller_sold_comps: 'Share recent sales with sellers',
  book_appointments: 'Book appointments on your calendar',
};
/**
 * The panel's "What it may do", rewritten for the reader (V5, V6). b13 review B13S-2: allowed and built are the API's
 * (the policy and the opt-in, as the turn grants them; ISA_BUILT_CAPABILITIES), never a web constant. Recent sales are
 * built and dark: allowed says what they still wait for; not allowed says only the opt-in or policy, one reason.
 */
export const SOLD_COMPS_WAIT = 'none go out until counsel review of platform:cma and platform:ai_isa_seller_data is recorded and the MLS licence allows it';
export function capabilityLine(c: { capability: string; allowed: boolean; built?: boolean }, v: Viewer): string {
  const what = (CAPABILITY_WORDS[c.capability] ?? 'Another capability').replace('your calendar', v.isOwner ? 'your calendar' : `${v.ownerFirst}'s calendar`).replace('for you to approve', v.isOwner ? 'for you to approve' : `for ${v.ownerFirst} to approve`);
  if (c.built !== true) return `${what}: not available yet on this deployment.`;
  if (c.allowed) return c.capability === 'seller_sold_comps' ? `${what}: allowed, but ${SOLD_COMPS_WAIT}.` : `${what}: yes.`;
  return `${what}: no. ${v.isOwner ? 'Not in your opt-in or the team policy.' : `Not in ${v.ownerFirst}'s opt-in or the team policy.`}`;
}

// ---- next steps and notes (handoff.ts:106-115) ---------------------------------------------------------------------

// batch 13 isa-4 F5: ISA-2b appends approve_saved_search (a proposed AI-origin saved search) or review_saved_search
export const NEXT_STEPS = ['call_now', 'confirm_appointment', 'answer_pricing_question', 'reply_to_complaint', 'review_fair_housing_question', 'review_consent', 'review_saved_search', 'approve_saved_search', 'prepare_cma', 'confirm_subject'] as const;
/** Steps that are not built: they say "{step}: not available yet." (any other unknown step is "Another check", no claim). */
export const UNBUILT_STEPS: ReadonlySet<string> = new Set(['prepare_cma', 'confirm_subject']);
export type NextStep = (typeof NEXT_STEPS)[number];
export const NEXT_STEP_WORDS: Record<NextStep, string> = {
  call_now: 'Call them',
  confirm_appointment: 'Confirm the appointment',
  answer_pricing_question: 'Answer their price question yourself',
  reply_to_complaint: 'Reply to their complaint',
  review_fair_housing_question: 'Answer their question about the area yourself',
  review_consent: 'Review their consent',
  review_saved_search: 'Review the saved search',
  approve_saved_search: 'Approve the saved search',
  prepare_cma: 'Prepare a CMA',
  confirm_subject: "Confirm the home they're selling",
};
export const nextStepWords = (s: string) => (NEXT_STEP_WORDS as Record<string, string>)[s] ?? OTHER_CHECK;

export const NOTE_WORDS: Record<string, string> = {
  CONFIRMATION_NOT_SENT: 'The confirmation was not sent: confirm by hand.',
  BOOKED_WHILE_PAUSED: 'Booked while AI care was paused; the confirmation was not sent.',
  IN_FLIGHT: 'A message was already on its way when care stopped; it may still reach them.',
};
/** A prefixed note ("IN_FLIGHT:<id>") drops its id. */
export const noteWords = (n: string) => NOTE_WORDS[n.split(':')[0]!] ?? OTHER_CHECK;

// ---- confirmation and message statuses (V17) -----------------------------------------------------------------------

export const CONFIRMATION_WORDS: Record<string, string> = {
  none: 'No confirmation was planned.',
  scheduled: 'A confirmation is scheduled.',
  queued: 'A confirmation is queued.',
  sent: 'The confirmation was sent.',
  canceled: 'Confirmation not sent: confirm by hand.',
  refused: 'Confirmation not sent: confirm by hand.',
};
export const confirmationWords = (s: string) => CONFIRMATION_WORDS[s] ?? OTHER_CHECK;

// ---- handoff deadlines and closes (0081: sla_class 'none', b12 review B12X-2; closed_reason, b12 recheck R19, R23) ----

/** Whether a deadline class has a deadline: 'none' is written when no human touch can ever clear it (R-ISA-30). */
export const SLA_HAS_DEADLINE: Record<SlaClass, boolean> = { critical: true, high: true, normal: true, low: true, none: false };
/** The deadline line of a handoff with no deadline: no call, text or email can reach the person, or the lead is closed. */
export const noDeadlineWords = (first: string) => `No deadline: no call, text or email from the team can reach ${first} now, or the lead is closed.`;
/** Why the system closed a handoff (it is done; never overdue). */
export const CLOSED_REASON_WORDS: Record<HandoffClosedReason, string> = {
  deadline_met: 'Closed: a call, text or email reached them in time.',
  acknowledged: 'Closed: it was acknowledged, and it had no deadline.',
  lead_closed: 'Closed: the lead was closed.',
  care_restarted: 'Closed: AI care started again.',
  care_continued: 'Closed: AI care was continued.',
};
export const closedReasonWords = (r: string) => (CLOSED_REASON_WORDS as Record<string, string>)[r] ?? OTHER_CHECK;

export type MessageVerb = 'sent' | 'scheduled' | 'queued' | 'not_sent';
/** The verb a message's own status supports (R-ISA-7): never "sent" unless it was. */
export function messageVerb(status: string | null | undefined): MessageVerb {
  switch (status) {
    case 'sent':
    case 'delivered':
    case 'read':
      return 'sent';
    case 'scheduled':
      return 'scheduled';
    case 'queued':
    case 'dispatching':
    case 'dispatch_unknown':
    case 'pending':
    case 'held':
      return 'queued';
    default:
      return 'not_sent';
  }
}

// ---- the fixed lines (core lines.ts ISA_LINES; restated, words.test.ts asserts parity) -----------------------------

export const LINES: Readonly<Record<IsaLineId, string>> = {
  bot_question: "You're texting with {Agent}'s AI assistant, not a person. Reply AGENT any time and I'll ask {Agent} to contact you.",
  safety: "I'm an AI assistant and I've alerted {Agent} right away. If you're in danger, please call 911 now.",
  fraud_risk: "Don't send money based on a text or email. Call {Agent} at a number you already know.",
  privacy_request: "I've passed your request to {Team}.",
  ai_declined: "Understood. I've asked {Agent} to take it from here.",
  complaint: "I'm sorry. I've asked {Agent} to reach out to you personally.",
  human_request: "I've let {Agent} know you'd like to talk.",
  fair_housing: "I can't describe who lives in an area or how safe it is. Your agent can point you to public sources so you can decide for yourself.",
  legal_contract: "That's a question for {Agent}. I've passed it on.",
  third_party: "Thanks. I've let {Agent} know.",
  pricing: "Putting a price on your home is something {Agent} does with you personally, so I've let {Agent} know.",
  financial: "That's a question for {Agent} or a lender. I've passed it on.",
  sensitive_personal: "Thank you for telling me. I've asked {Agent} to reach out to you personally.",
  language: "I can only write in English. I've asked {Agent} to reach out to you.",
  data_unavailable: "I don't have current market data for that right now. {Agent} can go over this with you.",
  booking_unavailable: "I couldn't confirm a time right now. {Agent} will reach out to set one.",
  uncertain: "I've passed this to {Agent}.",
  ready: '{Agent} will take it from here and be in touch.',
  open_offer_closed: '{Agent} will confirm a time with you directly.',
  slot_clarify_intro: 'Which of these times works best? Reply with its number:',
  email_details_pointer: 'I can email you the details.',
  holding: "I've passed this to {Agent}.",
};
export function fillLine(id: string, agent: string, team: string): string | null {
  const t = (LINES as Record<string, string>)[id];
  if (!t) return null;
  return t.replaceAll('{Agent}', agent).replaceAll('{Team}', team);
}

// ---- module-75 error codes (errors.ts:339-363) ---------------------------------------------------------------------

export const ISA_ERROR_MESSAGES: Record<string, string> = {
  AI_ISA_OFF: 'The AI assistant is off for your team.',
  AI_ISA_NOT_CLEARED: 'Waiting on counsel review (platform:ai_isa). Nothing is sent until counsel clears it.',
  AI_ISA_POLICY_NOT_APPROVED: 'Your team has no approved AI assistant policy.',
  AI_ISA_NO_OPTIN: 'Opt in to the AI assistant first (Settings, My AI assistant).',
  AI_ISA_NOT_OWNER: "Only the lead's owner can start AI care.",
  AI_ISA_ALREADY_ACTIVE: 'AI care is already on for this person.',
  AI_ISA_NO_CHANNEL: 'No phone or email of theirs can receive AI messages.',
  AI_ISA_SHARED_ADDRESS: 'Another person shares one of their phone numbers or emails.',
  AI_ISA_ACTIVE_CLIENT: 'They are a client on an open deal or an active listing.',
  AI_ISA_LISTED_ELSEWHERE: 'Their home is listed with another brokerage.',
  AI_ISA_NOT_ROOT: 'This record was merged. Start AI care on the surviving record.',
  AI_ISA_CALENDAR_REQUIRED: 'Connect your calendar first to let it book appointments.',
  AI_ISA_FIRST_TOUCH_PENDING: "Text or call them yourself first. AI messages don't count as your first contact.",
  AI_ISA_PERSON_DECLINED: 'This person declined or stopped AI care.',
  AI_ISA_HANDBACK_STALE: 'They wrote again or a reply was already queued. Open the thread instead.',
  AI_ISA_UNDO_EXPIRED: 'Too late to undo.',
  AI_ISA_NOT_LIVE: 'AI care is not on for this person any more.',
  AI_ISA_NOT_PAUSED: 'AI care is not paused right now.',
  AI_ISA_NOT_CONTINUABLE: 'Continue AI care is only for care paused by a new inquiry or a change to the team rules. Resume it instead.',
  AI_ISA_DO_NOT_CONTACT: 'This person asked not to be contacted.',
  AI_ISA_ATTESTATION_REQUIRED: 'This needs your written confirmation first.',
  AI_ISA_ROLE_NOT_ELIGIBLE: "Your role can't use the AI assistant for leads.",
  AI_ISA_BLOCK_NOT_LIFTABLE: "This can't be lifted. A restart needs a new message from them.",
  SUBJECT_UNCONFIRMED: "Confirm the home they're selling first.",
  CAPABILITY_NOT_AVAILABLE: "That isn't available on this deployment yet.",
  AI_ISA_BOOKING_IN_PROGRESS: 'The AI assistant is booking the time they agreed to. Resume after the booking finishes, in a few seconds.',
  // batch 12 recheck R11 (merged at batch 13): the generic approve or reject never decides an AI handoff card (feed/lib/messages.ts says the same)
  AI_ISA_HANDOFF_USE_ACK: "This is the assistant's handoff, not a draft, so nothing was sent.",
};

/** This surface's page-local variants of shell-owned codes (never registered app-wide: the shell owns them). */
export const TEAM_PAGE_MESSAGES: Record<string, string> = {
  OWNER_REQUIRED: 'Only the account owner can turn this on.',
  ATTESTATION_REQUIRED: 'Tick the confirmation first: turning this on needs your written confirmation.',
};
/** The daily limit's own variants (batch 13 isa-4 F13: an Admin raising the limit turns nothing on). */
export const CAP_PAGE_MESSAGES: Record<string, string> = {
  OWNER_REQUIRED: 'Only the account owner can raise the limit.',
  ATTESTATION_REQUIRED: 'Tick the confirmation first: raising the limit needs your written confirmation.',
};

/** A sentence for an ISA error: the page's local map, then module 75's, then the shell's (never a code). */
export function isaMessage(err: { code: string; details?: Record<string, unknown> | null } | string, local?: Readonly<Record<string, string>>): string {
  return messageFor(err, { ...ISA_ERROR_MESSAGES, ...(local ?? {}) });
}

// ---- start refusals (V4: non-owners see one sentence) -------------------------------------------------------------

/** Refusals everyone sees (a team-wide condition), each with its one fix. */
export const TEAM_REFUSALS: ReadonlySet<string> = new Set(['AI_ISA_OFF', 'AI_ISA_NOT_CLEARED', 'AI_ISA_POLICY_NOT_APPROVED']);
export const SIDE_WORDS: Record<string, string> = { buyer: 'Buyer', seller: 'Seller', both: 'Buyer and seller' };
