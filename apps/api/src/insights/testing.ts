// Test helpers of api/insights (imported by *.test.ts only). Deals, history and financials are superuser fixtures
// (their timing must be backdated: deal_stage_history is written by a trigger at now()); every read under test goes
// through the real server as app_user, or withTenantTx as an explicit actor.
import { randomUUID } from 'node:crypto';
import { type Instant, type TenantId, instant, localDateOf, zone } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import type { ApiHarness, TestClient } from '../auth/testHarness.js';
import { type LeadsWorld, leadsWorld, suFixture } from '../leads/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { contactOf } from '../workspace/testing.js';
import { addDaysLocal, midnight, mondayOf } from './common.js';
import { reconcileWeeklyPlans } from './plan.js';

export { call, freshReauth, staleReauth } from '../admin/testing.js';

export const DAY = 86_400_000;

export interface InsightsWorld extends LeadsWorld {
  admin: TestClient;
  isa: TestClient;
  tc: TestClient;
  teamLead: TestClient;
  zone: string;
}

/** Owner, Admin, a Team Lead leading agents[0..1], an ISA and a TC; one lead source ("Portal"). */
export async function insightsWorld(h: ApiHarness, o: { timezone?: string } = {}): Promise<InsightsWorld> {
  const w = await leadsWorld(h, { agents: 2, teamLead: true, others: ['admin', 'isa', 'tc'], push: false, timezone: o.timezone ?? 'America/Los_Angeles' });
  const [admin, isa, tc] = w.others as [TestClient, TestClient, TestClient];
  return { ...w, admin, isa, tc, teamLead: w.teamLead!, zone: o.timezone ?? 'America/Los_Angeles' };
}

export async function leadSource(h: ApiHarness, tenantId: string, name: string): Promise<string> {
  const id = randomUUID();
  await h.su.query(`INSERT INTO lead_sources (tenant_id, id, name, kind) VALUES ($1, $2, $3, 'other')`, [tenantId, id, name]);
  return id;
}

export interface DealFixture {
  owner: TestClient;
  stage: 'prospect' | 'agreement_signed' | 'active' | 'under_contract' | 'closed' | 'lost';
  name?: string;
  sourceId?: string | null;
  /** closed deals: the closing instant (also the history row's) */
  closedAt?: Date;
  /** the instant the deal entered its current stage (history row) */
  enteredAt?: Date;
  commissionCents?: number | null;
  contactId?: string;
}

/** A deal of `owner` with ONE backdated history row for its current stage, and optional financials. */
export async function deal(h: ApiHarness, tenantId: string, f: DealFixture): Promise<string> {
  const id = randomUUID();
  const contactId = f.contactId ?? (await contactOf(f.owner)).id;
  const entered = f.stage === 'closed' ? (f.closedAt ?? new Date()) : (f.enteredAt ?? new Date());
  // triggers off (replica): no now()-stamped history row; the one row below carries the backdated entry
  await suFixture(h, [
    {
      text: `INSERT INTO deals (tenant_id, id, name, side, stage, stage_entered_at, primary_contact_id, owner_user_id, closed_at, lead_source_id, lost_reason)
             VALUES ($1, $2, $3, 'buy', $4, $5, $6, $7, $8, $9, $10)`,
      values: [tenantId, id, f.name ?? `Deal ${id.slice(0, 4)}`, f.stage, entered, contactId, f.owner.userId, f.stage === 'closed' ? entered : null, f.sourceId ?? null, f.stage === 'lost' ? 'other' : null],
    },
    { text: `INSERT INTO deal_stage_history (tenant_id, deal_id, to_stage, actor_kind, changed_at) VALUES ($1, $2, $3, 'system', $4)`, values: [tenantId, id, f.stage, entered] },
  ]);
  if (f.commissionCents !== undefined) {
    await h.su.query(
      `INSERT INTO deal_financials (tenant_id, deal_id, gross_commission_cents, commission_status, updated_by_user_id) VALUES ($1, $2, $3, 'estimated', $4)`,
      [tenantId, id, f.commissionCents, f.owner.userId],
    );
  }
  return id;
}

/** Appends a backdated stage entry (the forecast's samples) without moving the deal. */
export async function history(h: ApiHarness, tenantId: string, dealId: string, toStage: string, at: Date): Promise<void> {
  await h.su.query(`INSERT INTO deal_stage_history (tenant_id, deal_id, to_stage, actor_kind, changed_at) VALUES ($1, $2, $3, 'system', $4)`, [tenantId, dealId, toStage, at]);
}

export const ago = (days: number) => new Date(Date.now() - days * DAY);

/** The tenant's "YYYY-MM" for an instant. */
export function ym(d: Date, z: string): string {
  return localDateOf(instant(d.getTime()), zone(z)).slice(0, 7);
}

/** Monday 00:05 of the current ISO week in `z` (never after the real now except in that first 5 minutes). */
export function thisMonday(z: string, plusDays = 0): Instant {
  const today = localDateOf(instant(Date.now()), zone(z));
  return instant(midnight(addDaysLocal(mondayOf(today), plusDays), zone(z)) + 5 * 60_000);
}

/** Runs the hourly reconcile of one tenant at `now` as the system actor (timer). */
export async function runWeeklyPlan(h: ApiHarness, tenantId: string, now: Instant) {
  return withTenantTx(systemActor(tenantId as TenantId, 'timer'), (tx) => reconcileWeeklyPlans(tx, systemActor(tenantId as TenantId, 'timer'), h.app.platform.ids, now), { db: h.database });
}
