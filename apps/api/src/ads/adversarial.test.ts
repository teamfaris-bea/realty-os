// Adversarial checks of module 52 (R-ADS-9, R-PERM-5, R-TEN-1, R-TEN-7, R-AST-21, D1, D-ADS): roles and support, tenancy,
// what a support session reads, and that no name, account id or token reaches a log, an audit row, a job or a notification.
// Real Postgres as app_user; FakeAds and FakeOAuth only; the network tripwire is installed.
import { type Actor, type TenantId, can, instant } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call } from '../admin/testing.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { installNetworkTripwire } from '../providers/integrations/spark.testing.js';
import { memoryAlerts } from '../worker/observability.js';
import { systemActor } from '../worker/systemActor.js';
import type { StandaloneJobContext, StandaloneJobHandler } from '../worker/types.js';
import { ADS_JOBS, makeAdsHandlers } from './handlers.js';
import { runReconcile } from './mirror.js';
import { runWeeklyProposal } from './propose.js';
import { type AdsWorld, adsWorld, campaignOf, connectAds, dealsFor, depsOf, resetAdsPack, setCapVia, spendHistory, thisMonday, withAdsCleared } from './testing.js';

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

const NAME = 'Oak St Secret Campaign';

/** A cleared world with a weekly proposal pending; returns its id. */
async function pending(w: AdsWorld): Promise<{ accountId: string; actionId: string; campaignId: string }> {
  const { accountId } = await connectAds(h, w, `fake-ads-adv-${randomUUID().slice(0, 8)}`, {
    campaigns: [{ externalCampaignId: 'fake-c-x', name: NAME, dailyBudgetCents: 3000 }, { externalCampaignId: 'fake-c-y', name: `${NAME} 2`, dailyBudgetCents: 3000 }],
  });
  await runReconcile(depsOf(h, w), w.tenantId);
  for (const ext of ['fake-c-x', 'fake-c-y']) {
    const c = (await campaignOf(h, w.tenantId, ext))!;
    await call(w.owner, 'PATCH', `/ads/campaigns/${c.id}`, { listingId: w.listingId, creativePieceId: w.pieceId });
  }
  spendHistory(w, accountId, 'fake-c-x', 2000);
  spendHistory(w, accountId, 'fake-c-y', 4000);
  await dealsFor(h, w, 'gads:fake-c-x', 6);
  await dealsFor(h, w, 'gads:fake-c-y', 5);
  await setCapVia(h, w.owner, 3_000_000, 10_000);
  await runReconcile(depsOf(h, w), w.tenantId);
  const p = await runWeeklyProposal(depsOf(h, w, { now: () => thisMonday() as never }), w.tenantId);
  expect(p.outcome).toBe('proposed');
  return { accountId, actionId: p.actionId!, campaignId: (await campaignOf(h, w.tenantId, 'fake-c-x'))!.id };
}

const ROUTES = (ids: { actionId: string; campaignId: string }) => [
  ['GET', '/ads', undefined],
  ['GET', '/ads/ledger', undefined],
  ['POST', '/ads/caps', { monthlyCapCents: 100_000, dailyCeilingCents: 1_000, attestation: 'I approve a Google Ads cap of $1,000.00 a month and $10.00 a day.' }],
  ['PATCH', `/ads/campaigns/${ids.campaignId}`, { listingId: randomUUID(), creativePieceId: randomUUID() }],
  ['POST', `/ads/campaigns/${ids.campaignId}/resume`, undefined],
  ['POST', `/ads/proposals/${ids.actionId}/approve`, undefined],
  ['POST', `/ads/proposals/${ids.actionId}/reject`, undefined],
] as const;

describe('roles, support and tenancy (R-ADS-9, R-PERM-5, R-TEN-1)', () => {
  it('R-PERM-5 R-ADS-9: agents and Team Leads get 404 on every /ads route; a support actor is refused every ads action; ads tables show them no rows', async () => {
    await withAdsCleared(h, async () => {
      const w = await adsWorld(h);
      const ids = await pending(w);
      for (const c of [w.agent, w.teamLead]) {
        for (const [m, url, body] of ROUTES(ids)) expect((await call(c, m as never, url, body)).status, `${m} ${url}`).toBe(404);
        const rows = await withTenantTx(c.actor(), async (tx) => ({
          campaigns: (await sql`SELECT id FROM ad_campaigns`.execute(tx)).rows.length,
          events: (await sql`SELECT id FROM ad_allocation_events`.execute(tx)).rows.length,
          caps: (await sql`SELECT id FROM ad_budget_caps`.execute(tx)).rows.length,
          actions: (await sql`SELECT id FROM assistant_actions WHERE kind = 'ad_reallocation'`.execute(tx)).rows.length,
        }), { db: h.database });
        expect(rows).toEqual({ campaigns: 0, events: 0, caps: 0, actions: 0 });
      }
      // support is never granted an ads action (no support flag), and every /ads route authorizes one of them
      const support: Actor = { kind: 'support', userId: randomUUID() as never, tenantId: w.tenantId as TenantId, grantId: randomUUID() };
      for (const action of ['ads.view', 'ads.cap_set', 'ads.shift_decide', 'ads.campaign_manage'] as const) {
        expect(can(support, action, { reauth: { reauthenticatedAt: instant(Date.now()), now: instant(Date.now()) } })).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      }
      const table = h.app.platform.routeTable.filter((r) => r.url.startsWith('/api/ads') && r.method !== 'HEAD');
      expect(table.length).toBe(7);
      for (const r of table) expect(r.authorizes, r.url).toMatch(/^ads\./);
      expect((await h.su.query("SELECT status FROM assistant_actions WHERE id = $1", [ids.actionId])).rows[0].status).toBe('proposed');
    });
  });

  it('R-ADS-1 R-ADS-9 R-AST-21: the ads actions by role: Owner all (the cap re-authenticated); Admin all but the cap; every other role and the system none', () => {
    const now = instant(Date.now());
    const fresh = { reauth: { reauthenticatedAt: now, now } };
    const stale = { reauth: { reauthenticatedAt: instant(Date.now() - 3_600_000), now } };
    const user = (role: 'owner' | 'admin' | 'team_lead' | 'agent' | 'isa' | 'tc'): Actor => ({ kind: 'user', userId: randomUUID() as never, tenantId: randomUUID() as never, role, sessionId: 's' });
    const actions = ['ads.view', 'ads.cap_set', 'ads.shift_decide', 'ads.campaign_manage'] as const;
    for (const a of actions) {
      expect(can(user('owner'), a, fresh), a).toEqual({ ok: true });
      expect(can(user('admin'), a, fresh), a).toEqual(a === 'ads.cap_set' ? { ok: false, code: 'NOT_FOUND' } : { ok: true });
      for (const r of ['team_lead', 'agent', 'isa', 'tc'] as const) expect(can(user(r), a, fresh), `${r} ${a}`).toMatchObject({ ok: false, code: 'NOT_FOUND' });
      expect(can(systemActor(randomUUID(), 'timer'), a, fresh), a).toMatchObject({ ok: false });
    }
    expect(can(user('owner'), 'ads.cap_set', stale)).toMatchObject({ ok: false, code: 'REAUTH_REQUIRED' });
  });

  it('R-ADS-9: a support session under the Owner\'s grant reads the ownerless ad_reallocation (read-only, as documented) and no ads table row; it cannot change it', async () => {
    await withAdsCleared(h, async () => {
      const w = await adsWorld(h);
      const ids = await pending(w);
      const supportUser = randomUUID();
      await h.su.query("INSERT INTO users (id, email, display_name, password_hash) VALUES ($1, $2, 'Sam Support', $3)", [supportUser, `support-${supportUser.slice(0, 8)}@example.test`, '$argon2id$v=19$m=65536,t=3,p=1$c2FsdA$aGFzaA']);
      await h.su.query("INSERT INTO support_access_grants (tenant_id, id, support_user_id, granted_by_user_id, reason, expires_at) VALUES ($1, $2, $3, $4, 'Ticket 1', now() + interval '1 hour')",
        [w.tenantId, randomUUID(), supportUser, w.owner.userId]);
      const support: Actor = { kind: 'support', userId: supportUser as never, tenantId: w.tenantId as TenantId, grantId: randomUUID() };
      const seen = await withTenantTx(support, async (tx) => ({
        actions: (await sql<{ id: string }>`SELECT id FROM assistant_actions WHERE kind = 'ad_reallocation'`.execute(tx)).rows.map((r) => r.id),
        campaigns: (await sql`SELECT id FROM ad_campaigns`.execute(tx)).rows.length,
        events: (await sql`SELECT id FROM ad_allocation_events`.execute(tx)).rows.length,
        caps: (await sql`SELECT id FROM ad_budget_caps`.execute(tx)).rows.length,
      }), { db: h.database });
      expect(seen).toEqual({ actions: [ids.actionId], campaigns: 0, events: 0, caps: 0 });
      await expect(withTenantTx(support, (tx) => sql`UPDATE assistant_actions SET status = 'rejected', decided_by_user_id = app.user_id(), decided_at = now() WHERE id = ${ids.actionId}::uuid`.execute(tx), { db: h.database })).rejects.toThrow();
      expect((await h.su.query('SELECT status FROM assistant_actions WHERE id = $1', [ids.actionId])).rows[0].status).toBe('proposed');
    });
  });

  it('R-TEN-1: another tenant\'s Owner gets 404 for this tenant\'s proposal and campaign ids; nothing changes', async () => {
    await withAdsCleared(h, async () => {
      const a = await adsWorld(h);
      const ids = await pending(a);
      const b = await adsWorld(h);
      await setCapVia(h, b.owner, 300_000, 10_000);
      for (const [m, url, body] of ROUTES(ids).filter(([, u]) => u.includes(ids.actionId) || u.includes(ids.campaignId))) {
        expect((await call(b.owner, m as never, url, body)).status, `${m} ${url}`).toBe(404);
      }
      expect((await h.su.query('SELECT status FROM assistant_actions WHERE id = $1', [ids.actionId])).rows[0].status).toBe('proposed');
      expect((await call<{ campaigns: unknown[] }>(b.owner, 'GET', '/ads')).body.campaigns).toEqual([]);
    });
  });
});

describe('no names, account ids or tokens in logs, audit rows, jobs or notifications (R-TEN-7)', () => {
  it('R-TEN-7: after a mirror, a proposal, an approved apply and a cap pause, no campaign name, account id or token is in audit_log, jobs, notifications, the job log or the server log', async () => {
    await withAdsCleared(h, async () => {
      const w = await adsWorld(h);
      const ids = await pending(w);
      expect((await call(w.owner, 'POST', `/ads/proposals/${ids.actionId}/approve`)).status).toBe(200);
      // the handler's own log line, through the real handler with a stub context
      const lines: string[] = [];
      const [reconcile] = makeAdsHandlers(() => depsOf(h, w)) as unknown as StandaloneJobHandler<Record<string, never>>[];
      expect(reconcile!.kind).toBe(ADS_JOBS.reconcile);
      const ctx = {
        actor: systemActor(w.tenantId, 'timer'), now: instant(Date.now()), providers: h.providers, job: { id: 1n, kind: ADS_JOBS.reconcile, queue: 'default', attempts: 1 },
        log: { info: (m: string, f?: unknown) => lines.push(JSON.stringify([m, f])), warn: (m: string, f?: unknown) => lines.push(JSON.stringify([m, f])), error: (m: string, f?: unknown) => lines.push(JSON.stringify([m, f])) },
        alerts: memoryAlerts(), withTx: (fn: never) => withTenantTx(systemActor(w.tenantId, 'timer'), fn, { db: h.database }),
      } as unknown as StandaloneJobContext;
      await setCapVia(h, w.owner, 1_000, 1_000);
      await reconcile!.run(ctx, {});
      expect(lines.length).toBeGreaterThan(0);
      expect((await h.su.query("SELECT count(*)::int AS n FROM ad_allocation_events WHERE tenant_id = $1 AND event_kind = 'paused'", [w.tenantId])).rows[0].n).toBeGreaterThan(0);
      const token = (await h.su.query("SELECT count(*)::int AS n FROM provider_credentials WHERE tenant_id = $1 AND provider = 'google'", [w.tenantId])).rows[0].n;
      expect(token).toBe(1);
      const dump = JSON.stringify([
        // this module's audit rows (module 21's integration.* rows record the linked account id by design)
        (await h.su.query("SELECT action, entity_type, changes, reason FROM audit_log WHERE tenant_id = $1 AND action LIKE 'ads.%'", [w.tenantId])).rows,
        (await h.su.query("SELECT kind, payload, last_error, dedupe_key FROM jobs WHERE tenant_id = $1 AND kind LIKE 'ads.%'", [w.tenantId])).rows,
        (await h.su.query('SELECT title, body, dedupe_key FROM notifications WHERE tenant_id = $1', [w.tenantId])).rows,
        lines,
        h.logs,
      ]);
      expect(dump).toContain('ads.shift_approved');
      expect(dump).not.toContain(NAME);
      expect(dump).not.toContain(ids.accountId);
      expect(dump).not.toMatch(/fake-access|accessToken|refresh_token|secret_enc/);
      // no audit row of any module names the campaign
      expect(JSON.stringify((await h.su.query('SELECT changes, reason FROM audit_log WHERE tenant_id = $1', [w.tenantId])).rows)).not.toContain(NAME);
      // the ledger and the proposal carry ids and codes only
      expect(JSON.stringify((await h.su.query('SELECT reason_code, provider_ref FROM ad_allocation_events WHERE tenant_id = $1', [w.tenantId])).rows)).not.toContain(NAME);
      expect(JSON.stringify((await h.su.query('SELECT payload, explanation FROM assistant_actions WHERE id = $1', [ids.actionId])).rows)).not.toContain(NAME);
    });
  });

  it('D1: the ads module sends nothing to a contact: a full cycle writes no message, call or conversation', async () => {
    await withAdsCleared(h, async () => {
      const w = await adsWorld(h);
      const before = (await h.su.query('SELECT (SELECT count(*) FROM messages WHERE tenant_id = $1) + (SELECT count(*) FROM calls WHERE tenant_id = $1) AS n', [w.tenantId])).rows[0].n;
      const ids = await pending(w);
      await call(w.owner, 'POST', `/ads/proposals/${ids.actionId}/approve`);
      await runReconcile(depsOf(h, w), w.tenantId);
      const after = (await h.su.query('SELECT (SELECT count(*) FROM messages WHERE tenant_id = $1) + (SELECT count(*) FROM calls WHERE tenant_id = $1) AS n', [w.tenantId])).rows[0].n;
      expect(after).toBe(before);
      expect(h.providers.telephony.sms).toEqual([]);
      expect(h.providers.email.sent).toEqual([]);
    });
  });
});
