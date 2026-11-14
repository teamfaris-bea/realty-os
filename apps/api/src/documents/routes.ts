// api/documents route module (PHASE2_3_PLAN §5.4 #42), mounted under /api by routes.ts:
//
//   POST /deals/:id/documents                 multipart upload of a deal document                      document.upload
//   POST /listings/:id/documents              multipart upload of a listing document                   document.upload_listing
//   POST /contacts/:id/documents              multipart upload of a contact document                   document.upload_contact
//   POST /documents/:id/versions              a new version (inherits the kind); the scope's upload
//                                             action is checked on the document's own scope             document.view + scope upload
//   GET  /deals|listings|contacts/:id/documents   one entry per visible chain + platform state         document.view
//   GET  /documents/:id                       the document and its visible chain                       document.view
//   GET  /documents/:id/file                  the bytes of a CLEAN document (never support)            document.download
//   POST /documents/:id/share {shared}        clean deal/listing documents; the DB re-checks            document.share
//   POST /documents/:id/hold {hold, reason}   Owner/Admin as themselves (403 DOCUMENT_HOLD_OWNER_ADMIN
//                                             to a member who sees the document)                        document.view + document.hold
//   PUT  /documents/:id/retention             Owner/Admin; 3-10 years after the scope's close           document.view + document.hold
//   GET  /documents/extractions               the caller's own open extractions (pointers, module 55)  document.view (+ RLS)
//   GET  /documents/:id/extraction            the proposal, its claims, evidence and the deal's dates   document.view (+ the action's RLS)
//   POST /documents/:id/extraction/run        read a clean PDF contract now (uploader, tenant-wide)     document.view (+ the action's RLS)
//   POST /documents/:id/extraction/claims/:claimId/confirm   one date through module 31's confirmInTx    milestone.confirm
//   POST /documents/:id/extraction/claims/:claimId/reject    dismiss one claim (needs_review included)   milestone.confirm
// An invisible scope or document is 404 (R-PERM-5). Multipart is parsed only inside this plugin's upload scope:
// buffered up to 10,000,000 + 65,536 bytes (a larger declared body is 413 before it is read), then
// Response.formData(); a Content-Encoding other than identity is refused before the body is read.
import { type Action, type Instant, type ResourceFacts, type UserActor, can } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { contactFacts } from '../comms/repos/contacts.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { AppError } from '../errors.js';
import { refuseContentEncoding } from '../imports/routes.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import { actorOf, mapWorkspaceDbError, platformOf } from '../workspace/common.js';
import { dealFacts } from '../workspace/deals.js';
import { listingFacts } from '../workspace/listings.js';
import { confirmClaimInTx, rejectClaimInTx } from './confirm.js';
import { COPY, previousVersionSharedText } from './copy.js';
import { extractDocument } from './extract.js';
import { extractionView } from './extractionView.js';
import { setHold, setRetention, setShared } from './manage.js';
import { type ReadCtx, documentDetail, downloadDocument, listScope, shareFacts } from './read.js';
import * as R from './repos.js';
import * as S from './schemas.js';
import { DOCUMENT_BODY_LIMIT, type DocumentDeps, type DocumentScope } from './types.js';
import { type FormEntry, checkBytes, countUploadAttempt, parseMultipart, readForm, uploadDocument } from './upload.js';

const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;

export function documentDeps(req: FastifyRequest): DocumentDeps {
  const p = platformOf(req);
  const d = depsFromPlatform(p);
  return { db: d.db, envelope: d.envelope, ids: d.ids, linkSecret: d.linkSecret, providers: p.providers };
}

/** can() with the request's re-auth state, for the view's canShare / canHold and the in-handler checks. */
function canFor(req: FastifyRequest): (action: Action, facts: ResourceFacts) => boolean {
  const actor = actorOf(req);
  const state = req.authState;
  return (action, facts) => state !== undefined && can(actor, action, { ...facts, reauth: { reauthenticatedAt: state.reauthenticatedAt, now: state.now } }).ok;
}

function readCtx(req: FastifyRequest): ReadCtx {
  const p = platformOf(req).providers;
  return { actor: actorOf(req), can: canFor(req), scanner: p.scanner, extractor: p.textExtractor };
}

/** One request transaction as the person; DB refusals map to stable codes (0069 codes are API bugs if reached). */
export async function docTx<T>(req: FastifyRequest, fn: (tx: Tx, actor: UserActor) => Promise<T>): Promise<T> {
  const actor = actorOf(req);
  try {
    return await withTenantTx(actor, (tx) => fn(tx, actor), { db: platformOf(req).db, retries: 2 });
  } catch (e) {
    throw mapDocumentDbError(req, e);
  }
}

/** DB-only codes: version and share refusals are 404 (the caller may not reach that row); the rest are API bugs. */
export function mapDocumentDbError(req: FastifyRequest, e: unknown): unknown {
  if (e instanceof AppError) return e;
  const msg = String((e as { message?: unknown })?.message ?? '');
  if (msg.startsWith('DOCUMENT_VERSION_INVALID') || msg.startsWith('DOCUMENT_SHARE_NOT_ALLOWED')) return new AppError('NOT_FOUND');
  if (msg.startsWith('DOCUMENT_RETAINED')) return new AppError('DOCUMENT_RETAINED');
  if (msg.startsWith('DOCUMENT_HOLD_OWNER_ADMIN') || msg.startsWith('DOCUMENT_RETENTION_OWNER_ADMIN')) return new AppError('DOCUMENT_HOLD_OWNER_ADMIN');
  if (/^(DOCUMENT_UPLOADER_SELF|DOCUMENT_OBJECT_INVALID|DOCUMENT_IMMUTABLE|DOCUMENT_SCAN_SYSTEM_ONLY|DEAL_DATE_EVIDENCE_INVALID)/.test(msg)) {
    req.log.error({ code: msg.split(':')[0] }, 'documents: a database guard refused an API write');
    return new AppError('INTERNAL_ERROR');
  }
  return mapWorkspaceDbError(e) ?? e;
}

async function scopeFacts(tx: Tx, scope: DocumentScope): Promise<ResourceFacts | null> {
  if (scope.kind === 'deal') return dealFacts(tx, scope.id);
  if (scope.kind === 'listing') return listingFacts(tx, scope.id);
  return contactFacts(tx, scope.id);
}
const UPLOAD_ACTION: Record<DocumentScope['kind'], Action> = { deal: 'document.upload', listing: 'document.upload_listing', contact: 'document.upload_contact' };

const scopeView = (kind: DocumentScope['kind']) => async (req: FastifyRequest) =>
  docTx(req, async (tx) => ((await R.scopeVisible(tx, { kind, id: idOf(req) } as DocumentScope)) ? {} : null));
const docVisible = (req: FastifyRequest) => docTx(req, async (tx) => ((await R.docById(tx, idOf(req))) ? {} : null));

async function detail(req: FastifyRequest, id: string) {
  return docTx(req, (tx) => documentDetail(tx, id, readCtx(req)));
}

async function handleUpload(req: FastifyRequest, reply: FastifyReply, target: { scope: DocumentScope } | { supersedesId: string }) {
  const actor = actorOf(req);
  const deps = documentDeps(req);
  await countUploadAttempt(deps, actor);
  if (!Array.isArray(req.body)) throw new AppError('VALIDATION_FAILED', { reason: 'MULTIPART_REQUIRED' });
  const form = readForm(req.body as FormEntry[], !('supersedesId' in target));
  const type = checkBytes(form);
  if ('supersedesId' in target) {
    // the new version is uploaded under the scope's own upload action (a TC never reaches contact documents)
    const ok = await docTx(req, async (tx) => {
      const prev = await R.docById(tx, target.supersedesId);
      if (!prev) return false;
      const scope = R.scopeOf(prev);
      const f = await scopeFacts(tx, scope);
      if (f === null && scope.kind === 'contact') {
        // seen through the merge survivor (0075): a merged-away record takes no new version (b11 ownership-data/F1)
        const root = await R.visibleMergeRootOf(tx, scope.id);
        if (root) throw new AppError('CONTACT_MERGED', { mergedInto: root });
      }
      return f !== null && canFor(req)(UPLOAD_ACTION[scope.kind], f);
    });
    if (!ok) throw new AppError('NOT_FOUND');
  }
  let res;
  try {
    res = await uploadDocument(deps, actor, target, form, type);
  } catch (e) {
    throw mapDocumentDbError(req, e);
  }
  const d = await detail(req, res.documentId);
  return reply.code(201).send({ ...d, previousVersionShared: res.previousVersionShared, previousVersionSharedText: res.previousVersionShared ? previousVersionSharedText(res.versionNo) : null });
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  // ---- uploads: multipart only inside this scope ----
  await app.register(async (scope) => {
    scope.addContentTypeParser('multipart/form-data', { parseAs: 'buffer', bodyLimit: DOCUMENT_BODY_LIMIT }, (req, body, done) => {
      parseMultipart(new Uint8Array(body as Buffer), String(req.headers['content-type'] ?? ''))
        .then((entries) => done(null, entries))
        .catch(() => done(Object.assign(new Error('invalid body'), { statusCode: 400, code: 'REALTY_INVALID_BODY' }), undefined));
    });
    const s = scope.withTypeProvider<ZodTypeProvider>();
    const up = { bodyLimit: DOCUMENT_BODY_LIMIT, preParsing: refuseContentEncoding, schema: { params: S.IdParams, response: { 201: S.UploadResponse } } };
    const uploadAuth = (kind: DocumentScope['kind']) => authorize(UPLOAD_ACTION[kind], (req) => docTx(req, (tx) => scopeFacts(tx, { kind, id: idOf(req) } as DocumentScope)));
    s.post('/deals/:id/documents', { ...up, config: { auth: 'document.upload' }, preHandler: uploadAuth('deal') }, async (req, reply) => handleUpload(req, reply, { scope: { kind: 'deal', id: req.params.id } }));
    s.post('/listings/:id/documents', { ...up, config: { auth: 'document.upload_listing' }, preHandler: uploadAuth('listing') }, async (req, reply) => handleUpload(req, reply, { scope: { kind: 'listing', id: req.params.id } }));
    s.post('/contacts/:id/documents', { ...up, config: { auth: 'document.upload_contact' }, preHandler: uploadAuth('contact') }, async (req, reply) => handleUpload(req, reply, { scope: { kind: 'contact', id: req.params.id } }));
    s.post('/documents/:id/versions', { ...up, config: { auth: 'document.view' }, preHandler: authorize('document.view', docVisible) }, async (req, reply) => handleUpload(req, reply, { supersedesId: req.params.id }));
  });

  // ---- reads ----
  const list = { schema: { params: S.IdParams, response: { 200: S.ListResponse } } };
  for (const kind of ['deal', 'listing', 'contact'] as const) {
    r.get(`/${kind}s/:id/documents`, { ...list, config: { auth: 'document.view' }, preHandler: authorize('document.view', scopeView(kind)) }, async (req) =>
      docTx(req, (tx) => listScope(tx, { kind, id: req.params.id } as DocumentScope, readCtx(req))),
    );
  }
  r.get('/documents/:id', { config: { auth: 'document.view' }, preHandler: authorize('document.view', docVisible), schema: { params: S.IdParams, response: { 200: S.DetailResponse } } }, async (req) => detail(req, req.params.id));

  r.get('/documents/:id/file', { config: { auth: 'document.download' }, preHandler: authorize('document.download', docVisible), schema: { params: S.IdParams } }, async (req, reply) => {
    const deps = documentDeps(req);
    const f = await docTx(req, (tx, actor) => downloadDocument(tx, deps, actor, req.params.id));
    // never rendered by the browser as a page: no sniffing, a sandboxing CSP, and PDFs always as an attachment
    reply
      .header('content-type', f.contentType)
      .header('x-content-type-options', 'nosniff')
      .header('content-security-policy', "default-src 'none'; sandbox")
      .header('cross-origin-resource-policy', 'same-origin')
      .header('cache-control', 'private, no-store')
      .header('content-disposition', `${f.contentType === 'application/pdf' ? 'attachment' : 'inline'}; filename="${f.asciiName}"; filename*=UTF-8''${f.utf8Name}`);
    return reply.send(Buffer.from(f.bytes));
  });

  // ---- share, hold, retention ----
  const shareAuth = authorize('document.share', (req) =>
    docTx(req, async (tx, actor) => {
      const d = await R.docById(tx, idOf(req));
      if (!d) return null;
      if (d.contact_id !== null) return {}; // visible: the handler answers DOCUMENT_NOT_SHAREABLE only if the role may share at all
      return shareFacts(tx, d, actor.role);
    }),
  );
  r.post('/documents/:id/share', { config: { auth: 'document.share' }, preHandler: shareAuth, schema: { params: S.IdParams, body: S.ShareBody, response: { 200: S.ShareResponse } } }, async (req) => {
    await docTx(req, (tx, actor) => setShared(tx, actor, req.params.id, req.body.shared));
    const d = await detail(req, req.params.id);
    const on = d.platform.portalCleared;
    return { ...d, text: req.body.shared ? (on ? COPY.sharedCleared : COPY.sharedNotCleared) : on ? COPY.unshared : COPY.unsharedNotCleared };
  });

  const ownerAdmin = (req: FastifyRequest) => {
    if (!canFor(req)('document.hold', {})) throw new AppError('DOCUMENT_HOLD_OWNER_ADMIN');
  };
  r.post('/documents/:id/hold', { config: { auth: 'document.view' }, preHandler: authorize('document.view', docVisible), schema: { params: S.IdParams, body: S.HoldBody, response: { 200: S.DetailResponse } } }, async (req) => {
    ownerAdmin(req);
    await docTx(req, (tx, actor) => setHold(tx, actor, req.params.id, req.body.hold, req.body.reason));
    return detail(req, req.params.id);
  });
  r.put('/documents/:id/retention', { config: { auth: 'document.view' }, preHandler: authorize('document.view', docVisible), schema: { params: S.IdParams, body: S.RetentionBody, response: { 200: S.DetailResponse } } }, async (req) => {
    ownerAdmin(req);
    await docTx(req, (tx, actor) => setRetention(tx, actor, req.params.id, new Date(req.body.retentionUntil)));
    return detail(req, req.params.id);
  });
}

async function registerExtraction(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const dealConfirm = authorize('milestone.confirm', (req) =>
    docTx(req, async (tx) => {
      const d = await R.docById(tx, idOf(req));
      return d?.deal_id ? dealFacts(tx, d.deal_id) : null;
    }),
  );
  // module 55: the caller's own open extractions, for the Approvals pointer card. A static segment: Fastify matches it
  // before /documents/:id whatever the registration order. A read only; nothing is decided here (R-DOC-8, R-STAFF-2).
  r.get('/documents/extractions', { config: { auth: 'document.view' }, preHandler: authorize('document.view', () => ({})), schema: { response: { 200: S.OpenExtractionsResponse } } }, async (req) =>
    docTx(req, async (tx) => ({
      extractions: (await R.openExtractions(tx, 50)).map((x) => ({
        documentId: x.document_id,
        dealId: x.deal_id,
        displayName: x.display_name,
        versionNo: x.version_no,
        outcome: (['dates', 'no_text', 'no_dates', 'unreadable'] as const).find((o) => o === x.outcome) ?? null,
        unreviewedClaims: x.unreviewed,
        createdAt: x.created_at.toISOString(),
      })),
    })),
  );
  r.get('/documents/:id/extraction', { config: { auth: 'document.view' }, preHandler: authorize('document.view', docVisible), schema: { params: S.IdParams, response: { 200: S.ExtractionResponse } } }, async (req) =>
    docTx(req, (tx) => extractionView(tx, req.params.id, readCtx(req))),
  );
  r.post('/documents/:id/extraction/run', { config: { auth: 'document.view' }, preHandler: authorize('document.view', docVisible), schema: { params: S.IdParams, response: { 200: S.ExtractionResponse } } }, async (req) => {
    const actor = actorOf(req);
    const deps = documentDeps(req);
    // the uploader or a tenant-wide actor (the action is the uploader's; RLS lets nobody else write it)
    const allowed = await docTx(req, async (tx) => {
      const d = await R.docById(tx, req.params.id);
      if (!d) return false;
      const x = await sql<{ ok: boolean }>`SELECT (app.is_tenant_wide() OR app.user_id() = ${d.uploaded_by_user_id}::uuid) AS ok`.execute(tx);
      return x.rows[0]?.ok === true;
    });
    if (!allowed) throw new AppError('NOT_FOUND');
    let run;
    try {
      run = await extractDocument(deps, actor, (fn) => withTenantTx(actor, fn, { db: deps.db }), req.params.id);
    } catch (e) {
      throw mapDocumentDbError(req, e);
    }
    if (run.result === 'exists') throw new AppError('EXTRACTION_EXISTS');
    return docTx(req, (tx) => extractionView(tx, req.params.id, readCtx(req)));
  });
  const claimTx = async <T>(req: FastifyRequest, fn: (tx: Tx, actor: UserActor, now: Instant) => Promise<T>): Promise<T> => {
    const actor = actorOf(req);
    try {
      return await withTenantTx(actor, (tx, now) => fn(tx, actor, now), { db: platformOf(req).db, retries: 2 });
    } catch (e) {
      // module 31's codes, as transactions/routes.ts maps them
      if (String((e as { message?: unknown })?.message ?? '').startsWith('DATE_HUMAN_CONFIRMATION')) throw new AppError('DATE_HUMAN_CONFIRMATION');
      throw mapDocumentDbError(req, e);
    }
  };
  r.post('/documents/:id/extraction/claims/:claimId/confirm', { config: { auth: 'milestone.confirm' }, preHandler: dealConfirm, schema: { params: S.ClaimParams, body: S.ConfirmClaimBody, response: { 200: S.ClaimDecisionResponse } } }, async (req) =>
    claimTx(req, async (tx, actor, now) => {
      const res = await confirmClaimInTx(tx, actor, platformOf(req).ids, req.params.id, req.params.claimId, { target: req.body.target, reminderDaysBefore: req.body.reminderDaysBefore }, now);
      return { ...(await extractionView(tx, req.params.id, readCtx(req))), dateId: res.dateId };
    }),
  );
  r.post('/documents/:id/extraction/claims/:claimId/reject', { config: { auth: 'milestone.confirm' }, preHandler: dealConfirm, schema: { params: S.ClaimParams, body: S.RejectClaimBody, response: { 200: S.ClaimDecisionResponse } } }, async (req) =>
    claimTx(req, async (tx, actor) => {
      await rejectClaimInTx(tx, actor, req.params.id, req.params.claimId);
      return { ...(await extractionView(tx, req.params.id, readCtx(req))), dateId: null };
    }),
  );
}

export const documentRoutes: RouteModule = { name: 'documents', register: async (app) => {
  await register(app);
  await registerExtraction(app);
} };
