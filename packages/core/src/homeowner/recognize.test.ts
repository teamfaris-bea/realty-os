import { describe, expect, it } from 'vitest';
import { attachPropertyRecord } from '../predict/index.js';
import { canonicalRegion, connectorCountyOf, connectorZips, countyOf, isSouthCarolina } from './counties.js';
import { isEntityOwner, personOwnerNames } from './owners.js';
import { reasonsFrom, subjectsFor, type CandidateAddress } from './recognize.js';
import { TEAM_CLOSING_SOURCE, yearsOwned } from './years.js';

const addr = (id: string, kind: CandidateAddress['kind'], createdAt: string, complete = true): CandidateAddress => ({
  id, kind, line1: complete ? `${id} Sample Way` : null, line2: null, city: 'Exampleton', region: 'SC', postalCode: '29902', createdAt,
});

describe('recognition and subjects (R-HOME-1, R-HOME-2)', () => {
  it('R-HOME-1: each of the four reasons recognises a contact, in a fixed order; none means not recognised', () => {
    expect(reasonsFrom({ sellerIntent: false, sellerInquiry: false, homeownerTag: false, pastBuyer: false })).toEqual([]);
    expect(reasonsFrom({ sellerIntent: true, sellerInquiry: true, homeownerTag: true, pastBuyer: true })).toEqual(['seller_intent', 'seller_inquiry', 'homeowner_tag', 'past_buyer']);
    expect(reasonsFrom({ sellerIntent: false, sellerInquiry: false, homeownerTag: true, pastBuyer: false })).toEqual(['homeowner_tag']);
  });

  it('R-HOME-2: K2\'s address of any kind first, then home, then property, oldest first; never a mailing or interest address otherwise; at most three', () => {
    const a = [
      addr('m1', 'mailing', '2020-01-01'),
      addr('i1', 'interest', '2020-01-01'),
      addr('p1', 'property', '2019-01-01'),
      addr('h2', 'home', '2022-01-01'),
      addr('h1', 'home', '2021-01-01'),
      addr('k2', 'mailing', '2023-01-01'),
    ];
    expect(subjectsFor(['past_buyer'], a, ['k2']).map((x) => x.id)).toEqual(['k2', 'h1', 'h2']);
    expect(subjectsFor(['seller_intent'], a, ['k2']).map((x) => x.id)).toEqual(['h1', 'h2', 'p1']); // K2 counts only for a past buyer
    expect(subjectsFor(['seller_intent'], [addr('m1', 'mailing', '2020-01-01'), addr('i1', 'interest', '2020-01-01')], [])).toEqual([]);
    expect(subjectsFor([], a, ['k2'])).toEqual([]);
  });

  it('R-HOME-2 E560: an incomplete address is never a subject, so a person with only incomplete ones has none; ties break by id', () => {
    const a = [addr('hb', 'home', '2021-01-01'), addr('ha', 'home', '2021-01-01'), addr('hx', 'home', '2020-01-01', false)];
    expect(subjectsFor(['homeowner_tag'], a, []).map((x) => x.id)).toEqual(['ha', 'hb']);
  });
});

describe('county routing (R-HOME-2, R-HOME-5)', () => {
  it('R-HOME-2: a Beaufort ZIP routes to the connector', () => {
    expect(countyOf({ region: 'SC', postalCode: '29902' })).toEqual({ key: 'sc-beaufort', mode: 'connector' });
    expect(countyOf({ region: 'SC', postalCode: '29902-1234' })).toEqual({ key: 'sc-beaufort', mode: 'connector' });
  });

  it('R-HOME-2 R-HOME-5 E575 E576: a shared ZIP tries Beaufort and also names Jasper; a Jasper ZIP is links only', () => {
    expect(countyOf({ region: 'SC', postalCode: '29910' })).toEqual({ mode: 'shared', try: 'sc-beaufort', also: 'sc-jasper' });
    expect(countyOf({ region: 'SC', postalCode: '29936' })).toEqual({ key: 'sc-jasper', mode: 'links' });
    expect(connectorCountyOf(countyOf({ region: 'SC', postalCode: '29910' }))).toBe('sc-beaufort');
    expect(connectorCountyOf(countyOf({ region: 'SC', postalCode: '29936' }))).toBeNull();
  });

  it('R-HOME-2 R-HOME-5 E577: another state, an unlisted or malformed ZIP has no county; "South Carolina" and "S.C." count as SC', () => {
    expect(isSouthCarolina('South Carolina')).toBe(true);
    expect(isSouthCarolina('s.c.')).toBe(true);
    expect(countyOf({ region: 'South Carolina', postalCode: '29902' })).toEqual({ key: 'sc-beaufort', mode: 'connector' });
    expect(countyOf({ region: 'GA', postalCode: '29902' })).toBeNull();
    expect(countyOf({ region: 'SC', postalCode: '29401' })).toBeNull();
    expect(countyOf({ region: 'SC', postalCode: '2990' })).toBeNull();
    expect(canonicalRegion({ line1: 'x', city: 'y', region: 'South Carolina', postalCode: '29902' }).region).toBe('SC');
  });

  it('R-HOME-2: connectorZips is Beaufort plus the shared ZIPs, five digits each', () => {
    const z = connectorZips();
    expect(z).toContain('29902');
    expect(z).toContain('29910');
    expect(z).not.toContain('29936');
    for (const x of z) expect(x).toMatch(/^\d{5}$/);
  });
});

describe('the entity-owner filter (R-HOME-3)', () => {
  it('R-HOME-3 E564: entity owners are dropped before attach, person owners kept, "A & B" split', () => {
    expect(personOwnerNames(['SAMPLE HOLDINGS LLC', 'SAMPLE OWNER A & SAMPLE FAMILY TRUST', 'SAMPLE L.L.C.', 'ESTATE OF SAMPLE OWNER B', 'FIRST SAMPLE BANK'])).toEqual(['SAMPLE OWNER A']);
    expect(isEntityOwner('SAMPLE OWNER A TRUSTEE')).toBe(true);
    expect(isEntityOwner('SAMPLE INCE')).toBe(false); // whole words only
  });

  // b11 reconciliation homeowner-2: the brief's E563 (name formats on the real layer are verify_items 14)
  it('R-HOME-3 E563: "SAMPLE OWNER A & SAMPLE OWNER B" matches either owner; "DOE JOHN & JANE" does not match Jane Doe', () => {
    const address = { line1: '1 Sample Way', city: 'Exampleton', region: 'SC', postalCode: '29902' };
    const record = (owner: string) => ({ address, ownerNames: personOwnerNames([owner]) });
    expect(personOwnerNames(['SAMPLE OWNER A & SAMPLE OWNER B'])).toEqual(['SAMPLE OWNER A', 'SAMPLE OWNER B']);
    expect(attachPropertyRecord(record('SAMPLE OWNER A & SAMPLE OWNER B'), { address, names: ['Sample Owner B'] })).toEqual({ attach: true, ownerNameMatch: true });
    expect(attachPropertyRecord(record('SAMPLE OWNER A & SAMPLE OWNER B'), { address, names: ['Owner A Sample'] })).toEqual({ attach: true, ownerNameMatch: true });
    expect(attachPropertyRecord(record('DOE JOHN & JANE'), { address, names: ['John Doe'] })).toEqual({ attach: true, ownerNameMatch: true });
    expect(attachPropertyRecord(record('DOE JOHN & JANE'), { address, names: ['Jane Doe'] })).toEqual({ attach: false, reason: 'needs_review', detail: 'owner_name_mismatch' });
  });

  it('R-HOME-3 E564: a record naming only entities attaches to no one (missing_data)', () => {
    const address = { line1: '1 Sample Way', city: 'Exampleton', region: 'SC', postalCode: '29902' };
    const d = attachPropertyRecord({ address, ownerNames: personOwnerNames(['SAMPLE OWNER A LLC']) }, { address, names: ['Sample Owner A LLC', 'Sample Owner A'] });
    expect(d).toEqual({ attach: false, reason: 'needs_review', detail: 'missing_data' });
  });
});

describe('years owned (R-HOME-4)', () => {
  const t = (value: string) => ({ value, source: 'Beaufort County GIS parcel layer', asOf: null });
  it('R-HOME-4: whole years by floor(days / 365.25), naming its date and source', () => {
    expect(yearsOwned(t('2015-06-01'), '2026-11-12')).toEqual({ years: 11, since: '2015-06-01', basis: 'county_transfer', source: 'Beaufort County GIS parcel layer', asOf: null });
    expect(yearsOwned(t('2026-11-12'), '2026-11-12')?.years).toBe(0);
  });
  it('R-HOME-4: leap days: a 2020-02-29 transfer is 4 years on 2024-02-29 and 3 the day before', () => {
    expect(yearsOwned(t('2020-02-29'), '2024-02-29')?.years).toBe(4);
    expect(yearsOwned(t('2020-02-29'), '2024-02-28')?.years).toBe(3);
  });
  it('R-HOME-4 E582: with no county transfer date, the team closing the caller passes counts instead and is named as the source', () => {
    expect(yearsOwned(null, '2026-11-12', '2021-03-15')).toEqual({ years: 5, since: '2021-03-15', basis: 'team_closing', source: TEAM_CLOSING_SOURCE, asOf: null });
    expect(yearsOwned(undefined, '2026-11-12', '2021-03-15')?.basis).toBe('team_closing');
    // the county's date wins whenever there is one
    expect(yearsOwned(t('2015-06-01'), '2026-11-12', '2021-03-15')).toMatchObject({ years: 11, since: '2015-06-01', basis: 'county_transfer' });
    // the same bounds: a future closing or a malformed one gives null
    expect(yearsOwned(null, '2026-11-12', '2026-12-01')).toBeNull();
    expect(yearsOwned(null, '2026-11-12', 'not a date')).toBeNull();
    expect(yearsOwned(null, '2026-11-12', null)).toBeNull();
  });
  it('R-HOME-4: a future date, more than 150 years back, or no date gives null', () => {
    expect(yearsOwned(t('2026-11-13'), '2026-11-12')).toBeNull();
    expect(yearsOwned(t('1850-01-01'), '2026-11-12')).toBeNull();
    expect(yearsOwned(null, '2026-11-12')).toBeNull();
  });
});
