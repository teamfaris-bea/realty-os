// ads/dispatch.ts, the one apply path (module 52): one Owner/Admin tap → planned → applied, with reasons and denominators;
// the pack gate; stale proposals; timeouts resolved by readback; partial failure; replays; concurrent approvers; resume.
// Real Postgres as app_user; FakeAds on a manual clock and FakeOAuth only; the network tripwire is installed.
import { HOUR_MS, MINUTE_MS } from '@realty/core/foundation';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { call, freshReauth } from '../admin/testing.js';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { installNetworkTripwire } from '../providers/integrations/spark.testing.js';
import { approveShift } from './dispatch.js';
import { runReconcile } from './mirror.js';
import { runWeeklyProposal } from './propose.js';
import { DAY_MS } from '@realty/core/foundation';
import {
  type AdsWorld, actionOf, passTime, adsWorld, campaignOf, connectAds, dealsFor, depsOf, ledgerOf, moneyRows, resetAdsPack, setAdsPack, setCapVia, spendHistory, thisMonday, withAdsCleared,
} from './testing.js';

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

interface Ready {
  w: AdsWorld;
  accountId: string;
  connectionId: string;
  /** cheap: 6 agreements on $20/day; costly: 5 agreements on $40/day */
  cheap: string;
  costly: string;
}

/** A Monday world: two linked, active, eligible campaigns with 90 days of spend and outcomes, a cap, and the pack cleared. */
async function ready(o: { ceiling?: number; monthly?: number; clockMs?: number } = {}): Promise<Ready> {
  const w = await adsWorld(h, o.clockMs === undefined ? {} : { clockMs: o.clockMs });
  const { connectionId, accountId } = await connectAds(h, w, undefined, {
    campaigns: [
      { externalCampaignId: 'fake-c-cheap', name: 'Oak St cheap', dailyBudgetCents: 3000 },
      { externalCampaignId: 'fake-c-costly', name: 'Oak St costly', dailyBudgetCents: 3000 },
    ],
  });
  await runReconcile(depsOf(h, w), w.tenantId);
  for (const ext of ['fake-c-cheap', 'fake-c-costly']) {
    const c = await campaignOf(h, w.tenantId, ext);
    const r = await call(w.owner, 'PATCH', `/ads/campaigns/${c!.id}`, { listingId: w.listingId, creativePieceId: w.pieceId });
    expect(r.status).toBe(200);
  }
  spendHistory(w, accountId, 'fake-c-cheap', 2000);
  spendHistory(w, accountId, 'fake-c-costly', 4000);
  await dealsFor(h, w, 'gads:fake-c-cheap', 6);
  await dealsFor(h, w, 'gads:fake-c-costly', 5);
  expect((await setCapVia(h, w.owner, o.monthly ?? 3_000_000, o.ceiling ?? 10_000)).status).toBe(201);
  await runReconcile(depsOf(h, w), w.tenantId);
  expect((await campaignOf(h, w.tenantId, 'fake-c-cheap'))!.status).toBe('active');
  const cheap = (await campaignOf(h, w.tenantId, 'fake-c-cheap'))!.id;
  const costly = (await campaignOf(h, w.tenantId, 'fake-c-costly'))!.id;
  return { w, accountId, connectionId, cheap, costly };
}

async function propose(r: Ready): Promise<string> {
  // the weekly job acts on the tenant's local Monday: this one wake runs on this ISO week's Monday clock
  const p = await runWeeklyProposal(depsOf(h, r.w, { now: () => thisMonday() as never }), r.w.tenantId);
  expect(p.outcome).toBe('proposed');
  return p.actionId!;
}

describe('one tap: planned → applied (R-ADS-2, R-ADS-3, D-ADS)', () => {
  it('R-ADS-2 R-ADS-3 R-ADS-10: the Owner approves a proposal in one tap; the ledger shows planned → applied with reasons, the system updates the mirror, the action is executed', async () => {
    await withAdsCleared(h, async () => {
      const r = await ready();
      const id = await propose(r);
      const a = await actionOf(h, id);
      expect(a).toMatchObject({ status: 'proposed', owner_user_id: null, contact_id: null });
      expect(a!.explanation.length).toBeLessThanOrEqual(300);
      expect(a!.explanation).toMatch(/\d+ agreements on \$[\d,]+\.\d\d/);
      const res = await call<{ status: string; runId: string; rows: { campaignId: string; outcome: string; reasonCode: string; fromDailyCents: number; toDailyCents: number }[] }>(r.w.owner, 'POST', `/ads/proposals/${id}/approve`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('executed');
      expect(res.body.rows.map((x) => x.outcome)).toEqual(['applied', 'applied']);
      const ledger = await ledgerOf(h, r.w.tenantId);
      expect(ledger.map((e) => e.event_kind)).toEqual(['planned', 'planned', 'applied', 'applied']);
      const raised = ledger.find((e) => e.event_kind === 'planned' && e.campaign_id === r.cheap)!;
      const lowered = ledger.find((e) => e.event_kind === 'planned' && e.campaign_id === r.costly)!;
      expect(raised.reason_code).toBe('RAISED_LOWER_COST_PER_OUTCOME');
      expect(lowered.reason_code).toBe('LOWERED_HIGHER_COST_PER_OUTCOME');
      expect(raised.to + lowered.to).toBe(6000);
      expect(raised.to).toBeGreaterThan(3000);
      expect((await actionOf(h, id))!.decided_by_role).toBe('owner');
      expect(Number((await campaignOf(h, r.w.tenantId, 'fake-c-cheap'))!.daily_budget_cents)).toBe(raised.to);
      expect(r.w.fake.budgetOf(r.accountId, 'fake-c-cheap')).toBe(raised.to);
      expect(r.w.fake.applied.map((x) => x.idempotencyKey).sort()).toEqual([raised.id, lowered.id].sort());
      const audit = (await h.su.query("SELECT action, changes FROM audit_log WHERE tenant_id = $1 AND action = 'ads.shift_approved'", [r.w.tenantId])).rows;
      expect(audit).toHaveLength(1);
    });
  });

  it('R-AST-21 R-ADS-10: an Admin approves; an agent and a Team Lead get 404; the generic assistant approve and reject routes 404 for an ownerless ad_reallocation', async () => {
    await withAdsCleared(h, async () => {
      const r = await ready();
      const id = await propose(r);
      for (const c of [r.w.agent, r.w.teamLead]) {
        expect((await call(c, 'POST', `/ads/proposals/${id}/approve`)).status).toBe(404);
        expect((await call(c, 'POST', `/ads/proposals/${id}/reject`)).status).toBe(404);
      }
      for (const c of [r.w.owner, r.w.admin]) {
        expect((await call(c, 'POST', `/assistant/actions/${id}/approve`, { commandId: randomUUID() })).status).toBe(404);
        expect((await call(c, 'POST', `/assistant/actions/${id}/reject`, {})).status).toBe(404);
      }
      expect((await actionOf(h, id))!.status).toBe('proposed');
      const res = await call<{ status: string }>(r.w.admin, 'POST', `/ads/proposals/${id}/approve`);
      expect(res.status).toBe(200);
      expect(res.body.status).toBe('executed');
      expect((await actionOf(h, id))!.decided_by_role).toBe('admin');
    });
  });
});

describe('the pack gate (R-ADS-7, D7)', () => {
  it('E440: while platform:ads is dark the tap is ADS_NOT_CLEARED and nothing is recorded; E441: counsel review alone is refused too', async () => {
    const r = await withAdsCleared(h, async () => {
      const x = await ready();
      return { ...x, id: await propose(x) };
    });
    const before = await moneyRows(h, r.w.tenantId);
    const dark = await call(r.w.owner, 'POST', `/ads/proposals/${r.id}/approve`);
    expect(dark.status).toBe(409);
    expect(dark.code).toBe('ADS_NOT_CLEARED');
    try {
      await setAdsPack(h, { reviewed: true, vendor: false });
      const counsel = await call(r.w.owner, 'POST', `/ads/proposals/${r.id}/approve`);
      expect(counsel.code).toBe('ADS_NOT_CLEARED');
    } finally {
      await resetAdsPack(h);
    }
    expect(await moneyRows(h, r.w.tenantId)).toEqual(before);
    expect((await actionOf(h, r.id))!.status).toBe('proposed');
    expect(r.w.fake.calls.filter((c) => c.op === 'applyBudgetChange')).toEqual([]);
  });

  it('E442: the pack withdrawn after the tap (mid-flight): the planned rows fail PACK_WITHDRAWN and no budget call is made', async () => {
    await withAdsCleared(h, async () => {
      const r = await ready();
      const id = await propose(r);
      // the provider call never answers; meanwhile counsel withdraws the pack; the readback then sees the old amount
      r.w.fake.failNext('applyBudgetChange', { kind: 'hang', applied: false });
      const deps = depsOf(h, r.w, { applyTimeoutMs: 50 });
      const first = approveShift(deps, r.w.owner.actor(), id);
      const state = await first;
      expect(state.rows.map((x) => x.outcome).sort()).toEqual(['applied', 'pending']);
      await resetAdsPack(h);
      passTime(r.w, STALE);
      await runReconcile(depsOf(h, r.w), r.w.tenantId);
      const failed = (await ledgerOf(h, r.w.tenantId)).filter((e) => e.event_kind === 'failed');
      expect(failed.map((e) => e.reason_code)).toEqual(['PACK_WITHDRAWN']);
      expect(r.w.fake.calls.filter((c) => c.op === 'applyBudgetChange')).toHaveLength(2);
      expect((await actionOf(h, id))!.status).toBe('executed');
    });
  });
});

const STALE = 11 * MINUTE_MS;

describe('stale proposals (E445, E446, E124)', () => {
  it('E445 E124: the Owner lowered the cap after the proposal: the tap is ADS_PROPOSAL_STALE, the proposal is superseded, nothing is planned', async () => {
    await withAdsCleared(h, async () => {
      const r = await ready();
      const id = await propose(r);
      expect((await setCapVia(h, r.w.owner, 2_000_000, 8_000)).status).toBe(201);
      const res = await call(r.w.owner, 'POST', `/ads/proposals/${id}/approve`);
      expect(res.code).toBe('ADS_PROPOSAL_STALE');
      expect((await actionOf(h, id))!.status).toBe('superseded');
      expect((await moneyRows(h, r.w.tenantId)).events).toBe(0);
    });
  });

  it('E446: a budget changed in the Google Ads interface after the proposal: ADS_PROPOSAL_STALE (the mirror took the new amount)', async () => {
    await withAdsCleared(h, async () => {
      const r = await ready();
      const id = await propose(r);
      r.w.fake.setBudget(r.accountId, 'fake-c-cheap', 2500);
      await runReconcile(depsOf(h, r.w), r.w.tenantId);
      const res = await call(r.w.owner, 'POST', `/ads/proposals/${id}/approve`);
      expect(res.code).toBe('ADS_PROPOSAL_STALE');
      expect((await actionOf(h, id))!.status).toBe('superseded');
    });
  });
});

describe('unknown outcomes resolved by readback (E447), partial failure (E448)', () => {
  it('E447: a timeout that applied anyway is read back as applied (READBACK); never a second plan', async () => {
    await withAdsCleared(h, async () => {
      const r = await ready();
      const id = await propose(r);
      r.w.fake.failNext('applyBudgetChange', { kind: 'timeout', applied: true });
      const s = await call<{ rows: { outcome: string }[] }>(r.w.owner, 'POST', `/ads/proposals/${id}/approve`);
      expect(s.body.rows.map((x) => x.outcome).sort()).toEqual(['applied', 'pending']);
      passTime(r.w, STALE);
      await runReconcile(depsOf(h, r.w), r.w.tenantId);
      const l = await ledgerOf(h, r.w.tenantId);
      expect(l.filter((e) => e.event_kind === 'planned')).toHaveLength(2);
      expect(l.filter((e) => e.event_kind === 'applied').map((e) => e.reason_code).sort()).toEqual(['APPLIED', 'READBACK']);
      expect((await actionOf(h, id))!.status).toBe('executed');
    });
  });

  it('E447: a timeout that did not apply is re-applied once (marked first in trigger_ref.reapplied), then applied', async () => {
    await withAdsCleared(h, async () => {
      const r = await ready();
      const id = await propose(r);
      r.w.fake.failNext('applyBudgetChange', { kind: 'timeout', applied: false });
      await call(r.w.owner, 'POST', `/ads/proposals/${id}/approve`);
      passTime(r.w, STALE);
      await runReconcile(depsOf(h, r.w), r.w.tenantId);
      const a = await actionOf(h, id);
      expect((a!.trigger_ref.reapplied as string[]).length).toBe(1);
      expect(a!.status).toBe('executed');
      const applies = r.w.fake.calls.filter((c) => c.op === 'applyBudgetChange');
      expect(applies).toHaveLength(3);
      expect(new Set(applies.map((c) => c.idempotencyKey)).size).toBe(2);
    });
  });

  it('E447: a re-apply that times out again waits; after 24 hours the plan fails OUTCOME_UNKNOWN and is never re-applied twice', async () => {
    await withAdsCleared(h, async () => {
      const r = await ready();
      const id = await propose(r);
      r.w.fake.failNext('applyBudgetChange', { kind: 'timeout', applied: false });
      await call(r.w.owner, 'POST', `/ads/proposals/${id}/approve`);
      passTime(r.w, STALE);
      r.w.fake.failNext('applyBudgetChange', { kind: 'timeout', applied: false });
      await runReconcile(depsOf(h, r.w), r.w.tenantId);
      r.w.clock.advance(HOUR_MS);
      await runReconcile(depsOf(h, r.w), r.w.tenantId);
      expect(r.w.fake.calls.filter((c) => c.op === 'applyBudgetChange')).toHaveLength(3);
      r.w.clock.advance(DAY_MS);
      await runReconcile(depsOf(h, r.w), r.w.tenantId);
      const failed = (await ledgerOf(h, r.w.tenantId)).filter((e) => e.event_kind === 'failed');
      expect(failed.map((e) => e.reason_code)).toEqual(['OUTCOME_UNKNOWN']);
      expect((await ledgerOf(h, r.w.tenantId)).filter((e) => e.event_kind === 'planned')).toHaveLength(2);
      expect((await actionOf(h, id))!.status).toBe('executed');
    });
  });

  it('E447: the platform shows a third amount after a timeout: failed PLATFORM_CHANGED and the mirror takes it', async () => {
    await withAdsCleared(h, async () => {
      const r = await ready();
      const id = await propose(r);
      r.w.fake.failNext('applyBudgetChange', { kind: 'timeout', applied: false });
      await call(r.w.owner, 'POST', `/ads/proposals/${id}/approve`);
      const pendingExt = (await ledgerOf(h, r.w.tenantId)).filter((e) => e.event_kind === 'planned').find((p) => !(r.w.fake.applied.some((x) => x.idempotencyKey === p.id)))!;
      const ext = pendingExt.campaign_id === r.cheap ? 'fake-c-cheap' : 'fake-c-costly';
      r.w.fake.setBudget(r.accountId, ext, 1234);
      passTime(r.w, STALE);
      await runReconcile(depsOf(h, r.w), r.w.tenantId);
      expect((await ledgerOf(h, r.w.tenantId)).filter((e) => e.event_kind === 'failed').map((e) => e.reason_code)).toEqual(['PLATFORM_CHANGED']);
      expect(Number((await campaignOf(h, r.w.tenantId, ext))!.daily_budget_cents)).toBe(1234);
      expect((await actionOf(h, id))!.status).toBe('executed');
    });
  });

  it('E448: one change applied and the other rejected by the platform: both outcomes recorded, the run executed, the mirror moved only where applied', async () => {
    await withAdsCleared(h, async () => {
      const r = await ready();
      const id = await propose(r);
      r.w.fake.failNext('applyBudgetChange', { kind: 'rejected', code: 'BUDGET_TOO_LOW' });
      const s = await call<{ status: string; rows: { outcome: string; outcomeCode: string | null }[] }>(r.w.owner, 'POST', `/ads/proposals/${id}/approve`);
      expect(s.body.status).toBe('executed');
      expect(s.body.rows.map((x) => `${x.outcome}:${x.outcomeCode}`).sort()).toEqual(['applied:APPLIED', 'failed:BUDGET_TOO_LOW']);
      expect(r.w.fake.applied).toHaveLength(1);
    });
  });
});

describe('replays and concurrency (E145, E161, E457)', () => {
  it('E145 E161: a double tap returns the run state; a replay of the approval the next day plans nothing (the DB refuses a second planned row per approval)', async () => {
    await withAdsCleared(h, async () => {
      const r = await ready();
      const id = await propose(r);
      const one = await call<{ runId: string }>(r.w.owner, 'POST', `/ads/proposals/${id}/approve`);
      const two = await call<{ runId: string }>(r.w.owner, 'POST', `/ads/proposals/${id}/approve`);
      expect(two.status).toBe(200);
      expect(two.body.runId).toBe(one.body.runId);
      r.w.clock.advance(DAY_MS);
      const three = await call<{ runId: string }>(r.w.owner, 'POST', `/ads/proposals/${id}/approve`);
      expect(three.body.runId).toBe(one.body.runId);
      expect((await ledgerOf(h, r.w.tenantId)).filter((e) => e.event_kind === 'planned')).toHaveLength(2);
      // the DB refuses the replayed planned row itself (approval single-use)
      const planned = (await ledgerOf(h, r.w.tenantId)).find((e) => e.event_kind === 'planned')!;
      await expect(h.su.query(
        `INSERT INTO ad_allocation_events (tenant_id, id, run_id, campaign_id, event_kind, cap_version_id, assistant_action_id, from_daily_cents, to_daily_cents, reason_code, occurred_at)
         VALUES ($1, gen_random_uuid(), gen_random_uuid(), $2, 'planned', $3, $4, $5, $6, 'REPLAY', now())`,
        [r.w.tenantId, planned.campaign_id, planned.cap_version_id, id, planned.from, planned.to],
      )).rejects.toThrow(/ad_allocation_events_approval_once/);
      // another person learns it was handled
      expect((await call(r.w.admin, 'POST', `/ads/proposals/${id}/approve`)).code).toBe('ACTION_NOT_PENDING');
    });
  });

  it('E457: an Owner and an Admin tap at the same moment: exactly one plan, the other is told it was handled', async () => {
    await withAdsCleared(h, async () => {
      const r = await ready();
      const id = await propose(r);
      const [a, b] = await Promise.all([call(r.w.owner, 'POST', `/ads/proposals/${id}/approve`), call(r.w.admin, 'POST', `/ads/proposals/${id}/approve`)]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      expect([a.code, b.code].filter(Boolean)).toEqual(['ACTION_NOT_PENDING']);
      expect((await ledgerOf(h, r.w.tenantId)).filter((e) => e.event_kind === 'planned')).toHaveLength(2);
      expect(new Set((await ledgerOf(h, r.w.tenantId)).map((e) => e.run_id)).size).toBe(1);
    });
  });

  it('E444: an ad_reallocation approved outside the ads path is never planned (ADS_APPROVAL_NOT_FROM_ADS), and a reject is the person\'s decision, audited', async () => {
    await withAdsCleared(h, async () => {
      const r = await ready();
      const id = await propose(r);
      // an approval written by a person straight to the row (not through /ads): the ads path never plans it
      const { withTenantTx } = await import('@realty/db');
      const { sql } = await import('kysely');
      await withTenantTx(r.w.owner.actor(), (tx) => sql`UPDATE assistant_actions SET status = 'approved', decided_by_user_id = app.user_id(), decided_at = now() WHERE id = ${id}::uuid`.execute(tx), { db: h.database });
      const res = await call(r.w.owner, 'POST', `/ads/proposals/${id}/approve`);
      expect(res.code).toBe('ADS_APPROVAL_NOT_FROM_ADS');
      await runReconcile(depsOf(h, r.w), r.w.tenantId);
      expect((await moneyRows(h, r.w.tenantId)).events).toBe(0);
      // a new week's proposal, rejected
      await h.su.query('DELETE FROM assistant_actions WHERE id = $1', [id]);
      const id2 = await propose(r);
      const rej = await call<{ status: string }>(r.w.admin, 'POST', `/ads/proposals/${id2}/reject`);
      expect(rej.body.status).toBe('rejected');
      expect((await h.su.query("SELECT count(*)::int AS n FROM audit_log WHERE tenant_id = $1 AND action = 'ads.shift_rejected'", [r.w.tenantId])).rows[0].n).toBe(1);
      expect((await call(r.w.owner, 'POST', `/ads/proposals/${id2}/approve`)).code).toBe('ACTION_NOT_PENDING');
    });
  });
});

describe('no lead source, no money move (b11 sends-gates/F2)', () => {
  it('R-ADS-9 E459: once an Admin clears the connection\'s lead source (its spend is no longer recorded), a pending proposal\'s tap and a resume are 409 ADS_NO_LEAD_SOURCE and nothing is planned', async () => {
    await withAdsCleared(h, async () => {
      const r = await ready();
      const id = await propose(r);
      const leadSource = async (leadSourceId: string | null) => {
        await freshReauth(h, r.w.admin);
        expect((await call(r.w.admin, 'PATCH', `/admin/integrations/connections/${r.connectionId}`, { leadSourceId })).status).toBe(200);
      };
      await leadSource(null);
      const before = await moneyRows(h, r.w.tenantId);
      const tap = await call(r.w.owner, 'POST', `/ads/proposals/${id}/approve`);
      expect(tap.status).toBe(409);
      expect(tap.code).toBe('ADS_NO_LEAD_SOURCE');
      expect((await actionOf(h, id))!.status).toBe('proposed');
      // a campaign paused in Google Ads, mirrored as paused while the lead source was set again; then cleared again
      await leadSource(r.w.sourceId);
      r.w.fake.setStatus(r.accountId, 'fake-c-costly', 'paused');
      await runReconcile(depsOf(h, r.w), r.w.tenantId);
      expect((await campaignOf(h, r.w.tenantId, 'fake-c-costly'))!.status).toBe('paused');
      await leadSource(null);
      const resume = await call(r.w.owner, 'POST', `/ads/campaigns/${r.costly}/resume`);
      expect(resume.status).toBe(409);
      expect(resume.code).toBe('ADS_NO_LEAD_SOURCE');
      expect(await moneyRows(h, r.w.tenantId)).toEqual(before);
      expect(r.w.fake.calls.filter((c) => c.op === 'applyBudgetChange')).toEqual([]);
    });
  });
});

describe('grant revoked, then disconnected (E454)', () => {
  it('E454 R-ADS-8 R-ADS-13: revoked, then disconnected: the tap is ADS_CONNECTION_NOT_LIVE and the weekly run finds no connection; campaign and ledger rows are kept; spend unchecked for 2 hours still alerts each Owner and Admin once a day', async () => {
    await withAdsCleared(h, async () => {
      const r = await ready();
      // last week's proposal, approved and applied: ledger rows exist; this week's is pending
      const last = await runWeeklyProposal(depsOf(h, r.w, { now: () => (thisMonday() - 7 * DAY_MS) as never }), r.w.tenantId);
      expect(last.outcome).toBe('proposed');
      expect((await call(r.w.owner, 'POST', `/ads/proposals/${last.actionId}/approve`)).status).toBe(200);
      await runReconcile(depsOf(h, r.w), r.w.tenantId);
      const id = await propose(r);
      const ledger = (await ledgerOf(h, r.w.tenantId)).length;
      expect(ledger).toBeGreaterThan(0);
      r.w.fake.revoke(r.accountId);
      await runReconcile(depsOf(h, r.w), r.w.tenantId);
      expect((await h.su.query('SELECT status FROM integration_connections WHERE id = $1', [r.connectionId])).rows[0].status).toBe('revoked');
      expect((await call(r.w.owner, 'POST', `/ads/proposals/${id}/approve`)).code).toBe('ADS_CONNECTION_NOT_LIVE');
      await freshReauth(h, r.w.owner);
      expect((await call(r.w.owner, 'POST', `/admin/integrations/connections/${r.connectionId}/disconnect`)).status).toBe(200);
      expect((await call(r.w.admin, 'POST', `/ads/proposals/${id}/approve`)).code).toBe('ADS_CONNECTION_NOT_LIVE');
      const next = await runWeeklyProposal(depsOf(h, r.w, { now: () => (thisMonday() + 7 * DAY_MS) as never }), r.w.tenantId);
      expect(next.outcome).toBe('no_connection');
      expect((await actionOf(h, id))!.status).toBe('proposed');
      // the rows stay
      expect((await h.su.query('SELECT count(*)::int AS n FROM ad_campaigns WHERE tenant_id = $1', [r.w.tenantId])).rows[0].n).toBe(2);
      expect((await ledgerOf(h, r.w.tenantId)).length).toBe(ledger);
      // a disconnected account's campaigns may still spend: after 2 hours unchecked, one alert per Owner/Admin and day
      const unchecked = async () => (await h.su.query<{ user_id: string }>("SELECT user_id FROM notifications WHERE tenant_id = $1 AND kind = 'ad_overspend' AND dedupe_key LIKE $2", [r.w.tenantId, `ad_unchecked:${r.connectionId}:%`])).rows;
      expect(await unchecked()).toEqual([]);
      passTime(r.w, 3 * HOUR_MS);
      await runReconcile(depsOf(h, r.w), r.w.tenantId);
      await runReconcile(depsOf(h, r.w), r.w.tenantId);
      expect((await unchecked()).map((x) => x.user_id).sort()).toEqual([r.w.owner.userId, r.w.admin.userId].sort());
      expect(r.w.fake.calls.filter((c) => c.op === 'applyBudgetChange').length).toBe(2);
    });
  });
});

describe('resume (R-ADS-5: resuming is a tap)', () => {
  it('E459: resume is refused at the monthly cap; below it one tap plans RESUMED and applies with resume', async () => {
    await withAdsCleared(h, async () => {
      const r = await ready();
      // E124: the Owner lowers the cap below month-to-date spend: a reconcile pass is queued at once and pauses both
      r.w.fake.addSpend(r.accountId, 'fake-c-cheap', r.w.clock.now() - 2 * HOUR_MS, 12_000);
      await runReconcile(depsOf(h, r.w), r.w.tenantId);
      const lowered = await setCapVia(h, r.w.owner, 10_000, 10_000);
      expect(lowered.body.reconcileQueued).toBe(true);
      expect((await h.su.query("SELECT count(*)::int AS n FROM jobs WHERE tenant_id = $1 AND kind = 'ads.reconcile' AND dedupe_key = 'ads_reconcile:cap_lowered'", [r.w.tenantId])).rows[0].n).toBe(1);
      await runReconcile(depsOf(h, r.w), r.w.tenantId);
      expect((await campaignOf(h, r.w.tenantId, 'fake-c-cheap'))!.status).toBe('paused');
      const refused = await call(r.w.owner, 'POST', `/ads/campaigns/${r.cheap}/resume`);
      expect(refused.code).toBe('ADS_MONTHLY_CAP_REACHED');
      expect((await setCapVia(h, r.w.owner, 3_000_000, 10_000)).status).toBe(201);
      const ok = await call<{ status: string; rows: { reasonCode: string; outcome: string }[] }>(r.w.owner, 'POST', `/ads/campaigns/${r.cheap}/resume`);
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({ status: 'executed', rows: [{ reasonCode: 'RESUMED', outcome: 'applied' }] });
      expect(r.w.fake.statusOf(r.accountId, 'fake-c-cheap')).toBe('enabled');
      expect((await campaignOf(h, r.w.tenantId, 'fake-c-cheap'))!.status).toBe('active');
      // E447 for a resume: a timed-out resume that did not take effect is not read back as applied (the budget alone matches)
      const cap2 = await setCapVia(h, r.w.owner, 3_000_000, 10_000);
      expect(cap2.status).toBe(201);
      r.w.fake.failNext('applyBudgetChange', { kind: 'timeout', applied: false });
      const pending = await call<{ rows: { outcome: string }[] }>(r.w.owner, 'POST', `/ads/campaigns/${r.costly}/resume`);
      expect(pending.body.rows.map((x) => x.outcome)).toEqual(['pending']);
      r.w.fake.failNext('applyBudgetChange', { kind: 'timeout', applied: false });
      passTime(r.w, STALE);
      await runReconcile(depsOf(h, r.w), r.w.tenantId);
      const costlyRows = (await ledgerOf(h, r.w.tenantId)).filter((e) => e.campaign_id === r.costly && (e.event_kind === 'applied' || e.event_kind === 'failed'));
      expect(costlyRows).toEqual([]);
      expect(r.w.fake.statusOf(r.accountId, 'fake-c-costly')).toBe('paused');
      // the next pass, with the re-apply already used: still waiting; the platform resumed by hand ⇒ applied READBACK
      r.w.fake.setStatus(r.accountId, 'fake-c-costly', 'enabled');
      passTime(r.w, STALE);
      await runReconcile(depsOf(h, r.w), r.w.tenantId);
      expect((await ledgerOf(h, r.w.tenantId)).filter((e) => e.campaign_id === r.costly && e.event_kind === 'applied').map((e) => e.reason_code)).toEqual(['READBACK']);
      // an agent cannot resume
      expect((await call(r.w.agent, 'POST', `/ads/campaigns/${r.costly}/resume`)).status).toBe(404);
    });
  });
});
