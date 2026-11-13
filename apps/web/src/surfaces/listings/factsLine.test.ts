// R-MLS-7: a listing line states a size only when the listing has one. An unknown size is left out, never shown as
// 0 or a guess (the listings pages show team listings; MLS rows reach the web only through API views that carry the
// same null). E603.
import { describe, expect, it } from 'vitest';
import { factsLine } from './ListingsPages.js';

describe('R-MLS-7 E603: listing lines never state a size they do not have', () => {
  it('E603 R-MLS-7: an unknown size is left out; a known one is shown as given', () => {
    expect(factsLine({ beds: 3, bathsX10: 20, sqft: null })).toBe('3 bd · 2 ba');
    expect(factsLine({ beds: null, bathsX10: null, sqft: null })).toBe('');
    expect(factsLine({ beds: 3, bathsX10: 25, sqft: 1650 })).toBe('3 bd · 2.5 ba · 1,650 sq ft');
    expect(factsLine({ beds: 3, bathsX10: 20, sqft: null })).not.toMatch(/sq ft|\b0\b/);
  });
});
