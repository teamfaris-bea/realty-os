// api/assistant route module (BUILD_PLAN module 13), mounted under /api by routes.ts:
//   GET  /assistant/inbox                          the caller's open assistant cards        self (RLS + own)
//   GET  /assistant/actions/:id                    one card                                 draft.approve (own)
//   POST /assistant/actions/:id/approve            ONE tap: send / acknowledge               draft.approve (own)
//   POST /assistant/actions/:id/reject             dismiss                                   draft.approve (own)
//   POST /assistant/claims/:id/review              confirm / correct / reject a claim        draft.approve (own)
//   POST /contacts/:id/drafts                      ask the assistant for a reply draft       comms.send
//   GET  /playbooks, GET /playbooks/:id            playbooks the caller can see              self (RLS)
//   POST /playbooks, POST /playbooks/:id/versions  create / edit (a new draft)               playbook.approve
//   POST /playbook-versions/:id/{approve,revoke}   hash-bound decision with attestation      playbook.approve
//   POST /contacts/:id/enrollments                 enroll (confirm to replace)               comms.send (marketing)
//   POST /enrollments/:id/{pause,resume,stop}                                                comms.send (marketing)
//   GET  /contacts/:id/saved-searches, GET /saved-searches/:id/preview                       contact.view_detail
//   POST /saved-searches/:id/{approve,activate,pause}                                        comms.send (marketing)
// Enrolling, resuming and starting search alerts let the assistant message the contact on the caller's
// behalf, marketing included, so they need the right to send ANY message to the contact (a TC cannot).
import { classifyHumanPurpose } from '@realty/core/compliance';
import type { ResourceFacts, UserActor } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { contactFacts, dealOrAppointmentContext } from '../comms/repos/contacts.js';
import { conversationOf } from '../comms/repos/gate.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import { systemActor } from '../worker/systemActor.js';
import { actionView, approveAction, inbox, rejectAction, reviewClaim } from './drafts.js';
import { enrollContact, enrollmentContact, pauseEnrollment, resumeEnrollment, stopEnrollment } from './enrollments.js';
import { approveVersion, createPlaybook, createVersion, listPlaybooks, playbookFacts, playbookView, revokeVersion, versionPlaybookId } from './playbooks.js';
import { runAssistant } from './runs.js';
import { activateSearch, approveSearch, pauseSearch, previewSearch, searchContact } from './searches.js';
import * as S from './schemas.js';
import { templateByKey } from './templates.js';

const IdParams = z.object({ id: z.uuid() });

function actorOf(req: FastifyRequest): UserActor {
  if (!req.actor) throw new AppError('UNAUTHENTICATED');
  return req.actor;
}
const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;

function factsTx<T>(req: FastifyRequest, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenantTx(actorOf(req), (tx) => fn(tx), { db: req.server.platform.db });
}

/** Own assistant action (or the action behind a claim): `draft.approve` is own-only for every role. */
async function ownActionFacts(tx: Tx, actionId: string): Promise<ResourceFacts | null> {
  const r = await sql<{ mine: boolean }>`SELECT owner_user_id IS NOT DISTINCT FROM app.user_id() AS mine FROM assistant_actions WHERE tenant_id = app.tenant_id() AND id = ${actionId}`.execute(tx);
  return r.rows[0] ? { own: r.rows[0].mine } : null;
}

async function sendFacts(tx: Tx, contactId: string | null, purpose?: 'marketing'): Promise<ResourceFacts | null> {
  if (!contactId) return null;
  const f = await contactFacts(tx, contactId);
  if (!f) return null;
  if (purpose) return { ...f, purpose };
  const conv = await conversationOf(tx, contactId);
  const now = (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(tx)).rows[0]!.now.getTime();
  return { ...f, purpose: classifyHumanPurpose({ lastInboundAt: conv?.lastInboundAt ?? null, dealOrAppointmentContext: await dealOrAppointmentContext(tx, contactId), now: now as never }) };
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const deps = () => depsFromPlatform(app.platform);

  const actionAuth = authorize('draft.approve', (req) => factsTx(req, (tx) => ownActionFacts(tx, idOf(req))));
  const claimAuth = authorize('draft.approve', (req) =>
    factsTx(req, async (tx) => {
      const c = await sql<{ action_id: string }>`SELECT action_id FROM assistant_claims WHERE tenant_id = app.tenant_id() AND id = ${idOf(req)}`.execute(tx);
      return c.rows[0] ? ownActionFacts(tx, c.rows[0].action_id) : null;
    }),
  );
  const pbAuth = (pick: (tx: Tx, req: FastifyRequest) => Promise<string | null>) =>
    authorize('playbook.approve', (req) =>
      factsTx(req, async (tx) => {
        const id = await pick(tx, req);
        return id ? playbookFacts(tx, id) : null;
      }),
    );
  const enrollmentAuth = authorize('comms.send', (req) => factsTx(req, async (tx) => sendFacts(tx, await enrollmentContact(tx, idOf(req)), 'marketing')));
  const searchAuth = authorize('comms.send', (req) => factsTx(req, async (tx) => sendFacts(tx, await searchContact(tx, idOf(req)), 'marketing')));

  // ---- inbox and cards ----
  r.get('/assistant/inbox', { config: { auth: 'self' }, schema: { response: { 200: S.InboxResponse } } }, async (req) => ({ items: await inbox(actorOf(req), deps()) }));
  r.get('/assistant/actions/:id', { config: { auth: 'draft.approve' }, preHandler: actionAuth, schema: { params: IdParams, response: { 200: S.ActionResponse } } }, async (req) => ({
    action: await actionView(actorOf(req), req.params.id, deps()),
  }));
  r.post('/assistant/actions/:id/approve', { config: { auth: 'draft.approve' }, preHandler: actionAuth, schema: { params: IdParams, body: S.ApproveBody, response: { 200: S.ApproveResponse } } }, async (req) =>
    approveAction(actorOf(req), req.params.id, req.body, deps()),
  );
  r.post('/assistant/actions/:id/reject', { config: { auth: 'draft.approve' }, preHandler: actionAuth, schema: { params: IdParams, response: { 200: S.RejectResponse } } }, async (req) =>
    rejectAction(actorOf(req), req.params.id, deps()),
  );
  r.post('/assistant/claims/:id/review', { config: { auth: 'draft.approve' }, preHandler: claimAuth, schema: { params: IdParams, body: S.ClaimReviewBody, response: { 200: S.ClaimReviewResponse } } }, async (req) =>
    reviewClaim(actorOf(req), req.params.id, req.body, deps()),
  );
  r.post(
    '/contacts/:id/drafts',
    { config: { auth: 'comms.send' }, preHandler: authorize('comms.send', (req) => factsTx(req, (tx) => sendFacts(tx, idOf(req)))), schema: { params: IdParams, body: S.DraftRequestBody, response: { 200: S.ActionResponse } } },
    async (req) => {
      const actor = actorOf(req);
      // R-AST-7: a draft is bound to the lead's owner and ownership period, so a draft for anyone else
      // could never be sent: refuse it instead of showing a card that fails on the tap
      const owner = await factsTx(req, async (tx) => (await sql<{ owner_user_id: string | null }>`SELECT owner_user_id FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${req.params.id}`.execute(tx)).rows[0]?.owner_user_id ?? null);
      if (owner !== actor.userId) throw new AppError('DRAFT_OWNER_ONLY');
      // the assistant runs as itself (system, via assistant) on this one contact, for the requesting agent
      const id = await runAssistant(systemActor(actor.tenantId, 'assistant'), 'draft', req.params.id, { kind: 'agent_request', requestedByUserId: actor.userId }, deps());
      if (!id) throw new AppError('ASSISTANT_UNAVAILABLE');
      return { action: await actionView(actor, id, deps()) };
    },
  );

  // ---- playbooks ----
  r.get('/playbooks', { config: { auth: 'self' }, schema: { response: { 200: S.PlaybooksResponse } } }, async (req) => ({ playbooks: await listPlaybooks(actorOf(req), deps()) }));
  r.get('/playbooks/:id', { config: { auth: 'self' }, schema: { params: IdParams, response: { 200: S.PlaybookResponse } } }, async (req) => ({ playbook: await playbookView(actorOf(req), req.params.id, deps()) }));
  r.post(
    '/playbooks',
    {
      config: { auth: 'playbook.approve' },
      preHandler: authorize('playbook.approve', (req) => {
        const b = req.body as { scope?: string; templateKey?: string };
        const scope = b.scope ?? (b.templateKey ? (templateByKey(b.templateKey)?.scope ?? 'agent') : 'agent');
        return scope === 'team' ? { teamPlaybook: true } : { own: true };
      }),
      schema: { body: S.CreatePlaybookBody, response: { 201: S.PlaybookResponse } },
    },
    async (req, reply) => {
      const playbook = await createPlaybook(actorOf(req), req.body, deps());
      reply.code(201);
      return { playbook };
    },
  );
  r.post('/playbooks/:id/versions', { config: { auth: 'playbook.approve' }, preHandler: pbAuth(async (_tx, req) => idOf(req)), schema: { params: IdParams, body: S.CreateVersionBody, response: { 200: S.PlaybookResponse } } }, async (req) => ({
    playbook: await createVersion(actorOf(req), req.params.id, req.body, deps()),
  }));
  r.post('/playbook-versions/:id/approve', { config: { auth: 'playbook.approve' }, preHandler: pbAuth((tx, req) => versionPlaybookId(tx, idOf(req))), schema: { params: IdParams, body: S.VersionDecisionBody, response: { 200: S.PlaybookResponse } } }, async (req) => ({
    playbook: await approveVersion(actorOf(req), req.params.id, req.body, deps()),
  }));
  r.post('/playbook-versions/:id/revoke', { config: { auth: 'playbook.approve' }, preHandler: pbAuth((tx, req) => versionPlaybookId(tx, idOf(req))), schema: { params: IdParams, body: S.VersionDecisionBody, response: { 200: S.PlaybookResponse } } }, async (req) => ({
    playbook: await revokeVersion(actorOf(req), req.params.id, req.body, deps()),
  }));

  // ---- enrollments ----
  r.post(
    '/contacts/:id/enrollments',
    { config: { auth: 'comms.send' }, preHandler: authorize('comms.send', (req) => factsTx(req, (tx) => sendFacts(tx, idOf(req), 'marketing'))), schema: { params: IdParams, body: S.EnrollBody, response: { 201: S.EnrollmentResponse } } },
    async (req, reply) => {
      const enrollment = await enrollContact(actorOf(req), req.params.id, req.body, deps());
      reply.code(201);
      return { enrollment };
    },
  );
  r.post('/enrollments/:id/pause', { config: { auth: 'comms.send' }, preHandler: enrollmentAuth, schema: { params: IdParams, response: { 200: S.EnrollmentResponse } } }, async (req) => ({ enrollment: await pauseEnrollment(actorOf(req), req.params.id, deps()) }));
  r.post('/enrollments/:id/resume', { config: { auth: 'comms.send' }, preHandler: enrollmentAuth, schema: { params: IdParams, response: { 200: S.EnrollmentResponse } } }, async (req) => ({ enrollment: await resumeEnrollment(actorOf(req), req.params.id, deps()) }));
  r.post('/enrollments/:id/stop', { config: { auth: 'comms.send' }, preHandler: enrollmentAuth, schema: { params: IdParams, response: { 200: S.EnrollmentResponse } } }, async (req) => ({ enrollment: await stopEnrollment(actorOf(req), req.params.id, deps()) }));

  // ---- saved searches ----
  r.get(
    '/contacts/:id/saved-searches',
    { config: { auth: 'contact.view_detail' }, preHandler: authorize('contact.view_detail', (req) => factsTx(req, (tx) => contactFacts(tx, idOf(req)))), schema: { params: IdParams, response: { 200: S.SearchesResponse } } },
    async (req) => {
      const actor = actorOf(req);
      const ids = await factsTx(req, async (tx) => (await sql<{ id: string }>`SELECT id FROM saved_searches WHERE tenant_id = app.tenant_id() AND contact_id = ${req.params.id} AND status <> 'archived' ORDER BY created_at DESC`.execute(tx)).rows.map((x) => x.id));
      const searches = [];
      for (const id of ids) searches.push(await previewSearch(actor, id, deps()));
      return { searches };
    },
  );
  r.get(
    '/saved-searches/:id/preview',
    { config: { auth: 'contact.view_detail' }, preHandler: authorize('contact.view_detail', (req) => factsTx(req, async (tx) => { const c = await searchContact(tx, idOf(req)); return c ? contactFacts(tx, c) : null; })), schema: { params: IdParams, response: { 200: S.SearchResponse } } },
    async (req) => ({ search: await previewSearch(actorOf(req), req.params.id, deps()) }),
  );
  r.post('/saved-searches/:id/approve', { config: { auth: 'comms.send' }, preHandler: searchAuth, schema: { params: IdParams, body: S.ApproveSearchBody, response: { 200: S.SearchResponse } } }, async (req) => ({
    search: await approveSearch(actorOf(req), req.params.id, req.body as never, deps()),
  }));
  r.post('/saved-searches/:id/activate', { config: { auth: 'comms.send' }, preHandler: searchAuth, schema: { params: IdParams, response: { 200: S.SearchResponse } } }, async (req) => ({ search: await activateSearch(actorOf(req), req.params.id, deps()) }));
  r.post('/saved-searches/:id/pause', { config: { auth: 'comms.send' }, preHandler: searchAuth, schema: { params: IdParams, response: { 200: S.SearchResponse } } }, async (req) => ({ search: await pauseSearch(actorOf(req), req.params.id, deps()) }));
}

export const assistantRoutes: RouteModule = { name: 'assistant', register };
