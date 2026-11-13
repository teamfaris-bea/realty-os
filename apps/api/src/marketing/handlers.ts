// Job handlers of module 29 (registered in worker/handlers/index.ts by one additive line).
//
//   marketing.reconcile   per tenant, every 5 minutes (R-OWN-27: woken by its own stored state, not a timer per row):
//     1. publications: a stale 'publishing' becomes 'unknown'; every 'unknown' is LOOKED UP at the provider and recorded
//        published / failed, or left unknown (VERIFY: lookup without a post id). Never re-posted (E227).
//     2. R-MKT-9 / E91: a listing that went sold, withdrawn or expired: unsent invites (queued/scheduled messages of its
//        pieces) are canceled; its external posts are retracted by the system after the provider confirmed the deletion,
//        otherwise the agent gets a "remove it yourself" card (asked once per post). Its page answers 410 by itself
//        (app.public_listing_page) and exports are flagged "may be out of date" (core exportBundle).
//     3. R-MKT-4: live (approved/published/exported) versions are re-rendered with the current identity and packs; one
//        that no longer passes is taken down from pages we control (a page → 'retracted', final: it needs a new version)
//        within the hour, and its external posts are retracted as in 2.
//     4. R-MKT-12 (0054): a retraction whose process died after it claimed the post (a person's tap or a pass of its
//        own) is finished once its claim is older than app.marketing_retract_claim_window(), whatever the listing.
import { liveRecheck } from '@realty/core/marketing';
import type { IdGenerator, SystemActor } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import type { z } from 'zod';
import { loadConfig } from '../config.js';
import { commsRuntime } from '../comms/runtime.js';
import { audit, redactSnapshot } from '../audit.js';
import { jobPayload } from '../worker/payload.js';
import type { JobHandler, StandaloneJobContext, StandaloneJobHandler } from '../worker/types.js';
import { syncReviewCards } from './cards.js';
import { type PublishDeps, reconcilePublications, retractPublication } from './publish.js';
import * as repo from './repo.js';

export const MARKETING_RECONCILE_KIND = 'marketing.reconcile' as const;
export const MARKETING_RECONCILE_EVERY_MS = 5 * 60_000;

const Empty = jobPayload({});
type DepsFor = (ctx: StandaloneJobContext) => PublishDeps;

const defaultDeps: DepsFor = (ctx) => {
  const r = commsRuntime();
  const cfg = loadConfig();
  return { db: r.db, envelope: r.envelope, ids: r.ids, social: ctx.providers.integrations.social, gbp: ctx.providers.gbp, publicBaseUrl: cfg.publicBaseUrl, linkSecret: cfg.sessionSecret };
};

export interface ReconcileSummary {
  looked: number;
  published: number;
  failed: number;
  invitesCanceled: number;
  retracted: number;
  removeYourself: number;
  /** posts another retraction is taking down right now: left to it (a later pass finishes one whose process died) */
  inProgress: number;
  pagesTakenDown: number;
}

/** One reconcile pass for the job's tenant (exported for tests). */
export async function reconcileMarketing(ctx: StandaloneJobContext, deps: PublishDeps): Promise<ReconcileSummary> {
  const tenantId = ctx.actor.tenantId;
  const pubs = await reconcilePublications(deps, tenantId);
  const out: ReconcileSummary = { ...pubs, invitesCanceled: 0, retracted: 0, removeYourself: 0, inProgress: 0, pagesTakenDown: 0 };

  // 2 + 3: what must come down. Separate transactions, so an unavailable pack (3) never undoes the invite cancellations (2).
  const canceled = await ctx.withTx((tx) => cancelOffMarketInvites(tx));
  let down = { failingPieceIds: [] as string[], pagesTakenDown: 0 };
  try {
    down = await ctx.withTx((tx) => takeDownFailingPages(tx, deps.ids, ctx.actor));
  } catch (e) {
    ctx.log.warn('marketing.reconcile live re-check failed', { code: e instanceof Error ? e.message.slice(0, 60) : 'unknown' });
  }
  const work = await ctx.withTx(async (tx) => {
    // live or possibly-live posts ('unknown' may be up) of off-market listings and failing versions that were not yet
    // retracted or handed to the agent as "remove it yourself" (filtered before the limit, so older ones never block);
    // and (0054) any post whose retraction claim outlived the window: someone asked for it to come down and that
    // process died, so the stored request is finished whatever the listing (once: the claim is cleared or released)
    const posts = await sql<{ id: string }>`
      SELECT p.id FROM marketing_publications p
        JOIN marketing_pieces mp ON mp.tenant_id = p.tenant_id AND mp.id = p.piece_id
        JOIN listings l ON l.tenant_id = mp.tenant_id AND l.id = mp.listing_id
       WHERE p.tenant_id = app.tenant_id() AND p.status IN ('published','unknown')
         AND ((p.status = 'published' AND p.retract_claim_id IS NOT NULL AND p.retract_claimed_at < now() - app.marketing_retract_claim_window())
              OR ((l.status IN ('sold','withdrawn','expired') OR mp.id = ANY (${down.failingPieceIds}::uuid[]))
                  AND NOT EXISTS (SELECT 1 FROM priority_feed_items f, jsonb_array_elements(f.reasons) x
                                   WHERE f.tenant_id = p.tenant_id AND f.dedupe_key = 'marketing:' || p.piece_id::text
                                     AND x->>'code' = 'REMOVE_POST_YOURSELF:' || p.id::text)))
       ORDER BY p.requested_at LIMIT 50`.execute(tx);
    return { canceled, pagesTakenDown: down.pagesTakenDown, todo: posts.rows.map((r) => r.id) };
  });
  out.invitesCanceled = work.canceled;
  out.pagesTakenDown = work.pagesTakenDown;
  for (const id of work.todo) {
    const r = await retractPublication(deps, tenantId, id, null);
    if (r.outcome === 'retracted') out.retracted += 1;
    if (r.outcome === 'remove_yourself') out.removeYourself += 1;
    if (r.outcome === 'in_progress') out.inProgress += 1;
  }
  return out;
}

/** R-MKT-9: unsent invites of an off-market listing are canceled (never sent later). */
async function cancelOffMarketInvites(tx: Tx): Promise<number> {
  const r = await sql<{ id: string }>`
    UPDATE messages m SET status = 'canceled', status_reason = 'LISTING_OFF_MARKET'
      FROM marketing_pieces mp JOIN listings l ON l.tenant_id = mp.tenant_id AND l.id = mp.listing_id
     WHERE m.tenant_id = app.tenant_id() AND m.marketing_piece_id = mp.id AND mp.tenant_id = m.tenant_id
       AND m.status IN ('queued','scheduled') AND l.status IN ('sold','withdrawn','expired')
    RETURNING m.id`.execute(tx);
  return r.rows.length;
}

/** R-MKT-4: live versions that no longer pass with the current identity and packs. Pages come down; ids returned. */
async function takeDownFailingPages(tx: Tx, ids: IdGenerator, sys: SystemActor): Promise<{ failingPieceIds: string[]; pagesTakenDown: number }> {
  const live = await sql<repo.PieceRow & { listing_status: string }>`
    SELECT mp.id, mp.listing_id, mp.kind, mp.version_no, mp.status, mp.prose, mp.bound_fields, mp.template_key, mp.content_sha256, mp.guard_result,
           mp.public_slug, mp.open_house, mp.approved_by_user_id, mp.approved_at, mp.published_at, mp.exported_at, mp.retracted_at, mp.created_by_user_id,
           mp.created_at, mp.updated_at, l.status AS listing_status
      FROM marketing_pieces mp JOIN listings l ON l.tenant_id = mp.tenant_id AND l.id = mp.listing_id
     WHERE mp.tenant_id = app.tenant_id() AND mp.status IN ('approved','published','exported') AND l.source = 'team'
     ORDER BY mp.updated_at LIMIT 500`.execute(tx);
  if (live.rows.length === 0) return { failingPieceIds: [], pagesTakenDown: 0 };
  const identity = await repo.identityOf(tx);
  const [advertising, fh] = await Promise.all([repo.advertisingPacks(tx, identity.jurisdictions), repo.fairHousingPack(tx, identity.jurisdictions)]);
  const failing: string[] = [];
  let pages = 0;
  const listings = new Set<string>();
  for (const p of live.rows) {
    const facts = await repo.listingFacts(tx, p.listing_id);
    if (!facts) continue;
    const assets = await repo.assetsOf(tx, p.id);
    const check = liveRecheck(repo.versionOf(p, assets), facts, identity, { advertising }, fh, p.content_sha256);
    if (check.action === 'keep') continue;
    failing.push(p.id);
    if (p.kind === 'website_page' && p.status === 'published') {
      await sql`UPDATE marketing_pieces SET status = 'retracted', retracted_at = now() WHERE tenant_id = app.tenant_id() AND id = ${p.id} AND status = 'published'`.execute(tx);
      await audit(tx, sys, { action: 'marketing.retracted', entity: { type: 'marketing_piece', id: p.id }, changes: redactSnapshot({ kind: p.kind }), reason: 'NO_LONGER_PASSES' });
      pages += 1;
      listings.add(p.listing_id);
    }
  }
  for (const l of listings) await syncReviewCards(tx, ids, l);
  return { failingPieceIds: failing, pagesTakenDown: pages };
}

export function makeMarketingHandlers(depsFor: DepsFor = defaultDeps): JobHandler<unknown>[] {
  const reconcile: StandaloneJobHandler<z.infer<typeof Empty>> = {
    kind: MARKETING_RECONCILE_KIND,
    queue: 'default',
    mode: 'standalone',
    via: 'provider',
    schema: Empty,
    every: { ms: MARKETING_RECONCILE_EVERY_MS, offsetMs: 13_000 },
    periodicPayload: {},
    async run(ctx) {
      const s = await reconcileMarketing(ctx, depsFor(ctx));
      if (s.looked + s.retracted + s.removeYourself + s.inProgress + s.pagesTakenDown + s.invitesCanceled > 0) {
        ctx.log.info('marketing.reconcile', { jobId: ctx.job.id.toString(), code: `looked:${s.looked}:published:${s.published}:failed:${s.failed}:retracted:${s.retracted}:remove:${s.removeYourself}:in_progress:${s.inProgress}:pages:${s.pagesTakenDown}:invites:${s.invitesCanceled}` });
      }
    },
  };
  return [reconcile] as unknown as JobHandler<unknown>[];
}

export const marketingHandlers: JobHandler<unknown>[] = makeMarketingHandlers();
