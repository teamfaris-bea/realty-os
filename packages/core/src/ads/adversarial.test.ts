// Adversarial cases for core/ads (critical: money). Core takes no tenant input and adds no route,
// handler, SQL or provider; the money rules it owns are the cap total, the sample minimum and who may move.
import { describe, expect, it } from 'vitest';
import { DEFAULT_ALLOC_RULES, proposeReallocation } from './propose.js';
import { tenantDailyTotal } from './total.js';
import { cap, campaign, cid, out, outcomes, spend, uid } from './testing/fixtures.js';
import type { Campaign, CapVersionId, Proposal } from './types.js';

const R = DEFAULT_ALLOC_RULES;
const base = (): Campaign[] => [campaign(1), campaign(2)];
const sp = [spend(1, 300_000), spend(2, 600_000)];
const oc = outcomes(out(1, 10), out(2, 6));
const run = (over: { c?: Campaign[]; s?: typeof sp; o?: typeof oc; k?: ReturnType<typeof cap>; r?: typeof R } = {}) =>
  proposeReallocation(over.c ?? base(), over.s ?? sp, over.o ?? oc, over.k ?? cap(), over.r ?? R);

describe('core/ads adversarial', () => {
  it('NaN, negative, fractional and unsafe cents are refused with a RangeError', () => {
    for (const bad of [Number.NaN, -1, 0.5, 2 ** 53, Number.POSITIVE_INFINITY, '100' as unknown as number]) {
      expect(() => run({ c: [campaign(1, { dailyBudgetCents: bad }), campaign(2)] })).toThrow(RangeError);
      expect(() => run({ c: [campaign(1, { latestEvent: { kind: 'applied', toDailyCents: bad } }), campaign(2)] })).toThrow(RangeError);
      expect(() => run({ s: [spend(1, bad), spend(2, 1)] })).toThrow(RangeError);
      expect(() => run({ o: outcomes(out(1, bad), out(2, 6)) })).toThrow(RangeError);
      expect(() => run({ k: cap({ monthlyCapCents: bad }) })).toThrow(RangeError);
      expect(() => run({ k: cap({ dailyCeilingCents: bad }) })).toThrow(RangeError);
      expect(() => tenantDailyTotal(base(), [{ campaign_id: cid(1), to_daily_cents: bad }])).toThrow(RangeError);
    }
    // sums that would leave the safe range are refused, not rounded
    const huge = [campaign(1, { dailyBudgetCents: 2 ** 52, latestEvent: null }), campaign(2, { dailyBudgetCents: 2 ** 52, latestEvent: null }), campaign(3, { dailyBudgetCents: 2 ** 52, latestEvent: null })];
    expect(() => tenantDailyTotal(huge)).toThrow(RangeError);
  });

  it('duplicate campaign ids, spend rows, outcome rows or changes are refused', () => {
    expect(() => run({ c: [campaign(1), campaign(1)] })).toThrow(RangeError);
    expect(() => run({ s: [spend(1, 1), spend(1, 2)] })).toThrow(RangeError);
    expect(() => run({ o: outcomes(out(1, 6), out(1, 7)) })).toThrow(RangeError);
    expect(() => tenantDailyTotal(base(), [{ campaign_id: cid(1), to_daily_cents: 1 }, { campaign_id: cid(1), to_daily_cents: 2 }])).toThrow(RangeError);
    expect(() => tenantDailyTotal(base(), [{ campaign_id: cid(9), to_daily_cents: 1 }])).toThrow(/AD_CAMPAIGN_UNKNOWN/);
  });

  it('outcomes and spend for unknown campaigns name nothing and move nothing', () => {
    const p = run({ s: [...sp, spend(77, 1)], o: outcomes(out(1, 10), out(2, 6), out(77, 1_000)) }) as Proposal;
    expect(p.changes.map((c) => c.campaign_id)).toEqual([cid(1), cid(2)]);
    expect(p.counts.campaigns.map((c) => c.campaignId)).toEqual([cid(1), cid(2)]);
    expect(JSON.stringify(p)).not.toContain(cid(77));
  });

  it('\'ADS_GOOGLE\' and \'ads_google \' spoofs are never moved, and still count in the total', () => {
    for (const kind of ['ADS_GOOGLE', 'ads_google ', ' ads_google', 'ads_google\u200B', 'google_ads']) {
      const spoof = campaign(3, { connectionKind: kind });
      const p = run({ c: [...base(), spoof], s: [...sp, spend(3, 1)], o: outcomes(out(1, 10), out(2, 6), out(3, 500)) }) as Proposal;
      expect(p.changes.some((c) => c.campaign_id === cid(3))).toBe(false);
      expect(p.rows[2]!.blockers).toContain('NOT_GOOGLE_ADS');
      expect(p.totals.currentDailyCents).toBe(30_000);
    }
  });

  it('unknown statuses, spoofed statuses and non-canonical ids are refused', () => {
    expect(() => run({ c: [campaign(1, { status: 'Active' as never }), campaign(2)] })).toThrow(RangeError);
    expect(() => run({ c: [campaign(1, { connectionStatus: 'Connected' as never }), campaign(2)] })).toThrow(RangeError);
    expect(() => run({ c: [campaign(1, { latestEvent: { kind: 'approved' as never, toDailyCents: 1 } }), campaign(2)] })).toThrow(RangeError);
    expect(() => run({ c: [campaign(1, { latestEvent: { kind: 'paused', toDailyCents: 5 } }), campaign(2)] })).toThrow(RangeError);
    expect(() => run({ c: [campaign(1, { connectionKind: 7 as never }), campaign(2)] })).toThrow(RangeError);
    expect(() => run({ c: [campaign(1, { specialCategory: null as never }), campaign(2)] })).toThrow(RangeError);
    expect(() => run({ c: [campaign(1, { id: uid(0xabc).toUpperCase() as never }), campaign(2)] })).toThrow(RangeError);
    expect(() => run({ c: [campaign(1, { listingId: 'L1' as never }), campaign(2)] })).toThrow(RangeError);
    expect(() => run({ c: [campaign(1, { creative: { pieceId: 'p' as never, status: 'approved', listingId: campaign(1).listingId! } }), campaign(2)] })).toThrow(RangeError);
    expect(() => run({ c: [campaign(1, { creative: { pieceId: campaign(1).creative!.pieceId, status: 3 as never, listingId: campaign(1).listingId! } }), campaign(2)] })).toThrow(RangeError);
    expect(() => run({ c: 'x' as never })).toThrow(RangeError);
  });

  it('a cap whose daily ceiling exceeds its monthly cap, a bad version or window, and bad rules are refused', () => {
    expect(() => run({ k: cap({ dailyCeilingCents: 10, monthlyCapCents: 9 }) })).toThrow(RangeError);
    expect(() => run({ k: cap({ versionNo: 0 }) })).toThrow(RangeError);
    expect(() => run({ k: cap({ id: 'cap-1' as never }) })).toThrow(RangeError);
    expect(() => run({ k: cap({ effectiveFrom: Number.NaN as never }) })).toThrow(RangeError);
    expect(() => run({ o: { ...oc, windowDays: 30 } })).toThrow(RangeError);
    expect(() => run({ s: [spend(1, 1, 30), spend(2, 1)] })).toThrow(RangeError);
    for (const r of [{ windowDays: 0 }, { minAgreements: 0 }, { leadingOutcome: 'appointments' }, { maxShiftBps: 10_001 }, { maxShiftBps: -1 }, { minDailyCents: -1 }]) {
      expect(() => run({ r: { ...R, ...r } as never })).toThrow(RangeError);
    }
  });

  it('a stale cap version: the proposal cites exactly the cap it was given, so the DB can refuse a stale one', () => {
    const old = cap({ id: uid(0x901) as CapVersionId, versionNo: 2, dailyCeilingCents: 100_000 });
    const inForce = cap({ id: uid(0x902) as CapVersionId, versionNo: 3, dailyCeilingCents: 15_000 });
    const p = run({ k: old }) as Proposal;
    expect([p.capVersionId, p.capVersionNo]).toEqual([old.id, 2]);
    // AD_CAP_VERSION_STALE: the trigger compares the cited id with the version in force
    expect(p.capVersionId === inForce.id).toBe(false);
    // and the version in force would have needed a cut, which only a proposal against it carries
    expect((run({ k: inForce }) as Proposal).totals.proposedDailyCents).toBeLessThanOrEqual(15_000);
  });

  it('a proposal never raises a paused, rejected or ended campaign, even with outstanding outcomes', () => {
    for (const status of ['paused', 'rejected', 'ended', 'draft'] as const) {
      const p = run({ c: [...base(), campaign(3, { status })], s: [...sp, spend(3, 1)], o: outcomes(out(1, 10), out(2, 6), out(3, 10_000)) }) as Proposal;
      expect(p.rows[2]).toMatchObject({ changed: false, toDailyCents: 0 });
    }
  });
});
