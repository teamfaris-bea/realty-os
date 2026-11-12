// publishPost: THE publishing path (module 29; D2; PHASE2_3_PLAN §5.4 #29; DATA_MODEL R-MKT-12, R-GATE-15, R-INT-6;
// E227, E228; ARCHITECTURE §21.11). The only module that calls SocialPublisher (publishPost, lookupPost, deletePost):
// lint realty/no-provider-outbound reserves publishPost / postReviewReply for this file, and architecture.test.ts
// proves no other file calls any of the three. Module 53 adds the gbp_location branch here (one flagged edit).
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
//   retract: deletePost at the provider first; 'retracted' is recorded only after the provider confirmed the deletion;
//        otherwise a "remove it yourself" card (marketing:{piece}) for the listing agent.
// The Meta connection is for content publishing only: there is no messaging webhook, so a DM to the Page is never
// received (E228; integrations/catalog.ts requests publishing scopes only).
import { type IdGenerator, type Instant, type TenantId, type UserActor, toIso } from '@realty/core/foundation';
import { guardReasons, guardResult, renderPiece } from '@realty/core/marketing';
import { type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit, redactSnapshot } from '../audit.js';
import type { EnvelopeService } from '../crypto/envelope.js';
import { AppError } from '../errors.js';
import type { OAuthToken, PublishRequest, SocialPublisher } from '../providers/integrations/types.js';
import { systemActor } from '../worker/systemActor.js';
import type { Database } from '@realty/db';
import { type PublishTargetKind, classifyPublish, reconcileFromLookup, retractFromDelete } from './decide.js';
import { type MarketingAssumptions, marketingAssumptions } from './assumptions.js';
import { signedAssetUrl } from './assetLinks.js';
import { closeReviewCard, raiseRemoveYourselfCard } from './cards.js';
import { mapDbError } from './pieces.js';
import * as repo from './repo.js';

export interface PublishDeps {
  db: Database;
  envelope: EnvelopeService;
  social: SocialPublisher;
  /** absolute base of this API (signed image URLs the provider fetches, VERIFY: Instagram fetches public URLs) */
  publicBaseUrl: string;
  /** keys the signed asset URLs (HMAC, derived per purpose) */
  linkSecret: Uint8Array;
  ids: IdGenerator;
  /** the VERIFY items (assumptions.ts); default: the process environment's, strict */
  assumptions?: MarketingAssumptions;
}

const asSystem = <T>(d: Pick<PublishDeps, 'db'>, tenantId: string, fn: (tx: Tx, now: Instant) => Promise<T>) => withTenantTx(systemActor(tenantId, 'provider'), fn, { db: d.db, retries: 2 });

/** A stuck 'publishing' row (the process died between TX1 and TX2) is treated as unknown after this long. */
export const STALE_PUBLISHING_MS = 5 * 60_000;

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
      if (p.kind !== 'social_post') throw new AppError(p.kind === 'gbp_post' ? 'PUBLISH_TARGET_INVALID' : 'MARKETING_NOT_PUBLISHABLE');
      if (p.status !== 'approved' && p.status !== 'published') throw new AppError(p.status === 'draft' ? 'MARKETING_APPROVE_FIRST' : 'MARKETING_NOT_LIVE', { status: p.status });
      const t = await repo.targetById(tx, connectionId);
      if (!t) throw new AppError('NOT_FOUND');
      if (t.kind !== 'facebook_page' && t.kind !== 'instagram_business') throw new AppError('PUBLISH_TARGET_INVALID');
      if (t.status !== 'connected' && t.status !== 'degraded') throw new AppError('CHANNEL_NOT_CONNECTED');
      if (!t.external_account_id || !t.credential_id) throw new AppError('CHANNEL_NOT_CONNECTED');
      if (!(await repo.platformCleared(tx, 'platform:fair_housing'))) throw new AppError('PLATFORM_NOT_CLEARED');
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
        target: t.kind,
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
    outcome = classifyPublish({ ok: true, result: await deps.social.publishPost(req) });
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
    await sql`UPDATE marketing_publications SET status = 'unknown', error_code = 'PUBLISH_ANSWER_LOST'
               WHERE tenant_id = app.tenant_id() AND status = 'publishing' AND requested_at < ${toIso((now - STALE_PUBLISHING_MS) as Instant)}::timestamptz`.execute(tx);
    const r = await sql<{ id: string; piece_id: string; connection_id: string; requested_at: Date; kind: string; external_account_id: string | null; credential_id: string | null; content_sha256: string }>`
      SELECT p.id, p.piece_id, p.connection_id, p.requested_at, c.kind, c.external_account_id, c.credential_id, mp.content_sha256
        FROM marketing_publications p
        JOIN integration_connections c ON c.tenant_id = p.tenant_id AND c.id = p.connection_id
        JOIN marketing_pieces mp ON mp.tenant_id = p.tenant_id AND mp.id = p.piece_id
       WHERE p.tenant_id = app.tenant_id() AND p.status = 'unknown'
         AND c.kind IN ('facebook_page','instagram_business') AND c.external_account_id IS NOT NULL AND c.credential_id IS NOT NULL
       ORDER BY p.updated_at, p.id LIMIT 50`.execute(tx);
    return { rows: r.rows, now };
  });
  const out = { looked: 0, published: 0, failed: 0 };
  for (const r of rows.rows) {
    if (!r.external_account_id || !r.credential_id || (r.kind !== 'facebook_page' && r.kind !== 'instagram_business')) continue;
    const token = await asSystem(deps, tenantId, (tx) => tokenFor(deps, tx, tenantId, r.credential_id!)).catch(() => null);
    if (!token) continue;
    out.looked += 1;
    let decided: ReturnType<typeof reconcileFromLookup>;
    try {
      decided = reconcileFromLookup({ ok: true, result: await deps.social.lookupPost({ externalAccountId: r.external_account_id, accessToken: token.accessToken, target: r.kind, pieceId: r.piece_id, contentSha256: r.content_sha256 }) }, rows.now - r.requested_at.getTime(), (deps.assumptions ?? marketingAssumptions()).unknownGiveUpMs);
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
 */
export async function retractPublication(deps: PublishDeps, tenantId: string, publicationId: string, requestedBy: UserActor | null): Promise<{ outcome: 'retracted' | 'remove_yourself' | 'not_live' }> {
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
  const pub = await asSystem(deps, tenantId, async (tx) => {
    const p = await repo.publicationById(tx, publicationId);
    if (!p) return null;
    // 'unknown' may be live but has no post id to delete: the agent removes it themselves (R-MKT-9, R-MKT-4)
    if (p.status === 'unknown') return { p, c: null, token: null };
    if (p.status !== 'published' || !p.external_post_id) return null;
    const c = await repo.targetById(tx, p.connection_id);
    const token = c?.credential_id ? await tokenFor(deps, tx, tenantId, c.credential_id).catch(() => null) : null;
    return { p, c, token };
  });
  if (!pub) return { outcome: 'not_live' };
  let decided: ReturnType<typeof retractFromDelete>;
  if (!pub.token || !pub.c?.external_account_id || (pub.c.kind !== 'facebook_page' && pub.c.kind !== 'instagram_business')) decided = { kind: 'remove_yourself', reason: 'FAILED' };
  else {
    try {
      decided = retractFromDelete({ ok: true, result: await deps.social.deletePost({ externalAccountId: pub.c.external_account_id, accessToken: pub.token.accessToken, target: pub.c.kind, providerRef: pub.p.external_post_id! }) });
    } catch (e) {
      decided = retractFromDelete({ ok: false, error: e });
    }
  }
  return asSystem(deps, tenantId, async (tx, now) => {
    const sys = systemActor(tenantId, 'provider');
    if (decided.kind === 'retracted') {
      const done = await sql`UPDATE marketing_publications SET status = 'retracted', retracted_at = ${toIso(now)}::timestamptz WHERE tenant_id = app.tenant_id() AND id = ${publicationId} AND status = 'published'`.execute(tx);
      if (Number(done.numAffectedRows ?? 0) === 0) return { outcome: 'not_live' as const };
      await audit(tx, sys, { action: 'marketing.retracted', entity: { type: 'marketing_publication', id: publicationId }, changes: redactSnapshot({ piece_id: pub.p.piece_id }), reason: 'PROVIDER_CONFIRMED_DELETION' });
      return { outcome: 'retracted' as const };
    }
    // a concurrent retraction may have confirmed the deletion meanwhile: no card for a post that is gone
    const still = await repo.publicationById(tx, publicationId, { forUpdate: true });
    if (!still || (still.status !== 'published' && still.status !== 'unknown')) return { outcome: 'not_live' as const };
    await raiseRemoveYourselfCard(tx, deps, { pieceId: pub.p.piece_id, publicationId, targetKind: pub.p.connection_kind, targetName: pub.p.connection_name });
    return { outcome: 'remove_yourself' as const };
  });
}

/** Every live publication of a piece, retracted (or a card raised). Used by retract routes and the reconcile handler. */
export async function retractAllOf(deps: PublishDeps, tenantId: string, pieceId: string, requestedBy: UserActor | null): Promise<{ retracted: number; removeYourself: number }> {
  const ids = await asSystem(deps, tenantId, async (tx) => (await sql<{ id: string }>`SELECT id FROM marketing_publications WHERE tenant_id = app.tenant_id() AND piece_id = ${pieceId} AND status IN ('published','unknown') ORDER BY requested_at`.execute(tx)).rows.map((r) => r.id));
  const out = { retracted: 0, removeYourself: 0 };
  for (const id of ids) {
    const r = await retractPublication(deps, tenantId, id, requestedBy);
    if (r.outcome === 'retracted') out.retracted += 1;
    if (r.outcome === 'remove_yourself') out.removeYourself += 1;
  }
  return out;
}

export { closeReviewCard };
