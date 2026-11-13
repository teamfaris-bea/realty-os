// Pure units of isa/buyer/criteria.ts (R-ISA-17, R-ISA-27).
import type { Instant } from '@realty/core/foundation';
import { describe, expect, it } from 'vitest';
import type { UsableQualClaim } from '../coreSeam.js';
import { criteriaFromClaims } from './criteria.js';

const c = (field: UsableQualClaim['field'], value: UsableQualClaim['value'], at = 1, id = `c${at}${field}`): UsableQualClaim => ({ claimId: id, field, value, quote: String(value), messageId: 'm', saidAt: at as Instant });

describe('criteriaFromClaims (R-ISA-17)', () => {
  it('R-ISA-17: a location is required (CRITERIA_INCOMPLETE without one)', () => {
    expect(criteriaFromClaims([c('budget', 500000), c('beds_min', 3)])).toBeNull();
  });
  it('R-ISA-17: areas → postal codes or cities; budget → priceMaxCents; beds; baths ×10; type; never keywords', () => {
    const r = criteriaFromClaims([c('areas', ['02139', 'Springfield']), c('budget', 450000), c('beds_min', 3), c('baths_min', 2.5), c('property_type', 'condo')])!;
    expect(r.criteria).toEqual({ postalCodes: ['02139'], cities: [{ city: 'Springfield' }], priceMaxCents: 45_000_000, bedsMin: 3, bathsMinX10: 25, propertyTypes: ['condo'] });
    expect(Object.keys(r.criteria)).not.toContain('keywords');
  });
  it('R-ISA-27: the latest claim per field wins; an injected locality is dropped', () => {
    const r = criteriaFromClaims([c('areas', 'Oldtown', 1), c('areas', 'Newtown', 2), c('budget', 300000, 1), c('budget', 350000, 3)])!;
    expect(r.criteria.cities).toEqual([{ city: 'Newtown' }]);
    expect(r.criteria.priceMaxCents).toBe(35_000_000);
    expect(criteriaFromClaims([c('areas', 'text 555-0100 the price')])).toBeNull();
  });
});
