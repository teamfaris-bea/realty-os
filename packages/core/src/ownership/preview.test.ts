// R-LSRC-4: previewRouting mirrors route() for a new lead. Unit cases per outcome, and a property: for random routing
// snapshots, the person or pond the preview names equals what decide()'s `create via intake` emits.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { UserId } from '../foundation/index.js';
import { decide } from './decide.js';
import { previewRouting } from './routing.js';
import { DEFAULT_POND, FALLBACK_POND, OTHER_POND, SETTINGS, SRC, U, candidate, ctx, rule, systemActor } from './testing/fixtures.js';
import type { Candidate, InquiryFacts, RotationCursor, RuleFacts } from './types.js';

const S = { defaultPondId: SETTINGS.defaultPondId, maxOffers: SETTINGS.maxOffers, uncontactedCapacityCap: SETTINGS.uncontactedCapacityCap };
const BUY: InquiryFacts = { leadSourceId: SRC, inquiryType: 'buy', postalCode: '10001', priceMinCents: null, priceMaxCents: null };

describe('previewRouting (R-LSRC-4)', () => {
  it('R-LSRC-4: no rule ⇒ the default pond (NO_RULE_MATCH); a pond rule ⇒ its pond (RULE_POND)', () => {
    expect(previewRouting([], BUY, [], {}, S)).toMatchObject({ kind: 'pond', pondId: DEFAULT_POND, reasonCode: 'NO_RULE_MATCH', rule: null });
    expect(previewRouting([rule({ strategy: 'pond', targetPondId: OTHER_POND })], BUY, [], {}, S)).toMatchObject({ kind: 'pond', pondId: OTHER_POND, reasonCode: 'RULE_POND' });
  });

  it('R-LSRC-4 E334: a round-robin mid-round names the next member after the cursor and leaves the cursor as it was', () => {
    const cursor: RotationCursor = { lastUserId: U.a };
    const p = previewRouting([rule()], BUY, [candidate(U.a), candidate(U.b)], cursor, S);
    expect(p).toMatchObject({ kind: 'offer', userId: U.b });
    expect(cursor).toEqual({ lastUserId: U.a });
  });

  it('R-LSRC-4 E336: no eligible member ⇒ the fallback pond with each skipped member and its reason', () => {
    const p = previewRouting([rule({ strategy: 'direct', directUserId: U.a, fallbackPondId: FALLBACK_POND })], BUY, [candidate(U.a, { status: 'suspended' })], {}, S);
    expect(p).toEqual({ kind: 'pond', rule: expect.anything(), pondId: FALLBACK_POND, reasonCode: 'NO_ELIGIBLE_AGENT', considered: [{ userId: U.a, eligible: false, skipReason: 'MEMBERSHIP_INACTIVE' }] });
  });

  it('R-LSRC-4: a price-band rule matches only an inquiry with a price', () => {
    const banded = rule({ match: { priceMin: 100_000_00, priceMax: 500_000_00 } });
    expect(previewRouting([banded], BUY, [candidate(U.a)], {}, S).kind).toBe('pond');
    expect(previewRouting([banded], { ...BUY, priceMinCents: 200_000_00, priceMaxCents: 300_000_00 }, [candidate(U.a)], {}, S)).toMatchObject({ kind: 'offer', userId: U.a });
  });

  it('R-LSRC-5 E335: a direct rule below a catch-all never wins; moved to the top it does', () => {
    const catchAll = rule({ id: 'd0000000-0000-7000-8000-0000000000aa' as RuleFacts['id'], position: 1 });
    const direct = rule({ id: 'd0000000-0000-7000-8000-0000000000bb' as RuleFacts['id'], position: 2, strategy: 'direct', directUserId: U.c, match: { sources: [SRC] } });
    expect(previewRouting([catchAll, direct], BUY, [candidate(U.a)], {}, S)).toMatchObject({ rule: { id: catchAll.id } });
    expect(previewRouting([{ ...direct, position: 0 }, catchAll], BUY, [candidate(U.c)], {}, S)).toMatchObject({ kind: 'offer', userId: U.c, rule: { id: direct.id } });
  });

  it('R-LSRC-4: for random snapshots, the preview names the person or pond decide() routes a new intake lead to', () => {
    const users = [U.a, U.b, U.c, U.isa, U.tc, U.tl] as UserId[];
    const cand = fc.record({
      userId: fc.constantFrom(...users),
      weight: fc.integer({ min: 1, max: 4 }),
      status: fc.constantFrom('active', 'active', 'suspended'),
      acceptingLeads: fc.boolean(),
      hasCriticalChannel: fc.boolean(),
      inReleaseCooldown: fc.constant(false),
      uncontactedOwned: fc.integer({ min: 0, max: 7 }),
    });
    const ruleArb = fc.record({
      strategy: fc.constantFrom('round_robin', 'weighted', 'direct', 'pond'),
      direct: fc.constantFrom(...users),
      types: fc.subarray(['buy', 'sell', 'rent', 'value', 'general'] as const),
      fallback: fc.boolean(),
      maxOffers: fc.option(fc.integer({ min: 0, max: 3 })),
    });
    fc.assert(
      fc.property(fc.array(ruleArb, { maxLength: 3 }), fc.array(cand, { maxLength: 6 }), fc.constantFrom('buy', 'sell', 'general'), fc.option(fc.constantFrom(...users)), (rs, cs, type, last) => {
        const rules: RuleFacts[] = rs.map((r, i) => rule({
          id: `d0000000-0000-7000-8000-00000000000${i}` as RuleFacts['id'], position: i + 1, strategy: r.strategy, directUserId: r.direct,
          targetPondId: r.strategy === 'pond' ? OTHER_POND : null, fallbackPondId: r.fallback ? FALLBACK_POND : null, maxOffers: r.maxOffers, match: r.types.length ? { leadTypes: [...r.types] } : {},
        }));
        const inquiry: InquiryFacts = { ...BUY, inquiryType: type };
        const candidates: Candidate[] = cs.map((c) => candidate(c.userId, c));
        const cursor: RotationCursor = last ? { lastUserId: last } : {};
        const p = previewRouting(rules, inquiry, candidates, cursor, S);
        // what the router reads: the matched rule's members (direct: the direct user only)
        const matched = p.rule;
        const snapCandidates = matched?.strategy === 'direct' ? candidates.filter((c) => c.userId === matched.directUserId).slice(0, 1) : candidates;
        const d = decide(null, { kind: 'create', via: 'intake' }, ctx({ actor: systemActor('provider'), routing: { rule: matched, candidates: snapCandidates, cursor, alreadyOffered: [] } }));
        if (!d.ok) throw new Error('decide rejected');
        const routed = d.events[1]!;
        if (p.kind === 'offer') expect(routed).toMatchObject({ type: 'offered', offeredToUserId: p.userId });
        else expect(routed).toMatchObject({ type: 'sent_to_pond', pondId: p.pondId, reasonCode: p.reasonCode });
      }),
      { numRuns: 2000, seed: 20261112 },
    );
  });
});
