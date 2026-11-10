import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { LeadSourceId, UserId } from '../foundation/index.js';
import { ROUTABLE_ROLES, canReceiveLead, claimBlock, isEligible, pondAllows, skipReason } from './eligibility.js';
import { matchRule, normalizeZip, offeredInCurrentSequence, parseRoutingMatch, ruleMatches, selectCandidate } from './routing.js';
import { Lead, RULE, SRC, U, candidate, member, pond, rule, userActor } from './testing/fixtures.js';
import type { Candidate, InquiryFacts, RotationCursor, RuleFacts } from './types.js';

const inquiry = (over: Partial<InquiryFacts> = {}): InquiryFacts => ({ leadSourceId: SRC, inquiryType: 'buy', postalCode: '10001', priceMinCents: null, priceMaxCents: null, ...over });

describe('matchRule (R-OWN-10)', () => {
  const r = (id: string, position: number, over: Partial<RuleFacts> = {}) => rule({ id: id as RuleFacts['id'], position, ...over });

  it('R-OWN-10: enabled rules by ascending position; the first match wins; no match ⇒ null (default pond)', () => {
    const rules = [
      r('d0000000-0000-7000-8000-000000000003', 3, {}),
      r('d0000000-0000-7000-8000-000000000001', 1, { match: { zips: ['94105'] } }),
      r('d0000000-0000-7000-8000-000000000002', 2, { match: { leadTypes: ['buy'] }, enabled: false }),
      r('d0000000-0000-7000-8000-000000000004', 2, { match: { leadTypes: ['sell'] } }),
    ];
    expect(matchRule(rules, inquiry({ postalCode: '94105-1234' }))?.position).toBe(1);
    expect(matchRule(rules, inquiry({ inquiryType: 'sell' }))?.position).toBe(2);
    expect(matchRule(rules, inquiry())?.position).toBe(3); // disabled rule 2 skipped
    expect(matchRule(rules.slice(1), inquiry())).toBeNull();
    expect(matchRule([], inquiry())).toBeNull();
    // equal positions (mid-reorder, the UNIQUE is deferrable) break ties by id; duplicate rows are harmless
    const tied = [r('d0000000-0000-7000-8000-00000000000b', 5), r('d0000000-0000-7000-8000-00000000000a', 5), r('d0000000-0000-7000-8000-00000000000a', 5)];
    expect(matchRule(tied, inquiry())?.id).toBe('d0000000-0000-7000-8000-00000000000a');
  });

  it('R-OWN-10: the four match fields — sources, lead types, zips, price band — must all hold', () => {
    const OTHER = 'e0000000-0000-7000-8000-000000000009' as LeadSourceId;
    expect(ruleMatches({ sources: [SRC] }, inquiry())).toBe(true);
    expect(ruleMatches({ sources: [OTHER] }, inquiry())).toBe(false);
    expect(ruleMatches({ sources: [SRC] }, inquiry({ leadSourceId: null }))).toBe(false);
    expect(ruleMatches({ leadTypes: ['rent'] }, inquiry())).toBe(false);
    expect(ruleMatches({ leadTypes: ['rent'] }, inquiry({ inquiryType: null }))).toBe(false);
    expect(ruleMatches({ zips: ['10001'] }, inquiry({ postalCode: ' 10001 ' }))).toBe(true);
    expect(ruleMatches({ zips: ['10001'] }, inquiry({ postalCode: 'SW1A 1AA' }))).toBe(false);
    expect(ruleMatches({ priceMin: 500_000_00, priceMax: 900_000_00 }, inquiry({ priceMinCents: 800_000_00, priceMaxCents: 1_200_000_00 }))).toBe(true);
    expect(ruleMatches({ priceMin: 500_000_00 }, inquiry({ priceMaxCents: 400_000_00 }))).toBe(false);
    expect(ruleMatches({ priceMax: 500_000_00 }, inquiry({ priceMinCents: 400_000_00 }))).toBe(true);
    expect(ruleMatches({ priceMax: 500_000_00 }, inquiry())).toBe(false); // no price never matches a price rule
    expect(ruleMatches({ sources: [], zips: [], leadTypes: [] }, inquiry({ postalCode: null }))).toBe(true);
    expect(ruleMatches({ sources: [SRC], leadTypes: ['buy'], zips: ['10001'], priceMin: 0 }, inquiry({ priceMinCents: 1 }))).toBe(true);
  });

  it('routing_rules.match is validated (Zod) and normalized', () => {
    expect(parseRoutingMatch({ sources: [SRC.toUpperCase()], lead_types: ['buy'], zips: ['10001-2222'], price_min: 1, price_max: 2 })).toEqual({
      ok: true,
      match: { sources: [SRC], leadTypes: ['buy'], zips: ['10001'], priceMin: 1, priceMax: 2 },
    });
    expect(parseRoutingMatch({})).toEqual({ ok: true, match: {} });
    for (const bad of [{ zips: ['1001'] }, { price_min: 3, price_max: 2 }, { lead_types: ['condo'] }, { polygon: [] }, { sources: ['x'] }, { price_min: -1 }, null]) {
      expect(parseRoutingMatch(bad)).toMatchObject({ ok: false, code: 'VALIDATION_FAILED' });
    }
    expect(normalizeZip(undefined)).toBeNull();
    expect(normalizeZip('12345 6789')).toBe('12345');
  });
});

describe('eligibility (R-OWN-11, R-PERM-15)', () => {
  it('R-OWN-11: checks run in order and the first failing one is the skip reason', () => {
    const worst = candidate(U.a, { status: 'suspended', role: 'tc', acceptingLeads: false, hasCriticalChannel: false, alreadyOffered: true, inReleaseCooldown: true, uncontactedOwned: 9 });
    const steps: [Partial<Candidate>, string | null][] = [
      [{}, 'MEMBERSHIP_INACTIVE'],
      [{ status: 'active' }, 'ROLE_NOT_ELIGIBLE'],
      [{ role: 'agent' }, 'NOT_ACCEPTING_LEADS'],
      [{ acceptingLeads: true }, 'NO_CRITICAL_CHANNEL'],
      [{ hasCriticalChannel: true }, 'ALREADY_OFFERED'],
      [{ alreadyOffered: false }, 'RELEASE_COOLDOWN'],
      [{ inReleaseCooldown: false }, 'CAPACITY_REACHED'],
      [{ uncontactedOwned: 4 }, null],
    ];
    let c: Candidate = worst;
    for (const [fix, expected] of steps) {
      c = { ...c, ...fix };
      expect(skipReason(c, 5)).toBe(expected);
    }
    expect(isEligible(c, 5)).toBe(true);
    expect(isEligible(c, 4)).toBe(false);
  });

  it('R-PERM-15 R-OWN-11: only agents, TLs and ISAs are routed to; TCs never own or claim', () => {
    expect([...ROUTABLE_ROLES].sort()).toEqual(['agent', 'isa', 'team_lead']);
    for (const role of ['owner', 'admin', 'tc'] as const) expect(skipReason(candidate(U.a, { role }), 5)).toBe('ROLE_NOT_ELIGIBLE');
    expect(pondAllows(pond({ eligibleRoles: ['agent', 'team_lead', 'isa', 'tc'] as never }), 'tc')).toBe(false);
    expect(canReceiveLead(member(U.tc))).toBe(false);
    expect(canReceiveLead(member(U.owner))).toBe(true);
    expect(canReceiveLead(undefined)).toBe(false);
    expect(claimBlock({ pond: pond(), member: member(U.tc), stats: { claimsToday: 0, inCooldown: false, uncontactedOwned: 0 }, capacityCap: 5 })).toBe('POND_NOT_ELIGIBLE');
  });
});

describe('selectCandidate (R-OWN-10)', () => {
  const members = [U.c, U.a, U.b].map((u) => candidate(u));

  it('R-OWN-10: round robin follows stable user_id order from the stored cursor and skips the ineligible', () => {
    let cursor: RotationCursor = {};
    const picks: (UserId | null)[] = [];
    for (let i = 0; i < 4; i++) {
      const s = selectCandidate(rule(), members, cursor);
      picks.push(s.pick);
      cursor = s.cursorAfter;
    }
    expect(picks).toEqual([U.a, U.b, U.c, U.a]);
    const withSkip = selectCandidate(rule(), [candidate(U.a), candidate(U.b, { acceptingLeads: false }), candidate(U.c)], { lastUserId: U.a });
    expect(withSkip.pick).toBe(U.c);
    expect(withSkip.considered).toEqual([{ userId: U.b, eligible: false, skipReason: 'NOT_ACCEPTING_LEADS' }, { userId: U.c, eligible: true }, { userId: U.a, eligible: true }]);
    // a cursor pointing at a removed member continues after it in user_id order
    expect(selectCandidate(rule(), [candidate(U.a), candidate(U.c)], { lastUserId: U.b }).pick).toBe(U.c);
    const none = selectCandidate(rule(), [candidate(U.a, { status: 'removed' })], { lastUserId: U.b });
    expect(none).toEqual({ pick: null, cursorAfter: { lastUserId: U.b }, considered: [{ userId: U.a, eligible: false, skipReason: 'MEMBERSHIP_INACTIVE' }] });
  });

  it('R-OWN-10: round robin over 1,000 rounds gives every eligible member an equal share', () => {
    let cursor: RotationCursor = {};
    const counts: Record<string, number> = {};
    for (let i = 0; i < 1000; i++) {
      const s = selectCandidate(rule(), members, cursor);
      counts[s.pick as string] = (counts[s.pick as string] ?? 0) + 1;
      cursor = s.cursorAfter;
    }
    expect(Object.values(counts).sort()).toEqual([333, 333, 334]);
  });

  it('R-OWN-10: smooth weighted round robin over 1,000 rounds matches the weights exactly per cycle, ties to the lowest user_id', () => {
    const weighted = [candidate(U.a, { weight: 5 }), candidate(U.b, { weight: 3 }), candidate(U.c, { weight: 2 })];
    const r = rule({ strategy: 'weighted' });
    let cursor: RotationCursor = {};
    const counts: Record<string, number> = {};
    const seq: string[] = [];
    for (let i = 0; i < 1000; i++) {
      const s = selectCandidate(r, weighted, cursor);
      counts[s.pick as string] = (counts[s.pick as string] ?? 0) + 1;
      if (i < 10) seq.push(s.pick as string);
      cursor = s.cursorAfter;
    }
    expect(counts).toEqual({ [U.a]: 500, [U.b]: 300, [U.c]: 200 });
    // smooth: never more than two heavy picks in a row, and the first tie goes to the lowest id
    expect(seq.slice(0, 10)).toEqual([U.a, U.b, U.c, U.a, U.a, U.b, U.a, U.c, U.b, U.a]);
    const tie = selectCandidate(r, [candidate(U.b), candidate(U.a)], {});
    expect(tie.pick).toBe(U.a);
    expect(tie.cursorAfter).toEqual({ current: { [U.a]: -1, [U.b]: 1 } });
  });

  it('R-OWN-10: weighted selection skips ineligible members without disturbing their state; removed members drop out', () => {
    const r = rule({ strategy: 'weighted' });
    const s = selectCandidate(r, [candidate(U.a, { weight: 2 }), candidate(U.b, { weight: 1, uncontactedOwned: 5 })], { current: { [U.a]: 0, [U.b]: 7, [U.c]: 4 } });
    expect(s.pick).toBe(U.a);
    expect(s.cursorAfter).toEqual({ current: { [U.a]: 0, [U.b]: 7 } });
    expect(s.considered[1]).toEqual({ userId: U.b, eligible: false, skipReason: 'CAPACITY_REACHED' });
    expect(selectCandidate(r, [candidate(U.a, { status: 'suspended' })], { current: {} })).toMatchObject({ pick: null, cursorAfter: { current: {} } });
  });

  it('R-OWN-10: selection is a pure function of (members, eligibility, cursor) and the pick is always eligible', () => {
    const arbCand = fc.record({
      userId: fc.constantFrom(U.a, U.b, U.c, U.tl, U.isa),
      weight: fc.integer({ min: 1, max: 100 }),
      status: fc.constantFrom('active', 'active', 'suspended'),
      acceptingLeads: fc.boolean(),
      hasCriticalChannel: fc.boolean(),
      inReleaseCooldown: fc.boolean(),
      uncontactedOwned: fc.integer({ min: 0, max: 7 }),
    });
    fc.assert(
      fc.property(fc.uniqueArray(arbCand, { maxLength: 5, selector: (m) => m.userId }), // routing_rule_members PK: one row per user
         fc.constantFrom('round_robin', 'weighted', 'direct', 'pond'), fc.option(fc.constantFrom(U.a, U.b, U.c), { nil: null }), (raw, strategy, last) => {
        const ms = raw.map((m) => candidate(m.userId, m as Partial<Candidate>));
        const r = rule({ strategy, directUserId: strategy === 'direct' ? U.b : null });
        const cur: RotationCursor = strategy === 'weighted' ? { current: last ? { [last]: 3 } : {} } : { lastUserId: last };
        const a = selectCandidate(r, ms, cur);
        const b = selectCandidate(r, [...ms].reverse(), cur);
        expect(a).toEqual(b);
        if (a.pick !== null) {
          const m = ms.find((x) => x.userId === a.pick) as Candidate;
          expect(skipReason(m, 5)).toBeNull();
          expect(a.considered.find((c) => c.userId === a.pick)?.eligible).toBe(true);
        }
        for (const c of a.considered) expect(c.eligible === (c.skipReason === undefined)).toBe(true);
        if (strategy === 'pond') expect(a.pick).toBeNull();
      }),
      { numRuns: 2000 },
    );
  });

  it('R-OWN-10: direct offers only the direct user; pond never picks', () => {
    expect(selectCandidate(rule({ strategy: 'direct', directUserId: U.b }), members, {}).pick).toBe(U.b);
    expect(selectCandidate(rule({ strategy: 'direct', directUserId: U.b }), [candidate(U.b, { hasCriticalChannel: false })], {})).toMatchObject({ pick: null, considered: [{ userId: U.b, skipReason: 'NO_CRITICAL_CHANNEL' }] });
    expect(selectCandidate(rule({ strategy: 'direct', directUserId: U.tl }), members, {})).toEqual({ pick: null, cursorAfter: {}, considered: [] });
    expect(selectCandidate(rule({ strategy: 'pond' }), members, {})).toEqual({ pick: null, cursorAfter: {}, considered: [] });
    expect(selectCandidate(rule(), [candidate(U.a), candidate(U.a)], {}).considered).toHaveLength(1);
  });
});

describe('offeredInCurrentSequence (R-OWN-11 step 5)', () => {
  it('collects offerees since the sequence began and resets when the lead is owned, ponded or closed', () => {
    const l = new Lead();
    l.run({ kind: 'create', via: 'intake' }, { routing: { rule: rule(), candidates: [candidate(U.a), candidate(U.b)], cursor: {}, alreadyOffered: [] } });
    l.run({ kind: 'decline', offerId: l.p.offerId as string }, { actor: userActor(U.a) });
    l.run({ kind: 'route' }, { routing: { rule: rule(), candidates: [candidate(U.a), candidate(U.b)], cursor: { lastUserId: U.a }, alreadyOffered: offeredInCurrentSequence(l.events) } });
    expect(offeredInCurrentSequence(l.events)).toEqual([U.a, U.b]);
    l.run({ kind: 'accept', offerId: l.p.offerId as string }, { actor: userActor(U.b), actorMember: member(U.b) });
    expect(offeredInCurrentSequence(l.events)).toEqual([]);
    expect(l.events.find((e) => e.type === 'offered')?.routingRuleId).toBe(RULE);
  });
});
