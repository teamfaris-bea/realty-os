// A team listing whose listing agent is no longer an active member (b7 ownership-data/F2; DATA_MODEL R-SELL-1,
// R-MKT-4, R-OWN-22). Staged deactivation moves the member's open team listings (R-OWN-22 E540), but a suspended
// agent keeps theirs, and so can a listing reopened after its agent left. Only the listing agent sends its seller update and
// reviews its marketing, so such a listing's seller updates and marketing cards would go to someone who can no longer act.
//
// Instead, the seller-update reconcile and the marketing card writers skip the agent and raise ONE card per listing
// (key `seller_update:{listing}:agent-inactive`, item type seller_update, "Open listing") to every active Owner and
// Admin, naming the listing; an Owner/Admin then changes the listing's agent (PATCH /listings/:id/agent,
// listing.reassign, audited). The seller-update reconcile closes the card once the listing has an active agent again.
// Everything here runs as the system (a feed row of another user is not writable under the caller's RLS).
import type { IdGenerator, Instant } from '@realty/core/foundation';
import { toIso } from '@realty/core/foundation';
import { sellerUpdateFeedKey } from '@realty/core/priority';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

/** The period part of the card's key (the seller_update family's third part). */
export const AGENT_INACTIVE_KEY_PART = 'agent-inactive';

export const listingAgentInactiveKey = (listingId: string): string => sellerUpdateFeedKey(listingId as never, AGENT_INACTIVE_KEY_PART);

/** SQL: the listing `l` has a listing agent who is an active member of the tenant. */
export const LISTING_AGENT_ACTIVE = sql`EXISTS (SELECT 1 FROM memberships ms WHERE ms.tenant_id = l.tenant_id AND ms.user_id = l.listing_agent_user_id AND ms.status = 'active')`;

export interface ListingAgentFacts {
  listingId: string;
  address: string;
  agentUserId: string | null;
  agentActive: boolean;
}

export async function listingAgentFacts(tx: Tx, listingId: string): Promise<ListingAgentFacts | null> {
  const r = await sql<{ id: string; address_line1: string; agent: string | null; active: boolean }>`
    SELECT l.id, l.address_line1, l.listing_agent_user_id AS agent, ${LISTING_AGENT_ACTIVE} AS active
      FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.id = ${listingId}`.execute(tx);
  const x = r.rows[0];
  return x ? { listingId: x.id, address: x.address_line1, agentUserId: x.agent, agentActive: x.active } : null;
}

/** The active Owners and Admins, who can change a listing's agent. */
export async function activeOwnersAndAdmins(tx: Tx): Promise<string[]> {
  const r = await sql<{ user_id: string }>`
    SELECT user_id FROM memberships WHERE tenant_id = app.tenant_id() AND role IN ('owner','admin') AND status = 'active' ORDER BY role = 'owner' DESC, user_id`.execute(tx);
  return r.rows.map((x) => x.user_id);
}

/** One open card per listing for each active Owner/Admin: the listing has no active agent (idempotent). */
export async function raiseListingAgentInactiveCard(tx: Tx, ids: IdGenerator, l: { listingId: string; address: string }): Promise<void> {
  const reasons = [
    {
      code: 'LISTING_AGENT_INACTIVE',
      label: `${l.address} has no active listing agent. Change the listing's agent so its seller updates and marketing reviews reach someone who can act on them`,
    },
  ];
  const key = listingAgentInactiveKey(l.listingId);
  for (const userId of await activeOwnersAndAdmins(tx)) {
    // a card the user closed stays closed until the listing had an active agent again (a condition close after it)
    await sql`
      INSERT INTO priority_feed_items (tenant_id, id, user_id, item_type, band, contact_id, subject_type, subject_id, due_at, score, score_version, reasons, dedupe_key)
      SELECT app.tenant_id(), ${ids.next<'FeedItemId'>()}, ${userId}, 'seller_update', 'scored', NULL, 'listing', ${l.listingId}, NULL, 60, 1,
             ${JSON.stringify(reasons)}::jsonb, ${key}
       WHERE NOT EXISTS (SELECT 1 FROM priority_feed_items d
                          WHERE d.tenant_id = app.tenant_id() AND d.user_id = ${userId} AND d.dedupe_key = ${key} AND d.resolved_by = 'user'
                            AND NOT EXISTS (SELECT 1 FROM priority_feed_items c
                                             WHERE c.tenant_id = d.tenant_id AND c.user_id = d.user_id AND c.dedupe_key = d.dedupe_key
                                               AND c.resolved_by = 'condition' AND c.resolved_at > d.resolved_at))
      ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE state IN ('open','snoozed') DO UPDATE SET reasons = EXCLUDED.reasons, updated_at = now()`.execute(tx);
  }
}

/** Closes the cards of listings that have an active agent again (the seller-update reconcile calls it every pass). */
export async function closeResolvedAgentInactiveCards(tx: Tx, now: Instant): Promise<number> {
  const r = await sql`
    UPDATE priority_feed_items f SET state = 'done', snoozed_until = NULL, resolved_by = 'condition', resolved_at = ${toIso(now)}::timestamptz, updated_at = now()
      FROM listings l
     WHERE f.tenant_id = app.tenant_id() AND f.item_type = 'seller_update' AND f.subject_type = 'listing'
       AND f.dedupe_key = 'seller_update:' || l.id::text || ':' || ${AGENT_INACTIVE_KEY_PART}::text
       AND f.state IN ('open','snoozed') AND l.tenant_id = f.tenant_id AND l.id = f.subject_id
       AND (${LISTING_AGENT_ACTIVE} OR l.source <> 'team' OR l.status IN ('sold','withdrawn','expired'))`.execute(tx);
  return Number(r.numAffectedRows ?? 0);
}
