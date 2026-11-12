import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { instant } from '../foundation/index.js';
import { overspend } from './overspend.js';
import { DEFAULT_ALLOC_RULES, eligibility, proposeReallocation } from './propose.js';
import { tenantDailyTotal } from './total.js';
import { worldArb } from './testing/arbitraries.js';
import { cap, cid } from './testing/fixtures.js';
import { triggerTotal, payloadNames, type LedgerRow } from './testing/trigger.js';
import type { AllocRules, HourlySpend, Proposal } from './types.js';

const rulesArb: fc.Arbitrary<AllocRules> = fc.record({
  windowDays: fc.constant(90), minAgreements: fc.constantFrom(5, 5, 1, 12), leadingOutcome: fc.constantFrom('agreements', 'closings'),
  maxShiftBps: fc.constantFrom(2000, 2000, 0, 500, 10_000), minDailyCents: fc.constantFrom(0, 0, 100, 5_000),
});

describe('proposeReallocation (properties)', () => {
  it('R-ADS-2 E123: the proposal\'s total, counted the trigger\'s way, is ≤ the ceiling; at the cap it never rises; only eligible campaigns change', () => {
    const seen = { proposals: 0, overCeiling: 0, holds: 0 };
    fc.assert(fc.property(worldArb, rulesArb, (w, rules) => {
      const r = proposeReallocation(w.campaigns, w.spend, w.outcomes, w.cap, rules);
      const current = tenantDailyTotal(w.campaigns);
      if (!('changes' in r)) {
        seen.holds += 1;
        expect(['ADS_BELOW_MINIMUM_SAMPLE', 'ADS_NO_PLAN_FITS', 'ADS_NOTHING_TO_MOVE']).toContain(r.hold);
        expect(r.counts.campaigns.map((x) => x.campaignId)).toEqual([...w.campaigns.map((c) => c.id)].sort());
        return;
      }
      const p: Proposal = r;
      seen.proposals += 1;
      if (current > w.cap.dailyCeilingCents) seen.overCeiling += 1;
      // the trigger, over the real ledger plus this run's planned rows (untouched campaigns count too)
      const run = '00000051-0000-7000-8000-00000000ffff';
      const planned: LedgerRow[] = p.changes.map((ch, i) => ({ id: `00000051-0000-7000-8000-0000000fff${i.toString(16).padStart(2, '0')}`, run_id: run, campaign_id: ch.campaign_id, event_kind: 'planned', to_daily_cents: ch.to_daily_cents, occurred_at: 1_000 }));
      const rows = w.campaigns.map((c) => ({ id: c.id, status: c.status, daily_budget_cents: c.dailyBudgetCents }));
      const after = triggerTotal(rows, [...w.ledger, ...planned], run);
      expect(after).toBe(tenantDailyTotal(w.campaigns, p.changes));
      expect(after).toBe(p.totals.proposedDailyCents);
      expect(after).toBeLessThanOrEqual(w.cap.dailyCeilingCents);
      expect(after).toBeLessThanOrEqual(current);
      if (current <= w.cap.dailyCeilingCents) expect(after).toBe(current); // never adds spend, never cuts below need
      expect(p.totals.currentDailyCents).toBe(triggerTotal(rows, w.ledger, run));
      // only eligible campaigns with the minimum sample change; every change is named exactly in the payload
      const json = JSON.stringify({ changes: p.changes });
      for (const ch of p.changes) {
        const c = w.campaigns.find((x) => x.id === ch.campaign_id)!;
        expect(eligibility(c).blockers).toEqual([]);
        expect(w.outcomes.campaigns.find((o) => o.campaignId === c.id)!.agreements).toBeGreaterThanOrEqual(rules.minAgreements);
        expect(Number.isSafeInteger(ch.to_daily_cents) && ch.to_daily_cents >= 0).toBe(true);
        expect(payloadNames(json, ch.campaign_id, BigInt(ch.to_daily_cents))).toBe(true);
      }
      expect(p.capVersionId).toBe(w.cap.id);
      expect(new Set(p.changes.map((c) => c.campaign_id)).size).toBe(p.changes.length);
      for (const row of p.rows) {
        expect(row.reasonCode).toMatch(/^[A-Z][A-Z0-9_]*$/);
        if (row.changed && row.toDailyCents > row.fromDailyCents) expect(w.campaigns.find((c) => c.id === row.campaignId)!.status).toBe('active');
      }
    }), { numRuns: 4000 });
    // the generator must exercise real proposals, including ones that start over the ceiling
    expect(seen.proposals).toBeGreaterThan(400);
    expect(seen.overCeiling).toBeGreaterThan(40);
    expect(seen.holds).toBeGreaterThan(400);
  });

  it('is independent of input order', () => {
    fc.assert(fc.property(worldArb, (w) => {
      const a = proposeReallocation(w.campaigns, w.spend, w.outcomes, w.cap, DEFAULT_ALLOC_RULES);
      const b = proposeReallocation([...w.campaigns].reverse(), [...w.spend].reverse(), { ...w.outcomes, campaigns: [...w.outcomes.campaigns].reverse() }, w.cap, DEFAULT_ALLOC_RULES);
      expect(b).toEqual(a);
    }), { numRuns: 500 });
  });
});

describe('overspend (properties)', () => {
  const hourly = fc.array(fc.record({ n: fc.integer({ min: 1, max: 6 }), hour: fc.integer({ min: 0, max: 700 }), cents: fc.integer({ min: 0, max: 200_000 }) }), { maxLength: 40 })
    .map((xs) => {
      const seen = new Set<string>();
      return xs.filter((x) => !seen.has(`${x.n}@${x.hour}`) && seen.add(`${x.n}@${x.hour}`))
        .map((x): HourlySpend => ({ campaignId: cid(x.n), hourStart: instant(x.hour * 3_600_000), spendCents: x.cents }));
    });

  it('is monotone in spend: more spend never un-pauses a campaign', () => {
    fc.assert(fc.property(hourly, fc.integer({ min: 0, max: 3_000_000 }), fc.integer({ min: 0, max: 200_000 }), (rows, monthly, extra) => {
      const c = cap({ monthlyCapCents: monthly, dailyCeilingCents: Math.min(monthly, 1_000) });
      const before = overspend(rows, c);
      if (rows.length === 0) return;
      const more = rows.map((r, i) => (i === 0 ? { ...r, spendCents: r.spendCents + extra } : r));
      const after = overspend(more, c);
      for (const id of before) expect(after).toContain(id);
      expect(before.length === 0 || before.length === new Set(rows.map((r) => r.campaignId)).size).toBe(true);
    }), { numRuns: 2000 });
  });

  it('is all or nothing, exactly at month-to-date ≥ the monthly cap', () => {
    fc.assert(fc.property(hourly, fc.integer({ min: 0, max: 3_000_000 }), (rows, monthly) => {
      const mtd = rows.reduce((t, r) => t + r.spendCents, 0);
      const ids = [...new Set(rows.map((r) => r.campaignId))].sort();
      expect(overspend(rows, cap({ monthlyCapCents: monthly, dailyCeilingCents: 0 }))).toEqual(mtd >= monthly ? ids : []);
    }));
  });
});
