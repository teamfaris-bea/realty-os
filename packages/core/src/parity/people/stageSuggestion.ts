// The stage an outcome suggests (R-STG-2). Pure and total. When an agent logs what happened (a call's outcome, a text
// or email, an appointment's result) the screen offers ONE stage to confirm; the agent confirms or picks another.
// Nothing here changes a stage: the routes that return a suggestion never write one.
//
// The table (the whole of it; nothing else is ever suggested):
//
//   signal                                             suggests       only while the person is
//   -------------------------------------------------  -------------  -------------------------------------
//   voicemail left, no answer, "other" call,           attempting     new
//     a text or email sent with no reply
//   a connected call, a callback request,              connected      new, attempting
//     the person's own reply (text or email)
//   wrong number, bad number, do-not-call request      nothing        (any)
//   appointment result "agreement_signed"              active         new, attempting, connected, nurture
//   any other appointment result                       nothing        (any)
//
// So: a voicemail is not a conversation (it never suggests "connected"); a reply does not make someone an active
// client (only a signed agreement suggests "active"); a suggestion never moves a person to an earlier stage; and
// nurture, under_contract, closed and lost are never the suggested stage: those are judgements about the
// relationship or facts about a sale that no logged outcome proves.
//
// A wrong number, a bad number and a do-not-call request suggest nothing on purpose: they are not progress with the
// person, and each has its own path (the wrong-number revoke, the person-level do-not-contact). "Not moving forward"
// is never offered for them, because that stage is not an opt-out.
import { STAGES, type Stage } from './stage.js';

/** Every call outcome a suggestion reads: the platform's (POST /calls/:id/outcome) and the log sheet's (`other`). */
export const CALL_SIGNAL_OUTCOMES = ['connected', 'left_voicemail', 'no_answer', 'wrong_number', 'bad_number', 'do_not_call_request', 'callback_requested', 'other'] as const;
export type CallSignalOutcome = (typeof CALL_SIGNAL_OUTCOMES)[number];

/** Appointment results (the workspace's outcome sheet). */
export const APPOINTMENT_RESULTS = ['agreement_signed', 'follow_up', 'not_a_fit', 'no_decision', 'no_show'] as const;
export type AppointmentResult = (typeof APPOINTMENT_RESULTS)[number];

export type StageSignal =
  /** a call and how it ended */
  | { kind: 'call'; outcome: CallSignalOutcome }
  /** a text or email: `outbound` is one we sent with no reply yet, `inbound` is the person's own reply */
  | { kind: 'message'; channel: 'text' | 'email'; direction: 'outbound' | 'inbound' }
  /** an appointment's recorded result */
  | { kind: 'appointment'; result: AppointmentResult };

export interface StageSuggestion {
  /** the stage to offer; never nurture, under_contract, closed or lost, and never earlier than the current one */
  stage: Stage;
  /** one plain sentence saying why, for the screen */
  why: string;
}

type SignalClass = 'tried' | 'talked' | 'agreement' | 'none';

function classOf(signal: StageSignal): SignalClass {
  const s = signal as { kind?: unknown; outcome?: unknown; direction?: unknown; channel?: unknown; result?: unknown };
  if (s.kind === 'call') {
    if (s.outcome === 'left_voicemail' || s.outcome === 'no_answer' || s.outcome === 'other') return 'tried';
    if (s.outcome === 'connected' || s.outcome === 'callback_requested') return 'talked';
    return 'none';
  }
  if (s.kind === 'message') {
    if (s.channel !== 'text' && s.channel !== 'email') return 'none';
    if (s.direction === 'outbound') return 'tried';
    if (s.direction === 'inbound') return 'talked';
    return 'none';
  }
  if (s.kind === 'appointment') return s.result === 'agreement_signed' ? 'agreement' : 'none';
  return 'none';
}

const RULES: Record<Exclude<SignalClass, 'none'>, { to: Stage; from: readonly Stage[] }> = {
  tried: { to: 'attempting', from: ['new'] },
  talked: { to: 'connected', from: ['new', 'attempting'] },
  agreement: { to: 'active', from: ['new', 'attempting', 'connected', 'nurture'] },
};

function whyOf(signal: StageSignal): string {
  if (signal.kind === 'call') {
    switch (signal.outcome) {
      case 'left_voicemail':
        return 'You left a voicemail. That is a try, not a conversation yet.';
      case 'no_answer':
        return 'Nobody answered. That is a try, not a conversation yet.';
      case 'connected':
        return 'You talked with them. That is a two-way conversation.';
      case 'callback_requested':
        return 'They asked for a call back, so you have reached them.';
      default:
        return 'You tried to call. There has been no two-way conversation yet.';
    }
  }
  if (signal.kind === 'message') {
    const what = signal.channel === 'email' ? 'an email' : 'a text';
    return signal.direction === 'inbound' ? `They answered with ${what}. That is a two-way conversation.` : `You sent ${what} and they have not replied yet.`;
  }
  return 'They signed an agreement, so you are working together now.';
}

/**
 * R-STG-2: the stage this outcome suggests for a person in `current`, or null when it suggests nothing. Total: an
 * unknown stage or signal suggests nothing. The caller shows it as a suggestion to confirm; it changes nothing.
 */
export function suggestStageFromOutcome(i: { current: Stage; signal: StageSignal }): StageSuggestion | null {
  const at = STAGES.indexOf(i.current);
  if (at < 0 || i.signal === null || typeof i.signal !== 'object') return null;
  const c = classOf(i.signal);
  if (c === 'none') return null;
  const rule = RULES[c];
  if (!rule.from.includes(i.current)) return null;
  // never demotes: every `from` stage of the table is earlier than its `to` (kept as a check, not an assumption)
  if (STAGES.indexOf(rule.to) <= at) return null;
  return { stage: rule.to, why: whyOf(i.signal) };
}
