// R-TODAY-1 / R-TODAY-4 (web): the words of a follow-up card's "Last" and "Next" lines, and of a logged outside
// call wherever it is shown. Written against local dates, so they hold under any TZ the suite runs in.
import { describe, expect, it } from 'vitest';
import { NO_CONVERSATION_YET, allDayWords, automaticLine, lastLine, lastTouchLine, loggedWords, nextPromiseLine, whenWords } from './followUp.js';
import type { LastTouchView, NextPromiseView } from './types.js';

// Thursday Nov 19 2026, 10:00 local
const NOW = new Date(2026, 10, 19, 10, 0, 0).getTime();
const local = (d: number, h = 14, m = 10) => new Date(2026, 10, d, h, m, 0).toISOString();

const touch = (o: Partial<LastTouchView> = {}): LastTouchView => ({ kind: 'call', at: local(17), byName: 'Avery Brooks', byMe: true, direction: 'outbound', outcome: 'talked 6 min', snippet: null, reported: false, ...o });

describe('when', () => {
  it('today with the time, yesterday, a weekday within the week, then the date', () => {
    expect(whenWords(local(19, 9, 5), NOW)).toBe('today 9:05 AM');
    expect(whenWords(local(18), NOW)).toBe('yesterday');
    expect(whenWords(local(17), NOW)).toBe('Tue');
    expect(whenWords(local(13), NOW)).toBe('Fri');
    expect(whenWords(local(12), NOW)).toBe('Nov 12');
    expect(whenWords(new Date(2025, 10, 12, 9).toISOString(), NOW)).toBe('Nov 12, 2025');
  });
  it('with the time asked for: "Tue 2:10 PM"', () => {
    expect(whenWords(local(17), NOW, { time: true })).toBe('Tue 2:10 PM');
    expect(whenWords(local(18), NOW, { time: true })).toBe('yesterday 2:10 PM');
  });
  it('a time ahead: "tomorrow 9:00 AM", a weekday, then the date', () => {
    expect(whenWords(local(19, 17, 0), NOW)).toBe('today 5:00 PM');
    expect(whenWords(local(20, 9, 0), NOW, { time: true })).toBe('tomorrow 9:00 AM');
    expect(whenWords(local(23, 9, 0), NOW, { time: true })).toBe('Mon 9:00 AM');
    expect(whenWords(local(30, 9, 0), NOW, { time: true })).toBe('Nov 30, 9:00 AM');
  });
});

describe('the Last line', () => {
  const CASES: [string, Partial<LastTouchView>, string][] = [
    ['a call the app placed', {}, 'Call Tue, talked 6 min'],
    ['a teammate’s call', { byMe: false }, 'Call Tue by Avery Brooks, talked 6 min'],
    ['a call with nothing recorded', { outcome: null }, 'Call Tue'],
    ['their call, answered', { direction: 'inbound', byName: null, byMe: false, outcome: 'talked under a minute' }, 'They called Tue, talked under a minute'],
    ['a text with what was said', { kind: 'text', outcome: null, snippet: 'Sending the lender intro tonight.' }, 'Text Tue: “Sending the lender intro tonight.”'],
    ['their text', { kind: 'text', direction: 'inbound', byName: null, byMe: false, outcome: null, snippet: 'Can we see it Saturday?' }, 'They texted Tue: “Can we see it Saturday?”'],
    ['their email', { kind: 'email', direction: 'inbound', byName: null, byMe: false, outcome: null }, 'They emailed Tue'],
    ['an email', { kind: 'email', outcome: null, byMe: false }, 'Email Tue by Avery Brooks'],
    ['the website chat', { kind: 'chat', direction: 'inbound', byName: null, byMe: false, outcome: null }, 'They wrote in the website chat Tue'],
    ['a note', { kind: 'note', direction: null, outcome: null, snippet: 'Wants 3 beds near the park.' }, 'Note Tue: “Wants 3 beds near the park.”'],
    ['an appointment', { kind: 'appointment', direction: null, outcome: 'follow-up needed' }, 'Appointment Tue, follow-up needed'],
  ];
  it.each(CASES)('%s', (_n, over, want) => {
    expect(lastTouchLine(touch(over), NOW)).toBe(want);
  });

  it('no last touch: "No conversation yet."', () => {
    expect(NO_CONVERSATION_YET).toBe('No conversation yet.');
    expect(lastTouchLine(null, NOW)).toBe('No conversation yet.');
  });
  it('E845: no last touch here, but history was imported: says so, and never calls it a conversation', () => {
    expect(lastTouchLine(null, NOW, local(12))).toBe('No conversation yet in Realty OS. Earlier history was imported (latest entry Nov 12).');
  });
});

describe('R-TODAY-4: a logged outside call is labelled as the agent’s own report', () => {
  it('the brief’s line: "Logged by you: called from your phone, left a voicemail (Wed 2:10 PM)"', () => {
    expect(lastTouchLine(touch({ reported: true, outcome: 'left a voicemail', at: local(18) }), new Date(2026, 10, 20, 10).getTime())).toBe('Logged by you: called from your phone, left a voicemail (Wed 2:10 PM)');
  });
  const LOGGED: [string, Parameters<typeof loggedWords>[0], string][] = [
    ['my outbound call', { kind: 'call', direction: 'outbound', outcome: 'talked', byName: 'Avery Brooks', byMe: true }, 'Logged by you: called from your phone, talked'],
    ['a teammate’s outbound call', { kind: 'call', direction: 'outbound', outcome: 'no answer', byName: 'Avery Brooks', byMe: false }, 'Logged by Avery Brooks: called from their phone, no answer'],
    ['their call to my phone', { kind: 'call', direction: 'inbound', outcome: null, byName: 'Avery Brooks', byMe: true }, 'Logged by you: they called your phone'],
    ['a text from my phone', { kind: 'text', direction: 'outbound', outcome: null, byName: 'Avery Brooks', byMe: true }, 'Logged by you: texted from your phone'],
    ['their text to a teammate', { kind: 'text', direction: 'inbound', outcome: null, byName: 'Avery Brooks', byMe: false }, 'Logged by Avery Brooks: they texted their phone'],
    ['an email outside the app', { kind: 'email', direction: 'outbound', outcome: null, byName: 'Avery Brooks', byMe: true }, 'Logged by you: emailed from outside Realty OS'],
    ['their email outside the app', { kind: 'email', direction: 'inbound', outcome: null, byName: null, byMe: false }, 'Logged by a teammate: they emailed outside Realty OS'],
  ];
  it.each(LOGGED)('%s', (_n, a, want) => {
    expect(loggedWords(a)).toBe(want);
  });
  it('every logged line starts with "Logged by": none can read as a call the system placed', () => {
    for (const [, a] of LOGGED) expect(loggedWords(a)).toMatch(/^Logged by /);
    expect(lastTouchLine(touch({ reported: true, snippet: 'Will try Friday.' }), NOW)).toBe('Logged by you: called from your phone, talked 6 min (Tue 2:10 PM): “Will try Friday.”');
  });
});

describe('the automatic line is its own line', () => {
  it('"Automatic text sent Tue", "Automatic email sent yesterday", and a bulk send says bulk', () => {
    expect(automaticLine({ kind: 'text', at: local(17), bulk: false }, NOW)).toBe('Automatic text sent Tue');
    expect(automaticLine({ kind: 'email', at: local(18), bulk: false }, NOW)).toBe('Automatic email sent yesterday');
    expect(automaticLine({ kind: 'chat', at: local(17), bulk: false }, NOW)).toBe('Automatic chat reply sent Tue');
    expect(automaticLine({ kind: 'email', at: local(17), bulk: true }, NOW)).toBe('Bulk email sent Tue');
  });
});

describe('the Next line', () => {
  const p = (o: Partial<NextPromiseView> = {}): NextPromiseView => ({ taskId: 't1', text: 'Send lender intro', kind: 'promise', dueAt: local(19, 17, 0), dueAllDay: false, overdue: false, ...o });
  it('the task as written, then when: "Send lender intro, today 5:00 PM"', () => {
    expect(nextPromiseLine(p(), NOW)).toBe('Send lender intro, today 5:00 PM');
    expect(nextPromiseLine(p({ dueAt: local(20, 9, 0) }), NOW)).toBe('Send lender intro, tomorrow 9:00 AM');
  });
  it('an all-day task has no time; an overdue one says overdue; no date says so', () => {
    expect(nextPromiseLine(p({ dueAllDay: true, dueAt: new Date(2026, 10, 19).toISOString() }), NOW)).toBe('Send lender intro, today');
    expect(nextPromiseLine(p({ overdue: true, dueAt: local(17, 9, 0) }), NOW)).toBe('Send lender intro, overdue since Tue 9:00 AM');
    expect(nextPromiseLine(p({ dueAt: null }), NOW)).toBe('Send lender intro, no date set');
  });
  it('nothing next: "No next step set."', () => {
    expect(nextPromiseLine(null, NOW)).toBe('No next step set.');
  });
});

// b19 Today fix 1 (M5; R-TODAY-14): the Last line is worded from the SAME story as the Due line (the server's
// `quiet`), so the two can never disagree. The truth table, by evidence; the Due sentences are the server's
// (packages/core quietStory.test.ts and apps/api followUpTruthTable.test.ts test the same table from their side).
describe('R-TODAY-14: lastLine, the Last line of the truth table', () => {
  const D10 = local(10); // Tue Nov 10
  type C = Parameters<typeof lastLine>[0];
  const warm = (o: Partial<C>): C => ({ itemType: 'warm_follow_up', lastTouch: null, lastConversation: null, importedHistoryAt: null, quiet: null, ...o });
  const task = (o: Partial<C>): C => ({ ...warm(o), itemType: 'task_due' });
  const q = (basis: NonNullable<C['quiet']>['basis'], at: string | null, attempt: NonNullable<C['quiet']>['attempt'] = null) => ({ basis, at, attempt });
  const call = touch({ at: local(10), outcome: 'talked 6 min' });
  const logged = touch({ at: local(10), outcome: 'talked', reported: true });
  const reply = touch({ kind: 'text', at: local(11), direction: 'inbound', byName: null, byMe: false, outcome: null, snippet: 'Can we see it Saturday?' });
  const note = touch({ kind: 'note', at: local(19, 9, 5), direction: null, outcome: null, snippet: 'Ask about the school district.' });

  // evidence, the server's Due line for a Connected person, the card's facts, the Last line on a quiet row, and on any other follow-up card
  const TABLE: [string, string, Partial<C>, string | null, string][] = [
    ['none', 'Connected: no conversation yet', { quiet: q('never', null) }, null, 'No conversation yet.'],
    ['automated only', 'Connected: no conversation yet', { quiet: q('never', null) }, null, 'No conversation yet.'],
    ['bulk only', 'Connected: no conversation yet', { quiet: q('never', null) }, null, 'No conversation yet.'],
    ['an undelivered attempt', 'Connected, but the last text was not delivered', { quiet: q('undelivered', D10, { kind: 'text', at: D10, what: 'undelivered' }) }, 'No conversation is recorded. The last text (Nov 10) was not delivered.', 'No conversation is recorded. The last text (Nov 10) was not delivered.'],
    ['a failed dial', 'Connected, but the last call did not connect', { quiet: q('failed_dial', D10, { kind: 'call', at: D10, what: 'failed_dial' }) }, 'No conversation is recorded. The last call (Nov 10) did not connect.', 'No conversation is recorded. The last call (Nov 10) did not connect.'],
    ['a logged outside call', 'Connected: no conversation for 9 days', { quiet: q('contact', D10), lastTouch: logged }, 'Logged by you: called from your phone, talked (Nov 10, 2:10 PM)', 'Logged by you: called from your phone, talked (Nov 10, 2:10 PM)'],
    ['a verified call', 'Connected: no conversation for 9 days', { quiet: q('contact', D10), lastTouch: call }, 'Call Nov 10, talked 6 min', 'Call Nov 10, talked 6 min'],
    ['their reply', 'Connected: no conversation for 8 days', { quiet: q('contact', local(11)), lastTouch: reply }, 'They texted Nov 11: “Can we see it Saturday?”', 'They texted Nov 11: “Can we see it Saturday?”'],
    ['imported only', 'Connected: only imported history, the latest 40 days ago', { quiet: q('imported', local(1)), importedHistoryAt: local(1) }, 'Imported history only (latest entry Nov 1). No conversation in Realty OS yet.', 'Imported history only (latest entry Nov 1). No conversation in Realty OS yet.'],
    ['a touch on record with nothing readable', 'Connected: no conversation for 9 days', { quiet: q('touch_only', D10) }, 'No conversation is recorded for the contact counted Nov 10.', 'No conversation is recorded for the contact counted Nov 10.'],
    ['a conversation, then an undelivered text', 'Connected, but the last text was not delivered', { quiet: q('undelivered', local(16), { kind: 'text', at: local(16), what: 'undelivered' }), lastTouch: call }, 'Call Nov 10, talked 6 min. The text after it (Mon) was not delivered.', 'Call Nov 10, talked 6 min. The text after it (Mon) was not delivered.'],
    ['a conversation, then a touch with nothing readable', 'Connected: no conversation for 3 days', { quiet: q('touch_only', local(16)), lastTouch: call }, 'Call Nov 10, talked 6 min. Nothing is recorded for the later contact counted Mon.', 'Call Nov 10, talked 6 min. Nothing is recorded for the later contact counted Mon.'],
    ['a note on top of a conversation', 'Connected: no conversation for 9 days', { quiet: q('contact', D10), lastTouch: note, lastConversation: call }, 'Note today 9:05 AM: “Ask about the school district.” Last conversation: Call Nov 10, talked 6 min', 'Note today 9:05 AM: “Ask about the school district.” Last conversation: Call Nov 10, talked 6 min'],
    ['only a note', 'Connected: no conversation yet', { quiet: q('never', null), lastTouch: note }, 'Note today 9:05 AM: “Ask about the school district.”', 'Note today 9:05 AM: “Ask about the school district.”'],
  ];
  it.each(TABLE)('%s', (_n, _due, facts, onQuietRow, onOtherCard) => {
    expect(lastLine(warm(facts), NOW)).toBe(onQuietRow);
    expect(lastLine(task(facts), NOW)).toBe(onOtherCard);
  });

  it('no row of the table can read "no conversation yet" under a Due line that counts days, nor say the same sentence twice', () => {
    for (const [name, due, facts, onQuietRow] of TABLE) {
      if (/\d+ days?/.test(due)) expect(onQuietRow ?? '', name).not.toMatch(/No conversation yet/i);
      if (/no conversation yet/.test(due)) expect(onQuietRow ?? '', name).not.toMatch(/No conversation yet\.$/);
      // one instant: a line that counts days from a conversation names something dated at the story's instant
      if (facts.quiet?.basis === 'contact') expect((facts.lastConversation ?? facts.lastTouch)!.at, name).toBe(facts.quiet.at);
    }
  });

  it('an older server’s answer (no story): a quiet row with no last touch says nothing rather than "No conversation yet." under a day count; other cards say it as before', () => {
    expect(lastLine({ itemType: 'warm_follow_up', lastTouch: null }, NOW)).toBeNull();
    expect(lastLine({ itemType: 'task_due', lastTouch: null }, NOW)).toBe('No conversation yet.');
    expect(lastLine({ itemType: 'task_due', lastTouch: null, importedHistoryAt: local(12) }, NOW)).toBe('No conversation yet in Realty OS. Earlier history was imported (latest entry Nov 12).');
    expect(lastLine({ itemType: 'warm_follow_up', lastTouch: call }, NOW)).toBe('Call Nov 10, talked 6 min');
  });
});

// b19 Today fix 6 (M10; R-TODAY-19): an all-day task is a DAY in its own zone (the task's, else the team's), not an
// instant in the viewer's. The server sends the zone; the day is worded in that zone, whatever zone the viewer's
// device is in. (These hold under any TZ the suite runs in: nothing here reads the device's zone.)
describe('M10 (R-TODAY-19): an all-day task is said in its own zone', () => {
  // an all-day task due Thursday Nov 19 2026 in each zone: its stored instant is the start of that local day
  const ZONES: [string, string, number][] = [
    ['America/Los_Angeles', '2026-11-19T08:00:00.000Z', -8],
    ['America/New_York', '2026-11-19T05:00:00.000Z', -5],
    ['Asia/Tokyo', '2026-11-18T15:00:00.000Z', 9],
    ['Pacific/Auckland', '2026-11-18T11:00:00.000Z', 13],
  ];
  /** an instant given as a wall-clock time of November 2026 in a zone `offset` hours from UTC */
  const wall = (offset: number, day: number, h: number, m = 0) => Date.UTC(2026, 10, day, h - offset, m);
  const allDay = (dueAt: string, dueZone: string, overdue = false): NextPromiseView => ({ taskId: 't1', text: 'Send lender intro', kind: 'promise', dueAt, dueAllDay: true, dueZone, overdue });

  it.each(ZONES)('%s: at noon on its day it is "today"', (zone, dueAt, off) => {
    expect(nextPromiseLine(allDay(dueAt, zone), wall(off, 19, 12))).toBe('Send lender intro, today');
  });
  it.each(ZONES)('%s: at 11:30 PM on its day it is still "today"; at 12:30 AM the next day it is "overdue since yesterday"', (zone, dueAt, off) => {
    expect(nextPromiseLine(allDay(dueAt, zone), wall(off, 19, 23, 30))).toBe('Send lender intro, today');
    expect(nextPromiseLine(allDay(dueAt, zone, true), wall(off, 20, 0, 30))).toBe('Send lender intro, overdue since yesterday');
  });
  it.each(ZONES)('%s: at 11:30 PM the evening before it is "tomorrow"; a week before, its date', (zone, dueAt, off) => {
    expect(nextPromiseLine(allDay(dueAt, zone), wall(off, 18, 23, 30))).toBe('Send lender intro, tomorrow');
    expect(nextPromiseLine(allDay(dueAt, zone), wall(off, 17, 9))).toBe('Send lender intro, Thu');
    expect(nextPromiseLine(allDay(dueAt, zone), wall(off, 10, 9))).toBe('Send lender intro, Nov 19');
  });
  it('W4 (the reviewer’s case): a New York task due today, read at noon New York time, is "today" for every viewer (it used to be "yesterday" in Los Angeles and Tokyo)', () => {
    const [zone, dueAt] = ZONES[1]!;
    const noonNY = Date.UTC(2026, 10, 19, 17, 0);
    expect(nextPromiseLine(allDay(dueAt, zone), noonNY)).toBe('Send lender intro, today');
    expect(allDayWords(dueAt, zone, noonNY)).toBe('today');
    // Friday 9 AM New York: overdue since yesterday, for every viewer
    expect(nextPromiseLine(allDay(dueAt, zone, true), Date.UTC(2026, 10, 20, 14, 0))).toBe('Send lender intro, overdue since yesterday');
  });
  it('a year boundary, and a zone the device does not know: the date keeps its year; an unknown zone falls back to the viewer’s own day', () => {
    expect(allDayWords('2025-12-31T05:00:00.000Z', 'America/New_York', Date.UTC(2026, 10, 19, 17, 0))).toBe('Dec 31, 2025');
    expect(allDayWords(new Date(NOW).toISOString(), 'Not/AZone', NOW)).toBe('today');
  });
  it('a timed task is still said in the viewer’s own time, with its time', () => {
    expect(nextPromiseLine({ taskId: 't1', text: 'Send lender intro', kind: 'promise', dueAt: local(19, 17, 0), dueAllDay: false, dueZone: null, overdue: false }, NOW)).toBe('Send lender intro, today 5:00 PM');
  });
});
