import { describe, expect, it } from 'vitest';
import { DEFAULT_ALLOC_RULES, proposeReallocation } from './propose.js';
import { tenantDailyTotal } from './total.js';
import { cap, campaign, cid, lid, out, outcomes, spend } from './testing/fixtures.js';
import { payloadNames } from './testing/trigger.js';
import type { Campaign, Hold, Proposal } from './types.js';

const R = DEFAULT_ALLOC_RULES;
const isProposal = (x: Proposal | Hold): x is Proposal => 'changes' in x;
const proposal = (x: Proposal | Hold): Proposal => {
  if (!isProposal(x)) throw new Error(`expected a proposal, got hold ${x.hold}`);
  return x;
};
const two = (): Campaign[] => [campaign(1), campaign(2)];
const twoSpend = [spend(1, 300_000), spend(2, 600_000)];
const twoOut = outcomes(out(1, 10, 2), out(2, 6, 1));

describe('proposeReallocation', () => {
  it('moves budget from the costlier to the cheaper campaign, keeping the total, with reasons and denominators', () => {
    const p = proposal(proposeReallocation(two(), twoSpend, twoOut, cap(), R));
    expect(p.changes).toEqual([{ campaign_id: cid(1), to_daily_cents: 12_000 }, { campaign_id: cid(2), to_daily_cents: 8_000 }]);
    expect(p.totals).toEqual({ currentDailyCents: 20_000, proposedDailyCents: 20_000, ceilingDailyCents: 100_000 });
    expect(p.capVersionId).toBe(cap().id);
    expect(p.rows.map((r) => [r.reasonCode, r.fromDailyCents, r.toDailyCents])).toEqual([['RAISED_LOWER_COST_PER_OUTCOME', 10_000, 12_000], ['LOWERED_HIGHER_COST_PER_OUTCOME', 10_000, 8_000]]);
    expect(p.rows[0]!.sentence).toBe('Raise from $100.00 to $120.00 a day: 10 agreements on $3,000.00 spent in 90 days ($300.00 per agreement), below the $562.50 per agreement across the 2 campaigns compared (16 agreements on $9,000.00).');
    expect(p.rows[1]!.sentence).toBe('Lower from $100.00 to $80.00 a day: 6 agreements on $6,000.00 spent in 90 days ($1,000.00 per agreement), above the $562.50 per agreement across the 2 campaigns compared (16 agreements on $9,000.00).');
    for (const r of p.rows) expect(r.reasonCode).toMatch(/^[A-Z][A-Z0-9_]*$/);
  });

  it('R-ADS-2: the changes JSON gives x->>\'to_daily_cents\' equal to the bigint text, never "5000.0"', () => {
    const p = proposal(proposeReallocation(two(), twoSpend, twoOut, cap(), R));
    const json = JSON.stringify({ changes: p.changes });
    expect(json).toBe(`{"changes":[{"campaign_id":"${cid(1)}","to_daily_cents":12000},{"campaign_id":"${cid(2)}","to_daily_cents":8000}]}`);
    for (const ch of p.changes) {
      expect(Number.isSafeInteger(ch.to_daily_cents)).toBe(true);
      expect(payloadNames(json, ch.campaign_id, BigInt(ch.to_daily_cents))).toBe(true);
      expect(Object.keys(ch)).toEqual(['campaign_id', 'to_daily_cents']);
    }
  });

  it('R-ADS-6: 4 agreements hold, 5 move; the hold carries every campaign\'s counts and the minimum', () => {
    const cs = [campaign(1), campaign(2), campaign(3, { connectionKind: 'ads_meta' })];
    const sp = [spend(1, 300_000), spend(2, 600_000), spend(3, 50_000)];
    const held = proposeReallocation(cs, sp, outcomes(out(1, 10), out(2, 4, 1), out(3, 9)), cap(), R);
    expect(held).toEqual({
      hold: 'ADS_BELOW_MINIMUM_SAMPLE',
      counts: { windowDays: 90, minAgreements: 5, leadingOutcome: 'agreements', campaigns: [
        { campaignId: cid(1), agreements: 10, closings: 0, spendCents: 300_000 },
        { campaignId: cid(2), agreements: 4, closings: 1, spendCents: 600_000 },
        { campaignId: cid(3), agreements: 9, closings: 0, spendCents: 50_000 },
      ] },
    });
    const moved = proposal(proposeReallocation(cs, sp, outcomes(out(1, 10), out(2, 5, 1), out(3, 9)), cap(), R));
    expect(moved.changes.map((c) => c.campaign_id)).toEqual([cid(1), cid(2)]);
  });

  it('R-ADS-6: a thin campaign keeps its budget and stays out of the moves; the others still move', () => {
    const p = proposal(proposeReallocation([campaign(1), campaign(2), campaign(3)], [...twoSpend, spend(3, 10_000)], outcomes(out(1, 10), out(2, 6), out(3, 4)), cap(), R));
    const thin = p.rows.find((r) => r.campaignId === cid(3))!;
    expect(thin).toMatchObject({ changed: false, reasonCode: 'KEPT_BELOW_MINIMUM_SAMPLE', fromDailyCents: 10_000, toDailyCents: 10_000 });
    expect(thin.sentence).toBe('Keep at $100.00 a day: 4 agreements in 90 days, fewer than the 5 needed before money moves to or from a campaign.');
    expect(p.changes.map((c) => c.campaign_id)).toEqual([cid(1), cid(2)]);
  });

  it('R-ADS-4 R-FH-4: a campaign with forbidden targeting, a non-housing category or no approved creative of its own listing is never moved, and is listed with the validator\'s issues', () => {
    const bad: Partial<Campaign>[] = [
      { targeting: { geo: 'radius_of_listing', radiusMiles: 20, zips: ['00000'] } },
      { targeting: { geo: 'radius_of_listing', radiusMiles: 20, neighborhood: 'Example Heights' } },
      { targeting: { geo: 'radius_of_listing', radiusMiles: 20, customAudience: 'list-1' } },
      { targeting: { geo: 'radius_of_listing', radiusMiles: 20, lookalike: true } },
      { targeting: { geo: 'radius_of_listing', radiusMiles: 20, predictionBand: 'likely_90d' } },
      { targeting: { geo: 'radius_of_listing', radiusMiles: 5 } },
      { specialCategory: 'none' },
      { creative: null },
      { creative: { pieceId: cid(9) as never, status: 'draft', listingId: lid(3) } },
      { creative: { pieceId: cid(9) as never, status: 'retracted', listingId: lid(3) } },
      { creative: { pieceId: cid(9) as never, status: 'approved', listingId: lid(4) } },
      { listingId: null },
    ];
    for (const over of bad) {
      const cs = [...two(), campaign(3, over)];
      const p = proposal(proposeReallocation(cs, [...twoSpend, spend(3, 100)], outcomes(out(1, 10), out(2, 6), out(3, 50)), cap(), R));
      const row = p.rows.find((r) => r.campaignId === cid(3))!;
      expect(row.changed).toBe(false);
      expect(row.reasonCode).toBe('KEPT_NOT_ELIGIBLE');
      expect(row.blockers.length).toBeGreaterThan(0);
      expect(p.changes.some((c) => c.campaign_id === cid(3))).toBe(false);
      if (over.targeting !== undefined) {
        expect(row.blockers).toContain('TARGETING_REFUSED');
        expect(row.targetingIssues.length).toBeGreaterThan(0);
      }
    }
    const zip = proposal(proposeReallocation([...two(), campaign(3, bad[0])], [...twoSpend], twoOut, cap(), R)).rows[2]!;
    expect(zip.targetingIssues).toEqual(['zips: ZIP or neighborhood geography cannot be used for targeting']);
    expect(zip.sentence).toBe('Keep at $100.00 a day: not moved, because it is its targeting is refused.');
  });

  it('D2: an ads_meta campaign never appears in changes, yet counts in the total', () => {
    const meta = campaign(3, { connectionKind: 'ads_meta', dailyBudgetCents: 70_000, latestEvent: null });
    const cs = [...two(), meta];
    const p = proposal(proposeReallocation(cs, [...twoSpend, spend(3, 1)], outcomes(out(1, 10), out(2, 6), out(3, 99)), cap({ dailyCeilingCents: 90_000 }), R));
    expect(p.changes.some((c) => c.campaign_id === cid(3))).toBe(false);
    expect(p.rows[2]!.blockers).toEqual(['NOT_GOOGLE_ADS']);
    expect(p.totals.currentDailyCents).toBe(90_000);
    expect(tenantDailyTotal(cs, p.changes)).toBe(90_000);
  });

  it('over the ceiling, the total is lowered to fit: costliest first', () => {
    const p = proposal(proposeReallocation(two(), twoSpend, twoOut, cap({ dailyCeilingCents: 15_000 }), R));
    expect(p.totals).toEqual({ currentDailyCents: 20_000, proposedDailyCents: 15_000, ceilingDailyCents: 15_000 });
    expect(p.rows.map((r) => [r.reasonCode, r.toDailyCents])).toEqual([['RAISED_LOWER_COST_PER_OUTCOME', 12_000], ['LOWERED_TO_FIT_CEILING', 3_000]]);
    expect(p.rows[1]!.sentence).toBe('Lower from $100.00 to $30.00 a day so the daily budgets total $150.00, within the cap\'s daily ceiling of $150.00: 6 agreements on $6,000.00 spent in 90 days ($1,000.00 per agreement).');
  });

  it('holds when no plan fits the ceiling, and when nothing would move', () => {
    const fixed = campaign(3, { connectionKind: 'ads_meta', dailyBudgetCents: 120_000, latestEvent: null });
    expect(proposeReallocation([...two(), fixed], twoSpend, twoOut, cap(), R)).toMatchObject({ hold: 'ADS_NO_PLAN_FITS' });
    expect(proposeReallocation(two(), twoSpend, twoOut, cap({ dailyCeilingCents: 1_000 }), { ...R, minDailyCents: 1_000 })).toMatchObject({ hold: 'ADS_NO_PLAN_FITS' });
    expect(proposeReallocation(two(), [spend(1, 300_000), spend(2, 300_000)], outcomes(out(1, 6), out(2, 6)), cap(), R)).toMatchObject({ hold: 'ADS_NOTHING_TO_MOVE' });
    expect(proposeReallocation(two(), twoSpend, twoOut, cap(), { ...R, maxShiftBps: 0 })).toMatchObject({ hold: 'ADS_NOTHING_TO_MOVE' });
  });

  it('at the cap, money only moves between campaigns (the total stays at the ceiling)', () => {
    // E123 (example; the property test proves it)
    const p = proposal(proposeReallocation(two(), twoSpend, twoOut, cap({ dailyCeilingCents: 20_000 }), R));
    expect(p.totals).toEqual({ currentDailyCents: 20_000, proposedDailyCents: 20_000, ceilingDailyCents: 20_000 });
  });

  it('a proposal never adds spend below the ceiling', () => {
    const p = proposal(proposeReallocation(two(), twoSpend, twoOut, cap({ dailyCeilingCents: 1_000_000, monthlyCapCents: 1_000_000 }), R));
    expect(p.totals.proposedDailyCents).toBe(p.totals.currentDailyCents);
  });

  it('a rejected campaign gets nothing, and no proposal carries targeting', () => {
    // E146 (core half): no fallback targeting; module 52 records the platform's reason.
    const rejected = campaign(3, { status: 'rejected', targeting: { geo: 'radius_of_listing', radiusMiles: 20, secretMarker: 'TARGET-VALUE-77' } });
    const p = proposal(proposeReallocation([...two(), rejected], [...twoSpend, spend(3, 1_000)], outcomes(out(1, 10), out(2, 6), out(3, 40)), cap(), R));
    expect(p.rows[2]).toMatchObject({ changed: false, fromDailyCents: 0, toDailyCents: 0, reasonCode: 'KEPT_NOT_ELIGIBLE' });
    expect(p.rows[2]!.blockers).toContain('REJECTED');
    const json = JSON.stringify(p);
    expect(json).not.toContain('TARGET-VALUE-77');
    expect(json).not.toContain('radius_of_listing');
    expect(json).not.toMatch(/"targeting"/);
  });

  it('a paused campaign is never raised: resuming is a tap', () => {
    for (const paused of [campaign(1, { status: 'paused' }), campaign(1, { latestEvent: { kind: 'paused', toDailyCents: 0 } })]) {
      const cs = [paused, campaign(2), campaign(3)];
      const p = proposeReallocation(cs, [spend(1, 1_000), spend(2, 600_000), spend(3, 900_000)], outcomes(out(1, 50), out(2, 6), out(3, 6)), cap(), R);
      const row = isProposal(p) ? p.rows[0]! : null;
      if (row !== null) {
        expect(row).toMatchObject({ changed: false, toDailyCents: 0 });
        expect(row.blockers).toContain('PAUSED');
      }
      if (isProposal(p)) expect(p.changes.some((c) => c.campaign_id === cid(1))).toBe(false);
    }
  });

  it('a campaign with a change in flight, a disconnected account or a draft status is not moved', () => {
    const cases: [Partial<Campaign>, string][] = [
      [{ latestEvent: { kind: 'planned', toDailyCents: 5_000 } }, 'CHANGE_IN_FLIGHT'],
      [{ connectionStatus: 'revoked' }, 'CONNECTION_NOT_LIVE'],
      [{ connectionStatus: 'pending_review' }, 'CONNECTION_NOT_LIVE'],
      [{ status: 'draft' }, 'NOT_ACTIVE'],
      [{ status: 'ended' }, 'NOT_ACTIVE'],
    ];
    for (const [over, code] of cases) {
      const p = proposal(proposeReallocation([...two(), campaign(3, over)], [...twoSpend, spend(3, 1)], outcomes(out(1, 10), out(2, 6), out(3, 90)), cap(), R));
      expect(p.rows[2]!.blockers).toContain(code);
      expect(p.rows[2]!.changed).toBe(false);
    }
    const degraded = proposal(proposeReallocation([campaign(1, { connectionStatus: 'degraded' }), campaign(2)], twoSpend, twoOut, cap(), R));
    expect(degraded.changes).toHaveLength(2);
  });

  it('is deterministic and independent of input order', () => {
    // E145 (core half): the same inputs give the same proposal; the DB's unique keys refuse a replayed run.
    const cs = [campaign(1), campaign(2), campaign(3), campaign(4, { dailyBudgetCents: 7_777, latestEvent: null })];
    const sp = [spend(1, 300_000), spend(2, 600_000), spend(3, 450_000), spend(4, 120_000)];
    const oc = outcomes(out(1, 10), out(2, 6), out(3, 9), out(4, 7));
    const a = proposeReallocation(cs, sp, oc, cap(), R);
    const b = proposeReallocation([...cs].reverse(), [...sp].reverse(), { ...oc, campaigns: [...oc.campaigns].reverse() }, cap(), R);
    expect(b).toEqual(a);
    expect(proposeReallocation(cs, sp, oc, cap(), R)).toEqual(a);
  });

  it('leading outcome closings: zero closings rank costliest and never divide by zero', () => {
    const rules = { ...R, leadingOutcome: 'closings' as const };
    const p = proposal(proposeReallocation(two(), twoSpend, outcomes(out(1, 10, 0), out(2, 6, 3)), cap(), rules));
    expect(p.rows.map((r) => r.reasonCode)).toEqual(['LOWERED_HIGHER_COST_PER_OUTCOME', 'RAISED_LOWER_COST_PER_OUTCOME']);
    expect(p.rows[0]!.sentence).toBe('Lower from $100.00 to $80.00 a day: no closings on $3,000.00 spent in 90 days, above the $3,000.00 per closing across the 2 campaigns compared (3 closings on $9,000.00).');
    // no closings anywhere: nothing to compare, but a ceiling cut still fits the total
    const none = outcomes(out(1, 10, 0), out(2, 6, 0));
    expect(proposeReallocation(two(), twoSpend, none, cap(), rules)).toMatchObject({ hold: 'ADS_NOTHING_TO_MOVE' });
    const fit = proposal(proposeReallocation(two(), twoSpend, none, cap({ dailyCeilingCents: 19_000 }), rules));
    expect(fit.rows[0]!.sentence).toContain('no closings on $3,000.00 spent in 90 days');
    expect(fit.totals.proposedDailyCents).toBe(19_000);
  });

  it('a compared campaign that ends up unchanged, or has agreements and no spend, says so', () => {
    const cs = [campaign(1), campaign(2), campaign(3), campaign(4)];
    const p = proposal(proposeReallocation(cs, [spend(1, 300_000), spend(2, 600_000), spend(3, 450_000)], outcomes(out(1, 10), out(2, 6), out(3, 8), out(4, 20)), cap(), R));
    const pooled = p.rows.find((r) => r.campaignId === cid(3))!;
    expect(pooled.reasonCode).toBe('KEPT_UNCHANGED');
    expect(pooled.sentence).toMatch(/^Keep at \$100\.00 a day: 8 agreements on \$4,500\.00 spent in 90 days \(\$562\.50 per agreement\), against the \$562\.50 per agreement/);
    const nospend = p.rows.find((r) => r.campaignId === cid(4))!;
    expect(nospend).toMatchObject({ reasonCode: 'KEPT_NO_SPEND', changed: false });
    expect(nospend.sentence).toBe('Keep at $100.00 a day: no spend reported in 90 days, so its cost per agreement cannot be measured.');
  });

  it('leftover cents of the pool go to the cheapest campaign first', () => {
    const cs = [campaign(1, { dailyBudgetCents: 10_001, latestEvent: null }), campaign(2), campaign(3)];
    const p = proposal(proposeReallocation(cs, [spend(1, 900_000), spend(2, 100_000), spend(3, 100_000)], outcomes(out(1, 5), out(2, 5), out(3, 5)), cap(), R));
    // pool = round(10_001 × 20 %) = 2_000 → 1_000 each; with an odd pool the cheaper-by-id campaign gets the extra cent
    expect(p.totals.proposedDailyCents).toBe(p.totals.currentDailyCents);
    const odd = proposal(proposeReallocation([campaign(1, { dailyBudgetCents: 10_005, latestEvent: null }), campaign(2), campaign(3)], [spend(1, 900_000), spend(2, 100_000), spend(3, 100_000)], outcomes(out(1, 5), out(2, 5), out(3, 5)), cap(), R));
    expect(odd.rows.map((r) => r.toDailyCents)).toEqual([8_004, 11_001, 11_000]);
  });
});
