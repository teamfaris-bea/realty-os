import { describe, expect, it } from 'vitest';
import { check, DEFAULT_FAIR_HOUSING_PACK, fairHousingPackFrom, fairHousingReviewState } from './index.js';

const platform = { rules: { lexicon_version: 'fh/1' }, reviewedByCounselAt: null };

describe('fair-housing pack data (R-FH-5, R-INT-6)', () => {
  it('R-FH-5 R-INT-6: the platform pack as seeded (fh/1, unreviewed) gives the built-in lexicon, unreviewed', () => {
    const r = fairHousingPackFrom(platform);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pack.reviewedByCounselAt).toBeNull();
      expect(r.pack.hard).toEqual(DEFAULT_FAIR_HOUSING_PACK.hard);
      expect(r.pack.soft).toEqual(DEFAULT_FAIR_HOUSING_PACK.soft);
    }
  });

  it('R-FH-5: the review instant is carried from the platform pack', () => {
    const r = fairHousingPackFrom({ ...platform, reviewedByCounselAt: '2027-01-05T00:00:00Z' });
    expect(r.ok && r.pack.reviewedByCounselAt).toBe('2027-01-05T00:00:00Z');
  });

  it('R-FH-5: an unknown lexicon version or malformed rules is a refusal, never a fallback', () => {
    expect(fairHousingPackFrom({ rules: { lexicon_version: 'fh/9' }, reviewedByCounselAt: null })).toEqual({ ok: false, code: 'FAIR_HOUSING_LEXICON_UNKNOWN', detail: 'fh/9' });
    expect(fairHousingPackFrom({ rules: {}, reviewedByCounselAt: null })).toMatchObject({ ok: false, code: 'FAIR_HOUSING_PACK_INVALID' });
    expect(fairHousingPackFrom({ rules: null, reviewedByCounselAt: null })).toMatchObject({ ok: false, code: 'FAIR_HOUSING_PACK_INVALID' });
    expect(
      fairHousingPackFrom({ rules: { lexicon_version: 'fh/1', hard: [{ id: 'x.bad', label: 'x', class: 'race', patterns: ['* x'] }] }, reviewedByCounselAt: null }),
    ).toMatchObject({ ok: false, code: 'FAIR_HOUSING_PACK_INVALID' });
    expect(fairHousingPackFrom(platform, [{ hard: [{ id: 'x.y', label: 'x', class: 'not_a_class', patterns: ['x'] }] }])).toMatchObject({ ok: false, code: 'FAIR_HOUSING_PACK_INVALID' });
  });

  it('R-FH-5: a jurisdiction adds terms (stricter) and cannot reuse a built-in id', () => {
    const r = fairHousingPackFrom(platform, [{ hard: [{ id: 'st.x.vets', label: 'excludes veterans', class: 'military_status', patterns: ['civilians only'] }] }]);
    expect(r.ok).toBe(true);
    if (r.ok) expect(check('Civilians only', r.pack).hard.map((m) => m.termId)).toEqual(['st.x.vets']);
    expect(fairHousingPackFrom(platform, [{ hard: [{ id: 'fh.military.excludes', label: 'x', class: 'military_status', patterns: ['x'] }] }])).toMatchObject({
      ok: false,
      detail: 'duplicate id fh.military.excludes',
    });
  });

  it('R-FH-5: a jurisdiction can escalate a soft term to hard, but not invent one', () => {
    const r = fairHousingPackFrom(platform, [{ escalate_to_hard: ['fh.religion.mention'] }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(check('Near the church', r.pack).hard.map((m) => m.termId)).toEqual(['fh.religion.mention']);
      expect(r.pack.soft.some((t) => t.id === 'fh.religion.mention')).toBe(false);
    }
    expect(fairHousingPackFrom(platform, [{ escalate_to_hard: ['fh.nope'] }])).toMatchObject({ ok: false, detail: 'escalate_to_hard: unknown soft term fh.nope' });
  });

  it('R-FH-5: the UI text says plainly when the lexicon has not been reviewed', () => {
    expect(fairHousingReviewState(DEFAULT_FAIR_HOUSING_PACK)).toEqual({
      reviewed: false,
      text: 'The fair-housing wording list (fh/1) has not been reviewed by counsel yet. Pieces are checked against it, and publishing stays off until it is reviewed.',
    });
    expect(fairHousingReviewState({ lexiconVersion: 'fh/1', reviewedByCounselAt: '2027-01-05T10:00:00Z' })).toEqual({
      reviewed: true,
      text: 'The fair-housing wording list (fh/1) was reviewed by counsel on 2027-01-05.',
    });
  });
});
