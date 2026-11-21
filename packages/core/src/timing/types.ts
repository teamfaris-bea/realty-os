// Types of core/timing (timing cues: when a person said they plan to buy, sell or move).
// Pure data: dates are calendar dates 'YYYY-MM-DD' in the team's zone; no instants, no clock.

/** What the person plans, as the source says it. A plan to rent is never a cue (the team does no rentals). */
export type CueIntent = 'buy' | 'sell' | 'both' | 'unknown';
export const CUE_INTENTS: readonly CueIntent[] = ['buy', 'sell', 'both', 'unknown'];

/** The stated timeframe, relative to the day the words were written (never to today). */
export type CueTimeframe = '0-3mo' | '3-6mo' | '6-12mo' | '12+mo' | 'unknown';
export const CUE_TIMEFRAMES: readonly CueTimeframe[] = ['0-3mo', '3-6mo', '6-12mo', '12+mo', 'unknown'];

/** Who the timing came from: the client's words, an intake form field, or the agent logging what was said. */
export type CueEvidence = 'client_stated' | 'form' | 'agent_logged';
export const CUE_EVIDENCE: readonly CueEvidence[] = ['client_stated', 'form', 'agent_logged'];

export type WindowPrecision = 'month' | 'season' | 'year' | 'range';

/**
 * The projected move window: the first and last calendar day the person's stated timing points at, computed from
 * the day the words were written. `basis` says whether the words named the time ('stated': "lease ends March",
 * "PCS next summer") or only a timeframe bucket was available ('timeframe': "0-3 months" from the day written).
 */
export interface MoveWindow {
  start: string;
  end: string;
  precision: WindowPrecision;
  basis: 'stated' | 'timeframe';
  /** e.g. "Mar 2027", "summer 2027", "2027", "Nov 2026–Feb 2027" */
  label: string;
}

/**
 * What one scan of one source decided (timing_cues.outcome). Every outcome but `cue` is recorded too, so the
 * nightly scan never reads the same unchanged words twice.
 */
export type ScanOutcome =
  | 'no_timing' // the prefilter found no timing words: no model call
  | 'boilerplate' // a playbook, script, sequence or mail-merge template: no model call
  | 'reminder_only' // a short agent self-reminder ("call in new year"): no model call
  | 'no_cue' // the model found no client timing
  | 'rental' // the plan is to rent (or rent a home out): the team does no rentals
  | 'unverified' // every quote the model gave is not in the source word for word
  | 'low_confidence' // verified, but below the write threshold
  | 'no_window' // verified, but no window can be computed (no stated time, timeframe unknown)
  | 'model_error' // the model's answer was not the JSON contract
  | 'cue';
export const SCAN_OUTCOMES: readonly ScanOutcome[] = ['no_timing', 'boilerplate', 'reminder_only', 'no_cue', 'rental', 'unverified', 'low_confidence', 'no_window', 'model_error', 'cue'];

/** A cue the model proposed (the JSON contract, before verification). */
export interface ProposedCue {
  evidence: CueEvidence | 'none';
  snippet: string;
  intent: CueIntent | 'rent';
  timeframe: CueTimeframe;
  confidence: number;
}

/** A verified, accepted cue with its window (what a `cue` row stores). */
export interface AcceptedCue {
  evidence: CueEvidence;
  snippet: string;
  intent: CueIntent;
  timeframe: CueTimeframe;
  confidence: number;
  window: MoveWindow;
}

/**
 * Today's call class of a cue (read time, against today, never stored):
 * - LIVE: the window is open now or starts within the horizon (about 6 months): "call today".
 * - PAST_WINDOW: the window already ended and nothing shows they moved: "still planning to move?" check-in.
 * - STALE: a deal or listing after the words shows the plan already happened (listed, under contract, closed).
 * - LATER: the window starts beyond the horizon: not on today's list.
 * - EXPIRED: the window ended more than the look-back ago: not on the list.
 */
export type NudgeClass = 'LIVE' | 'PAST_WINDOW' | 'STALE' | 'LATER' | 'EXPIRED';

/** Why a person is left off the list entirely (before any class). */
export type NudgeDrop = 'closed' | 'lost' | 'under_contract' | 'do_not_contact';
