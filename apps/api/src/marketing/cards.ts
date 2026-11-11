// Feed cards of module 29 under its own key family `marketing:{piece}` (module 18a; core/priority keys.ts), for the
// listing agent: "Marketing to review" while a piece version is a draft, and "Remove the post yourself" when the
// system could not take an external post down (R-MKT-4, R-MKT-9, R-MKT-12). Written by the SYSTEM in its own
// transaction (a Team Lead or Owner acting on an agent's listing may not write the agent's feed under RLS). The
// scorer never produces this key family, so it never updates or closes these rows (workspace/feed.ts).
import type { IdGenerator } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { targetWord } from './decide.js';

const KIND_WORD: Record<string, string> = {
  website_page: 'listing page',
  social_post: 'social post',
  open_house_invite: 'open-house invite',
  flyer: 'flyer',
  marketplace_export: 'Marketplace listing',
  gbp_post: 'Business Profile post',
};

async function upsertCard(tx: Tx, ids: IdGenerator, c: { userId: string; pieceId: string; score: number; reasons: { code: string; text: string }[]; merge?: boolean }): Promise<void> {
  if (c.merge) {
    // remove-it-yourself reasons accumulate (one per post the system could not take down); the review reason goes
    await sql`
      INSERT INTO priority_feed_items (tenant_id, id, user_id, item_type, band, contact_id, subject_type, subject_id, score, reasons, dedupe_key)
      VALUES (app.tenant_id(), ${ids.next<'FeedItemId'>()}, ${c.userId}, 'marketing_review', 'scored', NULL, 'marketing_piece', ${c.pieceId},
              ${c.score}, ${JSON.stringify(c.reasons)}::jsonb, ${`marketing:${c.pieceId}`})
      ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE state IN ('open','snoozed') DO UPDATE SET
        reasons = (SELECT jsonb_agg(x) FROM (SELECT DISTINCT ON (x->>'code') x FROM jsonb_array_elements(priority_feed_items.reasons || EXCLUDED.reasons) x
                    WHERE x->>'code' LIKE 'REMOVE_POST_YOURSELF:%' ORDER BY x->>'code') y),
        score = GREATEST(priority_feed_items.score, EXCLUDED.score), updated_at = now()`.execute(tx);
    return;
  }
  await sql`
    INSERT INTO priority_feed_items (tenant_id, id, user_id, item_type, band, contact_id, subject_type, subject_id, score, reasons, dedupe_key)
    VALUES (app.tenant_id(), ${ids.next<'FeedItemId'>()}, ${c.userId}, 'marketing_review', 'scored', NULL, 'marketing_piece', ${c.pieceId},
            ${c.score}, ${JSON.stringify(c.reasons)}::jsonb, ${`marketing:${c.pieceId}`})
    ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE state IN ('open','snoozed') DO UPDATE SET reasons = EXCLUDED.reasons, score = EXCLUDED.score, updated_at = now()`.execute(tx);
}

/**
 * Makes the review cards of one listing match its drafts (as the system): an open card for every draft version, for
 * the listing agent; the card of a version that is no longer a draft is closed (unless it carries a remove-it-yourself
 * reason, which only the agent closes).
 */
export async function syncReviewCards(tx: Tx, ids: IdGenerator, listingId: string): Promise<void> {
  const r = await sql<{ id: string; kind: string; status: string; agent: string | null }>`
    SELECT mp.id, mp.kind, mp.status, l.listing_agent_user_id AS agent FROM marketing_pieces mp
      JOIN listings l ON l.tenant_id = mp.tenant_id AND l.id = mp.listing_id
     WHERE mp.tenant_id = app.tenant_id() AND mp.listing_id = ${listingId}`.execute(tx);
  for (const p of r.rows) {
    if (p.status === 'draft' && p.agent) {
      await upsertCard(tx, ids, { userId: p.agent, pieceId: p.id, score: 40, reasons: [{ code: 'MARKETING_TO_REVIEW', text: `A ${KIND_WORD[p.kind] ?? 'piece'} is ready for you to review and approve` }] });
    } else if (p.status !== 'draft') {
      await closeReviewCard(tx, p.id);
    }
  }
}

/** Closes the review card of a piece (it was approved or replaced), keeping remove-it-yourself cards open. */
export async function closeReviewCard(tx: Tx, pieceId: string): Promise<void> {
  await sql`UPDATE priority_feed_items SET state = 'done', resolved_at = now(), snoozed_until = NULL, updated_at = now()
             WHERE tenant_id = app.tenant_id() AND dedupe_key = ${`marketing:${pieceId}`} AND state IN ('open','snoozed')
               AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(reasons) x WHERE x->>'code' LIKE 'REMOVE_POST_YOURSELF:%')`.execute(tx);
}

/** The system could not take an external post down: tell the listing agent to remove it themselves. Idempotent. */
export async function raiseRemoveYourselfCard(tx: Tx, deps: { ids: IdGenerator }, c: { pieceId: string; publicationId: string; targetKind: string; targetName: string }): Promise<void> {
  const r = await sql<{ agent: string | null }>`SELECT l.listing_agent_user_id AS agent FROM marketing_pieces mp JOIN listings l ON l.tenant_id = mp.tenant_id AND l.id = mp.listing_id
     WHERE mp.tenant_id = app.tenant_id() AND mp.id = ${c.pieceId}`.execute(tx);
  const agent = r.rows[0]?.agent;
  if (!agent) return;
  const code = `REMOVE_POST_YOURSELF:${c.publicationId}`;
  const seen = await sql<{ n: number }>`SELECT count(*)::int AS n FROM priority_feed_items f, jsonb_array_elements(f.reasons) x
     WHERE f.tenant_id = app.tenant_id() AND f.dedupe_key = ${`marketing:${c.pieceId}`} AND x->>'code' = ${code}`.execute(tx);
  if ((seen.rows[0]?.n ?? 0) > 0) return;
  const word = targetWord(c.targetKind);
  // a review card that is still open for this piece is replaced by the remove card (the piece is no longer a draft)
  await upsertCard(tx, deps.ids, {
    userId: agent,
    pieceId: c.pieceId,
    score: 70,
    reasons: [{ code, text: `Remove the post from your ${word} "${c.targetName}" yourself: we could not take it down from here` }],
    merge: true,
  });
}

/** Whether a remove-it-yourself card was ever raised for this publication (the reconcile handler asks once). */
export async function removeYourselfRaised(tx: Tx, pieceId: string, publicationId: string): Promise<boolean> {
  const r = await sql<{ n: number }>`SELECT count(*)::int AS n FROM priority_feed_items f, jsonb_array_elements(f.reasons) x
     WHERE f.tenant_id = app.tenant_id() AND f.dedupe_key = ${`marketing:${pieceId}`} AND x->>'code' = ${`REMOVE_POST_YOURSELF:${publicationId}`}`.execute(tx);
  return (r.rows[0]?.n ?? 0) > 0;
}
