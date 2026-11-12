// SQL of module 29 (marketing_pieces, marketing_piece_assets, marketing_publications, the identity and packs the
// guard needs). Every query runs in the caller's transaction under FORCE RLS (app.tenant_id()); nothing here sets a
// tenant or reads across tenants. The one pre-tenant read is app.public_listing_page (publicPage.ts).
import type { AdvertisingPack, BoundField, BrokerageIdentity, PieceKind, PieceStatus, PieceVersion } from '@realty/core/marketing';
import { advertisingPackFrom } from '@realty/core/marketing';
import { type FairHousingPack, fairHousingPackFrom } from '@realty/core/fairhousing';
import type { ListingFacts } from '@realty/core/listings';
import type { ListingId, StoredObjectId } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { AppError } from '../errors.js';
import { LISTING_COLS, type ListingRow, factsOfRow } from '../mls/eligibility.js';

export interface PieceRow {
  id: string;
  listing_id: string;
  kind: PieceKind;
  version_no: number;
  status: PieceStatus;
  prose: Record<string, unknown>;
  bound_fields: BoundField[];
  template_key: string;
  content_sha256: string;
  guard_result: Record<string, unknown>;
  public_slug: string | null;
  open_house: { startsAt: string; endsAt: string; zone: string } | null;
  approved_by_user_id: string | null;
  approved_at: Date | null;
  published_at: Date | null;
  exported_at: Date | null;
  retracted_at: Date | null;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

const PIECE_COLS = sql`id, listing_id, kind, version_no, status, prose, bound_fields, template_key, content_sha256, guard_result, public_slug,
  open_house, approved_by_user_id, approved_at, published_at, exported_at, retracted_at, created_by_user_id, created_at, updated_at`;

export async function pieceById(tx: Tx, id: string, o: { forUpdate?: boolean } = {}): Promise<PieceRow | null> {
  const r = await sql<PieceRow>`SELECT ${PIECE_COLS} FROM marketing_pieces WHERE tenant_id = app.tenant_id() AND id = ${id} ${o.forUpdate ? sql`FOR UPDATE` : sql``}`.execute(tx);
  return r.rows[0] ?? null;
}

export async function piecesOfListing(tx: Tx, listingId: string): Promise<PieceRow[]> {
  return (await sql<PieceRow>`SELECT ${PIECE_COLS} FROM marketing_pieces WHERE tenant_id = app.tenant_id() AND listing_id = ${listingId} ORDER BY kind, version_no`.execute(tx)).rows;
}

/** Draft pieces of team listings the caller may approve (listing writers), newest first: the approvals inbox. */
export async function approvableDrafts(tx: Tx, limit: number): Promise<PieceRow[]> {
  return (
    await sql<PieceRow>`SELECT ${PIECE_COLS} FROM marketing_pieces mp
      WHERE mp.tenant_id = app.tenant_id() AND mp.status = 'draft' AND app.listing_writable(mp.tenant_id, mp.listing_id)
      ORDER BY mp.updated_at DESC, mp.id LIMIT ${limit}`.execute(tx)
  ).rows;
}

export async function assetsOf(tx: Tx, pieceId: string): Promise<{ objectId: StoredObjectId; position: number }[]> {
  const r = await sql<{ object_id: string; position: number }>`SELECT object_id, position FROM marketing_piece_assets
     WHERE tenant_id = app.tenant_id() AND piece_id = ${pieceId} ORDER BY position`.execute(tx);
  return r.rows.map((x) => ({ objectId: x.object_id as StoredObjectId, position: x.position }));
}

export function versionOf(p: PieceRow, assets: { objectId: StoredObjectId; position: number }[]): PieceVersion {
  return {
    kind: p.kind,
    versionNo: p.version_no,
    prose: p.prose,
    templateKey: p.template_key,
    boundFields: p.bound_fields,
    assets,
    openHouse: p.open_house ? { startsAt: Date.parse(p.open_house.startsAt) as never, endsAt: Date.parse(p.open_house.endsAt) as never, zone: p.open_house.zone as never } : null,
  };
}

export async function listingRow(tx: Tx, listingId: string, o: { forShare?: boolean } = {}): Promise<ListingRow | null> {
  const r = await sql<ListingRow>`SELECT ${LISTING_COLS} FROM listings l WHERE l.tenant_id = app.tenant_id() AND l.id = ${listingId} ${o.forShare ? sql`FOR SHARE` : sql``}`.execute(tx);
  return r.rows[0] ?? null;
}

export async function listingFacts(tx: Tx, listingId: string): Promise<ListingFacts | null> {
  const r = await listingRow(tx, listingId);
  return r ? factsOfRow(r) : null;
}

export async function identityOf(tx: Tx): Promise<BrokerageIdentity & { jurisdictions: string[]; timezone: string }> {
  const r = await sql<{ brokerage_legal_name: string; team_name: string | null; brokerage_license_number: string | null; brokerage_postal_address: string | null; operating_jurisdictions: string[]; default_timezone: string; tenant_name: string }>`
    SELECT s.brokerage_legal_name, s.team_name, s.brokerage_license_number, s.brokerage_postal_address, s.operating_jurisdictions, s.default_timezone, t.name AS tenant_name
      FROM tenant_settings s JOIN tenants t ON t.id = s.tenant_id WHERE s.tenant_id = app.tenant_id()`.execute(tx);
  const s = r.rows[0];
  if (!s) throw new AppError('NOT_FOUND');
  return identityFromSettings(s);
}

export function identityFromSettings(s: { brokerage_legal_name: string | null; team_name: string | null; brokerage_license_number: string | null; brokerage_postal_address: string | null; operating_jurisdictions: string[] | null; default_timezone?: string; tenant_name?: string }): BrokerageIdentity & { jurisdictions: string[]; timezone: string } {
  return {
    brokerageLegalName: s.brokerage_legal_name ?? '',
    teamName: s.team_name ?? s.tenant_name ?? s.brokerage_legal_name ?? '',
    licenseNumber: s.brokerage_license_number,
    brokerageAddress: s.brokerage_postal_address,
    jurisdictions: s.operating_jurisdictions ?? ['US'],
    timezone: s.default_timezone ?? 'UTC',
  };
}

/** Published advertising packs for the jurisdictions (every pack that governs them; none ⇒ the strictest default). */
export async function advertisingPacks(tx: Tx, jurisdictions: readonly string[]): Promise<AdvertisingPack[]> {
  const keys = [...new Set(jurisdictions.flatMap((j) => (j.includes('-') ? [j.split('-')[0]!, j] : [j])))];
  const r = await sql<{ key: string; rules: Record<string, unknown>; reviewed_by_counsel_at: Date | null }>`
    SELECT key, rules, reviewed_by_counsel_at FROM jurisdiction_packs WHERE status = 'published' AND key = ANY (${keys}::text[]) ORDER BY key`.execute(tx);
  return r.rows.filter((p) => p.rules['advertising'] !== undefined).map((p) => advertisingPackFrom(p.key, p.rules['advertising'], p.reviewed_by_counsel_at?.toISOString() ?? null));
}

/** The fair-housing pack (platform:fair_housing + jurisdiction additions). An invalid pack fails closed. */
export async function fairHousingPack(tx: Tx, jurisdictions: readonly string[]): Promise<FairHousingPack> {
  const p = await sql<{ rules: unknown; reviewed_by_counsel_at: Date | null }>`
    SELECT rules, reviewed_by_counsel_at FROM jurisdiction_packs WHERE key = 'platform:fair_housing' AND status = 'published'`.execute(tx);
  const base = p.rows[0];
  if (!base) throw new AppError('FAIR_HOUSING_PACK_UNAVAILABLE');
  // every pack that governs the jurisdictions: the country pack too for a state ('US' for 'US-SC'), as the advertising packs
  const keys = [...new Set(jurisdictions.flatMap((j) => (j.includes('-') ? [j.split('-')[0]!, j] : [j])))];
  const adds = await sql<{ rules: Record<string, unknown> }>`SELECT rules FROM jurisdiction_packs WHERE status = 'published' AND key = ANY (${keys}::text[]) ORDER BY key`.execute(tx);
  const r = fairHousingPackFrom({ rules: base.rules, reviewedByCounselAt: base.reviewed_by_counsel_at?.toISOString() ?? null }, adds.rows.map((x) => x.rules['fair_housing']).filter((x) => x !== undefined));
  if (!r.ok) throw new AppError('FAIR_HOUSING_PACK_UNAVAILABLE');
  return r.pack;
}

export async function platformCleared(tx: Tx, key: string): Promise<boolean> {
  return (await sql<{ ok: boolean }>`SELECT app.platform_cleared(${key}) AS ok`.execute(tx)).rows[0]?.ok === true;
}

/** The DB's own content hash of a draft as it is stored now (prose, template, bound fields, ordered assets). */
export async function contentSha256(tx: Tx, pieceId: string): Promise<string> {
  const r = await sql<{ h: string }>`SELECT app.marketing_content_sha256(tenant_id, id, prose, template_key, bound_fields) AS h
     FROM marketing_pieces WHERE tenant_id = app.tenant_id() AND id = ${pieceId}`.execute(tx);
  const h = r.rows[0]?.h;
  if (!h) throw new AppError('NOT_FOUND');
  return h;
}

export async function nextVersionNo(tx: Tx, listingId: string, kind: PieceKind): Promise<number> {
  const r = await sql<{ n: number }>`SELECT COALESCE(max(version_no), 0)::int + 1 AS n FROM marketing_pieces WHERE tenant_id = app.tenant_id() AND listing_id = ${listingId} AND kind = ${kind}`.execute(tx);
  return r.rows[0]?.n ?? 1;
}

export async function lockListingKind(tx: Tx, listingId: string, kind: PieceKind): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended(${`marketing:${listingId}:${kind}`}, 29))`.execute(tx);
}

export interface PublicationRow {
  id: string;
  piece_id: string;
  connection_id: string;
  status: 'publishing' | 'published' | 'failed' | 'unknown' | 'retracted';
  external_post_id: string | null;
  error_code: string | null;
  requested_by_user_id: string;
  requested_at: Date;
  published_at: Date | null;
  retracted_at: Date | null;
  /** 0054: the retraction in flight (one caller calls the provider), or null */
  retract_claim_id: string | null;
  connection_kind: string;
  connection_name: string;
  connection_status: string;
}

const PUB_COLS = sql`p.id, p.piece_id, p.connection_id, p.status, p.external_post_id, p.error_code, p.requested_by_user_id, p.requested_at, p.published_at, p.retracted_at,
  p.retract_claim_id, c.kind AS connection_kind, c.display_name AS connection_name, c.status AS connection_status`;

export async function publicationsOfPieces(tx: Tx, pieceIds: readonly string[]): Promise<PublicationRow[]> {
  if (pieceIds.length === 0) return [];
  return (
    await sql<PublicationRow>`SELECT ${PUB_COLS} FROM marketing_publications p JOIN integration_connections c ON c.tenant_id = p.tenant_id AND c.id = p.connection_id
      WHERE p.tenant_id = app.tenant_id() AND p.piece_id = ANY (${pieceIds}::uuid[]) ORDER BY p.requested_at, p.id`.execute(tx)
  ).rows;
}

export async function publicationById(tx: Tx, id: string, o: { forUpdate?: boolean } = {}): Promise<PublicationRow | null> {
  const r = await sql<PublicationRow>`SELECT ${PUB_COLS} FROM marketing_publications p JOIN integration_connections c ON c.tenant_id = p.tenant_id AND c.id = p.connection_id
     WHERE p.tenant_id = app.tenant_id() AND p.id = ${id} ${o.forUpdate ? sql`FOR UPDATE OF p` : sql``}`.execute(tx);
  return r.rows[0] ?? null;
}

export interface TargetRow {
  id: string;
  kind: string;
  status: string;
  display_name: string;
  external_account_id: string | null;
  credential_id: string | null;
}

/** Facebook Page / Instagram business connections of the tenant (any status: the UI says which are not connected). */
export async function publishTargets(tx: Tx): Promise<TargetRow[]> {
  return (
    await sql<TargetRow>`SELECT id, kind, status, display_name, external_account_id, credential_id FROM integration_connections
      WHERE tenant_id = app.tenant_id() AND kind IN ('facebook_page','instagram_business') AND status NOT IN ('disconnected','revoked') ORDER BY kind, display_name, id`.execute(tx)
  ).rows;
}

export async function targetById(tx: Tx, id: string): Promise<TargetRow | null> {
  const r = await sql<TargetRow>`SELECT id, kind, status, display_name, external_account_id, credential_id FROM integration_connections WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  return r.rows[0] ?? null;
}

export async function credentialSecret(tx: Tx, credentialId: string): Promise<Buffer | null> {
  const r = await sql<{ secret_enc: Buffer | null; status: string }>`SELECT secret_enc, status FROM provider_credentials WHERE tenant_id = app.tenant_id() AND id = ${credentialId}`.execute(tx);
  const c = r.rows[0];
  return c && c.status === 'active' ? c.secret_enc : null;
}

export async function listingIsTeam(tx: Tx, listingId: string): Promise<boolean> {
  const r = await sql<{ ok: boolean }>`SELECT source = 'team' AS ok FROM listings WHERE tenant_id = app.tenant_id() AND id = ${listingId}`.execute(tx);
  return r.rows[0]?.ok === true;
}

export type { ListingId };
