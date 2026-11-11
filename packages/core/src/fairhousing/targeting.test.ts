import { describe, expect, expectTypeOf, it } from 'vitest';
import { attributeKeyWords, classifyAttributeKey, DEFAULT_TARGETING_LIMITS, type TargetingSpec, validateTargeting } from './index.js';

describe('targeting validator (R-FH-4)', () => {
  it('R-FH-4: compile time: TargetingSpec cannot express a protected attribute, a ZIP or prediction output', () => {
    const ok: TargetingSpec = { geo: 'radius_of_listing', radiusMiles: 15 };
    expect(ok.radiusMiles).toBe(15);
    // @ts-expect-error ageMin is typed never
    const a: TargetingSpec = { geo: 'radius_of_listing', radiusMiles: 15, ageMin: 25 };
    // @ts-expect-error zip is typed never
    const z: TargetingSpec = { geo: 'radius_of_listing', radiusMiles: 15, zip: '30301' };
    // @ts-expect-error familialStatus is typed never
    const f: TargetingSpec = { geo: 'radius_of_listing', radiusMiles: 15, familialStatus: 'with_children' };
    // @ts-expect-error predictionBand is typed never
    const p: TargetingSpec = { geo: 'radius_of_listing', radiusMiles: 15, predictionBand: 'likely_90d' };
    // @ts-expect-error an unknown field is an excess property
    const u: TargetingSpec = { geo: 'radius_of_listing', radiusMiles: 15, incomeBracket: 'high' };
    // @ts-expect-error only a radius around the listing exists
    const g: TargetingSpec = { geo: 'zip_list', radiusMiles: 15 };
    expect([a, z, f, p, u, g]).toHaveLength(6);
    expectTypeOf<TargetingSpec['ageMin']>().toEqualTypeOf<undefined>();
    expectTypeOf<keyof TargetingSpec & 'geo'>().toEqualTypeOf<'geo'>();
  });

  it('R-FH-4: a radius around the listing passes', () => {
    expect(validateTargeting({ geo: 'radius_of_listing', radiusMiles: 20 })).toEqual({ ok: true, spec: { geo: 'radius_of_listing', radiusMiles: 20 } });
    expect(validateTargeting({ geo: 'radius_of_listing', radiusMiles: DEFAULT_TARGETING_LIMITS.minRadiusMiles }).ok).toBe(true);
    expect(validateTargeting({ geo: 'radius_of_listing', radiusMiles: DEFAULT_TARGETING_LIMITS.maxRadiusMiles }).ok).toBe(true);
  });

  const refused: [unknown, RegExp][] = [
    [{ geo: 'radius_of_listing', radiusMiles: 20, ageMin: 25 }, /ageMin: a protected class/],
    [{ geo: 'radius_of_listing', radiusMiles: 20, gender: 'female' }, /gender: a protected class/],
    [{ geo: 'radius_of_listing', radiusMiles: 20, zip: ['30301'] }, /zip: ZIP or neighborhood geography/],
    [{ geo: 'radius_of_listing', radiusMiles: 20, neighborhoodIds: [1] }, /neighborhoodIds: ZIP or neighborhood geography/],
    [{ geo: 'radius_of_listing', radiusMiles: 20, likelyToMove: true }, /likelyToMove: prediction output/],
    [{ geo: 'radius_of_listing', radiusMiles: 20, lifeEvents: ['new_baby'] }, /lifeEvents: a life event/],
    [{ geo: 'radius_of_listing', radiusMiles: 20, interests: ['parenting'] }, /interests: a stand-in for a protected class/],
    [{ geo: 'radius_of_listing', radiusMiles: 20, lookalikeOf: 'x' }, /lookalikeOf: a stand-in/],
    [{ geo: 'radius_of_listing', radiusMiles: 20, colorPreference: 'x' }, /colorPreference: a protected class/],
    [{ geo: 'radius_of_listing', radiusMiles: 20, budget: 5 }, /budget: not an allowed targeting field/],
    [{ geo: 'zip_list', radiusMiles: 20 }, /geo: only "radius_of_listing"/],
    [{ geo: 'radius_of_listing' }, /radiusMiles: a number of miles is required/],
    [{ geo: 'radius_of_listing', radiusMiles: Number.NaN }, /radiusMiles: a number/],
    [{ geo: 'radius_of_listing', radiusMiles: '20' }, /radiusMiles: a number/],
    [{ geo: 'radius_of_listing', radiusMiles: 1 }, /must be between 15 and 50/],
    [{ geo: 'radius_of_listing', radiusMiles: 51 }, /must be between 15 and 50/],
    [null, /must be an object/],
    [[{ geo: 'radius_of_listing' }], /must be an object/],
    ['radius', /must be an object/],
  ];
  for (const [spec, re] of refused) {
    it(`R-FH-4: refuses ${JSON.stringify(spec)}`, () => {
      const r = validateTargeting(spec);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues.join('\n')).toMatch(re);
    });
  }

  it('R-FH-4: custom limits apply (VERIFY: platform radius rules)', () => {
    expect(validateTargeting({ geo: 'radius_of_listing', radiusMiles: 10 }, { minRadiusMiles: 5, maxRadiusMiles: 10 }).ok).toBe(true);
    expect(validateTargeting({ geo: 'radius_of_listing', radiusMiles: 11 }, { minRadiusMiles: 5, maxRadiusMiles: 10 }).ok).toBe(false);
  });

  it('R-FH-4: every issue is reported, not only the first', () => {
    const r = validateTargeting({ geo: 'zip', radiusMiles: 2, age: 3, religion: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.issues).toHaveLength(4);
  });
});

describe('attribute classification (shared with core/predict and core/ads)', () => {
  it('splits keys into words', () => {
    expect(attributeKeyWords('ageMin')).toEqual(['age', 'min']);
    expect(attributeKeyWords('zip_codes')).toEqual(['zip', 'codes']);
    expect(attributeKeyWords('HouseholdSize')).toEqual(['household', 'size']);
  });
  const cases: [string, ReturnType<typeof classifyAttributeKey>][] = [
    ['age', 'protected_class'],
    ['ageMin', 'protected_class'],
    ['householdComposition', 'protected_proxy'],
    ['numberOfChildren', 'protected_class'],
    ['familyStatus', 'protected_class'],
    ['ethnicityGuess', 'protected_class'],
    ['religiousAffiliation', 'protected_class'],
    ['disabled', 'protected_class'],
    ['nationalOrigin', 'protected_class'],
    ['pcsOrders', 'life_event'],
    ['militaryStatus', 'protected_class'],
    ['primaryLanguage', 'protected_proxy'],
    ['zipCode', 'geography'],
    ['neighbourhoods', 'geography'],
    ['censusTract', 'geography'],
    ['predictedBand', 'prediction_output'],
    ['lifeEvent', 'life_event'],
    ['first_name', 'identity'],
    ['married', 'protected_class'],
    ['marriageDate', 'protected_class'],
    ['gendered', 'protected_class'],
    ['yearsInHome', null],
    ['storage', null],
    ['mileage', null],
    ['radiusMiles', null],
    ['equityBand', 'prediction_output'],
  ];
  for (const [k, c] of cases) {
    it(`R-FH-4: ${k} → ${String(c)}`, () => {
      expect(classifyAttributeKey(k)).toBe(c);
    });
  }
});
