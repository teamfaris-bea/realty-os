import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { contentSha256, validatePlaybookContent } from '../assistant/index.js';
import { type AiIsaContent, DEFAULT_AI_ISA_CONTENT, capabilitiesInEffect, narrowsPrevious, parseAiIsaContent, validateAiIsaContent } from './content.js';
import { CONTENT, IDENTITY } from './testing/fixtures.js';

const codes = (c: unknown) => validateAiIsaContent(c, { identity: IDENTITY }).map((i) => i.code);
const withC = (o: Partial<AiIsaContent>): AiIsaContent => ({ ...CONTENT, ...o });

describe('R-ISA-1 E524 AiIsaContent: strict schema and pack ceilings', () => {
  it('the shipped default and the full-capability fixture are valid, stored or bare', () => {
    expect(codes(DEFAULT_AI_ISA_CONTENT)).toEqual([]);
    expect(codes(CONTENT)).toEqual([]);
    expect(codes({ kind: 'ai_isa', aiIsa: CONTENT })).toEqual([]);
    expect(parseAiIsaContent({ kind: 'ai_isa', aiIsa: CONTENT })).toEqual(CONTENT);
    expect(parseAiIsaContent({ ...CONTENT, caps: { ...CONTENT.caps, ai24h: 4 } })).toBeNull();
  });
  it('the content is hashed by contentSha256 and refused as any other playbook kind', () => {
    expect(contentSha256({ kind: 'ai_isa', aiIsa: CONTENT }, {})).toMatch(/^[0-9a-f]{64}$/);
    expect(validatePlaybookContent({ kind: 'ai_isa', aiIsa: CONTENT }, { kind: 'nurture' })[0]!.code).toBe('CONTENT_KIND_MISMATCH');
    expect(codes({ kind: 'voice', voice: {} })).toEqual(['CONTENT_KIND_MISMATCH']);
  });
  it('unknown keys and wrong types fail the schema', () => {
    expect(codes({ ...CONTENT, disclosure: 'Hi I am Avery' })).toContain('SCHEMA');
    expect(codes({ ...CONTENT, channels: ['sms', 'web_chat'] })).toContain('SCHEMA');
    expect(codes({ ...CONTENT, cadence: '2d' })).toContain('SCHEMA');
    expect(codes(null)).toContain('SCHEMA');
  });
  it('reserved capabilities are refused CAPABILITY_NOT_AVAILABLE; converse is required', () => {
    expect(codes(withC({ capabilities: ['converse', 'share_value_estimate'] }))).toEqual(['CAPABILITY_NOT_AVAILABLE']);
    expect(codes(withC({ capabilities: ['converse', 'seller_market_stats'] }))).toEqual(['CAPABILITY_NOT_AVAILABLE']);
    expect(codes(withC({ capabilities: ['share_listings'] }))).toEqual(['CONVERSE_REQUIRED']);
    expect(codes(withC({ capabilities: ['converse', 'teleport'] }))).toEqual(['CAPABILITY_UNKNOWN']);
    expect(codes(withC({ capabilities: ['converse', 'converse'] }))).toEqual(['DUPLICATE']);
  });
  it('the window never wider than 08:00–20:00; holidays on; caps, gap, limits, readiness and booking within the ceiling', () => {
    expect(codes(withC({ window: { startSec: 7 * 3600, endSec: 20 * 3600 } }))).toEqual(['WINDOW_ABOVE_CEILING']);
    expect(codes(withC({ window: { startSec: 9 * 3600, endSec: 21 * 3600 } }))).toEqual(['WINDOW_ABOVE_CEILING']);
    expect(codes(withC({ window: { startSec: 12 * 3600, endSec: 9 * 3600 } }))).toEqual(['WINDOW_INVALID']);
    expect(codes(withC({ noInitiatedOnHolidays: false }))).toEqual(['HOLIDAYS_REQUIRED']);
    expect(codes(withC({ caps: { ...CONTENT.caps, ai24h: 4 } }))).toEqual(['CAP_ABOVE_CEILING']);
    expect(codes(withC({ caps: { ...CONTENT.caps, minGapSeconds: 60 } }))).toEqual(['GAP_BELOW_CEILING']);
    expect(codes(withC({ limits: { ...CONTENT.limits, maxMessagesPerAssignment: 41 } }))).toEqual(['LIMIT_ABOVE_CEILING']);
    expect(codes(withC({ limits: { ...CONTENT.limits, maxDays: 181 } }))).toEqual(['LIMIT_ABOVE_CEILING']);
    expect(codes(withC({ limits: { ...CONTENT.limits, slowAfterUnanswered: 7 } }))).toEqual(['LIMIT_ABOVE_CEILING']);
    expect(codes(withC({ readiness: { timelineDays: 120 } }))).toEqual(['READINESS_ABOVE_CEILING']);
    expect(codes(withC({ booking: { ...CONTENT.booking, minNoticeHours: 2 } }))).toEqual(['BOOKING_ABOVE_CEILING']);
    expect(codes(withC({ booking: { ...CONTENT.booking, horizonDays: 30 } }))).toEqual(['BOOKING_ABOVE_CEILING']);
    expect(codes(withC({ booking: { ...CONTENT.booking, bufferMinutes: 5 } }))).toEqual(['BOOKING_ABOVE_CEILING']);
    expect(codes(withC({ booking: { ...CONTENT.booking, durationMinutes: 180 } }))).toEqual(['BOOKING_ABOVE_CEILING']);
  });
  it('holding lines pass the content, fair-housing and ISA guards; the tone passes fair housing', () => {
    expect(codes(withC({ holdingLines: { financial: "That's a question for Avery. I've passed it on." } }))).toEqual([]);
    expect(codes(withC({ holdingLines: { pricing_negotiation: 'Homes here sell for top dollar, call Avery.' } }))).toEqual(['LINE_GUARD']);
    expect(codes(withC({ holdingLines: { financial: 'Rates are around six percent right now.' } }))).toEqual(['LINE_GUARD']);
    expect(codes(withC({ tone: 'Friendly, perfect for young professionals with no kids.' }))).toEqual(['TONE_GUARD']);
    expect(validateAiIsaContent(withC({ holdingLines: { financial: 'Homes like this have no children nearby ok' } }))[0]!.code).toBe('LINE_GUARD');
  });
});

describe('R-ISA-1 E524 narrowsPrevious', () => {
  it('equal content narrows; each widening field does not', () => {
    expect(narrowsPrevious(CONTENT, CONTENT)).toBe(true);
    expect(narrowsPrevious(CONTENT, withC({ capabilities: ['converse'], channels: ['sms'], caps: { ...CONTENT.caps, ai24h: 2 }, cadence: '7d', tone: 'new wording' }))).toBe(true);
    const narrow = withC({ capabilities: ['converse'] });
    const widenings: Partial<AiIsaContent>[] = [
      { capabilities: ['converse', 'share_listings'] },
      { window: { startSec: 8 * 3600, endSec: 20 * 3600 } },
      { initiatedDays: [1, 2, 3, 4, 5, 6, 7] },
      { caps: { ...CONTENT.caps, ai24h: 4 } },
      { caps: { ...CONTENT.caps, minGapSeconds: 60 } },
      { cadence: '1d' },
      { limits: { ...CONTENT.limits, maxDays: 200 } },
      { readiness: { timelineDays: 120 } },
      { booking: { ...CONTENT.booking, minNoticeHours: 2 } },
      { booking: { ...CONTENT.booking, durationMinutes: 45 } },
      { noInitiatedOnHolidays: false },
    ];
    for (const w of widenings) expect(narrowsPrevious(narrow, { ...narrow, ...w })).toBe(false);
    expect(narrowsPrevious(withC({ channels: ['sms'] }), CONTENT)).toBe(false);
  });
  it('property: narrowing is reflexive and transitive over random caps and windows', () => {
    const arb = fc.record({ ai: fc.integer({ min: 0, max: 3 }), start: fc.integer({ min: 8, max: 12 }), end: fc.integer({ min: 13, max: 20 }), gap: fc.integer({ min: 120, max: 600 }) });
    const mk = (r: { ai: number; start: number; end: number; gap: number }): AiIsaContent => withC({ caps: { ...CONTENT.caps, ai24h: r.ai, minGapSeconds: r.gap }, window: { startSec: r.start * 3600, endSec: r.end * 3600 } });
    fc.assert(
      fc.property(arb, arb, arb, (a, b, c) => {
        const [x, y, z] = [mk(a), mk(b), mk(c)];
        expect(narrowsPrevious(x, x)).toBe(true);
        if (narrowsPrevious(x, y) && narrowsPrevious(y, z)) expect(narrowsPrevious(x, z)).toBe(true);
      }),
    );
  });
  it('capabilitiesInEffect is the policy ∩ the opt-in, without reserved ones', () => {
    expect([...capabilitiesInEffect(CONTENT, ['converse', 'book_appointments', 'share_value_estimate'])].sort()).toEqual(['book_appointments', 'converse']);
    expect([...capabilitiesInEffect(withC({ capabilities: ['converse', 'share_value_estimate'] }), ['share_value_estimate'])]).toEqual([]);
  });
});
