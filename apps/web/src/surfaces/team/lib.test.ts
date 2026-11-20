// Pure helpers of the Team surface.
import { describe, expect, it } from 'vitest';
import { evidenceText } from '../../design/index.js';
import { board } from '../admin/lib/testing.js';
import { clock12, exceptionEvidenceView, normLine, periodLabel, queueCount, queueFootnote, queueMoreLine, queueWait, scoreboardLines } from './lib.js';

describe('exceptionEvidenceView', () => {
  it('keeps source, place and explanation; carries no score', () => {
    const v = exceptionEvidenceView({ sourceType: 'call', sourceId: 'c1', explanation: 'Where it was promised', at: null, locator: { kind: 'transcript_offset', startMs: 61_000, endMs: 64_000 }, snippet: '  send the comps ', needsReview: false, link: { kind: 'call', id: 'c1', contactId: 'p1', offsetMs: 61_000 } });
    expect(v).toEqual({ sourceType: 'call', sourceId: 'c1', contactId: 'p1', locator: { kind: 'transcript_offset', startMs: 61_000, endMs: 64_000 }, explanation: 'Where it was promised', snippet: 'send the comps' });
    expect(evidenceText(v)).toBe('“send the comps” at 1:01 in the call');
  });

  it('uses the link offset when the stored locator has none, and puts the instant into the explanation', () => {
    const v = exceptionEvidenceView({ sourceType: 'message_status', sourceId: 'm1', explanation: 'Carrier said undelivered', at: '2026-11-10T22:05:00.000Z', locator: null, snippet: null, needsReview: false, link: null });
    expect(v.locator).toEqual({ kind: 'message' });
    expect(v.contactId).toBeNull();
    expect(v.explanation).toMatch(/^Carrier said undelivered · Nov 10, /);
    expect(evidenceText(v)).toBe(v.explanation);
    const w = exceptionEvidenceView({ sourceType: 'call', sourceId: 'c2', explanation: 'x', at: null, locator: null, snippet: 'hi', needsReview: false, link: { kind: 'call', id: 'c2', contactId: 'p', offsetMs: 5_000 } });
    expect(w.locator).toEqual({ kind: 'transcript_offset', startMs: 5_000, endMs: 5_000 });
  });

  it('maps an unknown source type to a note rather than inventing a route', () => {
    expect(exceptionEvidenceView({ sourceType: 'mystery', sourceId: 'x', explanation: 'e', at: null, locator: null, snippet: null, needsReview: false, link: null }).sourceType).toBe('note');
  });
});

describe('periodLabel and the period lines (one ownership period per card)', () => {
  const owner = { userId: 'u1', name: 'Ava Agent' };
  it('labels an untouched lead\'s facts as its owner\'s period, and as the earlier period once the lead moved on; other types have none', () => {
    expect(periodLabel({ itemType: 'untouched_lead', owner, period: { current: true, movedOn: false } })).toBe("Ava Agent's ownership period");
    expect(periodLabel({ itemType: 'untouched_lead', owner, period: { current: false, movedOn: true } })).toBe("Ava Agent's earlier ownership period (the lead has moved on since)");
    expect(periodLabel({ itemType: 'untouched_lead', owner: { userId: 'u2', name: null }, period: { current: false, movedOn: true } })).toBe("A former member's earlier ownership period (the lead has moved on since)");
    expect(periodLabel({ itemType: 'overdue_promise', owner, period: null })).toBeNull();
  });
  it('when the same agent still has the lead and a re-inquiry started their next period, the earlier period never says the lead moved on', () => {
    // the re-inquiry SLA period of an owned lead (R-OWN-20 / E68; the server's period facts: accountability/exceptions.test.ts)
    expect(periodLabel({ itemType: 'untouched_lead', owner, period: { current: false, movedOn: false } })).toBe("Ava Agent's earlier ownership period (a new one started when the lead inquired again)");
    // only the server's explicit "kept" names a re-inquiry: a period without that fact keeps the cautious wording
    expect(periodLabel({ itemType: 'untouched_lead', owner, period: { current: false } as never })).toBe("Ava Agent's earlier ownership period (the lead has moved on since)");
  });
  it('names the period\'s owner in its lines and leaves the period end to the label; other lines are unchanged', () => {
    const line = (explanation: string, o?: string) => exceptionEvidenceView({ sourceType: 'ownership_period', sourceId: 'p1', explanation, at: null, locator: null, snippet: null, needsReview: false, link: null }, o ? { owner: o } : {}).explanation;
    expect(line('Lead became theirs', 'Ava Agent')).toBe("Lead became Ava Agent's");
    expect(line('No human call, text or email by the first-contact deadline; the lead later left this agent', 'Ava Agent')).toBe('No human call, text or email by the first-contact deadline');
    expect(line('First human contact', 'Ava Agent')).toBe('First human contact');
    expect(line('Lead became theirs')).toBe('Lead became theirs');
  });
  it('E310 E311 (owner decision D8): the server names a chat reply among the touches and says whose touch is missing; the lines name the period\'s owner, the "the lead later left" one is shortened the same way, and an item stored with the earlier words still reads as before', () => {
    const line = (explanation: string, o: { owner?: string } = { owner: 'Ava Agent' }) => exceptionEvidenceView({ sourceType: 'ownership_period', sourceId: 'p1', explanation, at: null, locator: null, snippet: null, needsReview: false, link: null }, o).explanation;
    const missed = 'No human call, text, email or chat reply from the agent or a collaborator by the first-contact deadline';
    expect(line(`${missed}; the lead later left this agent`)).toBe('No human call, text, email or chat reply from Ava Agent or a collaborator by the first-contact deadline');
    expect(line(missed)).toBe('No human call, text, email or chat reply from Ava Agent or a collaborator by the first-contact deadline');
    expect(line('First human call, text, email or chat reply from the agent or a collaborator came after the first-contact deadline')).toBe('First human call, text, email or chat reply from Ava Agent or a collaborator came after the first-contact deadline');
    // without the owner's name (a card that has none) the server's words stand
    expect(line(missed, {})).toBe(missed);
    // a handled item outside the recompute window keeps the words it was stored with
    expect(line('No human call, text or email by the first-contact deadline; the lead later left this agent')).toBe('No human call, text or email by the first-contact deadline');
  });
});

describe('scoreboardLines', () => {
  it('E310 (owner decision D8): the touches split names the chat replies counted with the texts and emails', () => {
    const touches = scoreboardLines(board({ touches: { count: 5, calls: 2, textsAndEmails: 3, days: 7 } })).find((l) => l.label === 'Touches (attempts)');
    expect(touches).toEqual({ label: 'Touches (attempts)', text: '5 in 7 days', detail: '2 call attempts (answered or not) · 3 texts, emails and chat replies sent' });
  });

  it('E724 (b18 item g): touches are attempts and say so: a call counts whether or not it was answered, and nothing calls them conversations', () => {
    for (const calls of [0, 1, 4]) {
      const t = scoreboardLines(board({ touches: { count: calls + 1, calls, textsAndEmails: 1, days: 7 } })).find((l) => l.label.startsWith('Touches'))!;
      expect(t.label).toBe('Touches (attempts)');
      expect(t.detail).toMatch(calls === 1 ? /^1 call attempt \(answered or not\)/ : new RegExp(`^${calls} call attempts \\(answered or not\\)`));
      expect(`${t.label} ${t.text} ${t.detail}`).not.toMatch(/conversation|connected|talked|spoke/i);
    }
  });
});

describe('normLine', () => {
  it('says the median with its sample, or why there is no comparison', () => {
    expect(normLine({ medianDays: 9, sample: 12, enough: true }, 5)).toBe('Team median 9 days (of 12 deals)');
    expect(normLine({ medianDays: 1, sample: 1, enough: false }, 5)).toBe('Not enough team history to compare yet (1 of 5 deals needed)');
    expect(normLine(null, 5)).toBe('Not enough team history to compare yet (0 of 5 deals needed)');
  });
});

// b19 team-queue lane: the display helpers of the team work queue
describe('team work queue helpers', () => {
  it('R-TEAMQ-1 E826: the count is the number, or "at least" it when the server read was capped', () => {
    expect(queueCount({ total: 32, atLeast: false })).toBe('32');
    expect(queueCount({ total: 500, atLeast: true })).toBe('at least 500');
  });

  it('R-TEAMQ-2 E823: a new lead waits from arrival; staffed time is said apart only when it differs by a minute or more', () => {
    const table: [Parameters<typeof queueWait>[0], number, number | null, string][] = [
      ['new_lead', 720, 720, 'Waiting 12 min'],
      ['new_lead', 30, 30, 'Waiting under a minute'],
      ['new_lead', 8 * 3600, 2 * 3600, 'Waiting 8 h · 2 h in staffed hours'],
      ['new_lead', 600, 0, 'Waiting 10 min · under a minute in staffed hours'],
      ['unanswered_reply', 1200, null, 'Waiting 20 min'],
      ['due_promise', 10_800, null, 'Past due 3 h'],
      ['overdue_follow_up', 2 * 86_400, null, 'Past due 2 days'],
      ['appointment_outcome', 600, null, 'Ended 10 min ago'],
    ];
    for (const [key, waitingSeconds, staffedSeconds, want] of table) expect(queueWait(key, { waitingSeconds, staffedSeconds })).toBe(want);
  });

  it('R-TEAMQ-1 E826: the more line says how many are shown and how many are not, and nothing when all are shown', () => {
    const rows = [{}, {}] as never[];
    expect(queueMoreLine({ rows, more: 0, atLeast: false })).toBeNull();
    expect(queueMoreLine({ rows, more: 1, atLeast: false })).toBe('Showing the 2 waiting longest. 1 more is not shown.');
    expect(queueMoreLine({ rows, more: 7, atLeast: false })).toBe('Showing the 2 waiting longest. 7 more are not shown.');
    expect(queueMoreLine({ rows, more: 498, atLeast: true })).toBe('Showing the 2 waiting longest. At least 498 more are not shown.');
  });

  it('staffed hours are wall-clock times of the team’s zone, shown the same in every viewer zone', () => {
    expect([clock12('08:00'), clock12('21:00'), clock12('00:00'), clock12('12:30'), clock12('24:00')]).toEqual(['8:00 AM', '9:00 PM', '12:00 AM', '12:30 PM', '12:00 AM']);
    const line = queueFootnote({ generatedAt: '2026-11-10T15:00:00.000Z', staffedHours: { open: '08:00', close: '21:00', zone: 'America/New_York' }, windows: { newLeadDays: 14, replyDays: 7, taskDays: 90, appointmentDays: 30 } });
    expect(line).toMatch(/^Checked Nov 10, \d{1,2}:00 [AP]M\. Staffed hours are 8:00 AM to 9:00 PM \(America\/New_York\)\. Looks back 14 days for new leads, 7 days for replies, 90 days for promises and follow-ups, 30 days for appointments\.$/);
  });
});
