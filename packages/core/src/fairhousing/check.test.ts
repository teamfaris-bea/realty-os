import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { check, compilePattern, DEFAULT_FAIR_HOUSING_PACK as PACK, FAIR_HOUSING_LEXICON_VERSION, type FairHousingPack } from './index.js';
import { tokenize } from './normalize.js';
import { CLEAN_FIXTURES, HARD_FIXTURES, SOFT_FIXTURES } from './testing/fixtures.js';

const hardIds = (t: string): string[] => check(t, PACK).hard.map((m) => m.termId);
const softIds = (t: string): string[] => check(t, PACK).soft.map((m) => m.termId);

describe('fair-housing check: the fixture set (R-FH-1, R-FH-5)', () => {
  it('R-FH-5: every hard term in the pack has fixtures, and the pack ships unreviewed', () => {
    expect(new Set(Object.keys(HARD_FIXTURES))).toEqual(new Set(PACK.hard.map((t) => t.id)));
    expect(PACK.reviewedByCounselAt).toBeNull();
    expect(PACK.lexiconVersion).toBe(FAIR_HOUSING_LEXICON_VERSION);
  });

  for (const [termId, phrases] of Object.entries(HARD_FIXTURES)) {
    for (const p of phrases) {
      it(`R-FH-1: zero false negatives: "${p}" is a hard ${termId}`, () => {
        expect(hardIds(p)).toContain(termId);
      });
    }
  }

  for (const t of CLEAN_FIXTURES) {
    it(`R-FH-5: ordinary copy is not flagged: "${t}"`, () => {
      const r = check(t, PACK);
      expect([...r.hard, ...r.soft]).toEqual([]);
    });
  }

  for (const f of SOFT_FIXTURES) {
    it(`R-FH-5: "${f.text}" is soft ${f.termId}, not hard`, () => {
      expect(hardIds(f.text)).toEqual([]);
      expect(softIds(f.text)).toContain(f.termId);
    });
  }
});

describe('fair-housing check: E93 and the named plan tests', () => {
  it('E93 R-FH-1: "perfect for young families" is a hard match; "family room" is not flagged', () => {
    const r = check('Perfect for young families, with a big family room.', PACK);
    expect(r.hard.map((m) => [m.termId, m.text])).toContainEqual(['fh.familial.ideal_occupant', 'Perfect for young families']);
    expect([...r.hard, ...r.soft].some((m) => m.text.toLowerCase().includes('family room'))).toBe(false);
    expect(check('A big family room.', PACK)).toEqual({ hard: [], soft: [] });
  });

  it('E93: "great for young families" flagged; "great for hosting family gatherings" is only a soft mention', () => {
    expect(hardIds('great for young families')).toContain('fh.familial.ideal_occupant');
    expect(hardIds('great for hosting family gatherings')).toEqual([]);
    expect(softIds('great for hosting family gatherings')).toEqual(['fh.familial.mention']);
  });

  it('R-FH-1: offsets point at the original words, case and punctuation preserved', () => {
    const text = 'Lovely home. ADULTS-ONLY building!';
    const [m] = check(text, PACK).hard;
    expect(m).toMatchObject({ termId: 'fh.familial.adults_only', start: 13, end: 24, text: 'ADULTS-ONLY', negated: false, severity: 'hard', class: 'familial_status' });
  });

  it('R-FH-1: a soft mention inside a hard match is not repeated', () => {
    const r = check('No families.', PACK);
    expect(r.hard.map((m) => m.termId)).toEqual(['fh.familial.no_children']);
    expect(r.soft).toEqual([]);
  });

  it('R-FH-1: results are ordered by position', () => {
    const r = check('Adults only. No section 8. Christian home.', PACK);
    expect(r.hard.map((m) => m.termId)).toEqual(['fh.familial.adults_only', 'fh.income.excludes', 'fh.religion.only']);
    const starts = r.hard.map((m) => m.start);
    expect([...starts].sort((a, b) => a - b)).toEqual(starts);
  });

  it('R-FH-1: the same term matched by two patterns over one span is reported once', () => {
    // "childfree" matches one pattern; "child free" another; the same text never doubles
    expect(check('childfree', PACK).hard).toHaveLength(1);
  });
});

describe('fair-housing check: negation awareness (R-FH-5)', () => {
  it('R-FH-5: a bare negation never hides a match ("no children", "not for families")', () => {
    expect(hardIds('There are no children allowed.')).toContain('fh.familial.no_children');
    expect(hardIds('This home is not for families.')).toContain('fh.familial.no_children');
  });

  it('R-FH-5: an equal-opportunity frame downgrades a hard match to a negated soft match', () => {
    const r = check('We welcome all, regardless of familial status or children.', PACK);
    expect(r.hard).toEqual([]);
    expect(r.soft.some((m) => m.negated && m.termId === 'fh.familial.mention')).toBe(true);
    const r2 = check('We do not discriminate against families with kids.', PACK);
    expect(r2.hard).toEqual([]);
    expect(r2.soft.length).toBeGreaterThan(0);
    expect(r2.soft.find((m) => m.text === 'families')).toMatchObject({ negated: true });
    expect(r2.soft.find((m) => m.text === 'kids')).toMatchObject({ negated: false }); // 4 words after the frame
  });

  it('R-FH-5: a frame covers only the next 3 words of the same sentence', () => {
    // far away in the same sentence: still hard
    expect(hardIds('Regardless of what you have heard about the area, no kids.')).toContain('fh.familial.no_children');
    // in the next sentence: still hard
    expect(hardIds('Equal housing opportunity. Adults only.')).toContain('fh.familial.adults_only');
    // right after the frame: downgraded
    const r = check('Equal housing: adults only.', PACK);
    expect(r.hard).toEqual([]);
    expect(r.soft[0]).toMatchObject({ termId: 'fh.familial.adults_only', negated: true, severity: 'soft' });
  });

  it('R-FH-5: a match starting inside a frame counts as negated', () => {
    const pack: FairHousingPack = {
      ...PACK,
      hard: [{ id: 'x.t', label: 't', class: 'familial_status', patterns: ['housing families'] }],
      soft: [],
      exemptions: [{ id: 'x.f', effect: 'anti_discrimination', patterns: ['fair housing families'] }],
    };
    expect(check('fair housing families', pack)).toMatchObject({ hard: [], soft: [{ termId: 'x.t', negated: true }] });
  });

  it('R-FH-5: exactly at the window edge the frame applies; one word further it does not', () => {
    const pack: FairHousingPack = {
      ...PACK,
      hard: [{ id: 'x.t', label: 't', class: 'familial_status', patterns: ['banned'] }],
      soft: [],
      exemptions: [{ id: 'x.f', effect: 'anti_discrimination', patterns: ['regardless of'] }],
    };
    expect(check('regardless of aa bb banned', pack).soft).toHaveLength(1); // 3 tokens after the frame end
    expect(check('regardless of aa bb cc banned', pack).hard).toHaveLength(1); // 4 tokens after
  });
});

describe('fair-housing check: normalization (obfuscation cannot hide a term)', () => {
  const cases: [string, string][] = [
    ['zero-width space', 'No chi​ldren'],
    ['soft hyphen', 'adults­only'.replace('­', '­-')],
    ['Cyrillic look-alikes', 'Nо kіds'],
    ['full-width letters', 'Ｎｏ ｋｉｄｓ'],
    ['leetspeak', 'n0 k1ds'],
    ['spelled out', 'n o k i d s'],
    ['apostrophe', "Not suitable for children's toys or children"],
    ['line break', 'No\nchildren'.replace('\n', ' \t ')],
    ['upper case', 'ADULTS ONLY'],
    ['combining marks', 'No kíds'],
  ];
  for (const [name, text] of cases) {
    it(`R-FH-1: ${name} is still a hard match`, () => {
      expect(check(text, PACK).hard.length).toBeGreaterThan(0);
    });
  }

  it('R-FH-1: a phrase never spans two sentences', () => {
    expect(hardIds('Say no. Kids love the yard.')).toEqual([]);
    expect(hardIds('Adults. Only the best.')).toEqual([]);
  });

  it('tokenize keeps original offsets and sentence numbers', () => {
    const t = tokenize('Hi! Fa​mily, ok');
    expect(t.map((x) => [x.text, x.start, x.end, x.sentence])).toEqual([
      ['hi', 0, 2, 0],
      ['family', 4, 11, 1],
      ['ok', 13, 15, 1],
    ]);
    expect(tokenize('$500 for 4br').map((x) => x.text)).toEqual(['500', 'for', 'abr']);
    expect(tokenize('a b c d').map((x) => [x.text, x.merged])).toEqual([['abcd', true]]);
    expect(tokenize('a b').map((x) => x.text)).toEqual(['a', 'b']);
    expect(tokenize('a b. c d').map((x) => x.text)).toEqual(['a', 'b', 'c', 'd']);
    expect(tokenize("children's").map((x) => x.text)).toEqual(['childrens']);
    expect(tokenize("'quoted'").map((x) => x.text)).toEqual(['quoted']);
    expect(tokenize('55+ community').map((x) => x.text)).toEqual(['55+', 'community']);
  });

  it('a merged spelled-out run matches only patterns without wildcards', () => {
    expect(hardIds('f o r a d u l t s o n l y')).toContain('fh.familial.adults_only');
    expect(hardIds('p e r f e c t f o r k i d s')).toContain('fh.familial.ideal_occupant'); // alternatives expand
    expect(hardIds('n o t s u i t a b l e f o r k i d s')).toContain('fh.familial.no_children');
    expect(hardIds('n o t s u i t a b l e f o r m y k i d s')).toContain('fh.familial.no_children'); // a `*` gap
    expect(hardIds('h o m e')).toEqual([]);
  });
});

describe('fair-housing check: the pattern grammar', () => {
  it('compiles words, prefixes, alternatives, optional words and gaps', () => {
    expect(compilePattern('no kid|kids').squeezed.source).toBe('(?:no)(?:kid|kids)');
    expect(compilePattern('famil* x').squeezed.test('familiesx')).toBe(true);
    expect(compilePattern('55+ only').squeezed.test('55+only')).toBe(true);
    expect(compilePattern('55+ only').squeezed.test('555only')).toBe(false);
    expect(compilePattern('famil*').tokens).toEqual([{ kind: 'alt', optional: false, options: [{ word: 'famil', prefix: true }] }]);
    expect(compilePattern('for a|the? kids').tokens[1]).toEqual({ kind: 'alt', optional: true, options: [{ word: 'a', prefix: false }, { word: 'the', prefix: false }] });
    expect(compilePattern('not * kids').tokens[1]).toEqual({ kind: 'any' });
    expect(['forakids', 'forkids'].map((t) => compilePattern('for a? kids').squeezed.test(t))).toEqual([true, true]);
    expect(compilePattern('not * kids').squeezed.test('notmykids')).toBe(true);
  });

  it('refuses malformed patterns', () => {
    expect(() => compilePattern('*')).toThrow(/needs at least one word/);
    expect(() => compilePattern('a?')).toThrow(/needs at least one word/);
    expect(() => compilePattern('* kids')).toThrow(/cannot start or end/);
    expect(() => compilePattern('kids *')).toThrow(/cannot start or end/);
    expect(() => compilePattern('the? kids')).toThrow(/cannot start or end/);
    expect(() => compilePattern('kids the?')).toThrow(/cannot start or end/);
    expect(() => compilePattern('Kids')).toThrow(/bad word/);
    expect(() => compilePattern('ki-ds')).toThrow(/bad word/);
    expect(() => compilePattern('a||b')).toThrow(/bad word/);
  });

  it('`*` matches zero or one word, never two, and not across sentences', () => {
    const pack: FairHousingPack = { ...PACK, hard: [{ id: 'x.t', label: 't', class: 'age', patterns: ['no * kids'] }], soft: [], exemptions: [] };
    expect(check('no kids', pack).hard).toHaveLength(1);
    expect(check('no small kids', pack).hard).toHaveLength(1);
    expect(check('no very small kids', pack).hard).toHaveLength(0);
    expect(check('no. kids', pack).hard).toHaveLength(0);
    expect(check('no x. kids', pack).hard).toHaveLength(0);
  });

  it('optional words match with or without the word', () => {
    const pack: FairHousingPack = { ...PACK, hard: [{ id: 'x.t', label: 't', class: 'age', patterns: ['for a|the? kids'] }], soft: [], exemptions: [] };
    expect(check('for kids', pack).hard).toHaveLength(1);
    expect(check('for the kids', pack).hard).toHaveLength(1);
    expect(check('for my kids', pack).hard).toHaveLength(0);
  });

  it('prefix words match longer tokens; exact words do not', () => {
    const pack: FairHousingPack = { ...PACK, hard: [{ id: 'x.t', label: 't', class: 'age', patterns: ['kid', 'teen*'] }], soft: [], exemptions: [] };
    expect(check('kids', pack).hard).toHaveLength(0);
    expect(check('kid', pack).hard).toHaveLength(1);
    expect(check('teenagers', pack).hard).toHaveLength(1);
  });

  it('not_a_reference drops a match whose last word is in the exempt phrase, and only that', () => {
    expect(check('family room', PACK)).toEqual({ hard: [], soft: [] });
    // the hard match ends on "families", which is not inside "family room"
    expect(hardIds('Ideal for families; family room too')).toContain('fh.familial.ideal_occupant');
    // last word inside the exemption: "perfect for single" ends on "single" of "single family"
    expect(hardIds('perfect for single family living')).toEqual([]);
  });
});

describe('fair-housing check: properties', () => {
  const words = ['home', 'yard', 'room', 'kitchen', 'quiet', 'garage', 'bright', 'near', 'park', 'updated', 'deck', 'with', 'and', 'the'];
  it('R-FH-1: appending a hard fixture anywhere always yields a hard match (no context can hide it)', () => {
    const phrases = Object.values(HARD_FIXTURES).flat();
    fc.assert(
      fc.property(fc.array(fc.constantFrom(...words), { maxLength: 12 }), fc.array(fc.constantFrom(...words), { maxLength: 12 }), fc.constantFrom(...phrases), (pre, post, p) => {
        const text = `${pre.join(' ')}. ${p} ${post.length > 0 ? '. ' : ''}${post.join(' ')}`;
        return check(text, PACK).hard.length > 0;
      }),
      { numRuns: 300 },
    );
  });

  it('R-FH-5: plain property words never match', () => {
    fc.assert(fc.property(fc.array(fc.constantFrom(...words), { maxLength: 30 }), (w) => {
      const r = check(w.join(' '), PACK);
      return r.hard.length === 0 && r.soft.length === 0;
    }));
  });

  it('check is deterministic and every match slice equals the original text', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 120 }), fc.constantFrom(...Object.values(HARD_FIXTURES).flat()), (noise, p) => {
        const text = `${noise} ${p}`;
        const a = check(text, PACK);
        const b = check(text, PACK);
        return JSON.stringify(a) === JSON.stringify(b) && [...a.hard, ...a.soft].every((m) => text.slice(m.start, m.end) === m.text);
      }),
      { numRuns: 200 },
    );
  });
});
