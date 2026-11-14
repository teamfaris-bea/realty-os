// Pure display helpers: countdowns, relative times, money, and the API evidence → EvidenceRefView
// mapping (withheld transcript snippets and sources removed under retention read as words).
import { describe, expect, it } from 'vitest';
import { claimView, countdownWords, evidenceView, firstName, formatCountdown, formatLocalDate, formatMoney, formatPhone, relativeTime } from './format.js';

describe('format', () => {
  it('formatCountdown rounds up, pads seconds, shows hours, and is null once the deadline passed', () => {
    expect(formatCountdown(300_000, 0)).toBe('5:00');
    expect(formatCountdown(299_001, 0)).toBe('5:00');
    expect(formatCountdown(299_000, 0)).toBe('4:59');
    expect(formatCountdown(7_000, 0)).toBe('0:07');
    expect(formatCountdown(3_723_000, 0)).toBe('1:02:03');
    expect(formatCountdown(1, 0)).toBe('0:01');
    expect(formatCountdown(0, 0)).toBeNull();
    expect(formatCountdown(-5, 0)).toBeNull();
  });

  it('countdownWords says it in words for screen readers', () => {
    expect(countdownWords(299_000, 0)).toBe('4 minutes 59 seconds left');
    expect(countdownWords(60_000, 0)).toBe('1 minute left');
    expect(countdownWords(3_660_000, 0)).toBe('1 hour 1 minute left');
    expect(countdownWords(0, 0)).toBe('0 seconds left');
  });

  it('relativeTime reads like a person would say it', () => {
    expect(relativeTime(0, 30_000)).toBe('just now');
    expect(relativeTime(0, 5 * 60_000)).toBe('5 min ago');
    expect(relativeTime(0, 3 * 3_600_000)).toBe('3 h ago');
    expect(relativeTime(0, 2 * 86_400_000)).toBe('2 d ago');
    expect(relativeTime(10 * 60_000, 0)).toBe('in 10 min');
  });

  it('money, dates, phones, first names', () => {
    expect(formatMoney(42_500_000)).toBe('$425,000');
    expect(formatMoney(null)).toBeNull();
    expect(formatLocalDate('2026-12-15')).toBe('Dec 15, 2026');
    expect(formatPhone('+14155550123')).toBe('(415) 555-0123');
    expect(formatPhone('+442079460958')).toBe('+442079460958');
    expect(firstName('Jane Doe')).toBe('Jane');
    expect(firstName(null)).toBe('They');
  });

  it('evidenceView keeps the verbatim snippet and the transcript offset', () => {
    const v = evidenceView({ sourceType: 'call', sourceId: 'c1', locator: { kind: 'transcript_offset', startMs: 134_000, endMs: 137_000 }, snippet: 'call me Thursday', verified: true, sourceAvailable: true, label: 'x' }, 'k1');
    expect(v).toEqual({ sourceType: 'call', sourceId: 'c1', contactId: 'k1', locator: { kind: 'transcript_offset', startMs: 134_000, endMs: 137_000 }, snippet: 'call me Thursday', verified: true });
  });

  it('evidenceView: a withheld snippet shows the server label; a source removed under retention says so', () => {
    const withheld = evidenceView({ sourceType: 'call', sourceId: 'c1', locator: { kind: 'transcript_offset', startMs: 1, endMs: 2 }, snippet: null, verified: true, sourceAvailable: true, label: 'Quoted from the call (open the call to hear it)' });
    expect(withheld.explanation).toBe('Quoted from the call (open the call to hear it)');
    expect(withheld.snippet).toBeUndefined();
    const removed = evidenceView({ sourceType: 'call', sourceId: 'c1', locator: {}, snippet: 'gone', verified: true, sourceAvailable: false, label: 'Source removed under retention policy' });
    expect(removed.explanation).toBe('Source removed under retention policy');
    expect(removed.locator).toEqual({ kind: 'message' });
  });

  it('claimView keeps a needs-review claim (flagged, never dropped) and shows the resolved date with the claim', () => {
    const c = claimView({ id: 'x', kind: 'callback_due', text: 'Callback due', needsReview: true, reviewStatus: 'unreviewed', due: { at: '2026-11-12T00:00:00Z', display: 'Thu Nov 12, 4 PM', allDay: false }, evidence: [] });
    expect(c).toEqual({ text: 'Callback due (Thu Nov 12, 4 PM)', needsReview: true, evidence: [] });
  });
});
