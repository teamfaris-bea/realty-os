// The public listing page (module 29; DATA_MODEL R-MKT-7, R-MKT-9, R-MKT-3, R-INT-6; E90, E91).
//
//   GET /p/:tenantSlug/:pageSlug                     the page (HTML)                          public, rate-limited
//   GET /p/:tenantSlug/:pageSlug/photos/:position    one of the page's images                 public, rate-limited
//   GET /api/public/marketing-assets/:token          a short-lived signed image link (routes.ts; Instagram fetches it)
//
// Viewers are not principals (ARCHITECTURE §21.1). The page is read ONLY through app.public_listing_page (0050 definer):
// the approved prose, the bound facts of the team listing (rendered live by core renderPiece: a price change shows at
// once, no re-approval, E90), the identity block and the piece's own assets through marketing_piece_assets. Never
// contact data, never the listing agent, never another piece. A retracted page or an off-market listing is 410 with its
// notice (E91); anything else unknown is 404 (no oracle on which tenants or slugs exist beyond "not here").
// The live rendering is guarded once more (R-MKT-4): a page whose brokerage name, fair-housing check or pack rules no
// longer pass is not served (404) and the reconcile handler takes it down within the hour.
// Abuse: both slugs are shape-checked before any query; DB-backed rate limits per IP and per page; text is
// HTML-escaped; the page has a strict CSP (no script; images from this origin; one hashed stylesheet); responses are
// cacheable for a minute only.
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { type Instant, type TenantId, MINUTE_MS } from '@realty/core/foundation';
import { type BrokerageIdentity, type PieceVersion, guardResult, renderPiece } from '@realty/core/marketing';
import type { ListingFacts } from '@realty/core/listings';
import { type Tx, withPreTenant, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { type Limit, enforceLimits } from '../auth/rateLimit.js';
import { getObject } from '../crypto/objects.js';
import { AppError } from '../errors.js';
import type { Platform } from '../server.js';
import { systemActor } from '../worker/systemActor.js';
import { verifyAssetLink } from './assetLinks.js';
import * as repo from './repo.js';

const TENANT_SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const PAGE_SLUG_RE = /^[a-z0-9][a-z0-9-]{2,80}$/;

// Per IP only: a per-page budget shared by everyone would let one client take a listing page offline for all visitors.
// Photos have their own, larger budget (a page shows up to 50), so viewing images never uses up the page budget.
export const PAGE_LIMITS = (ip: string): Limit[] => [
  { kind: 'listing_page_ip', parts: [ip], max: 120, windowSeconds: 60 },
  { kind: 'listing_page_ip_hour', parts: [ip], max: 2000, windowSeconds: 3600 },
];
export const PHOTO_LIMITS = (ip: string): Limit[] => [
  { kind: 'listing_photo_ip', parts: [ip], max: 1200, windowSeconds: 60 },
  { kind: 'listing_photo_ip_hour', parts: [ip], max: 20000, windowSeconds: 3600 },
];
export const ASSET_LIMITS = (ip: string): Limit[] => [{ kind: 'marketing_asset_ip', parts: [ip], max: 600, windowSeconds: 60 }];

interface PageRow {
  state: 'live' | 'gone';
  notice: string | null;
  tenant_id: string | null;
  piece_id: string | null;
  version_no: number | null;
  prose: Record<string, unknown> | null;
  template_key: string | null;
  bound_fields: string[] | null;
  listing_status: ListingFacts['status'] | null;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  region: string | null;
  postal_code: string | null;
  list_price_cents: string | null;
  beds: number | null;
  baths_x10: number | null;
  sqft: number | null;
  property_type: ListingFacts['propertyType'] | null;
  brokerage_legal_name: string | null;
  team_name: string | null;
  brokerage_license_number: string | null;
  brokerage_postal_address: string | null;
  operating_jurisdictions: string[] | null;
  asset_object_ids: string[] | null;
}

/** The one pre-tenant read (definer). */
export async function lookupPage(tx: Tx, tenantSlug: string, pageSlug: string): Promise<PageRow | null> {
  if (!TENANT_SLUG_RE.test(tenantSlug) || !PAGE_SLUG_RE.test(pageSlug)) return null;
  const r = await sql<PageRow>`SELECT * FROM app.public_listing_page(${tenantSlug}, ${pageSlug})`.execute(tx);
  return r.rows[0] ?? null;
}

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

const STYLE = `body{margin:0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#1d1d1f;background:#fff;line-height:1.5}
main{max-width:46rem;margin:0 auto;padding:1.25rem}
.display{font-size:2rem;font-weight:700;margin:.5rem 0}.heading{font-size:1.35rem;font-weight:600;margin:.5rem 0}
.body{font-size:1.05rem;margin:.5rem 0;white-space:pre-line}.small{font-size:.9rem;color:#444;margin:.25rem 0}.footnote{font-size:.8rem;color:#555;margin:.2rem 0}
.gallery{display:grid;gap:.5rem;grid-template-columns:repeat(auto-fill,minmax(14rem,1fr));margin:1rem 0}.gallery img{width:100%;height:auto;border-radius:.5rem}
footer{border-top:1px solid #ddd;margin-top:1.5rem;padding-top:1rem}`;
const STYLE_HASH = `'sha256-${createHash('sha256').update(STYLE).digest('base64')}'`;
const CSP = `default-src 'none'; img-src 'self'; style-src ${STYLE_HASH}; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;

function htmlDoc(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noarchive"><title>${esc(title)}</title><style>${STYLE}</style></head><body><main>${body}</main></body></html>`;
}

function send(reply: FastifyReply, status: number, html: string, cacheSeconds: number): FastifyReply {
  return reply
    .code(status)
    .header('content-type', 'text/html; charset=utf-8')
    .header('content-security-policy', CSP)
    .header('cache-control', cacheSeconds > 0 ? `public, max-age=${cacheSeconds}` : 'no-store')
    .header('x-content-type-options', 'nosniff')
    .header('referrer-policy', 'no-referrer')
    .send(html);
}

function factsOf(p: PageRow): ListingFacts {
  return {
    id: null,
    source: 'team',
    listingKey: null,
    mlsNumber: null,
    status: p.listing_status!,
    addressLine1: p.address_line1 ?? '',
    addressLine2: p.address_line2,
    city: p.city ?? '',
    region: p.region ?? '',
    postalCode: p.postal_code ?? '',
    listPriceCents: p.list_price_cents === null ? null : Number(p.list_price_cents),
    beds: p.beds,
    bathsX10: p.baths_x10,
    sqft: p.sqft,
    propertyType: p.property_type,
    description: null,
    listDate: null,
    mlsConnectionId: null,
    mlsModifiedAt: null,
    listingBrokerageName: null,
    displayAllowed: true,
    addressDisplayAllowed: true,
    photoUrls: [],
    photosCount: null,
    teamListingId: null,
    lastSeenInFeedAt: null,
    offMarketAt: null,
  };
}

export interface RenderedPage {
  title: string;
  html: string;
}

/** The live page, rendered from the definer's row only; null when the live re-check fails (R-MKT-4). */
export async function renderLivePage(tx: Tx, p: PageRow, base: string): Promise<RenderedPage | null> {
  const identity: BrokerageIdentity = repo.identityFromSettings({ ...p, tenant_name: p.team_name ?? undefined });
  const jurisdictions = p.operating_jurisdictions ?? ['US'];
  const [advertising, fh] = await Promise.all([repo.advertisingPacks(tx, jurisdictions), repo.fairHousingPack(tx, jurisdictions)]);
  const version: PieceVersion = {
    kind: 'website_page',
    versionNo: p.version_no ?? 1,
    prose: p.prose ?? {},
    templateKey: p.template_key ?? '',
    boundFields: (p.bound_fields ?? []) as PieceVersion['boundFields'],
    assets: (p.asset_object_ids ?? []).map((objectId, i) => ({ objectId: objectId as never, position: i + 1 })),
  };
  const r = renderPiece(version, factsOf(p), identity, { advertising });
  if (!r.ok) return null;
  const g = guardResult(r, identity, { advertising }, fh, '0'.repeat(64));
  if (!g.brokerage_name_present || g.hard_count > 0 || g.pack_rule_failures.length > 0) return null;
  const parts: string[] = [];
  let footer = false;
  for (const b of r.blocks) {
    if (b.role === 'gallery') {
      parts.push(`<div class="gallery">${r.images.map((img, i) => `<img src="${esc(base)}/photos/${i + 1}" alt="Photo ${i + 1} of the home" loading="lazy">`).join('')}</div>`);
      continue;
    }
    if (!footer && (b.origin === 'identity' || b.origin === 'pack')) {
      parts.push('<footer>');
      footer = true;
    }
    const tag = b.prominence === 'display' ? 'h1' : b.prominence === 'heading' && b.origin !== 'identity' ? 'h2' : 'p';
    parts.push(`<${tag} class="${b.prominence}">${esc(b.text)}</${tag}>`);
  }
  if (footer) parts.push('</footer>');
  const title = r.blocks.find((b) => b.role === 'headline')?.text ?? 'Listing';
  return { title, html: htmlDoc(title, parts.join('')) };
}

const asSystem = <T>(db: Platform['db'], tenantId: string, fn: (tx: Tx, now: Instant) => Promise<T>) => withTenantTx(systemActor(tenantId, 'provider'), fn, { db, retries: 1 });
// the one pre-tenant read: no tenant context (every tenant table reads as empty); only the definer answers
const preTenant = <T>(db: Platform['db'], fn: (tx: Tx) => Promise<T>) => withPreTenant((tx) => fn(tx), { db });

async function limit(p: Platform, limits: Limit[]): Promise<boolean> {
  try {
    await enforceLimits(p.db, p.config.sessionSecret, limits, p.publicPageLimitClock);
    return true;
  } catch (e) {
    if (e instanceof AppError && e.code === 'RATE_LIMITED') return false;
    throw e;
  }
}

/** One line in server.ts registers the public page routes (outside /api: a page is a document, not an API). */
export function registerPublicListingPages(app: FastifyInstance): void {
  app.get('/p/:tenantSlug/:pageSlug', async (req: FastifyRequest, reply) => {
    const { tenantSlug, pageSlug } = req.params as { tenantSlug: string; pageSlug: string };
    const p = app.platform;
    if (!TENANT_SLUG_RE.test(tenantSlug) || !PAGE_SLUG_RE.test(pageSlug)) return send(reply, 404, htmlDoc('Not found', '<p class="body">This page does not exist.</p>'), 0);
    if (!(await limit(p, PAGE_LIMITS(req.ip)))) return send(reply.header('retry-after', '60'), 429, htmlDoc('Too many requests', '<p class="body">Too many requests. Try again in a minute.</p>'), 0);
    const row = await preTenant(p.db, (tx) => lookupPage(tx, tenantSlug, pageSlug));
    if (!row) return send(reply, 404, htmlDoc('Not found', '<p class="body">This page does not exist.</p>'), 0);
    if (row.state === 'gone') return send(reply, 410, htmlDoc('No longer available', `<p class="heading">${esc(row.notice ?? 'This page is no longer available.')}</p>`), 60);
    const page = await asSystem(p.db, row.tenant_id!, (tx) => renderLivePage(tx, row, `/p/${tenantSlug}/${pageSlug}`));
    if (!page) return send(reply, 404, htmlDoc('Not found', '<p class="body">This page is being updated.</p>'), 0);
    return send(reply, 200, page.html, 60);
  });

  app.get('/p/:tenantSlug/:pageSlug/photos/:position', async (req: FastifyRequest, reply) => {
    const { tenantSlug, pageSlug, position } = req.params as { tenantSlug: string; pageSlug: string; position: string };
    const p = app.platform;
    const pos = /^[1-9][0-9]?$/.test(position) ? Number(position) : NaN;
    if (!TENANT_SLUG_RE.test(tenantSlug) || !PAGE_SLUG_RE.test(pageSlug) || !(pos >= 1 && pos <= 50)) return reply.code(404).header('cache-control', 'no-store').send();
    if (!(await limit(p, PHOTO_LIMITS(req.ip)))) return reply.code(429).header('retry-after', '60').send();
    const row = await preTenant(p.db, (tx) => lookupPage(tx, tenantSlug, pageSlug));
    const objectId = row?.state === 'live' ? row.asset_object_ids?.[pos - 1] : undefined;
    if (!row || !objectId) return reply.code(row?.state === 'gone' ? 410 : 404).header('cache-control', 'no-store').send();
    const img = await asSystem(p.db, row.tenant_id!, (tx) => readAsset(tx, p, row.tenant_id!, objectId));
    if (!img) return reply.code(404).header('cache-control', 'no-store').send();
    return reply.code(200).header('content-type', img.contentType).header('cache-control', 'public, max-age=300').header('x-content-type-options', 'nosniff').send(Buffer.from(img.bytes));
  });
}

/** A marketing asset's bytes, only while it is a live asset of some piece of this tenant (as the tenant's system). */
export async function readAsset(tx: Tx, p: Pick<Platform, 'envelope' | 'providers'>, tenantId: string, objectId: string): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const r = await sql<{ storage_key: string; dek_wrapped: Buffer | null; content_type: string }>`
    SELECT o.storage_key, o.dek_wrapped, o.content_type FROM stored_objects o
     WHERE o.tenant_id = app.tenant_id() AND o.id = ${objectId} AND o.purpose = 'marketing_asset' AND o.deleted_at IS NULL
       AND EXISTS (SELECT 1 FROM marketing_piece_assets a JOIN marketing_pieces mp ON mp.tenant_id = a.tenant_id AND mp.id = a.piece_id
                    WHERE a.tenant_id = o.tenant_id AND a.object_id = o.id AND mp.status IN ('approved','published','exported'))`.execute(tx);
  const o = r.rows[0];
  if (!o || !o.dek_wrapped) return null;
  const bytes = await getObject(p.envelope.inTx(tx, tenantId as TenantId), p.providers.storage, tenantId as TenantId, objectId, o.storage_key, new Uint8Array(o.dek_wrapped));
  return bytes ? { bytes, contentType: o.content_type } : null;
}

/** GET /api/public/marketing-assets/:token (routes.ts): a signed, expiring image link for the provider to fetch. */
export async function signedAsset(p: Platform, token: string, ip: string, now: number): Promise<{ bytes: Uint8Array; contentType: string } | null> {
  const link = verifyAssetLink(p.config.sessionSecret, token, now);
  if (!link) return null;
  if (!(await limit(p, ASSET_LIMITS(ip)))) throw new AppError('RATE_LIMITED', { retryAfterSeconds: 60 });
  return asSystem(p.db, link.tenantId, (tx) => readAsset(tx, p, link.tenantId, link.objectId));
}

export { MINUTE_MS };
