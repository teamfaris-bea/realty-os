// The review reply privacy guard (module 53): examples and properties. DATA_MODEL R-GBP-1; E132, E469.
import { DEFAULT_FAIR_HOUSING_PACK } from '@realty/core/fairhousing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type GuardCode, fold, guardReply } from './guard.js';

const FH = DEFAULT_FAIR_HOUSING_PACK;
const g = (text: string, reviewer: string | null = 'Reviewer Alpha') => guardReply(text, { reviewerDisplay: reviewer, fairHousing: FH }).codes;
const CLEAN = ['Thank you for taking the time to share this.', 'We are glad the move went smoothly.', 'We appreciate the kind words and hope to work with you again.', 'Thanks for the feedback; we will pass it on to the team.'];

describe('guardReply examples (R-GBP-1)', () => {
  it('R-GBP-1: an ordinary thank-you passes', () => {
    for (const t of CLEAN) expect(g(t), t).toEqual([]);
  });

  it('E132 E469 R-GBP-1: the reviewer\'s name, a price, an address, a date, contact details and deal terms are refused, each with its code', () => {
    const cases: [string, GuardCode][] = [
      ['Thank you, Alpha!', 'REVIEWER_NAME'],
      ['Thanks REVIEWER for the review.', 'REVIEWER_NAME'],
      ['Glad we got you $425,000 for it.', 'MONEY'],
      ['We sold it for 15k over asking.', 'MONEY'],
      ['A 3% bump at the end.', 'MONEY'],
      ['Congratulations on 1200 square feet of joy.', 'MONEY'],
      ['Enjoy 42 Harbor View Rd!', 'ADDRESS'],
      ['See you at 7 Oak Street.', 'ADDRESS'],
      ['Since March 3rd it has been great.', 'DATE'],
      ['Since 3/14 it has been great.', 'DATE'],
      ['Write to us at team@example.test.', 'CONTACT'],
      ['Call us on (555) 010-0199.', 'CONTACT'],
      ['Glad the inspection went well.', 'DEAL'],
      ['Happy the closing was smooth.', 'DEAL'],
      ['Your lender was great too.', 'DEAL'],
      ['Thanks! Perfect for young families.', 'FAIR_HOUSING'],
      [`Thanks! ${'Very kind. '.repeat(160)}`, 'LENGTH'],
    ];
    for (const [t, code] of cases) expect(g(t), t).toContain(code);
  });

  it('R-GBP-1: the reviewer\'s name is caught in any case or accent form; one-letter initials are not names', () => {
    expect(g('Thank you, Jose.', 'José Núñez')).toContain('REVIEWER_NAME');
    expect(g('Thank you NUNEZ family.', 'José Núñez')).toContain('REVIEWER_NAME');
    expect(g('Thank you, núñez.', 'Jose Nunez')).toContain('REVIEWER_NAME');
    expect(g('Thank you so much.', 'J. K.')).toEqual([]);
  });

  it('R-GBP-1: soft fair-housing matches are warnings, not refusals; spans point into the text, never copy it', () => {
    const r = guardReply('Thank you, Alpha! Enjoy 42 Harbor View Rd.', { reviewerDisplay: 'Reviewer Alpha', fairHousing: FH });
    expect(r.codes).toEqual(['REVIEWER_NAME', 'ADDRESS']);
    for (const s of r.spans) expect(Object.keys(s).sort()).toEqual(['code', 'end', 'start']);
    expect(fold('ÀÉÎ Straße')).toHaveLength('ÀÉÎ Straße'.length);
  });
});

const TOKENS: [string, GuardCode][] = [
  ['Alpha', 'REVIEWER_NAME'], ['$900', 'MONEY'], ['250k', 'MONEY'], ['12 Elm Street', 'ADDRESS'], ['June 4', 'DATE'], ['4/6', 'DATE'],
  ['someone@example.test', 'CONTACT'], ['555 010 0199', 'CONTACT'], ['escrow', 'DEAL'], ['under contract', 'DEAL'], ['commission', 'DEAL'],
];
const variant = fc.constantFrom<(s: string) => string>((s) => s, (s) => s.toUpperCase(), (s) => s.toLowerCase());

describe('guardReply properties (R-GBP-1)', () => {
  it('R-GBP-1: deterministic: the same text and reviewer always give the same codes and spans', () => {
    fc.assert(fc.property(fc.string({ maxLength: 300 }), fc.option(fc.string({ maxLength: 40 }), { nil: null }), (t, r) => {
      expect(guardReply(t, { reviewerDisplay: r, fairHousing: FH })).toEqual(guardReply(t, { reviewerDisplay: r, fairHousing: FH }));
    }), { numRuns: 300 });
  });

  it('R-GBP-1: monotonic: adding a refused token to a passing reply makes it fail with that token\'s code', () => {
    fc.assert(fc.property(fc.constantFrom(...CLEAN), fc.constantFrom(...TOKENS), variant, fc.boolean(), (clean, [tok, code], v, before) => {
      const text = before ? `${v(tok)} ${clean}` : `${clean} ${v(tok)}`;
      expect(g(text)).toContain(code);
    }), { numRuns: 500 });
  });

  it('R-GBP-1: the reviewer\'s name fails in any case or diacritic form, wherever it sits', () => {
    const NAMES = ['Zoë', 'Renée', 'Åsa', 'Ólafur', 'Chloé', 'Noël'];
    const strip = (s: string) => s.normalize('NFKD').replace(/\p{M}/gu, '');
    fc.assert(fc.property(fc.constantFrom(...NAMES), fc.constantFrom(...CLEAN), variant, fc.boolean(), fc.boolean(), (name, clean, v, plain, before) => {
      const shown = v(plain ? strip(name) : name);
      const text = before ? `${shown}, ${clean}` : `${clean} ${shown}.`;
      expect(guardReply(text, { reviewerDisplay: `${name} Reviewer` }).codes).toContain('REVIEWER_NAME');
    }), { numRuns: 400 });
  });
});
