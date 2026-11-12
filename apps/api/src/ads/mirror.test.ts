// The Google Ads connect, the campaign mirror and the spend sync (module 52; R-ADS-4, R-ADS-11, R-ADS-12, R-ADS-13, R-INT-1,
// R-INT-2, R-OWNER-5; E146, E160, E449-E451, E453-E456, E458). Real Postgres as app_user; FakeAds on a manual clock and
// FakeOAuth only; the network tripwire is installed.
import { HOUR_MS } from '@realty/core/foundation';
import { validateTargeting } from '@realty/core/fairhousing';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { systemActor } from '../worker/systemActor.js';
import { call } from '../admin/testing.js';
import { type ApiHarness, createApiHarness, testConfig } from '../auth/testHarness.js';
import { connectFlow } from '../integrations/testing.js';
import { createProviders } from '../providers/index.js';
import { installNetworkTripwire } from '../providers/integrations/spark.testing.js';
import { campaignName, mapTargeting, runReconcile } from './mirror.js';
import { ADS_NOT_SET_UP, FakeAds, UnconfiguredAds } from './provider.js';
import { GOOGLE_ADS_SCOPES } from '../integrations/catalog.js';
import { type AdsWorld, adsWorld, campaignOf, connectAds, depsOf, midMonth, passTime, resetAdsPack, setAdsPack } from './testing.js';

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

interface Overview {
  state: string;
  stateSentence: string;
  packSentence: string;
  campaigns: { id: string; externalCampaignId: string; status: string; managed: boolean; why: string; dailyBudgetCents: number; budgetNote: string | null }[];
  unmanagedDailyCents: number;
  doubleCount: { sentence: string } | null;
  uncheckedSentence: string | null;
  asOf: string | null;
  monthToDate: { spentCents: number; zone: string };
}
const overview = async (w: AdsWorld) => (await call<Overview>(w.owner, 'GET', '/ads')).body;
const conn = async (id: string) => (await h.su.query('SELECT status, status_reason, last_error_code, last_synced_at FROM integration_connections WHERE id = $1', [id])).rows[0];
const costs = async (tenantId: string) =>
  (await h.su.query<{ lead_source_id: string; month: string; amount_cents: string; origin: string; note: string | null }>(
    "SELECT lead_source_id, to_char(month, 'YYYY-MM') AS month, amount_cents, origin, note FROM lead_source_costs WHERE tenant_id = $1 ORDER BY origin, month", [tenantId])).rows;
const notes = async (tenantId: string) => (await h.su.query<{ title: string; body: string; priority: string; kind: string; dedupe_key: string }>(
  "SELECT title, body, priority, kind, dedupe_key FROM notifications WHERE tenant_id = $1 AND kind = 'ad_overspend' ORDER BY created_at", [tenantId])).rows;

describe('connect (R-ADS-13, R-INT-1, E160)', () => {
  it('R-ADS-13: the connect asks for exactly GOOGLE_ADS_SCOPES and completes on FakeOAuth; E160: an account the token does not manage is refused and nothing is linked', async () => {
    const w = await adsWorld(h);
    w.fake.addAccount('fake-ads-mine');
    const ok = await connectFlow(h, w.owner, 'ads_google', { externalAccountId: 'fake-ads-mine', leadSourceId: w.sourceId }, [{ id: 'fake-ads-mine' }]);
    expect(new URL(ok.authorizeUrl).searchParams.get('scope')!.split(' ')).toEqual([...GOOGLE_ADS_SCOPES]);
    expect(ok.cb.result).toBe('CONNECTED');
    const bad = await connectFlow(h, w.owner, 'ads_google', { externalAccountId: 'fake-ads-other' }, [{ id: 'fake-ads-mine' }]);
    expect(bad.cb.result).toBe('ACCOUNT_NOT_MANAGED');
    expect((await h.su.query('SELECT status, external_account_id FROM integration_connections WHERE id = $1', [bad.connectionId])).rows[0]).toEqual({ status: 'not_configured', external_account_id: null });
  });

  it('R-INT-1 R-ADS-13: production without ALLOW_FAKE_PROVIDERS gets UnconfiguredAds, which reads and changes nothing and says "not set up"; the fake is the default elsewhere', async () => {
    const prod = createProviders({ ...testConfig(), env: 'production', allowFakeProviders: false }, { clock: { now: () => Date.now() } as never }).ads;
    expect(prod).toBeInstanceOf(UnconfiguredAds);
    expect(prod.configured).toBe(false);
    expect(prod.statusText).toBe(ADS_NOT_SET_UP);
    await expect(prod.listCampaigns({ externalAccountId: 'fake-ads-1', accessToken: 'x' })).rejects.toMatchObject({ kind: 'not_configured', providerCode: 'ADS_NOT_CONFIGURED' });
    expect(createProviders({ ...testConfig(), env: 'production', allowFakeProviders: true }, { clock: { now: () => Date.now() } as never }).ads).toBeInstanceOf(FakeAds);
  });

  it('R-INT-6 R-ADS-7 E441: change_budget waits for counsel review of platform:ads, then for its vendor check ("it also waits for the vendor check"); read_spend works at once (Q-ADS-1)', async () => {
    const w = await adsWorld(h);
    const { connectionId } = await connectAds(h, w);
    type Caps = { services: { kind: string; connections: { id: string; capabilities: { name: string; available: boolean; reason: string | null }[] }[] }[] };
    const caps = async () => (await call<Caps>(w.owner, 'GET', '/admin/integrations')).body.services.find((s) => s.kind === 'ads_google')!.connections.find((c) => c.id === connectionId)!.capabilities;
    expect(await caps()).toEqual([{ name: 'change_budget', available: false, reason: 'Waits for counsel review of platform:ads.' }, { name: 'read_spend', available: true, reason: null }]);
    try {
      await setAdsPack(h, { reviewed: true, vendor: false });
      expect((await caps())[0]!.reason).toBe('Waits for the vendor check of platform:ads.');
      const ov = await overview(w);
      expect(ov.state).toBe('not_cleared');
      expect(ov.packSentence).toMatch(/^Changing Google Ads budgets stays off: counsel reviewed it on \d{4}-\d{2}-\d{2}; it also waits for the vendor check \(pack 2026\.11\.0\)\.$/);
    } finally {
      await resetAdsPack(h);
    }
  });
});

describe('the mirror (R-ADS-12, R-ADS-4)', () => {
  it('R-ADS-12 E449: a running campaign is mirrored as draft (not managed here) until linked; linking writes only the two ids and the next pass activates it; reads run while dark (Q-ADS-1)', async () => {
    const w = await adsWorld(h);
    const { accountId } = await connectAds(h, w, undefined, { campaigns: [{ externalCampaignId: 'fake-c-1', name: 'Oak St', dailyBudgetCents: 2500 }] });
    await runReconcile(depsOf(h, w), w.tenantId);
    const c = (await campaignOf(h, w.tenantId, 'fake-c-1'))!;
    expect(c).toMatchObject({ status: 'draft', daily_budget_cents: '2500', lead_source_id: w.sourceId, campaign_ref: 'gads:fake-c-1', name: 'Oak St', listing_id: null });
    const ov = await overview(w);
    expect(ov.state).toBe('not_cleared');
    expect(ov.campaigns[0]).toMatchObject({ managed: false, why: 'Not linked to a listing and its creative.' });
    expect(ov.unmanagedDailyCents).toBe(2500);
    // budget, status and targeting are refused (422); an unapproved creative is 409
    for (const extra of [{ dailyBudgetCents: 1 }, { status: 'active' }, { targeting: {} }]) {
      expect((await call(w.owner, 'PATCH', `/ads/campaigns/${c.id}`, { listingId: w.listingId, creativePieceId: w.pieceId, ...extra })).status).toBe(422);
    }
    const { approvedPiece } = await import('./testing.js');
    const draft = await approvedPiece(h, w.tenantId, w.agent, { listingId: w.listingId, status: 'draft' });
    expect((await call(w.owner, 'PATCH', `/ads/campaigns/${c.id}`, { listingId: w.listingId, creativePieceId: draft.pieceId })).code).toBe('AD_CREATIVE_NOT_APPROVED');
    const linked = await call<{ campaign: { status: string; listingId: string } }>(w.admin, 'PATCH', `/ads/campaigns/${c.id}`, { listingId: w.listingId, creativePieceId: w.pieceId });
    expect(linked.status).toBe(200);
    expect(linked.body.campaign).toMatchObject({ status: 'draft', listingId: w.listingId });
    expect((await h.su.query("SELECT count(*)::int AS n FROM jobs WHERE tenant_id = $1 AND kind = 'ads.reconcile' AND dedupe_key = 'ads_reconcile:linked'", [w.tenantId])).rows[0].n).toBe(1);
    expect((await h.su.query("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'ads.campaign_linked'", [w.tenantId])).rows[0].n).toBe(1);
    await runReconcile(depsOf(h, w), w.tenantId);
    expect((await campaignOf(h, w.tenantId, 'fake-c-1'))!.status).toBe('active');
    expect((await overview(w)).campaigns[0]).toMatchObject({ managed: true });
    // a UI budget change is mirrored; nothing is written back to Google Ads by the mirror
    w.fake.setBudget(accountId, 'fake-c-1', 4000);
    await runReconcile(depsOf(h, w), w.tenantId);
    expect((await campaignOf(h, w.tenantId, 'fake-c-1'))!.daily_budget_cents).toBe('4000');
    expect(w.fake.calls.filter((x) => x.op === 'applyBudgetChange' || x.op === 'pauseCampaign')).toEqual([]);
  });

  it('E146 R-ADS-12: REMOVED becomes ended, a disapproval becomes rejected with its reason in words, paused stays paused; a campaign not declared housing stays draft (E449)', async () => {
    const w = await adsWorld(h);
    const { accountId } = await connectAds(h, w, undefined, {
      campaigns: [
        { externalCampaignId: 'fake-c-gone', platformStatus: 'removed' },
        { externalCampaignId: 'fake-c-bad' },
        { externalCampaignId: 'fake-c-paused', platformStatus: 'paused' },
        { externalCampaignId: 'fake-c-nohousing', housingDeclared: 'unknown' },
      ],
    });
    w.fake.disapprove(accountId, 'fake-c-bad', 'HOUSING_POLICY_DISAPPROVED');
    await runReconcile(depsOf(h, w), w.tenantId);
    const status = async (ext: string) => (await campaignOf(h, w.tenantId, ext))!.status;
    expect(await status('fake-c-gone')).toBe('ended');
    expect(await status('fake-c-bad')).toBe('rejected');
    expect(await status('fake-c-paused')).toBe('paused');
    // the housing-unknown one is linked but still not managed
    const nh = (await campaignOf(h, w.tenantId, 'fake-c-nohousing'))!;
    await call(w.owner, 'PATCH', `/ads/campaigns/${nh.id}`, { listingId: w.listingId, creativePieceId: w.pieceId });
    await runReconcile(depsOf(h, w), w.tenantId);
    expect(await status('fake-c-nohousing')).toBe('draft');
    const ov = await overview(w);
    const why = (ext: string) => ov.campaigns.find((c) => c.externalCampaignId === ext)!.why;
    expect(why('fake-c-gone')).toBe('Ended on Google Ads.');
    expect(why('fake-c-bad')).toBe('Rejected on Google Ads (housing policy disapproved).');
    expect(why('fake-c-nohousing')).toBe('Google Ads did not report it as a housing campaign with its own budget in US dollars at the last sync.');
  });

  it('E456 R-ADS-12: a shared budget is stored as 0, shown as "shared budget", and never managed', async () => {
    const w = await adsWorld(h);
    await connectAds(h, w, undefined, { campaigns: [{ externalCampaignId: 'fake-c-shared', sharedBudget: true, dailyBudgetCents: 5000 }, { externalCampaignId: 'fake-c-none', dailyBudgetCents: null }] });
    await runReconcile(depsOf(h, w), w.tenantId);
    const c = (await campaignOf(h, w.tenantId, 'fake-c-shared'))!;
    expect(c.daily_budget_cents).toBe('0');
    await call(w.owner, 'PATCH', `/ads/campaigns/${c.id}`, { listingId: w.listingId, creativePieceId: w.pieceId });
    await runReconcile(depsOf(h, w), w.tenantId);
    expect((await campaignOf(h, w.tenantId, 'fake-c-shared'))!.status).toBe('draft');
    const ov = await overview(w);
    expect(ov.campaigns.find((x) => x.externalCampaignId === 'fake-c-shared')!.budgetNote).toBe('shared budget');
    expect(ov.campaigns.find((x) => x.externalCampaignId === 'fake-c-none')!.budgetNote).toBe('budget not reported');
  });

  it('E458 R-ADS-4: targeting that does not map is stored {} and refused by the validator; a mapped radius is kept; nothing is written back', async () => {
    expect(mapTargeting({ proximity: { radiusMiles: 20 } })).toEqual({ geo: 'radius_of_listing', radiusMiles: 20 });
    expect(mapTargeting({ proximity: { radiusMiles: 20 }, ageRange: [25, 34] })).toEqual({});
    expect(mapTargeting({ zips: ['29401'] })).toEqual({});
    expect(validateTargeting({}).ok).toBe(false);
    const w = await adsWorld(h);
    await connectAds(h, w, undefined, { campaigns: [{ externalCampaignId: 'fake-c-age', targeting: { proximity: { radiusMiles: 20 }, ageRange: [25, 34] } }, { externalCampaignId: 'fake-c-ok', targeting: { proximity: { radiusMiles: 20 } } }] });
    await runReconcile(depsOf(h, w), w.tenantId);
    expect((await campaignOf(h, w.tenantId, 'fake-c-age'))!.targeting).toEqual({});
    expect((await campaignOf(h, w.tenantId, 'fake-c-ok'))!.targeting).toEqual({ geo: 'radius_of_listing', radiusMiles: 20 });
    expect(w.fake.calls.map((c) => c.op).filter((op) => op === 'applyBudgetChange' || op === 'pauseCampaign')).toEqual([]);
  });

  it('R-ADS-12: names stay inside the 1..200 CHECK: a long name is clipped, an empty one becomes "Campaign <id>"', async () => {
    expect(campaignName('x'.repeat(250), 'fake-c-1')).toHaveLength(200);
    expect(campaignName('  \u0000 ', 'fake-c-9')).toBe('Campaign fake-c-9');
    const w = await adsWorld(h);
    await connectAds(h, w, undefined, { campaigns: [{ externalCampaignId: 'fake-c-long', name: 'y'.repeat(300) }, { externalCampaignId: 'fake-c-empty', name: '   ' }] });
    await runReconcile(depsOf(h, w), w.tenantId);
    expect((await campaignOf(h, w.tenantId, 'fake-c-long'))!.name).toHaveLength(200);
    expect((await campaignOf(h, w.tenantId, 'fake-c-empty'))!.name).toBe('Campaign fake-c-empty');
  });

  it('E455 R-ADS-8 D2: an ads_meta connection made before D2 is never mirrored, read, proposed for or paused', async () => {
    const w = await adsWorld(h);
    w.fake.addAccount('fake-meta-ads-1');
    w.fake.addCampaign('fake-meta-ads-1', { externalCampaignId: 'fake-m-1' });
    // a row made before D2 (the system linked it then); written here as the tenant's system actor, as the callback did
    await withTenantTx(systemActor(w.tenantId, 'provider'), async (tx) => {
      const cred = (await sql<{ id: string }>`INSERT INTO provider_credentials (tenant_id, id, provider, secret_enc, key_version) VALUES (app.tenant_id(), gen_random_uuid(), 'meta', '\\x01', 1) RETURNING id`.execute(tx)).rows[0]!.id;
      await sql`INSERT INTO integration_connections (tenant_id, id, kind, status, display_name, external_account_id, credential_id, lead_source_id, connected_at)
                VALUES (app.tenant_id(), gen_random_uuid(), 'ads_meta', 'connected', 'Meta ads', 'fake-meta-ads-1', ${cred}::uuid, ${w.sourceId}::uuid, now())`.execute(tx);
    }, { db: h.database });
    const r = await runReconcile(depsOf(h, w), w.tenantId);
    expect(r.connections).toEqual([]);
    expect(w.fake.calls).toEqual([]);
    expect((await h.su.query('SELECT count(*)::int AS n FROM ad_campaigns WHERE tenant_id = $1', [w.tenantId])).rows[0].n).toBe(0);
  });
});

describe('reads while dark (Q-ADS-1)', () => {
  it('Q-ADS-1 R-ADS-7 (b11 ads-7): with READS_WHILE_DARK off, a dark pass reads nothing from Google Ads, mirrors and costs nothing, sends no alert, and the page says why; once cleared it reads again', async () => {
    const w = await adsWorld(h);
    const { accountId } = await connectAds(h, w, undefined, { campaigns: [{ externalCampaignId: 'fake-c-dark' }] });
    w.fake.addSpend(accountId, 'fake-c-dark', w.clock.now() - HOUR_MS, 900);
    passTime(w, 3 * HOUR_MS);
    const r = await runReconcile(depsOf(h, w), w.tenantId, { readsWhileDark: false });
    expect(r).toMatchObject({ cleared: false, readsSkipped: true, connections: [], costsWritten: 0, uncheckedAlerts: 0 });
    expect(w.fake.calls).toEqual([]);
    expect(await campaignOf(h, w.tenantId, 'fake-c-dark')).toBeUndefined();
    expect(await costs(w.tenantId)).toEqual([]);
    expect(await notes(w.tenantId)).toEqual([]);
    const { buildOverview } = await import('./overview.js');
    const ov = await withTenantTx(w.owner.actor(), (tx) => buildOverview(tx, w.clock.now() as never, { readsWhileDark: false }), { db: h.database });
    expect(ov.stateSentence).toMatch(/Google Ads is not read/);
    expect(ov.overspendNote).toMatch(/does not read Google Ads/);
    try {
      await setAdsPack(h, { reviewed: true, vendor: true });
      const cleared = await runReconcile(depsOf(h, w), w.tenantId, { readsWhileDark: false });
      expect(cleared.readsSkipped).toBe(false);
      expect(w.fake.calls.map((c) => c.op)).toContain('listCampaigns');
      expect(await campaignOf(h, w.tenantId, 'fake-c-dark')).toBeDefined();
    } finally {
      await resetAdsPack(h);
    }
  });
});

describe('connection states (R-INT-2; E453, E454)', () => {
  it('E453 R-ADS-13: a non-USD account is degraded ADS_CURRENCY_UNSUPPORTED (an honest limit state): nothing is managed or costed, overspend is unchecked and the "not checked" alert fires', async () => {
    const w = await adsWorld(h);
    const { connectionId, accountId } = await connectAds(h, w, undefined, { currency: 'CAD', campaigns: [{ externalCampaignId: 'fake-c-cad' }] });
    w.fake.addSpend(accountId, 'fake-c-cad', w.clock.now() - HOUR_MS, 5000);
    await runReconcile(depsOf(h, w), w.tenantId);
    expect(await conn(connectionId)).toMatchObject({ status: 'degraded', status_reason: 'ADS_CURRENCY_UNSUPPORTED', last_synced_at: null });
    expect((await campaignOf(h, w.tenantId, 'fake-c-cad'))!.status).toBe('draft');
    expect(await costs(w.tenantId)).toEqual([]);
    const n = await notes(w.tenantId);
    expect(n).toHaveLength(2); // the Owner and the Admin
    expect(n[0]).toMatchObject({ priority: 'high', title: expect.stringMatching(/^Google Ads spend has not been checked since /) });
    expect((await overview(w)).uncheckedSentence).toMatch(/^Google Ads spend has not been checked since /);
  });

  it('E453 R-ADS-13: a quota error degrades the connection (ADS_QUOTA) and retries next hour; after 2 hours without a check the "not checked" alert fires once a day', async () => {
    // noon on the 15th (no plans here, so the fake clock need not follow the DB's): the passes stay inside one UTC day
    const w = await adsWorld(h, { clockMs: midMonth() });
    const { connectionId } = await connectAds(h, w, undefined, { campaigns: [{ externalCampaignId: 'fake-c-q' }] });
    await runReconcile(depsOf(h, w), w.tenantId);
    expect((await conn(connectionId)).status).toBe('connected');
    w.fake.failNext('accountInfo', { kind: 'quota' });
    w.clock.advance(HOUR_MS);
    await runReconcile(depsOf(h, w), w.tenantId);
    expect(await conn(connectionId)).toMatchObject({ status: 'degraded', status_reason: 'ADS_QUOTA' });
    expect(await notes(w.tenantId)).toEqual([]);
    for (const _ of [1, 2]) {
      w.fake.failNext('accountInfo', { kind: 'quota' });
      w.clock.advance(HOUR_MS);
      await runReconcile(depsOf(h, w), w.tenantId);
    }
    const n = await notes(w.tenantId);
    expect(n).toHaveLength(2);
    expect(n.every((x) => x.dedupe_key.startsWith(`ad_unchecked:${connectionId}:`))).toBe(true);
    // the next success restores the connection
    w.clock.advance(HOUR_MS);
    await runReconcile(depsOf(h, w), w.tenantId);
    expect(await conn(connectionId)).toMatchObject({ status: 'connected', status_reason: null });
  });

  it('E454 R-ADS-8 R-ADS-13: a token revoked at Google revokes the connection (an honest state); the page says the account is no longer connected; nothing is applied', async () => {
    const w = await adsWorld(h);
    const { connectionId, accountId } = await connectAds(h, w, undefined, { campaigns: [{ externalCampaignId: 'fake-c-r' }] });
    w.fake.revoke(accountId);
    try {
      await setAdsPack(h, { reviewed: true, vendor: true });
      await runReconcile(depsOf(h, w), w.tenantId);
      expect(await conn(connectionId)).toMatchObject({ status: 'revoked', status_reason: 'TOKEN_REVOKED' });
      expect((await overview(w)).state).toBe('connection_not_live');
    } finally {
      await resetAdsPack(h);
    }
    expect(w.fake.applied).toEqual([]);
  });

  it('R-ADS-13 (b11 api-ui/F2): no lead source: nothing is mirrored or costed and the page says so without pointing at a control the web app does not have', async () => {
    const w = await adsWorld(h);
    await connectAds(h, w, undefined, { leadSource: false, campaigns: [{ externalCampaignId: 'fake-c-ns' }] });
    try {
      await setAdsPack(h, { reviewed: true, vendor: true });
      await runReconcile(depsOf(h, w), w.tenantId);
      expect(await campaignOf(h, w.tenantId, 'fake-c-ns')).toBeUndefined();
      expect(await costs(w.tenantId)).toEqual([]);
      const ov = await overview(w);
      expect(ov.state).toBe('no_lead_source');
      expect(ov.stateSentence).toBe('The Google Ads account has no lead source, so its spend is not recorded and no budget moves.');
      expect((ov as unknown as { overspendNote: string }).overspendNote).toMatch(/Without a lead source it records no new campaign: pause those in Google Ads\.$/);
    } finally {
      await resetAdsPack(h);
    }
  });
});

describe('spend sync into the owner view (R-ADS-11, R-OWNER-5; E450, E451)', () => {
  it('E450 R-ADS-11: one ads_sync row per lead source and account-zone month (current and previous), the note names the zone and sync time; 0 when there is no spend; updated in place, never deleted', async () => {
    const w = await adsWorld(h);
    const { accountId } = await connectAds(h, w, undefined, { timeZone: 'Pacific/Kiritimati', campaigns: [{ externalCampaignId: 'fake-c-z', platformStatus: 'paused' }] });
    // 22:00 UTC on the last day of the previous UTC month is noon on the 1st of this month in the account zone (+14)
    const d = new Date(w.clock.now());
    const monthStartUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
    w.fake.addSpend(accountId, 'fake-c-z', monthStartUtc - 2 * HOUR_MS, 700);
    w.fake.addSpend(accountId, 'fake-c-z', monthStartUtc - 30 * HOUR_MS, 300);
    await runReconcile(depsOf(h, w), w.tenantId);
    const rows = await costs(w.tenantId);
    const ym = (ms: number) => new Date(ms).toISOString().slice(0, 7);
    const cur = ym(w.clock.now());
    const prev = ym(monthStartUtc - 1);
    expect(rows.map((r) => [r.origin, r.month, r.amount_cents])).toEqual([['ads_sync', prev, '300'], ['ads_sync', cur, '700']]);
    expect(rows[1]!.note).toMatch(/^Google Ads spend for \d{4}-\d{2} in the account zone \(Pacific\/Kiritimati\), as reported at \d{4}-\d{2}-\d{2}T/);
    w.fake.addSpend(accountId, 'fake-c-z', monthStartUtc + 2 * HOUR_MS, 50);
    await runReconcile(depsOf(h, w), w.tenantId);
    expect((await costs(w.tenantId)).map((r) => r.amount_cents)).toEqual(['300', '750']);
    expect((await h.su.query("SELECT count(*)::int AS n FROM lead_source_costs WHERE tenant_id = $1", [w.tenantId])).rows[0].n).toBe(2);
  });

  it('R-ADS-11 R-OWNER-5 E451: manual rows are never touched; the owner view shows ads_sync costs; a source with both gets the double-count warning', async () => {
    const w = await adsWorld(h);
    const { accountId } = await connectAds(h, w, undefined, { campaigns: [{ externalCampaignId: 'fake-c-o', platformStatus: 'paused' }] });
    w.fake.addSpend(accountId, 'fake-c-o', w.clock.now() - 3 * HOUR_MS, 4_200);
    const month = new Date(w.clock.now()).toISOString().slice(0, 7);
    const put = await call(w.owner, 'PUT', '/lead-source-costs', { leadSourceId: w.sourceId, month, amountCents: 10_000 });
    expect(put.status).toBe(200);
    await runReconcile(depsOf(h, w), w.tenantId);
    const rows = await costs(w.tenantId);
    expect(rows.find((r) => r.origin === 'manual')).toMatchObject({ amount_cents: '10000' });
    expect(rows.find((r) => r.origin === 'ads_sync' && r.month === month)).toMatchObject({ amount_cents: '4200' });
    const src = await call<{ rows: { leadSourceId: string; costCents: number; costManualCents: number; costAdsSyncCents: number }[] }>(w.owner, 'GET', `/owner/sources?from=${month}&to=${month}`);
    expect(src.body.rows.find((r) => r.leadSourceId === w.sourceId)).toMatchObject({ costManualCents: 10_000, costAdsSyncCents: 4_200, costCents: 14_200 });
    const ov = await overview(w);
    expect(ov.doubleCount!.sentence).toMatch(/both a cost typed in by hand and Google Ads spend/);
    expect(ov.monthToDate.spentCents).toBe(4_200);
  });
});
