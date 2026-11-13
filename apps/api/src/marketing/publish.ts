// publishPost: THE publishing path (module 29; D2; PHASE2_3_PLAN §5.4 #29; DATA_MODEL R-MKT-12, R-GATE-15, R-INT-6;
// E227, E228; ARCHITECTURE §21.11). The only module that calls SocialPublisher (publishPost, lookupPost, deletePost):
// lint realty/no-provider-outbound reserves publishPost / postReviewReply for this file, and architecture.test.ts
// proves no other file calls any of the three. Module 53 adds the gbp_location branch here (flagged edit): deps.gbp publishes, looks up and deletes GBP posts, and
// sendReviewReply posts review replies.
//
//   TX1  as the person who tapped (FORCE RLS): the piece (an approved/published social post) and the target (a
//        connected/degraded facebook_page / instagram_business of the tenant) are re-read; the guard runs once more
//        against the live facts and identity (R-MKT-4); INSERT marketing_publications 'publishing'. The DB guard is the
//        authority: born 'publishing', a person as themselves, the matching kind, a connected account, platform:fair_housing
//        cleared; the one-live-row index refuses a second attempt per piece and target (also while 'unknown': E227)
//   TXk  as the system: the account's token is decrypted (R-INT-4) and short-lived signed URLs for the images are made
//   call SocialPublisher.publishPost, outside any transaction
//   TX2  as the system: 'published' (the provider's post id) | 'failed' (an explicit rejection) | 'unknown' (a timeout
//        or an answer we cannot read). The piece becomes 'published' only after a provider-confirmed post.
//   reconcile (handlers.ts → reconcilePublications): a stale 'publishing' (the process died between TX1 and TX2) becomes
//        'unknown'; an 'unknown' row is looked up at the provider by piece and content (lookupPost) and never posted
//        again; VERIFY: a provider that cannot find a post without its id leaves it 'unknown' ("Check your Page").
//   retract: TX1 as the system claims the retraction (0054 retract_claim_id: one caller per publication calls the
//        provider; another answers 'in_progress'; a claim older than app.marketing_retract_claim_window() is taken
//        again, and the reconcile pass finishes it), then deletePost outside any transaction, waited for at most
//        DELETE_POST_TIMEOUT_MS; TX2 records 'retracted' only after the provider confirmed the deletion (and takes the
//        post off any "remove it yourself" card), otherwise a "remove it yourself" card (marketing:{piece}) for the
//        listing agent.
// The Meta connection is for content publishing only: there is no messaging webhook, so a DM to the Page is never
// received (E228; integrations/catalog.ts requests publishing scopes only).
import { type IdGenerator, type Instant, type TenantId, type UserActor, toIso } from '@realty/core/foundation';
import { guardReasons, guardResult, renderPiece } from '@realty/core/marketing';
import { type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit, redactSnapshot } from '../audit.js';
import type { EnvelopeService } from '../crypto/envelope.js';
import { AppError } from '../errors.js';
import { ProviderError } from '../providers/types.js';
import type { DeleteRequest, OAuthToken, PublishRequest, SocialPublisher } from '../providers/integrations/types.js';
import type { GbpProvider, ReviewReplyRequest } from '../gbp/provider.js';
import { systemActor } from '../worker/systemActor.js';
import type { Database } from '@realty/db';
import { type PublishTargetKind, classifyPublish, errorCodeOf, reconcileFromLookup, retractFromDelete } from './decide.js';
import { type MarketingAssumptions, marketingAssumptions } from './assumptions.js';
import { signedAssetUrl } from './assetLinks.js';
import { clearRemoveYourselfReason, closeReviewCard, raiseRemoveYourselfCard } from './cards.js';
import { mapDbError } from './pieces.js';
import * as repo from './repo.js';

export interface PublishDeps {
  db: Database;
  envelope: EnvelopeService;
  social: SocialPublisher;
  /** module 53: the Google Business Profile adapter (gbp_location targets and review replies). Absent or not configured: GBP_NOT_CONFIGURED */
  gbp?: GbpProvider;
  /** absolute base of this API (signed image URLs the provider fetches, VERIFY: Instagram fetches public URLs) */
  publicBaseUrl: string;
  /** keys the signed asset URLs (HMAC, derived per purpose) */
  linkSecret: Uint8Array;
  ids: IdGenerator;
  /** the VERIFY items (assumptions.ts); default: the process environment's, strict */
  assumptions?: MarketingAssumptions;
  /** tests: how long one deletePost call is waited for; default DELETE_POST_TIMEOUT_MS */
  deleteTimeoutMs?: number;
}

const asSystem = <T>(d: Pick<PublishDeps, 'db'>, tenantId: string, fn: (tx: Tx, now: Instant) => Promise<T>) => withTenantTx(systemActor(tenantId, 'provider'), fn, { db: d.db, retries: 2 });

/** A stuck 'publishing' row (the process died between TX1 and TX2) is treated as unknown after this long. */
export const STALE_PUBLISHING_MS = 5 * 60_000;

/**
 * The longest one deletePost call is waited for; then it counts as failed (the "remove it yourself" card). Well
 * inside app.marketing_retract_claim_window() (5 minutes, 0054): the retract claim holds only while its caller is
 * still waiting, so a stale claim is taken over only from a process that died, never from one still in the provider.
 * The adapter's own request timeout is shorter (SocialPublisher.deletePost).
 */
export const DELETE_POST_TIMEOUT_MS = 60_000;

/** The provider's answer, or ProviderError('timeout') after `ms` (the call itself is not waited for any longer). */
async function withinBound<T>(call: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([call, new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new ProviderError('timeout', 'DELETE_POST_TIMEOUT')), ms)))]);
  } finally {
    clearTimeout(timer);
  }
}

interface Prepared {
  publicationId: string;
  pieceId: string;
  listingId: string;
  target: PublishTargetKind;
  connectionId: string;
  externalAccountId: string;
  credentialId: string;
  contentSha256: string;
  text: string;
  imageObjectIds: string[];
}

/** POST /marketing-pieces/:id/publish {connectionId} for a social post. Returns the publication id. */
export async function publishPost(deps: PublishDeps, actor: UserActor, pieceId: string, connectionId: string): Promise<{ publicationId: string; status: repo.PublicationRow['status'] }> {
  // TX1, as the person who tapped
  const prep = await withTenantTx(
    actor,
    async (tx, now): Promise<Prepared> => {
      const p = await repo.pieceById(tx, pieceId, { forUpdate: true });
      if (!p) throw new AppError('NOT_FOUND');
      if (p.kind !== 'social_post' && p.kind !== 'gbp_post') throw new AppError('MARKETING_NOT_PUBLISHABLE');
      if (p.status !== 'approved' && p.status !== 'published') throw new AppError(p.status === 'draft' ? 'MARKETING_APPROVE_FIRST' : 'MARKETING_NOT_LIVE', { status: p.status });
      const t = await repo.targetById(tx, connectionId);
      if (!t) throw new AppError('NOT_FOUND');
      // a social post goes only to a Facebook Page or Instagram business account, a GBP post only to a GBP location (module 53)
      const meta = t.kind === 'facebook_page' || t.kind === 'instagram_business';
      if (p.kind === 'social_post' ? !meta : t.kind !== 'gbp_location') throw new AppError('PUBLISH_TARGET_INVALID');
      if (t.status !== 'connected' && t.status !== 'degraded') throw new AppError('CHANNEL_NOT_CONNECTED');
      if (!t.external_account_id || !t.credential_id) throw new AppError('CHANNEL_NOT_CONNECTED');
      if (!(await repo.platformCleared(tx, 'platform:fair_housing'))) throw new AppError('PLATFORM_NOT_CLEARED');
      if (t.kind === 'gbp_location') {
        // module 53: GBP stays dark behind platform:gbp (the 0170 gate is the authority) and needs a configured adapter
        if (!(await repo.platformCleared(tx, 'platform:gbp'))) throw new AppError('PLATFORM_NOT_CLEARED', { pack: 'platform:gbp' });
        if (!deps.gbp?.configured) throw new AppError('GBP_NOT_CONFIGURED');
      }
      const assets = await repo.assetsOf(tx, pieceId);
      if (t.kind === 'instagram_business' && (deps.assumptions ?? marketingAssumptions()).instagramRequiresImage && assets.length === 0) throw new AppError('PUBLISH_NEEDS_IMAGE');
      // R-MKT-4: the frozen approval stands only while the live rendering still passes (identity / pack changes)
      const [facts, identity] = await Promise.all([repo.listingFacts(tx, p.listing_id), repo.identityOf(tx)]);
      if (!facts) throw new AppError('NOT_FOUND');
      if (['sold', 'withdrawn', 'expired'].includes(facts.status)) throw new AppError('LISTING_OFF_MARKET');
      const [advertising, fh] = await Promise.all([repo.advertisingPacks(tx, identity.jurisdictions), repo.fairHousingPack(tx, identity.jurisdictions)]);
      const rendered = renderPiece(repo.versionOf(p, assets), facts, identity, { advertising });
      const g = guardResult(rendered, identity, { advertising }, fh, p.content_sha256);
      if (!rendered.ok || guardReasons(g, p.content_sha256).length > 0) throw new AppError('MARKETING_GUARD_FAILED');
      const publicationId = deps.ids.next<'MarketingPublicationId'>();
      try {
        await sql`INSERT INTO marketing_publications (tenant_id, id, piece_id, connection_id, status, requested_by_user_id)
                  VALUES (app.tenant_id(), ${publicationId}, ${pieceId}, ${connectionId}, 'publishing', ${actor.userId})`.execute(tx);
      } catch (e) {
        throw mapDbError(e);
      }
      await audit(tx, actor, { action: 'marketing.publish_requested', entity: { type: 'marketing_publication', id: publicationId }, changes: redactSnapshot({ piece_id: pieceId, connection_id: connectionId, target: t.kind }), reason: 'TAPPED' });
      void now;
      return {
        publicationId,
        pieceId,
        listingId: p.listing_id,
        target: t.kind as PublishTargetKind,
        connectionId,
        externalAccountId: t.external_account_id,
        credentialId: t.credential_id,
        contentSha256: p.content_sha256,
        text: rendered.ok ? rendered.text : '',
        imageObjectIds: assets.map((a) => a.objectId as string),
      };
    },
    { db: deps.db, retries: 0 },
  );
  return sendAndRecord(deps, actor.tenantId, prep);
}

async function tokenFor(deps: PublishDeps, tx: Tx, tenantId: string, credentialId: string): Promise<OAuthToken | null> {
  const secret = await repo.credentialSecret(tx, credentialId);
  if (!secret) return null;
  const pt = await deps.envelope.inTx(tx, tenantId as TenantId).decrypt(tenantId as TenantId, { table: 'provider_credentials', column: 'secret_enc', rowId: credentialId }, new Uint8Array(secret));
  return JSON.parse(new TextDecoder().decode(pt)) as OAuthToken;
}

async function sendAndRecord(deps: PublishDeps, tenantId: string, prep: Prepared): Promise<{ publicationId: string; status: repo.PublicationRow['status'] }> {
  // TXk, as the system: the token in memory only, and the signed image URLs
  const ctx = await asSystem(deps, tenantId, async (tx, now) => {
    const token = await tokenFor(deps, tx, tenantId, prep.credentialId).catch(() => null);
    const imageUrls = prep.imageObjectIds.map((objectId) => signedAssetUrl({ publicBaseUrl: deps.publicBaseUrl, secret: deps.linkSecret }, { tenantId, objectId, expiresAt: now + (deps.assumptions ?? marketingAssumptions()).imageUrlTtlMs }));
    return { token, imageUrls };
  });
  if (!ctx.token) {
    await recordOutcome(deps, tenantId, prep.publicationId, { status: 'failed', errorCode: 'CREDENTIAL_UNAVAILABLE' });
    return { publicationId: prep.publicationId, status: 'failed' };
  }
  const req: PublishRequest = {
    externalAccountId: prep.externalAccountId,
    accessToken: ctx.token.accessToken,
    target: prep.target,
    pieceId: prep.pieceId,
    contentSha256: prep.contentSha256,
    text: prep.text,
    imageUrls: ctx.imageUrls,
  };
  let outcome: ReturnType<typeof classifyPublish>;
  try {
    // the provider by target: a GBP location through deps.gbp (module 53), a Meta account through deps.social
    if (prep.target === 'gbp_location') {
      if (!deps.gbp?.configured) throw new ProviderError('not_configured', 'GBP_NOT_CONFIGURED');
      outcome = classifyPublish({ ok: true, result: await deps.gbp.publishPost(req) });
    } else outcome = classifyPublish({ ok: true, result: await deps.social.publishPost(req) });
  } catch (e) {
    outcome = classifyPublish({ ok: false, error: e });
  }
  await recordOutcome(deps, tenantId, prep.publicationId, outcome);
  return { publicationId: prep.publicationId, status: outcome.status };
}

/** TX2, as the system: the provider's outcome. Forward only (the DB guard); a 'published' piece only after a confirmed post. */
async function recordOutcome(deps: Pick<PublishDeps, 'db'>, tenantId: string, publicationId: string, o: { status: 'published'; externalPostId: string } | { status: 'failed' | 'unknown'; errorCode: string }): Promise<void> {
  await asSystem(deps, tenantId, async (tx, now) => {
    const sys = systemActor(tenantId, 'provider');
    // Lock order: the piece before this publication's row, the order TX1 takes them (the piece FOR UPDATE, then the
    // INSERT into the one-live index). A concurrent tap's TX1 that holds the piece then waits in that INSERT for an
    // uncommitted change of this row: writing the row first and the piece second was a deadlock (the tap answered
    // 500, or this TX2 was retried after deadlock_timeout). A row only locked here does not make that INSERT wait: it
    // is refused at once (PUBLICATION_ALREADY_LIVE). piece_id never changes (0025 guard), so it is read unlocked.
    // FOR NO KEY UPDATE (the lock the piece UPDATE below takes anyway) still waits for TX1's FOR UPDATE, but not for
    // the key-share locks of rows that reference the piece (assets, invite messages, ad creatives).
    if (o.status === 'published') {
      await sql`SELECT 1 FROM marketing_pieces mp JOIN marketing_publications p ON p.tenant_id = mp.tenant_id AND p.piece_id = mp.id
                 WHERE p.tenant_id = app.tenant_id() AND p.id = ${publicationId} FOR NO KEY UPDATE OF mp`.execute(tx);
    }
    const cur = await repo.publicationById(tx, publicationId, { forUpdate: true });
    if (!cur || (cur.status !== 'publishing' && cur.status !== 'unknown')) return;
    if (o.status === 'published') {
      await sql`UPDATE marketing_publications SET status = 'published', external_post_id = ${o.externalPostId}, published_at = ${toIso(now)}::timestamptz, error_code = NULL
                 WHERE tenant_id = app.tenant_id() AND id = ${publicationId}`.execute(tx);
      // R-MKT-12: a piece is 'published' once at least one of its publications is provider-confirmed. In a savepoint: if
      // the piece cannot move now (platform:fair_housing became uncleared after TX1), the provider's confirmed post is
      // still recorded; never rolled back to 'publishing'
      await sql`SAVEPOINT piece_status`.execute(tx);
      try {
        await sql`UPDATE marketing_pieces SET status = 'published', published_at = COALESCE(published_at, ${toIso(now)}::timestamptz)
                   WHERE tenant_id = app.tenant_id() AND id = ${cur.piece_id} AND status = 'approved'`.execute(tx);
        await sql`RELEASE SAVEPOINT piece_status`.execute(tx);
      } catch {
        await sql`ROLLBACK TO SAVEPOINT piece_status`.execute(tx);
      }
    } else if (o.status === 'failed') {
      await sql`UPDATE marketing_publications SET status = 'failed', error_code = ${o.errorCode} WHERE tenant_id = app.tenant_id() AND id = ${publicationId}`.execute(tx);
    } else if (cur.status === 'publishing') {
      await sql`UPDATE marketing_publications SET status = 'unknown', error_code = ${o.errorCode} WHERE tenant_id = app.tenant_id() AND id = ${publicationId}`.execute(tx);
    } else return;
    await audit(tx, sys, { action: 'marketing.publication_recorded', entity: { type: 'marketing_publication', id: publicationId }, changes: redactSnapshot({ status: o.status, piece_id: cur.piece_id }), reason: o.status === 'published' ? 'PROVIDER_CONFIRMED' : o.errorCode });
  });
}

/**
 * The module's reconcile pass over publications (handlers.ts, per tenant, as the system): stale 'publishing' rows
 * become 'unknown'; every 'unknown' row is looked up at the provider and recorded as published or failed, or left
 * unknown. Nothing here ever calls publishPost (E227: never re-posted).
 */
export async function reconcilePublications(deps: PublishDeps, tenantId: string): Promise<{ looked: number; published: number; failed: number }> {
  const rows = await asSystem(deps, tenantId, async (tx, now) => {
    // module 53: a GBP location is looked up only with a configured adapter and platform:gbp cleared; otherwise its
    // 'unknown' rows stay unknown ("Check your Google Business Profile") and are not selected at all
    const gbpOn = deps.gbp?.configured === true && (await repo.platformCleared(tx, 'platform:gbp'));
    await sql`UPDATE marketing_publications SET status = 'unknown', error_code = 'PUBLISH_ANSWER_LOST'
               WHERE tenant_id = app.tenant_id() AND status = 'publishing' AND requested_at < ${toIso((now - STALE_PUBLISHING_MS) as Instant)}::timestamptz`.execute(tx);
    const r = await sql<{ id: string; piece_id: string; connection_id: string; requested_at: Date; kind: string; external_account_id: string | null; credential_id: string | null; content_sha256: string }>`
      SELECT p.id, p.piece_id, p.connection_id, p.requested_at, c.kind, c.external_account_id, c.credential_id, mp.content_sha256
        FROM marketing_publications p
        JOIN integration_connections c ON c.tenant_id = p.tenant_id AND c.id = p.connection_id
        JOIN marketing_pieces mp ON mp.tenant_id = p.tenant_id AND mp.id = p.piece_id
       WHERE p.tenant_id = app.tenant_id() AND p.status = 'unknown'
         AND (c.kind IN ('facebook_page','instagram_business') OR (c.kind = 'gbp_location' AND ${gbpOn}))
         AND c.external_account_id IS NOT NULL AND c.credential_id IS NOT NULL
       ORDER BY p.updated_at, p.id LIMIT 50`.execute(tx);
    return { rows: r.rows, now };
  });
  const out = { looked: 0, published: 0, failed: 0 };
  for (const r of rows.rows) {
    if (!r.external_account_id || !r.credential_id || (r.kind !== 'facebook_page' && r.kind !== 'instagram_business' && r.kind !== 'gbp_location')) continue;
    if (r.kind === 'gbp_location' && !deps.gbp?.configured) continue;
    const token = await asSystem(deps, tenantId, (tx) => tokenFor(deps, tx, tenantId, r.credential_id!)).catch(() => null);
    if (!token) continue;
    out.looked += 1;
    let decided: ReturnType<typeof reconcileFromLookup>;
    try {
      const look = { externalAccountId: r.external_account_id, accessToken: token.accessToken, target: r.kind as PublishRequest['target'], pieceId: r.piece_id, contentSha256: r.content_sha256 };
      const found = r.kind === 'gbp_location' ? await deps.gbp!.lookupPost(look) : await deps.social.lookupPost(look);
      decided = reconcileFromLookup({ ok: true, result: found }, rows.now - r.requested_at.getTime(), (deps.assumptions ?? marketingAssumptions()).unknownGiveUpMs);
    } catch (e) {
      decided = reconcileFromLookup({ ok: false, error: e }, rows.now - r.requested_at.getTime());
    }
    if (decided.status === 'unknown') {
      // still unknown: to the back of the queue, so rows that cannot be resolved never starve newer ones
      await asSystem(deps, tenantId, (tx) => sql`UPDATE marketing_publications SET updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${r.id} AND status = 'unknown'`.execute(tx));
      continue;
    }
    await recordOutcome(deps, tenantId, r.id, decided);
    if (decided.status === 'published') out.published += 1;
    else out.failed += 1;
  }
  return out;
}

/**
 * Retract one provider-confirmed publication: delete at the provider first; record 'retracted' only after it
 * confirmed; otherwise raise the "remove it yourself" card. `requestedBy` is the person who asked (TX1 checks they
 * may write the listing), or null for the system (R-MKT-4 / R-MKT-9 from the reconcile handler).
 *
 * The same TX1 / provider / TX2 shape as publishing (R-MKT-12, R-GATE-15): one short transaction claims the
 * retraction (0054 marketing_publications.retract_claim_id), so exactly one caller per publication calls deletePost;
 * another caller answers 'in_progress' and never calls the provider (before the claim, a second caller's
 * POST_NOT_FOUND raised a "remove it yourself" card for a post the first had just deleted). The provider call is
 * outside any transaction and waited for at most DELETE_POST_TIMEOUT_MS. TX2 clears the claim with the outcome. A
 * claim older than app.marketing_retract_claim_window() (5 minutes) belonged to a process that died and is taken
 * again: the reconcile pass finishes it (a stored request to retract), whatever the listing.
 */
export async function retractPublication(deps: PublishDeps, tenantId: string, publicationId: string, requestedBy: UserActor | null): Promise<{ outcome: 'retracted' | 'remove_yourself' | 'not_live' | 'in_progress' }> {
  if (requestedBy) {
    await withTenantTx(
      requestedBy,
      async (tx) => {
        const pub = await repo.publicationById(tx, publicationId);
        if (!pub) throw new AppError('NOT_FOUND');
        const ok = await sql<{ ok: boolean }>`SELECT app.listing_writable(mp.tenant_id, mp.listing_id) AS ok FROM marketing_pieces mp WHERE mp.tenant_id = app.tenant_id() AND mp.id = ${pub.piece_id}`.execute(tx);
        if (ok.rows[0]?.ok !== true) throw new AppError('NOT_FOUND');
        await audit(tx, requestedBy, { action: 'marketing.retract_requested', entity: { type: 'marketing_publication', id: publicationId }, changes: redactSnapshot({ piece_id: pub.piece_id }), reason: 'RETRACT_REQUESTED' });
      },
      { db: deps.db },
    );
  }
  // TX1 (the claim), as the system
  const claimId = deps.ids.next<'RetractClaimId'>();
  const pub = await asSystem(deps, tenantId, async (tx) => {
    const p = await repo.publicationById(tx, publicationId, { forUpdate: true });
    if (!p) return null;
    // 'unknown' may be live but has no post id to delete: the agent removes it themselves (R-MKT-9, R-MKT-4). No
    // provider call, so no claim: TX2 decides under this row's lock (it may have been confirmed meanwhile)
    if (p.status === 'unknown') return { p, c: null, token: null, claimId: null };
    if (p.status !== 'published' || !p.external_post_id) return null;
    // a live claim is another retraction in flight; the 0054 guard refuses replacing it before the window too. The
    // guard stamps the claim with clock_timestamp(): the time it was taken, after any wait for the row
    const took = await sql`UPDATE marketing_publications SET retract_claim_id = ${claimId}, retract_claimed_at = clock_timestamp()
                            WHERE tenant_id = app.tenant_id() AND id = ${publicationId} AND status = 'published'
                              AND (retract_claim_id IS NULL OR retract_claimed_at < now() - app.marketing_retract_claim_window())`.execute(tx);
    if (Number(took.numAffectedRows ?? 0) === 0) return 'in_progress' as const;
    const c = await repo.targetById(tx, p.connection_id);
    // module 53 (R-GBP-3): while platform:gbp is uncleared, Google is called only to take down a post whose listing must
    // come down (the system's retraction, requestedBy null); a person's own retraction gets the "remove it yourself" card
    const gbpHeld = c?.kind === 'gbp_location' && requestedBy !== null && !(await repo.platformCleared(tx, 'platform:gbp'));
    const token = c?.credential_id && !gbpHeld ? await tokenFor(deps, tx, tenantId, c.credential_id).catch(() => null) : null;
    return { p, c, token, claimId };
  });
  if (!pub) return { outcome: 'not_live' };
  if (pub === 'in_progress') return { outcome: 'in_progress' };
  // the provider, outside any transaction, by the claim holder only, and waited for well inside the claim window
  let decided: ReturnType<typeof retractFromDelete>;
  // retract by target: a GBP location through deps.gbp (module 53; allowed while platform:gbp is uncleared: taking a live
  // post down never waits on a pack), a Meta account through deps.social; no configured GBP adapter: "remove it yourself"
  const viaGbp = pub.c?.kind === 'gbp_location';
  if (!pub.token || !pub.c?.external_account_id || !(pub.c.kind === 'facebook_page' || pub.c.kind === 'instagram_business' || (viaGbp && deps.gbp?.configured))) decided = { kind: 'remove_yourself', reason: 'FAILED' };
  else {
    try {
      const del: DeleteRequest = { externalAccountId: pub.c.external_account_id, accessToken: pub.token.accessToken, target: pub.c.kind as DeleteRequest['target'], providerRef: pub.p.external_post_id! };
      const call = viaGbp ? deps.gbp!.deletePost(del) : deps.social.deletePost(del);
      decided = retractFromDelete({ ok: true, result: await withinBound(call, deps.deleteTimeoutMs ?? DELETE_POST_TIMEOUT_MS) });
    } catch (e) {
      decided = retractFromDelete({ ok: false, error: e });
    }
  }
  // TX2, as the system
  const done = await asSystem(deps, tenantId, async (tx, now) => {
    const sys = systemActor(tenantId, 'provider');
    if (decided.kind === 'retracted') {
      // the provider confirmed the deletion: recorded (and any claim cleared) whoever holds the claim now
      const r = await sql`UPDATE marketing_publications SET status = 'retracted', retracted_at = ${toIso(now)}::timestamptz, retract_claim_id = NULL, retract_claimed_at = NULL
                           WHERE tenant_id = app.tenant_id() AND id = ${publicationId} AND status = 'published'`.execute(tx);
      if (Number(r.numAffectedRows ?? 0) === 0) return { outcome: 'not_live' as const };
      // a card an earlier attempt (or a retraction that took over a stale claim) raised for this post is moot now
      await clearRemoveYourselfReason(tx, pub.p.piece_id, publicationId);
      await audit(tx, sys, { action: 'marketing.retracted', entity: { type: 'marketing_publication', id: publicationId }, changes: redactSnapshot({ piece_id: pub.p.piece_id }), reason: 'PROVIDER_CONFIRMED_DELETION' });
      return { outcome: 'retracted' as const };
    }
    // a retraction that took over a stale claim may have confirmed the deletion meanwhile: no card for a post that is gone
    const still = await repo.publicationById(tx, publicationId, { forUpdate: true });
    if (!still || (still.status !== 'published' && still.status !== 'unknown')) return { outcome: 'not_live' as const };
    // another retraction holds the claim now (this one's went stale and was taken over, or this 'unknown' row was
    // confirmed and claimed meanwhile): that one decides, and raises the card if it must. null === null: an 'unknown'
    // row, still unclaimed, goes on
    if (still.retract_claim_id !== pub.claimId) return { outcome: 'in_progress' as const };
    // this 'unknown' row was confirmed meanwhile (reconcile's lookup, or the provider's late answer): it has a post id
    // now, so the provider can delete it. Retracted through the claim instead of handed to the agent (once: a
    // 'published' row never becomes 'unknown' again, so the second run takes the claim path)
    if (pub.claimId === null && still.status === 'published') return 'confirmed_meanwhile' as const;
    await raiseRemoveYourselfCard(tx, deps, { pieceId: pub.p.piece_id, publicationId, targetKind: pub.p.connection_kind, targetName: pub.p.connection_name });
    // the post stays recorded as live; the claim is released, so a later request asks the provider again
    if (pub.claimId !== null) {
      await sql`UPDATE marketing_publications SET retract_claim_id = NULL, retract_claimed_at = NULL
                 WHERE tenant_id = app.tenant_id() AND id = ${publicationId} AND retract_claim_id = ${pub.claimId}`.execute(tx);
    }
    return { outcome: 'remove_yourself' as const };
  });
  if (done === 'confirmed_meanwhile') return retractPublication(deps, tenantId, publicationId, null);
  return done;
}

/**
 * Every live publication of a piece, retracted (or a card raised). Used by retract routes and the reconcile handler.
 * `inProgress` counts posts another retraction is taking down right now (they are not asked again here).
 */
export async function retractAllOf(deps: PublishDeps, tenantId: string, pieceId: string, requestedBy: UserActor | null): Promise<{ retracted: number; removeYourself: number; inProgress: number }> {
  const ids = await asSystem(deps, tenantId, async (tx) => (await sql<{ id: string }>`SELECT id FROM marketing_publications WHERE tenant_id = app.tenant_id() AND piece_id = ${pieceId} AND status IN ('published','unknown') ORDER BY requested_at`.execute(tx)).rows.map((r) => r.id));
  const out = { retracted: 0, removeYourself: 0, inProgress: 0 };
  for (const id of ids) {
    const r = await retractPublication(deps, tenantId, id, requestedBy);
    if (r.outcome === 'retracted') out.retracted += 1;
    if (r.outcome === 'remove_yourself') out.removeYourself += 1;
    if (r.outcome === 'in_progress') out.inProgress += 1;
  }
  return out;
}

/** How long one review reply is waited for; then it counts as unknown (the reply may exist: never posted twice). */
export const REVIEW_REPLY_TIMEOUT_MS = 30_000;

/**
 * Module 53: post one public reply to a Google review. THE only postReviewReply call site (R-GBP-1, R-GATE-15); only
 * gbp/replies.ts imports it (gbp/architecture.test.ts), which runs it outside any transaction after its TX1 claimed the
 * approval, and records the outcome in its TX2. A public review reply is publishing, not contact communication
 * (R-GATE-15): no messages row, contact point, touch or consent event. 'replied' only on Google's explicit answer; an
 * explicit refusal is { failed }; a timeout or an answer we cannot read is 'unknown'.
 */
export async function sendReviewReply(deps: Pick<PublishDeps, 'gbp'>, req: ReviewReplyRequest, timeoutMs = REVIEW_REPLY_TIMEOUT_MS): Promise<'replied' | { failed: string } | 'unknown'> {
  if (!deps.gbp?.configured) return { failed: 'GBP_NOT_CONFIGURED' };
  try {
    const r = await withinBound(deps.gbp.postReviewReply(req), timeoutMs);
    if (r.kind === 'replied') return 'replied';
    if (r.kind === 'rejected') return { failed: errorCodeOf(r.code, 'REPLY_REJECTED') };
    return 'unknown';
  } catch (e) {
    if (e instanceof ProviderError && (e.kind === 'rejected' || e.kind === 'not_configured')) return { failed: errorCodeOf(e.providerCode, 'REPLY_REJECTED') };
    return 'unknown';
  }
}

export { closeReviewCard };
