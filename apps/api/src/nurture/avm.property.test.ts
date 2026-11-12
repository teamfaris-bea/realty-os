// Property tests of the home-value decisions as api/nurture wires them (wave 2C; R-AVM-1, R-AVM-2, R-AST-13):
// core avmSendable over arbitrary estimates and limits, and the vendor-answer parser over arbitrary input.
import { type AvmEstimate, avmSendable, homeValueText } from '@realty/core/nurture';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { parseAvmAnswer, vendorText } from './avm.js';
import { literal } from './decide.js';

const day = fc.integer({ min: 0, max: 400 }).map((d) => new Date(Date.UTC(2026, 0, 1) + d * 86_400_000).toISOString().slice(0, 10));
const money = fc.integer({ min: 0, max: 5_000_000_000 });
const estimateArb: fc.Arbitrary<AvmEstimate> = fc.record({
  status: fc.constantFrom('ok' as const, 'unavailable' as const, 'error' as const),
  valueCents: fc.option(money, { nil: null }),
  lowCents: fc.option(money, { nil: null }),
  highCents: fc.option(money, { nil: null }),
  asOf: fc.option(fc.oneof(day, fc.constant('not-a-date')), { nil: null }),
  displayAllowed: fc.boolean(),
  provider: fc.constant('P'),
});
const settingsArb = fc.record({ maxRangeBps: fc.integer({ min: 100, max: 10_000 }), maxJumpBps: fc.integer({ min: 0, max: 10_000 }), maxAgeDays: fc.integer({ min: 0, max: 90 }), today: day });
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

describe('R-AVM-2 avmSendable (property)', () => {
  it('R-AVM-2: never ok when not cleared, not ok, stale, not displayable, too wide or over the jump limit', () => {
    fc.assert(
      fc.property(estimateArb, fc.option(estimateArb, { nil: null }), settingsArb, fc.boolean(), (e, prior, s, cleared) => {
        const d = avmSendable(e, prior, s, cleared);
        if (!d.ok) return;
        expect(cleared).toBe(true);
        expect(e.status).toBe('ok');
        expect(e.valueCents).not.toBeNull();
        expect(e.displayAllowed).toBe(true);
        expect(e.asOf).not.toBeNull();
        expect(days(e.asOf!, s.today)).toBeLessThanOrEqual(s.maxAgeDays);
        expect(((e.highCents! - e.lowCents!) * 10_000) / e.valueCents!).toBeLessThanOrEqual(s.maxRangeBps);
        if (prior !== null && prior.status === 'ok' && prior.valueCents !== null && prior.valueCents > 0) expect((Math.abs(e.valueCents! - prior.valueCents) * 10_000) / prior.valueCents).toBeLessThanOrEqual(s.maxJumpBps);
        // and the message then always carries the R-AVM-1 sentence
        expect(homeValueText(e)).toMatch(/This is an estimate, not an appraisal\.$/);
      }),
      { numRuns: 2000 },
    );
  });

  it('R-AVM-2: tightening any limit (range, jump, age) or withdrawing clearance never turns a refusal into ok', () => {
    fc.assert(
      fc.property(estimateArb, fc.option(estimateArb, { nil: null }), settingsArb, fc.boolean(), fc.record({ range: fc.nat(5_000), jump: fc.nat(5_000), age: fc.nat(60) }), (e, prior, s, cleared, by) => {
        const loose = avmSendable(e, prior, s, cleared);
        const tight = { ...s, maxRangeBps: Math.max(0, s.maxRangeBps - by.range), maxJumpBps: Math.max(0, s.maxJumpBps - by.jump), maxAgeDays: Math.max(0, s.maxAgeDays - by.age) };
        if (!loose.ok) {
          expect(avmSendable(e, prior, tight, cleared).ok).toBe(false);
          expect(avmSendable(e, prior, s, false).ok).toBe(false);
        }
      }),
      { numRuns: 2000 },
    );
  });

  it('R-AVM-2 E99: an estimate that is not ok is always UNAVAILABLE (a skip "No estimate available."), never a draft that could say "unchanged"', () => {
    fc.assert(
      fc.property(estimateArb.filter((e) => e.status !== 'ok'), fc.option(estimateArb, { nil: null }), settingsArb, fc.boolean(), (e, prior, s, cleared) => {
        expect(avmSendable(e, prior, s, cleared)).toEqual({ ok: false, reason: 'UNAVAILABLE' });
        expect(homeValueText(e)).toBeNull();
      }),
    );
  });
});

describe('the vendor-answer parser (R-AVM-1, N8, R-AST-13)', () => {
  const anything = fc.anything({ withNullPrototype: false });
  it('R-AVM-1: an unavailable or unparseable answer never yields a value; display is granted only by a literal true; no confidence or score survives', () => {
    fc.assert(
      fc.property(
        fc.record({ available: fc.oneof(fc.boolean(), anything), valueCents: fc.oneof(money, anything), lowCents: fc.oneof(money, anything), highCents: fc.oneof(money, anything), asOf: fc.oneof(day, anything), provider: fc.oneof(fc.string(), anything), displayAllowed: fc.oneof(fc.boolean(), fc.constantFrom('true', 1, 'yes'), anything), confidence: anything, score: anything }, { requiredKeys: [] }),
        (raw) => {
          const p = parseAvmAnswer(raw);
          if (p === null) return;
          expect(Object.keys(p).some((k) => /confidence|score/i.test(k))).toBe(false);
          if (p.status === 'unavailable') {
            expect(Object.keys(p).sort()).toEqual(['provider', 'status']);
            return;
          }
          expect(raw.available).toBe(true);
          expect(p.displayAllowed).toBe(raw.displayAllowed === true);
          expect(p.lowCents).toBeLessThanOrEqual(p.highCents);
          expect(p.valueCents).toBeGreaterThan(0);
        },
      ),
      { numRuns: 2000 },
    );
    expect(parseAvmAnswer({ available: true, valueCents: 10, lowCents: 9, highCents: 11, asOf: '2026-11-01', provider: 'P', displayAllowed: 'true' })).toMatchObject({ displayAllowed: false });
    expect(parseAvmAnswer({ available: true, valueCents: 10, lowCents: 9, highCents: 11, asOf: '2026-11-01', provider: 'P' })).toMatchObject({ displayAllowed: false });
    expect(parseAvmAnswer({ available: false, valueCents: 10, provider: 'P' })).toEqual({ status: 'unavailable', provider: 'P' });
    expect(parseAvmAnswer({ available: true, valueCents: 10, lowCents: 9, highCents: 11, asOf: '2026-02-30', provider: 'P' })).toBeNull();
  });

  it('vendor strings never carry template markers, line breaks, control or bidi characters into a message', () => {
    fc.assert(
      fc.property(fc.string({ unit: fc.constantFrom('{', '}', '\n', '\r', '\t', '‮', '⁦', '‏', '\u0000', '\u0085', 'a', ' ', '<') , maxLength: 60 }), (s) => {
        for (const out of [literal(s), vendorText(s, 80) ?? '']) {
          expect(out).not.toMatch(/\{\{|\}\}/);
          // eslint-disable-next-line no-control-regex
          expect(out).not.toMatch(/[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/);
        }
      }),
      { numRuns: 2000 },
    );
  });
});
