// The words of a follow-up card (batch 19, warm follow-up in Today; R-TODAY-1, R-TODAY-4): what was last discussed,
// the automatic line, the next promise, and how a call, text or email the agent LOGGED from outside the app is said
// wherever it is shown (the card, the person's notes, the timeline). One place, so the label cannot drift:
//
//   "Logged by you: called from your phone, left a voicemail (Wed 2:10 PM)"
//
// A logged activity always starts "Logged by …": it is the agent's own report and is never worded as a call the system
// placed or a message it sent. An automated message is never the "Last" line; it is said on its own line.
// Times are the viewer's own (the browser's zone), like every other time on the feed.
import type { FeedCard, LastAutomaticView, LastTouchView, NextPromiseView } from './types.js';

export const NO_CONVERSATION_YET = 'No conversation yet.';
export const NO_NEXT_STEP = 'No next step set.';

const DAY = 86_400_000;
const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};
const timeOf = (d: Date) => new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' }).format(d);

/**
 * "today 2:10 PM", "yesterday", "Tue", "Nov 12", "Nov 12, 2025"; ahead: "tomorrow", "Mon", "Nov 30". Today always
 * carries the time; other days carry it when `time` is set ("Tue 2:10 PM").
 */
export function whenWords(iso: string, nowMs: number, o: { time?: boolean } = {}): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  // whole local days between the two dates (rounded: a DST day is 23 or 25 hours)
  const days = Math.round((startOfDay(d.getTime()) - startOfDay(nowMs)) / DAY);
  const t = timeOf(d);
  if (days === 0) return `today ${t}`;
  const day =
    days === -1
      ? 'yesterday'
      : days === 1
        ? 'tomorrow'
        : Math.abs(days) < 7
          ? new Intl.DateTimeFormat('en-US', { weekday: 'short' }).format(d)
          : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', ...(d.getFullYear() !== new Date(nowMs).getFullYear() ? { year: 'numeric' } : {}) }).format(d);
  if (!o.time) return day;
  return Math.abs(days) < 7 ? `${day} ${t}` : `${day}, ${t}`;
}

/** The calendar day of an instant in `zone`, as [year, month, day]; null when the device does not know the zone. */
function dayIn(ms: number, zone: string): [number, number, number] | null {
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(ms);
    const n = (t: string) => Number(parts.find((p) => p.type === t)?.value);
    const out: [number, number, number] = [n('year'), n('month'), n('day')];
    return out.every(Number.isFinite) ? out : null;
  } catch {
    return null;
  }
}

/**
 * The day of an ALL-DAY task (R-TODAY-19), worded in the task's own zone (the server sends it: the task's, else the
 * team's), never in the zone of the viewer's device: "today", "yesterday", "tomorrow", "Thu", "Nov 19", "Dec 31, 2025".
 * The day and "today" are both read in that zone, so a task due today there is "today" for a viewer anywhere, and the
 * words agree with the server's own overdue flag. No time is said: the task has none. An unknown zone falls back to
 * the viewer's own day.
 */
export function allDayWords(iso: string, zone: string | null | undefined, nowMs: number): string {
  const at = Date.parse(iso);
  const due = zone && Number.isFinite(at) ? dayIn(at, zone) : null;
  const today = zone ? dayIn(nowMs, zone) : null;
  if (!zone || !due || !today) return whenWords(iso, nowMs).replace(/^today .*$/, 'today');
  const utc = (d: [number, number, number]) => Date.UTC(d[0], d[1] - 1, d[2]);
  const days = Math.round((utc(due) - utc(today)) / DAY);
  if (days === 0) return 'today';
  if (days === -1) return 'yesterday';
  if (days === 1) return 'tomorrow';
  // (the calendar day itself, formatted as a UTC date so the device's zone cannot move it)
  const d = new Date(utc(due));
  if (Math.abs(days) < 7) return new Intl.DateTimeFormat('en-US', { weekday: 'short', timeZone: 'UTC' }).format(d);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC', ...(due[0] !== today[0] ? { year: 'numeric' } : {}) }).format(d);
}

/** The outcome of a LOGGED call in words (notes.activity_outcome; core's last-touch words are the same). */
export const LOGGED_OUTCOME_WORDS: Readonly<Record<string, string>> = { connected: 'talked', left_voicemail: 'left a voicemail', no_answer: 'no answer', wrong_number: 'wrong number' };

export interface LoggedActivityWords {
  kind: 'call' | 'text' | 'email' | (string & {});
  direction: 'inbound' | 'outbound' | null;
  /** in words ("left a voicemail"); null: none */
  outcome: string | null;
  byName: string | null;
  byMe: boolean;
}

/**
 * How a logged outside activity is said, everywhere: "Logged by you: called from your phone, left a voicemail".
 * Always the reporter first; never anything that reads as the system having placed or sent it.
 */
export function loggedWords(a: LoggedActivityWords): string {
  const who = a.byMe ? 'you' : (a.byName ?? 'a teammate');
  const phone = a.byMe ? 'your phone' : 'their phone';
  const inbound = a.direction === 'inbound';
  const what =
    a.kind === 'call'
      ? inbound
        ? `they called ${phone}`
        : `called from ${phone}`
      : a.kind === 'text'
        ? inbound
          ? `they texted ${phone}`
          : `texted from ${phone}`
        : inbound
          ? 'they emailed outside Realty OS'
          : 'emailed from outside Realty OS';
  return `Logged by ${who}: ${what}${a.outcome ? `, ${a.outcome}` : ''}`;
}

const quoted = (s: string | null) => (s ? `: “${s}”` : '');

const VERB: Record<string, { mine: string; theirs: string }> = {
  call: { mine: 'Call', theirs: 'They called' },
  text: { mine: 'Text', theirs: 'They texted' },
  email: { mine: 'Email', theirs: 'They emailed' },
  chat: { mine: 'Website chat', theirs: 'They wrote in the website chat' },
  note: { mine: 'Note', theirs: 'Note' },
  appointment: { mine: 'Appointment', theirs: 'Appointment' },
};

/**
 * The "Last" line. null: no human contact the viewer can see; `importedAt` then says that earlier history was
 * imported (it is never called a conversation: nobody can say who or what wrote it).
 */
export function lastTouchLine(t: LastTouchView | null | undefined, nowMs: number, importedAt?: string | null): string {
  if (!t) return importedAt ? `No conversation yet in Realty OS. Earlier history was imported (latest entry ${whenWords(importedAt, nowMs)}).` : NO_CONVERSATION_YET;
  if (t.reported) return `${loggedWords(t)} (${whenWords(t.at, nowMs, { time: true })})${quoted(t.snippet)}`;
  const v = VERB[t.kind] ?? VERB.note!;
  const head = t.direction === 'inbound' ? `${v.theirs} ${whenWords(t.at, nowMs)}` : `${v.mine} ${whenWords(t.at, nowMs)}${!t.byMe && t.byName ? ` by ${t.byName}` : ''}`;
  return `${head}${t.outcome ? `, ${t.outcome}` : ''}${quoted(t.snippet)}`;
}

/** Ends a sentence that does not end one yet ("Call Nov 10, talked 6 min" → "….", a quoted snippet is left as it is). */
const stop = (s: string) => (/[.!?”"]$/.test(s) ? s : `${s}.`);

/**
 * The "Last" line of a follow-up card, worded from the SAME story as its Due line (R-TODAY-14: the server's `quiet`,
 * core quietStory), so the two can never disagree. By what stands at the story's instant:
 *
 *   contact       the conversation itself, dated ("Call Nov 10, talked 6 min"); under a newer note, the note first and
 *                 then "Last conversation: …" (the Due line counts from the conversation, never from the note)
 *   undelivered   "No conversation is recorded. The last text (Nov 10) was not delivered."   (after an older
 *   failed_dial    conversation: that conversation, then "The text after it (Mon) was not delivered.")
 *   touch_only    "No conversation is recorded for the contact counted Nov 10."
 *   imported      "Imported history only (latest entry Nov 1). No conversation in Realty OS yet."
 *   never         a note when there is one; otherwise NOTHING on a quiet row (its Due line already says "no
 *                 conversation yet": one sentence, not two) and "No conversation yet." on any other card
 *
 * Null: the card shows no Last line. Without a story (an older server's answer) it is the last touch as before, and a
 * quiet row with none says nothing rather than risk the contradiction.
 */
export function lastLine(c: Pick<FeedCard, 'itemType' | 'lastTouch' | 'lastConversation' | 'quiet' | 'importedHistoryAt'>, nowMs: number): string | null {
  const quietRow = c.itemType === 'warm_follow_up';
  const said = c.lastTouch ? lastTouchLine(c.lastTouch, nowMs) : null;
  const q = c.quiet;
  if (!q) return said ?? (quietRow ? null : lastTouchLine(null, nowMs, c.importedHistoryAt));
  // a note is the newest thing said about the person; the conversation the clock counts from follows it
  const told = said !== null && c.lastConversation ? `${stop(said)} Last conversation: ${lastTouchLine(c.lastConversation, nowMs)}` : said;
  const when = q.at ? whenWords(q.at, nowMs) : '';
  switch (q.basis) {
    case 'contact':
      return told;
    case 'undelivered':
    case 'failed_dial': {
      const what = q.attempt?.kind ?? (q.basis === 'failed_dial' ? 'call' : 'text');
      const failed = q.basis === 'failed_dial' ? 'did not connect' : 'was not delivered';
      return told ? `${stop(told)} The ${what} after it (${when}) ${failed}.` : `No conversation is recorded. The last ${what} (${when}) ${failed}.`;
    }
    case 'touch_only':
      return told ? `${stop(told)} Nothing is recorded for the later contact counted ${when}.` : `No conversation is recorded for the contact counted ${when}.`;
    case 'imported':
      return `${told ? `${stop(told)} ` : ''}Imported history only (latest entry ${when}). No conversation in Realty OS yet.`;
    case 'never':
      return told ?? (quietRow ? null : NO_CONVERSATION_YET);
  }
}

const AUTOMATIC: Record<string, string> = { text: 'text', email: 'email', chat: 'chat reply' };

/** "Automatic text sent Tue": its own line, never the last thing discussed. Its text is never shown here. */
export function automaticLine(a: LastAutomaticView, nowMs: number): string {
  return `${a.bulk ? 'Bulk' : 'Automatic'} ${AUTOMATIC[a.kind] ?? 'message'} sent ${whenWords(a.at, nowMs)}`;
}

/** "Send lender intro, today 5:00 PM": the task as it was written, then when. */
export function nextPromiseLine(p: NextPromiseView | null | undefined, nowMs: number): string {
  if (!p) return NO_NEXT_STEP;
  if (p.dueAt === null) return `${p.text}, no date set`;
  // R-TODAY-19: an all-day task is a day in its own zone; a timed task is an instant, said in the viewer's own time
  const when = p.dueAllDay ? allDayWords(p.dueAt, p.dueZone, nowMs) : whenWords(p.dueAt, nowMs, { time: true });
  return `${p.text}, ${p.overdue ? `overdue since ${when}` : when}`;
}
