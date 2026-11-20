import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { contentSha256, validatePlaybookContent } from '../assistant/index.js';
import { AI_ISA_FIELD_KEYS, AI_ISA_FIELD_WIDENS, type AiIsaContent, DEFAULT_AI_ISA_CONTENT, capabilitiesInEffect, narrowsPrevious, parseAiIsaContent, policyFieldChange, policyFieldChanges, validateAiIsaContent } from './content.js';
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
    expect(narrowsPrevious(CONTENT, withC({ capabilities: ['converse'], channels: ['sms'], caps: { ...CONTENT.caps, ai24h: 2 }, cadence: '7d' }))).toBe(true);
    // b19 review F5 (R-ISA-38): a new tone sample is a change the platform cannot rank, so the same narrowing with it is wider
    expect(narrowsPrevious(CONTENT, withC({ capabilities: ['converse'], channels: ['sms'], caps: { ...CONTENT.caps, ai24h: 2 }, cadence: '7d', tone: 'new wording' }))).toBe(false);
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

// b19 review F2 and F8 (R-ISA-38; E1011): one rule per field of the content, from one table keyed by the content's own
// leaves; a change the table cannot rank, and a field it does not know, is wider.
describe('R-ISA-38 E1011 one comparison rule per field, failing closed', () => {
  /** Every leaf path of a value, an array counting as one leaf. */
  function leaves(o: unknown, at: string[] = []): string[] {
    if (o === null || typeof o !== 'object' || Array.isArray(o)) return [at.join('.')];
    return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leaves(v, [...at, k]));
  }
  const FULL: AiIsaContent = { ...CONTENT, holdingLines: { pricing_negotiation: 'x'.repeat(12), financial: 'x'.repeat(12), data_unavailable: 'x'.repeat(12), booking_unavailable: 'x'.repeat(12) }, tone: 'Warm.' };
  const mid: AiIsaContent = withC({
    capabilities: ['converse', 'share_listings'], channels: ['sms'], window: { startSec: 10 * 3600, endSec: 18 * 3600 }, initiatedDays: [1, 2, 3], cadence: '7d',
    caps: { ai24h: 2, automated24h: 2, initiated24h: 0, initiated7d: 2, minGapSeconds: 300 },
    limits: { maxMessagesPerAssignment: 20, maxDays: 90, slowAfterUnanswered: 2, dormantAfterUnanswered: 4 },
    readiness: { timelineDays: 60 },
    booking: { kinds: { buyer: ['buyer_consult'], seller: ['listing_appointment'] }, durationMinutes: 30, minNoticeHours: 12, horizonDays: 7, bufferMinutes: 30 },
    holdingLines: { financial: 'I will ask your agent to go over that with you.' }, tone: 'Warm and brief.',
  });
  const set = (path: string, value: unknown): AiIsaContent => {
    const go = (o: Record<string, unknown>, [k, ...rest]: string[]): Record<string, unknown> => (rest.length === 0 ? { ...o, [k!]: value } : { ...o, [k!]: go((o[k!] ?? {}) as Record<string, unknown>, rest) });
    return go(mid as unknown as Record<string, unknown>, path.split('.')) as unknown as AiIsaContent;
  };

  it('every leaf of the default content, and of a content with every optional value set, has a rule; the table has no other key', () => {
    expect([...AI_ISA_FIELD_KEYS].sort()).toEqual(leaves(FULL).sort());
    for (const k of leaves(DEFAULT_AI_ISA_CONTENT)) expect(AI_ISA_FIELD_KEYS as readonly string[], k).toContain(k);
    expect(Object.keys(AI_ISA_FIELD_WIDENS).sort()).toEqual([...AI_ISA_FIELD_KEYS].sort());
    expect(new Set(AI_ISA_FIELD_KEYS).size).toBe(AI_ISA_FIELD_KEYS.length);
  });

  // the review's field table, row by row: [field, a value that widens `mid`, a value that narrows it (null: any change widens)]
  const TABLE: [string, unknown, unknown][] = [
    ['capabilities', ['converse', 'share_listings', 'book_appointments'], ['converse']],
    ['channels', ['sms', 'email'], null],
    ['window.startSec', 9 * 3600, 11 * 3600],
    ['window.endSec', 19 * 3600, 17 * 3600],
    ['initiatedDays', [1, 2, 3, 4], [1, 2]],
    ['caps.ai24h', 3, 1],
    ['caps.initiated24h', 1, null],
    ['caps.initiated7d', 3, 1],
    ['caps.automated24h', 3, 1],
    ['caps.minGapSeconds', 299, 301],
    ['cadence', '3d', '14d'],
    ['limits.maxMessagesPerAssignment', 21, 19],
    ['limits.maxDays', 91, 89],
    ['limits.slowAfterUnanswered', 3, 1],
    ['limits.dormantAfterUnanswered', 5, 3],
    ['booking.kinds.buyer', ['buyer_consult', 'consult'], []],
    ['booking.kinds.seller', ['listing_appointment', 'consult'], []],
    ['booking.minNoticeHours', 11, 13],
    ['booking.bufferMinutes', 29, 31],
    ['booking.horizonDays', 8, 6],
  ];
  it.each(TABLE)('%s: the widening direction is wider, the other direction narrows', (key, wider, narrower) => {
    expect(narrowsPrevious(mid, set(key, wider)), `${key} wider`).toBe(false);
    expect(policyFieldChange(key, (leavesValue(mid, key)), wider)).toBe('wider');
    if (narrower !== null) {
      expect(narrowsPrevious(mid, set(key, narrower)), `${key} narrower`).toBe(true);
      expect(policyFieldChange(key, leavesValue(mid, key), narrower)).toBe('narrower');
    }
    expect(policyFieldChange(key, leavesValue(mid, key), leavesValue(mid, key))).toBe('same');
  });
  function leavesValue(c: AiIsaContent, key: string): unknown {
    return key.split('.').reduce<unknown>((at, k) => (at as Record<string, unknown>)[k], c);
  }

  it('noInitiatedOnHolidays: turning it off is wider, turning it on narrows', () => {
    expect(policyFieldChange('noInitiatedOnHolidays', true, false)).toBe('wider');
    expect(policyFieldChange('noInitiatedOnHolidays', false, true)).toBe('narrower');
    expect(narrowsPrevious(mid, { ...mid, noInitiatedOnHolidays: false })).toBe(false);
  });

  // the rows where ANY change widens: the direction is not the platform's to rule (Q-ISA-46), or nothing ranks the words
  const ANY: [string, unknown, unknown][] = [
    ['readiness.timelineDays', 30, 90],
    ['booking.durationMinutes', 15, 45],
    ['holdingLines.financial', 'Your agent will go over the numbers with you.', undefined],
    ['holdingLines.pricing_negotiation', 'Your agent will talk about price with you.', 'Price is a question for your agent, I passed it on.'],
    ['holdingLines.data_unavailable', 'I cannot check that, your agent will.', 'Your agent can look that up for you.'],
    ['holdingLines.booking_unavailable', 'I cannot offer a time, your agent will.', 'Your agent will find a time with you.'],
    ['tone', 'Formal.', ''],
  ];
  it.each(ANY)('%s: any change is wider, in both directions (fail closed)', (key, one, other) => {
    for (const v of [one, other]) {
      expect(narrowsPrevious(mid, set(key, v)), `${key} -> ${String(v)}`).toBe(false);
      expect(narrowsPrevious(set(key, v), mid), `${key} <- ${String(v)}`).toBe(false);
    }
    expect(AI_ISA_FIELD_WIDENS[key as keyof typeof AI_ISA_FIELD_WIDENS]).toBe('any');
  });

  it('F2: lowering the ready-within days keeps more people in AI care, so 90 to 30 is wider; so is 30 to 90', () => {
    const d90 = withC({ readiness: { timelineDays: 90 } });
    const d30 = withC({ readiness: { timelineDays: 30 } });
    expect(narrowsPrevious(d90, d30)).toBe(false);
    expect(narrowsPrevious(d30, d90)).toBe(false);
    expect(narrowsPrevious(d30, d30)).toBe(true);
  });

  it('F8: a field the table does not know is wider, whatever its value, on either side; so is a value of the wrong type', () => {
    const extra = { ...CONTENT, shareOpenHouses: true } as unknown as AiIsaContent;
    expect(narrowsPrevious(CONTENT, extra)).toBe(false);
    expect(narrowsPrevious(extra, CONTENT)).toBe(false);
    expect(narrowsPrevious(extra, extra)).toBe(false);
    const nested = { ...CONTENT, caps: { ...CONTENT.caps, perHour: 1 } } as unknown as AiIsaContent;
    expect(narrowsPrevious(CONTENT, nested)).toBe(false);
    expect(policyFieldChanges(CONTENT, nested)).toEqual([{ key: 'caps.perHour', change: 'wider', known: false }]);
    expect(policyFieldChange('shareOpenHouses', true, true)).toBe('wider');
    expect(narrowsPrevious(CONTENT, { ...CONTENT, capabilities: 'converse' } as unknown as AiIsaContent)).toBe(false);
    expect(narrowsPrevious(CONTENT, { ...CONTENT, caps: null } as unknown as AiIsaContent)).toBe(false);
    expect(narrowsPrevious(CONTENT, null as unknown as AiIsaContent)).toBe(false);
    expect(policyFieldChange('caps.ai24h', 2, '1')).toBe('wider');
    expect(policyFieldChange('cadence', '3d', '2d')).toBe('wider');
    // a name inherited from Object is not a rule
    expect(policyFieldChange('toString', 1, 1)).toBe('wider');
    expect(policyFieldChange('constructor', 1, 1)).toBe('wider');
  });

  it('the same choices in another order are the same', () => {
    expect(policyFieldChange('capabilities', ['converse', 'share_listings'], ['share_listings', 'converse'])).toBe('same');
    expect(policyFieldChanges(mid, mid)).toEqual([]);
  });
});

