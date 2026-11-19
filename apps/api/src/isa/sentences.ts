// Plain-language states and refusals of module 75 (honest UI: every hold, pause and refusal is said as what it is).
// API error bodies carry codes only (errors.ts); the web lane (ISA-4) shows these sentences.
import type { AssignmentRow } from './repo.js';

export const STATE_SENTENCES = {
  paused: 'Paused: nobody is following up automatically.',
  held: 'Held: sending is off or a daily limit is reached; it continues on its own when that clears.',
} as const;

/**
 * b18 item f (owner product boundary, 2026-11-14), renamed by b18 review B18S-5: why a person a lead source marked "No
 * automated contact for leads from this source" sent gets no AI care: the start refusal, Continue, chain link 11 and the
 * pause note all say it.
 */
export const SOURCE_NO_AI_CARE_SENTENCE = "No automated contact for leads from this source: the Owner turned this on for this person's lead source, so the AI assistant does not care for them (nothing automatic goes to them; call, text or email them one to one).";
/** The pause note's body (notifications.body is at most 240 characters). */
export const SOURCE_NO_AI_CARE_NOTE = 'No automated contact for leads from this source is on for their lead source (an Owner setting). AI care stays paused and cannot be resumed or continued while it is on.';

/**
 * R-LSRC-9 (owner decision 2026-11-14, migration 0101): why an imported person whose source nobody has reviewed gets no
 * AI care. Its own words on the start refusal, Continue, chain link 11 and the pause note: an import brought them in,
 * the imported source has not been reviewed yet, and an Owner reviews it under Lead sources. Never the setting's words.
 */
export const SOURCE_UNCLASSIFIED_AI_CARE_SENTENCE = 'This person came in from an import and their imported source has not been reviewed yet (an Owner reviews it under Lead sources), so the AI assistant does not care for them (nothing automatic goes to them; call, text or email them one to one).';
/** The pause note's body for that reason (at most 240 characters). */
export const SOURCE_UNCLASSIFIED_AI_CARE_NOTE = 'They came in from an import and their imported source has not been reviewed yet. AI care stays paused and cannot be resumed or continued until an Owner reviews it under Lead sources.';

/** The AI care codes of the two source refusals (leads/automatedContact.ts SourceRefusal), and the pause reason each writes. */
export const AI_CARE_SOURCE_CODE = { SOURCE_NO_AUTOMATED_CONTACT: 'AI_ISA_SOURCE_NO_AI_CARE', SOURCE_UNCLASSIFIED: 'AI_ISA_SOURCE_UNCLASSIFIED' } as const;
export const AI_CARE_SOURCE_PAUSE = { SOURCE_NO_AUTOMATED_CONTACT: 'source_no_ai_care', SOURCE_UNCLASSIFIED: 'source_unclassified' } as const;
export type AiCareSourceCode = (typeof AI_CARE_SOURCE_CODE)[keyof typeof AI_CARE_SOURCE_CODE];
/** The pause note for a source pause reason, or null for any other pause. */
export function sourcePauseNote(reason: string): string | null {
  return reason === 'source_no_ai_care' ? SOURCE_NO_AI_CARE_NOTE : reason === 'source_unclassified' ? SOURCE_UNCLASSIFIED_AI_CARE_NOTE : null;
}

/**
 * E795 (R-ISA-20; b19 review F4): what the lead's owner is told the moment a turn is held at a daily model-call budget.
 * Staff words only: nothing about a budget is ever written to the person. The first is the unanswered-reply handback
 * (after "They replied. "), the second the notification for a start or a follow-up that waits (nobody wrote), the third
 * the activity card while a reply waits (it never says the assistant is answering while it is not).
 */
export const BUDGET_HOLD_REPLY = "AI care is waiting: today's AI budget is used up. It resumes tomorrow. You can reply yourself now.";
export const BUDGET_HOLD_OUTREACH = "AI care is waiting: today's AI budget is used up. It resumes tomorrow. You can reach out yourself now.";
export const BUDGET_HOLD_ACTIVITY = "They replied; AI care is waiting for tomorrow's AI budget. You can reply yourself now.";
export const ACTIVITY_ANSWERING = { code: 'AI_ISA_REPLY_RECEIVED', text: 'They replied; the AI assistant is answering' } as const;
export const ACTIVITY_WAITING_BUDGET = { code: 'AI_ISA_REPLY_WAITING_BUDGET', text: BUDGET_HOLD_ACTIVITY } as const;

const START_REFUSALS: Record<string, string> = {
  AI_ISA_OFF: 'The AI assistant is off for your team.',
  AI_ISA_NOT_CLEARED: 'Waiting on counsel review (platform:ai_isa). Nothing is sent until counsel clears it.',
  AI_ISA_POLICY_NOT_APPROVED: 'Your team has no approved AI assistant policy.',
  AI_ISA_NO_OPTIN: 'Opt in to the AI assistant first (Settings, My AI assistant).',
  AI_ISA_NOT_OWNER: "Only the lead's owner can start AI care.",
  AI_ISA_NOT_ROOT: 'This record was merged; start AI care on the surviving record.',
  AI_ISA_ALREADY_ACTIVE: 'AI care is already on for this person.',
  AI_ISA_DO_NOT_CONTACT: 'This person asked not to be contacted.',
  AI_ISA_PERSON_DECLINED: 'This person declined or stopped AI care. A restart needs a new message from them and your attestation.',
  AI_ISA_FIRST_TOUCH_PENDING: "Text or call them yourself first. AI messages don't count as your first contact.",
  AI_ISA_SHARED_ADDRESS: 'Another person shares one of their phone numbers or emails.',
  AI_ISA_ACTIVE_CLIENT: 'They are a client on an open deal or an active listing.',
  AI_ISA_NO_CHANNEL: 'No phone or email of theirs can receive AI messages.',
  AI_ISA_LISTED_ELSEWHERE: 'Their home is listed with another brokerage.',
  // b18 item f: an Owner setting on the lead source (the panel names it; the source itself is the owner's data)
  AI_ISA_SOURCE_NO_AI_CARE: SOURCE_NO_AI_CARE_SENTENCE,
  // R-LSRC-9 (0101): an imported person whose source is not reviewed yet (never worded as the Owner's setting)
  AI_ISA_SOURCE_UNCLASSIFIED: SOURCE_UNCLASSIFIED_AI_CARE_SENTENCE,
};
/**
 * b13 review B13S-2: what this tree implements, one list for the panel and the opt-in form (the web reads it from
 * the API, never its own constant). Every capability turn.ts can grant is here: converse, share_listings and
 * propose_saved_search (ISA-2b's buyer bundle and saved search), seller_competition (ISA-3: competing listings with
 * their asking prices, allowed before platform:cma, E534), book_appointments (ISA-2b offers and booking) and
 * seller_sold_comps, built but dark: recent sales go out only once counsel review of platform:cma and
 * platform:ai_isa_seller_data is recorded and the MLS licence allows ai_isa_comps (batch 16: under V2-A's own statement
 * rules, connected in isa/seller/cmaSeam.ts). Reserved capabilities (core ISA_RESERVED_CAPABILITIES) are never listed.
 */
export const ISA_BUILT_CAPABILITIES = ['converse', 'share_listings', 'propose_saved_search', 'seller_competition', 'seller_sold_comps', 'book_appointments'] as const;

/**
 * The panel's "What it may do" row of a capability: allowed (the team policy and the owner's opt-in) and the sentence.
 * b14 to-do (B13S-2 low): the booking row also carries whether the owner's calendar is live now (turn.ts offers times
 * only then; the calendar is checked only at opt-in), so an allowed booking never reads as a bare "Allowed." while no
 * times can be offered.
 */
export function capabilityRow(cap: string, inPolicy: boolean, inOptIn: boolean, o: { calendarLive?: boolean } = {}): { capability: string; allowed: boolean; built: boolean; calendarConnected?: boolean; sentence: string } {
  const built = (ISA_BUILT_CAPABILITIES as readonly string[]).includes(cap);
  const allowed = built && inPolicy && inOptIn;
  const calendar = cap === 'book_appointments' && o.calendarLive !== undefined ? { calendarConnected: o.calendarLive } : {};
  const sentence = !built
    ? 'Not built in this version.'
    : !allowed
      ? 'Not in the opt-in or the team policy.'
      : cap === 'seller_sold_comps'
        ? 'Allowed. Recent sales still go out only once counsel review of platform:cma and platform:ai_isa_seller_data is recorded and the MLS licence allows it.'
        : cap === 'seller_competition'
          ? 'Allowed: competing listings with their asking prices.'
          : calendar.calendarConnected === false
            ? 'Allowed, but the calendar is not connected, so no times are offered.'
            : 'Allowed.';
  return { capability: cap, allowed, built, ...calendar, sentence };
}

/** Control and booking refusals (ISA-2b; the web shows the sentence). */
export const CONTROL_REFUSALS: Record<string, string> = {
  AI_ISA_BOOKING_IN_PROGRESS: 'The AI assistant is booking the time they agreed to. Resume after the booking finishes (a few seconds).',
};

/** The buyer bundle's honest unavailable codes (item 10), each as a panel sentence. VERIFY WITH MLS. */
export const BUNDLE_SENTENCES: Record<string, string> = {
  CAPABILITY_OFF: 'Sharing listings is not on for this lead (policy, opt-in or side).',
  CRITERIA_INCOMPLETE: 'Not enough of what they want yet: an area is needed before any home is shared.',
  CONSENT_TIER_MISSING: 'No consent from their own form for messages they did not ask for, so no listings are sent.',
  MLS_NOT_ELIGIBLE: 'No MLS feed may reach clients right now (connection, counsel review or freshness).',
  LEASE_UNCHECKED: 'Matching MLS rows have not been checked for leases yet, so none are shared.',
  NO_MATCH: 'No current listing matches what they told us (homes sent in the last 90 days are skipped).',
};

/** Offer and booking codes on the turn and the panel (item 8–9), each as a plain sentence. */
export const BOOKING_SENTENCES: Record<string, string> = {
  CALENDAR_UNAVAILABLE: 'Your calendar could not be read just now, so no times were offered.',
  KIND_NOT_ALLOWED: 'That appointment kind is not in your opt-in or the team policy.',
  APPOINTMENT_ALREADY_SET: 'They already have an appointment with the team.', // the turn carries the dated form (appointmentAlreadySetSentence)
  NO_FREE_SLOT: 'No free time fits your availability, the notice period and their time zones.',
  NO_AVAILABILITY: 'Your availability leaves no hours inside routing hours.',
  OFFER_EXPIRED: 'The offered times expired before they answered.',
  CONFIRMATION_TOO_LATE: 'A confirmation could not go out before the notice period (quiet hours or daily limits).',
  CARE_PAUSED: 'AI care was paused before the booking.',
  CARE_NOT_LIVE: 'AI care ended before the booking.',
  CONFIRMATION_ON_HOLD: 'Sending is on hold, so the AI did not book a time it could not confirm.',
  SLOT_TAKEN: 'That time was just taken; new times were offered.',
  SLOT_SOURCE_CHANGED: 'Your calendar changed; new times were offered.',
};

/**
 * Q3's default (ISA-2b; batch 13 audit ISA2B-11): the agent sees "They already have an appointment on {date}", the
 * date in the team's zone. The offer turn stores codes only (0080's ai_isa_codes_only: the appointment id and its local
 * date, YYYY-MM-DD); the panel renders the sentence from them.
 */
export function appointmentOnOf(startsAt: number, teamZone: string | null): string {
  const day = (z: string) => new Intl.DateTimeFormat('en-CA', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(startsAt));
  try {
    return day(teamZone ?? 'UTC');
  } catch {
    return day('UTC');
  }
}
export function appointmentAlreadySetSentence(on: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(on)) return null;
  const d = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${on}T12:00:00Z`));
  return `They already have an appointment on ${d}.`;
}

export function startRefusalSentence(code: string): string {
  return START_REFUSALS[code] ?? 'AI care cannot start right now.';
}

type Chip = { kind: 'active' | 'waiting_reply' | 'reply_scheduled' | 'scheduling' | 'waiting_on_agent' | 'paused' | 'held' | 'ended'; sentence: string };
export function chipOf(a: AssignmentRow, notBefore: Date | null): Chip {
  if (a.endedAt !== null) return { kind: 'ended', sentence: `Ended: ${String(a.endReason ?? '').replace(/_/g, ' ')}` };
  if (a.pausedAt !== null) return { kind: 'paused', sentence: `Paused: ${String(a.pauseReason ?? '').replace(/_/g, ' ')} (nobody is following up)` };
  if (notBefore !== null && notBefore.getTime() > Date.now()) return { kind: 'reply_scheduled', sentence: `Reply scheduled ${notBefore.toISOString().slice(11, 16)} UTC` };
  if (a.machine.held.length > 0) return { kind: 'waiting_on_agent', sentence: `Waiting on you: ${a.machine.held[0]!.class.replace(/_/g, ' ')}` };
  if (a.machine.phase === 'scheduling' || a.machine.phase === 'booking') return { kind: 'scheduling', sentence: 'Scheduling' };
  if (a.machine.phase === 'awaiting_reply' || a.machine.phase === 'nurture') return { kind: 'waiting_reply', sentence: 'Waiting for reply' };
  return { kind: 'active', sentence: 'Active' };
}
