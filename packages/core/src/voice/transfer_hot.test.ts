// transferTarget (R-VOICE-6, R-GATE-9 core side) and isHot / HotRule (R-VOICE-6, R-AST-5, R-PRED-4,
// R-COACH-5; known gap (c): no default criteria ship, the rule below is a test fixture).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { CLAIM_KINDS } from '../assistant/index.js';
import { type UserId, at } from '../foundation/index.js';
import { DEFAULT_TRANSFER_HOLD_SECONDS, type HotRule, type VerifiedClaim, holdSecondsOf, isHot, parseHotRule, transferTarget } from './index.js';
import { AFTER_HOURS, FIXTURE_HOT_RULE, HOT_CLAIMS, IN_HOURS, OWNER, OWNER_ID, ROUTING_HOURS, claim, contact } from './testing/index.js';

describe('transferTarget', () => {
  it('R-VOICE-6 the contact\'s current owner, active and accepting leads, inside routing hours, with the hold', () => {
    expect(transferTarget(contact(), IN_HOURS)).toEqual({ kind: 'owner', userId: OWNER_ID, holdSeconds: 20 });
  });

  it.each([
    ['after hours', contact(), AFTER_HOURS],
    ['owner not accepting leads', contact({ owner: { ...OWNER, acceptingLeads: false } }), IN_HOURS],
    ['owner suspended', contact({ owner: { ...OWNER, status: 'suspended' } }), IN_HOURS],
    ['owner deactivating', contact({ owner: { ...OWNER, status: 'deactivating' } }), IN_HOURS],
  ])('R-VOICE-6 otherwise a message for the owner (%s)', (_n, c, t) => {
    expect(transferTarget(c, t)).toEqual({ kind: 'message', handbackTo: 'owner' });
  });

  it('R-VOICE-6 an unowned caller gets a message whose handback goes to whoever the intake offer reaches', () => {
    expect(transferTarget(contact({ owner: null, contactId: null }), IN_HOURS)).toEqual({ kind: 'message', handbackTo: 'intake_offer' });
  });

  it('the hold: default 20 s (known gap (b)), clamped to the content\'s 5–60 s', () => {
    expect(DEFAULT_TRANSFER_HOLD_SECONDS).toBe(20);
    expect(holdSecondsOf(contact({ holdSeconds: undefined }))).toBe(20);
    expect(holdSecondsOf(contact({ holdSeconds: Number.NaN }))).toBe(20);
    expect(holdSecondsOf(contact({ holdSeconds: 1 }))).toBe(5);
    expect(holdSecondsOf(contact({ holdSeconds: 600 }))).toBe(60);
    expect(holdSecondsOf(contact({ holdSeconds: 30 }))).toBe(30);
  });

  it('R-VOICE-6 R-GATE-9 property: only the facts\' current owner (active, accepting, in hours) or a message, never anyone else', () => {
    const uuid = fc.uuid().map((u) => u as UserId);
    fc.assert(
      fc.property(
        fc.option(fc.record({ userId: uuid, role: fc.constantFrom('owner', 'admin', 'team_lead', 'agent', 'isa') as fc.Arbitrary<never>, status: fc.constantFrom('invited', 'active', 'suspended', 'deactivating', 'removed') as fc.Arbitrary<never>, acceptingLeads: fc.boolean() }), { nil: null }),
        fc.integer({ min: at('2026-01-01T00:00:00Z'), max: at('2027-01-01T00:00:00Z') }),
        fc.option(fc.integer({ min: -10, max: 100 }), { nil: undefined }),
        (owner, t, hold) => {
          const c = contact({ owner, holdSeconds: hold });
          const r = transferTarget(c, t as never);
          if (r.kind === 'owner') {
            expect(owner).not.toBeNull();
            expect(r.userId).toBe(owner?.userId);
            expect(owner?.status).toBe('active');
            expect(owner?.acceptingLeads).toBe(true);
            expect(r.holdSeconds).toBeGreaterThanOrEqual(5);
            expect(r.holdSeconds).toBeLessThanOrEqual(60);
          } else {
            expect(r.handbackTo).toBe(owner === null ? 'intake_offer' : 'owner');
          }
          // no address and no other id ever appears in the result
          expect(Object.keys(r).sort()).toEqual(r.kind === 'owner' ? ['holdSeconds', 'kind', 'userId'] : ['handbackTo', 'kind']);
        },
      ),
    );
    expect(transferTarget(contact(), IN_HOURS).kind).toBe('owner');
    expect(ROUTING_HOURS.zone).toBe('America/New_York');
  });
});

describe('isHot over usable claims only', () => {
  it('R-VOICE-6 R-AST-5 the fixture rule: two usable qualification claims', () => {
    expect(isHot(HOT_CLAIMS, FIXTURE_HOT_RULE)).toBe(true);
    expect(isHot([claim(1)], FIXTURE_HOT_RULE)).toBe(false);
  });

  it('R-AST-5 a needs-review claim never counts, nor a rejected one; a confirmed or corrected one does', () => {
    expect(isHot([claim(1), claim(2, { needsReview: true, reviewReasons: ['QUOTE_NOT_VERIFIED'] })], FIXTURE_HOT_RULE)).toBe(false);
    expect(isHot([claim(1), claim(2, { reviewStatus: 'rejected' })], FIXTURE_HOT_RULE)).toBe(false);
    expect(isHot([claim(1), claim(2, { needsReview: true, reviewStatus: 'confirmed' })], FIXTURE_HOT_RULE)).toBe(true);
    expect(isHot([claim(1), claim(2, { needsReview: true, reviewStatus: 'corrected' })], FIXTURE_HOT_RULE)).toBe(true);
  });

  it('structured criteria: key and values', () => {
    const now = claim(3, { kind: 'preference', structured: { criterion: { key: 'timeline', value: 'now' } } });
    const later = claim(4, { kind: 'preference', structured: { criterion: { key: 'timeline', value: 'next_year' } } });
    const other = claim(5, { kind: 'preference', structured: { criterion: { key: 'beds', value: 'now' } } });
    const bare = claim(6, { kind: 'preference' });
    expect(isHot([now], FIXTURE_HOT_RULE)).toBe(true);
    expect(isHot([later, other, bare], FIXTURE_HOT_RULE)).toBe(false);
    expect(isHot([later], { anyOf: [{ claimKind: 'preference', criterionKey: 'timeline' }] })).toBe(true);
    expect(isHot([], { anyOf: [] })).toBe(false);
  });

  it('property: isHot(claims) = isHot(usable claims only)', () => {
    const claimArb: fc.Arbitrary<VerifiedClaim> = fc
      .record({
        n: fc.integer({ min: 1, max: 999 }),
        kind: fc.constantFrom(...CLAIM_KINDS),
        needsReview: fc.boolean(),
        reviewStatus: fc.constantFrom('unreviewed', 'confirmed', 'corrected', 'rejected') as fc.Arbitrary<VerifiedClaim['reviewStatus']>,
        crit: fc.option(fc.record({ key: fc.constantFrom('timeline', 'beds'), value: fc.constantFrom('now', 'later', 3) }), { nil: undefined }),
      })
      .map((r) => claim(r.n, { kind: r.kind, needsReview: r.needsReview, reviewStatus: r.reviewStatus, ...(r.crit !== undefined ? { structured: { criterion: r.crit } } : {}) }));
    const ruleArb: fc.Arbitrary<HotRule> = fc.record({
      anyOf: fc.array(
        fc.record(
          { claimKind: fc.constantFrom(...CLAIM_KINDS), criterionKey: fc.constantFrom('timeline', 'beds'), criterionValues: fc.array(fc.constantFrom('now', 'later', 3), { minLength: 1, maxLength: 2 }), atLeast: fc.integer({ min: 1, max: 3 }) },
          { requiredKeys: ['claimKind'] },
        ),
        { maxLength: 3 },
      ),
    });
    fc.assert(
      fc.property(fc.array(claimArb, { maxLength: 8 }), ruleArb, (claims, rule) => {
        const usable = claims.filter((c) => c.reviewStatus !== 'rejected' && (!c.needsReview || c.reviewStatus === 'confirmed' || c.reviewStatus === 'corrected'));
        expect(isHot(claims, rule)).toBe(isHot(usable, rule));
        // adding needs-review claims never makes a caller hot
        const flagged = claims.map((c) => ({ ...c, needsReview: true, reviewStatus: 'unreviewed' as const }));
        expect(isHot([...usable, ...flagged], rule)).toBe(isHot(usable, rule));
      }),
    );
  });
});

describe('HotRule cannot express a contact attribute, a prediction band or a call score (R-PRED-4, R-COACH-5)', () => {
  it('R-PRED-4 R-COACH-5 parseHotRule rejects any key it does not know', () => {
    for (const bad of [
      { anyOf: [{ claimKind: 'qualification', band: 'high' }] },
      { anyOf: [{ claimKind: 'qualification', callScore: 90 }] },
      { anyOf: [{ claimKind: 'qualification', stage: 'active' }] },
      { anyOf: [{ claimKind: 'qualification', contactSource: 'zillow' }] },
      { anyOf: [], predictionBand: 'high' },
      { anyOf: [{ claimKind: 'not_a_kind' }] },
      { anyOf: [{ claimKind: 'qualification', criterionKey: 'Bad Key' }] },
      { anyOf: [{ claimKind: 'qualification', criterionValues: ['now'] }] },
      { anyOf: [{ claimKind: 'qualification', criterionKey: 'timeline', criterionValues: [] }] },
      { anyOf: [{ claimKind: 'qualification', criterionKey: 'timeline', criterionValues: [{}] }] },
      { anyOf: [{ claimKind: 'qualification', atLeast: 0 }] },
      { anyOf: [{ claimKind: 'qualification', atLeast: 1.5 }] },
      { anyOf: ['qualification'] },
      { anyOf: 'qualification' },
      { anyOf: Array.from({ length: 21 }, () => ({ claimKind: 'fact' })) },
      null,
      [],
    ]) {
      expect(parseHotRule(bad)).toEqual({ ok: false, code: 'HOT_RULE_INVALID' });
    }
  });

  it('parseHotRule accepts the claim-only shape', () => {
    expect(parseHotRule(FIXTURE_HOT_RULE)).toEqual({ ok: true, rule: FIXTURE_HOT_RULE });
    expect(parseHotRule({ anyOf: [{ claimKind: 'fact', criterionKey: 'beds', criterionValues: [3, true], atLeast: 2 }] })).toMatchObject({ ok: true });
  });

  it('R-PRED-4 R-COACH-5 the type has no field for them (compile-time)', () => {
    // @ts-expect-error a prediction band is not expressible
    const a: HotRule = { anyOf: [{ claimKind: 'fact', band: 'high' }] };
    // @ts-expect-error a call score is not expressible
    const b: HotRule = { anyOf: [{ claimKind: 'fact', callScore: 3 }] };
    // @ts-expect-error a contact attribute is not expressible
    const c: HotRule = { anyOf: [{ claimKind: 'fact', contactStage: 'active' }] };
    expect([a, b, c].every((r) => parseHotRule(r).ok === false)).toBe(true);
  });
});
