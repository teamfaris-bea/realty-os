// Test world of module 53 (imported by gbp/*.test.ts only). Everything goes through the real server as app_user and
// the real OAuth callback (the system links the location); the provider side is the deterministic FakeGbp. `h.su` is
// used only for platform data (counsel's review of a pack), stored instants a test moves, and read-back.
import { randomUUID } from 'node:crypto';
import { withTenantTx } from '@realty/db';
import type { ApiHarness, TestClient } from '../../auth/testHarness.js';
import { call } from '../../admin/testing.js';
import { connectFlow } from '../../integrations/testing.js';
import { leadsWorld } from '../../leads/testing.js';
import type { StandaloneJobContext } from '../../worker/types.js';
import { systemActor } from '../../worker/systemActor.js';
import type { GbpSyncDeps } from '../sync.js';
import type { FakeGbp } from '../testing.js';

export { call };

/** D11's six packs: DEPLOY's D11 command since 0091 (platform:portal is not recorded by it; Q-PORTAL-19). */
export const D11 = ['platform:fair_housing', 'platform:coaching', 'platform:gmail', 'platform:voice', 'platform:avm', 'platform:review_requests'];

export interface GbpWorld {
  owner: TestClient;
  admin: TestClient;
  agent: TestClient;
  teamLead: TestClient;
  tenantId: string;
  location: { connectionId: string; accountId: string };
}

/** Counsel's review of platform packs (platform data, no application path; R-INT-6). */
export async function setPacks(h: ApiHarness, keys: readonly string[], reviewed: boolean): Promise<void> {
  await h.su.query(`UPDATE jurisdiction_packs SET reviewed_by_counsel_at = ${reviewed ? 'now()' : 'NULL'} WHERE key = ANY($1::text[]) AND status = 'published'`, [[...keys]]);
}
export const resetPacks = (h: ApiHarness) => h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL WHERE key LIKE 'platform:%'");

export async function connectLocation(h: ApiHarness, owner: TestClient, name = 'Example Realty Team location'): Promise<{ connectionId: string; accountId: string }> {
  const accountId = `loc-${randomUUID()}`;
  const f = await connectFlow(h, owner, 'gbp_location', { externalAccountId: accountId, displayName: name }, [{ id: accountId }]);
  if (f.cb.result !== 'CONNECTED') throw new Error(`connect gbp: ${f.cb.result}`);
  return { connectionId: f.connectionId, accountId };
}

export async function gbpWorld(h: ApiHarness): Promise<GbpWorld> {
  const w = await leadsWorld(h, { agents: 1, teamLead: true });
  const admin = await h.invite(w.owner, 'admin');
  const location = await connectLocation(h, w.owner);
  return { owner: w.owner, admin, agent: w.agents[0]!, teamLead: w.teamLead!, tenantId: w.tenantId, location };
}

export function jobCtx(h: ApiHarness, tenantId: string): StandaloneJobContext {
  const actor = systemActor(tenantId, 'provider');
  return {
    actor,
    now: Date.now() as never,
    providers: h.providers,
    job: { id: 1n, kind: 'gbp.reconcile', attempt: 1 } as never,
    log: { info: () => undefined, warn: () => undefined, error: () => undefined } as never,
    alerts: { raise: async () => undefined } as never,
    withTx: (fn) => withTenantTx(actor, fn, { db: h.database }),
  };
}

export const syncDeps = (h: ApiHarness, gbp: GbpSyncDeps['gbp'] = h.providers.gbp): GbpSyncDeps => ({ envelope: h.app.platform.envelope, ids: h.app.platform.ids, gbp });

/** Make every location of the tenant due now (its stored next_sync_at is moved; R-OWN-27). */
export const makeDue = (h: ApiHarness, tenantId: string) => h.su.query("UPDATE integration_connections SET next_sync_at = NULL WHERE tenant_id = $1 AND kind = 'gbp_location'", [tenantId]);

export interface ReviewDbRow {
  id: string;
  external_review_id: string;
  rating: number | null;
  body: string | null;
  reviewer_display: string | null;
  reply_status: string;
  reply_action_id: string | null;
}
export async function reviewRows(h: ApiHarness, connectionId: string): Promise<ReviewDbRow[]> {
  return (await h.su.query<ReviewDbRow>('SELECT id, external_review_id, rating, body, reviewer_display, reply_status, reply_action_id FROM gbp_reviews WHERE connection_id = $1 ORDER BY external_review_id', [connectionId])).rows;
}

export function resetFake(f: FakeGbp): void {
  f.pageSize = 50;
  f.failPage = null;
  f.nextReply = 'replied';
  f.replyAppliesOnTimeout = true;
  f.nextPublish = 'published';
  f.deletion = 'supported';
  f.beforeReply = null;
  f.replies.length = 0;
  f.calls.length = 0;
  f.listed.length = 0;
}

/** another tenant (Owner only) */
export const leadsWorldFor = (h: ApiHarness) => leadsWorld(h, { agents: 1 });
