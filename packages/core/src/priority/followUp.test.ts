// R-TODAY-1 to R-TODAY-3 (batch 19, warm follow-up in Today): what a follow-up card says about the person.
// Table tests of the pure selection: the last HUMAN contact, the automatic line, the next promise.
import { describe, expect, it } from 'vitest';
import { DAY_MS, HOUR_MS, MINUTE_MS, at, zone } from '../foundation/index.js';
import { ACTIVITY_MAX_AHEAD_MS } from '../parity/people/index.js';
import {
  type ContactCandidate,
  FOLLOW_UP_ITEM_TYPES,
  LOGGED_AHEAD_MS,
  NO_CONVERSATION_YET,
  type PromiseTask,
  SNIPPET_MAX,
  classifyCandidate,
  isFollowUpItemType,
  selectLastContact,
  selectNextPromise,
  snippetOf,
} from './followUp.js';

const NOW = at('2026-11-19T15:00:00Z'); // Thu 10:00 in New York
const NY = zone('America/New_York');
const ago = (ms: number) => (NOW - ms) as typeof NOW;

const msg = (o: Partial<Extract<ContactCandidate, { source: 'message' }>> = {}): ContactCandidate => ({
  source: 'message',
  id: 'm1',
  at: ago(2 * DAY_MS),
  channel: 'sms',
  direction: 'outbound',
  initiator: 'human',
  imported: false,
  bulk: false,
  autoReply: false,
  status: 'delivered',
  byName: 'Avery Brooks',
  body: 'Sending the lender intro tonight.',
  ...o,
});
const call = (o: Partial<Extract<ContactCandidate, { source: 'call' }>> = {}): ContactCandidate => ({
  source: 'call',
  id: 'c1',
  at: ago(2 * DAY_MS),
  direction: 'outbound',
  initiator: 'human',
  imported: false,
  status: 'completed',
  answered: true,
  handledBy: 'human',
  outcome: 'connected',
  talkSeconds: 372,
  byName: 'Avery Brooks',
  ...o,
});
const note = (o: Partial<Extract<ContactCandidate, { source: 'note' }>> = {}): ContactCandidate => ({
  source: 'note',
  id: 'n1',
  at: ago(2 * DAY_MS),
  noteSource: 'manual',
  imported: false,
  activity: null,
  bodyIsDefault: false,
  byName: 'Avery Brooks',
  body: 'Wants 3 beds near the park, pre-approval next week.',
  ...o,
});
const appt = (o: Partial<Extract<ContactCandidate, { source: 'appointment' }>> = {}): ContactCandidate => ({
  source: 'appointment',
  id: 'a1',
  at: ago(2 * DAY_MS),
  status: 'held',
  outcome: 'follow_up',
  byName: 'Avery Brooks',
  ...o,
});

describe('R-TODAY-2: an automated message is never the last thing discussed', () => {
  const AUTOMATIC: [string, ContactCandidate][] = [
    ['a text the assistant sent', msg({ initiator: 'assistant' })],
    ['a text a plan sent (system)', msg({ initiator: 'system' })],
    ['an email a plan sent', msg({ initiator: 'system', channel: 'email' })],
    ['a bulk text a person started', msg({ bulk: true })],
    ['a bulk email the assistant started', msg({ bulk: true, initiator: 'assistant', channel: 'email' })],
    ['a website-chat reply the assistant sent', msg({ initiator: 'assistant', channel: 'web_chat' })],
  ];
  it.each(AUTOMATIC)('%s is automatic: never the last touch, and it is its own line', (_name, c) => {
    expect(classifyCandidate(c, NOW)).toBe('automatic');
    const r = selectLastContact([c], NOW);
    expect(r.lastTouch).toBeNull();
    expect(r.lastAutomatic).toMatchObject({ at: c.at });
  });

  it('the automatic line names the channel, and says bulk for a mass send', () => {
    expect(selectLastContact([msg({ initiator: 'system', channel: 'email' })], NOW).lastAutomatic).toEqual({ kind: 'email', at: ago(2 * DAY_MS), bulk: false });
    expect(selectLastContact([msg({ bulk: true })], NOW).lastAutomatic).toEqual({ kind: 'text', at: ago(2 * DAY_MS), bulk: true });
    expect(selectLastContact([msg({ initiator: 'assistant', channel: 'mms' })], NOW).lastAutomatic?.kind).toBe('text');
  });

  it('E841: a newer automatic text never replaces an older conversation: the call stays the last touch and the text is a separate line', () => {
    const r = selectLastContact([call({ at: ago(3 * DAY_MS) }), msg({ id: 'm2', initiator: 'system', at: ago(DAY_MS) })], NOW);
    expect(r.lastTouch).toMatchObject({ kind: 'call', at: ago(3 * DAY_MS) });
    expect(r.lastAutomatic).toEqual({ kind: 'text', at: ago(DAY_MS), bulk: false });
  });

  it('an automatic message older than the last conversation is not said at all', () => {
    const r = selectLastContact([call({ at: ago(DAY_MS) }), msg({ id: 'm2', initiator: 'system', at: ago(3 * DAY_MS) })], NOW);
    expect(r.lastTouch?.kind).toBe('call');
    expect(r.lastAutomatic).toBeNull();
  });

  it('whatever the order of the candidates, no automatic one is ever chosen (every permutation of a mixed set)', () => {
    const set = [msg({ id: 'a', initiator: 'assistant', at: ago(HOUR_MS) }), msg({ id: 'b', bulk: true, at: ago(2 * HOUR_MS) }), note({ at: ago(5 * DAY_MS) }), msg({ id: 'c', initiator: 'system', channel: 'email', at: ago(30 * MINUTE_MS) })];
    const perms = (xs: ContactCandidate[]): ContactCandidate[][] => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => perms([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
    for (const p of perms(set)) {
      const r = selectLastContact(p, NOW);
      expect(r.lastTouch).toMatchObject({ kind: 'note', at: ago(5 * DAY_MS) });
      expect(r.lastAutomatic).toEqual({ kind: 'email', at: ago(30 * MINUTE_MS), bulk: false });
    }
  });
});

describe('R-TODAY-1: the last human contact', () => {
  const HUMAN: [string, ContactCandidate, Record<string, unknown>][] = [
    ['a text the agent sent', msg(), { kind: 'text', direction: 'outbound', byName: 'Avery Brooks', outcome: null, snippet: 'Sending the lender intro tonight.', reported: false }],
    ['an email the agent sent', msg({ channel: 'email' }), { kind: 'email', direction: 'outbound' }],
    ['a text the client wrote', msg({ direction: 'inbound', initiator: 'client', status: 'received', byName: null, body: 'Can we see it Saturday?' }), { kind: 'text', direction: 'inbound', byName: null, snippet: 'Can we see it Saturday?' }],
    ['a reply in the website chat', msg({ channel: 'web_chat' }), { kind: 'chat' }],
    ['a call the app placed, talked', call(), { kind: 'call', direction: 'outbound', outcome: 'talked 6 min', snippet: null, reported: false }],
    ['a call the app placed, voicemail', call({ answered: false, outcome: 'left_voicemail', talkSeconds: null }), { kind: 'call', outcome: 'left a voicemail' }],
    ['a call the app placed that rang out, with no outcome logged', call({ status: 'no_answer', answered: false, outcome: null, talkSeconds: null }), { kind: 'call', outcome: null }],
    ['a call the app placed whose outcome the agent logged before the network reported back', call({ status: 'initiated', answered: false, outcome: 'no_answer', talkSeconds: null }), { kind: 'call', outcome: 'no answer' }],
    ['an inbound call a person picked up', call({ direction: 'inbound', initiator: 'client', outcome: null, talkSeconds: 40 }), { kind: 'call', direction: 'inbound', outcome: 'talked under a minute' }],
    ["the agent's own note", note(), { kind: 'note', direction: null, snippet: 'Wants 3 beds near the park, pre-approval next week.', reported: false }],
    ['a held appointment', appt(), { kind: 'appointment', outcome: 'follow-up needed', snippet: null }],
  ];
  it.each(HUMAN)('%s counts', (_name, c, want) => {
    expect(classifyCandidate(c, NOW)).toBe('human');
    expect(selectLastContact([c], NOW).lastTouch).toMatchObject({ at: c.at, ...want });
  });

  const NOT_A_CONTACT: [string, ContactCandidate][] = [
    ['a text still queued', msg({ status: 'queued' })],
    ['a text scheduled for later', msg({ status: 'scheduled' })],
    ['a text the gate blocked', msg({ status: 'blocked' })],
    ['a text that failed', msg({ status: 'failed' })],
    ['a text nobody could confirm', msg({ status: 'dispatch_unknown' })],
    ['an out-of-office auto-reply', msg({ direction: 'inbound', initiator: 'client', status: 'received', autoReply: true })],
    ['a call that never rang out (the dial failed, nothing was logged)', call({ status: 'failed', answered: false, outcome: null, talkSeconds: null })],
    ['a call still being dialed', call({ status: 'initiated', answered: false, outcome: null, talkSeconds: null })],
    ['a missed inbound call', call({ direction: 'inbound', initiator: 'client', answered: false, outcome: null })],
    ['an inbound call that went to voicemail', call({ direction: 'inbound', initiator: 'client', answered: true, handledBy: 'voicemail', outcome: null })],
    ['an inbound call the assistant answered', call({ direction: 'inbound', initiator: 'client', answered: true, handledBy: 'assistant', outcome: null })],
    ["the assistant's call summary", note({ noteSource: 'call_summary' })],
    ['an appointment still ahead', appt({ status: 'scheduled', at: (NOW + DAY_MS) as typeof NOW })],
    ['a canceled appointment', appt({ status: 'canceled' })],
    ['a no-show', appt({ status: 'no_show' })],
    ['a contact dated in the future', msg({ at: (NOW + HOUR_MS) as typeof NOW })],
  ];
  it.each(NOT_A_CONTACT)('%s is not a contact', (_name, c) => {
    expect(classifyCandidate(c, NOW)).toBe('none');
    expect(selectLastContact([c], NOW)).toEqual({ lastTouch: null, lastContact: null, lastContactAt: null, lastAutomatic: null, importedHistoryAt: null });
  });

  it('picks the most recent human contact of any kind; a tie goes to the same one whatever the order', () => {
    const a = msg({ id: 'm-a', at: ago(DAY_MS) });
    const b = call({ id: 'c-b', at: ago(DAY_MS) });
    const older = note({ at: ago(4 * DAY_MS) });
    expect(selectLastContact([older, a], NOW).lastTouch?.kind).toBe('text');
    const one = selectLastContact([a, b, older], NOW).lastTouch;
    const two = selectLastContact([older, b, a], NOW).lastTouch;
    expect(one).toEqual(two);
  });

  it('a person with no history: no last touch, and the words are "No conversation yet."', () => {
    expect(selectLastContact([], NOW)).toEqual({ lastTouch: null, lastContact: null, lastContactAt: null, lastAutomatic: null, importedHistoryAt: null });
    expect(NO_CONVERSATION_YET).toBe('No conversation yet.');
  });
});

describe('R-TODAY-4: an outside call is the agent’s own report', () => {
  it('a logged outside call is a contact, marked as reported, with the outcome in words and the note they typed', () => {
    const c = note({ noteSource: 'logged_activity', activity: { kind: 'call', direction: 'outbound', outcome: 'left_voicemail' }, body: 'Said I would try again Friday.' });
    expect(selectLastContact([c], NOW).lastTouch).toEqual({ kind: 'call', at: c.at, byName: 'Avery Brooks', byUserId: null, direction: 'outbound', outcome: 'left a voicemail', snippet: 'Said I would try again Friday.', reported: true });
    // the teammate's id is carried when the caller gives one, and never for the client's own message
    expect(selectLastContact([{ ...c, byUserId: 'u-1' }], NOW).lastTouch?.byUserId).toBe('u-1');
    expect(selectLastContact([msg({ direction: 'inbound', initiator: 'client', status: 'received', byUserId: 'u-1' })], NOW).lastTouch?.byUserId).toBeNull();
  });
  it('the body the system wrote for an empty log ("Outbound call: left a voicemail") is not shown as their note', () => {
    const c = note({ noteSource: 'logged_activity', activity: { kind: 'call', direction: 'outbound', outcome: 'left_voicemail' }, body: 'Outbound call: left a voicemail', bodyIsDefault: true });
    expect(selectLastContact([c], NOW).lastTouch).toMatchObject({ kind: 'call', reported: true, snippet: null });
  });
  it('a logged text or email keeps its kind; "talked" for a logged conversation; nothing a system call would say (no duration)', () => {
    expect(selectLastContact([note({ noteSource: 'logged_activity', activity: { kind: 'text', direction: 'inbound', outcome: null } })], NOW).lastTouch).toMatchObject({ kind: 'text', direction: 'inbound', reported: true, outcome: null });
    expect(selectLastContact([note({ noteSource: 'logged_activity', activity: { kind: 'call', direction: 'outbound', outcome: 'connected' } })], NOW).lastTouch).toMatchObject({ outcome: 'talked', reported: true });
  });
  it('a call the system placed is never marked as reported', () => {
    expect(selectLastContact([call()], NOW).lastTouch?.reported).toBe(false);
  });
});

describe('E845: imported history is neither a conversation here nor an automatic message', () => {
  const IMPORTED: [string, ContactCandidate][] = [
    ['an imported text', msg({ imported: true, initiator: 'import' })],
    ['an imported call', call({ imported: true, initiator: 'import' })],
    ['an imported note', note({ imported: true, noteSource: 'import' })],
  ];
  it.each(IMPORTED)('%s: no last touch, no automatic line, and the card can say earlier history was imported', (_n, c) => {
    expect(classifyCandidate(c, NOW)).toBe('imported');
    expect(selectLastContact([c], NOW)).toEqual({ lastTouch: null, lastContact: null, lastContactAt: null, lastAutomatic: null, importedHistoryAt: c.at });
  });
  it('the latest imported entry is the one dated', () => {
    expect(selectLastContact([note({ imported: true, noteSource: 'import', at: ago(9 * DAY_MS) }), msg({ imported: true, initiator: 'import', at: ago(4 * DAY_MS) })], NOW).importedHistoryAt).toBe(ago(4 * DAY_MS));
  });
});

describe('R-TODAY-1: the snippet', () => {
  it('is at most about 140 characters, cut on a word, with an ellipsis; white space is collapsed', () => {
    expect(SNIPPET_MAX).toBe(140);
    const long = `${'word '.repeat(60)}end`;
    const s = snippetOf(long)!;
    expect(s.length).toBeLessThanOrEqual(140);
    expect(s.endsWith('…')).toBe(true);
    expect(snippetOf('  two\n\nlines \t here ')).toBe('two lines here');
  });
  it('is null for nothing to show', () => {
    expect(snippetOf(null)).toBeNull();
    expect(snippetOf('   ')).toBeNull();
  });
  it('a redaction placeholder the API put in the text stays whole or is cut, never undone', () => {
    const body = `Liked “Sign in here: https://example.test/portal#token=[sign-in token removed]” ${'and more '.repeat(30)}`;
    const s = snippetOf(body)!;
    expect(s).toContain('[sign-in token removed]');
    expect(s.length).toBeLessThanOrEqual(140);
  });
});

describe('R-TODAY-3: the next promise', () => {
  const task = (o: Partial<PromiseTask> = {}): PromiseTask => ({ taskId: 't1', title: 'Send lender intro', kind: 'promise', dueAt: (NOW + 7 * HOUR_MS) as typeof NOW, dueAllDay: false, dueTz: null, createdAt: ago(DAY_MS), ...o });

  it('is the earliest open task for the person, worded as it was written', () => {
    const r = selectNextPromise([task({ taskId: 't2', title: 'Call about the inspection', dueAt: (NOW + 2 * DAY_MS) as typeof NOW }), task()], NOW, NY);
    expect(r).toEqual({ taskId: 't1', text: 'Send lender intro', kind: 'promise', dueAt: NOW + 7 * HOUR_MS, dueAllDay: false, dueZone: null, deadline: NOW + 7 * HOUR_MS, overdue: false });
  });
  it('null when there is none', () => {
    expect(selectNextPromise([], NOW, NY)).toBeNull();
  });
  it('an undated promise comes after every dated one, and is never overdue', () => {
    const undated = task({ taskId: 't0', dueAt: null });
    expect(selectNextPromise([undated, task()], NOW, NY)?.taskId).toBe('t1');
    expect(selectNextPromise([undated], NOW, NY)).toMatchObject({ taskId: 't0', dueAt: null, overdue: false });
  });
  it('a timed task is overdue from its instant', () => {
    expect(selectNextPromise([task({ dueAt: ago(MINUTE_MS) })], NOW, NY)?.overdue).toBe(true);
    expect(selectNextPromise([task({ dueAt: (NOW + MINUTE_MS) as typeof NOW })], NOW, NY)?.overdue).toBe(false);
  });
  it('E844: overdue is computed in the team’s time zone: an all-day task due "today" in New York is not overdue at 11:30 PM there, though the UTC date has changed', () => {
    const dueDay = at('2026-11-19T05:00:00Z'); // Thu 00:00 in New York
    const allDay = task({ dueAt: dueDay, dueAllDay: true, dueTz: null });
    const lateThu = at('2026-11-20T04:30:00Z'); // Thu 11:30 PM in New York; already Friday in UTC
    const earlyFri = at('2026-11-20T05:30:00Z'); // Fri 12:30 AM in New York
    expect(selectNextPromise([allDay], lateThu, NY)?.overdue).toBe(false);
    expect(selectNextPromise([allDay], earlyFri, NY)?.overdue).toBe(true);
    // a team further west: its Thursday ends three hours later, so its own all-day Thursday task is still on time then
    const dueDayLa = task({ dueAt: at('2026-11-19T08:00:00Z'), dueAllDay: true, dueTz: null }); // Thu 00:00 in Los Angeles
    expect(selectNextPromise([dueDayLa], earlyFri, zone('America/Los_Angeles'))?.overdue).toBe(false);
    expect(selectNextPromise([dueDayLa], at('2026-11-20T08:00:00Z'), zone('America/Los_Angeles'))?.overdue).toBe(true);
  });
  it('a tie on the deadline goes to the older task, then the id', () => {
    const a = task({ taskId: 'b', createdAt: ago(2 * DAY_MS) });
    const b = task({ taskId: 'a', createdAt: ago(DAY_MS) });
    expect(selectNextPromise([b, a], NOW, NY)?.taskId).toBe('b');
  });
});

describe('R-TODAY-1: which cards are follow-up cards', () => {
  it('first contact due, reply waiting, promise due, task due, re-inquiry and the warm follow-up, and nothing whose detail the viewer may not open', () => {
    for (const t of ['first_touch_due', 'unanswered_inbound', 'missed_call', 'promise_due', 'task_due', 'reinquiry', 'warm_follow_up']) expect(isFollowUpItemType(t)).toBe(true);
    for (const t of ['lead_offer', 'pond_new', 'deal_date', 'weekly_plan', 'coaching_fix']) expect(isFollowUpItemType(t)).toBe(false);
    expect(new Set(FOLLOW_UP_ITEM_TYPES).size).toBe(FOLLOW_UP_ITEM_TYPES.length);
  });
});

// b19 Today fix 1 (M6; R-TODAY-12): the quiet clock counts CONTACT with the person. A manual note is somebody's own
// words about the person (a Team Lead's housekeeping note, the agent's reminder to themselves): it may be the Last
// line, labelled as a note, but it is never contact.
describe('R-TODAY-12: the latest human CONTACT (the quiet clock); a manual note is never one', () => {
  it('a manual note is the Last line and no contact at all', () => {
    const r = selectLastContact([note({ at: ago(HOUR_MS) })], NOW);
    expect(r.lastTouch).toMatchObject({ kind: 'note' });
    expect(r.lastContactAt).toBeNull();
    expect(r.lastContact).toBeNull();
  });
  it('a note written after a call: the note is the Last line, the call is still the latest contact', () => {
    const r = selectLastContact([note({ id: 'n2', at: ago(HOUR_MS), byName: 'Tess Lead', body: 'Updated the address on file.' }), call({ at: ago(12 * DAY_MS) })], NOW);
    expect(r.lastTouch).toMatchObject({ kind: 'note', snippet: 'Updated the address on file.' });
    expect(r.lastContactAt).toBe(ago(12 * DAY_MS));
    expect(r.lastContact).toMatchObject({ kind: 'call', at: ago(12 * DAY_MS) });
  });
  const CONTACT: [string, ContactCandidate][] = [
    ['a text the agent sent', msg()],
    ['their reply', msg({ direction: 'inbound', initiator: 'client', status: 'received', byName: null })],
    ['a call the app placed', call()],
    ['a held appointment', appt()],
    ['a call the agent LOGGED from outside the app (their own report: the brief decided it counts)', note({ noteSource: 'logged_activity', activity: { kind: 'call', direction: 'outbound', outcome: 'left_voicemail' }, bodyIsDefault: true })],
    ['a logged text', note({ noteSource: 'logged_activity', activity: { kind: 'text', direction: 'outbound', outcome: null } })],
  ];
  it.each(CONTACT)('%s is contact', (_n, c) => {
    expect(selectLastContact([c], NOW).lastContactAt).toBe(c.at);
  });
  it('an automated message, imported history and a failed send are not contact either', () => {
    expect(selectLastContact([msg({ initiator: 'system' }), msg({ id: 'm2', imported: true, initiator: 'import' }), msg({ id: 'm3', status: 'failed' })], NOW).lastContactAt).toBeNull();
  });
});

// b19 Today fix 6 (M10; R-TODAY-19): an all-day task's day belongs to a zone, and the answer says which
describe('R-TODAY-19: the zone of an all-day task', () => {
  const allDay = (dueTz: string | null): PromiseTask => ({ taskId: 't1', title: 'Send lender intro', kind: 'promise', dueAt: at('2026-11-19T05:00:00Z'), dueAllDay: true, dueTz: dueTz === null ? null : zone(dueTz), createdAt: ago(DAY_MS) });
  it('is the task’s own zone when it has one, else the team’s; a timed or undated task has none', () => {
    expect(selectNextPromise([allDay(null)], NOW, NY)).toMatchObject({ dueAllDay: true, dueZone: 'America/New_York' });
    expect(selectNextPromise([allDay('Pacific/Auckland')], NOW, NY)).toMatchObject({ dueZone: 'Pacific/Auckland' });
    expect(selectNextPromise([{ ...allDay(null), dueAllDay: false }], NOW, NY)).toMatchObject({ dueZone: null });
    expect(selectNextPromise([{ ...allDay(null), dueAt: null }], NOW, NY)).toMatchObject({ dueZone: null });
  });
  it('is the zone `overdue` and the deadline were decided in', () => {
    // due Thursday in Auckland: by Thursday 10:00 in New York (Friday 4:00 AM in Auckland) its day is over
    const r = selectNextPromise([{ ...allDay('Pacific/Auckland'), dueAt: at('2026-11-18T11:00:00Z') }], NOW, NY)!;
    expect(r).toMatchObject({ dueZone: 'Pacific/Auckland', deadline: at('2026-11-19T11:00:00Z'), overdue: true });
  });
});

// b19 Today fix 7 (L17; R-TODAY-20): the log route accepts an activity dated up to 5 minutes ahead (the agent's clock
// may run ahead of the server's). Such a log used to be ignored until its time passed: the row said nothing had
// happened. It is shown at once.
describe('L17 (R-TODAY-20): a log dated up to 5 minutes ahead is shown immediately', () => {
  const loggedAt = (ms: number) => note({ id: 'ahead', at: (NOW + ms) as typeof NOW, noteSource: 'logged_activity', activity: { kind: 'call', direction: 'outbound', outcome: 'connected' }, bodyIsDefault: true });
  it('the slack is the log route’s own', () => {
    expect(LOGGED_AHEAD_MS).toBe(ACTIVITY_MAX_AHEAD_MS);
  });
  it('E891: a logged call dated 4 minutes ahead is the last touch and the latest contact now', () => {
    const r = selectLastContact([loggedAt(4 * MINUTE_MS), call({ at: ago(3 * DAY_MS) })], NOW);
    expect(r.lastTouch).toMatchObject({ kind: 'call', reported: true, outcome: 'talked', at: NOW + 4 * MINUTE_MS });
    expect(r.lastContactAt).toBe(NOW + 4 * MINUTE_MS);
  });
  it('exactly 5 minutes ahead counts; a moment more does not (the route would have refused it)', () => {
    expect(classifyCandidate(loggedAt(5 * MINUTE_MS), NOW)).toBe('human');
    expect(classifyCandidate(loggedAt(5 * MINUTE_MS + 1), NOW)).toBe('none');
  });
  it('only a LOGGED activity has the slack: a message, a call the system placed, a note or an appointment dated ahead is still not a contact', () => {
    for (const c of [msg({ at: (NOW + MINUTE_MS) as typeof NOW }), call({ at: (NOW + MINUTE_MS) as typeof NOW }), note({ at: (NOW + MINUTE_MS) as typeof NOW }), appt({ at: (NOW + MINUTE_MS) as typeof NOW })]) expect(classifyCandidate(c, NOW)).toBe('none');
  });
});
