// Lead-email intake routes (module 22 slice). Mounted under /api by routes.ts.
//
//   POST /webhooks/lead-email/inbound                  the generic signed format (fake provider; a bridge)   webhook (X-Realty-Signature)
//   POST /webhooks/lead-email/postmark/inbound         Postmark inbound JSON (only when enabled)            webhook (Basic)
//   POST /webhooks/lead-email/sendgrid/inbound         SendGrid Inbound Parse (only when enabled)           webhook (Basic)
//   GET  /lead-sources/:id/lead-email                  the inbound address + allowed sender domains          integration.view (Owner/Admin)
//   POST /lead-sources/:id/lead-email                  turn the address on                                  integration.manage 🔒
//   POST /lead-sources/:id/lead-email/rotate           a new address; the old one stops working             integration.manage 🔒
//   PUT  /lead-sources/:id/lead-email/sender-domains   the DKIM sender allowlist                            integration.manage 🔒
//   GET  /lead-email/reviews?status=                   Needs review (held) or decided                       lead_email.review_view (Owner/Admin/TL; support)
//   POST /lead-email/reviews/:id/accept                accept as a lead (same intake; audited)              lead_email.review_decide
//   POST /lead-email/reviews/:id/discard               discard (content purged; audited)                    lead_email.review_decide
//
// Webhooks: the guard verified the provider's signature first; the body is capped (bodyLimit) before parsing;
// attachments are dropped unread; nothing in the email is fetched. The tenant comes ONLY from the inbox key in the
// recipient address (app.resolve_lead_email_key). Idempotency: webhook_events (per inbox + message id), then the
// per-tenant UNIQUE message key in the same transaction as the lead.
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { run } from '../comms/webhooks.js';
import { AppError } from '../errors.js';
import { actorOf, leadsTx, platformOf } from '../leads/common.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import type { Platform } from '../server.js';
import { type LeadEmailInbound, parseGenericLeadEmail, parsePostmarkLeadEmail, parseSendgridLeadEmail } from './formats.js';
import { type LeadEmailDeps, acceptReview, discardReview, enableInbox, getInbox, listReviews, receiveLeadEmail, resolveInbox, rotateKey, setSenderDomains } from './service.js';

/** JSON lead emails are small; HTML bombs and attachments beyond this are refused with 413 before parsing. */
export const LEAD_EMAIL_JSON_LIMIT = 1_048_576;
/** SendGrid posts attachments in the same multipart body; they are dropped unread. */
export const LEAD_EMAIL_MULTIPART_LIMIT = 5 * 1_048_576;

export function leadEmailDeps(p: Platform): LeadEmailDeps {
  return { db: p.db, envelope: p.envelope, ids: p.ids, inboundDomain: p.config.leadEmail.inboundDomain };
}

const Id = z.uuid();
const FieldView = z.object({ value: z.string(), span: z.object({ start: z.number().int(), end: z.number().int() }) });
export const InboxResponse = z.object({
  inbox: z.object({
    leadSourceId: Id,
    enabled: z.boolean(),
    connectionId: Id.nullable(),
    status: z.string().nullable(),
    address: z.string().nullable(),
    addressCreatedAt: z.string().nullable(),
    allowedSenderDomains: z.array(z.string()),
    suggestedSenderDomains: z.array(z.object({ domain: z.string(), label: z.string() })),
    inboundDomainConfigured: z.boolean(),
  }),
});
export const ReviewItem = z.object({
  id: Id,
  receivedAt: z.string(),
  leadSourceId: Id,
  leadSourceName: z.string(),
  status: z.enum(['needs_review', 'accepted', 'discarded']),
  holdCode: z.string(),
  holdSentence: z.string(),
  senderDomain: z.string().nullable(),
  dkimPassDomains: z.array(z.string()),
  parserKind: z.string().nullable(),
  subject: z.string().nullable(),
  text: z.string().nullable(),
  fields: z
    .object({ name: FieldView.nullable(), phones: z.array(FieldView), emails: z.array(FieldView), message: FieldView.nullable(), property: FieldView.nullable(), listingId: FieldView.nullable(), leadType: z.string() })
    .nullable(),
  canAccept: z.boolean(),
  contactId: Id.nullable(),
  decidedAt: z.string().nullable(),
});
export const ReviewsResponse = z.object({ items: z.array(ReviewItem), pendingCount: z.number().int() });
export const ReviewDecisionResponse = z.object({ review: ReviewItem, contactId: Id.nullable() });
export const WebhookResponse = z.object({ ok: z.literal(true), outcome: z.enum(['lead_created', 'needs_review', 'duplicate', 'unrouted']) });

/** Response schemas, for the R-AST-13 / R-TEN-3 snapshot test. */
export const LEAD_EMAIL_RESPONSE_SCHEMAS = { InboxResponse, ReviewsResponse, ReviewDecisionResponse, WebhookResponse };

const Domain = z.string().trim().min(1).max(253);
const AcceptBody = z.strictObject({ name: z.string().trim().min(1).max(120).optional(), phone: z.string().trim().min(3).max(40).optional(), email: z.string().trim().min(3).max(254).optional() });

async function handle(req: FastifyRequest, n: LeadEmailInbound | null): Promise<z.infer<typeof WebhookResponse>> {
  if (!n) throw new AppError('VALIDATION_FAILED');
  const deps = leadEmailDeps(platformOf(req));
  const resolved = await resolveInbox(deps, n);
  const idHash = createHash('sha256').update(`${n.format}\n${n.messageId}`, 'utf8').digest('hex');
  // per inbox: a sender-chosen Message-ID can never pre-empt another inbox's (or tenant's) delivery
  const eventId = `lead-email:${resolved?.connectionId ?? 'unrouted'}:${idHash}`;
  const out = await run(req, 'email', eventId, resolved?.tenantId ?? null, { kind: 'lead_email', messageIdSha256: idHash }, () => receiveLeadEmail(deps, resolved!, n));
  const outcome = out === 'duplicate' || out === 'unrouted' ? out : out.outcome;
  return { ok: true, outcome };
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const Json = z.unknown();

  r.post(
    '/webhooks/lead-email/inbound',
    { bodyLimit: LEAD_EMAIL_JSON_LIMIT, config: { auth: 'webhook', webhookProvider: 'email' }, schema: { body: Json, response: { 200: WebhookResponse } } },
    async (req) => handle(req, parseGenericLeadEmail(req.body)),
  );

  const vendor = (format: 'postmark' | 'sendgrid') => ({
    config: { auth: 'webhook' as const, webhookProvider: 'email' as const, webhookAuth: 'basic' as const },
    preHandler: async (req: FastifyRequest) => {
      if (!req.server.platform.config.emailInbound.formats.includes(format)) throw new AppError('NOT_FOUND');
    },
  });
  r.post('/webhooks/lead-email/postmark/inbound', { ...vendor('postmark'), bodyLimit: LEAD_EMAIL_JSON_LIMIT, schema: { body: Json, response: { 200: WebhookResponse } } }, async (req) =>
    handle(req, parsePostmarkLeadEmail(req.body, platformOf(req).config.leadEmail.authservId)),
  );
  await app.register(async (scope) => {
    scope.addContentTypeParser('multipart/form-data', { parseAs: 'buffer', bodyLimit: LEAD_EMAIL_MULTIPART_LIMIT }, (req, body, done) => {
      const ct = req.headers['content-type'] ?? '';
      new Response(new Uint8Array(body as Buffer), { headers: { 'content-type': ct } })
        .formData()
        .then((fd) => {
          // files (attachments) are dropped unread; only text fields are kept
          const out: Record<string, string> = {};
          for (const [k, v] of fd) if (typeof v === 'string' && k !== '__proto__' && k !== 'constructor' && k !== 'prototype' && Object.keys(out).length < 100) out[k] = v;
          done(null, out);
        })
        .catch(() => done(Object.assign(new Error('invalid body'), { statusCode: 400, code: 'REALTY_INVALID_BODY' }), undefined));
    });
    scope
      .withTypeProvider<ZodTypeProvider>()
      .post('/webhooks/lead-email/sendgrid/inbound', { ...vendor('sendgrid'), bodyLimit: LEAD_EMAIL_MULTIPART_LIMIT, schema: { body: z.record(z.string(), z.string()), response: { 200: WebhookResponse } } }, async (req) =>
        handle(req, parseSendgridLeadEmail(req.body)),
      );
  });

  // ---- lead source settings (Owner/Admin) ----
  const view = { config: { auth: 'integration.view' as const }, preHandler: authorize('integration.view', () => ({})) };
  const manage = { config: { auth: 'integration.manage' as const }, preHandler: authorize('integration.manage', () => ({})) };
  const Params = z.object({ id: Id }).strict();

  r.get('/lead-sources/:id/lead-email', { ...view, schema: { params: Params, response: { 200: InboxResponse } } }, async (req) => ({
    inbox: await getInbox(leadEmailDeps(platformOf(req)), actorOf(req), req.params.id),
  }));
  r.post(
    '/lead-sources/:id/lead-email',
    { ...manage, schema: { params: Params, body: z.strictObject({ allowedSenderDomains: z.array(Domain).max(10).optional() }).optional(), response: { 200: InboxResponse } } },
    async (req) => ({ inbox: await enableInbox(leadEmailDeps(platformOf(req)), actorOf(req), req.params.id, req.body?.allowedSenderDomains) }),
  );
  r.post('/lead-sources/:id/lead-email/rotate', { ...manage, schema: { params: Params, response: { 200: InboxResponse } } }, async (req) => ({
    inbox: await rotateKey(leadEmailDeps(platformOf(req)), actorOf(req), req.params.id),
  }));
  r.put(
    '/lead-sources/:id/lead-email/sender-domains',
    { ...manage, schema: { params: Params, body: z.strictObject({ domains: z.array(Domain).max(10) }), response: { 200: InboxResponse } } },
    async (req) => ({ inbox: await setSenderDomains(leadEmailDeps(platformOf(req)), actorOf(req), req.params.id, req.body.domains) }),
  );

  // ---- Needs review (Owner/Admin/Team Lead) ----
  const reviewView = { config: { auth: 'lead_email.review_view' as const }, preHandler: authorize('lead_email.review_view', () => ({})) };
  const decide = { config: { auth: 'lead_email.review_decide' as const }, preHandler: authorize('lead_email.review_decide', () => ({})) };
  r.get(
    '/lead-email/reviews',
    { ...reviewView, schema: { querystring: z.object({ status: z.enum(['needs_review', 'decided']).default('needs_review') }).strict(), response: { 200: ReviewsResponse } } },
    async (req) => leadsTx(req, (tx, _now, actor) => listReviews(tx, leadEmailDeps(platformOf(req)), actor.tenantId, req.query.status)),
  );
  r.post('/lead-email/reviews/:id/accept', { ...decide, schema: { params: Params, body: AcceptBody.optional(), response: { 200: ReviewDecisionResponse } } }, async (req) => {
    const out = await acceptReview(leadEmailDeps(platformOf(req)), actorOf(req), req.params.id, req.body ?? {});
    return { review: out.review, contactId: out.contactId };
  });
  r.post('/lead-email/reviews/:id/discard', { ...decide, schema: { params: Params, response: { 200: ReviewDecisionResponse } } }, async (req) => {
    const out = await discardReview(leadEmailDeps(platformOf(req)), actorOf(req), req.params.id);
    return { review: out.review, contactId: null };
  });
}

export const leadEmailRoutes: RouteModule = { name: 'lead-email', register };
