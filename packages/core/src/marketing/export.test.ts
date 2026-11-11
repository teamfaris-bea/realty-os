import { describe, expect, it } from 'vitest';
import { DELIVERY, PIECE_KINDS, PIECE_STATUSES, OUT_OF_DATE_NOTICE, canPublish, claimsPosting, deliveryLabel, exportBundle, exportOnly, listingStatusEffect } from './index.js';
import { IDENTITY, STRICT, mlsListing, oid, piece, teamListing, withProse } from './testing/fixtures.js';

describe('exportBundle (R-MKT-6)', () => {
  it('R-MKT-6: an export is the rendered copy with the version images in order', () => {
    const b = exportBundle(piece('marketplace_export'), teamListing(), IDENTITY, STRICT);
    expect(b.ok).toBe(true);
    if (!b.ok) return;
    expect(b.text).toContain('Lone Star Realty LLC');
    expect(b.text).toContain('$450,000');
    expect(b.images.map((a) => a.objectId)).toEqual([oid(1), oid(2)]);
    expect(b.flags).toEqual([]);
  });

  it('R-MKT-6: export labels never claim posting ("posted", "published", "live")', () => {
    for (const kind of PIECE_KINDS) {
      const b = exportBundle(piece(kind), teamListing(), IDENTITY, STRICT);
      if (!b.ok) throw new Error(b.code);
      expect(claimsPosting(b.label)).toBe(false);
      expect(b.label).not.toMatch(/posted|published|live/i);
      expect(b.label).toMatch(/^Exported/);
    }
  });

  it('R-MKT-6: no delivery label claims posting for any kind or status we cannot verify', () => {
    for (const kind of PIECE_KINDS) {
      for (const status of PIECE_STATUSES) {
        expect(claimsPosting(deliveryLabel(kind, status))).toBe(false);
      }
    }
  });

  it('R-MKT-6: Facebook Marketplace is export-only', () => {
    expect(exportOnly('marketplace_export')).toBe(true);
    expect(canPublish('marketplace_export', true)).toBe(false);
    expect(PIECE_KINDS.filter(exportOnly)).toEqual(['flyer', 'marketplace_export']);
    expect(deliveryLabel('marketplace_export', 'exported')).toBe('Exported for Facebook Marketplace: copy it there yourself');
  });

  it('R-MKT-6 R-GBP-2: social and GBP posts publish only through a connected integration; the page is ours', () => {
    expect(canPublish('gbp_post', false)).toBe(false);
    expect(canPublish('gbp_post', true)).toBe(true);
    expect(canPublish('social_post', false)).toBe(false);
    expect(canPublish('website_page', false)).toBe(true);
    expect(DELIVERY.open_house_invite).toMatchObject({ send: true, export: false });
  });

  it('R-MKT-5: an MLS listing is never exported', () => {
    expect(exportBundle(piece('flyer'), mlsListing(), IDENTITY, STRICT)).toMatchObject({ ok: false, code: 'MARKETING_TEAM_LISTING_ONLY' });
  });

  it('R-MKT-6: posting words in the copy never reach the label', () => {
    const b = exportBundle(withProse('marketplace_export', { title: 'Posted live today!' }), teamListing(), IDENTITY, STRICT);
    if (!b.ok) throw new Error(b.code);
    expect(claimsPosting(b.label)).toBe(false);
  });
});

describe('R-MKT-9 E91: listing gone off market', () => {
  for (const status of ['sold', 'withdrawn', 'expired'] as const) {
    it(`R-MKT-9 E91: ${status} ⇒ invites canceled, page 410, exports flagged "may be out of date"`, () => {
      expect(listingStatusEffect(status)).toMatchObject({ offMarket: true, cancelUnsentInvites: true, page: 'gone', exportFlag: 'may_be_out_of_date' });
      const b = exportBundle(piece('flyer'), teamListing({ status }), IDENTITY, STRICT);
      if (!b.ok) throw new Error(b.code);
      expect(b.flags).toEqual(['may_be_out_of_date']);
      expect(b.label).toContain(OUT_OF_DATE_NOTICE);
      expect(b.label.toLowerCase()).toContain('may be out of date');
    });
  }
  it('R-MKT-9: active, coming soon and pending change nothing', () => {
    for (const s of ['active', 'coming_soon', 'pending'] as const) {
      expect(listingStatusEffect(s)).toEqual({ offMarket: false, cancelUnsentInvites: false, page: 'serve', exportFlag: null, notice: null });
    }
  });
});
