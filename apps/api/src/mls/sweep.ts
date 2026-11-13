// mls.compliance_sweep (PHASE2_3_PLAN §5.4 #24; R-MLS-2, R-MLS-3, R-MLS-5; E81, E85, E86).
//
// A per-tenant pass (every 5 min, system actor) that keeps what clients could receive in line with the
// licence and the feed, independently of whether a sync ran:
//   1. E85 / R-MLS-3: a live connection whose feed is stale is marked degraded (MLS_FEED_STALE); the UI
//      says "MLS data as of …". (A successful sync recovers it.)
//   2. E86 / R-MLS-2 / R-MLS-3: alerts not yet dispatched whose digest holds MLS data that may no longer
//      reach a client are canceled and their matches released (assistant/searches.ts, under the contact lock).
//   3. E81 / R-MLS-5: an mls row whose number is now a team listing's is linked to it (team row authoritative).
//   (module 71, D9 V2-A, E612) a shared CMA's queued email is canceled when the CMA's readiness fails (cma/sweep.ts).
// Idempotent; touches nothing but codes and links.
import type { Instant } from '@realty/core/foundation';
import { feedStale } from '@realty/core/listings';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { audit, redactDiff } from '../audit.js';
import { cancelIneligibleMlsAlertsInTx } from '../assistant/searches.js';
import { cancelIneligibleCmaSharesInTx } from '../cma/sweep.js';
import type { SystemActor } from '@realty/core/foundation';
import { mlsConnections } from './eligibility.js';

export interface SweepResult {
  degraded: string[];
  canceledAlerts: number;
  /** module 71 (D9 V2-A): queued CMA share emails canceled because the CMA's readiness fails (E612) */
  canceledCmaShares: number;
  mirrorsLinked: number;
}

export async function complianceSweepInTx(tx: Tx, actor: SystemActor, now: Instant): Promise<SweepResult> {
  const degraded: string[] = [];
  for (const c of await mlsConnections(tx)) {
    if (c.status !== 'connected' || !feedStale(c.lastSyncedAt, now, c.pack)) continue;
    const u = await sql<{ id: string }>`
      UPDATE integration_connections SET status = 'degraded', status_reason = 'MLS_FEED_STALE', last_error_code = 'MLS_FEED_STALE'
       WHERE tenant_id = app.tenant_id() AND id = ${c.id} AND status = 'connected' RETURNING id`.execute(tx);
    if (u.rows.length === 0) continue;
    degraded.push(c.id);
    await audit(tx, actor, { action: 'integration.changed', entity: { type: 'integration_connection', id: c.id }, changes: redactDiff({ status: 'connected' }, { status: 'degraded' }), reason: 'MLS_FEED_STALE' });
  }
  const canceled = await cancelIneligibleMlsAlertsInTx(tx, now);
  const canceledCmaShares = await cancelIneligibleCmaSharesInTx(tx, now);
  const linked = await sql`
    UPDATE listings m SET team_listing_id = t.id
      FROM listings t
     WHERE m.tenant_id = app.tenant_id() AND t.tenant_id = m.tenant_id AND m.source = 'mls' AND m.team_listing_id IS NULL
       AND t.source = 'team' AND t.mls_number = m.mls_number`.execute(tx);
  return { degraded, canceledAlerts: canceled.length, canceledCmaShares: canceledCmaShares.length, mirrorsLinked: Number(linked.numAffectedRows ?? 0n) };
}
