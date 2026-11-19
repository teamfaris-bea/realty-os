// The team work queue (b19 team-queue lane; DATA_MODEL R-TEAMQ-1..5, E820..E826): grouping, the "why" sentence of
// every row, who owns it, and the time since arrival in staffed and wall-clock time. Pure and table-tested.
import { describe, expect, it } from 'vitest';
import { type Instant, at, businessCalendar } from '../foundation/index.js';
import {
  TEAM_QUEUE_GROUPS,
  TEAM_QUEUE_GROUP_CAP,
  TEAM_QUEUE_NEW_LEAD_WINDOW_MS,
  type QueueHolder,
  type QueueInquiryFacts,
  type TeamQueueInputs,
  buildTeamQueue,
  holderLabel,
  measureFromArrival,
  queueHolder,
} from './index.js';
import { NOW, NY, appt, apptF, call, contact, hours, inquiry, min, msg, pond, t, task, taskF, touch, user } from './testing/fixtures.js';

// staffed 08:00 to 21:00 New York; NOW is 10:00 AM there
const CAL = businessCalendar({ zone: NY, open: '08:00', close: '21:00' });
const AVA: QueueHolder = { kind: 'owner', userId: user(1), name: 'Ava Agent' };
const OFFER: QueueHolder = { kind: 'on_offer', userId: user(2), name: 'Jordan P.' };
const POND: QueueHolder = { kind: 'pond', pondId: pond(1), name: 'Main pond' };
const NOBODY: QueueHolder = { kind: 'unassigned' };

const inputs = (o: Partial<TeamQueueInputs> = {}): TeamQueueInputs => ({ now: NOW, calendar: CAL, people: new Map(), inquiries: [], inbound: [], tasks: [], appointments: [], ...o });
const inq = (o: Partial<QueueInquiryFacts> = {}): QueueInquiryFacts => ({
  inquiryId: inquiry(1),
  contactId: contact(1),
  sourceName: 'Website form',
  arrivedAt: t(-min(12)),
  holder: OFFER,
  humanAttemptAt: null,
  automatedReplyAt: null,
  ...o,
});
const group = (i: TeamQueueInputs, key: (typeof TEAM_QUEUE_GROUPS)[number]) => buildTeamQueue(i).groups.find((g) => g.key === key)!;
const whys = (i: TeamQueueInputs, key: (typeof TEAM_QUEUE_GROUPS)[number]) => group(i, key).rows.map((r) => r.why);

describe('R-TEAMQ-1 the queue has five groups, always, in one order', () => {
  it('R-TEAMQ-1: an empty book gives the five groups, each empty, each with its own honest empty line', () => {
    const q = buildTeamQueue(inputs());
    expect(q.groups.map((g) => g.key)).toEqual(['new_lead', 'unanswered_reply', 'due_promise', 'overdue_follow_up', 'appointment_outcome']);
    expect(q.groups.map((g) => g.key)).toEqual([...TEAM_QUEUE_GROUPS]);
    expect(q.groups.map((g) => [g.rows.length, g.total, g.more])).toEqual([[0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0], [0, 0, 0]]);
    expect(q.groups.map((g) => g.empty)).toEqual([
      'Nobody is waiting on a first call.',
      'Every reply has an answer from a person.',
      'No promise is past due.',
      'No follow-up is past due.',
      'Every finished appointment has its outcome.',
    ]);
  });

  it('R-TEAMQ-1 E826: a group shows its longest-waiting rows first, at most the cap, and says how many more there are', () => {
    const many = Array.from({ length: TEAM_QUEUE_GROUP_CAP + 7 }, (_, n) => inq({ inquiryId: inquiry(n + 1), contactId: contact(n + 1), arrivedAt: t(-min(n + 1)) }));
    const g = group(inputs({ inquiries: many }), 'new_lead');
    expect([g.rows.length, g.total, g.more]).toEqual([TEAM_QUEUE_GROUP_CAP, TEAM_QUEUE_GROUP_CAP + 7, 7]);
    expect(g.rows[0]!.contactId).toBe(contact(TEAM_QUEUE_GROUP_CAP + 7)); // the oldest arrival
    expect(g.rows.map((r) => r.waitingSeconds)).toEqual([...g.rows.map((r) => r.waitingSeconds)].sort((a, b) => b - a));
  });
});

describe('R-TEAMQ-2 a new lead with no human attempt', () => {
  it('R-TEAMQ-2: the why line says when it arrived, from where, who has it, that nobody tried, and the automatic reply apart', () => {
    expect(whys(inputs({ inquiries: [inq({ automatedReplyAt: t(-min(11)) })] }), 'new_lead')).toEqual([
      'Arrived 12 min ago from Website form. On offer to Jordan P. Nobody has called, texted or emailed yet. An automatic reply went out at 9:49 AM.',
    ]);
  });

  const holders: [string, QueueHolder, string, string][] = [
    ['owned', AVA, 'Owned by Ava Agent.', 'Ava Agent'],
    ['on offer', OFFER, 'On offer to Jordan P.', 'No owner yet: on offer to Jordan P.'],
    ['in a pond', POND, 'In the pond Main pond.', 'No owner yet: in the pond Main pond'],
    ['unassigned', NOBODY, 'Not assigned to anyone.', 'No owner yet: not assigned to anyone'],
  ];
  for (const [name, holder, sentence, label] of holders) {
    it(`R-TEAMQ-2 E820: a lead that is ${name} is listed, and says so in words`, () => {
      const g = group(inputs({ inquiries: [inq({ holder })] }), 'new_lead');
      expect(g.rows).toHaveLength(1);
      expect(g.rows[0]!.why).toBe(`Arrived 12 min ago from Website form. ${sentence} Nobody has called, texted or emailed yet. No automatic reply has gone out.`);
      expect(g.rows[0]!.ownerLabel).toBe(label);
      expect(holderLabel(holder)).toBe(label);
    });
  }

  it('R-TEAMQ-2 E821: an automated reply never clears it; a human attempt at or after arrival does', () => {
    expect(group(inputs({ inquiries: [inq({ automatedReplyAt: t(-min(11)) })] }), 'new_lead').total).toBe(1);
    expect(group(inputs({ inquiries: [inq({ humanAttemptAt: t(-min(3)), automatedReplyAt: t(-min(11)) })] }), 'new_lead').total).toBe(0);
    expect(group(inputs({ inquiries: [inq({ humanAttemptAt: t(-min(12)) })] }), 'new_lead').total).toBe(0);
  });

  it('R-TEAMQ-2: an inquiry older than the window is not listed; one just inside it is', () => {
    const old = inq({ arrivedAt: t(-TEAM_QUEUE_NEW_LEAD_WINDOW_MS - 1) });
    const edge = inq({ inquiryId: inquiry(2), contactId: contact(2), arrivedAt: t(-TEAM_QUEUE_NEW_LEAD_WINDOW_MS + min(1)) });
    expect(group(inputs({ inquiries: [old, edge] }), 'new_lead').rows.map((r) => r.contactId)).toEqual([contact(2)]);
  });

  it('R-TEAMQ-2 E822: one person who asked twice is one row, counted from the first unanswered arrival', () => {
    const g = group(inputs({ inquiries: [inq({ arrivedAt: t(-hours(1)) }), inq({ inquiryId: inquiry(2), arrivedAt: t(-min(5)), sourceName: 'Open house sign-in' })] }), 'new_lead');
    expect(g.total).toBe(1);
    expect(g.rows[0]!.why).toBe('Arrived 1 h ago from Website form. Asked again 5 min ago (2 inquiries). On offer to Jordan P. Nobody has called, texted or emailed yet. No automatic reply has gone out.');
    expect(g.rows[0]!.since).toBe(t(-hours(1)));
  });

  it('R-TEAMQ-2 E822: an earlier inquiry a person answered does not count; the later unanswered one does, from its own arrival', () => {
    const g = group(inputs({ inquiries: [inq({ arrivedAt: t(-hours(3)), humanAttemptAt: t(-hours(2)) }), inq({ inquiryId: inquiry(2), arrivedAt: t(-min(5)) })] }), 'new_lead');
    expect(g.rows.map((r) => [r.since, r.waitingSeconds])).toEqual([[t(-min(5)), 300]]);
  });

  it('R-TEAMQ-2 E823: time since arrival is given in wall-clock and in staffed time; an arrival outside staffed hours is counted from opening and says so', () => {
    // arrived 02:00 New York; staffed hours open 08:00; now 10:00
    const night = at('2026-11-10T07:00:00Z');
    const g = group(inputs({ inquiries: [inq({ arrivedAt: night })] }), 'new_lead');
    expect([g.rows[0]!.waitingSeconds, g.rows[0]!.staffedSeconds, g.rows[0]!.offHours]).toEqual([8 * 3600, 2 * 3600, true]);
    expect(g.rows[0]!.why).toBe('Arrived 8 h ago from Website form, outside staffed hours (2 h of staffed time since opening). On offer to Jordan P. Nobody has called, texted or emailed yet. No automatic reply has gone out.');
    // a daytime arrival: both the same, nothing extra said
    const day = group(inputs({ inquiries: [inq()] }), 'new_lead').rows[0]!;
    expect([day.waitingSeconds, day.staffedSeconds, day.offHours]).toEqual([720, 720, false]);
  });

  it('R-TEAMQ-2: an automatic reply sent on an earlier day is dated by how long ago, never by a bare clock time; no source name is said plainly', () => {
    expect(whys(inputs({ inquiries: [inq({ arrivedAt: t(-hours(26)), automatedReplyAt: t(-hours(26) + min(1)), sourceName: null })] }), 'new_lead')[0]).toMatch(/^Arrived 26 h ago from a source with no name\. .* An automatic reply went out 25 h ago\.$/);
  });
});

describe('measureFromArrival', () => {
  const cases: [string, string, string, { wallSeconds: number; staffedSeconds: number; offHours: boolean }][] = [
    ['inside staffed hours', '2026-11-10T15:00:00Z', '2026-11-10T15:04:30Z', { wallSeconds: 270, staffedSeconds: 270, offHours: false }],
    ['before opening, tried after opening', '2026-11-10T07:00:00Z', '2026-11-10T13:03:00Z', { wallSeconds: 6 * 3600 + 180, staffedSeconds: 180, offHours: true }],
    ['before opening, tried before opening', '2026-11-10T07:00:00Z', '2026-11-10T07:10:00Z', { wallSeconds: 600, staffedSeconds: 0, offHours: true }],
    ['arrived at night, waited through the next whole day', '2026-11-10T03:00:00Z', '2026-11-11T03:00:00Z', { wallSeconds: 86_400, staffedSeconds: 13 * 3600, offHours: true }],
    ['an attempt before the arrival is no time at all', '2026-11-10T15:00:00Z', '2026-11-10T14:00:00Z', { wallSeconds: 0, staffedSeconds: 0, offHours: false }],
  ];
  for (const [name, a, b, want] of cases) {
    it(`R-TEAMQ-2 E823: ${name}`, () => {
      const m = measureFromArrival(at(a), at(b), CAL);
      expect({ wallSeconds: m.wallSeconds, staffedSeconds: m.staffedSeconds, offHours: m.offHours }).toEqual(want);
    });
  }
  it('R-TEAMQ-2 E823: countedFrom is the arrival itself when staffed, else the next opening', () => {
    expect(measureFromArrival(at('2026-11-10T15:00:00Z'), NOW, CAL).countedFrom).toBe(at('2026-11-10T15:00:00Z'));
    expect(measureFromArrival(at('2026-11-10T07:00:00Z'), NOW, CAL).countedFrom).toBe(at('2026-11-10T13:00:00Z'));
  });
});

describe('R-TEAMQ-3 an unanswered reply', () => {
  const people = new Map([[contact(3), { holder: AVA, sourceName: 'Website form' }], [contact(4), { holder: POND, sourceName: null }]]);
  const m = (o: Partial<TeamQueueInputs['inbound'][number]> = {}): TeamQueueInputs['inbound'][number] => ({ id: msg(1), kind: 'message', channel: 'sms', contactId: contact(3), at: t(-min(20)), imported: false, laterTouches: [], ...o });

  it('R-TEAMQ-3: a text, an email, a chat message and a missed call each say what happened and who has the person', () => {
    const table: [Partial<TeamQueueInputs['inbound'][number]>, string][] = [
      [{}, 'They texted 20 min ago; no answer from a person yet. Owned by Ava Agent.'],
      [{ channel: 'email' }, 'They emailed 20 min ago; no answer from a person yet. Owned by Ava Agent.'],
      [{ channel: 'web_chat' }, 'They wrote in the website chat 20 min ago; no answer from a person yet. Owned by Ava Agent.'],
      [{ id: call(1), kind: 'missed_call', channel: 'voice' }, 'Missed call 20 min ago; nobody has called back or written. Owned by Ava Agent.'],
      [{ contactId: contact(4) }, 'They texted 20 min ago; no answer from a person yet. In the pond Main pond.'],
    ];
    for (const [o, want] of table) expect(whys(inputs({ people, inbound: [m(o)] }), 'unanswered_reply')).toEqual([want]);
  });

  it('R-TEAMQ-3 E824: the feed’s own predicate decides: a human reply or a picked-up call answers; an assistant message, an auto-reply, a keyword and imported history never do', () => {
    const answered = (laterTouches: TeamQueueInputs['inbound'][number]['laterTouches']) => group(inputs({ people, inbound: [m({ laterTouches })] }), 'unanswered_reply').total === 0;
    expect(answered([touch({ at: t(-min(5)) })])).toBe(true);
    expect(answered([touch({ kind: 'call', direction: 'inbound_answered', at: t(-min(5)) })])).toBe(true);
    expect(answered([touch({ initiator: 'assistant', at: t(-min(5)) })])).toBe(false);
    expect(answered([touch({ initiator: 'system', at: t(-min(5)) })])).toBe(false);
    expect(answered([touch({ at: t(-min(25)) })])).toBe(false); // sent before they wrote
    expect(answered([touch({ gateAllowed: false, at: t(-min(5)) })])).toBe(false);
    expect(group(inputs({ people, inbound: [m({ isAutoReply: true })] }), 'unanswered_reply').total).toBe(0);
    expect(group(inputs({ people, inbound: [m({ isKeyword: true })] }), 'unanswered_reply').total).toBe(0);
    expect(group(inputs({ people, inbound: [m({ imported: true })] }), 'unanswered_reply').total).toBe(0);
  });

  it('R-TEAMQ-3: several waiting messages of one person are one row, aged from the first, worded by the latest', () => {
    const g = group(inputs({ people, inbound: [m({ at: t(-hours(2)) }), m({ id: msg(2), at: t(-min(4)), channel: 'email' })] }), 'unanswered_reply');
    expect(g.total).toBe(1);
    expect(g.rows[0]!.why).toBe('They emailed 4 min ago; no answer from a person yet. 2 messages or calls waiting, the first 2 h ago. Owned by Ava Agent.');
    expect(g.rows[0]!.waitingSeconds).toBe(7200);
  });

  it('R-TEAMQ-3: a message whose person is not among the people given (not visible to the viewer) makes no row', () => {
    expect(group(inputs({ people, inbound: [m({ contactId: contact(9) })] }), 'unanswered_reply').total).toBe(0);
  });
});

describe('R-TEAMQ-4 promises and follow-ups past due', () => {
  const people = new Map([[contact(6), { holder: AVA, sourceName: 'Website form' }]]);
  const AVA_MEMBER = { userId: user(1), name: 'Ava Agent' };
  const row = (o: Parameters<typeof taskF>[0], title = 'Send the comps') => ({ ...taskF({ contactId: contact(6), ...o }), title, assignee: AVA_MEMBER });

  it('R-TEAMQ-4: a promise past its deadline is a due promise; any other task about a person past its deadline is an overdue follow-up; each names who it is on', () => {
    const tasks = [
      row({ taskId: task(1), kind: 'promise', dueAt: t(-hours(3)) }),
      row({ taskId: task(2), kind: 'follow_up', dueAt: t(-hours(50)) }, 'Check in about financing'),
      row({ taskId: task(3), kind: 'callback', dueAt: t(-min(10)) }, 'Call back'),
    ];
    expect(whys(inputs({ people, tasks }), 'due_promise')).toEqual(['Promise “Send the comps” was due 3 h ago. Ava Agent made it.']);
    expect(whys(inputs({ people, tasks }), 'overdue_follow_up')).toEqual(['Follow-up “Check in about financing” was due 2 d ago. Assigned to Ava Agent.', 'Callback “Call back” was due 10 min ago. Assigned to Ava Agent.']);
    expect(group(inputs({ people, tasks }), 'due_promise').rows[0]!.ownerLabel).toBe('Ava Agent');
  });

  it('R-TEAMQ-4 E825: only past-due items: a task due in an hour, a done task, an undated task and an all-day task whose day is not over are not listed', () => {
    const tasks = [
      row({ taskId: task(1), kind: 'promise', dueAt: t(hours(1)) }),
      row({ taskId: task(2), kind: 'promise', dueAt: t(-hours(1)), status: 'done' }),
      row({ taskId: task(3), kind: 'promise', dueAt: null }),
      // all-day, due "today" in New York: past due only once the local day has ended
      row({ taskId: task(4), kind: 'follow_up', dueAt: at('2026-11-10T05:00:00Z') as Instant, dueAllDay: true, dueTz: NY }),
    ];
    const q = buildTeamQueue(inputs({ people, tasks }));
    expect(q.groups.filter((g) => g.key === 'due_promise' || g.key === 'overdue_follow_up').map((g) => g.total)).toEqual([0, 0]);
  });

  it('R-TEAMQ-4 R-IMPORT-6: a task an import created, and a task about no person, are never listed', () => {
    const tasks = [row({ taskId: task(1), kind: 'promise', dueAt: t(-hours(1)), createdByKind: 'import' }), row({ taskId: task(2), kind: 'todo', dueAt: t(-hours(1)), contactId: null })];
    expect(buildTeamQueue(inputs({ people, tasks })).groups.map((g) => g.total)).toEqual([0, 0, 0, 0, 0]);
  });
});

describe('R-TEAMQ-5 an appointment needing an outcome', () => {
  const people = new Map([[contact(7), { holder: AVA, sourceName: null }]]);
  const AVA_MEMBER = { userId: user(1), name: 'Ava Agent' };
  const a = (o: Parameters<typeof apptF>[0]) => ({ ...apptF({ contactId: contact(7), ...o }), member: AVA_MEMBER });

  it('R-TEAMQ-5: it is listed as soon as it has ended, not two hours later; one still running, one with an outcome, a canceled one and an imported one are not', () => {
    const appointments = [
      a({ appointmentId: appt(1), startsAt: t(-min(70)), endsAt: t(-min(10)) }),
      a({ appointmentId: appt(2), startsAt: t(-min(30)), endsAt: t(min(30)) }),
      a({ appointmentId: appt(3), startsAt: t(-hours(5)), endsAt: t(-hours(4)), outcomeLoggedAt: t(-hours(3)) }),
      a({ appointmentId: appt(4), startsAt: t(-hours(5)), endsAt: t(-hours(4)), status: 'canceled' }),
      a({ appointmentId: appt(5), startsAt: t(-hours(5)), endsAt: t(-hours(4)), createdByKind: 'import' }),
    ];
    const g = group(inputs({ people, appointments }), 'appointment_outcome');
    expect(g.rows.map((r) => r.why)).toEqual(['Buyer consult ended 10 min ago with no outcome logged. It is Ava Agent’s appointment.']);
    expect(g.rows[0]!.ownerLabel).toBe('Ava Agent');
  });
});

describe('who has the lead', () => {
  it('R-TEAMQ-2 E820: queueHolder reads the ownership state: owned, on offer, in a pond, unassigned; a closed lead has no holder (it is never listed)', () => {
    const base = { ownerUserId: null, ownerName: null, offeredToUserId: null, offeredToName: null, pondId: null, pondName: null };
    expect(queueHolder({ ...base, state: 'owned', ownerUserId: user(1), ownerName: 'Ava Agent' })).toEqual(AVA);
    expect(queueHolder({ ...base, state: 'offered', offeredToUserId: user(2), offeredToName: 'Jordan P.' })).toEqual(OFFER);
    expect(queueHolder({ ...base, state: 'in_pond', pondId: pond(1), pondName: 'Main pond' })).toEqual(POND);
    expect(queueHolder({ ...base, state: 'unassigned' })).toEqual(NOBODY);
    expect(queueHolder({ ...base, state: 'closed' })).toBeNull();
    expect(holderLabel({ kind: 'owner', userId: user(1), name: null })).toBe('A former member');
    expect(holderLabel({ kind: 'pond', pondId: pond(1), name: null })).toBe('No owner yet: in a pond');
  });
});

describe('R-TEAMQ-18 the backup alert on a new-lead row (b19 step 2)', () => {
  it('R-TEAMQ-18 E857: a row whose backup was alerted says so on its own line, with the time in the team\'s zone and who was alerted; the why line is unchanged', () => {
    const plain = group(inputs({ inquiries: [inq()] }), 'new_lead').rows[0]!;
    const g = group(inputs({ inquiries: [inq({ backupAlert: { at: t(-min(9)), outcome: 'alerted', name: 'Sam Torres', recipient: 'backup' } })] }), 'new_lead');
    expect(g.rows[0]!.backupAlert).toEqual({ at: t(-min(9)), alerted: true, line: 'Backup alerted at 9:51 AM: Sam T.' });
    expect(g.rows[0]!.why).toBe(plain.why);
    expect(plain.backupAlert).toBeNull();
    expect([g.backupAlerted, g.total]).toEqual([1, 1]);
  });

  it('R-TEAMQ-18 E857: the fallback and "nobody could be alerted" are said in words; an alert on another day says how long ago', () => {
    const line = (o: NonNullable<QueueInquiryFacts['backupAlert']>, arrivedAt = t(-min(12))) => group(inputs({ inquiries: [inq({ arrivedAt, backupAlert: o })] }), 'new_lead').rows[0]!.backupAlert;
    expect(line({ at: t(-min(9)), outcome: 'alerted', name: 'Taylor Lane', recipient: 'team_lead' })).toEqual({ at: t(-min(9)), alerted: true, line: 'The source\'s backup is unavailable: the team lead, Taylor L., was alerted at 9:51 AM.' });
    expect(line({ at: t(-min(9)), outcome: 'no_recipient', name: null, recipient: null })).toEqual({ at: t(-min(9)), alerted: false, line: 'Nobody could be alerted at 9:51 AM: the source\'s backup is unavailable and whoever has this lead has no team lead.' });
    expect(line({ at: t(-hours(26)), outcome: 'alerted', name: 'Sam Torres', recipient: 'backup' }, t(-hours(27)))!.line).toBe('Backup alerted 26 h ago: Sam T.');
    expect(line({ at: t(-min(9)), outcome: 'alerted', name: null, recipient: 'backup' })!.line).toBe('Backup alerted at 9:51 AM: a member.');
  });

  it('R-TEAMQ-18 E858: the group counts the rows whose backup was alerted over every waiting row (its denominator), also beyond the rows shown; a person who asked twice shows the latest alert', () => {
    const many = Array.from({ length: TEAM_QUEUE_GROUP_CAP + 3 }, (_, n) =>
      inq({ inquiryId: inquiry(n + 1), contactId: contact(n + 1), arrivedAt: t(-min(n + 5)), ...(n % 2 === 0 ? { backupAlert: { at: t(-min(n + 2)), outcome: 'alerted' as const, name: 'Sam Torres', recipient: 'backup' as const } } : {}) }),
    );
    const g = group(inputs({ inquiries: many }), 'new_lead');
    expect([g.backupAlerted, g.total]).toEqual([Math.ceil((TEAM_QUEUE_GROUP_CAP + 3) / 2), TEAM_QUEUE_GROUP_CAP + 3]);
    // "nobody could be alerted" is not counted as alerted
    const none = group(inputs({ inquiries: [inq({ backupAlert: { at: t(-min(9)), outcome: 'no_recipient', name: null, recipient: null } })] }), 'new_lead');
    expect([none.backupAlerted, none.total]).toEqual([0, 1]);
    const twice = group(
      inputs({
        inquiries: [
          inq({ inquiryId: inquiry(1), arrivedAt: t(-min(40)), backupAlert: { at: t(-min(37)), outcome: 'alerted', name: 'Sam Torres', recipient: 'backup' } }),
          inq({ inquiryId: inquiry(2), arrivedAt: t(-min(10)), backupAlert: { at: t(-min(7)), outcome: 'alerted', name: 'Sam Torres', recipient: 'backup' } }),
        ],
      }),
      'new_lead',
    );
    expect(twice.rows).toHaveLength(1);
    expect(twice.rows[0]!.backupAlert!.line).toBe('Backup alerted at 9:53 AM: Sam T.');
    expect([twice.backupAlerted, twice.total]).toEqual([1, 1]);
    // the other groups carry no such count
    expect(buildTeamQueue(inputs()).groups.filter((x) => x.key !== 'new_lead').map((x) => x.backupAlerted)).toEqual([null, null, null, null]);
  });
});
