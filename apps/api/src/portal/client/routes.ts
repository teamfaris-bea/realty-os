// Client portal routes (R-PORTAL-8, R-PORTAL-16, R-PORTAL-17), mounted under /api/portal by plugin.ts. Every route here
// needs a client session (clientGuard) and reaches the database only through withPortalTx and the @realty/db portal
// wrappers (lint: realty/portal-tx-separation mode client). Clients see only the three portal tables, only portal ids.
//
//   GET  /portal/me                               account status, CSRF token, session policy, live grants
//   POST /portal/logout                           (CSRF) ends this session, clears the cookie, 204
//   GET  /portal/timeline?grantId=                milestones, showings, feedback, seller updates; next steps apart
//   GET  /portal/documents?grantId=               document items
//   POST /portal/documents/:itemId/stream-token   (CSRF) a 60 s single-use download URL (E649)
//   GET  /portal/files/:token                     the bytes, once, attachment (E649, E659)
// A foreign, invisible or non-canonical id is 404 (R-PERM-5, E648).
import type { TenantId } from '@realty/core/foundation';
import { endPortalSession, issuePortalDocumentStream, recordPortalAudit, redeemPortalDocumentDownload, withPortalTx } from '@realty/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { getObject } from '../../crypto/objects.js';
import { AppError } from '../../errors.js';
import { attachmentDisposition, portalFileNames } from '../shared/fileNames.js';
import * as S from '../shared/schemas.js';
import { SESSION_POLICY, portalCookieName, portalCookieOptions, portalCsrfToken } from '../shared/session.js';
import { type PortalItemRow, documentsView, grantView, timelineView } from '../shared/view.js';
import { clientGuard, clientOf, portalCookieOf, portalRateKey } from './guard.js';
import { portalObjectEnvelope } from './objectKey.js';

const CANONICAL = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const STREAM_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const meta = (req: FastifyRequest) => ({ ip: req.ip ?? null, userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'].slice(0, 512) : null });

/** 120 reads a minute per session (else per IP); 30 stream tokens a minute (R-PORTAL-12). */
const READS = { max: 120, timeWindow: 60_000, keyGenerator: portalRateKey };
const STREAMS = { max: 30, timeWindow: 60_000, keyGenerator: portalRateKey };
const client = (rateLimit: typeof READS) => ({ config: { auth: 'public' as const, portal: 'client' as const, rateLimit }, bodyLimit: 4096, preValidation: [clientGuard] });

interface ItemDbRow {
  id: string;
  grant_id: string;
  kind: PortalItemRow['kind'];
  title: string;
  body: string | null;
  occurs_on: string | null;
  published_at: Date;
}
const toItem = (r: ItemDbRow): PortalItemRow => ({ id: r.id, grantId: r.grant_id, kind: r.kind, title: r.title, body: r.body, occursOn: r.occurs_on, publishedAt: r.published_at });

export async function registerClientRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = () => ({ db: app.platform.db });

  r.get('/me', { ...client(READS), schema: { response: { 200: S.MeResponse } } }, async (req) => {
    const c = clientOf(req);
    const grants = await withPortalTx(c, async (tx) => {
      const acc = await sql<{ status: string }>`SELECT status FROM portal_accounts`.execute(tx);
      if (acc.rows[0]?.status !== 'active') throw new AppError('PORTAL_SESSION_REQUIRED');
      return (await sql<{ id: string; display: unknown; expires_at: Date | null }>`SELECT id, display, expires_at FROM portal_grants ORDER BY granted_at, id`.execute(tx)).rows;
    }, db());
    return {
      account: { status: 'active' as const },
      csrfToken: portalCsrfToken(app.platform.config.sessionSecret, c.sessionId),
      session: { ...SESSION_POLICY },
      grants: grants.map((g) => grantView({ id: g.id, display: g.display, expiresAt: g.expires_at })),
    };
  });

  r.post('/logout', { ...client(READS) }, async (req, reply) => {
    const token = portalCookieOf(req);
    if (token) await endPortalSession(token, 'logout', db());
    const secure = app.platform.config.cookieSecure;
    reply.clearCookie(portalCookieName(secure), portalCookieOptions(secure, 0));
    return reply.code(204).send();
  });

  const itemsOf = async (req: FastifyRequest, grantId: string): Promise<PortalItemRow[]> => {
    if (!CANONICAL.test(grantId)) throw new AppError('NOT_FOUND');
    return withPortalTx(clientOf(req), async (tx) => {
      const g = await sql<{ id: string }>`SELECT id FROM portal_grants WHERE id = ${grantId}::uuid`.execute(tx);
      if (g.rows.length !== 1) throw new AppError('NOT_FOUND');
      const rows = await sql<ItemDbRow>`
        SELECT id, grant_id, kind, title, body, occurs_on::text AS occurs_on, published_at
          FROM portal_items WHERE grant_id = ${grantId}::uuid ORDER BY published_at, id`.execute(tx);
      return rows.rows.map(toItem);
    }, db());
  };

  r.get('/timeline', { ...client(READS), schema: { querystring: S.GrantQuery, response: { 200: S.TimelineResponse } } }, async (req) => {
    const items = await itemsOf(req, req.query.grantId);
    return { grantId: req.query.grantId, ...timelineView(items) };
  });

  r.get('/documents', { ...client(READS), schema: { querystring: S.GrantQuery, response: { 200: S.DocumentsResponse } } }, async (req) => {
    const items = await itemsOf(req, req.query.grantId);
    return { grantId: req.query.grantId, documents: documentsView(items) };
  });

  r.post('/documents/:itemId/stream-token', { ...client(STREAMS), schema: { params: S.ItemParams, response: { 200: S.StreamTokenResponse } } }, async (req) => {
    const itemId = req.params.itemId;
    if (!CANONICAL.test(itemId)) throw new AppError('NOT_FOUND');
    const t = await withPortalTx(clientOf(req), async (tx) => {
      const s = await issuePortalDocumentStream(tx, itemId);
      if (s) await recordPortalAudit(tx, 'portal.document_stream_issued', 'portal_item', itemId, meta(req));
      return s;
    }, db());
    if (!t) throw new AppError('NOT_FOUND');
    return {
      url: `/api/portal/files/${t.token}`,
      expiresAt: new Date(t.expiresAt).toISOString(),
      fileName: decodeURIComponent(portalFileNames(t.displayName, t.contentType).utf8Name),
      contentType: t.contentType,
      byteSize: t.byteSize,
    };
  });

  // b14 audit F8: no HEAD route. Fastify would expose one running this handler, which redeems the single-use token and
  // audits a download that never happened; a HEAD (a download manager's probe) is 404 and leaves the token unused.
  r.get('/files/:token', { ...client(STREAMS), exposeHeadRoute: false, schema: { params: S.FileParams } }, async (req, reply) => {
    const token = req.params.token;
    if (!STREAM_TOKEN.test(token)) throw new AppError('NOT_FOUND');
    const c = clientOf(req);
    const o = await withPortalTx(c, (tx) => redeemPortalDocumentDownload(tx, token, meta(req)), db());
    if (!o) throw new AppError('NOT_FOUND');
    const tenantId = c.tenantId as TenantId;
    let bytes: Uint8Array | null;
    try {
      const env = portalObjectEnvelope(app.platform.envelope.kek, { tenantId, objectId: o.objectId, objectKeyWrapped: o.objectKeyWrapped, objectKeyVersion: o.objectKeyVersion });
      bytes = await getObject(env, app.platform.providers.storage, tenantId, o.objectId, o.storageKey, new Uint8Array(o.dekWrapped));
    } catch (e) {
      req.log.warn({ code: (e as Error)?.name ?? 'DECRYPT' }, 'portal: a download could not be decrypted');
      bytes = null;
    }
    if (!bytes) throw new AppError('NOT_FOUND');
    reply
      .header('content-type', o.contentType)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cross-origin-resource-policy', 'same-origin')
      .header('cache-control', 'private, no-store')
      .header('referrer-policy', 'no-referrer')
      .header('content-disposition', attachmentDisposition(o.displayName, o.contentType));
    return reply.send(Buffer.from(bytes));
  });
}
