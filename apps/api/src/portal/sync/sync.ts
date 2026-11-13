// portal.sync (R-PORTAL-15; E410, E656, E658; finding F10, F13): per tenant every 5 minutes, as the system, at most
// PORTAL_SYNC_BATCH rows per step. Never publishes documents, showings, feedback, seller updates or next steps
// (core/portal: the rule path publishes confirmed milestones only).
//   1 retract (as the system: retracted_by_user_id NULL) milestones moved, waived, back to proposed or removed;
//     documents no longer shared and clean, or whose object is gone (E410); next steps whose task is done or canceled
//   2 publish each confirmed milestone of each live deal grant whose (grant, deal date, due_version) has no row at all,
//     unless a person retracted any version of it in that grant (E656)
//   3 store expiry once (F10): closed ⇒ GREATEST(closed_at, granted_at) + 90 days; lost ⇒ GREATEST(now, granted_at +
//     1 s); a listing sold, withdrawn or expired ⇒ now + 90 days (VERIFY WITH COUNSEL, Q-PORTAL-4)
//   4 refresh the contact card when the deal owner, listing agent or team sender changed (audited)
//   5 backstop: final sign-in link messages older than 15 minutes redacted, queued ones canceled
import type { Instant, SystemActor } from '@realty/core/foundation';
import { publishable, renderPortalItem } from '@realty/core/portal';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../../audit.js';
import { linkBackstopInTx } from '../signin/links.js';
import { displayOf } from '../shared/view.js';
import { cardFor, type CardDeps } from '../staff/display.js';
import { sourceFacts } from '../staff/sources.js';
import { PORTAL_SYNC_BATCH } from './jobs.js';

export interface SyncCounts {
  retracted: number;
  published: number;
  expired: number;
  cards: number;
  links: number;
}

async function retractAsSystem(tx: Tx, actor: SystemActor, ids: readonly string[], reason: string): Promise<number> {
  let n = 0;
  for (const id of ids) {
    const r = await sql`UPDATE portal_items SET retracted_at = now() WHERE tenant_id = app.tenant_id() AND id = ${id} AND retracted_at IS NULL`.execute(tx);
    if (Number(r.numAffectedRows ?? 0) === 1) {
      n++;
      await audit(tx, actor, { action: 'portal.item_retracted', entity: { type: 'portal_item', id }, reason });
    }
  }
  return n;
}

async function retractStale(tx: Tx, actor: SystemActor, limit: number): Promise<number> {
  const milestones = await sql<{ id: string }>`
    SELECT i.id FROM portal_items i
      LEFT JOIN deal_dates dd ON dd.tenant_id = i.tenant_id AND dd.id = i.source_id
     WHERE i.tenant_id = app.tenant_id() AND i.retracted_at IS NULL AND i.source_type = 'deal_date'
       AND (dd.id IS NULL OR dd.status <> 'confirmed' OR dd.due_version <> i.source_version)
     ORDER BY i.published_at LIMIT ${limit}`.execute(tx);
  const documents = await sql<{ id: string }>`
    SELECT i.id FROM portal_items i
      LEFT JOIN documents d ON d.tenant_id = i.tenant_id AND d.id = i.document_id
      LEFT JOIN stored_objects o ON o.tenant_id = d.tenant_id AND o.id = d.object_id
     WHERE i.tenant_id = app.tenant_id() AND i.retracted_at IS NULL AND i.kind = 'document'
       AND (d.id IS NULL OR NOT d.shared_to_portal OR d.scan_status <> 'clean' OR o.id IS NULL OR o.deleted_at IS NOT NULL OR o.dek_wrapped IS NULL)
     ORDER BY i.published_at LIMIT ${limit}`.execute(tx);
  const steps = await sql<{ id: string }>`
    SELECT i.id FROM portal_items i LEFT JOIN tasks t ON t.tenant_id = i.tenant_id AND t.id = i.source_id
     WHERE i.tenant_id = app.tenant_id() AND i.retracted_at IS NULL AND i.source_type = 'task'
       AND (t.id IS NULL OR t.status IN ('done','canceled'))
     ORDER BY i.published_at LIMIT ${limit}`.execute(tx);
  return (
    (await retractAsSystem(tx, actor, milestones.rows.map((r) => r.id), 'MILESTONE_CHANGED')) +
    (await retractAsSystem(tx, actor, documents.rows.map((r) => r.id), 'DOCUMENT_NOT_SHARED')) +
    (await retractAsSystem(tx, actor, steps.rows.map((r) => r.id), 'TASK_FINISHED'))
  );
}

async function publishMilestones(tx: Tx, actor: SystemActor, limit: number): Promise<number> {
  const due = await sql<{ grant_id: string; deal_date_id: string }>`
    SELECT g.id AS grant_id, dd.id AS deal_date_id
      FROM portal_grants g
      JOIN portal_accounts a ON a.tenant_id = g.tenant_id AND a.id = g.portal_account_id AND a.status <> 'disabled'
      JOIN deal_dates dd ON dd.tenant_id = g.tenant_id AND dd.deal_id = g.deal_id AND dd.status = 'confirmed'
     WHERE g.tenant_id = app.tenant_id() AND g.deal_id IS NOT NULL AND g.revoked_at IS NULL
       AND (g.expires_at IS NULL OR g.expires_at > now())
       AND app.portal_party_ok(g.tenant_id, g.portal_account_id, g.deal_id, g.listing_id)
       AND NOT EXISTS (SELECT 1 FROM portal_items i WHERE i.tenant_id = g.tenant_id AND i.grant_id = g.id AND i.source_type = 'deal_date'
                          AND i.source_id = dd.id AND (i.source_version = dd.due_version
                               OR (i.retracted_at IS NOT NULL AND i.retracted_by_user_id IS NOT NULL)))
     ORDER BY g.granted_at, dd.due_on LIMIT ${limit}`.execute(tx);
  let n = 0;
  for (const d of due.rows) {
    const facts = await sourceFacts(tx, d.grant_id, 'milestone', d.deal_date_id, 'system');
    if (!facts || !publishable('milestone', facts).ok) continue;
    const spec = renderPortalItem(facts);
    const ins = await sql<{ id: string }>`
      INSERT INTO portal_items (tenant_id, id, grant_id, kind, title, body, occurs_on, document_id, source_type, source_id, source_version,
                                published_by_kind, published_at)
      VALUES (app.tenant_id(), gen_random_uuid(), ${d.grant_id}, ${spec.kind}, ${spec.title}, ${spec.body}, ${spec.occursOn}::date, NULL,
              ${spec.sourceType}, ${spec.sourceId}, ${spec.sourceVersion}, 'system', now())
      ON CONFLICT DO NOTHING RETURNING id`.execute(tx);
    if (ins.rows[0]) {
      n++;
      await audit(tx, actor, { action: 'portal.item_published', entity: { type: 'portal_item', id: ins.rows[0].id }, reason: 'milestone' });
    }
  }
  return n;
}

async function storeExpiry(tx: Tx, limit: number): Promise<number> {
  const deals = await sql`
    UPDATE portal_grants g SET expires_at = CASE WHEN d.stage = 'closed' THEN GREATEST(d.closed_at, g.granted_at) + interval '90 days'
                                                 ELSE GREATEST(now(), g.granted_at + interval '1 second') END
      FROM deals d
     WHERE g.tenant_id = app.tenant_id() AND d.tenant_id = g.tenant_id AND d.id = g.deal_id AND g.expires_at IS NULL
       AND g.revoked_at IS NULL AND (d.stage = 'lost' OR (d.stage = 'closed' AND d.closed_at IS NOT NULL))
       AND g.id IN (SELECT g2.id FROM portal_grants g2 WHERE g2.tenant_id = app.tenant_id() AND g2.expires_at IS NULL AND g2.revoked_at IS NULL
                     AND g2.deal_id IS NOT NULL ORDER BY g2.granted_at LIMIT ${limit})`.execute(tx);
  const listings = await sql`
    UPDATE portal_grants g SET expires_at = now() + interval '90 days'
      FROM listings l
     WHERE g.tenant_id = app.tenant_id() AND l.tenant_id = g.tenant_id AND l.id = g.listing_id AND g.expires_at IS NULL
       AND g.revoked_at IS NULL AND l.status IN ('sold','withdrawn','expired')
       AND g.id IN (SELECT g2.id FROM portal_grants g2 WHERE g2.tenant_id = app.tenant_id() AND g2.expires_at IS NULL AND g2.revoked_at IS NULL
                     AND g2.listing_id IS NOT NULL ORDER BY g2.granted_at LIMIT ${limit})`.execute(tx);
  return Number(deals.numAffectedRows ?? 0) + Number(listings.numAffectedRows ?? 0);
}

async function refreshCards(tx: Tx, actor: SystemActor, deps: CardDeps, limit: number): Promise<number> {
  const live = await sql<{ id: string; display: unknown; contact_id: string; agent: string | null }>`
    SELECT g.id, g.display, a.contact_id, COALESCE(d.owner_user_id, l.listing_agent_user_id) AS agent
      FROM portal_grants g JOIN portal_accounts a ON a.tenant_id = g.tenant_id AND a.id = g.portal_account_id AND a.status <> 'disabled'
      LEFT JOIN deals d ON d.tenant_id = g.tenant_id AND d.id = g.deal_id
      LEFT JOIN listings l ON l.tenant_id = g.tenant_id AND l.id = g.listing_id
     WHERE g.tenant_id = app.tenant_id() AND g.revoked_at IS NULL AND (g.expires_at IS NULL OR g.expires_at > now())
       AND (g.display ? 'agentName' OR g.display ? 'textTo' OR g.display ? 'emailTo')
     ORDER BY g.granted_at LIMIT ${limit}`.execute(tx);
  let n = 0;
  for (const g of live.rows) {
    const cur = displayOf(g.display);
    const next = await cardFor(tx, deps, actor.tenantId, g.contact_id, g.agent);
    const changed = (['agentName', 'textTo', 'emailTo'] as const).filter((k) => (cur[k] ?? null) !== (next[k] ?? null));
    if (changed.length === 0) continue;
    const merged: Record<string, unknown> = { ...(g.display as Record<string, unknown>) };
    for (const k of ['agentName', 'textTo', 'emailTo'] as const) {
      if (next[k]) merged[k] = next[k];
      else delete merged[k];
    }
    await sql`UPDATE portal_grants SET display = ${JSON.stringify(merged)}::jsonb WHERE tenant_id = app.tenant_id() AND id = ${g.id}`.execute(tx);
    await audit(tx, actor, { action: 'portal.display_updated', entity: { type: 'portal_grant', id: g.id }, reason: changed.join(',') });
    n++;
  }
  return n;
}

export async function portalSyncInTx(tx: Tx, actor: SystemActor, deps: CardDeps, _now: Instant, limit = PORTAL_SYNC_BATCH): Promise<SyncCounts> {
  const retracted = await retractStale(tx, actor, limit);
  const published = await publishMilestones(tx, actor, limit);
  const expired = await storeExpiry(tx, limit);
  const cards = await refreshCards(tx, actor, deps, limit);
  const links = await linkBackstopInTx(tx, limit);
  return { retracted, published, expired, cards, links };
}
