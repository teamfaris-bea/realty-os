import { describe, expect, it } from 'vitest';
import {
  GuardResultSchema,
  advertisingPackFrom,
  guardPasses,
  guardReasons,
  guardResult,
  guardResultMatches,
  liveRecheck,
  MARKETING_DRAFT_ACTION,
  needsFairHousingCheck,
  parseGuardResult,
  renderPiece,
  PIECE_KINDS,
  type Packs,
  type PieceKind,
  type PieceVersion,
} from './index.js';
import { FH, IDENTITY, LENIENT, OTHER_SHA, SHA, STRICT, piece, teamListing, withProse } from './testing/fixtures.js';

const guard = (p: PieceVersion, packs: Packs = STRICT, identity = IDENTITY) => guardResult(renderPiece(p, teamListing(), identity, packs), identity, packs, FH, SHA);

describe('guardResult: the approval CHECK keys (R-MKT-1, R-GATE-12)', () => {
  it('R-MKT-1: the JSON has exactly the keys the DB CHECK reads, snake_case, true and 0', () => {
    const g = guard(piece('website_page'));
    expect(Object.keys(g).sort()).toEqual(['brokerage_name_present', 'content_sha256', 'fair_housing_reviewed', 'hard', 'hard_count', 'lexicon_version', 'numeral_issues', 'pack_rule_failures', 'soft'].sort());
    const json = JSON.parse(JSON.stringify(g)) as Record<string, unknown>;
    expect(json.brokerage_name_present).toBe(true);
    expect(json.hard_count).toBe(0);
    expect(Array.isArray(json.pack_rule_failures)).toBe(true);
    expect(json.pack_rule_failures).toEqual([]);
    expect(json.fair_housing_reviewed).toBe(false); // the shipped lexicon is unreviewed
    expect(String(json.brokerage_name_present)).toBe('true'); // the CHECK compares ->> text
    expect(String(json.hard_count)).toBe('0');
  });

  it('R-MKT-1 R-GATE-12: content_sha256 is echoed verbatim and only matches its own hash', () => {
    const g = guard(piece('flyer'));
    expect(g.content_sha256).toBe(SHA);
    expect(guardResultMatches(g, SHA)).toBe(true);
    expect(guardResultMatches(g, OTHER_SHA)).toBe(false);
    expect(guardPasses(g, SHA)).toBe(true);
    expect(guardPasses(g, OTHER_SHA)).toBe(false);
  });

  it('R-MKT-1: GuardResultSchema round-trips every kind and refuses extra or missing keys', () => {
    for (const kind of PIECE_KINDS) {
      const g = guard(withProse(kind, {} as never));
      const back = GuardResultSchema.parse(JSON.parse(JSON.stringify(g)));
      expect(back).toEqual(g);
    }
    const g = guard(piece('gbp_post'));
    expect(GuardResultSchema.safeParse({ ...g, approved: true }).success).toBe(false);
    const { hard_count: _drop, ...missing } = g;
    expect(GuardResultSchema.safeParse(missing).success).toBe(false);
    expect(parseGuardResult('{}')).toBeNull();
  });

  it('R-MKT-1: an invalid hash is a failure, still echoed', () => {
    const g = guardResult(renderPiece(piece('gbp_post'), teamListing(), IDENTITY, STRICT), IDENTITY, STRICT, FH, 'nope');
    expect(g.content_sha256).toBe('nope');
    expect(g.pack_rule_failures.map((f) => f.rule_id)).toContain('platform.content_hash');
    expect(guardPasses(g, 'nope')).toBe(false);
  });

  it('R-MKT-1: guardReasons lists every blocking reason in words', () => {
    const g = guard(withProse('flyer', { body: 'Adults only. Priced at $450k.' }), STRICT, { ...IDENTITY, licenseNumber: null });
    const reasons = guardReasons(g, OTHER_SHA);
    expect(reasons.join('\n')).toMatch(/different version/);
    expect(reasons.join('\n')).toMatch(/Fair-housing wording/);
    expect(reasons.join('\n')).toMatch(/licence number/);
    expect(reasons.join('\n')).toMatch(/\$450k/);
    expect(guardReasons(guard(piece('flyer')), SHA)).toEqual([]);
  });
});

describe('R-MKT-3: no price or date numerals in model copy', () => {
  const bad: readonly [string, string][] = [
    ['$450k', 'price'],
    ['450,000', 'price'],
    ['Nov 12', 'date'],
    ['12/11', 'date'],
    ['Saturday the 12th', 'date'],
  ];
  for (const [t, shape] of bad) {
    it(`R-MKT-3: prose containing "${t}" fails the guard`, () => {
      const g = guard(withProse('website_page', { body: `Lovely home. ${t} is the moment.` }));
      expect(g.numeral_issues.length).toBeGreaterThan(0);
      expect(g.numeral_issues[0]?.shape).toBe(shape);
      expect(g.pack_rule_failures.map((f) => f.rule_id)).toContain('R-MKT-3');
      expect(guardPasses(g, SHA)).toBe(false);
    });
  }

  it('R-MKT-3: numerals in a headline, subject, caption or hashtag also fail', () => {
    expect(guard(withProse('flyer', { headline: 'Now 450k' })).numeral_issues[0]).toMatchObject({ role: 'headline', shape: 'price' });
    expect(guard(withProse('open_house_invite', { subject: 'Open house Nov 14' })).numeral_issues[0]).toMatchObject({ role: 'subject', shape: 'date' });
    expect(guard(withProse('social_post', { hashtags: ['#Open1114'] })).numeral_issues[0]).toMatchObject({ role: 'hashtags' });
  });

  it('R-MKT-3: the bound price, address and open-house time rendered live are fine', () => {
    const g = guard(piece('open_house_invite'));
    expect(g.numeral_issues).toEqual([]);
    expect(guardPasses(g, SHA)).toBe(true);
  });

  it('R-MKT-3: counts that are not prices or dates pass ("3 bedrooms", "2-car garage")', () => {
    expect(guard(withProse('gbp_post', { body: 'Three bedrooms, 2-car garage and 2.5 baths.' })).numeral_issues).toEqual([]);
  });
});

describe('E92: brokerage-name prominence (R-MKT-1, pack rule)', () => {
  it('E92 R-MKT-1: a team-forward flyer fails when the pack requires brokerage prominence, with a human reason', () => {
    const g = guard(piece('flyer', { templateKey: 'flyer.team_forward' }));
    const f = g.pack_rule_failures.find((x) => x.rule_id === 'brokerage_name_prominence');
    expect(f).toBeDefined();
    expect(f?.pack_id).toBe('platform.default');
    expect(f?.reason).toBe(
      'The brokerage name "Lone Star Realty LLC" must be at least as prominent as the team name "The Smith Team". Here the team name is shown as the largest text and the brokerage name is shown as a footnote.',
    );
    expect(g.brokerage_name_present).toBe(true);
    expect(guardPasses(g, SHA)).toBe(false);
  });

  it('E92: the same flyer passes under a pack without the prominence rule', () => {
    const g = guard(piece('flyer', { templateKey: 'flyer.team_forward' }), LENIENT);
    expect(g.pack_rule_failures).toEqual([]);
  });

  it('E92: the standard flyer (equal prominence) passes the strict pack', () => {
    expect(guard(piece('flyer')).pack_rule_failures).toEqual([]);
  });

  it('E92: the failure names the pack that requires it; the strictest of several packs applies', () => {
    const tx = advertisingPackFrom('tx.trec', { brokerage_name_at_least_as_prominent_as_team: true });
    const g = guard(piece('flyer', { templateKey: 'flyer.team_forward' }), { advertising: [LENIENT.advertising[0]!, tx] });
    expect(g.pack_rule_failures.find((x) => x.rule_id === 'brokerage_name_prominence')?.pack_id).toBe('tx.trec');
  });
});

describe('jurisdiction pack rules (VERIFY WITH COUNSEL data)', () => {
  it('R-MKT-1: missing licence number or office address fails the strict default', () => {
    const g = guard(piece('gbp_post'), STRICT, { ...IDENTITY, licenseNumber: null, brokerageAddress: '  ' });
    expect(g.pack_rule_failures.map((f) => f.rule_id).sort()).toEqual(['brokerage_address', 'license_number']);
  });

  it('R-MKT-1: a team name with a forbidden term fails', () => {
    const pack = advertisingPackFrom('xx.team', { team_name_forbidden_terms: ['Realty'] });
    const g = guard(piece('gbp_post'), { advertising: [pack] }, { ...IDENTITY, teamName: 'Smith Realty Group' });
    expect(g.pack_rule_failures.find((f) => f.rule_id === 'team_name_terms')?.reason).toMatch(/"Realty"/);
  });

  it('R-MKT-1: a malformed pack parses to the strictest rules', () => {
    const p = advertisingPackFrom('bad', { require_license_number: 'no', brokerage_name_at_least_as_prominent_as_team: null });
    expect(p.requireLicenseNumber).toBe(true);
    expect(p.brokerageNameAtLeastAsProminentAsTeam).toBe(true);
    expect(advertisingPackFrom('bad2', 'garbage').requireBrokerageAddress).toBe(true);
  });

  it('R-MKT-1: brokerage_name_present is false when the identity name is empty', () => {
    expect(guard(piece('gbp_post'), STRICT, { ...IDENTITY, brokerageLegalName: '' }).brokerage_name_present).toBe(false);
  });
});

describe('E93: fair housing (R-FH-1, R-FH-2)', () => {
  it('E93 R-FH-1: "perfect for young families" is a hard match that blocks approval', () => {
    const g = guard(withProse('website_page', { body: 'Perfect for young families who love the park.' }));
    expect(g.hard_count).toBeGreaterThanOrEqual(1);
    expect(g.hard[0]?.term_id).toBe('fh.familial.ideal_occupant');
    expect(guardPasses(g, SHA)).toBe(false);
  });

  it('E93 R-FH-5: "family room" is not flagged', () => {
    const g = guard(withProse('website_page', { body: 'A spacious family room with a fireplace.' }));
    expect(g.hard).toEqual([]);
    expect(g.soft).toEqual([]);
  });

  it('R-FH-2: soft matches are listed but do not block; the piece is flagged "Check this"', () => {
    const g = guard(withProse('website_page', { body: 'A great family home on a quiet street.' }));
    expect(g.soft.map((s) => s.term_id)).toContain('fh.familial.mention');
    expect(g.hard_count).toBe(0);
    expect(guardPasses(g, SHA)).toBe(true);
    expect(needsFairHousingCheck(g)).toBe(true);
    expect(needsFairHousingCheck(guard(piece('flyer')))).toBe(false);
  });

  it('R-FH-1: the equal-housing statement itself is not flagged', () => {
    const kinds: PieceKind[] = [...PIECE_KINDS];
    for (const k of kinds) expect(guard(piece(k)).hard).toEqual([]);
  });

  it('R-FH-1: a hashtag spelled in CamelCase is read as words', () => {
    const g = guard(withProse('social_post', { hashtags: ['#PerfectForYoungFamilies'] }));
    expect(g.hard_count).toBeGreaterThan(0);
  });
});

describe('R-MKT-4: identity or pack changes re-render live pieces', () => {
  it('R-MKT-4: a pack change that the live flyer no longer passes ⇒ unpublish, with the reason', () => {
    const p = piece('flyer', { templateKey: 'flyer.team_forward' });
    expect(liveRecheck(p, teamListing(), IDENTITY, LENIENT, FH, SHA).action).toBe('keep');
    const after = liveRecheck(p, teamListing(), IDENTITY, STRICT, FH, SHA);
    expect(after.action).toBe('unpublish');
    expect(after.reasons.join(' ')).toMatch(/at least as prominent/);
  });

  it('R-MKT-4: an identity change re-renders the new name; removing the licence number unpublishes', () => {
    const p = piece('website_page');
    const renamed = liveRecheck(p, teamListing(), { ...IDENTITY, brokerageLegalName: 'Lone Star Homes LLC' }, STRICT, FH, SHA);
    expect(renamed.action).toBe('keep');
    expect(liveRecheck(p, teamListing(), { ...IDENTITY, licenseNumber: null }, STRICT, FH, SHA).action).toBe('unpublish');
  });

  it('R-AST-19: a marketing draft always needs approval', () => {
    expect(MARKETING_DRAFT_ACTION).toEqual({ kind: 'marketing_draft', autonomy: 'requires_approval' });
  });
});
