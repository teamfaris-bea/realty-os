// seller_updates.reconcile: module 28's per-tenant reconcile handler (R-OWN-27, R-SELL-1), every 5 min, as the
// system actor in one transaction.
//
// The timer is the stored instant listings.seller_update_next_due_at (team listings only, 0018 CHECK); this
// pass is the only writer of it:
//   1. arm     an active team listing with a seller contact and no instant gets one: now (its first update
//              covers the last cadence days);
//   2. disarm  a listing that is no longer active, has no seller contact left, or a tenant with cadence 0
//              loses its instant (nothing is assembled for it);
//   3. retire  an unsent draft whose listing is no longer active, or has no seller contact left, is superseded
//              (b7 ownership-data/F1: its explanation says why, it never stays "ready" with nobody to send to); one
//              whose listing changed agent, or whose agent is no longer an active member, is invalidated (only the
//              listing's own agent sends its update); their cards close; for a changed or inactive agent the
//              period's key is freed and the listing woken at the period's end, so the next agent gets the same
//              period's draft in step 4;
//   hold       (b7 ownership-data/F2) a due listing whose agent is not an active member is skipped, not drafted and
//              not advanced, and every active Owner/Admin gets one card naming it (workspace/listingAgent.ts) until
//              an Owner/Admin changes its agent (PATCH /listings/:id/agent); the card closes once it has one;
//   resume     an approved update whose per-seller messages were never queued (the process stopped after the
//              tap) is queued now, each message with its dispatch job (the gate still decides each one);
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
import { LISTING_AGENT_ACTIVE, closeResolvedAgentInactiveCards, raiseListingAgentInactiveCard } from '../workspace/listingAgent.js';
import { channelFor } from './recipients.js';
import { queueApprovedSends } from './service.js';
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
  /** messages queued for approved updates that never got that far */
  resumed: number;
  /** due listings held because their agent is not an active member (b7 ownership-data/F2) */
  held: number;
}

const NO_SELLER_NOTE = ' Not sent: no seller is linked to this listing any more.';
const AGENT_INACTIVE_NOTE = " Not sent: the listing's agent is no longer active on the team.";

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
  const stale = await sql<{ id: string; why: 'superseded' | 'invalidated'; note: string | null }>`
    SELECT a.id, CASE WHEN l.status = 'active' AND (l.listing_agent_user_id IS DISTINCT FROM a.owner_user_id OR NOT ${LISTING_AGENT_ACTIVE}) THEN 'invalidated' ELSE 'superseded' END AS why,
           CASE WHEN l.status <> 'active' THEN NULL
                WHEN l.listing_agent_user_id IS NOT DISTINCT FROM a.owner_user_id AND NOT ${LISTING_AGENT_ACTIVE} THEN ${AGENT_INACTIVE_NOTE}::text
                WHEN l.listing_agent_user_id IS NOT DISTINCT FROM a.owner_user_id AND NOT ${HAS_SELLER} THEN ${NO_SELLER_NOTE}::text END AS note
      FROM assistant_actions a
      JOIN listings l ON l.tenant_id = a.tenant_id AND l.id = (a.trigger_ref->>'listing_id')::uuid
     WHERE a.tenant_id = app.tenant_id() AND a.kind = 'seller_update_draft' AND a.trigger_ref ? 'listing_id'
       -- unsent drafts, and drafts the send path already invalidated whose period key is not yet freed (recent only)
       AND (a.status = 'proposed' OR (a.status = 'invalidated' AND a.dedupe_key NOT LIKE '%:invalidated:%'
                                      AND a.created_at > ${nowIso}::timestamptz - make_interval(days => GREATEST(${cad.cadenceDays}, 1))))
       AND (l.status <> 'active' OR l.listing_agent_user_id IS DISTINCT FROM a.owner_user_id OR NOT ${LISTING_AGENT_ACTIVE} OR NOT ${HAS_SELLER})`.execute(tx);
  for (const s of stale.rows) {
    if (s.note !== null) {
      await sql`UPDATE assistant_actions SET explanation = left(explanation || ${s.note}::text, 300), updated_at = now()
                 WHERE tenant_id = app.tenant_id() AND id = ${s.id} AND status = 'proposed'`.execute(tx);
    }
    await closeDraft(tx, s.id, s.why, now);
    if (s.why === 'invalidated') {
      // the listing changed agent: free the period's key and wake the listing at that period's end, so the due
      // step below drafts the same period for the new agent (the sellers do not miss the week)
      const r = await sql<{ end: string }>`
        UPDATE assistant_actions SET dedupe_key = dedupe_key || ':invalidated:' || id::text
         WHERE tenant_id = app.tenant_id() AND id = ${s.id} AND status = 'invalidated' AND dedupe_key NOT LIKE '%:invalidated:%'
        RETURNING payload->'period'->>'end' AS end`.execute(tx);
      const end = r.rows[0]?.end;
      if (end && cad.cadenceDays > 0) {
        await sql`UPDATE listings l SET seller_update_next_due_at = ${end}::timestamptz
                   WHERE l.tenant_id = app.tenant_id() AND l.id = (SELECT (trigger_ref->>'listing_id')::uuid FROM assistant_actions WHERE tenant_id = app.tenant_id() AND id = ${s.id})
                     AND l.status = 'active' AND ${HAS_SELLER}`.execute(tx);
      }
    }
  }

  // approved updates whose messages were never queued (the process stopped between the tap and the queue): queue
  // them now; each message carries its dispatch job, and the send-time gate still decides each one (D1)
  const unsent = await sql<{ parent: string }>`
    SELECT DISTINCT c.trigger_ref->>'actionId' AS parent FROM assistant_actions c
     WHERE c.tenant_id = app.tenant_id() AND c.kind = 'message_draft' AND c.status IN ('approved','executed')
       AND c.trigger_ref->>'kind' = 'seller_update_send' AND c.created_at > ${nowIso}::timestamptz - interval '7 days'
       AND c.created_at < ${nowIso}::timestamptz - interval '1 minute'
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id = c.tenant_id
                        AND m.idempotency_key = 'seller-update:' || (c.trigger_ref->>'actionId') || ':' || c.contact_id::text)
     LIMIT ${RECONCILE_BATCH}`.execute(tx);
  let resumed = 0;
  for (const u of unsent.rows) resumed += (await queueApprovedSends(tx, env, u.parent, now)).filter((q) => q.created).length;

  // b7 ownership-data/F2: a listing that has an active agent again closes its "no active agent" card
  await closeResolvedAgentInactiveCards(tx, now);

  let drafted = 0;
  let held = 0;
  if (cad.cadenceDays > 0) {
    // due listings whose agent is not an active member: held (no draft for someone who cannot send it, no advance),
    // and the Owners/Admins are told which listing (one card each, kept until the agent changes)
    const holds = await sql<{ id: string; address_line1: string }>`
      SELECT l.id, l.address_line1 FROM listings l
       WHERE l.tenant_id = app.tenant_id() AND l.seller_update_next_due_at IS NOT NULL AND l.seller_update_next_due_at <= ${nowIso}::timestamptz
         AND NOT ${LISTING_AGENT_ACTIVE}
       -- listings nobody has been told about yet first, so more than a batch of held listings all get their card
       ORDER BY EXISTS (SELECT 1 FROM priority_feed_items f WHERE f.tenant_id = l.tenant_id AND f.item_type = 'seller_update' AND f.subject_type = 'listing'
                         AND f.subject_id = l.id AND f.dedupe_key LIKE '%:agent-inactive' AND f.state IN ('open','snoozed')),
                l.seller_update_next_due_at, l.id LIMIT ${RECONCILE_BATCH}`.execute(tx);
    for (const l of holds.rows) await raiseListingAgentInactiveCard(tx, env.ids, { listingId: l.id, address: l.address_line1 });
    held = holds.rows.length;
    const due = await sql<{ id: string; address_line1: string; listing_agent_user_id: string; due: Date }>`
      SELECT l.id, l.address_line1, l.listing_agent_user_id, l.seller_update_next_due_at AS due FROM listings l
       WHERE l.tenant_id = app.tenant_id() AND l.seller_update_next_due_at IS NOT NULL AND l.seller_update_next_due_at <= ${nowIso}::timestamptz
         AND ${LISTING_AGENT_ACTIVE}
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
  return { armed: armed.rows.length, disarmed: disarmed.rows.length, retired: stale.rows.length, drafted, resumed, held };
}
