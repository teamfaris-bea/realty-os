// Adversarial tests for core/marketing (critical module): attempts to get discriminatory copy, price
// or date numerals, a guard result for other content, a hidden brokerage name, MLS listings, export
// "activity" or posting claims past the rules.
import { describe, expect, it } from 'vitest';
import {
  TEMPLATES,
  assembleSellerUpdate,
  claimsPosting,
  deliveryLabel,
  exportBundle,
  guardPasses,
  guardResult,
  guardResultMatches,
  numeralIssues,
  renderPiece,
  PIECE_KINDS,
  PIECE_STATUSES,
  type PieceVersion,
  type SellerUpdateInputs,
} from './index.js';
import { at } from '../foundation/index.js';
import { FH, IDENTITY, OTHER_SHA, SHA, STRICT, ZONE, lid, mlsListing, piece, teamListing, withProse } from './testing/fixtures.js';

const guard = (p: PieceVersion, identity = IDENTITY, packs = STRICT) => guardResult(renderPiece(p, teamListing(), identity, packs), identity, packs, FH, SHA);

describe('adversarial: hiding fair-housing wording (R-FH-1, E93)', () => {
  const disguised = [
    'Perfect for young fam\u200Bilies', // zero-width space
    'ＰＥＲＦＥＣＴ ＦＯＲ ＹＯＵＮＧ ＦＡＭＩＬＩＥＳ', // full width
    'Perfect for young famіlies', // Cyrillic і
    'a d u l t s o n l y', // spelled out
    'Perfect for y0ung families', // leetspeak
    'adults\u00ADonly', // soft hyphen
  ];
  for (const t of disguised) {
    it(`R-FH-1: "${t}" in prose is still a hard match`, () => {
      expect(guard(withProse('website_page', { body: t })).hard_count).toBeGreaterThan(0);
    });
  }

  it('R-FH-1: a phrase split across the headline and the body is still caught', () => {
    const g = guard(withProse('website_page', { headline: 'Perfect for young', body: 'families who love the park.' }));
    expect(g.hard_count).toBeGreaterThan(0);
  });

  it('R-FH-1: hashtags cannot hide a term (CamelCase or run together)', () => {
    expect(guard(withProse('social_post', { hashtags: ['#AdultsOnly'] })).hard_count).toBeGreaterThan(0);
    expect(guard(withProse('social_post', { hashtags: ['#adultsonly'] })).hard_count).toBeGreaterThan(0);
    expect(guard(withProse('social_post', { hashtags: ['#no_kids'] })).hard_count).toBeGreaterThan(0);
  });

  it('R-FH-1: a hard term in the team name is caught (the whole rendering is checked)', () => {
    expect(guard(piece('gbp_post'), { ...IDENTITY, teamName: 'Adults Only Homes' }).hard_count).toBeGreaterThan(0);
  });
});

describe('adversarial: numerals as words or other digits (R-MKT-3)', () => {
  const caught = [
    '４５０k', // full-width digits
    '٤٥٠٬٠٠٠', // Arabic-Indic digits with an Arabic thousands separator
    '٤٥٠,٠٠٠',
    '⁴⁵⁰k', // superscript
    '④⑤⓪k', // circled
    '4\u200B50k', // zero-width space
    '45Ok', // letter O for zero
    '4 5 0 k', // spaced digits
    '4-5-0-k',
    'four hundred fifty thousand dollars',
    'half a million',
    'Nov 1２', // mixed width
    'Saturday the twelfth',
    'twelve thirty pm'.replace('twelve thirty', 'twelve'),
    '#450k',
  ];
  for (const t of caught) {
    it(`R-MKT-3: "${t}" is caught`, () => {
      expect(numeralIssues(t).length).toBeGreaterThan(0);
      expect(guardPasses(guard(withProse('website_page', { body: `Home. ${t}` })), SHA)).toBe(false);
    });
  }

  it('R-MKT-3: documented gaps (no money or calendar word) are not caught', () => {
    for (const t of ['four fifty', 'mid four hundreds', 'this weekend', 'XII']) expect(numeralIssues(t)).toEqual([]);
  });

  it('R-MKT-3: a typed "price" key in the prose is refused, never rendered', () => {
    const r = renderPiece(piece('gbp_post', { prose: { body: 'Nice.', price: '$1' } }), teamListing(), IDENTITY, STRICT);
    expect(r.ok).toBe(false);
  });
});

describe('adversarial: a guard result for other content (R-MKT-1, R-GATE-12)', () => {
  it('R-GATE-12: a guard result computed over other content never matches this row', () => {
    const other = guard(withProse('flyer', { body: 'Clean copy.' }));
    expect(guardResultMatches(other, OTHER_SHA)).toBe(false);
    expect(guardPasses(other, OTHER_SHA)).toBe(false);
  });

  it('R-GATE-12: guardResult always echoes the given hash; it never computes or swaps one', () => {
    for (const h of [SHA, OTHER_SHA, '', 'A'.repeat(64)]) {
      const g = guardResult(renderPiece(piece('flyer'), teamListing(), IDENTITY, STRICT), IDENTITY, STRICT, FH, h);
      expect(g.content_sha256).toBe(h);
    }
    // an uppercase or empty hash never matches (the DB column is lowercase hex)
    expect(guardResultMatches(guard(piece('flyer')), 'A'.repeat(64))).toBe(false);
  });

  it('R-MKT-1: hand-written look-alikes are refused (strings for booleans, extra keys, missing failures)', () => {
    const g = guard(piece('flyer'));
    expect(guardPasses({ ...g, brokerage_name_present: 'true' }, SHA)).toBe(false);
    expect(guardPasses({ ...g, hard_count: '0' }, SHA)).toBe(false);
    expect(guardPasses({ ...g, pack_rule_failures: undefined }, SHA)).toBe(false);
    expect(guardPasses({ ...g, approved: true }, SHA)).toBe(false);
    expect(guardPasses(null, SHA)).toBe(false);
    expect(guardPasses(JSON.parse(JSON.stringify(g)), SHA)).toBe(true);
  });
});

describe('adversarial: hiding the brokerage name (R-MKT-1, E92)', () => {
  it('E92: the brokerage name in a footnote fails the prominence rule', () => {
    const g = guard(piece('flyer', { templateKey: 'flyer.team_forward' }));
    expect(g.pack_rule_failures.some((f) => f.rule_id === 'brokerage_name_prominence')).toBe(true);
  });

  it('E92: the team name typed into a display headline outranks the brokerage heading and fails', () => {
    const g = guard(withProse('flyer', { headline: 'The Smith Team presents' }));
    const f = g.pack_rule_failures.find((x) => x.rule_id === 'brokerage_name_prominence');
    expect(f?.reason).toMatch(/team name is shown as the largest text/);
  });

  it('E92: a template cannot be edited at run time to shrink the brokerage name', () => {
    expect(() => {
      (TEMPLATES['flyer.standard']!.slots[0] as { prominence: string }).prominence = 'footnote';
    }).toThrow();
    expect(() => {
      (TEMPLATES as Record<string, unknown>)['flyer.evil'] = {};
    }).toThrow();
  });

  it('R-MKT-1: a whitespace or invisible-character brokerage name is not "present"', () => {
    expect(guard(piece('gbp_post'), { ...IDENTITY, brokerageLegalName: ' \u200B ' }).brokerage_name_present).toBe(false);
  });

  it('R-MKT-1: the name only inside the prose counts as present, but the prominence rule still applies', () => {
    const id = { ...IDENTITY, brokerageLegalName: 'Hidden Brokerage Inc' };
    const r = renderPiece(withProse('flyer', { body: 'Hidden Brokerage Inc' }), teamListing(), id, STRICT);
    expect(guardResult(r, id, STRICT, FH, SHA).brokerage_name_present).toBe(true);
  });
});

describe('adversarial: marketing an MLS listing (R-MKT-5, R-MLS-4)', () => {
  it('R-MKT-5: an MLS row mirroring a team listing is still refused', () => {
    for (const kind of PIECE_KINDS) {
      expect(renderPiece(piece(kind), mlsListing({ teamListingId: lid(1) }), IDENTITY, STRICT).ok).toBe(false);
      expect(exportBundle(piece(kind), mlsListing(), IDENTITY, STRICT).ok).toBe(false);
    }
  });

  it('R-MKT-5: a source spelled differently is refused (only exactly "team")', () => {
    expect(renderPiece(piece('flyer'), teamListing({ source: 'Team' as never }), IDENTITY, STRICT).ok).toBe(false);
  });
});

describe('adversarial: counting exports as activity (R-SELL-2, R-MKT-6)', () => {
  const PERIOD = { start: at('2026-11-02T06:00:00Z'), end: at('2026-11-09T06:00:00Z'), zone: ZONE };
  const IN = at('2026-11-05T18:00:00Z');
  const inputs = (o: Partial<SellerUpdateInputs>): SellerUpdateInputs => ({
    listing: teamListing(),
    now: PERIOD.end,
    showingServiceConnected: false,
    showings: [],
    feedback: [],
    pieces: [],
    inviteSends: [],
    loggedActivity: [],
    mls: { connected: false },
    ...o,
  });

  it('R-SELL-2: an export marked with status "published" but no publication instant is not counted', () => {
    const r = assembleSellerUpdate(inputs({ pieces: [{ pieceId: 'p', kind: 'marketplace_export', status: 'published', publishedAt: null, exportedAt: IN }] }), PERIOD);
    expect(r.sections.find((s) => s.kind === 'marketing')?.state).toBe('none_logged');
  });

  it('R-SELL-2: an invite send with no recipients is not activity; one exported fifty times counts zero', () => {
    const pieces = Array.from({ length: 50 }, (_, n) => ({ pieceId: `p${n}`, kind: 'flyer' as const, status: 'exported' as const, publishedAt: null, exportedAt: IN }));
    const r = assembleSellerUpdate(inputs({ pieces, inviteSends: [{ pieceId: 'i', sentAt: IN, recipients: [] }] }), PERIOD);
    expect(r.claims.filter((c) => c.section === 'marketing').map((c) => c.count)).toEqual([0]);
  });
});

describe('adversarial: posting claims in export labels (R-MKT-6)', () => {
  it('R-MKT-6: copy that says "posted live" never changes the label', () => {
    for (const kind of PIECE_KINDS) {
      const prose = kind === 'marketplace_export' ? { title: 'Posted live!', description: 'Now live and published.' } : undefined;
      const b = exportBundle(prose ? piece(kind, { prose }) : piece(kind), teamListing(), IDENTITY, STRICT);
      if (!b.ok) throw new Error(b.code);
      expect(claimsPosting(b.label)).toBe(false);
    }
  });

  it('R-MKT-6: the label lint catches posting words, also in full-width', () => {
    for (const t of ['Posted live', 'Now live on Marketplace', 'Published to Facebook', 'ＰＯＳＴＥＤ', 'Your post went up', 'Shared to Instagram']) expect(claimsPosting(t)).toBe(true);
    for (const kind of PIECE_KINDS) for (const s of PIECE_STATUSES) expect(claimsPosting(deliveryLabel(kind, s))).toBe(false);
  });
});
