// Module 22 routes (channels and inbox). Mounted under /api by routes.ts.
//
// Public website chat (visitors are not principals, R-TEN-12; no cookie, no session; credential-less CORS from any
// website, server.ts; the widget's allowed origins are enforced here; rate limits per IP, widget and session):
//   GET  /public/chat/:widgetKey                    the disclosure the visitor must see first, the team name     public
//   POST /public/chat/:widgetKey/start              {name, phone|email, message, disclosureId} → session token    public (key is the authority)
//   POST /public/chat/session/:token/messages       {message, clientMessageId?}                                   public (token is the authority)
//   GET  /public/chat/session/:token/poll?after=    that session's delivered replies, oldest first, + cursor      public (token)
// (Fastify names the widget-key parameter `widgetToken`: the key in the URL is the route's only authority, which is
//  what rbac.ts's capabilityUrl declaration requires; the URL is the same.)
//
// Website chat widgets (Owner/Admin; disconnect is POST /admin/integrations/connections/:id/disconnect):
//   GET  /admin/web-chat/widgets                     list                                                          integration.view
//   POST /admin/web-chat/widgets                     create for a lead source; the key is returned ONCE            integration.manage 🔒
//   POST /admin/web-chat/widgets/:id/rotate          a new key (returned once); the old embed stops at once        integration.manage 🔒
//   PUT  /admin/web-chat/widgets/:id/origins         the websites it may run on                                    integration.manage 🔒
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { depsFromPlatform } from '../comms/runtime.js';
import { actorOf, platformOf } from '../leads/common.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import type { Platform } from '../server.js';
import { type WebChatDeps, MESSAGE_MAX, NAME_MAX, normalizeOrigin, pollSession, postVisitorMessage, startChat, widgetConfig } from './webchat.js';
import { createWidget, listWidgets, rotateWidgetKey, setWidgetOrigins } from './widgets.js';

/** A chat body is a few kilobytes at most; anything larger is 413 before parsing. */
export const PUBLIC_CHAT_BODY_LIMIT = 16_384;

export function webChatDeps(p: Platform): WebChatDeps {
  return { comms: depsFromPlatform(p), secret: p.config.sessionSecret };
}

// No control characters except newline and tab in a message; none at all in a name (header / log injection).
const NO_CONTROL = /^[^\p{Cc}\p{Cf}]*$/u;
const MESSAGE_TEXT = /^(?:[^\p{Cc}\p{Cf}]|[\n\t])*$/u;
const Name = z.string().trim().min(1).max(NAME_MAX).regex(NO_CONTROL);
const Message = z.string().trim().min(1).max(MESSAGE_MAX).regex(MESSAGE_TEXT);
const WidgetParams = z.strictObject({ widgetToken: z.string().min(1).max(200) });
const SessionParams = z.strictObject({ token: z.string().min(1).max(200) });

export const StartBody = z.strictObject({
  name: Name,
  phone: z.string().trim().min(3).max(40).regex(NO_CONTROL).optional(),
  email: z.string().trim().min(3).max(254).regex(NO_CONTROL).optional(),
  message: Message,
  disclosureId: z.uuid(),
});
export const MessageBody = z.strictObject({ message: Message, clientMessageId: z.uuid().optional() });
/** the cursor a previous poll returned, passed back unchanged */
export const PollQuery = z.strictObject({ after: z.string().max(80).optional() });

export const ConfigResponse = z.object({ teamName: z.string(), disclosure: z.object({ id: z.uuid(), text: z.string() }).nullable(), assistantNotice: z.string() });
export const StartResponse = z.object({ sessionToken: z.string(), status: z.literal('open') });
export const MessageResponse = z.object({ accepted: z.literal(true) });
export const PollResponse = z.object({
  messages: z.array(z.object({ id: z.uuid(), body: z.string(), sentAt: z.string(), from: z.enum(['team', 'assistant']) })),
  cursor: z.string().nullable(),
  open: z.boolean(),
});

const Widget = z.object({ id: z.uuid(), displayName: z.string(), status: z.string(), leadSourceId: z.uuid().nullable(), allowedOrigins: z.array(z.string()), connectedAt: z.string().nullable(), sentence: z.string() });
export const WidgetsResponse = z.object({ widgets: z.array(Widget) });
export const WidgetResponse = z.object({ widget: Widget });
export const WidgetKeyResponse = z.object({ widget: Widget, widgetKey: z.string() });

/** Response schemas, for the R-AST-13 / R-TEN-3 snapshot test (no tenant id, no confidence field). */
export const CHANNEL_RESPONSE_SCHEMAS = { ConfigResponse, StartResponse, MessageResponse, PollResponse, WidgetsResponse, WidgetResponse, WidgetKeyResponse };

const originOf = (req: FastifyRequest) => normalizeOrigin(typeof req.headers.origin === 'string' ? req.headers.origin : undefined);

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const pub = { auth: 'public' as const };
  const cap = { auth: 'public' as const, capabilityUrl: true as const };

  r.get('/public/chat/:widgetToken', { config: pub, schema: { params: WidgetParams, response: { 200: ConfigResponse } } }, async (req) =>
    widgetConfig(webChatDeps(platformOf(req)), req.params.widgetToken, originOf(req)),
  );
  r.post('/public/chat/:widgetToken/start', { config: cap, bodyLimit: PUBLIC_CHAT_BODY_LIMIT, schema: { params: WidgetParams, body: StartBody, response: { 200: StartResponse } } }, async (req) =>
    startChat(webChatDeps(platformOf(req)), req.params.widgetToken, originOf(req), req.ip, req.body),
  );
  r.post('/public/chat/session/:token/messages', { config: cap, bodyLimit: PUBLIC_CHAT_BODY_LIMIT, schema: { params: SessionParams, body: MessageBody, response: { 200: MessageResponse } } }, async (req) =>
    postVisitorMessage(webChatDeps(platformOf(req)), req.params.token, req.ip, req.body),
  );
  r.get(
    '/public/chat/session/:token/poll',
    { config: pub, schema: { params: SessionParams, querystring: PollQuery, response: { 200: PollResponse } } },
    async (req) => pollSession(webChatDeps(platformOf(req)), req.params.token, req.ip, req.query.after),
  );

  const view = { config: { auth: 'integration.view' as const }, preHandler: authorize('integration.view', () => ({})) };
  const manage = { config: { auth: 'integration.manage' as const }, preHandler: authorize('integration.manage', () => ({})) };
  const Params = z.strictObject({ id: z.uuid() });
  const Origins = z.array(z.string().trim().min(1).max(300)).max(10);
  const deps = (req: FastifyRequest) => ({ db: platformOf(req).db, ids: platformOf(req).ids });

  r.get('/admin/web-chat/widgets', { ...view, schema: { response: { 200: WidgetsResponse } } }, async (req) => ({ widgets: await listWidgets(deps(req), actorOf(req)) }));
  r.post(
    '/admin/web-chat/widgets',
    { ...manage, schema: { body: z.strictObject({ displayName: z.string().trim().min(1).max(120).regex(NO_CONTROL), leadSourceId: z.uuid(), allowedOrigins: Origins.default([]) }), response: { 200: WidgetKeyResponse } } },
    async (req) => createWidget(deps(req), actorOf(req), req.body),
  );
  r.post('/admin/web-chat/widgets/:id/rotate', { ...manage, schema: { params: Params, response: { 200: WidgetKeyResponse } } }, async (req) => rotateWidgetKey(deps(req), actorOf(req), req.params.id));
  r.put('/admin/web-chat/widgets/:id/origins', { ...manage, schema: { params: Params, body: z.strictObject({ allowedOrigins: Origins }), response: { 200: WidgetResponse } } }, async (req) => ({
    widget: await setWidgetOrigins(deps(req), actorOf(req), req.params.id, req.body.allowedOrigins),
  }));
}

export const channelRoutes: RouteModule = { name: 'channels', register };
