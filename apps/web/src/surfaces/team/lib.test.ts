// Pure helpers of the Team surface.
import { describe, expect, it } from 'vitest';
import { evidenceText } from '../../design/index.js';
import { exceptionEvidenceView, normLine } from './lib.js';

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

describe('normLine', () => {
  it('says the median with its sample, or why there is no comparison', () => {
    expect(normLine({ medianDays: 9, sample: 12, enough: true }, 5)).toBe('Team median 9 days (of 12 deals)');
    expect(normLine({ medianDays: 1, sample: 1, enough: false }, 5)).toBe('Not enough team history to compare yet (1 of 5 deals needed)');
    expect(normLine(null, 5)).toBe('Not enough team history to compare yet (0 of 5 deals needed)');
  });
});
