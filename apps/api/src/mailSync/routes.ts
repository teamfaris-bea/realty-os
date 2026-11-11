// api/mail-sync routes (module 68; PHASE2_3_PLAN §5.4 #68). Mounted under /api.
//
//   GET    /me/mail-link                      own link: status, mailbox address, last sync, last error      self
//   POST   /me/mail-link/connect              OAuth start (PKCE + state; exactly gmail.readonly)            self
//   GET    /me/mail-link/callback             Google's redirect; the SYSTEM actor (the signed state)       public
//   DELETE /me/mail-link                      disconnect: token deleted, copies hidden at once             self
//   POST   /me/mail-link/import-again         re-run the backfill window (R-GMAIL-8)                        self
//   GET    /me/mail-sync-points               own confirmed addresses + suggestions (S-D2-1)                self
//   POST   /me/mail-sync-points               confirm addresses (bulk at connect, later one tap each)       self
//   DELETE /me/mail-sync-points/:pointId      "Stop syncing this address" (S-D2-2)                          self
//   POST   /me/mail-threads/:threadId/exclude "Remove this thread from Realty OS" (R-GMAIL-7)               self
//   GET    /contacts/:id/mail-messages        the contact's synced copies, newest first; RLS decides         self (RLS)
//   GET    /admin/mail-sync                   the Owner switch, the window, the platform:gmail state          integration.view
//   PUT    /admin/mail-sync                   Owner turns on / sets the window; Admin turns off              mail_sync.manage 🔒
//
// Self routes act only on the caller's own link under RLS: Owners, Admins and Team Leads read no one else's link,
// token, sync state, confirmations or exclusions. No response ever carries refresh_enc, a token, a tenant id or a
// confidence field; the mail read route is the ONLY read path of synced mail (R-GMAIL-14), and support never reads it
// (RESTRICTIVE policy, even under a grant).
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, adminTx, platformOf } from '../admin/common.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import type { Platform } from '../server.js';
import { withTenantTx } from '@realty/db';
import {
  type MailSyncServiceDeps,
  adminSettings,
  confirmSyncPoints,
  contactMailMessages,
  disconnect,
  excludeThread,
  getOwnLink,
  importAgain,
  listSyncPoints,
  oauthCallback,
  removeSyncPoint,
  startConnect,
  updateAdminSettings,
} from './service.js';

const Iso = z.string();
export const LinkResponse = z.object({
  id: z.uuid(),
  status: z.enum(['connected', 'degraded', 'revoked']),
  mailboxAddress: z.string(),
  connectedAt: Iso,
  lastSyncedAt: Iso.nullable(),
  lastErrorCode: z.string().nullable(),
  revokeReason: z.string().nullable(),
  backfillRequestedAt: Iso.nullable(),
  backfillDoneAt: Iso.nullable(),
  statusSentence: z.string(),
});
export const OwnLinkResponse = z.object({
  available: z.object({ cleared: z.boolean(), enabled: z.boolean(), configured: z.boolean(), canConnect: z.boolean(), sentence: z.string() }),
  link: LinkResponse.nullable(),
  backfillDays: z.number().int(),
  pollIntervalSeconds: z.number().int(),
  disclosureSha256: z.string(),
});
export const ConnectResponse = z.object({ authorizeUrl: z.string(), expiresAt: Iso });
const PointView = z.object({ pointId: z.uuid(), contactId: z.uuid(), contactName: z.string(), address: z.string() });
export const SyncPointsResponse = z.object({ confirmed: z.array(PointView.extend({ confirmedAt: Iso })), suggestions: z.array(PointView) });
export const MailMessagesResponse = z.object({
  items: z.array(
    z.object({
      id: z.uuid(),
      threadId: z.string(),
      internalAt: Iso,
      sender: z.enum(['contact', 'mailbox', 'other']),
      contactRole: z.enum(['from', 'to', 'cc', 'bcc']),
      otherRecipientCount: z.number().int(),
      subject: z.string().nullable(),
      body: z.string(),
      bodyTruncated: z.boolean(),
      attachments: z.array(z.object({ name: z.string(), mimeType: z.string(), sizeBytes: z.number().int() })),
      origin: z.enum(['live', 'backfill']),
      mine: z.boolean(),
      mailboxOwnerName: z.string(),
      threadCapped: z.boolean(),
    }),
  ),
  coverage: z.array(z.object({ address: z.string(), since: Iso })),
  nextBefore: Iso.nullable(),
});
export const AdminMailResponse = z.object({
  enabled: z.boolean(),
  backfillDays: z.number().int(),
  pack: z.object({ cleared: z.boolean(), reviewedByCounsel: z.boolean(), vendorReady: z.boolean(), sentence: z.string() }),
  canTurnOn: z.boolean(),
  role: z.enum(['owner', 'admin']),
});

const ThreadId = z.string().regex(/^[0-9A-Za-z_-]{1,64}$/);

export function mailSyncDeps(p: Platform): MailSyncServiceDeps {
  return {
    db: p.db,
    envelope: p.envelope,
    ids: p.ids,
    gmail: p.providers.gmail,
    secret: p.config.sessionSecret,
    publicBaseUrl: p.config.publicBaseUrl,
    webOrigin: p.config.webOrigins[0]!,
    now: () => p.clock.now(),
  };
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const self = { config: { auth: 'self' as const } };
  const asSelf = <T>(req: Parameters<typeof actorOf>[0], fn: Parameters<typeof adminTx<T>>[1]) => adminTx(req, fn);

  r.get('/me/mail-link', { ...self, schema: { response: { 200: OwnLinkResponse } } }, async (req) => asSelf(req, (tx) => getOwnLink(tx, platformOf(req).providers.gmail)));

  r.post(
    '/me/mail-link/connect',
    { ...self, schema: { body: z.object({ disclosureSha256: z.string().regex(/^[0-9a-f]{64}$/) }).strict(), response: { 201: ConnectResponse } } },
    async (req, reply) => {
      const deps = mailSyncDeps(platformOf(req));
      const out = await asSelf(req, (tx, _now, actor) => startConnect(deps, tx, actor, req.body.disclosureSha256));
      reply.status(201);
      return out;
    },
  );

  r.get(
    '/me/mail-link/callback',
    {
      config: { auth: 'public' },
      schema: { querystring: z.object({ state: z.string().max(4096).optional(), code: z.string().max(4096).optional(), scope: z.string().max(4096).optional(), error: z.string().max(200).optional() }) },
    },
    async (req, reply) => {
      const res = await oauthCallback(mailSyncDeps(platformOf(req)), req.query);
      req.log.info({ outcome: res.outcome }, 'gmail oauth callback');
      return reply.redirect(res.location, 303);
    },
  );

  r.delete('/me/mail-link', { ...self, schema: { response: { 200: z.object({ link: LinkResponse }) } } }, async (req) => ({ link: await disconnect(mailSyncDeps(platformOf(req)), actorOf(req)) }));

  r.post('/me/mail-link/import-again', { ...self, schema: { response: { 200: z.object({ link: LinkResponse }) } } }, async (req) => ({ link: await asSelf(req, (tx, _n, actor) => importAgain(tx, actor)) }));

  r.get('/me/mail-sync-points', { ...self, schema: { response: { 200: SyncPointsResponse } } }, async (req) => listSyncPoints(mailSyncDeps(platformOf(req)), actorOf(req)));

  r.post(
    '/me/mail-sync-points',
    { ...self, schema: { body: z.object({ pointIds: z.array(z.uuid()).min(1).max(500) }).strict(), response: { 200: z.object({ confirmed: z.number().int() }) } } },
    async (req) => asSelf(req, (tx, _n, actor) => confirmSyncPoints(tx, actor, req.body.pointIds)),
  );

  r.delete(
    '/me/mail-sync-points/:pointId',
    { ...self, schema: { params: z.object({ pointId: z.uuid() }).strict(), response: { 200: z.object({ removed: z.boolean() }) } } },
    async (req) => asSelf(req, (tx, _n, actor) => removeSyncPoint(tx, actor, req.params.pointId)),
  );

  r.post(
    '/me/mail-threads/:threadId/exclude',
    { ...self, schema: { params: z.object({ threadId: ThreadId }).strict(), response: { 200: z.object({ excluded: z.literal(true) }) } } },
    async (req) => asSelf(req, (tx, _n, actor) => excludeThread(tx, actor, req.params.threadId)),
  );

  r.get(
    '/contacts/:id/mail-messages',
    {
      ...self,
      schema: {
        params: z.object({ id: z.uuid() }).strict(),
        querystring: z.object({ before: z.iso.datetime({ offset: true }).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict(),
        response: { 200: MailMessagesResponse },
      },
    },
    // RLS does the visibility: timeline readers plus the mailbox owner; hidden copies never return; support never
    async (req) => withTenantTx(actorOf(req), (tx) => contactMailMessages(tx, req.params.id, req.query), { db: platformOf(req).db }),
  );

  const manage = { config: { auth: 'mail_sync.manage' as const }, preHandler: authorize('mail_sync.manage', () => ({})) };
  // reading the switch is an admin view (Owner/Admin, no re-auth), like the integrations page
  const view = { config: { auth: 'integration.view' as const }, preHandler: authorize('integration.view', () => ({})) };
  r.get('/admin/mail-sync', { ...view, schema: { response: { 200: AdminMailResponse } } }, async (req) => adminTx(req, (tx, _n, actor) => adminSettings(tx, actor)));
  r.put(
    '/admin/mail-sync',
    { ...manage, schema: { body: z.object({ enabled: z.boolean(), backfillDays: z.number().int().min(0).max(90) }).strict(), response: { 200: AdminMailResponse } } },
    async (req) => adminTx(req, (tx, _n, actor) => updateAdminSettings(tx, actor, req.body)),
  );
}

export const mailSyncRoutes: RouteModule = { name: 'mail-sync', register };
