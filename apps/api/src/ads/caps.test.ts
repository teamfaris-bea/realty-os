// The Owner's ad cap, the ads page states and the ledger page (module 52; R-ADS-1, R-ADS-5, R-PERM-13; E124). Real Postgres
// as app_user; FakeAds and FakeOAuth only; the network tripwire is installed.
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, freshReauth, staleReauth } from '../admin/testing.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { AppError } from '../errors.js';
import { installNetworkTripwire } from '../providers/integrations/spark.testing.js';
import { setCap } from './caps.js';
import { runReconcile } from './mirror.js';
import { capAttestation, OVERSPEND_NOTE } from './settings.js';
import { adsWorld, connectAds, depsOf, resetAdsPack, setCapVia, withAdsCleared } from './testing.js';

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

describe('the ad cap (R-ADS-1)', () => {
  it('R-ADS-1 R-PERM-13: only the Owner sets a cap, re-authenticated, with the exact attestation rebuilt from the amounts; each cap is a new audited version', async () => {
    const w = await adsWorld(h);
    const body = (m: number, d: number, a = capAttestation(m, d)) => ({ monthlyCapCents: m, dailyCeilingCents: d, attestation: a });
    await staleReauth(h, w.owner);
    expect((await call(w.owner, 'POST', '/ads/caps', body(300_000, 10_000))).code).toBe('REAUTH_REQUIRED');
    await freshReauth(h, w.owner);
    expect(capAttestation(300_000, 10_000)).toBe('I approve a Google Ads cap of $3,000.00 a month and $100.00 a day.');
    const wrong = await call(w.owner, 'POST', '/ads/caps', body(300_000, 10_000, capAttestation(300_000, 20_000)));
    expect(wrong.status).toBe(403);
    expect(wrong.code).toBe('ATTESTATION_REQUIRED');
    expect((await call(w.owner, 'POST', '/ads/caps', body(10_000, 20_000))).code).toBe('AD_CAP_INVALID');
    const one = await call<{ cap: { versionNo: number }; reconcileQueued: boolean }>(w.owner, 'POST', '/ads/caps', body(300_000, 10_000));
    expect(one.status).toBe(201);
    expect(one.body).toMatchObject({ cap: { versionNo: 1 }, reconcileQueued: false });
    const two = await setCapVia(h, w.owner, 200_000, 8_000);
    expect(two.body.cap.versionNo).toBe(2);
    const audit = (await h.su.query("SELECT changes FROM audit_log WHERE tenant_id = $1 AND action = 'ads.cap_set' ORDER BY occurred_at", [w.tenantId])).rows;
    expect(audit).toHaveLength(2);
    expect(audit[1].changes).toMatchObject({ cap_version_no: { to: 2 }, monthly_cap_cents: { to: 200_000 }, daily_ceiling_cents: { to: 8_000 } });
    // an Admin or an agent: 404; the DB itself refuses an Admin writing a cap
    for (const c of [w.admin, w.agent, w.teamLead]) {
      await freshReauth(h, c);
      expect((await call(c, 'POST', '/ads/caps', body(300_000, 10_000))).status).toBe(404);
    }
    await expect(withTenantTx(w.admin.actor(), (tx) => sql`INSERT INTO ad_budget_caps (tenant_id, id, version_no, monthly_cap_cents, daily_ceiling_cents, effective_from, approved_by_user_id, attestation)
      VALUES (app.tenant_id(), ${randomUUID()}::uuid, 9, 1000, 100, now(), app.user_id(), 'I approve this cap.')`.execute(tx), { db: h.database })).rejects.toThrow(/OWNER_ONLY_AD_CAP|row-level security/);
    // cap versions are append-only
    await expect(h.su.query('UPDATE ad_budget_caps SET monthly_cap_cents = 1 WHERE tenant_id = $1', [w.tenantId])).rejects.toThrow();
  });

  it('R-ADS-1: two caps saved at the same moment: the second is 409 AD_CAP_CHANGED (UNIQUE version), never a silent overwrite', async () => {
    const w = await adsWorld(h);
    const input = { monthlyCapCents: 300_000, dailyCeilingCents: 10_000, attestation: capAttestation(300_000, 10_000) };
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let inserted!: () => void;
    const aInserted = new Promise<void>((r) => (inserted = r));
    const ids = h.app.platform.ids;
    const a = withTenantTx(w.owner.actor(), async (tx, now) => {
      const r = await setCap(tx, w.owner.actor(), ids, now, input);
      inserted();
      await gate;
      return r;
    }, { db: h.database });
    await aInserted;
    const b = withTenantTx(w.owner.actor(), (tx, now) => setCap(tx, w.owner.actor(), ids, now, input), { db: h.database }).then(() => null, (e: unknown) => e);
    setTimeout(release, 300);
    expect((await a).cap.versionNo).toBe(1);
    const err = await b;
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe('AD_CAP_CHANGED');
    expect((await h.su.query('SELECT count(*)::int AS n FROM ad_budget_caps WHERE tenant_id = $1', [w.tenantId])).rows[0].n).toBe(1);
  });
});

describe('GET /ads (R-ADS-5, R-AST-13)', () => {
  type Ov = { state: string; stateSentence: string; packSentence: string; overspendNote: string; cap: unknown; dailyTotal: { sentence: string }; monthToDate: { sentence: string } };
  it('R-ADS-5 R-ADS-7: the page says why in words: not cleared, no connection, no cap, ready; it always carries the over-delivery sentence; no confidence or probability anywhere', async () => {
    const w = await adsWorld(h);
    const get = async () => (await call<Ov>(w.owner, 'GET', '/ads')).body;
    let ov = await get();
    expect(ov.state).toBe('not_cleared');
    expect(ov.packSentence).toBe('Changing Google Ads budgets stays off: awaiting counsel review and the vendor check (pack 2026.11.0, not yet reviewed).');
    expect(ov.overspendNote).toBe(OVERSPEND_NOTE);
    expect(ov.overspendNote).toBe('Google Ads may spend more than a daily budget on a given day; Realty OS pauses every campaign once month-to-date spend reaches your monthly cap.');
    await withAdsCleared(h, async () => {
      expect((await get()).state).toBe('no_connection');
      await connectAds(h, w, undefined, { campaigns: [{ externalCampaignId: 'fake-c-1', dailyBudgetCents: 2000 }] });
      await runReconcile(depsOf(h, w), w.tenantId);
      expect((await get()).state).toBe('no_cap');
      await setCapVia(h, w.owner, 300_000, 10_000);
      ov = await get();
      expect(ov.state).toBe('ready');
      expect(ov.dailyTotal.sentence).toBe('Daily budgets total $0.00 against your $100.00 daily ceiling.');
      expect(ov.monthToDate.sentence).toMatch(/^\$0\.00 of your \$3,000\.00 monthly cap spent in \d{4}-\d{2}\.$/);
    });
    const text = JSON.stringify(ov);
    expect(text).not.toMatch(/confidence|probabilit|likelihood|score/i);
  });

  it('GET /ads/ledger pages the ledger newest first with a cursor', async () => {
    const w = await adsWorld(h);
    const r = await call<{ events: unknown[]; next: string | null }>(w.admin, 'GET', '/ads/ledger?limit=5');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ events: [], next: null });
    expect((await call(w.agent, 'GET', '/ads/ledger')).status).toBe(404);
  });
});
