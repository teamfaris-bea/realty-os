// api/imports route module (BUILD_PLAN module 16), mounted under /api by routes.ts. Every route is
// `import.run`: Owner/Admin with a re-authentication younger than 15 minutes (R-PERM-13; DATA_MODEL §3
// "Imports ✅ 🔒 | ✅ 🔒 | — …"). Everyone else gets 404 (R-PERM-5).
//
//   POST /imports                                     connection/export test: counts only (R-IMPORT-1)
//   GET  /imports, GET /imports/:id                   batches with their stages
//   POST /imports/:id/snapshot                        queue the (delta) snapshot
//   GET|PUT /imports/:id/user-mappings                FUB agents/ponds → members/ponds (R-IMPORT-8)
//   PUT  /imports/:id/csv-mapping                     CSV column mapping (resets uncommitted dry runs)
//   POST /imports/:id/stages/:category/dry-run        queue one stage's dry run
//   GET  /imports/:id/stages/:category/records        the per-record review list (?outcome=&after=&limit=)
//   POST /imports/:id/records/:rid/review             import | merge | reject
//   POST /imports/:id/stages/:category/approve        { snapshotSha256 } (R-IMPORT-2, E42)
//   POST /imports/:id/stages/:category/commit         queue the commit (R-IMPORT-3 order guard)
//   GET  /imports/:id/stages/:category/verification   recount + 20 side-by-side spot checks
//   POST /imports/:id/stages/:category/verify         { spotChecks } (R-IMPORT-5)
//   POST /imports/:id/stages/:category/skip           a stage the team does not import
//   POST /imports/:id/revert                          { category? } (R-IMPORT-10)
//   POST /imports/:id/abandon                         purge the FUB key now (R-IMPORT-11)
//   GET  /imports/:id/report                          per category source | imported | needs review | rejected | duplicate
import type { UserActor } from '@realty/core/foundation';
import { type Category } from '@realty/core/import';
import { withTenantTx } from '@realty/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import type { Platform } from '../server.js';
import { abandonImport, createImport, requestSnapshot, setCsvMapping, setUserMappings } from './batches.js';
import { requestCommit } from './commit.js';
import { MAX_CSV_BYTES } from './csv.js';
import { defaultFubConnector } from './handlers.js';
import * as brepo from './repos/batches.js';
import * as rrepo from './repos/records.js';
import { requestRevert } from './revert.js';
import * as S from './schemas.js';
import { MAX_FILE_BASE64_CHARS } from './schemas.js';
import { approveStage, requestDryRun, reviewRecord, skipStage, verificationView, verifyStage } from './stages.js';
import type { ImportDeps } from './types.js';
import { batchView, mappingView, recordView, reportView } from './views.js';

/**
 * Request body cap of POST /imports: the strict base64 of the largest file plus room for the JSON
 * envelope (file name, an up-to-500-column mapping). A declared Content-Length over it is refused
 * before the body is read (413).
 */
export const MAX_UPLOAD_BODY_BYTES = MAX_FILE_BASE64_CHARS + 128 * 1024;

/**
 * Uploads are never decompressed (no decompression bomb can reach the parser): any Content-Encoding
 * but identity is refused before the body is read, rather than handed to the JSON parser as bytes.
 */
async function refuseContentEncoding<P>(req: FastifyRequest, _reply: unknown, payload: P): Promise<P> {
  const ce = req.headers['content-encoding'];
  if (ce === undefined) return payload;
  const codings = String(ce)
    .split(',')
    .map((c) => c.trim().toLowerCase())
    .filter((c) => c !== '');
  if (codings.some((c) => c !== 'identity')) throw new AppError('UNSUPPORTED_MEDIA_TYPE', { reason: 'CONTENT_ENCODING' });
  return payload;
}

export type ImportDepsFromPlatform = (p: Platform) => ImportDeps;

function actorOf(req: FastifyRequest): UserActor {
  const a = req.actor;
  if (!a) throw new AppError('UNAUTHENTICATED');
  return a;
}

export function makeImportsRoutes(depsFor?: ImportDepsFromPlatform): RouteModule {
  return {
    name: 'imports',
    async register(app: FastifyInstance) {
      const fub = defaultFubConnector();
      let cached: ImportDeps | null = null;
      const deps = (req: FastifyRequest): ImportDeps => {
        if (cached) return cached;
        const p = req.server.platform;
        cached = depsFor ? depsFor(p) : { db: p.db, envelope: p.envelope, ids: p.ids, storage: p.providers.storage, fub };
        return cached;
      };
      const r = app.withTypeProvider<ZodTypeProvider>();
      const auth = { config: { auth: 'import.run' as const }, preHandler: authorize('import.run', () => ({})) };

      const view = async (req: FastifyRequest, id: string) =>
        withTenantTx(
          actorOf(req),
          async (tx) => {
            const b = await brepo.getBatch(tx, id);
            if (!b) throw new AppError('NOT_FOUND');
            return batchView(b, await brepo.getStages(tx, id));
          },
          { db: deps(req).db },
        );

      r.post('/imports', { ...auth, bodyLimit: MAX_UPLOAD_BODY_BYTES, preParsing: refuseContentEncoding, schema: { body: S.CreateImportBody, response: { 201: S.CreatedResponse } } }, async (req, reply) => {
        const body = req.body;
        if (body.source !== 'fub_api' && Buffer.byteLength(body.fileBase64, 'base64') > MAX_CSV_BYTES) throw new AppError('PAYLOAD_TOO_LARGE');
        const input = body.source === 'csv' && body.mapping === undefined ? { source: body.source, fileName: body.fileName, fileBase64: body.fileBase64 } : body;
        const res = await createImport(deps(req), actorOf(req), input as Parameters<typeof createImport>[2]);
        reply.status(201);
        return { batch: await view(req, res.batchId) };
      });

      r.get('/imports', { ...auth, schema: { response: { 200: S.BatchListResponse } } }, async (req) =>
        withTenantTx(
          actorOf(req),
          async (tx) => {
            const out = [];
            for (const b of await brepo.listBatches(tx)) out.push(batchView(b, await brepo.getStages(tx, b.id)));
            return { batches: out };
          },
          { db: deps(req).db },
        ),
      );

      r.get('/imports/:id', { ...auth, schema: { params: S.IdParams, response: { 200: S.BatchResponse } } }, async (req) => ({ batch: await view(req, req.params.id) }));

      r.post('/imports/:id/snapshot', { ...auth, schema: { params: S.IdParams, response: { 202: S.AcceptedResponse } } }, async (req, reply) => {
        await requestSnapshot(deps(req), actorOf(req), req.params.id);
        reply.status(202);
        return { batch: await view(req, req.params.id), queued: 'snapshot' };
      });

      r.get('/imports/:id/user-mappings', { ...auth, schema: { params: S.IdParams, response: { 200: S.MappingsResponse } } }, async (req) =>
        withTenantTx(
          actorOf(req),
          async (tx) => {
            const b = await brepo.getBatch(tx, req.params.id);
            if (!b) throw new AppError('NOT_FOUND');
            return mappingView(b, await brepo.listMappings(tx, b.id));
          },
          { db: deps(req).db },
        ),
      );

      r.put('/imports/:id/user-mappings', { ...auth, schema: { params: S.IdParams, body: S.MappingsBody, response: { 200: S.MappingsResponse } } }, async (req) => {
        await setUserMappings(deps(req), actorOf(req), req.params.id, req.body.mappings);
        return withTenantTx(
          actorOf(req),
          async (tx) => {
            const b = (await brepo.getBatch(tx, req.params.id)) as brepo.BatchRow;
            return mappingView(b, await brepo.listMappings(tx, b.id));
          },
          { db: deps(req).db },
        );
      });

      r.put('/imports/:id/csv-mapping', { ...auth, schema: { params: S.IdParams, body: S.CsvMappingBody, response: { 200: S.BatchResponse } } }, async (req) => {
        await setCsvMapping(deps(req), actorOf(req), req.params.id, req.body.mapping);
        return { batch: await view(req, req.params.id) };
      });

      r.post('/imports/:id/stages/:category/dry-run', { ...auth, schema: { params: S.StageParams, response: { 202: S.AcceptedResponse } } }, async (req, reply) => {
        await requestDryRun(deps(req), actorOf(req), req.params.id, req.params.category as Category);
        reply.status(202);
        return { batch: await view(req, req.params.id), queued: 'dry_run' };
      });

      r.get('/imports/:id/stages/:category/records', { ...auth, schema: { params: S.StageParams, querystring: S.RecordsQuery, response: { 200: S.RecordsResponse } } }, async (req) =>
        withTenantTx(
          actorOf(req),
          async (tx) => {
            const s = await brepo.getStage(tx, req.params.id, req.params.category as Category);
            if (!s) throw new AppError('NOT_FOUND');
            const q = req.query;
            const rows = await rrepo.listRecords(tx, s.id, { ...(q.outcome ? { outcome: q.outcome } : {}), after: q.after ?? null, limit: q.limit + 1 });
            const page = rows.slice(0, q.limit);
            return { records: page.map(recordView), next: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null };
          },
          { db: deps(req).db },
        ),
      );

      r.post('/imports/:id/records/:rid/review', { ...auth, schema: { params: S.RecordParams, body: S.ReviewBody, response: { 200: S.RecordResponse } } }, async (req) => {
        const rec = await reviewRecord(deps(req), actorOf(req), req.params.id, req.params.rid, req.body.decision, req.body.mergeIntoContactId ?? null);
        return { record: recordView(rec) };
      });

      r.post('/imports/:id/stages/:category/approve', { ...auth, schema: { params: S.StageParams, body: S.ApproveBody, response: { 200: S.ApproveResponse } } }, async (req) => {
        const expected = await approveStage(deps(req), actorOf(req), req.params.id, req.params.category as Category, req.body.snapshotSha256);
        return { batch: await view(req, req.params.id), expected };
      });

      r.post('/imports/:id/stages/:category/commit', { ...auth, schema: { params: S.StageParams, response: { 202: S.AcceptedResponse } } }, async (req, reply) => {
        await requestCommit(deps(req), actorOf(req), req.params.id, req.params.category as Category);
        reply.status(202);
        return { batch: await view(req, req.params.id), queued: 'commit' };
      });

      r.get('/imports/:id/stages/:category/verification', { ...auth, schema: { params: S.StageParams, response: { 200: S.VerificationResponse } } }, async (req) =>
        verificationView(deps(req), actorOf(req), req.params.id, req.params.category as Category),
      );

      r.post('/imports/:id/stages/:category/verify', { ...auth, schema: { params: S.StageParams, body: S.VerifyBody, response: { 200: S.BatchResponse } } }, async (req) => {
        await verifyStage(deps(req), actorOf(req), req.params.id, req.params.category as Category, req.body.spotChecks);
        return { batch: await view(req, req.params.id) };
      });

      r.post('/imports/:id/stages/:category/skip', { ...auth, schema: { params: S.StageParams, response: { 200: S.BatchResponse } } }, async (req) => {
        await skipStage(deps(req), actorOf(req), req.params.id, req.params.category as Category);
        return { batch: await view(req, req.params.id) };
      });

      r.post('/imports/:id/revert', { ...auth, schema: { params: S.IdParams, body: S.RevertBody, response: { 202: S.AcceptedResponse } } }, async (req, reply) => {
        await requestRevert(deps(req), actorOf(req), req.params.id, (req.body.category as Category | undefined) ?? null);
        reply.status(202);
        return { batch: await view(req, req.params.id), queued: 'revert' };
      });

      r.post('/imports/:id/abandon', { ...auth, schema: { params: S.IdParams, response: { 200: S.BatchResponse } } }, async (req) => {
        await abandonImport(deps(req), actorOf(req), req.params.id);
        return { batch: await view(req, req.params.id) };
      });

      r.get('/imports/:id/report', { ...auth, schema: { params: S.IdParams, response: { 200: S.ReportResponse } } }, async (req) =>
        withTenantTx(
          actorOf(req),
          async (tx) => {
            const b = await brepo.getBatch(tx, req.params.id);
            if (!b) throw new AppError('NOT_FOUND');
            return reportView(b, await brepo.getStages(tx, b.id));
          },
          { db: deps(req).db },
        ),
      );
    },
  };
}

export const importsRoutes: RouteModule = makeImportsRoutes();
