// Pure helpers of the Team surface.
import { describe, expect, it } from 'vitest';
import { evidenceText } from '../../design/index.js';
import { board } from '../admin/lib/testing.js';
import { exceptionEvidenceView, normLine, periodLabel, scoreboardLines } from './lib.js';

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
    const touches = scoreboardLines(board({ touches: { count: 5, calls: 2, textsAndEmails: 3, days: 7 } })).find((l) => l.label === 'Touches');
    expect(touches).toEqual({ label: 'Touches', text: '5 in 7 days', detail: '2 calls · 3 texts, emails and chat replies' });
  });
});

describe('normLine', () => {
  it('says the median with its sample, or why there is no comparison', () => {
    expect(normLine({ medianDays: 9, sample: 12, enough: true }, 5)).toBe('Team median 9 days (of 12 deals)');
    expect(normLine({ medianDays: 1, sample: 1, enough: false }, 5)).toBe('Not enough team history to compare yet (1 of 5 deals needed)');
    expect(normLine(null, 5)).toBe('Not enough team history to compare yet (0 of 5 deals needed)');
  });
});
