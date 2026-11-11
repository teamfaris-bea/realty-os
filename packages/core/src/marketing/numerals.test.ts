import { describe, expect, it } from 'vitest';
import { foldNumerals, numeralIssues } from './index.js';

const shapes = (t: string) => numeralIssues(t).map((h) => h.shape);

describe('R-MKT-3: price and date numerals in copy (what is caught)', () => {
  const caught: readonly [string, string][] = [
    ['Offered at $450k', 'price'],
    ['Offered at $450,000.', 'price'],
    ['now 450,000', 'price'],
    ['now 450000', 'price'],
    ['under 1.2M', 'price'],
    ['under 450 thousand', 'price'],
    ['€450', 'price'],
    ['USD 450', 'price'],
    ['in the 400s', 'price'],
    ['Nov 12', 'date'],
    ['November 12th', 'date'],
    ['12 November', 'date'],
    ['12/11', 'date'],
    ['12/11/2026', 'date'],
    ['2026-11-12', 'date'],
    ['12.11.2026', 'date'],
    ['Saturday the 12th', 'date'],
    ['from 2pm', 'time'],
    ['from 2 p.m.', 'time'],
    ['at 10:30', 'time'],
    ['built in 1925', 'year'],
    ['a 1920s bungalow', 'year'],
    ['four hundred fifty thousand dollars', 'number_words'],
    ['half a million', 'number_words'],
    ['under a million', 'number_words'],
    ['two grand off', 'number_words'],
    ['fifty dollars', 'number_words'],
    ['November twelfth', 'number_words'],
    ['the twelfth of November', 'number_words'],
    ['Saturday the twelfth', 'number_words'],
    ["at two o'clock", 'number_words'],
    ['from three pm', 'number_words'],
  ];
  for (const [t, shape] of caught) {
    it(`R-MKT-3: "${t}" is a ${shape} numeral`, () => {
      expect(shapes(t)).toContain(shape);
    });
  }
});

describe('R-MKT-3: what is not caught (counts, not prices or dates)', () => {
  const clean = [
    '3 bedrooms and a 2-car garage',
    '2.5 baths',
    '450 sq ft workshop',
    'Primary suite on the 2nd floor',
    'Open Saturday',
    'Quiet in November',
    'the first floor has an office',
    'Gym open 24/7',
    'four fifty', // known gap: bare number words without a money word
    'this weekend', // relative dates are not numerals
  ];
  for (const t of clean) {
    it(`R-MKT-3: "${t}" passes`, () => {
      expect(numeralIssues(t)).toEqual([]);
    });
  }

  it('R-MKT-3: "3/2" and "1/2 acre" are flagged as date-shaped (errs towards flagging)', () => {
    expect(shapes('a 3/2 ranch')).toEqual(['date']);
    expect(shapes('on 1/2 acre')).toEqual(['date']);
  });
});

describe('R-MKT-3: folding', () => {
  it('R-MKT-3: full-width digits fold to ASCII', () => {
    expect(foldNumerals('４５０k')).toBe('450k');
  });
  it('R-MKT-3: an O between digits is a zero, spaced single digits run together', () => {
    expect(foldNumerals('45Ok')).toBe('450k');
    expect(foldNumerals('4 5 0 k')).toBe('450 k');
  });
});
