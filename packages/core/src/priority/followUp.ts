// Warm follow-up in Today (batch 19; R-TODAY-1 to R-TODAY-6). Pure selection, no I/O:
//
//   selectLastContact   what was last discussed with a person: the most recent HUMAN contact, one-sided or two-sided
//                       (a call, a text, an email, a website-chat message, the agent's own note, a held appointment,
//                       or a call, text or email the agent LOGGED from outside the app). An automated message (the
//                       assistant's, a plan's, a bulk or marketing send) is never the last thing discussed: the most
//                       recent one after the last human contact is returned beside it, as its own line. Imported
//                       history is neither (nobody can say who or what wrote it): only its date is returned.
//   selectNextPromise   the earliest open task of the viewer for the person, worded as it was written; overdue is
//                       decided in the team's time zone (an all-day task is due until the end of its local day).
//   planFollowUpToday   the daily plan: who is due today by a promise or task, and who in "Connected" or "Long-term
//                       follow-up" has had no human contact for longer than the stage's threshold.
//
// The caller (apps/api workspace/repos/followUp.ts) reads every candidate under the VIEWER's own row-level security,
// so a candidate here is always a row the viewer could open. Nothing here creates a message, a task or a touch, and
// nothing here is read by scoring, the first-contact clock or a scoreboard: a logged outside call is the agent's own
// report (`reported: true`) and is never the same thing as a call the system placed.
import { type IanaZone, type Instant, addLocalDays, startOfLocalDay } from '../foundation/index.js';
import { clip } from './format.js';
import type { TaskFacts } from './types.js';

// ---- which cards carry the follow-up lines --------------------------------------------------------

/**
 * The card types that are about following up with one person, and whose person's detail the viewer may open. A lead
 * offer and a pond card are not among them: their viewer sees a card, not the person's history.
 */
export const FOLLOW_UP_ITEM_TYPES: readonly string[] = ['first_touch_due', 'unanswered_inbound', 'missed_call', 'handback', 'promise_due', 'task_due', 'reinquiry', 'inactivity_warning', 'warm_follow_up'];

export function isFollowUpItemType(itemType: string): boolean {
  return FOLLOW_UP_ITEM_TYPES.includes(itemType);
}

// ---- the last human contact -----------------------------------------------------------------------

export type LastTouchKind = 'call' | 'text' | 'email' | 'chat' | 'note' | 'appointment';

interface CandidateBase {
  id: string;
  /** when it happened (a logged activity: when the agent said it happened) */
  at: Instant;
  /** who did it on the team (null: the client did, or nobody is named) */
  byName: string | null;
  /** that teammate's user id, so the caller can tell the viewer's own contact from a teammate's (optional) */
  byUserId?: string | null;
}

export type ContactCandidate =
  | (CandidateBase & {
      source: 'message';
      channel: 'sms' | 'mms' | 'email' | 'web_chat';
      direction: 'inbound' | 'outbound';
      initiator: 'human' | 'assistant' | 'system' | 'client' | 'import';
      imported: boolean;
      /** part of a bulk action or a marketing piece: a mass send, whoever started it */
      bulk: boolean;
      autoReply: boolean;
      /** messages.status */
      status: string;
      /** the text as the viewer may read it (stored redactions kept, older tokens hidden by the caller) */
      body: string | null;
    })
  | (CandidateBase & {
      source: 'call';
      direction: 'inbound' | 'outbound';
      initiator: 'human' | 'client' | 'import';
      imported: boolean;
      /** calls.status */
      status: string;
      answered: boolean;
      handledBy: 'human' | 'voicemail' | 'assistant';
      /** calls.outcome */
      outcome: string | null;
      talkSeconds: number | null;
    })
  | (CandidateBase & {
      source: 'note';
      /** notes.source */
      noteSource: 'manual' | 'logged_activity' | 'call_summary' | 'import' | (string & {});
      imported: boolean;
      /** a logged outside call, text or email (notes.activity_*) */
      activity: { kind: 'call' | 'text' | 'email'; direction: 'inbound' | 'outbound' | null; outcome: string | null } | null;
      /** the body is the one the system writes for a log with nothing typed ("Outbound call: no answer") */
      bodyIsDefault: boolean;
      body: string | null;
    })
  | (CandidateBase & {
      source: 'appointment';
      /** appointments.status */
      status: string;
      /** appointments.outcome */
      outcome: string | null;
    });

export interface LastTouch {
  kind: LastTouchKind;
  at: Instant;
  /** the teammate who called, wrote or logged it; null when the client did */
  byName: string | null;
  /** their user id when the caller gave one (null otherwise, and for the client) */
  byUserId: string | null;
  direction: 'inbound' | 'outbound' | null;
  /** what came of it, in words that fit after the kind ("talked 6 min", "left a voicemail"); null: nothing recorded */
  outcome: string | null;
  /** at most about 140 characters of the note or the message; null: nothing to quote */
  snippet: string | null;
  /**
   * true: the agent's own report of something that happened outside the app (a logged call, text or email). It was
   * never placed, sent or verified by the system and must be labelled so wherever it is shown.
   */
  reported: boolean;
}

export interface LastAutomatic {
  kind: 'text' | 'email' | 'chat';
  at: Instant;
  /** a bulk or marketing send (a person may have started it; it is still not a conversation) */
  bulk: boolean;
}

export interface LastContact {
  lastTouch: LastTouch | null;
  /** the most recent automated message AFTER the last human contact (or the most recent one when there is none) */
  lastAutomatic: LastAutomatic | null;
  /** only when there is no last touch: the date of the latest imported entry, if any history was imported */
  importedHistoryAt: Instant | null;
}

/** What the card says when the viewer can see no human contact with the person. */
export const NO_CONVERSATION_YET = 'No conversation yet.';

/** The message statuses that mean it went out (a queued, scheduled, blocked, failed or unconfirmed one did not). */
const WENT_OUT: ReadonlySet<string> = new Set(['sent', 'delivered']);

/** The call statuses of an outbound call that reached the person's phone, answered or not. */
const CALL_RANG: ReadonlySet<string> = new Set(['completed', 'no_answer', 'busy', 'voicemail']);

export type CandidateClass = 'human' | 'automatic' | 'imported' | 'none';

/**
 * What one row is, for "what was last discussed". Everything not positively known to be a person's own contact is
 * not one: the default is 'none'.
 */
export function classifyCandidate(c: ContactCandidate, now: Instant): CandidateClass {
  if (!(c.at <= now)) return 'none';
  switch (c.source) {
    case 'message': {
      if (c.imported || c.initiator === 'import') return 'imported';
      if (c.direction === 'inbound') return c.autoReply ? 'none' : 'human';
      if (!WENT_OUT.has(c.status)) return 'none';
      if (c.bulk || c.initiator === 'assistant' || c.initiator === 'system') return 'automatic';
      return c.initiator === 'human' ? 'human' : 'none';
    }
    case 'call': {
      if (c.imported || c.initiator === 'import') return 'imported';
      // a call the agent placed is a contact once it rang out (or they said what came of it); a dial that failed did not
      if (c.direction === 'outbound') return c.initiator === 'human' && (c.answered || c.outcome !== null || CALL_RANG.has(c.status)) ? 'human' : 'none';
      return c.answered && c.handledBy === 'human' ? 'human' : 'none';
    }
    case 'note': {
      if (c.imported || c.noteSource === 'import') return 'imported';
      if (c.noteSource === 'manual') return 'human';
      if (c.noteSource === 'logged_activity' && c.activity !== null) return 'human';
      return 'none';
    }
    case 'appointment':
      return c.status === 'held' ? 'human' : 'none';
  }
}

export const SNIPPET_MAX = 140;

/** At most `max` characters of `text` on one line, cut on a word with an ellipsis; null when there is nothing. */
export function snippetOf(text: string | null | undefined, max: number = SNIPPET_MAX): string | null {
  if (text === null || text === undefined) return null;
  const s = clip(text, max);
  return s.length > 0 ? s : null;
}

function talked(seconds: number | null): string {
  if (seconds === null) return 'talked';
  if (seconds < 60) return 'talked under a minute';
  return `talked ${Math.round(seconds / 60)} min`;
}

const CALL_OUTCOME_WORDS: Readonly<Record<string, string>> = {
  left_voicemail: 'left a voicemail',
  no_answer: 'no answer',
  wrong_number: 'wrong number',
  bad_number: 'number not working',
  do_not_call_request: 'asked not to be called',
  callback_requested: 'asked for a call back',
};

const APPOINTMENT_OUTCOME_WORDS: Readonly<Record<string, string>> = {
  agreement_signed: 'agreement signed',
  follow_up: 'follow-up needed',
  not_a_fit: 'not a fit',
  no_decision: 'no decision yet',
};

const MESSAGE_KIND: Readonly<Record<string, LastTouchKind>> = { sms: 'text', mms: 'text', email: 'email', web_chat: 'chat' };

function touchOf(c: ContactCandidate): LastTouch {
  switch (c.source) {
    case 'message':
      return { kind: MESSAGE_KIND[c.channel] ?? 'text', at: c.at, byName: c.direction === 'inbound' ? null : c.byName, byUserId: c.direction === 'inbound' ? null : (c.byUserId ?? null), direction: c.direction, outcome: null, snippet: snippetOf(c.body), reported: false };
    case 'call': {
      const outcome = c.outcome === 'connected' || (c.outcome === null && c.answered) ? talked(c.talkSeconds) : c.outcome !== null ? (CALL_OUTCOME_WORDS[c.outcome] ?? null) : null;
      return { kind: 'call', at: c.at, byName: c.byName, byUserId: c.byUserId ?? null, direction: c.direction, outcome, snippet: null, reported: false };
    }
    case 'note': {
      if (c.activity !== null) {
        // the agent's own report: never a duration (nobody measured it), never anything a system call would say
        const outcome = c.activity.outcome === 'connected' ? 'talked' : c.activity.outcome !== null ? (CALL_OUTCOME_WORDS[c.activity.outcome] ?? null) : null;
        return { kind: c.activity.kind, at: c.at, byName: c.byName, byUserId: c.byUserId ?? null, direction: c.activity.direction ?? 'outbound', outcome, snippet: c.bodyIsDefault ? null : snippetOf(c.body), reported: true };
      }
      return { kind: 'note', at: c.at, byName: c.byName, byUserId: c.byUserId ?? null, direction: null, outcome: null, snippet: snippetOf(c.body), reported: false };
    }
    case 'appointment':
      return { kind: 'appointment', at: c.at, byName: c.byName, byUserId: c.byUserId ?? null, direction: null, outcome: c.outcome !== null ? (APPOINTMENT_OUTCOME_WORDS[c.outcome] ?? null) : null, snippet: null, reported: false };
  }
}

const SOURCE_ORDER: Readonly<Record<ContactCandidate['source'], number>> = { call: 0, appointment: 1, message: 2, note: 3 };

/** Later first; a tie by source, then id, so the same set gives the same answer in any order. */
function newerFirst(a: ContactCandidate, b: ContactCandidate): number {
  return b.at - a.at || SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * What was last discussed, from the rows the viewer can see. An automated message is never chosen as the last touch,
 * whatever the order or the dates of the candidates.
 */
export function selectLastContact(candidates: readonly ContactCandidate[], now: Instant): LastContact {
  const human: ContactCandidate[] = [];
  const automatic: Extract<ContactCandidate, { source: 'message' }>[] = [];
  let importedAt: Instant | null = null;
  for (const c of candidates) {
    const k = classifyCandidate(c, now);
    if (k === 'human') human.push(c);
    else if (k === 'automatic' && c.source === 'message') automatic.push(c);
    else if (k === 'imported' && (importedAt === null || c.at > importedAt)) importedAt = c.at;
  }
  human.sort(newerFirst);
  automatic.sort(newerFirst);
  const last = human[0];
  const lastTouch = last ? touchOf(last) : null;
  const auto = automatic[0];
  const lastAutomatic: LastAutomatic | null =
    auto && (lastTouch === null || auto.at > lastTouch.at) ? { kind: (MESSAGE_KIND[auto.channel] ?? 'text') as LastAutomatic['kind'], at: auto.at, bulk: auto.bulk } : null;
  return { lastTouch, lastAutomatic, importedHistoryAt: lastTouch === null ? importedAt : null };
}

// ---- the next promise -----------------------------------------------------------------------------

export type PromiseTask = Pick<TaskFacts, 'kind' | 'dueAt' | 'dueAllDay' | 'dueTz' | 'createdAt'> & { taskId: string; title: string };

export interface NextPromise {
  taskId: string;
  /** the task's own title, as it was written */
  text: string;
  kind: TaskFacts['kind'];
  dueAt: Instant | null;
  dueAllDay: boolean;
  overdue: boolean;
}

/**
 * When a task stops being on time, in the team's zone: its instant, or for an all-day task the end of its local day
 * (in the task's own zone when it has one, else the team's).
 */
export function promiseDeadline(t: Pick<PromiseTask, 'dueAt' | 'dueAllDay' | 'dueTz'>, teamZone: IanaZone): Instant | null {
  if (t.dueAt === null) return null;
  if (!t.dueAllDay) return t.dueAt;
  const z = t.dueTz ?? teamZone;
  return addLocalDays(startOfLocalDay(t.dueAt, z), 1, z);
}

function byDeadline(zoneOf: IanaZone) {
  return (a: PromiseTask, b: PromiseTask): number => {
    const da = promiseDeadline(a, zoneOf);
    const db = promiseDeadline(b, zoneOf);
    if (da !== db) {
      if (da === null) return 1;
      if (db === null) return -1;
      return da - db;
    }
    return a.createdAt - b.createdAt || (a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0);
  };
}

/** The earliest open task of the viewer for one person (the caller passes only those), or null. */
export function selectNextPromise(tasks: readonly PromiseTask[], now: Instant, teamZone: IanaZone): NextPromise | null {
  const first = [...tasks].sort(byDeadline(teamZone))[0];
  if (!first) return null;
  const deadline = promiseDeadline(first, teamZone);
  return { taskId: first.taskId, text: first.title, kind: first.kind, dueAt: first.dueAt, dueAllDay: first.dueAllDay, overdue: deadline !== null && now >= deadline };
}
