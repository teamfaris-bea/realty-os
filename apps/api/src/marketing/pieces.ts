// Marketing pieces (module 29; PHASE2_3_PLAN §5.4 #29; DATA_MODEL R-MKT-1..10, R-GATE-12, R-FH-1/2; E90, E92, E93).
//
//   generate   one draft per Phase 2 kind (website page, social post, open-house invite, flyer, Marketplace export)
//              for a TEAM listing, with deterministic starter copy that carries no price or date numerals (R-MKT-3);
//              an existing draft of a kind is kept (idempotent)
//   patch      a draft's prose / assets / open-house time; the guard result is rewritten right after, over the DB's
//              own hash of the stored content (app.marketing_content_sha256). PATCH of an approved version makes a NEW
//              draft version (R-MKT-2: approved copy is frozen; the old one stays live until the new one is approved)
//   approve    by a person, as themselves, of the exact content they saw (contentSha256 must be the current hash);
//              the guard runs once more against the live facts first, and the DB CHECK refuses anything else
//              (brokerage name, hard fair-housing match, pack rule, stale guard result)
//   export     hands an approved version to the agent ("Exported: post it yourself", R-MKT-6)
//   page       a website page goes live through POST publish (no connection): status published + its slug, once
//              platform:fair_housing is cleared (the DB trigger is the authority); a newer approved page version takes
//              the slug over and the old one is superseded
//
// Every transaction runs as the person under FORCE RLS; feed cards (marketing:{piece}, for the listing agent) are
// written by the system (cards.ts), because a Team Lead may act on an agent's listing.
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_TEMPLATE,
  type GuardResult,
  type PieceKind,
  PieceSchemas,
  type Rendered,
  guardReasons,
  guardResult,
  needsFairHousingCheck,
  renderPiece,
  deliveryLabel,
  exportBundle,
  parseGuardResult,
} from '@realty/core/marketing';
import type { Instant, StoredObjectId, UserActor } from '@realty/core/foundation';
import { toIso } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { audit, redactSnapshot } from '../audit.js';
import { AppError } from '../errors.js';
import { EXPORTED_POST_IT_YOURSELF, PAGE_SLUG_RE, earlierPostNotice, pageSlug, publicationLabel, publishOptions } from './decide.js';
import { marketingAssumptions } from './assumptions.js';
import * as repo from './repo.js';

/** The kinds module 29 generates (Phase 2; the GBP post is module 53's). */
export const PHASE2_KINDS: readonly PieceKind[] = ['website_page', 'social_post', 'open_house_invite', 'flyer', 'marketplace_export'];

const BOUND: Record<PieceKind, string[]> = {
  website_page: ['price', 'status', 'beds', 'baths', 'sqft', 'address', 'photos'],
  social_post: ['price', 'status', 'beds', 'baths', 'sqft', 'address', 'photos'],
  open_house_invite: ['price', 'status', 'beds', 'baths', 'sqft', 'address', 'open_house_at', 'photos'],
  flyer: ['price', 'status', 'beds', 'baths', 'sqft', 'address', 'photos'],
  marketplace_export: ['price', 'status', 'beds', 'baths', 'sqft', 'address', 'photos'],
  gbp_post: ['price', 'status', 'address'],
};

const PROPERTY_WORD: Record<string, string> = {
  single_family: 'home',
  condo: 'condo',
  townhouse: 'townhome',
  multi_family: 'multi-family home',
  land: 'lot',
  manufactured: 'home',
  other: 'property',
};

/** Starter copy: words only (no numerals, R-MKT-3); the facts render live from the listing. Deterministic. */
export function starterProse(kind: PieceKind, f: { city: string; propertyType: string | null }): Record<string, unknown> {
  const city = f.city.replace(/[0-9]/g, '').trim() || 'town';
  const word = PROPERTY_WORD[f.propertyType ?? 'other'] ?? 'property';
  const tag = city.replace(/[^\p{L}]/gu, '');
  switch (kind) {
    case 'website_page':
      return { headline: `A ${word} in ${city}`, body: `Take a look at this ${word} in ${city}. Contact the team to set up a showing.`, highlights: [] };
    case 'social_post':
      return { caption: `Now on the market in ${city}: a ${word} worth seeing. Message the team to set up a showing.`, hashtags: tag ? ['#JustListed', `#${tag}Homes`] : ['#JustListed'] };
    case 'open_house_invite':
      return { subject: `Open house in ${city}`, body: `You're invited to tour this ${word} in ${city}. Stop by during the open house, or reply to set up a private showing.` };
    case 'flyer':
      return { headline: `A ${word} in ${city}`, body: `A ${word} in ${city}. Ask the team for a showing.`, highlights: [] };
    case 'marketplace_export':
      return { title: `${word.charAt(0).toUpperCase()}${word.slice(1)} in ${city}`, description: `A ${word} in ${city}. Message the team to set up a showing.` };
    case 'gbp_post':
      return { body: `A ${word} in ${city}. Contact the team to set up a showing.` };
  }
}

export interface OpenHouseInput {
  startsAt: string;
  endsAt: string;
}

/** The guard over a piece as it is stored now: rendered against the live facts, bound to the DB's own hash. */
export async function computeGuard(tx: Tx, pieceId: string): Promise<{ guard: GuardResult; sha: string; rendered: Rendered; piece: repo.PieceRow }> {
  const piece = await repo.pieceById(tx, pieceId);
  if (!piece) throw new AppError('NOT_FOUND');
  const [assets, facts, identity] = await Promise.all([repo.assetsOf(tx, pieceId), repo.listingFacts(tx, piece.listing_id), repo.identityOf(tx)]);
  if (!facts) throw new AppError('NOT_FOUND');
  const [advertising, fh, sha] = await Promise.all([repo.advertisingPacks(tx, identity.jurisdictions), repo.fairHousingPack(tx, identity.jurisdictions), repo.contentSha256(tx, pieceId)]);
  const packs = { advertising };
  const rendered = renderPiece(repo.versionOf(piece, assets), facts, identity, packs);
  return { guard: guardResult(rendered, identity, packs, fh, sha), sha, rendered, piece };
}

async function writeGuard(tx: Tx, pieceId: string): Promise<void> {
  const { guard } = await computeGuard(tx, pieceId);
  await sql`UPDATE marketing_pieces SET guard_result = ${JSON.stringify(guard)}::jsonb WHERE tenant_id = app.tenant_id() AND id = ${pieceId} AND status = 'draft'`.execute(tx);
}

function openHouseJson(o: OpenHouseInput | null | undefined, zone: string): string | null {
  if (!o) return null;
  const a = Date.parse(o.startsAt);
  const b = Date.parse(o.endsAt);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/openHouse', code: 'invalid_instant' }] });
  if (b <= a) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/openHouse', code: 'ends_before_start' }] });
  return JSON.stringify({ startsAt: new Date(a).toISOString(), endsAt: new Date(b).toISOString(), zone });
}

async function insertDraft(
  tx: Tx,
  actor: UserActor,
  listingId: string,
  kind: PieceKind,
  prose: Record<string, unknown>,
  o: { boundFields?: string[]; templateKey?: string; openHouse?: string | null; assets?: { objectId: string; position: number }[] } = {},
): Promise<string> {
  const id = randomUUID();
  const versionNo = await repo.nextVersionNo(tx, listingId, kind);
  try {
    await sql`INSERT INTO marketing_pieces (tenant_id, id, listing_id, kind, version_no, status, prose, bound_fields, template_key, content_sha256, guard_result, open_house, created_by_user_id)
      VALUES (app.tenant_id(), ${id}, ${listingId}, ${kind}, ${versionNo}, 'draft', ${JSON.stringify(prose)}::jsonb, ${o.boundFields ?? BOUND[kind]}::text[],
              ${o.templateKey ?? DEFAULT_TEMPLATE[kind]}, ${'0'.repeat(64)}, '{}'::jsonb, ${o.openHouse ?? null}::jsonb, ${actor.userId})`.execute(tx);
  } catch (e) {
    throw mapDbError(e);
  }
  for (const a of o.assets ?? []) {
    await sql`INSERT INTO marketing_piece_assets (tenant_id, piece_id, position, object_id) VALUES (app.tenant_id(), ${id}, ${a.position}, ${a.objectId})`.execute(tx);
  }
  await writeGuard(tx, id);
  return id;
}

/** POST /listings/:id/marketing/generate */
export async function generate(tx: Tx, actor: UserActor, listingId: string, input: { kinds?: PieceKind[] | undefined; openHouse?: OpenHouseInput | undefined }): Promise<string[]> {
  const row = await repo.listingRow(tx, listingId, { forShare: true });
  if (!row) throw new AppError('NOT_FOUND');
  if (row.source !== 'team') throw new AppError('MARKETING_TEAM_LISTING_ONLY');
  const identity = await repo.identityOf(tx);
  const kinds = input.kinds && input.kinds.length > 0 ? [...new Set(input.kinds)] : [...PHASE2_KINDS];
  if (kinds.includes('gbp_post')) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/kinds', code: 'gbp_post_is_module_53' }] });
  const ids: string[] = [];
  for (const kind of kinds) {
    await repo.lockListingKind(tx, listingId, kind);
    const existing = await sql<{ id: string }>`SELECT id FROM marketing_pieces WHERE tenant_id = app.tenant_id() AND listing_id = ${listingId} AND kind = ${kind} AND status = 'draft' ORDER BY version_no DESC LIMIT 1`.execute(tx);
    if (existing.rows[0]) {
      ids.push(existing.rows[0].id);
      continue;
    }
    const oh = kind === 'open_house_invite' ? openHouseJson(input.openHouse, identity.timezone) : null;
    ids.push(await insertDraft(tx, actor, listingId, kind, starterProse(kind, { city: row.city, propertyType: row.property_type }), { openHouse: oh }));
  }
  return ids;
}

export interface PatchInput {
  prose?: Record<string, unknown> | undefined;
  assetObjectIds?: string[] | undefined;
  openHouse?: OpenHouseInput | null | undefined;
}

/** PATCH /marketing-pieces/:id → the draft (the same id, or a NEW version when the piece was no longer a draft). */
export async function patchPiece(tx: Tx, actor: UserActor, pieceId: string, input: PatchInput): Promise<{ pieceId: string; newVersion: boolean }> {
  const p = await repo.pieceById(tx, pieceId, { forUpdate: true });
  if (!p) throw new AppError('NOT_FOUND');
  if (input.prose !== undefined) {
    const parsed = PieceSchemas[p.kind].safeParse(input.prose);
    if (!parsed.success) throw new AppError('VALIDATION_FAILED', { issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: `/prose/${i.path.join('/')}`, code: i.code })) });
  }
  if (input.openHouse !== undefined && p.kind !== 'open_house_invite') throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/openHouse', code: 'invite_only' }] });
  const identity = await repo.identityOf(tx);
  const oh = input.openHouse === undefined ? undefined : openHouseJson(input.openHouse, identity.timezone);
  if (p.status === 'retracted' && p.kind === 'website_page') {
    // a taken-down page needs a new version too (R-MKT-4), with a new slug when it goes live again
  }
  if (p.status !== 'draft') {
    // R-MKT-2: approved copy is frozen; the change is a new draft version, the old one stays as it is
    await repo.lockListingKind(tx, p.listing_id, p.kind);
    const open = await sql<{ id: string }>`SELECT id FROM marketing_pieces WHERE tenant_id = app.tenant_id() AND listing_id = ${p.listing_id} AND kind = ${p.kind} AND status = 'draft' LIMIT 1`.execute(tx);
    if (open.rows[0]) throw new AppError('MARKETING_DRAFT_EXISTS', { pieceId: open.rows[0].id });
    const assets = input.assetObjectIds !== undefined ? input.assetObjectIds.map((objectId, i) => ({ objectId, position: i + 1 })) : (await repo.assetsOf(tx, p.id)).map((a) => ({ objectId: a.objectId as string, position: a.position }));
    const id = await insertDraft(tx, actor, p.listing_id, p.kind, input.prose ?? p.prose, {
      boundFields: p.bound_fields,
      templateKey: p.template_key,
      openHouse: oh === undefined ? (p.open_house ? JSON.stringify(p.open_house) : null) : oh,
      assets,
    }).catch((e: unknown) => {
      throw mapDbError(e);
    });
    return { pieceId: id, newVersion: true };
  }
  try {
    if (input.prose !== undefined || oh !== undefined) {
      await sql`UPDATE marketing_pieces SET prose = COALESCE(${input.prose === undefined ? null : JSON.stringify(input.prose)}::jsonb, prose),
                  open_house = CASE WHEN ${oh !== undefined} THEN ${oh ?? null}::jsonb ELSE open_house END
                WHERE tenant_id = app.tenant_id() AND id = ${p.id}`.execute(tx);
    }
    if (input.assetObjectIds !== undefined) {
      const ids = input.assetObjectIds;
      if (new Set(ids).size !== ids.length) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/assetObjectIds', code: 'duplicate' }] });
      await sql`DELETE FROM marketing_piece_assets WHERE tenant_id = app.tenant_id() AND piece_id = ${p.id}`.execute(tx);
      for (const [i, objectId] of ids.entries()) {
        await sql`INSERT INTO marketing_piece_assets (tenant_id, piece_id, position, object_id) VALUES (app.tenant_id(), ${p.id}, ${i + 1}, ${objectId})`.execute(tx);
      }
      // the asset change moves the content hash: touch the piece so the trigger recomputes it
      await sql`UPDATE marketing_pieces SET prose = prose WHERE tenant_id = app.tenant_id() AND id = ${p.id}`.execute(tx);
    }
  } catch (e) {
    throw mapDbError(e);
  }
  await writeGuard(tx, p.id);
  return { pieceId: p.id, newVersion: false };
}

/** POST /marketing-pieces/:id/approve {contentSha256}: one tap, bound to the content the person saw. */
export async function approvePiece(tx: Tx, actor: UserActor, pieceId: string, seenSha256: string, now: Instant): Promise<void> {
  const p = await repo.pieceById(tx, pieceId, { forUpdate: true });
  if (!p) throw new AppError('NOT_FOUND');
  if (p.status !== 'draft') throw new AppError('MARKETING_NOT_DRAFT', { status: p.status });
  const { guard, sha } = await computeGuard(tx, pieceId);
  if (seenSha256 !== sha) throw new AppError('MARKETING_STALE', { contentSha256: sha });
  const reasons = guardReasons(guard, sha);
  // the fresh guard result is stored either way, so the person sees exactly why approval is refused
  await sql`UPDATE marketing_pieces SET guard_result = ${JSON.stringify(guard)}::jsonb WHERE tenant_id = app.tenant_id() AND id = ${pieceId} AND status = 'draft'`.execute(tx);
  if (reasons.length > 0) throw new AppError('MARKETING_GUARD_FAILED', { reasonCount: reasons.length });
  try {
    await sql`UPDATE marketing_pieces SET status = 'approved', approved_by_user_id = ${actor.userId}, approved_at = ${toIso(now)}::timestamptz
               WHERE tenant_id = app.tenant_id() AND id = ${pieceId} AND status = 'draft'`.execute(tx);
  } catch (e) {
    throw mapDbError(e);
  }
  await audit(tx, actor, { action: 'marketing.approved', entity: { type: 'marketing_piece', id: pieceId }, changes: redactSnapshot({ kind: p.kind, version_no: p.version_no, content_sha256: sha }), reason: 'APPROVED' });
  // R-MKT-2: the new version replaces the older live ones of its kind; their external posts are never touched
  const older = await sql<{ id: string; status: string; public_slug: string | null }>`
    SELECT id, status, public_slug FROM marketing_pieces WHERE tenant_id = app.tenant_id() AND listing_id = ${p.listing_id} AND kind = ${p.kind}
       AND id <> ${pieceId} AND status IN ('approved','published','exported','draft') FOR UPDATE`.execute(tx);
  let liveSlug: string | null = null;
  for (const o of older.rows) {
    if (o.status === 'published' && o.public_slug) liveSlug = o.public_slug;
    await sql`UPDATE marketing_pieces SET status = 'superseded', public_slug = NULL WHERE tenant_id = app.tenant_id() AND id = ${o.id}`.execute(tx);
  }
  // a live page moves to the new version at once (the old page stayed live until now)
  if (p.kind === 'website_page' && liveSlug && (await repo.platformCleared(tx, 'platform:fair_housing'))) {
    await sql`UPDATE marketing_pieces SET status = 'published', public_slug = ${liveSlug}, published_at = ${toIso(now)}::timestamptz WHERE tenant_id = app.tenant_id() AND id = ${pieceId}`.execute(tx);
    await audit(tx, actor, { action: 'marketing.page_published', entity: { type: 'marketing_piece', id: pieceId }, changes: redactSnapshot({ version_no: p.version_no }), reason: 'NEW_VERSION' });
  }
}

/** POST /marketing-pieces/:id/publish for a website page: the page goes live on our own site. */
export async function publishPage(tx: Tx, actor: UserActor, pieceId: string, now: Instant): Promise<void> {
  const p = await repo.pieceById(tx, pieceId, { forUpdate: true });
  if (!p) throw new AppError('NOT_FOUND');
  if (p.kind !== 'website_page') throw new AppError('MARKETING_NOT_PUBLISHABLE');
  if (p.status === 'published') return;
  if (p.status !== 'approved' && p.status !== 'exported') throw new AppError('MARKETING_APPROVE_FIRST');
  if (!(await repo.platformCleared(tx, 'platform:fair_housing'))) throw new AppError('PLATFORM_NOT_CLEARED');
  const listing = await repo.listingRow(tx, p.listing_id);
  if (!listing) throw new AppError('NOT_FOUND');
  if (['sold', 'withdrawn', 'expired'].includes(listing.status)) throw new AppError('LISTING_OFF_MARKET');
  const slug = pageSlug(listing.address_line1, listing.city, p.id.replace(/-/g, '').slice(0, 8));
  if (!PAGE_SLUG_RE.test(slug)) throw new Error('page slug does not match the CHECK');
  try {
    await sql`UPDATE marketing_pieces SET status = 'published', public_slug = ${slug}, published_at = ${toIso(now)}::timestamptz WHERE tenant_id = app.tenant_id() AND id = ${pieceId}`.execute(tx);
  } catch (e) {
    throw mapDbError(e);
  }
  await audit(tx, actor, { action: 'marketing.page_published', entity: { type: 'marketing_piece', id: pieceId }, changes: redactSnapshot({ version_no: p.version_no }), reason: 'PUBLISHED' });
}

/** POST /marketing-pieces/:id/retract for a website page: the page answers 410 from now on (final; a new version is a new page). */
export async function retractPage(tx: Tx, actor: UserActor, pieceId: string, now: Instant): Promise<void> {
  const p = await repo.pieceById(tx, pieceId, { forUpdate: true });
  if (!p) throw new AppError('NOT_FOUND');
  if (p.kind !== 'website_page') throw new AppError('MARKETING_NOT_PUBLISHABLE');
  if (p.status === 'retracted') return;
  if (p.status === 'draft' || p.status === 'superseded') throw new AppError('MARKETING_NOT_LIVE');
  await sql`UPDATE marketing_pieces SET status = 'retracted', retracted_at = ${toIso(now)}::timestamptz WHERE tenant_id = app.tenant_id() AND id = ${pieceId}`.execute(tx);
  await audit(tx, actor, { action: 'marketing.retracted', entity: { type: 'marketing_piece', id: pieceId }, changes: redactSnapshot({ kind: p.kind }), reason: 'PAGE_TAKEN_DOWN' });
}

export interface ExportView {
  text: string;
  label: string;
  flags: string[];
  images: { position: number; url: string }[];
  flyerUrl: string | null;
}

/** POST /marketing-pieces/:id/export: the approved version, rendered against the live listing, handed to the agent. */
export async function exportPiece(tx: Tx, actor: UserActor, pieceId: string, now: Instant): Promise<ExportView> {
  const p = await repo.pieceById(tx, pieceId, { forUpdate: true });
  if (!p) throw new AppError('NOT_FOUND');
  if (p.status === 'draft') throw new AppError('MARKETING_APPROVE_FIRST');
  if (p.status === 'retracted' || p.status === 'superseded') throw new AppError('MARKETING_NOT_LIVE', { status: p.status });
  if (p.kind === 'open_house_invite') throw new AppError('MARKETING_NOT_EXPORTABLE');
  const [assets, facts, identity] = await Promise.all([repo.assetsOf(tx, pieceId), repo.listingFacts(tx, p.listing_id), repo.identityOf(tx)]);
  if (!facts) throw new AppError('NOT_FOUND');
  const advertising = await repo.advertisingPacks(tx, identity.jurisdictions);
  const b = exportBundle(repo.versionOf(p, assets), facts, identity, { advertising });
  if (!b.ok) throw new AppError('MARKETING_TEAM_LISTING_ONLY');
  await sql`UPDATE marketing_pieces SET exported_at = ${toIso(now)}::timestamptz, status = CASE WHEN status = 'approved' THEN 'exported' ELSE status END
             WHERE tenant_id = app.tenant_id() AND id = ${pieceId}`.execute(tx);
  await audit(tx, actor, { action: 'marketing.exported', entity: { type: 'marketing_piece', id: pieceId }, changes: redactSnapshot({ kind: p.kind, version_no: p.version_no }), reason: 'EXPORTED' });
  const label = b.flags.length > 0 ? `${EXPORTED_POST_IT_YOURSELF}. May be out of date: the listing is no longer for sale.` : EXPORTED_POST_IT_YOURSELF;
  return {
    text: b.text,
    label,
    flags: [...b.flags],
    images: b.images.map((a) => ({ position: a.position, url: `/api/marketing-pieces/${pieceId}/assets/${a.position}` })),
    flyerUrl: p.kind === 'flyer' ? `/api/marketing-pieces/${pieceId}/flyer.pdf` : null,
  };
}

// ---- views ------------------------------------------------------------------------------------------------------

export interface PublicationView {
  id: string;
  connectionId: string;
  targetKind: string;
  targetName: string;
  status: repo.PublicationRow['status'];
  /** true only for a provider-confirmed post (published with the provider's post id): the only time the UI says "Posted" */
  posted: boolean;
  label: string;
  requestedAt: string;
  publishedAt: string | null;
}

export interface PieceView {
  id: string;
  listingId: string;
  kind: PieceKind;
  versionNo: number;
  status: repo.PieceRow['status'];
  statusLabel: string;
  prose: Record<string, unknown>;
  templateKey: string;
  boundFields: string[];
  contentSha256: string;
  openHouse: { startsAt: string; endsAt: string; zone: string } | null;
  preview: { text: string; blocks: { role: string; origin: string; prominence: string; text: string }[] } | null;
  assets: { position: number; objectId: string; url: string }[];
  guard: { approvable: boolean; reasons: string[]; checkThis: boolean; soft: string[]; fairHousingReviewed: boolean };
  approvedAt: string | null;
  publishedAt: string | null;
  exportedAt: string | null;
  retractedAt: string | null;
  publicPath: string | null;
  publications: PublicationView[];
  publishOptions: ReturnType<typeof publishOptions>;
  /** R-MKT-12: a newer version never touches an older version's external posts, and says so */
  earlierPostNotice: string | null;
  exportable: boolean;
  invitable: boolean;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

export function publicationView(r: repo.PublicationRow, removeYourself = false): PublicationView {
  return {
    id: r.id,
    connectionId: r.connection_id,
    targetKind: r.connection_kind,
    targetName: r.connection_name,
    status: r.status,
    posted: r.status === 'published' && r.external_post_id !== null,
    label: publicationLabel({ status: r.status, externalPostId: r.external_post_id, targetKind: r.connection_kind, errorCode: r.error_code, removeYourself }),
    requestedAt: r.requested_at.toISOString(),
    publishedAt: iso(r.published_at),
  };
}

function statusLabelOf(p: repo.PieceRow, posted: boolean): string {
  if (p.status === 'exported' || (p.exported_at && p.status === 'approved')) return EXPORTED_POST_IT_YOURSELF;
  if (p.kind === 'social_post' && p.status === 'published') return posted ? 'Posted: see each account below' : 'Check each account below';
  return deliveryLabel(p.kind, p.status);
}

/** Every piece version of a listing, newest version of each kind first, with publications and honest labels. */
export async function listingPieces(tx: Tx, listingId: string, tenantSlug: string): Promise<{ pieces: PieceView[]; targets: { id: string; kind: string; status: string; displayName: string }[]; publishingCleared: boolean; fairHousingReviewSentence: string }> {
  const row = await repo.listingRow(tx, listingId);
  if (!row) throw new AppError('NOT_FOUND');
  const pieces = await repo.piecesOfListing(tx, listingId);
  const pubs = await repo.publicationsOfPieces(tx, pieces.map((p) => p.id));
  const targets = await repo.publishTargets(tx);
  const cleared = await repo.platformCleared(tx, 'platform:fair_housing');
  const removeYourself = await removeYourselfPublications(tx, pieces.map((p) => p.id));
  const out: PieceView[] = [];
  for (const p of pieces) out.push(await pieceView(tx, p, pubs, targets, cleared, removeYourself, pieces, tenantSlug));
  out.sort((a, b) => (a.kind === b.kind ? b.versionNo - a.versionNo : a.kind.localeCompare(b.kind)));
  const reviewed = (await sql<{ r: Date | null }>`SELECT reviewed_by_counsel_at AS r FROM jurisdiction_packs WHERE key = 'platform:fair_housing' AND status = 'published'`.execute(tx)).rows[0]?.r ?? null;
  return {
    pieces: out,
    targets: targets.map((t) => ({ id: t.id, kind: t.kind, status: t.status, displayName: t.display_name })),
    publishingCleared: cleared,
    fairHousingReviewSentence: reviewed ? 'The fair-housing pack was reviewed by counsel; publishing to connected accounts is on.' : 'Not reviewed by counsel yet: publishing to Facebook and Instagram stays off, and pieces are exported for you to post yourself.',
  };
}

export async function onePiece(tx: Tx, pieceId: string, tenantSlug: string): Promise<PieceView> {
  const p = await repo.pieceById(tx, pieceId);
  if (!p) throw new AppError('NOT_FOUND');
  const siblings = await repo.piecesOfListing(tx, p.listing_id);
  const pubs = await repo.publicationsOfPieces(tx, siblings.map((s) => s.id));
  const targets = await repo.publishTargets(tx);
  const cleared = await repo.platformCleared(tx, 'platform:fair_housing');
  return pieceView(tx, p, pubs, targets, cleared, await removeYourselfPublications(tx, [p.id]), siblings, tenantSlug);
}

/** Publications the system could not take down (a "remove it yourself" card was raised for them). */
async function removeYourselfPublications(tx: Tx, pieceIds: readonly string[]): Promise<Set<string>> {
  if (pieceIds.length === 0) return new Set();
  const r = await sql<{ code: string }>`
    SELECT DISTINCT x->>'code' AS code FROM priority_feed_items f, jsonb_array_elements(f.reasons) x
     WHERE f.tenant_id = app.tenant_id() AND f.item_type = 'marketing_review' AND f.dedupe_key = ANY (${pieceIds.map((id) => `marketing:${id}`)}::text[])
       AND x->>'code' LIKE 'REMOVE_POST_YOURSELF:%'`.execute(tx);
  return new Set(r.rows.map((x) => x.code.slice('REMOVE_POST_YOURSELF:'.length)));
}

async function pieceView(
  tx: Tx,
  p: repo.PieceRow,
  allPubs: repo.PublicationRow[],
  targets: repo.TargetRow[],
  cleared: boolean,
  removeYourself: Set<string>,
  siblings: repo.PieceRow[],
  tenantSlug: string,
): Promise<PieceView> {
  const { rendered, guard, sha } = await computeGuard(tx, p.id).then((g) => ({ ...g, guard: p.status === 'draft' ? g.guard : (parseGuardResult(p.guard_result) ?? g.guard) }));
  const assets = await repo.assetsOf(tx, p.id);
  const pubs = allPubs.filter((x) => x.piece_id === p.id);
  const live = new Set(pubs.filter((x) => x.status === 'publishing' || x.status === 'published' || x.status === 'unknown').map((x) => x.connection_id));
  const views = pubs.map((x) => publicationView(x, removeYourself.has(x.id)));
  const reasons = p.status === 'draft' ? guardReasons(guard, sha) : [];
  // the older versions of this kind whose external posts are still up (R-MKT-12)
  const olderIds = new Set(siblings.filter((s) => s.kind === p.kind && s.version_no < p.version_no).map((s) => s.id));
  const olderLive = allPubs.filter((x) => olderIds.has(x.piece_id) && x.status === 'published').map((x) => ({ targetKind: x.connection_kind }));
  return {
    id: p.id,
    listingId: p.listing_id,
    kind: p.kind,
    versionNo: p.version_no,
    status: p.status,
    statusLabel: statusLabelOf(p, views.some((v) => v.posted)),
    prose: p.prose,
    templateKey: p.template_key,
    boundFields: p.bound_fields,
    contentSha256: sha,
    openHouse: p.open_house,
    preview: rendered.ok ? { text: rendered.text, blocks: rendered.blocks.map((b) => ({ role: b.role, origin: b.origin, prominence: b.prominence, text: b.text })) } : null,
    assets: assets.map((a) => ({ position: a.position, objectId: a.objectId as string, url: `/api/marketing-pieces/${p.id}/assets/${a.position}` })),
    guard: { approvable: p.status === 'draft' && reasons.length === 0, reasons: rendered.ok ? reasons : [rendered.reason, ...reasons], checkThis: needsFairHousingCheck(guard), soft: guard.soft.map((s) => s.text), fairHousingReviewed: guard.fair_housing_reviewed },
    approvedAt: iso(p.approved_at),
    publishedAt: iso(p.published_at),
    exportedAt: iso(p.exported_at),
    retractedAt: iso(p.retracted_at),
    publicPath: p.kind === 'website_page' && p.public_slug ? `/p/${tenantSlug}/${p.public_slug}` : null,
    publications: views,
    publishOptions: publishOptions({ kind: p.kind, status: p.status, imageCount: assets.length }, targets.map((t) => ({ connectionId: t.id, kind: t.kind, status: t.status, displayName: t.display_name })), live, cleared, marketingAssumptions()),
    earlierPostNotice: earlierPostNotice(olderLive),
    exportable: p.kind !== 'open_house_invite' && ['approved', 'exported', 'published'].includes(p.status),
    invitable: p.kind === 'open_house_invite' && ['approved', 'published'].includes(p.status),
  };
}

/** The approvals inbox: drafts the caller may approve, with the one-tap facts (hash, approvable, reasons). */
export async function pendingApprovals(tx: Tx, tenantSlug: string): Promise<PieceView[]> {
  const drafts = await repo.approvableDrafts(tx, 50);
  const out: PieceView[] = [];
  for (const d of drafts) out.push(await onePiece(tx, d.id, tenantSlug));
  return out;
}

export async function tenantSlug(tx: Tx): Promise<string> {
  return (await sql<{ slug: string }>`SELECT slug FROM tenants WHERE id = app.tenant_id()`.execute(tx)).rows[0]?.slug ?? '';
}

// ---- assets -------------------------------------------------------------------------------------------------------

export const ASSET_TYPES: Record<string, (b: Uint8Array) => boolean> = {
  'image/png': (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47,
  'image/jpeg': (b) => b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/webp': (b) => b.length > 12 && Buffer.from(b.subarray(0, 4)).toString('ascii') === 'RIFF' && Buffer.from(b.subarray(8, 12)).toString('ascii') === 'WEBP',
};
export const ASSET_MAX_BYTES = 10 * 1024 * 1024;

export async function insertAssetObject(tx: Tx, o: { id: string; storageKey: string; contentType: string; byteSize: number; sha256: Uint8Array; dekWrapped: Uint8Array; keyVersion: number }): Promise<void> {
  await sql`INSERT INTO stored_objects (tenant_id, id, purpose, storage_key, content_type, byte_size, sha256, dek_wrapped, key_version, created_by_user_id)
            VALUES (app.tenant_id(), ${o.id}, 'marketing_asset', ${o.storageKey}, ${o.contentType}, ${o.byteSize}, ${Buffer.from(o.sha256)},
                    ${Buffer.from(o.dekWrapped)}, ${o.keyVersion}, CASE WHEN app.actor_kind() = 'user' THEN app.user_id() ELSE NULL END)`.execute(tx);
}

export async function assetObject(tx: Tx, pieceId: string, position: number): Promise<{ id: StoredObjectId; storage_key: string; dek_wrapped: Buffer | null; content_type: string } | null> {
  const r = await sql<{ id: StoredObjectId; storage_key: string; dek_wrapped: Buffer | null; content_type: string }>`
    SELECT o.id, o.storage_key, o.dek_wrapped, o.content_type FROM marketing_piece_assets a
      JOIN stored_objects o ON o.tenant_id = a.tenant_id AND o.id = a.object_id AND o.purpose = 'marketing_asset' AND o.deleted_at IS NULL
     WHERE a.tenant_id = app.tenant_id() AND a.piece_id = ${pieceId} AND a.position = ${position}`.execute(tx);
  return r.rows[0] ?? null;
}

// ---- DB errors ----------------------------------------------------------------------------------------------------

interface PgErrorLike {
  code?: string;
  message?: string;
  constraint?: string;
}

const DB_CODES = [
  'MARKETING_TEAM_LISTING_ONLY',
  'MARKETING_FROZEN',
  'MARKETING_TERMINAL',
  'MARKETING_APPROVE_FIRST',
  'MARKETING_HUMAN_APPROVAL',
  'MARKETING_ASSET_INVALID',
  'MARKETING_IDENTITY_IMMUTABLE',
  'MARKETING_BORN_DRAFT',
  'PLATFORM_NOT_CLEARED',
  'PUBLISH_TARGET_INVALID',
  'CHANNEL_NOT_CONNECTED',
  'PUBLICATION_HUMAN_TAP',
  'PUBLICATION_BORN_PUBLISHING',
  'PUBLICATION_SYSTEM_ONLY',
  'PUBLICATION_FORWARD_ONLY',
  'PUBLICATION_IMMUTABLE',
  'PUBLICATION_POST_ID_FINAL',
] as const;

/** Postgres refusals of the marketing guards → stable codes. Anything else is rethrown as it was. */
export function mapDbError(e: unknown): unknown {
  if (e instanceof AppError) return e;
  const pe = (e && typeof e === 'object' ? e : {}) as PgErrorLike;
  const msg = pe.message ?? '';
  for (const c of DB_CODES) if (msg.startsWith(c)) return new AppError(c);
  if (pe.code === '23514' && msg.includes('marketing_pieces')) return new AppError('MARKETING_GUARD_FAILED');
  if (pe.code === '23505' && (pe.constraint === 'marketing_publications_one_live' || msg.includes('marketing_publications_one_live'))) return new AppError('PUBLICATION_ALREADY_LIVE');
  if (pe.code === '42501' || pe.code === '23503') return new AppError('NOT_FOUND');
  return e;
}

export type { GuardResult };
export const _forTests = { BOUND };
void parseGuardResult;
void randomUUID;
