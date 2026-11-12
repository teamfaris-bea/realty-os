// Module 29 routes (api/marketing). Mounted under /api by routes.ts; the public page is outside /api (publicPage.ts,
// registered by one line in server.ts).
//
//   GET  /listings/:id/marketing                       the listing's pieces, publications, targets   listing.view
//   POST /listings/:id/marketing/generate              drafts of the Phase 2 kinds {kinds?, openHouse?} listing.edit
//   POST /listings/:id/marketing/assets                upload one image (PNG/JPEG/WebP ≤ 10 MB)    listing.edit
//   GET  /marketing/approvals                          drafts the caller may approve (approvals inbox) self
//   GET  /marketing-pieces/:id                         one piece                                   listing.view
//   PATCH /marketing-pieces/:id                        {prose?, assetObjectIds?, openHouse?}       listing.edit
//   POST /marketing-pieces/:id/approve                 {contentSha256}: one tap                    listing.edit
//   POST /marketing-pieces/:id/publish                 page live / {connectionId}: publishPost     listing.edit
//   POST /marketing-pieces/:id/export                  "Exported: post it yourself"                listing.edit
//   POST /marketing-pieces/:id/retract                 page down / {publicationId?}: delete posts   listing.edit
//   POST /marketing-pieces/:id/invite/send             {recipientContactIds}: gated emails         listing.edit
//   GET  /marketing-pieces/:id/flyer.pdf               the approved flyer (DocumentRenderer)       listing.view
//   GET  /marketing-pieces/:id/assets/:position        one image of the piece                      listing.view
//   GET  /public/marketing-assets/:token               a signed, expiring image link (providers)   public
//
// listing.edit = the listing's writers (Owner, Admin, Team Lead; an agent for their own listings: DATA_MODEL §7
// "Approve a marketing piece", "Publish a post"). Every handler runs as the session user under FORCE RLS (another
// tenant's ids are 404), CSRF/Origin are the global guard's, and no response carries a tenant id or a confidence.
import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { PIECE_KINDS } from '@realty/core/marketing';
import type { TenantId } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { adminTx } from '../admin/common.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { putObject } from '../crypto/objects.js';
import { AppError } from '../errors.js';
import { actorOf, platformOf } from '../leads/common.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import type { Platform } from '../server.js';
import { listingFacts as listingResourceFacts } from '../workspace/listings.js';
import { syncReviewCards } from './cards.js';
import { flyerPdf } from './flyer.js';
import { sendInvites, MAX_INVITE_RECIPIENTS } from './invites.js';
import {
  ASSET_MAX_BYTES,
  ASSET_TYPES,
  approvePiece,
  assetObject,
  exportPiece,
  generate,
  insertAssetObject,
  listingPieces,
  onePiece,
  patchPiece,
  pendingApprovals,
  publishPage,
  retractPage,
  tenantSlug,
} from './pieces.js';
import { type PublishDeps, publishPost, retractAllOf, retractPublication } from './publish.js';
import { readAsset, signedAsset } from './publicPage.js';
import { getObject } from '../crypto/objects.js';
import * as repo from './repo.js';
import { systemActor } from '../worker/systemActor.js';

const IdParams = z.strictObject({ id: z.uuid() });
const AssetParams = z.strictObject({ id: z.uuid(), position: z.coerce.number().int().min(1).max(50) });
const TokenParams = z.strictObject({ assetToken: z.string().min(10).max(400) });
const Kind = z.enum(PIECE_KINDS);
const LocalTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const OpenHouse = z.union([z.strictObject({ startsAt: z.iso.datetime({ offset: true }), endsAt: z.iso.datetime({ offset: true }) }), z.strictObject({ localStart: LocalTime, localEnd: LocalTime })]);
const Sha = z.string().regex(/^[0-9a-f]{64}$/);

export const GenerateBody = z.strictObject({ kinds: z.array(Kind).min(1).max(PIECE_KINDS.length).optional(), openHouse: OpenHouse.optional() });
export const PatchBody = z.strictObject({
  prose: z.record(z.string(), z.unknown()).optional(),
  assetObjectIds: z.array(z.uuid()).max(50).optional(),
  openHouse: OpenHouse.nullable().optional(),
});
export const ApproveBody = z.strictObject({ contentSha256: Sha });
export const PublishBody = z.strictObject({ connectionId: z.uuid().optional() });
export const RetractBody = z.strictObject({ publicationId: z.uuid().optional() });
export const InviteBody = z.strictObject({ recipientContactIds: z.array(z.uuid()).min(1).max(MAX_INVITE_RECIPIENTS) });

const PublicationSchema = z.object({
  id: z.uuid(),
  connectionId: z.uuid(),
  targetKind: z.string(),
  targetName: z.string(),
  status: z.enum(['publishing', 'published', 'failed', 'unknown', 'retracted']),
  posted: z.boolean(),
  label: z.string(),
  requestedAt: z.string(),
  publishedAt: z.string().nullable(),
});
const OptionSchema = z.union([
  z.object({ kind: z.literal('publish'), connectionId: z.uuid(), target: z.enum(['facebook_page', 'instagram_business']), displayName: z.string() }),
  z.object({ kind: z.literal('export'), connectionId: z.uuid().nullable(), reason: z.string(), sentence: z.string() }),
]);
export const PieceSchema = z.object({
  id: z.uuid(),
  listingId: z.uuid(),
  kind: Kind,
  versionNo: z.number(),
  status: z.enum(['draft', 'approved', 'published', 'exported', 'retracted', 'superseded']),
  statusLabel: z.string(),
  prose: z.record(z.string(), z.unknown()),
  templateKey: z.string(),
  boundFields: z.array(z.string()),
  contentSha256: z.string(),
  openHouse: z.object({ startsAt: z.string(), endsAt: z.string(), zone: z.string() }).nullable(),
  timezone: z.string(),
  preview: z.object({ text: z.string(), blocks: z.array(z.object({ role: z.string(), origin: z.string(), prominence: z.string(), text: z.string() })) }).nullable(),
  assets: z.array(z.object({ position: z.number(), objectId: z.uuid(), url: z.string() })),
  guard: z.object({ approvable: z.boolean(), reasons: z.array(z.string()), checkThis: z.boolean(), soft: z.array(z.string()), fairHousingReviewed: z.boolean() }),
  approvedAt: z.string().nullable(),
  publishedAt: z.string().nullable(),
  exportedAt: z.string().nullable(),
  retractedAt: z.string().nullable(),
  publicPath: z.string().nullable(),
  publications: z.array(PublicationSchema),
  publishOptions: z.array(OptionSchema),
  earlierPostNotice: z.string().nullable(),
  exportable: z.boolean(),
  invitable: z.boolean(),
});
export const ListingMarketingResponse = z.object({
  pieces: z.array(PieceSchema),
  targets: z.array(z.object({ id: z.uuid(), kind: z.string(), status: z.string(), displayName: z.string() })),
  publishingCleared: z.boolean(),
  fairHousingReviewSentence: z.string(),
});
export const PieceResponse = z.object({ piece: PieceSchema });
export const PatchResponse = z.object({ piece: PieceSchema, newVersion: z.boolean() });
export const PiecesResponse = z.object({ pieces: z.array(PieceSchema) });
export const PublishResponse = z.object({ piece: PieceSchema, publication: PublicationSchema.nullable() });
export const ExportResponse = z.object({
  piece: PieceSchema,
  export: z.object({ text: z.string(), label: z.string(), flags: z.array(z.string()), images: z.array(z.object({ position: z.number(), url: z.string() })), flyerUrl: z.string().nullable() }),
});
export const RetractResponse = z.object({ piece: PieceSchema, retracted: z.number(), removeYourself: z.number() });
export const InviteResponse = z.object({
  sent: z.number(),
  total: z.number(),
  optedOut: z.number(),
  blocked: z.number(),
  noEmail: z.number(),
  alreadyInvited: z.number(),
  text: z.string(),
  recipients: z.array(z.object({ contactId: z.uuid(), outcome: z.enum(['sent', 'opted_out', 'blocked', 'no_email', 'already_invited']), messageId: z.uuid().nullable() })),
});
export const AssetResponse = z.object({ objectId: z.uuid() });

export function publishDepsOf(p: Platform): PublishDeps {
  return { db: p.db, envelope: p.envelope, ids: p.ids, social: p.providers.integrations.social, publicBaseUrl: p.config.publicBaseUrl, linkSecret: p.config.sessionSecret };
}

const tx = <T>(req: FastifyRequest, fn: Parameters<typeof adminTx<T>>[1]) => adminTx(req, fn);

/** The facts `authorize` reads for a piece: its listing's (own = the caller is its listing agent). */
async function pieceFacts(req: FastifyRequest) {
  const id = (req.params as { id: string }).id;
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  return tx(req, async (t) => {
    const r = await sql<{ listing_id: string }>`SELECT listing_id FROM marketing_pieces WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(t);
    const l = r.rows[0]?.listing_id;
    return l ? listingResourceFacts(t, l) : null;
  });
}

/** System-side card sync for a listing (the agent's feed; a TL may act on an agent's listing). */
async function syncCards(p: Platform, tenantId: string, listingId: string): Promise<void> {
  await withTenantTx(systemActor(tenantId, 'worker'), (t) => syncReviewCards(t, p.ids, listingId), { db: p.db, retries: 2 });
}

async function listingOfPiece(req: FastifyRequest, pieceId: string): Promise<string> {
  return tx(req, async (t) => {
    const p = await repo.pieceById(t, pieceId);
    if (!p) throw new AppError('NOT_FOUND');
    return p.listing_id;
  });
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const listingIdOf = (req: FastifyRequest) => (req.params as { id: string }).id;
  const listingView = authorize('listing.view', (req) => tx(req, (t) => listingResourceFacts(t, listingIdOf(req))));
  const listingEdit = authorize('listing.edit', (req) => tx(req, (t) => listingResourceFacts(t, listingIdOf(req))));
  const pieceView = authorize('listing.view', pieceFacts);
  const pieceEdit = authorize('listing.edit', pieceFacts);
  const view = { config: { auth: 'listing.view' as const }, preHandler: pieceView };
  const edit = { config: { auth: 'listing.edit' as const }, preHandler: pieceEdit };
  const piece = (req: FastifyRequest, id: string) => tx(req, async (t) => onePiece(t, id, await tenantSlug(t)));

  // images: raw bytes, magic-checked (only for this plugin's routes)
  for (const type of Object.keys(ASSET_TYPES)) app.addContentTypeParser(type, { parseAs: 'buffer', bodyLimit: ASSET_MAX_BYTES }, (_req, body, done) => done(null, body));

  r.get('/listings/:id/marketing', { config: { auth: 'listing.view' }, preHandler: listingView, schema: { params: IdParams, response: { 200: ListingMarketingResponse } } }, async (req) =>
    tx(req, async (t) => listingPieces(t, req.params.id, await tenantSlug(t))),
  );

  r.post('/listings/:id/marketing/generate', { config: { auth: 'listing.edit' }, preHandler: listingEdit, schema: { params: IdParams, body: GenerateBody, response: { 200: PiecesResponse } } }, async (req) => {
    const actor = actorOf(req);
    await tx(req, (t) => generate(t, actor, req.params.id, req.body));
    await syncCards(platformOf(req), actor.tenantId, req.params.id);
    return tx(req, async (t) => ({ pieces: (await listingPieces(t, req.params.id, await tenantSlug(t))).pieces.filter((p) => p.status === 'draft') }));
  });

  r.post('/listings/:id/marketing/assets', { config: { auth: 'listing.edit' }, preHandler: listingEdit, bodyLimit: ASSET_MAX_BYTES, schema: { params: IdParams, response: { 201: AssetResponse } } }, async (req, reply) => {
    const actor = actorOf(req);
    const p = platformOf(req);
    const type = String(req.headers['content-type'] ?? '').split(';')[0]!.trim().toLowerCase();
    const body = req.body as unknown;
    if (!Buffer.isBuffer(body) || !ASSET_TYPES[type]) throw new AppError('UNSUPPORTED_MEDIA_TYPE');
    const bytes = new Uint8Array(body);
    if (!ASSET_TYPES[type]!(bytes)) throw new AppError('MARKETING_ASSET_INVALID');
    if (!(await tx(req, (t) => repo.listingIsTeam(t, req.params.id)))) throw new AppError('MARKETING_TEAM_LISTING_ONLY');
    const id = randomUUID();
    const objectId = await withTenantTx(
      actor,
      async (t) => {
        const sealed = await putObject(p.envelope.inTx(t, actor.tenantId as TenantId), p.providers.storage, actor.tenantId as TenantId, id, 'marketing_asset', bytes, type);
        await insertAssetObject(t, { id, storageKey: sealed.storageKey, contentType: type, byteSize: sealed.byteSize, sha256: sealed.sha256, dekWrapped: sealed.dekWrapped, keyVersion: sealed.keyVersion });
        return id;
      },
      { db: p.db },
    );
    return reply.code(201).send({ objectId });
  });

  r.get('/marketing/approvals', { config: { auth: 'self' }, schema: { response: { 200: PiecesResponse } } }, async (req) => tx(req, async (t) => ({ pieces: await pendingApprovals(t, await tenantSlug(t)) })));

  r.get('/marketing-pieces/:id', { ...view, schema: { params: IdParams, response: { 200: PieceResponse } } }, async (req) => ({ piece: await piece(req, req.params.id) }));

  r.patch('/marketing-pieces/:id', { ...edit, bodyLimit: 64 * 1024, schema: { params: IdParams, body: PatchBody, response: { 200: PatchResponse } } }, async (req) => {
    const actor = actorOf(req);
    const out = await tx(req, (t) => patchPiece(t, actor, req.params.id, req.body));
    await syncCards(platformOf(req), actor.tenantId, await listingOfPiece(req, out.pieceId));
    return { piece: await piece(req, out.pieceId), newVersion: out.newVersion };
  });

  r.post('/marketing-pieces/:id/approve', { ...edit, schema: { params: IdParams, body: ApproveBody, response: { 200: PieceResponse } } }, async (req) => {
    const actor = actorOf(req);
    await tx(req, (t, now) => approvePiece(t, actor, req.params.id, req.body.contentSha256, now));
    await syncCards(platformOf(req), actor.tenantId, await listingOfPiece(req, req.params.id));
    return { piece: await piece(req, req.params.id) };
  });

  r.post('/marketing-pieces/:id/publish', { ...edit, schema: { params: IdParams, body: PublishBody, response: { 200: PublishResponse } } }, async (req) => {
    const actor = actorOf(req);
    const kind = await tx(req, async (t) => (await repo.pieceById(t, req.params.id))?.kind ?? null);
    if (!kind) throw new AppError('NOT_FOUND');
    if (kind === 'website_page') {
      if (req.body.connectionId) throw new AppError('PUBLISH_TARGET_INVALID');
      await tx(req, (t, now) => publishPage(t, actor, req.params.id, now));
      return { piece: await piece(req, req.params.id), publication: null };
    }
    if (!req.body.connectionId) throw new AppError('VALIDATION_FAILED', { issues: [{ path: '/connectionId', code: 'required' }] });
    const out = await publishPost(publishDepsOf(platformOf(req)), actor, req.params.id, req.body.connectionId);
    const pv = await piece(req, req.params.id);
    return { piece: pv, publication: pv.publications.find((x) => x.id === out.publicationId) ?? null };
  });

  r.post('/marketing-pieces/:id/export', { ...edit, schema: { params: IdParams, response: { 200: ExportResponse } } }, async (req) => {
    const actor = actorOf(req);
    const ex = await tx(req, (t, now) => exportPiece(t, actor, req.params.id, now));
    return { piece: await piece(req, req.params.id), export: ex };
  });

  r.post('/marketing-pieces/:id/retract', { ...edit, schema: { params: IdParams, body: RetractBody, response: { 200: RetractResponse } } }, async (req) => {
    const actor = actorOf(req);
    const deps = publishDepsOf(platformOf(req));
    const p = await tx(req, (t) => repo.pieceById(t, req.params.id));
    if (!p) throw new AppError('NOT_FOUND');
    if (p.kind === 'website_page') {
      await tx(req, (t, now) => retractPage(t, actor, req.params.id, now));
      return { piece: await piece(req, req.params.id), retracted: 1, removeYourself: 0 };
    }
    let out: { retracted: number; removeYourself: number };
    if (req.body.publicationId) {
      const pub = await tx(req, (t) => repo.publicationById(t, req.body.publicationId!));
      if (!pub || pub.piece_id !== p.id) throw new AppError('NOT_FOUND');
      const r1 = await retractPublication(deps, actor.tenantId, pub.id, actor);
      if (r1.outcome === 'not_live') throw new AppError('PUBLICATION_NOT_LIVE');
      out = { retracted: r1.outcome === 'retracted' ? 1 : 0, removeYourself: r1.outcome === 'remove_yourself' ? 1 : 0 };
    } else {
      out = await retractAllOf(deps, actor.tenantId, p.id, actor);
    }
    return { piece: await piece(req, req.params.id), ...out };
  });

  r.post('/marketing-pieces/:id/invite/send', { ...edit, bodyLimit: 128 * 1024, schema: { params: IdParams, body: InviteBody, response: { 200: InviteResponse } } }, async (req) => sendInvites(depsFromPlatform(platformOf(req)), actorOf(req), req.params.id, req.body.recipientContactIds));

  r.get('/marketing-pieces/:id/flyer.pdf', { ...view, schema: { params: IdParams } }, async (req, reply) => {
    const p = platformOf(req);
    const actor = actorOf(req);
    const pdf = await tx(req, (t) => flyerPdf(t, { renderer: p.providers.integrations.renderer, envelope: p.envelope, storage: p.providers.storage, tenantId: actor.tenantId }, req.params.id));
    return reply.header('content-type', 'application/pdf').header('content-disposition', 'attachment; filename="flyer.pdf"').header('x-content-type-options', 'nosniff').send(Buffer.from(pdf.bytes));
  });

  r.get('/marketing-pieces/:id/assets/:position', { ...view, schema: { params: AssetParams } }, async (req, reply) => {
    const p = platformOf(req);
    const actor = actorOf(req);
    const img = await tx(req, async (t) => {
      const o = await assetObject(t, req.params.id, req.params.position);
      if (!o?.dek_wrapped) return null;
      const bytes = await getObject(p.envelope.inTx(t, actor.tenantId as TenantId), p.providers.storage, actor.tenantId as TenantId, o.id, o.storage_key, new Uint8Array(o.dek_wrapped));
      return bytes ? { bytes, contentType: o.content_type } : null;
    });
    if (!img) throw new AppError('NOT_FOUND');
    return reply.header('content-type', img.contentType).header('x-content-type-options', 'nosniff').header('cache-control', 'private, max-age=300').send(Buffer.from(img.bytes));
  });

  r.get('/public/marketing-assets/:assetToken', { config: { auth: 'public' }, schema: { params: TokenParams } }, async (req, reply) => {
    const img = await signedAsset(platformOf(req), req.params.assetToken, req.ip, platformOf(req).clock.now());
    if (!img) throw new AppError('NOT_FOUND');
    return reply.header('content-type', img.contentType).header('x-content-type-options', 'nosniff').header('cache-control', 'private, max-age=300').send(Buffer.from(img.bytes));
  });
  void readAsset;
}

export const marketingRoutes: RouteModule = { name: 'marketing', register };
