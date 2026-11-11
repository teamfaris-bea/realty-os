// Adversarial tests for core/fairhousing (critical module): attempts to get discriminatory copy
// past the check, to launder a hard term through an equal-opportunity frame, to tamper with the
// built-in pack, and to smuggle protected or proxy targeting through the runtime validator.
import { describe, expect, it } from 'vitest';
import { check, DEFAULT_FAIR_HOUSING_PACK as PACK, fairHousingPackFrom, guardAssistantOutput, validateTargeting } from './index.js';

const hard = (t: string): number => check(t, PACK).hard.length;

describe('adversarial: hiding a hard term (R-FH-1)', () => {
  const disguised = [
    'N​o k‌ids', // zero-width non-joiner and space
    '‮no kids', // bidi override
    'NO   KIDS', // extra spaces
    'no kids', // no-break space
    'no kids', // em space
    'no-kids', // hyphen
    'no_kids', // underscore
    'no/kids', // slash
    'n0 k!ds'.replace('!', 'i'), // leetspeak
    'n.o k.i.d.s', // dotted letters: a dot between letters is not a sentence end
    'ａｄｕｌｔｓ ｏｎｌｙ', // full width
    '𝐀𝐝𝐮𝐥𝐭𝐬 𝐨𝐧𝐥𝐲', // mathematical bold
    'Αdults οnly', // Greek capital alpha, omicron
    'perfect for young fam­ilies', // soft hyphen inside the word
    'Perfect for young families', // escaped but ordinary letter
    "Ideal for a growin' family".replace("growin'", 'growing'),
  ];
  for (const t of disguised) {
    it(`R-FH-1: "${t}" is still a hard match`, () => {
      expect(hard(t)).toBeGreaterThan(0);
    });
  }

  it('R-FH-1: assistant output with a disguised term is never autonomous (R-FH-2)', () => {
    for (const t of disguised) expect(guardAssistantOutput(`Hi! ${t}. — the Smith Team assistant`, PACK).autonomousAllowed).toBe(false);
  });

  it('R-FH-1: a very long text with a term at the end is still caught (no early exit)', () => {
    const t = `${'Lovely updated home with a big yard. '.repeat(400)}Adults only.`;
    expect(hard(t)).toBe(1);
  });
});

describe('adversarial: laundering through a frame or exemption (R-FH-5)', () => {
  it('R-FH-5: a frame in another sentence or far away does not downgrade', () => {
    expect(hard('Fair housing. No kids.')).toBeGreaterThan(0);
    expect(hard('Regardless of the market today and tomorrow, adults only')).toBeGreaterThan(0);
  });

  it('R-FH-5: a downgraded term still reaches a person: assistant output stays a draft', () => {
    const r = guardAssistantOutput('Equal housing: adults only. — the Smith Team assistant', PACK);
    expect(r.hard).toEqual([]);
    expect(r.soft.length).toBeGreaterThan(0);
    expect(r.autonomousAllowed).toBe(false);
  });

  it('R-FH-5: a property-type exemption next to a hard term does not hide it', () => {
    expect(hard('Family room. No families.')).toBeGreaterThan(0);
    expect(hard('Single-family home, adults only')).toBeGreaterThan(0);
    expect(hard('Church Street: Christian home')).toBeGreaterThan(0);
  });

  it('R-FH-5: the built-in pack cannot be edited at run time', () => {
    expect(() => {
      (PACK.hard as unknown as unknown[]).length = 0;
    }).toThrow();
    expect(() => {
      (PACK as { reviewedByCounselAt: string | null }).reviewedByCounselAt = '2027-01-01';
    }).toThrow();
    expect(() => {
      (PACK.hard[0] as unknown as { patterns: string[] }).patterns.push('x');
    }).toThrow();
    expect(hard('No kids')).toBeGreaterThan(0);
    expect(PACK.reviewedByCounselAt).toBeNull();
  });

  it('R-FH-5: jurisdiction data cannot remove or rename a built-in hard term', () => {
    const r = fairHousingPackFrom({ rules: { lexicon_version: 'fh/1', hard: [] }, reviewedByCounselAt: null }, [{ soft: [] }, { hard: [] }]);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.pack.hard.map((t) => t.id)).toEqual(PACK.hard.map((t) => t.id));
      expect(check('No kids', r.pack).hard.length).toBeGreaterThan(0);
    }
    expect(fairHousingPackFrom({ rules: { lexicon_version: 'fh/1', extra: 1, hard: [{ id: 'fh.familial.no_children', label: 'x', class: 'age', patterns: ['zzz'] }] }, reviewedByCounselAt: null }).ok).toBe(false);
  });

  it('R-FH-5: a hostile pattern cannot become a regular expression (no regex injection)', () => {
    expect(fairHousingPackFrom({ rules: { lexicon_version: 'fh/1', hard: [{ id: 'x.re', label: 'x', class: 'race', patterns: ['(a+)+$'] }] }, reviewedByCounselAt: null }).ok).toBe(false);
    expect(fairHousingPackFrom({ rules: { lexicon_version: 'fh/1', soft: [{ id: 'x.re', label: 'x', class: 'race', patterns: ['.*'] }] }, reviewedByCounselAt: null }).ok).toBe(false);
  });
});

describe('adversarial: smuggling targeting (R-FH-4)', () => {
  it('R-FH-4: a __proto__ or constructor key does not slip past', () => {
    const spec = JSON.parse('{"geo":"radius_of_listing","radiusMiles":20,"__proto__":{"ageMin":18}}') as unknown;
    const r = validateTargeting(spec);
    expect(r.ok).toBe(false);
    const r2 = validateTargeting({ geo: 'radius_of_listing', radiusMiles: 20, constructor: { zip: 1 } });
    expect(r2.ok).toBe(false);
  });

  it('R-FH-4: the returned spec is a fresh object with only geo and radius', () => {
    const input = { geo: 'radius_of_listing', radiusMiles: 20 };
    const r = validateTargeting(input);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.spec).not.toBe(input);
      expect(Object.keys(r.spec)).toEqual(['geo', 'radiusMiles']);
    }
  });

  it('R-FH-4: casing and separators do not disguise a protected key', () => {
    for (const k of ['AGE_MIN', 'Zip-Code', 'religion ', 'Household.Size', 'FAMILY']) {
      const r = validateTargeting({ geo: 'radius_of_listing', radiusMiles: 20, [k]: 1 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues[0]).toMatch(/cannot be used for targeting/);
    }
  });

  it('R-FH-4: an infinite or negative radius is refused', () => {
    for (const r of [Number.POSITIVE_INFINITY, -20, 0]) expect(validateTargeting({ geo: 'radius_of_listing', radiusMiles: r }).ok).toBe(false);
  });
});
