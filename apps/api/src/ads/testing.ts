// Test helpers of api/ads (imported by *.test.ts only). The platform is the deterministic FakeAds on a manual clock and
// the FakeOAuth connect; the application side runs through the real server and real Postgres as app_user. Fixtures use
// fake-ads-* ids and no real names. Clearing platform:ads is a platform step done as superuser and ALWAYS reset
// (withAdsCleared's finally). The fast-check arbitraries live here (core/ads/testing has no index entry).
import { fixedClock, HOUR_MS, type ManualClock } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import fc from 'fast-check';
import { sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { call, freshReauth } from '../admin/testing.js';
import type { ApiHarness, TestClient } from '../auth/testHarness.js';
import { connectFlow } from '../integrations/testing.js';
import { contactOf } from '../workspace/testing.js';
import { FakeAds, type FakeCampaignInput } from './provider.js';
import type { AdsDeps } from './runtime.js';

/** The middle of the current UTC month at noon: hours of fake time never cross a month or a day boundary by accident. */
export function midMonth(nowMs = Date.now()): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 15, 12);
}

/**
 * The fake platform's clock: the current hour (so plan ages agree with the DB clock's occurred_at), moved up to 6 hours
 * away from a month boundary so a test that adds a few hours stays inside the current month.
 */
export function testClockStart(nowMs = Date.now()): number {
  const hour = Math.floor(nowMs / HOUR_MS) * HOUR_MS;
  const d = new Date(hour);
  const monthStart = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  const nextMonth = Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1);
  if (hour - monthStart < 6 * HOUR_MS) return monthStart + 6 * HOUR_MS;
  if (nextMonth - hour < 8 * HOUR_MS) return nextMonth - 8 * HOUR_MS;
  return hour;
}

/** The Monday of the current ISO week (UTC), at 15:00 UTC. */
export function thisMonday(nowMs = Date.now()): number {
  const d = new Date(nowMs);
  const day = d.getUTCDay() === 0 ? 7 : d.getUTCDay();
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - (day - 1), 15);
}

export interface AdsWorld {
  tenantId: string;
  owner: TestClient;
  admin: TestClient;
  agent: TestClient;
  teamLead: TestClient;
  sourceId: string;
  listingId: string;
  /** an approved creative of listingId */
  pieceId: string;
  clock: ManualClock;
  fake: FakeAds;
}

/** A tenant (zone Etc/UTC) with an Owner, an Admin, an agent and a Team Lead, a lead source, a listing and an approved creative. */
export async function adsWorld(h: ApiHarness, o: { clockMs?: number; fake?: FakeAds } = {}): Promise<AdsWorld> {
  const owner = await h.signup({ timezone: 'Etc/UTC' });
  const tenantId = owner.tenantId!;
  const admin = await h.invite(owner, 'admin');
  const agent = await h.invite(owner, 'agent');
  const teamLead = await h.invite(owner, 'team_lead');
  const sourceId = randomUUID();
  await h.su.query("INSERT INTO lead_sources (tenant_id, id, name, kind) VALUES ($1, $2, 'Google Ads', 'ads')", [tenantId, sourceId]);
  const { listingId, pieceId } = await approvedPiece(h, tenantId, agent);
  const clock = fixedClock(o.clockMs ?? testClockStart());
  const fake = o.fake ?? new FakeAds(clock);
  h.providers.ads = fake;
  return { tenantId, owner, admin, agent, teamLead, sourceId, listingId, pieceId, clock, fake };
}

/** A listing of the agent and an approved social post of it, written by the agent as themselves (the 0018 marketing guard). */
export async function approvedPiece(h: ApiHarness, tenantId: string, agent: TestClient, o: { listingId?: string; status?: 'approved' | 'draft' } = {}): Promise<{ listingId: string; pieceId: string }> {
  const listingId = o.listingId ?? randomUUID();
  if (!o.listingId) {
    await h.su.query(
      `INSERT INTO listings (tenant_id, id, source, status, address_line1, city, region, postal_code, listing_agent_user_id, list_price_cents)
       VALUES ($1, $2, 'team', 'active', '12 Test St', 'Town', 'SC', '29401', $3, 45000000)`,
      [tenantId, listingId, agent.userId],
    );
  }
  const pieceId = randomUUID();
  await withTenantTx(
    agent.actor(),
    async (tx) => {
      const v = (await sql<{ v: number }>`SELECT COALESCE(max(version_no), 0) + 1 AS v FROM marketing_pieces WHERE tenant_id = app.tenant_id() AND listing_id = ${listingId}::uuid`.execute(tx)).rows[0]!.v;
      await sql`INSERT INTO marketing_pieces (tenant_id, id, listing_id, kind, version_no, prose, template_key, guard_result, created_by_user_id)
                VALUES (app.tenant_id(), ${pieceId}::uuid, ${listingId}::uuid, 'social_post', ${v}, '{"text": "Open house Sunday at 12 Test St"}', 'social/1',
                        '{"brokerage_name_present": true, "hard_count": 0, "pack_rule_failures": []}', app.user_id())`.execute(tx);
      await sql`UPDATE marketing_pieces SET guard_result = guard_result || jsonb_build_object('content_sha256', content_sha256) WHERE id = ${pieceId}::uuid`.execute(tx);
      if ((o.status ?? 'approved') === 'approved') await sql`UPDATE marketing_pieces SET status = 'approved', approved_by_user_id = app.user_id(), approved_at = now() WHERE id = ${pieceId}::uuid`.execute(tx);
    },
    { db: h.database },
  );
  return { listingId, pieceId };
}

/** Connects a Google Ads account through the OAuth start and the FakeOAuth callback; the fake platform gets the account. */
export async function connectAds(
  h: ApiHarness,
  w: AdsWorld,
  accountId = `fake-ads-${randomUUID().slice(0, 8)}`,
  o: { leadSource?: boolean; currency?: string; timeZone?: string; campaigns?: FakeCampaignInput[] } = {},
): Promise<{ connectionId: string; accountId: string }> {
  w.fake.addAccount(accountId, { ...(o.currency ? { currency: o.currency } : {}), timeZone: o.timeZone ?? 'Etc/UTC' });
  for (const c of o.campaigns ?? []) w.fake.addCampaign(accountId, c);
  const f = await connectFlow(h, w.owner, 'ads_google', { externalAccountId: accountId, ...(o.leadSource === false ? {} : { leadSourceId: w.sourceId }) }, [{ id: accountId }]);
  if (f.cb.result !== 'CONNECTED') throw new Error(`ads connect failed: ${f.cb.result}`);
  return { connectionId: f.connectionId, accountId };
}

/** Moves the fake clock `ms` past both its own time and the DB's (plans' occurred_at is the DB clock). */
export function passTime(w: AdsWorld, ms: number): void {
  w.clock.set(Math.max(w.clock.now(), Date.now()) + ms);
}

/** Clears platform:ads (counsel review and/or the vendor check) as superuser. Always paired with resetAdsPack. */
export async function setAdsPack(h: ApiHarness, o: { reviewed: boolean; vendor: boolean }): Promise<void> {
  await h.su.query(
    `UPDATE jurisdiction_packs SET reviewed_by_counsel_at = CASE WHEN $1::boolean THEN now() END,
            rules = CASE WHEN $2::boolean THEN rules || '{"vendor_ready_at": "2026-11-01T00:00:00Z"}' ELSE rules - 'vendor_ready_at' END
      WHERE key = 'platform:ads' AND status = 'published'`,
    [o.reviewed, o.vendor],
  );
}

export const resetAdsPack = (h: ApiHarness) => setAdsPack(h, { reviewed: false, vendor: false });

/** Runs `fn` with platform:ads cleared, then withdraws it whatever happens (D11 never covers ads). */
export async function withAdsCleared<T>(h: ApiHarness, fn: () => Promise<T>): Promise<T> {
  await setAdsPack(h, { reviewed: true, vendor: true });
  try {
    return await fn();
  } finally {
    await resetAdsPack(h);
  }
}

export function depsOf(h: ApiHarness, w: AdsWorld, extra: Partial<AdsDeps> = {}): AdsDeps {
  const p = h.app.platform;
  return { db: p.db, envelope: p.envelope, ids: p.ids, ads: w.fake, now: () => w.clock.now(), ...extra };
}

/** The Owner sets a cap through the API (re-authenticated, with the exact attestation). */
export async function setCapVia(h: ApiHarness, c: TestClient, monthlyCapCents: number, dailyCeilingCents: number) {
  const { capAttestation } = await import('./settings.js');
  await freshReauth(h, c);
  return call<{ cap: { id: string; versionNo: number }; reconcileQueued: boolean }>(c, 'POST', '/ads/caps', { monthlyCapCents, dailyCeilingCents, attestation: capAttestation(monthlyCapCents, dailyCeilingCents) });
}

export async function campaignOf(h: ApiHarness, tenantId: string, externalCampaignId: string) {
  return (
    await h.su.query<{ id: string; status: string; daily_budget_cents: string; name: string; targeting: Record<string, unknown>; listing_id: string | null; creative_piece_id: string | null; lead_source_id: string; campaign_ref: string }>(
      'SELECT id, status, daily_budget_cents, name, targeting, listing_id, creative_piece_id, lead_source_id, campaign_ref FROM ad_campaigns WHERE tenant_id = $1 AND external_campaign_id = $2',
      [tenantId, externalCampaignId],
    )
  ).rows[0];
}

export async function ledgerOf(h: ApiHarness, tenantId: string) {
  return (
    await h.su.query<{ id: string; run_id: string; campaign_id: string; event_kind: string; from_daily_cents: string; to_daily_cents: string; reason_code: string; provider_ref: string | null; cap_version_id: string; assistant_action_id: string | null }>(
      'SELECT * FROM ad_allocation_events WHERE tenant_id = $1 ORDER BY occurred_at, id',
      [tenantId],
    )
  ).rows.map((r) => ({ ...r, from: Number(r.from_daily_cents), to: Number(r.to_daily_cents) }));
}

export async function actionOf(h: ApiHarness, id: string) {
  return (await h.su.query<{ status: string; owner_user_id: string | null; contact_id: string | null; payload: Record<string, unknown>; decided_by_role: string | null; trigger_ref: Record<string, unknown>; explanation: string; dedupe_key: string | null }>(
    'SELECT status, owner_user_id, contact_id, payload, decided_by_role, trigger_ref, explanation, dedupe_key FROM assistant_actions WHERE id = $1', [id])).rows[0];
}

/** Deals carrying a campaign's ref: `agreements` signed and `closings` closed within the last 90 days. */
export async function dealsFor(h: ApiHarness, w: AdsWorld, campaignRef: string, agreements: number, closings = 0): Promise<void> {
  const contact = await contactFor(h, w);
  for (let i = 0; i < agreements; i++) {
    const closed = i < closings;
    await h.su.query(
      `INSERT INTO deals (tenant_id, id, name, side, stage, stage_entered_at, primary_contact_id, owner_user_id, agreement_signed_at, closed_at, campaign_ref, created_by_user_id)
       VALUES ($1, $2, 'Deal', 'buy', $3, now(), $4, $5, now() - interval '10 days', $6, $7, $5)`,
      [w.tenantId, randomUUID(), closed ? 'closed' : 'agreement_signed', contact, w.agent.userId, closed ? new Date(Date.now() - 2 * 86_400_000) : null, campaignRef],
    );
  }
}

let contactCache = new Map<string, string>();
async function contactFor(h: ApiHarness, w: AdsWorld): Promise<string> {
  const c = contactCache.get(w.tenantId);
  if (c) return c;
  const { id } = await contactOf(w.agent, { firstName: 'Kai' });
  contactCache.set(w.tenantId, id);
  return id;
}
export function resetContactCache(): void {
  contactCache = new Map();
}

/** Spend history on the fake platform: `centsPerDay` for each of the `days` days before the fake clock (24 hours each). */
export function spendHistory(w: AdsWorld, accountId: string, externalCampaignId: string, centsPerDay: number, days = 90): void {
  const start = Math.floor(w.clock.now() / HOUR_MS) * HOUR_MS - days * 24 * HOUR_MS;
  const perHour = Math.floor(centsPerDay / 24);
  const rest = centsPerDay - perHour * 24;
  for (let d = 0; d < days; d++) for (let hr = 0; hr < 24; hr++) w.fake.addSpend(accountId, externalCampaignId, start + (d * 24 + hr) * HOUR_MS, perHour + (hr === 0 ? rest : 0));
}

/** Rows of a table a pass must never write while dark, for "nothing recorded" checks. */
export async function moneyRows(h: ApiHarness, tenantId: string): Promise<{ events: number; approved: number }> {
  const e = (await h.su.query('SELECT count(*)::int AS n FROM ad_allocation_events WHERE tenant_id = $1', [tenantId])).rows[0].n as number;
  const a = (await h.su.query("SELECT count(*)::int AS n FROM assistant_actions WHERE tenant_id = $1 AND kind = 'ad_reallocation' AND status IN ('approved','executed')", [tenantId])).rows[0].n as number;
  return { events: e, approved: a };
}

// ---- fast-check arbitraries (own: core/ads/testing has no index entry) ----------------------------------------------------

export interface CampaignSpec {
  budgetCents: number;
  agreements: number;
  spendPerDayCents: number;
  linked: boolean;
}

export const campaignSpecArb: fc.Arbitrary<CampaignSpec> = fc.record({
  budgetCents: fc.integer({ min: 100, max: 20_000 }),
  agreements: fc.constantFrom(0, 3, 5, 6, 9, 14),
  spendPerDayCents: fc.integer({ min: 0, max: 20_000 }),
  linked: fc.constantFrom(true, true, true, false),
});

export const worldSpecArb = fc.record({
  campaigns: fc.array(campaignSpecArb, { minLength: 2, maxLength: 5 }),
  ceilingSlackCents: fc.integer({ min: -2_000, max: 10_000 }),
});
