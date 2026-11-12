// Google Ads lead form routes (module 22 scope 7; DATA_MODEL R-GADS-1..4). Mounted under /api by routes.ts.
//
//   POST  /webhooks/google-ads/lead-form              Google posts one lead (key in the body)   webhook (google_lead_key)
//   GET   /lead-sources/:id/google-lead-form          state, URL, key (Owner/Admin)              integration.view
//   POST  /lead-sources/:id/google-lead-form          turn on: a new key                         integration.manage 🔒
//   POST  /lead-sources/:id/google-lead-form/rotate   a new key; the old one stops working       integration.manage 🔒
//   PATCH /lead-sources/:id/google-lead-form          inquiry type, consent citation             settings.routing
//   POST  /lead-sources/:id/google-lead-form/off      turn off: the key is retired forever       integration.manage 🔒
//
// The webhook has ONE fixed URL (no secret in the path): the key in the body is the only routing input
// (leadForms/auth.ts, run by the webhook guard before this handler). It opts out of the global per-IP limiter
// (Google posts from shared addresses; a resolved key is never refused by a limiter). Every answer after a resolved
// key is 200 {} — test, unreadable, duplicate, new lead alike — except a source turned off in between (403). The
// response never carries a tenant, contact or inquiry id. Each delivery is recorded once in webhook_events (provider
// 'lead'); the payload recorded there is ids and flags only (never the key, never the lead's content).
import { createHash } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { run } from '../comms/webhooks.js';
import { AppError } from '../errors.js';
import { actorOf, platformOf } from '../leads/common.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import { parseGoogleLead } from './google.js';
import { type GoogleLeadDeps, WEBHOOK_PATH, disableHook, enableHook, getHook, patchHook, receiveGoogleLead, rotateHook } from './service.js';

/** VERIFY: Google documents no maximum; one lead with ~100 short answers is a few KiB. Larger bodies are 413. */
export const GOOGLE_LEAD_BODY_LIMIT = 64 * 1024;

const Iso = z.string();
const InquiryTypeEnum = z.enum(['buy', 'sell', 'rent', 'value', 'general']);

export const GoogleLeadFormView = z.object({
  state: z.enum(['on', 'off', 'not_available']),
  /** null when not_available (no public https address) */
  webhookUrl: z.string().nullable(),
  /** the current key, only on GET and only while on */
  key: z.string().nullable(),
  createdAt: Iso.nullable(),
  inquiryType: InquiryTypeEnum.nullable(),
  citesSourceDisclosure: z.boolean().nullable(),
  lastTestAt: Iso.nullable(),
  lastLeadAt: Iso.nullable(),
  lastUnreadableAt: Iso.nullable(),
  unreadableCount: z.number().int(),
  sourceHasConsentText: z.boolean(),
});
export const GoogleLeadFormKeyResponse = z.object({ key: z.string(), webhookUrl: z.string(), createdAt: Iso });
export const GoogleLeadWebhookResponse = z.object({}).strict();

/** Response schemas, for the R-AST-13 / R-TEN-3 checks. */
export const GOOGLE_LEAD_FORM_RESPONSE_SCHEMAS = { GoogleLeadFormView, GoogleLeadFormKeyResponse, GoogleLeadWebhookResponse };

export const EnableBody = z.strictObject({ inquiryType: InquiryTypeEnum, citesSourceDisclosure: z.boolean().optional() });
export const PatchBody = z
  .strictObject({ inquiryType: InquiryTypeEnum.optional(), citesSourceDisclosure: z.boolean().optional() })
  .refine((b) => b.inquiryType !== undefined || b.citesSourceDisclosure !== undefined, { message: 'empty' });

function deps(req: FastifyRequest): GoogleLeadDeps {
  const p = platformOf(req);
  return { db: p.db, envelope: p.envelope, ids: p.ids, publicBaseUrl: p.config.publicBaseUrl };
}

const sha = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/webhooks/google-ads/lead-form',
    {
      bodyLimit: GOOGLE_LEAD_BODY_LIMIT,
      config: { auth: 'webhook', webhookProvider: 'lead', webhookAuth: 'google_lead_key', rateLimit: false },
      schema: { body: z.unknown(), response: { 200: GoogleLeadWebhookResponse } },
    },
    async (req) => {
      const hook = req.googleLeadHook;
      if (!hook) throw new AppError('INTERNAL_ERROR');
      const lead = parseGoogleLead(req.body);
      // per hook: a sender-chosen lead id can never pre-empt another tenant's delivery. A test delivery is recorded
      // each time (Google's test leads share one id); an unreadable one without an id is keyed by its body.
      const p = platformOf(req);
      const ref = lead.isTest ? `test:${p.ids.next()}` : lead.leadId !== null ? `lead:${sha(lead.leadId).slice(0, 40)}` : `body:${sha(req.rawBody ?? '').slice(0, 40)}`;
      const eventId = `gads:${hook.hookId}:${ref}`;
      // never the key, never the content: ids and flags only
      const payload = { kind: 'google_lead_form', hookId: hook.hookId, leadIdSha256: lead.leadId !== null ? sha(lead.leadId) : null, isTest: lead.isTest };
      // the lead route's provider is 'lead' (webhook_events.provider is free text; the lead intake routes record 'lead')
      await run(req, 'lead', eventId, hook.tenantId, payload, () => receiveGoogleLead(deps(req), hook, lead));
      return {};
    },
  );

  const view = { config: { auth: 'integration.view' as const }, preHandler: authorize('integration.view', () => ({})) };
  const manage = { config: { auth: 'integration.manage' as const }, preHandler: authorize('integration.manage', () => ({})) };
  const routing = { config: { auth: 'settings.routing' as const }, preHandler: authorize('settings.routing', () => ({})) };
  const Params = z.object({ id: z.uuid() }).strict();
  const base = '/lead-sources/:id/google-lead-form';

  r.get(base, { ...view, schema: { params: Params, response: { 200: GoogleLeadFormView } } }, async (req) => getHook(deps(req), actorOf(req), req.params.id));
  r.post(base, { ...manage, schema: { params: Params, body: EnableBody, response: { 200: GoogleLeadFormKeyResponse } } }, async (req) => enableHook(deps(req), actorOf(req), req.params.id, req.body));
  r.post(`${base}/rotate`, { ...manage, schema: { params: Params, response: { 200: GoogleLeadFormKeyResponse } } }, async (req) => rotateHook(deps(req), actorOf(req), req.params.id));
  r.patch(base, { ...routing, schema: { params: Params, body: PatchBody, response: { 200: GoogleLeadFormView } } }, async (req) => patchHook(deps(req), actorOf(req), req.params.id, req.body));
  r.post(`${base}/off`, { ...manage, schema: { params: Params, response: { 200: GoogleLeadFormView } } }, async (req) => disableHook(deps(req), actorOf(req), req.params.id));
}

export { WEBHOOK_PATH };
export const leadFormsRoutes: RouteModule = { name: 'lead-forms', register };
