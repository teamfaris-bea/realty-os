// Targeted cases for fairhousing/check.ts that the mutation run (>= 90 %, PHASE2_3_PLAN §6) needs:
// window and frame edges, de-duplication, soft-inside-hard suppression, ordering, grammar edges.
import { describe, expect, it } from 'vitest';
import { check, compilePattern, DEFAULT_FAIR_HOUSING_PACK as PACK, type FairHousingPack, hasAnyMatch, type Term } from './index.js';

const pack = (hard: Term[], soft: Term[] = [], exemptions: FairHousingPack['exemptions'] = []): FairHousingPack => ({ ...PACK, hard, soft, exemptions });
const T = (id: string, ...patterns: string[]): Term => ({ id, label: id, class: 'familial_status', patterns });

describe('fair-housing check: edges (R-FH-1, R-FH-5)', () => {
  it('R-FH-1: a `*` gap never takes a word from the next sentence, nor runs off the end', () => {
    const p = pack([T('x.t', 'no * kids')]);
    expect(check('no. x kids', p).hard).toEqual([]);
    expect(check('no', p).hard).toEqual([]);
    expect(check('no x', p).hard).toEqual([]);
  });

  it('R-FH-5: a match starting on the first or last word of a frame is negated', () => {
    const ex = [{ id: 'x.f', effect: 'anti_discrimination' as const, patterns: ['fair housing families'] }];
    expect(check('fair housing families', pack([T('x.a', 'fair housing')], [], ex)).soft[0]).toMatchObject({ negated: true });
    expect(check('fair housing families', pack([T('x.b', 'families')], [], ex)).soft[0]).toMatchObject({ negated: true });
  });

  it('R-FH-5: a match before a frame is not negated', () => {
    expect(check('Adults only, regardless of anything.', PACK).hard.map((m) => m.termId)).toEqual(['fh.familial.adults_only']);
  });

  it('R-FH-1: one term over one span is reported once; different spans are kept', () => {
    expect(check('no kids', pack([T('x.t', 'no kids', 'no kids')])).hard).toHaveLength(1);
    expect(check('no kids please', pack([T('x.t', 'no kids', 'no kids please')])).hard.map((m) => m.text)).toEqual(['no kids please', 'no kids']);
    expect(check('no kids please', pack([T('x.t', 'kids please', 'no kids please')])).hard.map((m) => m.text)).toEqual(['no kids please', 'kids please']);
    expect(check('no kids', pack([T('x.a', 'no kids'), T('x.b', 'no kids')])).hard.map((m) => m.termId)).toEqual(['x.a', 'x.b']);
  });

  it('R-FH-1: a soft match is dropped only when a hard match covers it entirely', () => {
    const p = pack([T('x.h', 'kids only')], [T('x.s1', 'no kids'), T('x.s2', 'only please'), T('x.s3', 'kids')]);
    const r = check('no kids only please', p);
    expect(r.hard.map((m) => m.termId)).toEqual(['x.h']);
    expect(r.soft.map((m) => m.termId)).toEqual(['x.s1', 'x.s2']);
  });

  it('R-FH-1: results are ordered by start, then longer first, then term id', () => {
    const p = pack([T('x.b', 'no kids'), T('x.a', 'no kids'), T('x.c', 'no'), T('x.d', 'no kids please')]);
    expect(check('no kids please', p).hard.map((m) => m.termId)).toEqual(['x.d', 'x.a', 'x.b', 'x.c']);
  });

  it('R-FH-1: patterns tolerate surrounding and repeated spaces', () => {
    expect(compilePattern('  no   kids ').tokens).toHaveLength(2);
    expect(() => compilePattern('?')).toThrow(/bad word/);
    expect(() => compilePattern('no ? kids')).toThrow(/bad word/);
  });

  it('R-FH-1: a spelled-out run needs the whole word, not only a prefix', () => {
    expect(check('n o w a y', PACK).hard).toEqual([]);
    expect(check('n o c h i l d r e n', PACK).hard.map((m) => m.termId)).toContain('fh.familial.no_children');
  });

  it('hasAnyMatch is true for any hard or soft match only', () => {
    const m = check('No kids', PACK).hard[0] as never;
    expect(hasAnyMatch({ hard: [], soft: [] })).toBe(false);
    expect(hasAnyMatch({ hard: [m], soft: [] })).toBe(true);
    expect(hasAnyMatch({ hard: [], soft: [m] })).toBe(true);
  });
});
