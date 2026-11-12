// The weekly proposal (module 52; R-ADS-2, R-ADS-6, R-ADS-10; E123). Real Postgres as app_user; FakeAds on a manual clock;
// the network tripwire is installed.
import { DAY_MS } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call } from '../admin/testing.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { installNetworkTripwire } from '../providers/integrations/spark.testing.js';
import { runReconcile } from './mirror.js';
import { proposalKey, runWeeklyProposal } from './propose.js';
import { type AdsWorld, actionOf, adsWorld, campaignOf, connectAds, dealsFor, depsOf, resetAdsPack, setCapVia, spendHistory, thisMonday, withAdsCleared } from './testing.js';

const tripwire = installNetworkTripwire();
let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
}, 240_000);
afterAll(async () => {
  await resetAdsPack(h);
  await h?.close();
  expect(tripwire.attempts).toEqual([]);
});

/** Two linked, active campaigns with 90 days of spend; outcomes per campaign ref; a cap. */
async function world(o: { cheapAgreements?: number; costlyAgreements?: number; ceiling?: number; refPrefix?: string } = {}): Promise<{ w: AdsWorld; accountId: string }> {
  const w = await adsWorld(h);
  const { accountId } = await connectAds(h, w, undefined, {
    campaigns: [
      { externalCampaignId: 'fake-c-cheap', dailyBudgetCents: 3000 },
      { externalCampaignId: 'fake-c-costly', dailyBudgetCents: 3000 },
    ],
  });
  await runReconcile(depsOf(h, w), w.tenantId);
  for (const ext of ['fake-c-cheap', 'fake-c-costly']) {
    const c = (await campaignOf(h, w.tenantId, ext))!;
    expect((await call(w.owner, 'PATCH', `/ads/campaigns/${c.id}`, { listingId: w.listingId, creativePieceId: w.pieceId })).status).toBe(200);
  }
  spendHistory(w, accountId, 'fake-c-cheap', 2000);
  spendHistory(w, accountId, 'fake-c-costly', 4000);
  const prefix = o.refPrefix ?? 'gads:';
  await dealsFor(h, w, `${prefix}fake-c-cheap`, o.cheapAgreements ?? 6);
  await dealsFor(h, w, `${prefix}fake-c-costly`, o.costlyAgreements ?? 5);
  await setCapVia(h, w.owner, 3_000_000, o.ceiling ?? 10_000);
  await runReconcile(depsOf(h, w), w.tenantId);
  return { w, accountId };
}

const monday = thisMonday();
const at = (w: AdsWorld, ms: number) => depsOf(h, w, { now: () => ms as never });

describe('the weekly proposal (R-ADS-6, R-ADS-10)', () => {
  it('R-ADS-10: once per local Monday: another weekday builds nothing, a second Monday wake finds it; the proposal is ownerless and contactless, money, requiring approval', async () => {
    await withAdsCleared(h, async () => {
      const { w } = await world();
      expect((await runWeeklyProposal(at(w, monday + DAY_MS), w.tenantId)).outcome).toBe('not_proposal_day');
      const p = await runWeeklyProposal(at(w, monday), w.tenantId);
      expect(p.outcome).toBe('proposed');
      expect((await runWeeklyProposal(at(w, monday + 3_600_000), w.tenantId)).outcome).toBe('exists');
      const a = (await h.su.query('SELECT kind, action_category, autonomy, status, owner_user_id, contact_id, dedupe_key, payload FROM assistant_actions WHERE id = $1', [p.actionId])).rows[0];
      expect(a).toMatchObject({ kind: 'ad_reallocation', action_category: 'money', autonomy: 'requires_approval', status: 'proposed', owner_user_id: null, contact_id: null, dedupe_key: proposalKey(p.week!) });
      expect(a.payload).toMatchObject({ v: 1, kind: 'weekly', leading_outcome: 'agreements', window: { days: 90 } });
      expect(a.payload.changes).toHaveLength(2);
      // every row says why, with its denominators; no confidence anywhere
      for (const r of a.payload.rows as { sentence: string }[]) expect(r.sentence).toMatch(/agreements? on \$[\d,]+\.\d\d spent in 90 days/);
      expect(JSON.stringify(a.payload)).not.toMatch(/confidence|probabilit/i);
    });
  });

  it('R-ADS-6: below 5 agreements a campaign the proposal is a hold, stored blocked with every campaign\'s counts, and never plannable', async () => {
    await withAdsCleared(h, async () => {
      const { w } = await world({ costlyAgreements: 3 });
      const p = await runWeeklyProposal(at(w, monday), w.tenantId);
      expect(p.outcome).toBe('held');
      const a = (await actionOf(h, p.actionId!))!;
      expect(a.status).toBe('blocked');
      expect(a.payload).toMatchObject({ v: 1, hold: 'ADS_BELOW_MINIMUM_SAMPLE' });
      expect((a.payload.counts as { campaigns: { agreements: number }[] }).campaigns.map((c) => c.agreements).sort()).toEqual([3, 6]);
      expect(a.explanation).toMatch(/1 of 2 campaigns had 5 or more agreements in 90 days/);
      expect((await call(w.owner, 'POST', `/ads/proposals/${p.actionId}/approve`)).code).toBe('ACTION_NOT_PENDING');
      const ov = (await call<{ latestHold: { id: string } | null; pendingProposal: unknown }>(w.owner, 'GET', '/ads')).body;
      expect(ov.latestHold?.id).toBe(p.actionId);
      expect(ov.pendingProposal).toBeNull();
    });
  });

  it('R-ADS-10: a new week\'s result supersedes the pending proposal', async () => {
    await withAdsCleared(h, async () => {
      const { w } = await world();
      const last = await runWeeklyProposal(at(w, monday - 7 * DAY_MS), w.tenantId);
      expect(last.outcome).toBe('proposed');
      const now = await runWeeklyProposal(at(w, monday), w.tenantId);
      expect(now).toMatchObject({ outcome: 'proposed', superseded: 1 });
      expect((await actionOf(h, last.actionId!))!.status).toBe('superseded');
    });
  });

  it('R-ADS-7: nothing is proposed while dark, without a cap, or with only an ads_meta connection; only gads: refs count as outcomes', async () => {
    const { w } = await withAdsCleared(h, () => world());
    expect((await runWeeklyProposal(at(w, monday), w.tenantId)).outcome).toBe('not_cleared');
    await withAdsCleared(h, async () => {
      const bare = await adsWorld(h);
      expect((await runWeeklyProposal(at(bare, monday), bare.tenantId)).outcome).toBe('no_cap');
      await setCapVia(h, bare.owner, 300_000, 10_000);
      expect((await runWeeklyProposal(at(bare, monday), bare.tenantId)).outcome).toBe('no_connection');
      // outcomes under another ref prefix never count: both campaigns are below the sample, so a hold
      const other = await world({ refPrefix: 'other:' });
      const p = await runWeeklyProposal(at(other.w, monday), other.w.tenantId);
      expect(p.outcome).toBe('held');
    });
  });

  it('R-ADS-2 E123: at the ceiling, money only moves between campaigns: the proposed total equals today\'s and stays within the ceiling', async () => {
    await withAdsCleared(h, async () => {
      const { w } = await world({ ceiling: 6000 });
      const p = await runWeeklyProposal(at(w, monday), w.tenantId);
      expect(p.outcome).toBe('proposed');
      const totals = (await actionOf(h, p.actionId!))!.payload.totals as { currentDailyCents: number; proposedDailyCents: number; ceilingDailyCents: number };
      expect(totals).toEqual({ currentDailyCents: 6000, proposedDailyCents: 6000, ceilingDailyCents: 6000 });
      const r = await call<{ status: string }>(w.owner, 'POST', `/ads/proposals/${p.actionId}/approve`);
      expect(r.body.status).toBe('executed');
    });
  });
});
