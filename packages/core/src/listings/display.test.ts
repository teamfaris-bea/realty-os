import { describe, expect, it } from 'vitest';
import { applyDisplayRules, marketingEligible } from './display.js';
import { STRICTEST_LICENSE_PACK, parseLicensePack } from './licence.js';
import { REVIEWED_PACK, mls, team } from './testing/fixtures.js';
import { DISPLAY_FIELDS, type LicensePack } from './types.js';

const unreviewed: LicensePack = { ...REVIEWED_PACK, reviewedByCounselAt: null };

describe('applyDisplayRules: agent audience', () => {
  it('R-MLS-4: the agent always sees an MLS listing, labelled MLS, with its brokerage and never as the team\'s own', () => {
    for (const pack of [STRICTEST_LICENSE_PACK, REVIEWED_PACK]) {
      const d = applyDisplayRules(mls({ displayAllowed: false, addressDisplayAllowed: false }), pack, 'agent');
      expect(d).not.toBeNull();
      expect(d).toMatchObject({ audience: 'agent', source: 'mls', sourceLabel: 'MLS', isTeamListing: false, listingBrokerageName: 'Other Brokerage LLC' });
      expect(d?.omittedFields).toEqual([]);
      expect(d?.address).toEqual({ line1: '12 Oak St', line2: null });
      expect(d?.listPriceCents).toBe(45_000_000);
    }
  });

  it('R-MLS-4: agent view carries the pack\'s attribution and disclaimer when the pack has them', () => {
    expect(applyDisplayRules(mls(), REVIEWED_PACK, 'agent')).toMatchObject({
      attribution: REVIEWED_PACK.attributionText,
      disclaimer: REVIEWED_PACK.disclaimerText,
    });
    expect(applyDisplayRules(mls(), STRICTEST_LICENSE_PACK, 'agent')).toMatchObject({ attribution: null, disclaimer: null });
  });
});

describe('applyDisplayRules: client and public audiences', () => {
  it('R-MLS-2: client audience returns null while the licence pack is not counsel-reviewed', () => {
    expect(applyDisplayRules(mls(), unreviewed, 'client')).toBeNull();
    expect(applyDisplayRules(mls(), unreviewed, 'public')).toBeNull();
  });

  it('R-MLS-2: the empty (default) pack shows nothing to clients or the public: never "allowed" by default', () => {
    const empty = parseLicensePack({});
    expect(empty).toEqual(STRICTEST_LICENSE_PACK);
    expect(applyDisplayRules(mls(), empty, 'client')).toBeNull();
    expect(applyDisplayRules(mls(), empty, 'public')).toBeNull();
    // reviewed but nothing else configured: still nothing (no attribution, no statuses)
    const reviewedOnly = parseLicensePack({ reviewed_by_counsel_at: '2026-10-15T09:00:00Z' });
    expect(applyDisplayRules(mls(), reviewedOnly, 'client')).toBeNull();
  });

  it('R-MLS-2 E86: display_allowed=false is never shown to clients', () => {
    const optedOut = mls({ displayAllowed: false });
    expect(applyDisplayRules(optedOut, REVIEWED_PACK, 'client')).toBeNull();
    expect(applyDisplayRules(optedOut, REVIEWED_PACK, 'public')).toBeNull();
    expect(applyDisplayRules(optedOut, REVIEWED_PACK, 'agent')).not.toBeNull();
  });

  it('R-MLS-2: attribution and disclaimer are always carried for client and public; a pack missing either shows nothing', () => {
    for (const audience of ['client', 'public'] as const) {
      const d = applyDisplayRules(mls(), REVIEWED_PACK, audience);
      expect(d?.attribution).toBe(REVIEWED_PACK.attributionText);
      expect(d?.disclaimer).toBe(REVIEWED_PACK.disclaimerText);
      expect(applyDisplayRules(mls(), { ...REVIEWED_PACK, attributionText: null }, audience)).toBeNull();
      expect(applyDisplayRules(mls(), { ...REVIEWED_PACK, disclaimerText: null }, audience)).toBeNull();
    }
  });

  it('R-MLS-4: a client rendering carries the listing brokerage and isTeamListing:false; without a brokerage it is refused unless the pack waives it', () => {
    expect(applyDisplayRules(mls(), REVIEWED_PACK, 'client')).toMatchObject({ sourceLabel: 'MLS', isTeamListing: false, listingBrokerageName: 'Other Brokerage LLC' });
    expect(applyDisplayRules(mls({ listingBrokerageName: null }), REVIEWED_PACK, 'client')).toBeNull();
    const waived = applyDisplayRules(mls({ listingBrokerageName: null }), { ...REVIEWED_PACK, requireListingBrokerage: false }, 'client');
    expect(waived).toMatchObject({ isTeamListing: false, listingBrokerageName: null });
  });

  it('R-MLS-2: the street address is hidden when the feed disallows address display, even if the pack allows the field', () => {
    const d = applyDisplayRules(mls({ addressDisplayAllowed: false }), REVIEWED_PACK, 'client');
    expect(d?.addressHidden).toBe(true);
    expect(d?.address).toBeUndefined();
    expect(d?.omittedFields).toContain('address');
    expect(d?.locality).toEqual({ city: 'Austin', region: 'TX', postalCode: '78701' });
    const shown = applyDisplayRules(mls(), REVIEWED_PACK, 'client');
    expect(shown?.addressHidden).toBe(false);
    expect(shown?.address).toEqual({ line1: '12 Oak St', line2: null });
  });

  it('R-MLS-2: fields the pack does not allow for the audience are dropped and named', () => {
    const d = applyDisplayRules(mls(), REVIEWED_PACK, 'public');
    expect(d).not.toBeNull();
    expect(Object.keys(d ?? {}).filter((k) => ['mlsNumber', 'sqft', 'bathsX10', 'description', 'listDate', 'propertyType', 'address'].includes(k))).toEqual([]);
    expect(d?.omittedFields).toEqual(['mlsNumber', 'baths', 'sqft', 'propertyType', 'description', 'listDate', 'address']);
    expect(d).toMatchObject({ status: 'active', listPriceCents: 45_000_000, beds: 3, addressHidden: true });
    const client = applyDisplayRules(mls(), REVIEWED_PACK, 'client');
    expect(client?.omittedFields).toEqual([]);
    expect(client).toMatchObject({ mlsNumber: 'MLS1', bathsX10: 20, sqft: 1850, propertyType: 'single_family', description: 'Bright corner home.', listDate: '2026-10-01' });
  });

  it('R-MLS-2: a status the pack does not allow for the audience is not shown', () => {
    expect(applyDisplayRules(mls({ status: 'sold' }), REVIEWED_PACK, 'public')).toBeNull();
    expect(applyDisplayRules(mls({ status: 'sold' }), REVIEWED_PACK, 'client')).not.toBeNull();
  });

  it('R-MLS-4: MLS photos are URL references unless the pack allows re-hosting, and absent when the field is not allowed', () => {
    const ref = applyDisplayRules(mls(), REVIEWED_PACK, 'client');
    expect(ref?.photos).toEqual([{ url: 'https://cdn.example.test/1.jpg', mode: 'reference' }]);
    const rehost = applyDisplayRules(mls(), { ...REVIEWED_PACK, allowRehostPhotos: true }, 'client');
    expect(rehost?.photos).toEqual([{ url: 'https://cdn.example.test/1.jpg', mode: 'rehost_allowed' }]);
    const agent = applyDisplayRules(mls(), STRICTEST_LICENSE_PACK, 'agent');
    expect(agent?.photos).toEqual([{ url: 'https://cdn.example.test/1.jpg', mode: 'reference' }]);
    const noPhotos: LicensePack = { ...REVIEWED_PACK, audiences: { ...REVIEWED_PACK.audiences, client: { fields: ['status'], statuses: ['active'] } } };
    const d = applyDisplayRules(mls(), noPhotos, 'client');
    expect(d?.photos).toBeUndefined();
    expect(d?.omittedFields).toEqual(DISPLAY_FIELDS.filter((f) => f !== 'status'));
    const bare: LicensePack = { ...REVIEWED_PACK, audiences: { ...REVIEWED_PACK.audiences, client: { fields: [], statuses: ['active'] } } };
    const b = applyDisplayRules(mls(), bare, 'client');
    expect(b).toEqual({
      audience: 'client',
      id: mls().id,
      source: 'mls',
      sourceLabel: 'MLS',
      isTeamListing: false,
      listingBrokerageName: 'Other Brokerage LLC',
      attribution: REVIEWED_PACK.attributionText,
      disclaimer: REVIEWED_PACK.disclaimerText,
      addressHidden: true,
      omittedFields: [...DISPLAY_FIELDS],
    });
  });
});

describe('applyDisplayRules: team listings', () => {
  it('R-MLS-4: the team\'s own listing is labelled Team for every audience and is not subject to the MLS pack', () => {
    for (const audience of ['agent', 'client', 'public'] as const) {
      const d = applyDisplayRules(team(), STRICTEST_LICENSE_PACK, audience);
      expect(d).toMatchObject({ audience, source: 'team', sourceLabel: 'Team', isTeamListing: true, attribution: null, disclaimer: null, addressHidden: false, omittedFields: [] });
      expect(d?.photos).toEqual([{ url: 'https://cdn.example.test/1.jpg', mode: 'rehost_allowed' }]);
    }
  });

  it('R-MLS-4: only team listings are eligible for marketing pieces', () => {
    expect(marketingEligible(team())).toBe(true);
    expect(marketingEligible(mls())).toBe(false);
    expect(marketingEligible(mls({ teamListingId: team().id }))).toBe(false);
  });
});

describe('parseLicensePack: strictest defaults', () => {
  it('R-MLS-2: invalid or unknown values fall back to the strictest value, key by key', () => {
    const p = parseLicensePack({
      reviewed_by_counsel_at: 'yesterday',
      max_staleness_hours: -3,
      attribution_text: '   ',
      disclaimer_text: 42,
      allow_rehost_photos: 'yes',
      require_listing_brokerage: 'no',
      audiences: { client: { fields: ['price', 'beds', 'beds', 'everything'], statuses: ['active', 'bogus'] }, public: 'all' },
    });
    expect(p).toEqual({
      ...STRICTEST_LICENSE_PACK,
      audiences: { client: { fields: ['beds'], statuses: ['active'] }, public: { fields: [], statuses: [] } },
    });
    for (const bad of [null, undefined, [], 'x', 1]) expect(parseLicensePack(bad)).toEqual(STRICTEST_LICENSE_PACK);
    expect(parseLicensePack({ audiences: 'x' }).audiences).toEqual(STRICTEST_LICENSE_PACK.audiences);
  });

  it('R-MLS-2: a reviewed pack keeps its values', () => {
    expect(REVIEWED_PACK).toMatchObject({ reviewedByCounselAt: '2026-10-15T09:00:00Z', maxStalenessHours: 24, allowRehostPhotos: false, requireListingBrokerage: true });
    expect(parseLicensePack({ allow_rehost_photos: true, require_listing_brokerage: false, attribution_text: ' A ' })).toMatchObject({
      allowRehostPhotos: true,
      requireListingBrokerage: false,
      attributionText: 'A',
    });
  });
});
