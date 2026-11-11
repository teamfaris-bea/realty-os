// api/seller-updates routes (PHASE2_3_PLAN §5.4 #28), mounted under /api.
//
//   GET   /listings/:id/seller-update        the listing's current update (else last sent), next due     listing.view
//   GET   /seller-updates/:id                one update: sections, sources, recipients, stale           draft.approve (own)
//   PATCH /seller-updates/:id                the agent's recommendation and removed feedback (unsent)    draft.approve (own)
//   POST  /seller-updates/:id/reassemble     one tap: re-read the period's data                          draft.approve (own)
//   POST  /seller-updates/:id/send           approve-and-send (also reachable as assistant approve)      draft.approve (own)
//
// draft.approve is own-only for every role: only the draft's owner (the listing agent it was drafted for) can
// act on it; another agent, another tenant, or a nonexistent id is 404. Every handler runs in the caller's
// tenant transaction under RLS (the system part of a send is the module's, see service.ts). Responses carry no
// tenant id and no confidence score.
import type { ResourceFacts, UserActor } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { depsFromPlatform } from '../comms/runtime.js';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import { listingFacts } from '../workspace/listings.js';
import { listingSellerUpdate, patchSellerUpdate, reassembleSellerUpdate, sellerUpdateView, sendSellerUpdate } from './service.js';

const IdParams = z.object({ id: z.uuid() });

const Reason = z.object({ code: z.string(), source: z.string(), at: z.string().nullable(), keyword: z.string().nullable(), addressHint: z.string().nullable(), otherAddress: z.boolean(), addressRemoved: z.boolean() });
const Recipient = z.object({
  contactId: z.uuid(),
  name: z.string().nullable(),
  role: z.enum(['seller', 'co_seller']),
  channel: z.enum(['email', 'sms']).nullable(),
  addressHint: z.string().nullable(),
  visible: z.boolean(),
  ownedByYou: z.boolean(),
  sendable: z.boolean(),
  personDoNotContact: z.boolean(),
  reasons: z.array(Reason),
  whyNot: z.string().nullable(),
});
const Section = z.object({
  kind: z.string(),
  title: z.string(),
  state: z.string(),
  statement: z.string(),
  lines: z.array(z.object({ text: z.string(), feedback: z.object({ feedbackId: z.uuid(), namesPerson: z.boolean(), excluded: z.boolean() }).nullable() })),
  sources: z.array(z.object({ text: z.string(), evidence: z.array(z.object({ sourceType: z.string(), sourceId: z.string(), label: z.string() })) })),
});
export const SellerUpdateSchema = z.object({
  id: z.uuid(),
  listingId: z.uuid(),
  address: z.string(),
  status: z.string(),
  ownerUserId: z.uuid().nullable(),
  canSend: z.boolean(),
  period: z.object({ start: z.string(), end: z.string(), key: z.string(), label: z.string(), text: z.string() }),
  assembledThrough: z.string(),
  stale: z.boolean(),
  sections: z.array(Section),
  recommendation: z.string(),
  excludedFeedbackIds: z.array(z.string()),
  recipients: z.array(Recipient),
  preview: z.object({ channel: z.enum(['email', 'sms']), subject: z.string(), body: z.string() }),
  sentAt: z.string().nullable(),
  delivery: z.array(z.object({ contactId: z.uuid(), name: z.string().nullable(), channel: z.enum(['email', 'sms']), status: z.string() })).nullable(),
});
const UpdateResponse = z.object({ update: SellerUpdateSchema });
const ListingUpdateResponse = z.object({ update: SellerUpdateSchema.nullable(), nextDueAt: z.string().nullable() });

export const PatchBody = z.strictObject({
  recommendation: z.string().max(2_000).optional(),
  excludedFeedbackIds: z.array(z.uuid()).max(200).optional(),
});
export const SendBody = z.strictObject({
  commandId: z.uuid(),
  recommendation: z.string().trim().max(2_000).optional(),
  excludedFeedbackIds: z.array(z.uuid()).max(200).optional(),
  // R-SELL-5: the sellers the agent was shown as reachable; required (the update goes only to who was shown)
  recipientIds: z.array(z.uuid()).max(50),
});
const Result = z.enum(['sent', 'queued', 'blocked', 'failed', 'dispatch_unknown', 'noop']);
export const SendResponse = z.object({
  actionId: z.uuid(),
  status: z.string(),
  result: Result,
  messageId: z.uuid().nullable(),
  recipients: z.array(z.object({ contactId: z.uuid(), messageId: z.uuid().nullable(), result: z.enum(['sent', 'queued', 'blocked', 'failed', 'dispatch_unknown', 'noop', 'not_queued']) })),
});

export const SELLER_UPDATE_REQUEST_SCHEMAS = { PatchBody, SendBody } as const;
export const SELLER_UPDATE_RESPONSE_SCHEMAS = { UpdateResponse, ListingUpdateResponse, SendResponse } as const;

function actorOf(req: FastifyRequest): UserActor {
  if (!req.actor) throw new AppError('UNAUTHENTICATED');
  return req.actor;
}
const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
const factsTx = <T>(req: FastifyRequest, fn: (tx: Tx) => Promise<T>): Promise<T> => withTenantTx(actorOf(req), (tx) => fn(tx), { db: req.server.platform.db });

/** A seller-update draft the caller owns (draft.approve is own-only); null: not a seller update or not visible. */
async function ownUpdateFacts(tx: Tx, id: string): Promise<ResourceFacts | null> {
  const r = await sql<{ mine: boolean }>`
    SELECT owner_user_id IS NOT DISTINCT FROM app.user_id() AS mine FROM assistant_actions
     WHERE tenant_id = app.tenant_id() AND id = ${id} AND kind = 'seller_update_draft' AND trigger_ref ? 'listing_id'`.execute(tx);
  return r.rows[0] ? { own: r.rows[0].mine } : null;
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const deps = () => depsFromPlatform(app.platform);
  const listingView = authorize('listing.view', (req) => factsTx(req, (tx) => listingFacts(tx, idOf(req))));
  const own = { config: { auth: 'draft.approve' as const }, preHandler: authorize('draft.approve', (req) => factsTx(req, (tx) => ownUpdateFacts(tx, idOf(req)))) };

  r.get('/listings/:id/seller-update', { config: { auth: 'listing.view' }, preHandler: listingView, schema: { params: IdParams, response: { 200: ListingUpdateResponse } } }, async (req) =>
    listingSellerUpdate(actorOf(req), req.params.id, deps()),
  );
  r.get('/seller-updates/:id', { ...own, schema: { params: IdParams, response: { 200: UpdateResponse } } }, async (req) => ({ update: await sellerUpdateView(actorOf(req), req.params.id, deps()) }));
  r.patch('/seller-updates/:id', { ...own, schema: { params: IdParams, body: PatchBody, response: { 200: UpdateResponse } } }, async (req) => ({
    update: await patchSellerUpdate(actorOf(req), req.params.id, req.body, deps()),
  }));
  r.post('/seller-updates/:id/reassemble', { ...own, schema: { params: IdParams, response: { 200: UpdateResponse } } }, async (req) => ({ update: await reassembleSellerUpdate(actorOf(req), req.params.id, deps()) }));
  r.post('/seller-updates/:id/send', { ...own, schema: { params: IdParams, body: SendBody, response: { 200: SendResponse } } }, async (req) => sendSellerUpdate(actorOf(req), req.params.id, req.body, deps()));
}

export const sellerUpdatesRoutes: RouteModule = { name: 'sellerUpdates', register };
