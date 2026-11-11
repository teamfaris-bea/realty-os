// Property tests for the marketing guard (critical module): R-FH-1, R-MKT-1, R-MKT-3.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HARD_FIXTURES, SOFT_FIXTURES } from '../fairhousing/testing/fixtures.js';
import { guardPasses, guardResult, guardResultMatches, renderPiece, type BrokerageIdentity, type RenderedPiece } from './index.js';
import { FH, IDENTITY, SHA, STRICT, teamListing, withProse } from './testing/fixtures.js';

// "wide" is excluded: "a single wide" is a home type the lexicon exempts (not a reference to a person).
const SAFE_WORDS = ['Lovely', 'home', 'with', 'a', 'deck', 'near', 'the', 'park', 'bright', 'kitchen', 'and', 'big', 'windows', 'quiet', 'street'];
const safeText = fc.array(fc.constantFrom(...SAFE_WORDS), { minLength: 0, maxLength: 8 }).map((w) => w.join(' '));
const HARD = Object.values(HARD_FIXTURES).flat();

const render = (body: string, identity: BrokerageIdentity = IDENTITY): RenderedPiece => {
  const r = renderPiece(withProse('website_page', { body }), teamListing(), identity, STRICT);
  if (!r.ok) throw new Error(r.reason);
  return r;
};

const fold = (x: string): string =>
  x
    .normalize('NFKC')
    .replace(/\p{Default_Ignorable_Code_Point}/gu, '')
    .replace(/\s+/gu, ' ')
    .trim()
    .toLowerCase();

const ordinal = (d: number): string => {
  if (d % 100 >= 11 && d % 100 <= 13) return `${d}th`;
  return `${d}${['th', 'st', 'nd', 'rd'][d % 10] ?? 'th'}`;
};

describe('guardResult properties', () => {
  it('R-FH-1: any prose containing a hard fixture phrase has hard_count > 0 and never passes', () => {
    fc.assert(
      fc.property(safeText, fc.constantFrom(...HARD), safeText, (pre, phrase, post) => {
        const g = guardResult(render(`${pre} ${phrase} ${post}.`), IDENTITY, STRICT, FH, SHA);
        expect(g.hard_count).toBeGreaterThan(0);
        expect(guardPasses(g, SHA)).toBe(false);
      }),
      { numRuns: 300 },
    );
  });

  it('R-FH-1 R-FH-2: soft-only copy is listed but never blocks', () => {
    fc.assert(
      fc.property(safeText, fc.constantFrom(...SOFT_FIXTURES), (pre, s) => {
        const g = guardResult(render(`${pre}. ${s.text}`), IDENTITY, STRICT, FH, SHA);
        expect(g.hard_count).toBe(0);
        expect(g.soft.length).toBeGreaterThan(0);
        expect(guardPasses(g, SHA)).toBe(true);
      }),
    );
  });

  const MONTHS = ['Jan', 'February', 'Mar', 'April', 'May', 'June', 'Jul', 'Aug', 'Sept', 'Oct', 'November', 'Dec'];
  const priceOrDate = fc.oneof(
    fc.integer({ min: 1, max: 9999 }).map((n) => `$${n}k`),
    fc.tuple(fc.integer({ min: 1, max: 999 }), fc.integer({ min: 0, max: 999 })).map(([a, b]) => `${a},${String(b).padStart(3, '0')}`),
    fc.integer({ min: 1000, max: 99_999_999 }).map(String),
    fc.integer({ min: 1, max: 999 }).map((n) => `${n}k`),
    fc.tuple(fc.constantFrom(...MONTHS), fc.integer({ min: 1, max: 31 })).map(([m, d]) => `${m} ${d}`),
    fc.tuple(fc.integer({ min: 1, max: 12 }), fc.integer({ min: 1, max: 31 })).map(([m, d]) => `${m}/${d}`),
    fc.integer({ min: 1, max: 31 }).map((d) => `the ${ordinal(d)}`),
    fc.tuple(fc.integer({ min: 1, max: 12 }), fc.constantFrom('am', 'pm', 'PM', 'p.m.')).map(([h, x]) => `${h}${x}`),
  );

  it('R-MKT-3: any prose with a price- or date-shaped numeral fails', () => {
    fc.assert(
      fc.property(safeText, priceOrDate, safeText, (pre, n, post) => {
        const g = guardResult(render(`${pre} ${n} ${post}`), IDENTITY, STRICT, FH, SHA);
        expect(g.numeral_issues.length).toBeGreaterThan(0);
        expect(g.pack_rule_failures.some((f) => f.rule_id === 'R-MKT-3')).toBe(true);
        expect(guardPasses(g, SHA)).toBe(false);
      }),
      { numRuns: 400 },
    );
  });

  it('R-MKT-1: brokerage_name_present is false whenever the identity name is missing from the rendered output', () => {
    const name = fc.string({ minLength: 1, maxLength: 30 }).map((s) => `Zq${s}Brokerage`);
    fc.assert(
      fc.property(name, (n) => {
        const r = render('A bright home.'); // rendered with the fixture identity
        const g = guardResult(r, { ...IDENTITY, brokerageLegalName: n }, STRICT, FH, SHA);
        expect(fold(r.text).includes(fold(n))).toBe(false);
        expect(g.brokerage_name_present).toBe(false);
        expect(guardPasses(g, SHA)).toBe(false);
      }),
    );
  });

  it('R-MKT-1: the identity used for rendering is always present', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 40 }).filter((s) => fold(s) !== ''),
        (n) => {
          const id = { ...IDENTITY, brokerageLegalName: n, teamName: n };
          const g = guardResult(render('A bright home.', id), id, STRICT, FH, SHA);
          expect(g.brokerage_name_present).toBe(true);
        },
      ),
    );
  });

  it('R-MKT-1 R-GATE-12: content_sha256 is echoed verbatim and matches no other hash', () => {
    const hex = fc.stringMatching(/^[0-9a-f]{64}$/);
    fc.assert(
      fc.property(hex, hex, (a, b) => {
        const g = guardResult(render('A bright home.'), IDENTITY, STRICT, FH, a);
        expect(g.content_sha256).toBe(a);
        expect(guardResultMatches(g, a)).toBe(true);
        expect(guardResultMatches(g, b)).toBe(a === b);
        expect(guardPasses(g, b)).toBe(a === b);
      }),
    );
  });
});
