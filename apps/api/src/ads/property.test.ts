// Property tests of module 52 against real Postgres (fast-check, ≤ 25 runs; own arbitraries in ads/testing.ts; history made
// only through the mirror, FakeAds and dispatch, and paused rows written directly as the system):
//   R-ADS-2  every core Proposal the weekly job stores is planned and committed by ads/dispatch.ts without AD_CAP_EXCEEDED,
//            and no proposal exceeds the cap's daily ceiling (PHASE2_3_PLAN exit criterion 4);
//   R-ADS-2  core's tenantDailyTotal equals the total app.ad_allocation_cap_check() counts, read from the message of an
//            over-ceiling probe (a planned row in a rolled-back transaction), before and after the apply.
import { type Campaign, tenantDailyTotal } from '@realty/core/ads';
import { withTenantTx } from '@realty/db';
import fc from 'fast-check';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call } from '../admin/testing.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { installNetworkTripwire } from '../providers/integrations/spark.testing.js';
import { systemActor } from '../worker/systemActor.js';
import { runReconcile } from './mirror.js';
import { runWeeklyProposal } from './propose.js';
import * as repo from './repo.js';
import { type AdsWorld, adsWorld, campaignOf, connectAds, dealsFor, depsOf, resetAdsPack, setAdsPack, setCapVia, spendHistory, thisMonday, worldSpecArb } from './testing.js';

const tripwire = installNetworkTripwire();
let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
  await setAdsPack(h, { reviewed: true, vendor: true });
}, 240_000);
afterAll(async () => {
  await resetAdsPack(h);
  await h?.close();
  expect(tripwire.attempts).toEqual([]);
});

const pausedArb = fc.array(fc.boolean(), { minLength: 5, maxLength: 5 });

async function coreCampaigns(w: AdsWorld): Promise<Campaign[]> {
  return withTenantTx(systemActor(w.tenantId, 'provider'), async (tx) => (await repo.campaignRows(tx)).map(repo.toCoreCampaign), { db: h.database });
}

/** The total the DB trigger counts, read from an over-ceiling probe's AD_CAP_EXCEEDED message (rolled back). */
async function triggerTotal(w: AdsWorld, campaignId: string, toDailyCents: number): Promise<{ total: number; ceiling: number }> {
  let message = '';
  try {
    await withTenantTx(w.owner.actor(), async (tx) => {
      const cap = (await repo.capInForce(tx))!;
      const actionId = randomUUID();
      await sql`INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload, decided_by_user_id, decided_at)
                VALUES (app.tenant_id(), ${actionId}::uuid, NULL, 'ad_reallocation', 'money', 'requires_approval', 'approved', NULL, 'probe',
                        ${JSON.stringify({ v: 1, changes: [{ campaign_id: campaignId, to_daily_cents: toDailyCents }] })}::jsonb, app.user_id(), now())`.execute(tx);
      await sql`INSERT INTO ad_allocation_events (tenant_id, id, run_id, campaign_id, event_kind, cap_version_id, assistant_action_id, from_daily_cents, to_daily_cents, reason_code, occurred_at)
                VALUES (app.tenant_id(), ${randomUUID()}::uuid, ${randomUUID()}::uuid, ${campaignId}::uuid, 'planned', ${cap.id}::uuid, ${actionId}::uuid, 0, ${toDailyCents}, 'PROBE', now())`.execute(tx);
      await sql`SET CONSTRAINTS ALL IMMEDIATE`.execute(tx);
      throw new Error('probe was not refused');
    }, { db: h.database });
  } catch (e) {
    message = (e as Error).message;
  }
  const m = /^AD_CAP_EXCEEDED: daily budgets would total (\d+) against the cap's daily ceiling (\d+)$/.exec(message);
  if (!m) throw new Error(`unexpected probe result: ${message}`);
  return { total: Number(m[1]), ceiling: Number(m[2]) };
}

describe('the DB trigger and core/ads agree (R-ADS-2)', () => {
  it('R-ADS-2 E123: over random campaign sets, every stored proposal stays within the ceiling and is planned and committed in one tap without AD_CAP_EXCEEDED; tenantDailyTotal equals the trigger\'s own count before and after', async () => {
    const seen = { proposals: 0, holds: 0, probes: 0 };
    await fc.assert(
      fc.asyncProperty(worldSpecArb, pausedArb, async (spec, pausedFlags) => {
        const w = await adsWorld(h);
        const campaigns = spec.campaigns.map((c, i) => ({ ...c, ext: `fake-p-${i}`, pausedRow: pausedFlags[i] === true && i > 0 }));
        const { accountId } = await connectAds(h, w, undefined, { campaigns: campaigns.map((c) => ({ externalCampaignId: c.ext, dailyBudgetCents: c.budgetCents })) });
        await runReconcile(depsOf(h, w), w.tenantId);
        for (const c of campaigns.filter((x) => x.linked)) {
          const row = (await campaignOf(h, w.tenantId, c.ext))!;
          expect((await call(w.owner, 'PATCH', `/ads/campaigns/${row.id}`, { listingId: w.listingId, creativePieceId: w.pieceId })).status).toBe(200);
        }
        await setCapVia(h, w.owner, 10_000_000, 10_000_000);
        await runReconcile(depsOf(h, w), w.tenantId);
        // history: a pause recorded directly by the system (it only lowers spend)
        for (const c of campaigns.filter((x) => x.pausedRow)) {
          const row = (await campaignOf(h, w.tenantId, c.ext))!;
          await withTenantTx(systemActor(w.tenantId, 'provider'), async (tx) => {
            const cap = (await repo.capInForce(tx))!;
            await repo.insertEvent(tx, { id: randomUUID(), runId: randomUUID(), campaignId: row.id, kind: 'paused', capVersionId: cap.id, actionId: null, fromDailyCents: c.budgetCents, toDailyCents: 0, reasonCode: 'MONTHLY_CAP_REACHED', providerRef: 'fake-ads-ref' });
          }, { db: h.database });
        }
        for (const c of campaigns) {
          if (c.spendPerDayCents > 0) spendHistory(w, accountId, c.ext, c.spendPerDayCents);
          if (c.agreements > 0) await dealsFor(h, w, `gads:${c.ext}`, c.agreements);
        }
        const before = await coreCampaigns(w);
        const ceiling = Math.max(0, tenantDailyTotal(before) + spec.ceilingSlackCents);
        expect((await setCapVia(h, w.owner, 10_000_000, ceiling)).status).toBe(201);

        // the trigger's own count of today's total, against core's
        const probeId = before[0]!.id as string;
        const pre = await triggerTotal(w, probeId, ceiling + 1);
        expect(pre).toEqual({ total: tenantDailyTotal(before, [{ campaign_id: probeId, to_daily_cents: ceiling + 1 }]), ceiling });
        seen.probes += 1;

        const p = await runWeeklyProposal(depsOf(h, w, { now: () => thisMonday() as never }), w.tenantId);
        if (p.outcome !== 'proposed') {
          expect(p.outcome).toBe('held');
          seen.holds += 1;
          return;
        }
        seen.proposals += 1;
        const stored = (await h.su.query('SELECT payload FROM assistant_actions WHERE id = $1', [p.actionId])).rows[0].payload as { totals: { proposedDailyCents: number; ceilingDailyCents: number }; changes: { campaign_id: string; to_daily_cents: number }[] };
        expect(stored.totals.proposedDailyCents).toBeLessThanOrEqual(ceiling);
        expect(tenantDailyTotal(before, stored.changes)).toBe(stored.totals.proposedDailyCents);
        const r = await call<{ status: string; rows: { outcome: string }[] }>(w.owner, 'POST', `/ads/proposals/${p.actionId}/approve`);
        expect(r.status, JSON.stringify(r.body)).toBe(200);
        expect(r.body.status).toBe('executed');
        expect(r.body.rows.every((x) => x.outcome === 'applied')).toBe(true);
        const after = await coreCampaigns(w);
        expect(tenantDailyTotal(after)).toBeLessThanOrEqual(ceiling);
        const post = await triggerTotal(w, probeId, ceiling + 1);
        expect(post.total).toBe(tenantDailyTotal(after, [{ campaign_id: probeId, to_daily_cents: ceiling + 1 }]));
        seen.probes += 1;
      }),
      // 12 runs with a fixed seed: each run builds a whole tenant on real Postgres (VERIFY: enough runs for the time it takes)
      { numRuns: 12, seed: 52, endOnFailure: true },
    );
    // the run is not vacuous: it saw proposals, holds and probes
    expect(seen.proposals).toBeGreaterThan(0);
    expect(seen.holds).toBeGreaterThan(0);
    expect(seen.probes).toBeGreaterThanOrEqual(12);
  }, 900_000);
});
