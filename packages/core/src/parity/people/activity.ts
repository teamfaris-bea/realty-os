// Logged outside activity (R-PAR-5, R-PAR-30, R-PAR-31, R-PAR-32). A call, text or email that happened
// outside Realty OS, written as a note (source 'logged_activity'). It is never a touch: it never
// satisfies or delays first-touch SLA, release or inactivity release, never unlocks R-PAR-14 and never
// appears in touch counts. It is shown "Logged by <name>", at the time it happened, and "not verified".
import { DAY_MS, type Instant, MINUTE_MS } from '../../foundation/time.js';

export const ACTIVITY_KINDS = ['call', 'text', 'email'] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];
export const ACTIVITY_DIRECTIONS = ['outbound', 'inbound'] as const;
export type ActivityDirection = (typeof ACTIVITY_DIRECTIONS)[number];
export const CALL_OUTCOMES = ['connected', 'left_voicemail', 'no_answer', 'wrong_number', 'other'] as const;
export type CallOutcome = (typeof CALL_OUTCOMES)[number];

/** R-PAR-31: at most 5 minutes ahead of entry. */
export const ACTIVITY_MAX_AHEAD_MS = 5 * MINUTE_MS;
/** R-PAR-31: at most 366 days back (core keeps one day of margin under the DB CHECK). */
export const ACTIVITY_MAX_BACK_MS = 365 * DAY_MS;
/** "Remind me in N days" (an ordinary task). */
export const MAX_REMIND_DAYS = 365;

/** R-PAR-5 / R-PAR-32: a logged activity is never a touch. There is no input for which it is. */
export const LOGGED_ACTIVITY_IS_TOUCH = false as const;

export interface LoggedActivityInput {
  kind: ActivityKind;
  direction?: ActivityDirection | null;
  at: Instant;
  outcome?: CallOutcome | null;
  body?: string | null;
  remindInDays?: number | null;
}

export interface LoggedActivity {
  kind: ActivityKind;
  direction: ActivityDirection;
  at: Instant;
  outcome: CallOutcome | null;
  body: string;
  remindInDays: number | null;
}

export type ActivityCode = 'ACTIVITY_IN_FUTURE' | 'ACTIVITY_TOO_OLD' | 'OUTCOME_CALLS_ONLY' | 'VALIDATION_FAILED';

const KIND_WORD: Record<ActivityKind, string> = { call: 'call', text: 'text', email: 'email' };
const OUTCOME_WORD: Record<CallOutcome, string> = { connected: 'connected', left_voicemail: 'left a voicemail', no_answer: 'no answer', wrong_number: 'wrong number', other: 'other' };

/** The body used when the person typed nothing ("Outbound call: no answer"). */
export function defaultActivityBody(kind: ActivityKind, direction: ActivityDirection, outcome: CallOutcome | null): string {
  const head = `${direction === 'inbound' ? 'Inbound' : 'Outbound'} ${KIND_WORD[kind]}`;
  return outcome ? `${head}: ${OUTCOME_WORD[outcome]}` : head;
}

/** Validates a log-sheet entry at `now` (the entry time). */
export function validateLoggedActivity(i: LoggedActivityInput, now: Instant): { ok: true; activity: LoggedActivity } | { ok: false; code: ActivityCode } {
  if (!(ACTIVITY_KINDS as readonly string[]).includes(i.kind)) return { ok: false, code: 'VALIDATION_FAILED' };
  if (!Number.isFinite(i.at)) return { ok: false, code: 'VALIDATION_FAILED' };
  if (i.at > now + ACTIVITY_MAX_AHEAD_MS) return { ok: false, code: 'ACTIVITY_IN_FUTURE' };
  if (i.at < now - ACTIVITY_MAX_BACK_MS) return { ok: false, code: 'ACTIVITY_TOO_OLD' };
  const outcome = i.outcome ?? null;
  if (outcome !== null && i.kind !== 'call') return { ok: false, code: 'OUTCOME_CALLS_ONLY' };
  if (outcome !== null && !(CALL_OUTCOMES as readonly string[]).includes(outcome)) return { ok: false, code: 'VALIDATION_FAILED' };
  const direction = i.direction ?? 'outbound';
  if (!(ACTIVITY_DIRECTIONS as readonly string[]).includes(direction)) return { ok: false, code: 'VALIDATION_FAILED' };
  const remind = i.remindInDays ?? null;
  if (remind !== null && (!Number.isInteger(remind) || remind < 1 || remind > MAX_REMIND_DAYS)) return { ok: false, code: 'VALIDATION_FAILED' };
  const typed = (i.body ?? '').trim();
  if (typed.length > 20_000) return { ok: false, code: 'VALIDATION_FAILED' };
  return { ok: true, activity: { kind: i.kind, direction, at: i.at, outcome, body: typed || defaultActivityBody(i.kind, direction, outcome), remindInDays: remind } };
}

/** The "remind me" task title (no PII beyond what the person already sees on their own task). */
export function followUpTitle(kind: ActivityKind): string {
  return `Follow up after the ${KIND_WORD[kind]}`;
}

// E193 / R-PAR-32: free text that reads like "they asked not to be contacted" never blocks anything by
// itself; the log sheet asks "Did they ask not to be contacted?" and offers the real person-level
// do-not-contact. This only decides whether to ask.
const STOP_PATTERNS = [
  /\bstop\b/i,
  /\bunsubscribe\b/i,
  /\b(do\s*n[o']?t|never|no\s+more)\s+(call|text|email|contact|message)/i,
  /\bnot\s+to\s+be\s+contacted\b/i,
  /\bremove\s+(me|them|him|her)\b/i,
  /\btake\s+(me|them|him|her)\s+off\b/i,
  /\bleave\s+(me|them|him|her)\s+alone\b/i,
  /\b(do\s*not|don'?t)\s+contact\b/i,
  /\bdnc\b/i,
];

export function suggestsDoNotContact(text: string | null | undefined): boolean {
  if (!text) return false;
  return STOP_PATTERNS.some((re) => re.test(text));
}

// R-PAR-7 / E167: a tag that reads like an opt-out ("DNC", "Opted out", "Unsubscribed") never stops a
// message; the app asks "Tags don't stop messages. Record 'do not contact' for Jane?" and offers the real
// person-level do-not-contact. Same patterns as the importer's TAG_DNC / TAG_OPT_OUT / TAG_UNSUB
// (core/import/fub.ts), so a typed tag and an imported one are read alike.
const TAG_OPT_OUT_PATTERNS = [/^(dnc|do[\s_-]*not[\s_-]*(contact|call))$/i, /^(opted[\s_-]*out|opt[\s_-]*out|stop)$/i, /^unsubscribed$/i];

export function tagReadsAsOptOut(name: string): boolean {
  const t = name.trim();
  return TAG_OPT_OUT_PATTERNS.some((re) => re.test(t));
}
