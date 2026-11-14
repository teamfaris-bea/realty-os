// Plain words for AI call answering (module 55 items 8 and 9; R-STAFF-1, R-STAFF-9, CONVENTIONS.md:198).
//
// Every code the voice routes send (a reason, a ledger tool, a reason code, an outcome, an end reason, a transfer
// outcome, a message topic, a line source) is worded here by its code, from maps typed against core/voice's closed
// sets (type imports only: nothing of core's runtime is bundled), so a new code fails the typecheck until it has words.
// A code the maps do not know gets a generic phrase, never the code. Server sentences that carry a planning tag or a
// pack key ("(N12)", "(platform:voice is not cleared)") are not trusted to be clean: withoutCodes strips them.
import type { MessageTopic, SayAction, TransferOutcome, VoiceAnswerWhen, VoiceEndReason, VoiceLedgerTool, VoiceOutcome, VoiceReasonCode } from '@realty/core/voice';

export const VOICE_PAGE_PATH = '/admin/ai-answering';

function wordFor<K extends string>(map: Readonly<Record<K, string>>, code: string | null | undefined, fallback: string): string {
  return code != null && Object.hasOwn(map, code) ? map[code as K] : fallback;
}

/** A server sentence without the planning tags and pack keys it may carry (never shown, CONVENTIONS.md:198). */
export function withoutCodes(s: string): string {
  return s
    .replace(/\s*\((?:N\d+|[^()]*platform:[a-z_]+[^()]*)\)/g, '')
    .replace(/platform:[a-z_]+/g, 'this feature')
    .replace(/\b[A-Z]{2,}_[A-Z_]+\b/g, '')
    .replace(/\s+([.,;:])/g, '$1')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// ---- the answering state (GET /voice/answering) ----------------------------------------------------

/** The reason codes answeringView sends (apps/api/src/voice/answering.ts REASON). */
export const ANSWERING_REASON_CODES = ['VOICE_NOT_CLEARED', 'VOICE_VENDOR_NOT_CONFIGURED', 'VOICE_PLAYBOOK_NOT_APPROVED', 'AI_DISABLED', 'VOICE_RECORDING_OFF', 'VOICE_ANSWERING_OFF'] as const;
export type AnsweringReasonCode = (typeof ANSWERING_REASON_CODES)[number];

export const ANSWERING_REASON_WORDS: Record<AnsweringReasonCode, string> = {
  VOICE_NOT_CLEARED: 'AI answering waits for counsel review and a check of a real voice vendor.',
  VOICE_VENDOR_NOT_CONFIGURED: 'No voice vendor is set up on this deployment yet, so AI answering stays off.',
  VOICE_PLAYBOOK_NOT_APPROVED: 'The call-answering playbook is not approved yet.',
  AI_DISABLED: 'The assistant is turned off for this team.',
  VOICE_RECORDING_OFF: 'Call recording is off in the team policy. A call the assistant answers is always announced and recorded.',
  VOICE_ANSWERING_OFF: 'The Owner has not turned AI answering on.',
};

/** b14 review F7: VOICE_NOT_CLEARED while counsel review and the vendor check are both recorded (the pack is then
 *  missing something else the API requires, such as its response-time limit): never "waits for" either record. */
export const NOT_CLEARED_BOTH_RECORDED = 'AI answering is not cleared on this deployment yet.';

/** One reason in words, by its code; an unknown code shows the server's sentence without codes. VOICE_NOT_CLEARED
 *  names only the record still missing, so it never contradicts the page's Checks list (b14 review F7). */
export function reasonWords(r: { code: string; sentence: string }, pack?: { reviewedByCounselAt: string | null; vendorReady: boolean }): string {
  if (r.code === 'VOICE_NOT_CLEARED' && pack) {
    const counsel = pack.reviewedByCounselAt !== null;
    if (counsel && pack.vendorReady) return NOT_CLEARED_BOTH_RECORDED;
    if (counsel) return 'AI answering waits for a check of a real voice vendor.';
    if (pack.vendorReady) return 'AI answering waits for counsel review.';
  }
  return wordFor(ANSWERING_REASON_WORDS, r.code, withoutCodes(r.sentence) || 'Another check is not met yet.');
}

export const STATE_WORDS: Record<'dark' | 'off' | 'on', string> = {
  dark: 'AI answering is not available on this deployment yet.',
  off: 'AI answering is off.',
  on: 'AI answering is on.',
};

export const ANSWER_WHEN_WORDS: Record<VoiceAnswerWhen, string> = {
  missed_and_after_hours: 'Missed calls and after-hours calls',
  after_hours_only: 'After-hours calls only',
};

export const ANSWER_AFTER_CHOICES = [10, 15, 20, 25, 30, 40, 50, 60] as const;

export function answerAfterWords(seconds: number): string {
  return `After ${seconds} seconds of ringing`;
}

/** Answers sooner, or in more hours: the API's settingsLoosening (answering.ts), which only the Owner may do. */
export function isWidening(cur: { answerAfterSeconds: number; answerWhen: string }, next: { answerAfterSeconds: number; answerWhen: string }): boolean {
  return next.answerAfterSeconds < cur.answerAfterSeconds || (cur.answerWhen === 'after_hours_only' && next.answerWhen === 'missed_and_after_hours');
}

export const ADMIN_WIDEN_REASON = 'Only the Owner can make AI answer sooner or in more hours.';
export const DARK_WIDEN_REASON = 'While AI answering is not available, it cannot be set to answer sooner or in more hours.';

export const PLAYBOOK_STATE_WORDS: Record<'draft' | 'approved' | 'superseded' | 'revoked', string> = {
  draft: 'The call-answering playbook is a draft, not approved yet.',
  approved: 'The call-answering playbook is approved.',
  superseded: 'The call-answering playbook was replaced by a newer version.',
  revoked: 'The call-answering playbook was withdrawn.',
};

export function playbookWords(state: string): string {
  return wordFor(PLAYBOOK_STATE_WORDS, state, 'The call-answering playbook is not approved.');
}

// ---- the test call (POST /voice/test-call) ---------------------------------------------------------

/**
 * The scripted callers core ships (packages/core/src/voice/testing/fixtures.ts SCRIPTS). The web may not import
 * core's test fixtures, so the names are listed here; words.test.ts pins them to the fixtures.
 */
export const SCRIPT_CHOICES = [
  { name: 'booking', label: 'A caller books a time' },
  { name: 'hotTransfer', label: 'A hot caller is put through to their agent' },
  { name: 'ownerNoAnswer', label: 'The agent does not pick up the transfer' },
  { name: 'priceQuestion', label: 'A caller asks about price' },
  { name: 'robot', label: 'A caller asks if they are talking to a robot' },
  { name: 'spokenStop', label: 'A caller says stop' },
  { name: 'stopCalling', label: 'A caller asks to stop calling them' },
  { name: 'takeMeOff', label: 'A caller asks to be taken off the list' },
  { name: 'dontStop', label: 'A caller says "don\'t stop", not an opt-out' },
  { name: 'injection', label: 'A caller tries to trick the assistant' },
  { name: 'silence', label: 'A caller stays silent' },
  { name: 'hangupMidBooking', label: 'A caller hangs up while booking' },
] as const;
export const DEFAULT_SCRIPT = 'booking';

export const LINE_SOURCE_WORDS: Record<SayAction['source'], string> = {
  disclosure: 'What callers hear first (preview)',
  announcement: 'The recording announcement (preview)',
  script: 'A fixed line of the assistant',
  model: 'The assistant',
};

export function lineSourceWords(source: string): string {
  return wordFor(LINE_SOURCE_WORDS, source, 'The assistant');
}

export const NO_PLAYBOOK_TO_SIMULATE = 'No call-answering playbook yet, so there is nothing to simulate.';
export const BOOKING_DRAFT_NOTE = 'In a real call the confirmation is a draft your agent sends with one tap.';

export const CONFIRMATION_CHANNEL_WORDS: Record<'sms' | 'email', string> = {
  sms: 'The confirmation would go by text.',
  email: 'The confirmation would go by email.',
};

// ---- the ledger, the outcome and the end (shared with the approvals handback card) ------------------

export const TOOL_WORDS: Record<VoiceLedgerTool, string> = {
  check_availability: 'Check free times',
  book_appointment: 'Book a time',
  warm_transfer: 'Put the caller through',
  take_message: 'Take a message',
  record_opt_out: 'Note that the caller asked not to be contacted',
  end_call: 'End the call',
};

export function toolWords(tool: string | null): string {
  return tool === null ? 'A request outside the tools the assistant may use' : wordFor(TOOL_WORDS, tool, 'A request outside the tools the assistant may use');
}

export const REASON_CODE_WORDS: Record<VoiceReasonCode, string> = {
  ALLOW_AVAILABILITY: 'checking free times is allowed',
  ALLOW_OFFERED_SLOT: 'the time was one of the times offered',
  ALLOW_OWNER_TRANSFER: 'the caller met the hot-lead rule and the transfer went to their own agent',
  ALLOW_MESSAGE: 'taking a message is allowed',
  ALLOW_OPT_OUT_HEARD: 'the caller asked not to be contacted',
  ALLOW_END_CALL: 'ending the call is allowed',
  VOICE_SESSION_ENDED: 'the call had already ended',
  VOICE_TOOL_BEFORE_DISCLOSURE: 'the caller had not yet heard that this is an automated assistant and that the call is recorded',
  VOICE_TOOL_UNKNOWN: 'it is not a tool the assistant may use',
  VOICE_TOOL_ARGS_INVALID: 'the request was not in an allowed form',
  VOICE_TOOL_NOT_ENABLED: 'the playbook does not turn it on',
  VOICE_TRANSFER_PENDING: 'a transfer was already under way',
  VOICE_OPTED_OUT: 'the caller asked not to be contacted',
  CONTACT_NOT_OWNED: 'the caller has no agent of their own',
  SLOT_NOT_OFFERED: 'that time was not one of the times offered',
  ALREADY_BOOKED: 'a time was already booked on this call',
  BOOKING_PENDING: 'a booking was still being made',
  TRANSFER_NOT_OWNER: "only the caller's own agent can take a transfer",
  TRANSFER_UNAVAILABLE: 'their agent could not take a transfer then',
  TRANSFER_ALREADY_TRIED: 'a transfer was already tried',
  CALLER_NOT_HOT: 'the caller did not meet the hot-lead rule',
  OPT_OUT_NOT_HEARD: 'the caller had not asked not to be contacted',
};

export function reasonCodeWords(code: string): string {
  return wordFor(REASON_CODE_WORDS, code, 'for a reason not shown here');
}

/** "Book a time: allowed, because the time was one of the times offered." */
export function ledgerRowWords(row: { tool: string | null; decision: 'allow' | 'deny'; reasonCode: string }): string {
  const verdict = `${toolWords(row.tool)}: ${row.decision === 'allow' ? 'allowed' : 'refused'}`;
  return Object.hasOwn(REASON_CODE_WORDS, row.reasonCode) ? `${verdict}, because ${REASON_CODE_WORDS[row.reasonCode as VoiceReasonCode]}.` : `${verdict}.`;
}

/** A request refused before it could be logged (payload.voice.unlogged). */
export function unloggedWords(reason: string): string {
  return Object.hasOwn(REASON_CODE_WORDS, reason) ? `A request was refused and not logged, because ${REASON_CODE_WORDS[reason as VoiceReasonCode]}.` : 'A request was refused and not logged.';
}

export const OUTCOME_WORDS: Record<VoiceOutcome, string> = {
  booked: 'The assistant booked a time.',
  transferred: 'The assistant put the caller through to their agent.',
  message_taken: 'The assistant took a message.',
  caller_ended: 'The caller hung up before leaving a message.',
  opted_out: 'The caller asked not to be contacted.',
  fallback_voicemail: 'The assistant sent the caller to voicemail.',
  error: 'The assistant could not finish the call.',
};

export function outcomeWords(outcome: string | null): string {
  return wordFor(OUTCOME_WORDS, outcome, 'The call ended.');
}

/** voice.reconcile's SESSION_LOST (apps/api/src/voice/handback.ts) is an end reason too. */
export const END_REASON_WORDS: Record<VoiceEndReason | 'SESSION_LOST', string> = {
  CALLER_HUNG_UP: 'The caller hung up.',
  MODEL_ENDED_CALL: 'The assistant ended the call.',
  TRANSFER_CONNECTED: 'The call ended with the transfer connected.',
  MAX_CALL_SECONDS: 'The call reached its time limit.',
  SILENCE: 'The caller stayed silent.',
  VENDOR_ERROR: 'The voice service failed during the call.',
  TURN_LATENCY: 'The assistant was too slow to answer, so the call went to voicemail.',
  DISCLOSURE_FAILED: 'The opening disclosure did not play, so the assistant stopped.',
  ANNOUNCEMENT_FAILED: 'The recording announcement did not play, so the assistant stopped.',
  ANNOUNCEMENT_DECLINED: 'The caller did not agree to the recording, so the assistant stopped.',
  PLAYBACK_TIMEOUT: 'The opening lines took too long to play, so the assistant stopped.',
  UNCOVERED_LANGUAGE: 'The caller spoke a language the playbook does not cover.',
  SESSION_LOST: 'The assistant lost the call.',
};

export function endReasonWords(code: string | null): string {
  return wordFor(END_REASON_WORDS, code, 'The call ended.');
}

export const TRANSFER_WORDS: Record<TransferOutcome, string> = {
  connected: 'You picked up the transfer.',
  declined: 'You declined the transfer.',
  no_answer: 'The transfer was not picked up in time.',
};

export function transferWords(code: string | null): string | null {
  return code === null ? null : wordFor(TRANSFER_WORDS, code, 'A transfer was tried.');
}

export const TOPIC_WORDS: Record<MessageTopic, string> = {
  GENERAL: 'a general question',
  CALLBACK: 'a call back',
  SHOWING: 'a showing',
  BUYING: 'buying',
  SELLING: 'selling',
  LISTING: 'a listing',
  PRICE: 'price',
  OFFER: 'an offer',
  CONTRACT: 'a contract',
  COMMISSION: 'commission',
  LEGAL: 'a legal question',
  LENDING: 'lending',
  AREA_QUESTION: 'a question about an area',
  LANGUAGE: 'another language',
};

export function topicWords(code: string): string {
  return wordFor(TOPIC_WORDS, code, 'another topic');
}
