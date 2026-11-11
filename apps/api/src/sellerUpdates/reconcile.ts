// seller_updates.reconcile: module 28's per-tenant reconcile handler (R-OWN-27, R-SELL-1), every 5 min, as the
// system actor in one transaction.
//
// The timer is the stored instant listings.seller_update_next_due_at (team listings only, 0018 CHECK); this
// pass is the only writer of it:
//   1. arm     an active team listing with a seller contact and no instant gets one: now (its first update
//              covers the last cadence days);
//   2. disarm  a listing that is no longer active, has no seller contact left, or a tenant with cadence 0
//              loses its instant (nothing is assembled for it);
//   3. retire  an unsent draft whose listing is no longer active is superseded, one whose listing changed
//              agent is invalidated (only the listing's own agent sends its update); their cards close;
//   4. due     each listing whose instant is due gets the draft of the period ending at that instant (missed
//              periods are skipped to the latest one, never a burst), older unsent drafts are superseded,
//              the listing agent's feed card is written, and the instant moves one cadence later, fenced on
//              the value read (a concurrent pass cannot double-advance it). The dedupe key makes a retry of the
//              same period a no-op.
// Assembly reads everything as the system: what reaches the seller is decided again, under the agent's own
// RLS and the send-time gate, when the agent taps Send.
import type { IdGenerator, Instant } from '@realty/core/foundation';
import { toIso } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import type { EnvelopeService } from '../crypto/envelope.js';
import { assemble, nextDueAfter, periodEndingAt, sellerContacts, tenantCadence } from './assembly.js';
import { channelFor } from './recipients.js';
import { closeDraft, insertDraft, upsertCard } from './store.js';

export const RECONCILE_BATCH = 200;

export interface ReconcileEnv {
  envelope: EnvelopeService;
  tenantId: string;
  ids: IdGenerator;
}

export interface ReconcileResult {
  armed: number;
  disarmed: number;
  retired: number;
  drafted: number;
}

const HAS_SELLER = sql`EXISTS (SELECT 1 FROM listing_contacts lc JOIN contacts c ON c.tenant_id = lc.tenant_id AND c.id = lc.contact_id
                               WHERE lc.tenant_id = l.tenant_id AND lc.listing_id = l.id AND lc.role IN ('seller','co_seller')
                                 AND c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL)`;

export async function reconcileSellerUpdates(tx: Tx, env: ReconcileEnv, now: Instant): Promise<ReconcileResult> {
  const cad = await tenantCadence(tx);
  const nowIso = toIso(now);
  const disarmed = await sql<{ id: string }>`
    UPDATE listings l SET seller_update_next_due_at = NULL
     WHERE l.tenant_id = app.tenant_id() AND l.seller_update_next_due_at IS NOT NULL
       AND (${cad.cadenceDays} = 0 OR l.status <> 'active' OR NOT ${HAS_SELLER})
    RETURNING l.id`.execute(tx);
  const armed =
    cad.cadenceDays === 0
      ? { rows: [] }
      : await sql<{ id: string }>`
    UPDATE listings l SET seller_update_next_due_at = ${nowIso}::timestamptz
     WHERE l.tenant_id = app.tenant_id() AND l.source = 'team' AND l.status = 'active' AND l.seller_update_next_due_at IS NULL AND ${HAS_SELLER}
    RETURNING l.id`.execute(tx);

  // unsent drafts that no longer apply
  const stale = await sql<{ id: string; why: 'superseded' | 'invalidated' }>`
    SELECT a.id, CASE WHEN l.listing_agent_user_id IS DISTINCT FROM a.owner_user_id THEN 'invalidated' ELSE 'superseded' END AS why
      FROM assistant_actions a
      JOIN listings l ON l.tenant_id = a.tenant_id AND l.id = (a.trigger_ref->>'listing_id')::uuid
     WHERE a.tenant_id = app.tenant_id() AND a.kind = 'seller_update_draft' AND a.status = 'proposed' AND a.trigger_ref ? 'listing_id'
       AND (l.status <> 'active' OR l.listing_agent_user_id IS DISTINCT FROM a.owner_user_id)`.execute(tx);
  for (const s of stale.rows) await closeDraft(tx, s.id, s.why, now);

  let drafted = 0;
  if (cad.cadenceDays > 0) {
    const due = await sql<{ id: string; address_line1: string; listing_agent_user_id: string; due: Date }>`
      SELECT l.id, l.address_line1, l.listing_agent_user_id, l.seller_update_next_due_at AS due FROM listings l
       WHERE l.tenant_id = app.tenant_id() AND l.seller_update_next_due_at IS NOT NULL AND l.seller_update_next_due_at <= ${nowIso}::timestamptz
       ORDER BY l.seller_update_next_due_at, l.id LIMIT ${RECONCILE_BATCH} FOR UPDATE OF l SKIP LOCKED`.execute(tx);
    for (const l of due.rows) {
      const stored = l.due.getTime() as Instant;
      // skip missed periods: the latest period that has ended by now
      let end = stored;
      for (let next = nextDueAfter(end, cad); next <= now; next = nextDueAfter(end, cad)) end = next;
      const period = periodEndingAt(end, cad);
      const sellers = await sellerContacts(tx, l.id);
      if (sellers.length > 0) {
        const older = await sql<{ id: string }>`
          SELECT id FROM assistant_actions WHERE tenant_id = app.tenant_id() AND kind = 'seller_update_draft' AND status = 'proposed'
             AND trigger_ref->>'listing_id' = ${l.id} AND trigger_ref->>'period_key' <> ${period.key}`.execute(tx);
        for (const o of older.rows) await closeDraft(tx, o.id, 'superseded', now);
        const a = await assemble(tx, l.id, period, now);
        const id = env.ids.next<'AssistantActionId'>();
        const created = await insertDraft(tx, env, { id, ownerUserId: l.listing_agent_user_id, listingId: l.id, address: l.address_line1, period, a, channel: await channelFor(tx, sellers[0]!.contactId) });
        if (created) {
          drafted++;
          await upsertCard(tx, env.ids, { userId: l.listing_agent_user_id, listingId: l.id, periodKey: period.key, actionId: id, address: l.address_line1, label: period.label });
        }
      }
      await sql`UPDATE listings SET seller_update_next_due_at = ${toIso(nextDueAfter(end, cad))}::timestamptz
                 WHERE tenant_id = app.tenant_id() AND id = ${l.id} AND seller_update_next_due_at = ${toIso(stored)}::timestamptz`.execute(tx);
    }
  }
  return { armed: armed.rows.length, disarmed: disarmed.rows.length, retired: stale.rows.length, drafted };
}
