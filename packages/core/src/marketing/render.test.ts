import { describe, expect, it } from 'vitest';
import { PIECE_KINDS, renderPiece, guardResult, type RenderedPiece, type Rendered } from './index.js';
import { FH, IDENTITY, LENIENT, SHA, STRICT, mlsListing, piece, teamListing, withProse } from './testing/fixtures.js';

const ok = (r: Rendered): RenderedPiece => {
  if (!r.ok) throw new Error(`refused: ${r.code} ${r.reason}`);
  return r;
};

describe('renderPiece: bound facts render live (R-MKT-3, E90)', () => {
  it('R-MKT-3 E90: a price change shows the new price without re-approval; prose unchanged', () => {
    const p = piece('website_page');
    const before = ok(renderPiece(p, teamListing(), IDENTITY, STRICT));
    const after = ok(renderPiece(p, teamListing({ listPriceCents: 43_500_000 }), IDENTITY, STRICT));
    expect(before.text).toContain('$450,000');
    expect(after.text).toContain('$435,000');
    expect(after.text).not.toContain('$450,000');
    const prose = (r: RenderedPiece) => r.blocks.filter((b) => b.origin === 'prose');
    expect(prose(after)).toEqual(prose(before));
    // the guard over the same content hash still passes: nothing to re-approve
    const g = guardResult(after, IDENTITY, STRICT, FH, SHA);
    expect(g.pack_rule_failures).toEqual([]);
    expect(g.numeral_issues).toEqual([]);
  });

  it('R-MKT-3: only bound fields render; an unbound price is not shown', () => {
    const r = ok(renderPiece(piece('social_post', { boundFields: ['beds'] }), teamListing(), IDENTITY, STRICT));
    expect(r.text).not.toContain('$450,000');
    expect(r.text).toContain('3 bd');
    expect(r.blocks.find((b) => b.role === 'price')).toBeUndefined();
  });

  it('R-MKT-3: beds, baths (x10), sqft and address render from facts', () => {
    const r = ok(renderPiece(piece('flyer'), teamListing({ addressLine2: 'Unit 4B' }), IDENTITY, STRICT));
    expect(r.text).toContain('3 bd · 2.5 ba · 1,850 sq ft');
    expect(r.text).toContain('12 Oak St, Unit 4B, Austin, TX 78701');
  });

  it('R-MKT-3: the open-house time renders from the piece, in its zone', () => {
    const r = ok(renderPiece(piece('open_house_invite'), teamListing(), IDENTITY, STRICT));
    expect(r.text).toContain('Open house: Sat, Nov 14, 1:00 PM – 3:00 PM CST');
    expect(r.issues).toEqual([]);
  });

  it('R-MKT-3: an invite without its open-house time is an issue (never typed into copy)', () => {
    const r = ok(renderPiece(piece('open_house_invite', { openHouse: null }), teamListing(), IDENTITY, STRICT));
    expect(r.issues.map((i) => i.ruleId)).toEqual(['platform.open_house_time']);
  });

  it('R-MKT-3: photos come from the piece assets, in position order', () => {
    const r = ok(renderPiece(piece('website_page'), teamListing(), IDENTITY, STRICT));
    expect(r.images.map((a) => a.position)).toEqual([1, 2]);
    expect(r.blocks.some((b) => b.role === 'gallery')).toBe(true);
  });

  it('R-MKT-9: a sold listing shows its status even when status is not bound', () => {
    const r = ok(renderPiece(piece('website_page', { boundFields: ['price'] }), teamListing({ status: 'sold' }), IDENTITY, STRICT));
    expect(r.text).toContain('Sold');
  });
});

describe('renderPiece: brokerage name on every kind (R-MKT-1)', () => {
  for (const kind of PIECE_KINDS) {
    it(`R-MKT-1: ${kind} renders the brokerage legal name, licence, address and statement (snapshot)`, () => {
      const r = ok(renderPiece(piece(kind), teamListing(), IDENTITY, STRICT));
      expect(r.text).toContain('Lone Star Realty LLC');
      expect(r.text).toContain('The Smith Team');
      expect(r.text).toContain('License #0123456');
      expect(r.text).toContain('Equal Housing Opportunity.');
      expect(r).toMatchSnapshot();
    });
  }

  it('R-MKT-1: a solo brokerage (team name = brokerage name) shows the name once', () => {
    const r = ok(renderPiece(piece('gbp_post'), teamListing(), { ...IDENTITY, teamName: 'LONE STAR REALTY LLC' }, STRICT));
    expect(r.blocks.filter((b) => b.role === 'team_name')).toEqual([]);
  });

  it('R-MKT-1: the statement is omitted only when no pack requires it', () => {
    const none = { advertising: [{ ...LENIENT.advertising[0]!, requireEqualHousingStatement: false }] };
    const r = ok(renderPiece(piece('gbp_post'), teamListing(), IDENTITY, none));
    expect(r.text).not.toContain('Equal Housing');
  });
});

describe('renderPiece refusals (R-MKT-5)', () => {
  it('R-MKT-5 R-MLS-4: an MLS listing cannot be rendered as a piece', () => {
    for (const kind of PIECE_KINDS) {
      const r = renderPiece(piece(kind), mlsListing(), IDENTITY, STRICT);
      expect(r).toMatchObject({ ok: false, code: 'MARKETING_TEAM_LISTING_ONLY' });
    }
  });

  it('R-MKT-5: the guard result of a refusal fails approval', () => {
    const g = guardResult(renderPiece(piece('flyer'), mlsListing(), IDENTITY, STRICT), IDENTITY, STRICT, FH, SHA);
    expect(g.brokerage_name_present).toBe(false);
    expect(g.pack_rule_failures.map((f) => f.rule_id)).toEqual(['MARKETING_TEAM_LISTING_ONLY']);
  });

  it('R-MKT-1: an unknown or other-kind template is refused', () => {
    expect(renderPiece(piece('flyer', { templateKey: 'website_page.standard' }), teamListing(), IDENTITY, STRICT)).toMatchObject({ ok: false, code: 'MARKETING_TEMPLATE_UNKNOWN' });
    expect(renderPiece(piece('flyer', { templateKey: 'toString' }), teamListing(), IDENTITY, STRICT)).toMatchObject({ ok: false, code: 'MARKETING_TEMPLATE_UNKNOWN' });
  });

  it('R-MKT-3: prose with an extra key (e.g. a typed "price") is refused', () => {
    const r = renderPiece(piece('gbp_post', { prose: { body: 'Nice home.', price: '$1' } }), teamListing(), IDENTITY, STRICT);
    expect(r).toMatchObject({ ok: false, code: 'MARKETING_PROSE_INVALID' });
  });

  it('R-MKT-3: an unknown bound field is refused', () => {
    const r = renderPiece(piece('gbp_post', { boundFields: ['price', 'hoa' as never] }), teamListing(), IDENTITY, STRICT);
    expect(r).toMatchObject({ ok: false, code: 'MARKETING_BOUND_FIELD_INVALID' });
  });

  it('R-MKT-1: duplicate assets are an issue', () => {
    const p = withProse('website_page', {});
    const r = ok(renderPiece({ ...p, assets: [p.assets[0]!, p.assets[0]!] }, teamListing(), IDENTITY, STRICT));
    expect(r.issues.map((i) => i.ruleId)).toContain('platform.assets');
  });
});
