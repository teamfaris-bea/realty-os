// api/comms route module (BUILD_PLAN module 12), mounted under /api by routes.ts:
//   POST /contacts/:id/messages            text/email (send-time gate)            comms.send
//   POST /contacts/:id/messages/preview    compose-time preview                    comms.send
//   GET  /contacts/:id/reachability        who can be texted/emailed/called, why not contact.view_detail
//   GET  /reachability?contactIds=a,b      the same for up to 50 contacts (feed)   self (each row: detail-visible under RLS)
//   POST /messages/:id/send                re-tap / confirm a waiting message      comms.send
//   POST /messages/:id/cancel              cancel a scheduled message              comms.send
//   POST /contacts/:id/calls               tap-to-call (dial-time gate)            comms.call
//   POST /calls/:id/outcome                post-call outcome                       comms.call
//   POST /contacts/:id/consent             staff consent entry / revoke            consent.record
//   POST /consent-events/:id/not-opt-out   R-CONSENT-8 review                      consent.record
//   POST /suppressions/:id/lift            Owner/Admin, 🔒                          suppression.lift
//   POST /contacts/:id/automation/resume   human-only resume                       comms.send (as marketing)
//   POST /recordings/:id/stream-token      60 s single-use token                   recording.play
//   GET  /recordings/:id/stream?token=     audited playback                        recording.play
//   GET  /recordings/:id/transcript        audited transcript view                 transcript.view
//   GET/POST /numbers, POST /numbers/:id/release (🔒), PATCH /numbers/:id/registration
//   POST /sender-registrations, POST /sender-registrations/:id/refresh
//   POST /sending-domains, POST /sending-domains/:id/verify, POST /email-identities      settings.numbers
//   GET/POST /email/unsubscribe/:token     the person's own unsubscribe            public
//   POST /webhooks/…                       provider webhooks (signed)              webhook
import { classifyHumanPurpose } from '@realty/core/compliance';
import type { ResourceFacts, UserActor } from '@realty/core/foundation';
import { REAUTH_WINDOW_MS } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import { cancelMessage, composeHumanMessage, previewHumanMessage, sendExisting } from './compose.js';
import { liftSuppression, logCallOutcome, markNotOptOut, recordStaffConsent, resumeAutomation, unsubscribeByLink } from './consent.js';
import { startCall } from './dial.js';
import { reachabilityFor, reachabilityOf } from './reachability.js';
import { acquireNumber, addDomain, addEmailIdentity, attachRegistration, createRegistration, listNumbers, refreshRegistration, releaseNumber, verifyDomain } from './numbers.js';
import { issueStreamToken, recordingFacts, streamRecording, viewTranscript } from './recordings.js';
import { contactFacts, dealOrAppointmentContext, detailVisibleContact } from './repos/contacts.js';
import { conversationOf } from './repos/gate.js';
import { depsFromPlatform } from './runtime.js';
import { systemActor } from '../worker/systemActor.js';
import * as S from './schemas.js';
import { registerWebhookRoutes } from './webhooks.js';

const IdParams = z.object({ id: z.uuid() });

function actorOf(req: FastifyRequest): UserActor {
  if (!req.actor) throw new AppError('UNAUTHENTICATED');
  return req.actor;
}

function factsTx<T>(req: FastifyRequest, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return withTenantTx(actorOf(req), (tx) => fn(tx), { db: req.server.platform.db });
}

const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;

async function sendFacts(tx: Tx, contactId: string): Promise<ResourceFacts | null> {
  const f = await contactFacts(tx, contactId);
  if (!f) return null;
  const conv = await conversationOf(tx, contactId);
  const now = (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(tx)).rows[0]!.now.getTime();
  return { ...f, purpose: classifyHumanPurpose({ lastInboundAt: conv?.lastInboundAt ?? null, dealOrAppointmentContext: await dealOrAppointmentContext(tx, contactId), now: now as never }) };
}

const contactSend = (req: FastifyRequest) => factsTx(req, (tx) => sendFacts(tx, idOf(req)));

/**
 * Resuming automation lets the assistant send on the owner's behalf again, including marketing steps,
 * so the human who resumes must be allowed to send ANY message to the contact (purpose 'marketing'):
 * a TC (informational only, D) cannot restart an agent's nurture.
 */
const contactResume = (req: FastifyRequest) =>
  factsTx(req, async (tx) => {
    const f = await contactFacts(tx, idOf(req));
    return f ? { ...f, purpose: 'marketing' as const } : null;
  });

const messageSend = (req: FastifyRequest) =>
  factsTx(req, async (tx) => {
    const r = await sql<{ contact_id: string }>`SELECT contact_id FROM messages WHERE tenant_id = app.tenant_id() AND id = ${idOf(req)}`.execute(tx);
    return r.rows[0] ? sendFacts(tx, r.rows[0].contact_id) : null;
  });

const callFacts = async (req: FastifyRequest): Promise<ResourceFacts | null> => {
  const visible = await factsTx(req, async (tx) => {
    const r = await sql<{ contact_id: string }>`SELECT contact_id FROM calls WHERE tenant_id = app.tenant_id() AND id = ${idOf(req)}`.execute(tx);
    return r.rows[0] ? sendFacts(tx, r.rows[0].contact_id) : null;
  });
  if (visible) return visible;
  // E14: the lead moved during the call; the agent who was on it may still hand its outcome over
  const actor = actorOf(req);
  const own = await withTenantTx(systemActor(actor.tenantId, 'worker'), async (tx) => {
    const r = await sql<{ ok: boolean }>`
      SELECT agent_user_id = ${actor.userId} AND started_at > now() - interval '24 hours' AS ok FROM calls
       WHERE tenant_id = app.tenant_id() AND id = ${idOf(req)} AND direction = 'outbound'`.execute(tx);
    return r.rows[0]?.ok === true;
  }, { db: req.server.platform.db });
  return own ? { own: true, purpose: 'informational' } : null;
};

async function consentFacts(tx: Tx, contactId: string | null): Promise<ResourceFacts | null> {
  if (!contactId) return null;
  const f = await contactFacts(tx, contactId);
  if (!f) return null;
  const s = await sql<{ on: boolean }>`SELECT agent_consent_entry_allowed AS on FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx);
  return { ...f, settings: { agentConsentEntryAllowed: s.rows[0]?.on === true } };
}

/** R-PERM-13 style re-auth for suppression lifts (BUILD_PLAN: Owner/Admin, reauth; stricter than §3). */
function requireFreshReauth(req: FastifyRequest): void {
  const s = req.authState;
  if (!s || s.reauthenticatedAt === null || s.now - s.reauthenticatedAt > REAUTH_WINDOW_MS || s.now < s.reauthenticatedAt) throw new AppError('REAUTH_REQUIRED');
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const deps = () => depsFromPlatform(app.platform);

  // ---- messages ----
  r.post('/contacts/:id/messages', { config: { auth: 'comms.send' }, preHandler: authorize('comms.send', contactSend), schema: { params: IdParams, body: S.ComposeBody, response: { 200: S.ComposeResponse } } }, async (req) =>
    composeHumanMessage(actorOf(req), req.params.id, req.body, deps()),
  );
  r.post('/contacts/:id/messages/preview', { config: { auth: 'comms.send' }, preHandler: authorize('comms.send', contactSend), schema: { params: IdParams, body: S.PreviewBody, response: { 200: S.PreviewResponse } } }, async (req) =>
    previewHumanMessage(actorOf(req), req.params.id, req.body, deps()),
  );
  r.post('/messages/:id/send', { config: { auth: 'comms.send' }, preHandler: authorize('comms.send', messageSend), schema: { params: IdParams, body: S.SendExistingBody, response: { 200: S.ComposeResponse } } }, async (req) =>
    sendExisting(actorOf(req), req.params.id, deps()),
  );
  r.post('/messages/:id/cancel', { config: { auth: 'comms.send' }, preHandler: authorize('comms.send', messageSend), schema: { params: IdParams, response: { 200: z.object({ message: S.MessageSchema }) } } }, async (req) => ({
    message: await cancelMessage(actorOf(req), req.params.id, deps()),
  }));
  r.post('/contacts/:id/automation/resume', { config: { auth: 'comms.send' }, preHandler: authorize('comms.send', contactResume), schema: { params: IdParams, response: { 200: S.ResumeResponse } } }, async (req) =>
    resumeAutomation(actorOf(req), req.params.id, deps()),
  );

  // ---- reachability (read-only; lane optout-visibility) ----
  r.get('/contacts/:id/reachability', { config: { auth: 'contact.view_detail' }, preHandler: authorize('contact.view_detail', (req) => factsTx(req, (tx) => contactFacts(tx, idOf(req)))), schema: { params: IdParams, response: { 200: S.ReachabilityResponse } } }, async (req) =>
    withTenantTx(actorOf(req), async (tx, now) => {
      const v = (await detailVisibleContact(tx, req.params.id)) ? await reachabilityOf(tx, req.params.id, now) : null;
      if (!v) throw new AppError('NOT_FOUND');
      return { reachability: v };
    }, { db: req.server.platform.db }),
  );
  // the feed's cards at once (up to 50): contacts the caller does not see in detail are simply absent
  r.get('/reachability', { config: { auth: 'self' }, schema: { querystring: z.strictObject({ contactIds: z.string().max(50 * 37).transform((s) => s.split(',').filter(Boolean)).pipe(z.array(z.uuid()).min(1).max(50)) }), response: { 200: S.ReachabilityManyResponse } } }, async (req) =>
    withTenantTx(actorOf(req), async (tx, now) => ({ reachability: [...(await reachabilityFor(tx, req.query.contactIds, now)).values()] }), { db: req.server.platform.db }),
  );

  // ---- calls ----
  r.post('/contacts/:id/calls', { config: { auth: 'comms.call' }, preHandler: authorize('comms.call', contactSend), schema: { params: IdParams, body: S.CallBody, response: { 200: S.CallResponse } } }, async (req) => {
    const out = await startCall(actorOf(req), req.params.id, req.body, deps());
    if (out.kind === 'gate') return { result: 'gate' as const, callId: null, bridgeToken: null, reason: null, decision: out.decision };
    if (out.kind === 'failed') return { result: 'failed' as const, callId: out.callId, bridgeToken: null, reason: out.reason, decision: out.decision };
    return { result: 'dialing' as const, callId: out.callId, bridgeToken: out.bridgeToken, reason: null, decision: out.decision };
  });
  r.post('/calls/:id/outcome', { config: { auth: 'comms.call' }, preHandler: authorize('comms.call', callFacts), schema: { params: IdParams, body: S.OutcomeBody, response: { 200: S.OutcomeResponse } } }, async (req) =>
    logCallOutcome(actorOf(req), req.params.id, req.body.outcome, deps()),
  );

  // ---- consent ----
  r.post('/contacts/:id/consent', { config: { auth: 'consent.record' }, preHandler: authorize('consent.record', (req) => factsTx(req, (tx) => consentFacts(tx, idOf(req)))), schema: { params: IdParams, body: S.ConsentBody, response: { 200: S.ConsentResponse } } }, async (req) =>
    recordStaffConsent(actorOf(req), req.params.id, req.body, deps()),
  );
  r.post('/consent-events/:id/not-opt-out', {
    config: { auth: 'consent.record' },
    preHandler: authorize('consent.record', (req) => factsTx(req, async (tx) => consentFacts(tx, (await sql<{ contact_id: string | null }>`SELECT contact_id FROM consent_events WHERE tenant_id = app.tenant_id() AND id = ${idOf(req)}`.execute(tx)).rows[0]?.contact_id ?? null))),
    schema: { params: IdParams, body: S.NotOptOutBody, response: { 200: S.NotOptOutResponse } },
  }, async (req) => markNotOptOut(actorOf(req), req.params.id, req.body.reason, deps()));
  r.post('/suppressions/:id/lift', {
    config: { auth: 'suppression.lift' },
    preHandler: authorize('suppression.lift', (req) => factsTx(req, async (tx) => {
      const s = await sql<{ reason: string }>`SELECT reason FROM suppressions WHERE tenant_id = app.tenant_id() AND id = ${idOf(req)}`.execute(tx);
      return s.rows[0] ? { suppressionReason: s.rows[0].reason } : null;
    })),
    schema: { params: IdParams, body: S.LiftBody, response: { 200: S.LiftResponse } },
  }, async (req) => {
    requireFreshReauth(req);
    return liftSuppression(actorOf(req), req.params.id, req.body.reason, deps());
  });

  // ---- recordings ----
  const recFacts = (req: FastifyRequest) => factsTx(req, (tx) => recordingFacts(tx, idOf(req)));
  r.post('/recordings/:id/stream-token', { config: { auth: 'recording.play' }, preHandler: authorize('recording.play', recFacts), schema: { params: IdParams, body: S.StreamTokenBody, response: { 200: S.StreamTokenResponse } } }, async (req) =>
    issueStreamToken(actorOf(req), req.params.id, req.body.purpose, deps()),
  );
  r.get('/recordings/:id/stream', { config: { auth: 'recording.play' }, preHandler: authorize('recording.play', recFacts), schema: { params: IdParams, querystring: z.object({ token: z.string().min(20).max(100) }) } }, async (req, reply) => {
    const out = await streamRecording(actorOf(req), req.params.id, req.query.token, deps());
    reply.header('content-type', out.contentType).header('cache-control', 'no-store');
    return reply.send(Buffer.from(out.bytes));
  });
  r.get('/recordings/:id/transcript', { config: { auth: 'transcript.view' }, preHandler: authorize('transcript.view', recFacts), schema: { params: IdParams, response: { 200: S.TranscriptResponse } } }, async (req) =>
    viewTranscript(actorOf(req), req.params.id, deps()),
  );

  // ---- numbers, registrations, domains, identities (Owner/Admin) ----
  const admin = { config: { auth: 'settings.numbers' as const }, preHandler: authorize('settings.numbers', () => ({})) };
  r.get('/numbers', { ...admin, schema: { response: { 200: S.NumbersResponse } } }, async (req) => ({ numbers: await listNumbers(actorOf(req), deps()) }));
  r.post('/numbers', { ...admin, schema: { body: S.AcquireBody, response: { 201: S.NumberResponse } } }, async (req, reply) => {
    const n = await acquireNumber(actorOf(req), req.body, deps());
    reply.status(201);
    return { number: n };
  });
  r.patch('/numbers/:id/registration', { ...admin, schema: { params: IdParams, body: S.AttachRegistrationBody, response: { 200: S.NumberResponse } } }, async (req) => ({
    number: await attachRegistration(actorOf(req), req.params.id, req.body.registrationId, deps()),
  }));
  r.post('/numbers/:id/release', { config: { auth: 'number.release' }, preHandler: authorize('number.release', () => ({})), schema: { params: IdParams, response: { 200: S.NumberResponse } } }, async (req) => ({
    number: await releaseNumber(actorOf(req), req.params.id, deps()),
  }));
  r.post('/sender-registrations', { ...admin, schema: { body: S.RegistrationBody, response: { 201: S.RegistrationResponse } } }, async (req, reply) => {
    const reg = await createRegistration(actorOf(req), req.body, deps());
    reply.status(201);
    return { registration: reg };
  });
  r.post('/sender-registrations/:id/refresh', { ...admin, schema: { params: IdParams, response: { 200: S.RegistrationResponse } } }, async (req) => ({
    registration: await refreshRegistration(actorOf(req), req.params.id, deps()),
  }));
  r.post('/sending-domains', { ...admin, schema: { body: S.DomainBody, response: { 201: S.DomainResponse } } }, async (req, reply) => {
    const d = await addDomain(actorOf(req), req.body.domain, deps());
    reply.status(201);
    return { domain: d };
  });
  r.post('/sending-domains/:id/verify', { ...admin, schema: { params: IdParams, response: { 200: S.DomainResponse } } }, async (req) => ({ domain: await verifyDomain(actorOf(req), req.params.id, deps()) }));
  r.post('/email-identities', { ...admin, schema: { body: S.IdentityBody, response: { 201: S.IdentityResponse } } }, async (req, reply) => {
    const i = await addEmailIdentity(actorOf(req), req.body, deps());
    reply.status(201);
    return { identity: i };
  });

  // ---- the person's own unsubscribe (public, MAC-signed link) ----
  const TokenParams = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}\.[A-Za-z0-9_-]{32}$/) });
  r.get('/email/unsubscribe/:token', { config: { auth: 'public' }, schema: { params: TokenParams } }, async (req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store');
    const action = `/api/email/unsubscribe/${encodeURIComponent(req.params.token)}`;
    return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribe</title>
<body style="font-family:system-ui;max-width:28rem;margin:3rem auto;padding:0 1rem"><h1 style="font-size:1.25rem">Stop marketing emails?</h1>
<form method="post" action="${action}"><button style="font-size:1rem;padding:.75rem 1.25rem">Unsubscribe</button></form></body>`;
  });
  // RFC 8058 one-click: the mailbox provider POSTs `List-Unsubscribe=One-Click` with no Origin and no cookie,
  // so this capability URL skips the Origin allowlist (opt-outs must always work); the MAC-signed token is the
  // only authority, and the action can only ever stop email. The page's own button posts here too.
  r.post('/email/unsubscribe/:token', { config: { auth: 'public', capabilityUrl: true }, schema: { params: TokenParams } }, async (req, reply) => {
    const out = await unsubscribeByLink(req.params.token, deps());
    if (out === 'invalid') throw new AppError('NOT_FOUND');
    if (String(req.headers.accept ?? '').includes('text/html')) {
      reply.header('content-type', 'text/html; charset=utf-8').header('cache-control', 'no-store');
      return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Unsubscribed</title>
<body><h1>You are unsubscribed</h1><p>You will not get marketing emails from this team again.</p></body>`;
    }
    return { unsubscribed: true };
  });

  await registerWebhookRoutes(app);
}

export const commsRoutes: RouteModule = { name: 'comms', register };
