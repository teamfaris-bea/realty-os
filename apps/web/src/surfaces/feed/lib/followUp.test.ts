// R-TODAY-1 / R-TODAY-4 (web): the words of a follow-up card's "Last" and "Next" lines, and of a logged outside
// call wherever it is shown. Written against local dates, so they hold under any TZ the suite runs in.
import { describe, expect, it } from 'vitest';
import { NO_CONVERSATION_YET, automaticLine, lastTouchLine, loggedWords, nextPromiseLine, whenWords } from './followUp.js';
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
