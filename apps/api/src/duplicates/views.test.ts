// Property tests on the pure decisions of api/duplicates: they must agree with the ownership engine's
// own rules (core mergeOwnership / decideMerge), so the page never offers a merge the engine refuses for
// a reason it could have shown up front (R-OWN-24, R-PAR-44).
import type { ContactId, Instant, UserId } from '@realty/core/foundation';
import { type OwnershipProjection, mergeOwnership } from '@realty/core/ownership';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type OwnerFacts, canMergeAs, mergeOwnerRule, suggestedSurvivor } from './views.js';

const USERS = ['00000000-0000-7000-8000-000000000001', '00000000-0000-7000-8000-000000000002', '00000000-0000-7000-8000-000000000003'];
const STATES = ['owned', 'unassigned', 'in_pond', 'offered', 'closed'] as const;

const facts = fc.record({
  id: fc.uuid(),
  ownershipState: fc.constantFrom(...STATES),
  ownerUserId: fc.constantFrom(...USERS),
  ownedAt: fc.integer({ min: 1, max: 1_000_000 }),
  createdAt: fc.integer({ min: 1, max: 1_000_000 }),
}) as fc.Arbitrary<OwnerFacts>;

function projection(f: OwnerFacts): OwnershipProjection {
  return {
    state: f.ownershipState,
    ownerUserId: f.ownershipState === 'owned' ? (f.ownerUserId as UserId) : null,
    ownedAt: f.ownershipState === 'owned' ? (f.ownedAt as Instant) : null,
  } as unknown as OwnershipProjection;
}

describe('api/duplicates decisions', () => {
  it('R-OWN-24: mergeOwnerRule agrees with core mergeOwnership: `choose` exactly when the engine answers MERGE_OWNER_REQUIRED, with the same preselected owner', () => {
    fc.assert(
      fc.property(facts, facts, (s, l) => {
        const core = mergeOwnership(projection(s), projection(l), null);
        const mine = mergeOwnerRule(s, l);
        if (!core.ok && core.code === 'MERGE_OWNER_REQUIRED') {
          expect(mine.rule).toBe('choose');
          if (mine.rule === 'choose') expect(mine.preselectedUserId).toBe(core.preselected);
        } else {
          expect(mine.rule).toBe('same');
          if (core.ok && mine.rule === 'same') expect(mine.userId).toBe(core.ownerUserId);
        }
      }),
      { numRuns: 500 },
    );
  });

  it('R-OWN-24: the preselected owner is always one of the two owners, and choosing it is accepted by the engine', () => {
    fc.assert(
      fc.property(facts, facts, (s, l) => {
        const mine = mergeOwnerRule(s, l);
        if (mine.rule !== 'choose') return;
        expect(mine.candidates).toContain(mine.preselectedUserId);
        expect(mergeOwnership(projection(s), projection(l), mine.preselectedUserId as UserId).ok).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it('R-PAR-44: the suggested survivor is one of the two, the earlier record, and does not depend on argument order', () => {
    fc.assert(
      fc.property(facts, facts, (a, b) => {
        fc.pre(a.id !== b.id);
        const s = suggestedSurvivor(a, b);
        expect([a.id, b.id]).toContain(s);
        expect(suggestedSurvivor(b, a)).toBe(s);
        const other = s === a.id ? b : a;
        const me = s === a.id ? a : b;
        expect(me.createdAt <= other.createdAt).toBe(true);
      }),
    );
  });

  it('R-PERM-15 R-PERM-6: a TC never merges; an agent/ISA never merges a pond or offer card or across two owners; Owner/Admin/TL may', () => {
    fc.assert(
      fc.property(facts, facts, fc.constantFrom('owner', 'admin', 'team_lead', 'agent', 'isa', 'tc' as const), (a, b, role) => {
        const ok = canMergeAs(role, a, b);
        if (role === 'tc') expect(ok).toBe(false);
        else if (role === 'owner' || role === 'admin' || role === 'team_lead') expect(ok).toBe(true);
        else {
          const card = [a, b].some((x) => x.ownershipState === 'in_pond' || x.ownershipState === 'offered');
          expect(ok).toBe(!card && mergeOwnerRule(a, b).rule === 'same');
        }
      }),
      { numRuns: 500 },
    );
  });

  it('R-OWN-24: ties in creation time pick the smaller id (stable)', () => {
    const a = { id: 'b0000000-0000-7000-8000-000000000000' as ContactId, ownershipState: 'owned', ownerUserId: USERS[0]!, ownedAt: 1, createdAt: 5 };
    const b = { ...a, id: 'a0000000-0000-7000-8000-000000000000' as ContactId };
    expect(suggestedSurvivor(a, b)).toBe(b.id);
  });
});
