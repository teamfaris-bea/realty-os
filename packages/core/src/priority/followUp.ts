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
import { type ContactId, DAY_MS, type IanaZone, type Instant, MINUTE_MS, addLocalDays, instant, startOfLocalDay } from '../foundation/index.js';
import { clip, textLabels } from './format.js';
import type { FeedReason, GateSummary, OneTapAction, TaskFacts } from './types.js';

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
  /** what the "Last" line may say: the most recent human contact OR manual note the viewer can see */
  lastTouch: LastTouch | null;
  /**
   * The most recent human CONTACT with the person (isContactCandidate): what the quiet clock counts from. A manual
   * note is never one (R-TODAY-12), so this can be older than `lastTouch`, or null while `lastTouch` is a note.
   */
  lastContact: LastTouch | null;
  lastContactAt: Instant | null;
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
 * How far ahead of now a logged activity may be dated and still be shown (R-TODAY-20): the log route's own allowance
 * (parity/people ACTIVITY_MAX_AHEAD_MS; a test holds the two equal).
 */
export const LOGGED_AHEAD_MS = 5 * MINUTE_MS;

/**
 * What one row is, for "what was last discussed". Everything not positively known to be a person's own contact is
 * not one: the default is 'none'.
 */
export function classifyCandidate(c: ContactCandidate, now: Instant): CandidateClass {
  // R-TODAY-20: a LOGGED activity may be dated a little ahead (the log route accepts it: the agent's clock can run
  // ahead of the server's). It is shown at once, not hidden until its time passes. Nothing else is ever ahead of now.
  const ahead = c.source === 'note' && c.noteSource === 'logged_activity' && c.activity !== null ? LOGGED_AHEAD_MS : 0;
  if (!(c.at <= now + ahead)) return 'none';
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

/**
 * True for a row that is CONTACT with the person (R-TODAY-12): a call, a text, an email, a chat message, a held
 * appointment, or a call, text or email the agent logged from outside the app (their own report; the owner's brief
 * decided it counts). A manual note is not: it is somebody's own words ABOUT the person (a Team Lead's housekeeping
 * note, the agent's reminder to themselves), so it never resets the quiet clock, though it may be the "Last" line.
 */
export function isContactCandidate(c: ContactCandidate, now: Instant): boolean {
  if (classifyCandidate(c, now) !== 'human') return false;
  return !(c.source === 'note' && c.activity === null);
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
  // (already newest first)
  const contact = human.find((c) => isContactCandidate(c, now));
  const lastContact = contact === undefined ? null : contact === last ? lastTouch : touchOf(contact);
  const auto = automatic[0];
  const lastAutomatic: LastAutomatic | null =
    auto && (lastTouch === null || auto.at > lastTouch.at) ? { kind: (MESSAGE_KIND[auto.channel] ?? 'text') as LastAutomatic['kind'], at: auto.at, bulk: auto.bulk } : null;
  return { lastTouch, lastContact, lastContactAt: lastContact?.at ?? null, lastAutomatic, importedHistoryAt: lastTouch === null ? importedAt : null };
}

// ---- one instant, two lines (R-TODAY-14) ----------------------------------------------------------

/**
 * An attempt that did not reach the person: a text or email of the agent's that failed, bounced or came back
 * undelivered, or a dial that never connected. It is never contact; it is what the card says instead of pretending a
 * conversation happened at that moment.
 */
export interface LastAttempt {
  kind: 'text' | 'email' | 'call';
  at: Instant;
  what: 'undelivered' | 'failed_dial';
}

/** The message statuses that mean it did not reach the person. */
const NOT_DELIVERED: ReadonlySet<string> = new Set(['failed', 'undelivered', 'bounced']);

/** The newest attempt of the agent's own that did not reach the person, among the candidates; null: none. */
export function selectLastAttempt(candidates: readonly ContactCandidate[], now: Instant): LastAttempt | null {
  let best: LastAttempt | null = null;
  for (const c of candidates) {
    if (!(c.at <= now)) continue;
    let a: LastAttempt | null = null;
    if (c.source === 'message' && !c.imported && c.direction === 'outbound' && c.initiator === 'human' && !c.bulk && NOT_DELIVERED.has(c.status)) {
      const kind = MESSAGE_KIND[c.channel];
      if (kind === 'text' || kind === 'email') a = { kind, at: c.at, what: 'undelivered' };
    } else if (c.source === 'call' && !c.imported && c.direction === 'outbound' && c.initiator === 'human' && classifyCandidate(c, now) === 'none' && (c.status === 'failed' || c.status === 'canceled')) {
      a = { kind: 'call', at: c.at, what: 'failed_dial' };
    }
    if (a && (best === null || a.at > best.at)) best = a;
  }
  return best;
}

/**
 * What stands at the instant the quiet clock is worded from:
 *   contact       a conversation or message the viewer can read (a verified call, their reply, a delivered text, a
 *                 held appointment, a call the agent logged from outside the app)
 *   undelivered   the latest thing is a text or email of the agent's that did not reach the person
 *   failed_dial   the latest thing is a dial that never connected
 *   touch_only    the system counted a contact then, and nothing the viewer can read stands behind it
 *   imported      only imported history
 *   never         nothing at all (an automated or bulk message is never any of the above)
 */
export type QuietBasis = 'contact' | 'undelivered' | 'failed_dial' | 'touch_only' | 'imported' | 'never';

export interface QuietStory {
  basis: QuietBasis;
  /** the ONE instant the Due line and the Last line are both worded from; null: never */
  at: Instant | null;
  /** set for `undelivered` and `failed_dial` */
  attempt: LastAttempt | null;
}

/** The system's own touch instant and the row it was recorded for are the same event when they are this close. */
export const TOUCH_SLACK_MS = 5 * MINUTE_MS;

/**
 * The story of a person's quiet clock (R-TODAY-14), from the same facts the daily plan reads: the latest of a readable
 * contact, an attempt that did not reach them, a touch the system counted with nothing readable behind it, and (only
 * when there is no readable contact) imported history. A tie goes to the contact, then the attempt, then imported
 * history. Both lines of a card are worded from this one answer, so they cannot disagree.
 */
export function quietStory(i: { lastContactAt: Instant | null; touchAt: Instant | null; importedAt: Instant | null; attempt: LastAttempt | null }): QuietStory {
  const c = i.lastContactAt;
  // an attempt older than the last conversation is history, not the story
  const attempt = i.attempt !== null && (c === null || i.attempt.at > c) ? i.attempt : null;
  // the system's touch is its own event only when neither a readable contact nor the attempt explains it
  const explained = (t: Instant) => (c !== null && t <= c + TOUCH_SLACK_MS) || (attempt !== null && Math.abs(t - attempt.at) <= TOUCH_SLACK_MS) || (attempt !== null && t <= attempt.at);
  const touch = i.touchAt !== null && !explained(i.touchAt) ? i.touchAt : null;
  const imported = c === null ? i.importedAt : null;
  const options: QuietStory[] = [];
  if (c !== null) options.push({ basis: 'contact', at: c, attempt: null });
  if (attempt !== null) options.push({ basis: attempt.what === 'failed_dial' ? 'failed_dial' : 'undelivered', at: attempt.at, attempt });
  if (imported !== null) options.push({ basis: 'imported', at: imported, attempt: null });
  if (touch !== null) options.push({ basis: 'touch_only', at: touch, attempt: null });
  // the latest wins; `options` is already in tie order
  let best: QuietStory | null = null;
  for (const o of options) if (best === null || (o.at as Instant) > (best.at as Instant)) best = o;
  return best ?? { basis: 'never', at: null, attempt: null };
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
  /**
   * R-TODAY-19: for an all-day task, the zone its DAY is in (the task's own, else the team's): the zone `overdue` was
   * decided in, and the one a screen must word the day in, whatever zone the viewer's device is in. Null for a timed
   * or undated task (an instant reads the same everywhere).
   */
  dueZone: IanaZone | null;
  /**
   * When it stops being on time (promiseDeadline): its instant, or for an all-day task the end of its local day. The
   * replace-a-task rule (parity/people decideTaskReplacement) reads this, never the screen's own idea of "due".
   */
  deadline: Instant | null;
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
  return { taskId: first.taskId, text: first.title, kind: first.kind, dueAt: first.dueAt, dueAllDay: first.dueAllDay, dueZone: first.dueAllDay && first.dueAt !== null ? (first.dueTz ?? teamZone) : null, deadline, overdue: deadline !== null && now >= deadline };
}

// ---- the daily plan: "Follow up today" (R-TODAY-6) -------------------------------------------------

/**
 * How long a person may go without a human contact before they are due again, in days, per stage. Only these two
 * stages have a threshold: "Connected" (we have talked, not working together yet) and "Long-term follow-up" (months
 * away, we keep in touch). OWNER QUESTION: 7 and 30 are the values proposed in the brief, not a measured choice.
 */
export const WARM_FOLLOW_UP_DAYS: Readonly<Record<string, number>> = { connected: 7, nurture: 30 };

/** The plan lists at most this many people; the total says how many are due in all. */
export const FOLLOW_UP_TODAY_CAP = 20;

/** The first instant of tomorrow in the team's zone: a task due before it is due "today or earlier". */
export function startOfTomorrow(now: Instant, teamZone: IanaZone): Instant {
  return addLocalDays(startOfLocalDay(now, teamZone), 1, teamZone);
}

const ONE_TO_ONE: readonly ('voice' | 'sms' | 'email')[] = ['voice', 'sms', 'email'];

/**
 * True when the person opted out of (or is blocked on) every channel the agent could use: no phone, text or email is
 * open, and at least one of them is closed by a refusal rather than by a missing number or address. A person with no
 * phone and no email at all has opted out of nothing and is not covered by this.
 */
export function optedOutOfEveryChannel(gate: GateSummary | undefined): boolean {
  if (gate === undefined) return false;
  const blocks = ONE_TO_ONE.map((ch) => gate[ch]);
  return blocks.every((b) => b !== undefined) && blocks.some((b) => b?.outcome === 'deny');
}

/** One person the agent owns, as the plan reads them. The caller passes only people the agent owns and may contact. */
export interface FollowUpPersonFacts {
  contactId: string;
  /** contacts.stage */
  stage: string;
  /** every open task of the agent for this person */
  tasks: readonly PromiseTask[];
  /**
   * the most recent human CONTACT the agent can see (selectLastContact's lastContactAt, the system's own last-touch
   * instant and imported history all count; a manual note never does: R-TODAY-12); null: none
   */
  lastContactAt: Instant | null;
  /** for someone never contacted: since when they are the agent's */
  sinceAt: Instant;
  gate: GateSummary | undefined;
}

export interface FollowUpTodayEntry {
  contactId: string;
  /** promise: a promise of the agent's is among their tasks due today or earlier; task: only other tasks are; warm: quiet for longer than the stage's threshold */
  reason: 'promise' | 'task' | 'warm';
  /** since when they are due (the plan's order): the earliest due task's deadline, or the last contact plus the threshold */
  dueAt: Instant;
  /**
   * the tasks due today or earlier (empty for warm). The first is the one the row LEADS with: the earliest due promise
   * when there is one, else the earliest due task (R-TODAY-15); the others follow, earliest first.
   */
  taskIds: string[];
  /** warm: whole days since the last contact (since they became the agent's when never contacted) */
  quietDays: number | null;
  neverContacted: boolean;
}

/**
 * Who the agent should follow up with today, most overdue first, capped. A person is in it once: by their earliest
 * due task, else by being quiet in a warm stage with no dated next step. Never someone who opted out of every channel.
 */
export function planFollowUpToday(i: { now: Instant; zone: IanaZone; people: readonly FollowUpPersonFacts[]; cap?: number }): { people: FollowUpTodayEntry[]; total: number } {
  const { now } = i;
  const tomorrow = startOfTomorrow(now, i.zone);
  const out: FollowUpTodayEntry[] = [];
  for (const p of i.people) {
    if (optedOutOfEveryChannel(p.gate)) continue;
    const dated = p.tasks.map((t) => ({ t, deadline: promiseDeadline(t, i.zone) })).filter((x): x is { t: PromiseTask; deadline: Instant } => x.deadline !== null);
    // due today or earlier: its instant is before tomorrow (an all-day task's own day has started)
    const due = dated.filter((x) => (x.t.dueAllDay ? (x.t.dueAt as Instant) : x.deadline) < tomorrow).sort((a, b) => a.deadline - b.deadline || a.t.createdAt - b.t.createdAt || (a.t.taskId < b.t.taskId ? -1 : 1));
    const first = due[0];
    if (first) {
      // R-TODAY-15: a due promise is never hidden behind an earlier routine task. The row LEADS with the earliest due
      // promise when there is one (taskIds[0]); the others follow, earliest first. The person is still ordered by
      // their earliest deadline of all.
      const lead = due.find((x) => x.t.kind === 'promise') ?? first;
      out.push({ contactId: p.contactId, reason: lead.t.kind === 'promise' ? 'promise' : 'task', dueAt: first.deadline, taskIds: [lead, ...due.filter((x) => x !== lead)].map((x) => x.t.taskId), quietDays: null, neverContacted: false });
      continue;
    }
    const days = WARM_FOLLOW_UP_DAYS[p.stage];
    // a dated next step is already set: they come due with it, not before
    if (days === undefined || dated.length > 0) continue;
    const anchor = p.lastContactAt ?? p.sinceAt;
    if (!(now - anchor > days * DAY_MS)) continue;
    out.push({ contactId: p.contactId, reason: 'warm', dueAt: instant(anchor + days * DAY_MS), taskIds: [], quietDays: Math.floor((now - anchor) / DAY_MS), neverContacted: p.lastContactAt === null });
  }
  out.sort((a, b) => a.dueAt - b.dueAt || (a.contactId < b.contactId ? -1 : a.contactId > b.contactId ? 1 : 0));
  return { people: out.slice(0, i.cap ?? FOLLOW_UP_TODAY_CAP), total: out.length };
}

const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;
const ATTEMPT_WORD: Readonly<Record<LastAttempt['kind'], string>> = { text: 'text', email: 'email', call: 'call' };

/**
 * The Due line of a quiet person (R-TODAY-14), stage by evidence. It is worded from the story's ONE instant, and the
 * Last line under it is worded from the same story (apps/web feed/lib/followUp.ts lastLine), so the two cannot
 * disagree:
 *
 *   never                    "<Stage>: no conversation yet"                           (and no Last line repeats it)
 *   contact, touch_only      "<Stage>: no conversation for N days"                     (N counted from that instant)
 *   undelivered              "<Stage>, but the last text was not delivered"
 *   failed_dial              "<Stage>, but the last call did not connect"
 *   imported                 "<Stage>: only imported history, the latest N days ago"
 */
export function warmReason(story: QuietStory, o: { now: Instant; stageLabel: string }): FeedReason {
  const n = story.at === null ? 0 : Math.max(0, Math.floor((o.now - story.at) / DAY_MS));
  switch (story.basis) {
    case 'never':
      return { code: 'WARM_NEVER_CONTACTED', label: `${o.stageLabel}: no conversation yet` };
    case 'undelivered':
      return { code: 'WARM_NOT_DELIVERED', label: `${o.stageLabel}, but the last ${ATTEMPT_WORD[story.attempt?.kind ?? 'text']} was not delivered` };
    case 'failed_dial':
      return { code: 'WARM_CALL_FAILED', label: `${o.stageLabel}, but the last call did not connect` };
    case 'imported':
      return { code: 'WARM_IMPORTED_ONLY', label: `${o.stageLabel}: only imported history, the latest ${days(n)} ago` };
    case 'contact':
    case 'touch_only':
      return { code: 'WARM_NO_CONTACT', label: `${o.stageLabel}: no conversation for ${days(n)}` };
  }
}

/** How many of a row's other due tasks are named in its "Also due" line before the rest are counted. */
export const ALSO_DUE_NAMED = 3;

/**
 * Why a person is in the plan, in words. Never scored: these reasons carry no points.
 *   `story` (R-TODAY-14): the person's quiet story, which words a warm row; without it the entry's own facts do.
 *   `tasks` and `zone` (R-TODAY-15): the person's tasks. With them the first reason is said in the LEAD task's own
 *   time (a promise overdue 1 h is "1 h overdue" though a routine task has been overdue for 2), and the others are
 *   named in one line: "Also due: Follow up with Dana". Without them, as before: the entry's instant and a count.
 */
export function followUpTodayReasons(e: FollowUpTodayEntry, o: { now: Instant; stageLabel: string; story?: QuietStory | undefined; tasks?: readonly PromiseTask[] | undefined; zone?: IanaZone | undefined }): FeedReason[] {
  const f = textLabels(o.now);
  if (e.reason === 'warm') {
    if (o.story) return [warmReason(o.story, o)];
    if (e.neverContacted) return [{ code: 'WARM_NEVER_CONTACTED', label: `${o.stageLabel}: no conversation yet` }];
    return [{ code: 'WARM_NO_CONTACT', label: `${o.stageLabel}: no conversation for ${days(e.quietDays ?? 0)}` }];
  }
  const byId = new Map((o.tasks ?? []).map((t) => [t.taskId, t]));
  const lead = byId.get(e.taskIds[0] ?? '');
  const leadDue = (lead && o.zone ? promiseDeadline(lead, o.zone) : null) ?? e.dueAt;
  const overdue = o.now >= leadDue;
  const promise = e.reason === 'promise';
  const first: FeedReason = promise
    ? { code: overdue ? 'PROMISE_OVERDUE' : 'PROMISE_DUE', label: overdue ? `You promised this; ${f.since(leadDue)} overdue` : `You promised this; due ${f.in(leadDue)}` }
    : { code: overdue ? 'TASK_OVERDUE' : 'TASK_DUE', label: overdue ? `Overdue by ${f.since(leadDue)}` : `Due ${f.in(leadDue)}` };
  if (e.taskIds.length <= 1) return [first];
  const others = e.taskIds.slice(1).map((id) => byId.get(id)?.title);
  if (others.some((t) => t === undefined)) return [first, { code: 'MORE_DUE', label: `${e.taskIds.length} tasks due today or earlier` }];
  const named = (others as string[]).slice(0, ALSO_DUE_NAMED);
  const more = others.length - named.length;
  return [first, { code: 'ALSO_DUE', label: `Also due: ${named.join(', ')}${more > 0 ? ` and ${more} more` : ''}` }];
}

/**
 * What a row of the plan offers: the agent's own call, text or email on a channel that is open, Done for the due
 * task, and the person's page. Nothing here sends by itself.
 */
export function followUpActions(contactId: ContactId, gate: GateSummary | undefined, taskId: string | null): { primaryAction: OneTapAction; alternatives: OneTapAction[] } {
  const usable: OneTapAction[] = [];
  if (gate?.voice === undefined) usable.push({ kind: 'call', label: 'Call', contactId });
  if (gate?.sms === undefined) usable.push({ kind: 'text', label: 'Text', contactId });
  if (gate?.email === undefined) usable.push({ kind: 'email', label: 'Email', contactId });
  const open: OneTapAction = { kind: 'open_contact', label: 'Open', contactId };
  const done: OneTapAction[] = taskId === null ? [] : [{ kind: 'complete_task', label: 'Done', taskId: taskId as never }];
  const [primary, ...rest] = usable;
  if (primary === undefined) return { primaryAction: open, alternatives: done };
  return { primaryAction: primary, alternatives: [...rest, ...done, open] };
}
