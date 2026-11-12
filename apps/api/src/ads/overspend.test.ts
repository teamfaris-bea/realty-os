// The hourly overspend check (module 52; R-ADS-5, R-TEN-7; E124, E449, E452; PHASE2_3_PLAN exit criterion 4: reconcile
// pauses within 1 h on the simulated platform). Real Postgres as app_user; FakeAds on a manual clock (its spend accrues
// hour by hour); the network tripwire is installed.
import { HOUR_MS } from '@realty/core/foundation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, freshReauth } from '../admin/testing.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { installNetworkTripwire } from '../providers/integrations/spark.testing.js';
import { overspendText, runReconcile, uncheckedText } from './mirror.js';
import { type AdsWorld, adsWorld, campaignOf, connectAds, depsOf, ledgerOf, resetAdsPack, setAdsPack, setCapVia, withAdsCleared } from './testing.js';

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

const alerts = async (tenantId: string) =>
  (await h.su.query<{ title: string; body: string; priority: string; user_id: string; dedupe_key: string }>(
    "SELECT title, body, priority, user_id, dedupe_key FROM notifications WHERE tenant_id = $1 AND kind = 'ad_overspend' ORDER BY created_at, user_id", [tenantId])).rows;
const sms = async (tenantId: string) => (await h.su.query("SELECT count(*)::int AS n FROM notification_deliveries d JOIN notifications n ON n.tenant_id = d.tenant_id AND n.id = d.notification_id WHERE d.tenant_id = $1 AND n.kind = 'ad_overspend' AND d.channel = 'sms'", [tenantId])).rows[0].n as number;

/** Two campaigns spending $1 an hour each (budget $24/day), one linked and managed, one running unmanaged (E449). */
async function spending(w: AdsWorld, o: { leadSource?: boolean } = {}) {
  const { connectionId, accountId } = await connectAds(h, w, undefined, {
    ...(o.leadSource === false ? { leadSource: false } : {}),
    campaigns: [{ externalCampaignId: 'fake-c-a', name: 'Oak St A', dailyBudgetCents: 2400 }, { externalCampaignId: 'fake-c-b', name: 'Oak St B', dailyBudgetCents: 2400 }],
  });
  await runReconcile(depsOf(h, w), w.tenantId);
  if (o.leadSource !== false) {
    const a = (await campaignOf(h, w.tenantId, 'fake-c-a'))!;
    await call(w.owner, 'PATCH', `/ads/campaigns/${a.id}`, { listingId: w.listingId, creativePieceId: w.pieceId });
    await runReconcile(depsOf(h, w), w.tenantId);
  }
  return { connectionId, accountId };
}

describe('pause at the monthly cap (R-ADS-5)', () => {
  it('R-ADS-5 E449: on the simulated platform every campaign (managed or not) is paused by the first hourly pass after month-to-date spend reaches the cap; the pause rows carry the cap in force; one alert per Owner/Admin, in-app and push, never SMS', async () => {
    await withAdsCleared(h, async () => {
      const w = await adsWorld(h);
      const { accountId } = await spending(w);
      const cap = await setCapVia(h, w.owner, 1_000, 1_000); // $10 a month: 5 hours of $2/h
      const start = w.clock.now();
      let pausedAtHour: number | null = null;
      for (let hour = 1; hour <= 8 && pausedAtHour === null; hour++) {
        w.clock.advance(HOUR_MS);
        await runReconcile(depsOf(h, w), w.tenantId);
        if (w.fake.statusOf(accountId, 'fake-c-a') === 'paused') pausedAtHour = hour;
      }
      // month-to-date reached $10 after 5 hours of spend; the pass at that hour paused both: within 1 h
      const reachedAt = start + 5 * HOUR_MS;
      expect(pausedAtHour).toBe(5);
      expect(start + pausedAtHour! * HOUR_MS - reachedAt).toBeLessThanOrEqual(HOUR_MS);
      expect(w.fake.statusOf(accountId, 'fake-c-b')).toBe('paused');
      expect(w.fake.totalSpend(accountId)).toBe(1_000);
      const paused = (await ledgerOf(h, w.tenantId)).filter((e) => e.event_kind === 'paused');
      expect(paused).toHaveLength(2);
      for (const p of paused) expect(p).toMatchObject({ to: 0, reason_code: 'MONTHLY_CAP_REACHED', cap_version_id: cap.body.cap.id, provider_ref: expect.stringMatching(/^fake-ads-op-/) });
      expect((await campaignOf(h, w.tenantId, 'fake-c-a'))!.status).toBe('paused');
      const n = await alerts(w.tenantId);
      expect(n.map((x) => x.user_id).sort()).toEqual([w.owner.userId, w.admin.userId].sort());
      expect(n[0]).toMatchObject({ priority: 'high', title: 'Google Ads paused at your monthly cap', body: 'Paused 2 campaigns: month-to-date spend reached your $10.00 cap.' });
      expect(await sms(w.tenantId)).toBe(0);
      // a later pass pauses nothing more and sends nothing more; a campaign re-enabled in Google Ads is paused again
      w.clock.advance(HOUR_MS);
      await runReconcile(depsOf(h, w), w.tenantId);
      expect((await ledgerOf(h, w.tenantId)).filter((e) => e.event_kind === 'paused')).toHaveLength(2);
      w.fake.setStatus(accountId, 'fake-c-b', 'enabled');
      w.clock.advance(HOUR_MS);
      await runReconcile(depsOf(h, w), w.tenantId);
      expect(w.fake.statusOf(accountId, 'fake-c-b')).toBe('paused');
      expect(await alerts(w.tenantId)).toHaveLength(2);
      const audit = (await h.su.query("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'ads.campaign_paused'", [w.tenantId])).rows[0].n;
      expect(audit).toBe(3);
    });
  });

  it('E452 R-ADS-7 R-ADS-5: while dark the cap only alerts ("pause them in Google Ads"): no provider write, no pause row', async () => {
    const w = await adsWorld(h);
    const { accountId } = await spending(w);
    await setCapVia(h, w.owner, 500, 500);
    for (let i = 0; i < 4; i++) {
      w.clock.advance(HOUR_MS);
      await runReconcile(depsOf(h, w), w.tenantId);
    }
    expect(w.fake.calls.filter((c) => c.op === 'pauseCampaign' || c.op === 'applyBudgetChange')).toEqual([]);
    expect(w.fake.statusOf(accountId, 'fake-c-a')).toBe('enabled');
    expect((await ledgerOf(h, w.tenantId))).toEqual([]);
    const n = await alerts(w.tenantId);
    expect(n).toHaveLength(2);
    expect(n[0]!.body).toBe('Month-to-date spend reached your $5.00 cap. Realty OS cannot pause campaigns until counsel review and the Google Ads check are complete: pause them in Google Ads.');
  });

  it('R-ADS-5 E452: a connection that never had a lead source: the cap only alerts, from the account\'s month-to-date spend (nothing is mirrored to pause)', async () => {
    const w = await adsWorld(h);
    try {
      await setAdsPack(h, { reviewed: true, vendor: true });
      await spending(w, { leadSource: false });
      await setCapVia(h, w.owner, 500, 500);
      for (let i = 0; i < 4; i++) {
        w.clock.advance(HOUR_MS);
        await runReconcile(depsOf(h, w), w.tenantId);
      }
    } finally {
      await resetAdsPack(h);
    }
    expect(w.fake.calls.filter((c) => c.op === 'pauseCampaign')).toEqual([]);
    const n = await alerts(w.tenantId);
    expect(n).toHaveLength(2);
    expect(n[0]!.body).toMatch(/^Month-to-date spend reached your \$5\.00 cap\. The Google Ads account has no lead source, so Realty OS has no record of some running campaigns and cannot pause them: pause them in Google Ads\.$/);
  });

  it('R-ADS-5 E452 (b11 sends-gates/F2): an Admin clears the lead source after mirroring: the cap still pauses every mirrored campaign; one added in Google Ads since is not recorded, so its alert says "pause them in Google Ads"', async () => {
    await withAdsCleared(h, async () => {
      const w = await adsWorld(h);
      const { connectionId, accountId } = await spending(w);
      await setCapVia(h, w.owner, 300, 300); // $3 a month: 2 hours of $2/h
      // the state PATCH /admin/integrations/connections/:id allows an Admin (integration.manage)
      await freshReauth(h, w.admin);
      const cleared = await call<{ connection: { leadSourceId: string | null } }>(w.admin, 'PATCH', `/admin/integrations/connections/${connectionId}`, { leadSourceId: null });
      expect(cleared.status).toBe(200);
      expect(cleared.body.connection.leadSourceId).toBeNull();
      w.fake.addCampaign(accountId, { externalCampaignId: 'fake-c-new', name: 'Oak St new', dailyBudgetCents: 2400 });
      for (let hour = 1; hour <= 8; hour++) {
        w.clock.advance(HOUR_MS);
        await runReconcile(depsOf(h, w), w.tenantId);
      }
      expect(w.fake.statusOf(accountId, 'fake-c-a')).toBe('paused');
      expect(w.fake.statusOf(accountId, 'fake-c-b')).toBe('paused');
      expect((await campaignOf(h, w.tenantId, 'fake-c-a'))!.status).toBe('paused');
      expect((await ledgerOf(h, w.tenantId)).filter((e) => e.event_kind === 'paused')).toHaveLength(2);
      // never mirrored without a lead source, so Realty OS has no record to pause it with
      expect(await campaignOf(h, w.tenantId, 'fake-c-new')).toBeUndefined();
      expect(w.fake.statusOf(accountId, 'fake-c-new')).toBe('enabled');
      const n = await alerts(w.tenantId);
      expect(n.filter((x) => x.title === 'Google Ads paused at your monthly cap').map((x) => x.user_id).sort()).toEqual([w.owner.userId, w.admin.userId].sort());
      const rest = n.filter((x) => x.title !== 'Google Ads paused at your monthly cap');
      expect(rest).toHaveLength(2);
      expect(rest[0]!.body).toMatch(/no lead source/);
      expect(rest[0]!.body).toMatch(/pause them in Google Ads\.$/);
    });
  });

  it('R-ADS-7 E452 (b11 ads-16): the pack withdrawn during a pass: no pause call after the withdrawal; the alert says "pause them in Google Ads"', async () => {
    await withAdsCleared(h, async () => {
      const w = await adsWorld(h);
      const { accountId } = await spending(w);
      await setCapVia(h, w.owner, 300, 300);
      // the first pause of the pass succeeds; counsel withdraws the pack right after it
      w.fake.afterChange = async (op) => {
        if (op === 'pauseCampaign') await resetAdsPack(h);
      };
      for (let hour = 1; hour <= 4; hour++) {
        w.clock.advance(HOUR_MS);
        await runReconcile(depsOf(h, w), w.tenantId);
      }
      expect(w.fake.calls.filter((c) => c.op === 'pauseCampaign')).toHaveLength(1);
      expect([w.fake.statusOf(accountId, 'fake-c-a'), w.fake.statusOf(accountId, 'fake-c-b')].sort()).toEqual(['enabled', 'paused']);
      expect((await ledgerOf(h, w.tenantId)).filter((e) => e.event_kind === 'paused')).toHaveLength(1);
      const n = await alerts(w.tenantId);
      expect(n.filter((x) => x.body.endsWith('the Google Ads check are complete: pause them in Google Ads.'))).toHaveLength(2);
    });
  });

  it('Q-ADS-3 R-ADS-5 (b11 ads-7): with CAP_COUNTS_EVERY_CAMPAIGN off, only campaigns linked here count toward the cap and only managed (active) ones are paused', async () => {
    await withAdsCleared(h, async () => {
      const w = await adsWorld(h);
      const { accountId } = await spending(w); // fake-c-a linked and active, fake-c-b running unmanaged; $1 an hour each
      await setCapVia(h, w.owner, 400, 400); // the whole account reaches $4 in 2 hours, the linked campaign alone in 4
      let pausedAtHour: number | null = null;
      for (let hour = 1; hour <= 6; hour++) {
        w.clock.advance(HOUR_MS);
        await runReconcile(depsOf(h, w), w.tenantId, { capCountsEveryCampaign: false });
        if (pausedAtHour === null && w.fake.statusOf(accountId, 'fake-c-a') === 'paused') pausedAtHour = hour;
      }
      expect(pausedAtHour).toBe(4);
      expect(w.fake.statusOf(accountId, 'fake-c-b')).toBe('enabled');
      expect((await ledgerOf(h, w.tenantId)).filter((e) => e.event_kind === 'paused')).toHaveLength(1);
    });
  });

  it('R-TEN-7: every alert fits the 120/240 CHECKs and carries no pack key, code, campaign name or account id', () => {
    const texts = [
      overspendText({ kind: 'paused', paused: 1, capCents: 99_999_999_99 }),
      overspendText({ kind: 'paused', paused: 12, capCents: 100 }),
      overspendText({ kind: 'dark', capCents: 99_999_999_99 }),
      overspendText({ kind: 'no_lead_source', capCents: 99_999_999_99 }),
      uncheckedText('2026-11-12T15:00:00.000Z'),
      uncheckedText(null),
    ];
    for (const t of texts) {
      expect(t.title.length).toBeLessThanOrEqual(120);
      expect(t.body.length).toBeLessThanOrEqual(240);
      expect(`${t.title} ${t.body}`).not.toMatch(/platform:|[A-Z]{2,}_[A-Z]|Oak St|fake-/);
    }
    expect(overspendText({ kind: 'paused', paused: 1, capCents: 100 }).body).toBe('Paused 1 campaign: month-to-date spend reached your $1.00 cap.');
  });
});
