// The words of a follow-up card (batch 19, warm follow-up in Today; R-TODAY-1, R-TODAY-4): what was last discussed,
// the automatic line, the next promise, and how a call, text or email the agent LOGGED from outside the app is said
// wherever it is shown (the card, the person's notes, the timeline). One place, so the label cannot drift:
//
//   "Logged by you: called from your phone, left a voicemail (Wed 2:10 PM)"
//
// A logged activity always starts "Logged by …": it is the agent's own report and is never worded as a call the system
// placed or a message it sent. An automated message is never the "Last" line; it is said on its own line.
// Times are the viewer's own (the browser's zone), like every other time on the feed.
import type { LastAutomaticView, LastTouchView, NextPromiseView } from './types.js';

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

const AUTOMATIC: Record<string, string> = { text: 'text', email: 'email', chat: 'chat reply' };

/** "Automatic text sent Tue": its own line, never the last thing discussed. Its text is never shown here. */
export function automaticLine(a: LastAutomaticView, nowMs: number): string {
  return `${a.bulk ? 'Bulk' : 'Automatic'} ${AUTOMATIC[a.kind] ?? 'message'} sent ${whenWords(a.at, nowMs)}`;
}

/** "Send lender intro, today 5:00 PM": the task as it was written, then when. */
export function nextPromiseLine(p: NextPromiseView | null | undefined, nowMs: number): string {
  if (!p) return NO_NEXT_STEP;
  if (p.dueAt === null) return `${p.text}, no date set`;
  const when = p.dueAllDay ? whenWords(p.dueAt, nowMs).replace(/^today .*$/, 'today') : whenWords(p.dueAt, nowMs, { time: true });
  return `${p.text}, ${p.overdue ? `overdue since ${when}` : when}`;
}
