// Provider webhooks of api/comms (ARCHITECTURE §3 "Webhook lifecycle"). The webhook guard (server.ts)
// has already verified the signature; a bad one never reaches these handlers and writes no tenant row.
//   1 resolve the tenant: the number that was texted/called (app.resolve_inbound_number: live numbers
//     only, so inbound to a released or quarantined number is never delivered: unrouted, R-TEN-8 / E55),
//     the email routing token (app.resolve_inbound_email_token), or a MAC-signed reference we issued
//   2 idempotency: app.record_webhook_event(provider, provider_event_id) (payload platform-encrypted)
//   3 the work, in the tenant, as the system actor (via 'provider')
//
//   POST /webhooks/telephony/sms        inbound SMS/MMS            → ingestInbound
//   POST /webhooks/telephony/status     outbound SMS status        → applyMessageStatus (?m={message id})
//   POST /webhooks/telephony/voice      inbound calls + outbound call status (announcement result)
//   POST /webhooks/telephony/recording  a recording is ready       → comms.recording_copy job
//   POST /webhooks/telephony/answer     Twilio <Number url>: the client answered a click-to-call; plays the
//                                       recording announcement and records that it played (?c= signed call ref)
//   POST /webhooks/email/inbound        a reply to r+{token}@in…   → ingestInbound
//   POST /webhooks/email/events         delivered/bounced/complained/opened/clicked/unsubscribed (X-Realty-Ref echo)
//   POST /webhooks/email/postmark/{inbound,events}   the same, in Postmark's formats (Basic auth)
//   POST /webhooks/email/sendgrid/inbound            SendGrid Inbound Parse (multipart, Basic auth)
//   POST /webhooks/email/sendgrid/events             SendGrid Event Webhook (ECDSA signature)
// With TELEPHONY_PROVIDER=twilio the guard also resolved the tenant from the signing subaccount
// (req.webhookTenantId); a number that resolves to a different tenant is treated as unrouted.
import { createHash } from 'node:crypto';
import type { IdGenerator, Instant } from '@realty/core/foundation';
import { at, instant, toIso } from '@realty/core/foundation';
import { type Database, enqueueJob, withPreTenant, withTenantTx } from '@realty/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import type { EnvelopeService } from '../crypto/envelope.js';
import { AppError } from '../errors.js';
import { systemActor } from '../worker/systemActor.js';
import { announcementTwiml } from '../providers/twilio/telephony.js';
import { type NormalizedEmailEvent, type NormalizedInbound, parsePostmarkEvent, parsePostmarkInbound, parseSendgridEvents, parseSendgridInbound } from '../providers/email/inbound.js';
import { unsubscribeMessageRecipient } from './consent.js';
import { RECORDING_ANNOUNCEMENT, applyCallStatus } from './dial.js';
import { ingestInbound, isMissedCallStatus, recordMissedInboundCall } from './inbound.js';
import { RECORDING_COPY_JOB } from './recordings.js';
import { tokenFromRecipient, verifySignedRef } from './render.js';
import { depsFromPlatform } from './runtime.js';
import { type MappedStatus, applyMessageStatus, mapTelephonyStatus } from './status.js';

type Provider = 'telephony' | 'email';

async function resolveNumber(db: Database, e164: string): Promise<string | null> {
  if (!/^\+[1-9][0-9]{6,14}$/.test(e164)) return null;
  return withPreTenant(async (tx) => (await sql<{ tenant_id: string }>`SELECT tenant_id FROM app.resolve_inbound_number(${e164})`.execute(tx)).rows[0]?.tenant_id ?? null, { db });
}

async function resolveEmailToken(db: Database, token: string): Promise<{ tenantId: string; conversationId: string } | null> {
  const hash = createHash('sha256').update(token, 'utf8').digest();
  return withPreTenant(async (tx) => {
    const r = await sql<{ tenant_id: string; conversation_id: string }>`SELECT tenant_id, conversation_id FROM app.resolve_inbound_email_token(${hash})`.execute(tx);
    return r.rows[0] ? { tenantId: r.rows[0].tenant_id, conversationId: r.rows[0].conversation_id } : null;
  }, { db });
}

/** Records the delivery (idempotency + unrouted log). Returns the webhook id, or null for a duplicate. */
async function recordEvent(db: Database, ids: IdGenerator, envelope: EnvelopeService, provider: Provider, eventId: string, tenantId: string | null, payload: unknown, now: Instant): Promise<string | null> {
  const id = ids.next<'WebhookEventId'>();
  const enc = envelope.encryptPlatform('webhook', { table: 'webhook_events', column: 'payload_enc', rowId: id }, Buffer.from(JSON.stringify(payload)));
  const ok = await withPreTenant(async (tx) => (await sql<{ ok: boolean }>`
    SELECT app.record_webhook_event(${id}::uuid, ${provider}, ${eventId.slice(0, 200)}, ${tenantId}::uuid, true, ${Buffer.from(enc)}, ${toIso(now)}::timestamptz) AS ok`.execute(tx)).rows[0]?.ok ?? false, { db });
  return ok ? id : null;
}

async function finishEvent(db: Database, id: string, ok: boolean, code: string | null, now: Instant): Promise<void> {
  await withPreTenant(async (tx) => {
    await sql`SELECT app.finish_webhook_event(${id}::uuid, ${ok ? 'processed' : 'failed'}, ${code}, ${toIso(now)}::timestamptz)`.execute(tx);
  }, { db });
}

/**
 * The tenant of a telephony callback: the number's tenant, cross-checked against the subaccount that signed
 * the request when the guard resolved one (Twilio). A mismatch is unrouted, never delivered to either tenant.
 */
async function telephonyTenant(req: FastifyRequest, e164: string | undefined): Promise<string | null> {
  const byNumber = e164 ? await resolveNumber(req.server.platform.db, e164) : null;
  const byAccount = req.webhookTenantId;
  if (byAccount === undefined || byAccount === null) return byNumber;
  return byNumber === null || byNumber === byAccount ? byAccount : null;
}

const Form = z.record(z.string(), z.string());

/** A provider duration in whole seconds, or null when absent or malformed (never fails the callback). */
function durationOf(v: string | undefined): number | null {
  if (v === undefined || !/^\d{1,6}$/.test(v.trim())) return null;
  return Number(v.trim());
}
const twiml = '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';

function occurred(v: string | undefined, now: Instant): Instant {
  if (!v) return now;
  const t = Date.parse(v);
  return Number.isFinite(t) && Math.abs(t - now) < 7 * 24 * 3600_000 ? instant(t) : now;
}

async function run<T>(req: FastifyRequest, provider: Provider, eventId: string, tenantId: string | null, payload: unknown, fn: () => Promise<T>): Promise<'duplicate' | 'unrouted' | T> {
  const p = req.server.platform;
  const now = p.clock.now();
  const id = await recordEvent(p.db, p.ids, p.envelope, provider, eventId, tenantId, payload, now);
  if (!id) return 'duplicate';
  if (!tenantId) {
    req.log.warn({ code: 'WEBHOOK_UNROUTED', provider }, 'unrouted inbound (platform alert)');
    return 'unrouted';
  }
  try {
    const out = await fn();
    await finishEvent(p.db, id, true, null, p.clock.now());
    return out;
  } catch (e) {
    await finishEvent(p.db, id, false, (e as { code?: string }).code ?? (e as Error).name ?? 'ERROR', p.clock.now());
    throw e;
  }
}

export async function registerWebhookRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const tel = { config: { auth: 'webhook' as const, webhookProvider: 'telephony' as const } };

  r.post('/webhooks/telephony/sms', { ...tel, schema: { body: Form } }, async (req, reply) => {
    const b = req.body;
    if (!b.MessageSid || !b.From || !b.To) throw new AppError('VALIDATION_FAILED');
    const p = req.server.platform;
    const tenantId = await telephonyTenant(req, b.To);
    await run(req, 'telephony', `sms:${b.MessageSid}`, tenantId, { sid: b.MessageSid }, () =>
      ingestInbound(systemActor(tenantId!, 'provider'), { kind: 'sms', providerRef: b.MessageSid!, from: b.From!, to: b.To!, body: b.Body ?? '', mediaCount: Number(b.NumMedia ?? '0') || 0 }, depsFromPlatform(p)),
    );
    reply.header('content-type', 'text/xml');
    return twiml;
  });

  r.post('/webhooks/telephony/status', { ...tel, schema: { body: Form, querystring: z.object({ m: z.uuid().optional() }) } }, async (req) => {
    const b = req.body;
    const mapped = mapTelephonyStatus(b.MessageStatus ?? '');
    if (!b.MessageSid || !b.From) throw new AppError('VALIDATION_FAILED');
    const p = req.server.platform;
    const tenantId = await telephonyTenant(req, b.From);
    if (!mapped) return { ok: true };
    const ref = `status:${b.MessageSid}:${b.MessageStatus}`;
    await run(req, 'telephony', ref, tenantId, { sid: b.MessageSid, status: b.MessageStatus }, () =>
      applyMessageStatus(systemActor(tenantId!, 'provider'), { providerEventRef: ref, message: req.query.m ? { id: req.query.m } : { providerRef: b.MessageSid! }, providerStatus: b.MessageStatus!, mapped, errorCode: b.ErrorCode ?? null, occurredAt: p.clock.now() }, depsFromPlatform(p)),
    );
    return { ok: true };
  });

  r.post('/webhooks/telephony/voice', { ...tel, schema: { body: Form } }, async (req, reply) => {
    const b = req.body;
    if (!b.CallSid || !b.From || !b.To) throw new AppError('VALIDATION_FAILED');
    const p = req.server.platform;
    const now = p.clock.now();
    const inbound = (b.Direction ?? 'inbound') === 'inbound';
    const tenantId = await telephonyTenant(req, inbound ? b.To : b.From);
    const status = (b.CallStatus ?? 'ringing').replace('-', '_');
    // Twilio: the client leg of a click-to-call is a child call; its status belongs to the parent we stored
    const callRef = b.Direction === 'outbound-dial' && b.ParentCallSid ? b.ParentCallSid : b.CallSid;
    const ref = `voice:${b.CallSid}:${status}:${b.AnnouncementStatus ?? ''}`;
    await run(req, 'telephony', ref, tenantId, { sid: b.CallSid, status }, async () => {
      const actor = systemActor(tenantId!, 'provider');
      const deps = depsFromPlatform(p);
      if (inbound && (status === 'ringing' || status === 'no_answer' || status === 'busy' || status === 'voicemail' || status === 'completed')) {
        const known = await applyCallStatus(actor, { providerCallRef: b.CallSid!, status: status as 'ringing', occurredAt: occurred(b.Timestamp, now) }, deps);
        if (known) {
          if (isMissedCallStatus(status)) await recordMissedInboundCall(actor, known, deps);
          return known;
        }
        return ingestInbound(actor, { kind: 'call', providerRef: b.CallSid!, from: b.From!, to: b.To!, status: status as 'ringing' }, deps);
      }
      const announcement = b.AnnouncementStatus === 'played' ? 'played' : b.AnnouncementStatus === 'failed' ? 'failed' : undefined;
      return applyCallStatus(actor, { providerCallRef: callRef, status: status as 'ringing', ...(announcement ? { announcement } : {}), ...(durationOf(b.CallDuration) !== null ? { durationS: durationOf(b.CallDuration)! } : {}), occurredAt: occurred(b.Timestamp, now) }, deps);
    });
    reply.header('content-type', 'text/xml');
    return twiml;
  });

  r.post('/webhooks/telephony/recording', { ...tel, schema: { body: Form } }, async (req) => {
    const b = req.body;
    // Twilio's recording callback carries no From; its tenant comes from the signing subaccount
    if (!b.CallSid || !b.RecordingSid || (!b.From && !req.webhookTenantId)) throw new AppError('VALIDATION_FAILED');
    const p = req.server.platform;
    const tenantId = await telephonyTenant(req, b.From);
    await run(req, 'telephony', `recording:${b.RecordingSid}`, tenantId, { call: b.CallSid, recording: b.RecordingSid }, () =>
      withTenantTx(systemActor(tenantId!, 'provider'), async (tx) => {
        await enqueueJob(tx, { queue: RECORDING_COPY_JOB.queue, kind: RECORDING_COPY_JOB.kind, payload: { callRef: b.CallSid!, recordingRef: b.RecordingSid!, durationS: Math.min(durationOf(b.RecordingDuration) ?? 0, 86_400) }, dedupeKey: RECORDING_COPY_JOB.dedupeKey(b.RecordingSid!) });
      }, { db: p.db }),
    );
    return { ok: true };
  });

  r.post('/webhooks/telephony/answer', { ...tel, schema: { body: Form, querystring: z.object({ c: z.string().max(100) }) } }, async (req, reply) => {
    const b = req.body;
    const p = req.server.platform;
    const parent = b.ParentCallSid ?? b.CallSid;
    const ref = verifySignedRef(p.config.sessionSecret, 'call-answer', req.query.c);
    if (!parent || !ref) throw new AppError('VALIDATION_FAILED');
    const tenantId = req.webhookTenantId === undefined || req.webhookTenantId === ref.tenantId ? ref.tenantId : null;
    // what to play depends only on the call (so a retried fetch still announces); the state change runs once
    const announce = tenantId
      ? await withTenantTx(systemActor(tenantId, 'provider'), async (tx) => {
          const c = await sql<{ announce: boolean }>`
            SELECT (recording_decision->>'announce')::boolean IS TRUE AND recording_mode <> 'off' AS announce FROM calls
             WHERE tenant_id = app.tenant_id() AND id = ${ref.id} AND provider_call_ref = ${parent}`.execute(tx);
          return c.rows[0]?.announce ?? null;
        }, { db: p.db })
      : null;
    await run(req, 'telephony', `answer:${parent}`, announce === null ? null : tenantId, { sid: parent }, async () => {
      // the announcement TwiML is handed to the provider now and plays before the legs are bridged
      await applyCallStatus(systemActor(tenantId!, 'provider'), { providerCallRef: parent, status: 'in_progress', ...(announce ? { announcement: 'played' as const } : {}), occurredAt: p.clock.now() }, depsFromPlatform(p));
    });
    reply.header('content-type', 'text/xml');
    return announcementTwiml(announce === true ? RECORDING_ANNOUNCEMENT : null);
  });

  const mail = { config: { auth: 'webhook' as const, webhookProvider: 'email' as const } };
  const InboundEmail = z.object({
    eventId: z.string().min(1).max(200),
    from: z.string().min(3).max(320),
    to: z.string().min(3).max(320),
    subject: z.string().max(998).nullable().optional(),
    text: z.string().max(200_000),
    headers: z.record(z.string(), z.string()).optional(),
  });
  async function handleInbound(req: FastifyRequest, n: NormalizedInbound): Promise<{ ok: true; routed: boolean }> {
    const p = req.server.platform;
    let resolved: { tenantId: string; conversationId: string } | null = null;
    let to = n.recipients[0] ?? '';
    for (const addr of n.recipients) {
      const token = tokenFromRecipient(addr);
      resolved = token ? await resolveEmailToken(p.db, token) : null;
      if (resolved) {
        to = addr;
        break;
      }
    }
    const out = await run(req, 'email', `inbound:${n.eventId}`, resolved?.tenantId ?? null, { eventId: n.eventId }, () =>
      ingestInbound(systemActor(resolved!.tenantId, 'provider'), { kind: 'email', providerRef: n.eventId, from: n.from, to, subject: n.subject, text: n.text, headers: n.headers, conversationId: resolved!.conversationId }, depsFromPlatform(p)),
    );
    return { ok: true, routed: out !== 'unrouted' };
  }

  async function handleEvent(req: FastifyRequest, e: NormalizedEmailEvent): Promise<void> {
    if (e.type === 'ignored') return;
    const p = req.server.platform;
    const ref = e.ref ? verifySignedRef(p.config.sessionSecret, 'email-ref', e.ref) : null;
    await run(req, 'email', `event:${e.eventId}`, ref?.tenantId ?? null, { eventId: e.eventId, type: e.type }, async () => {
      // an unsubscribe at the provider is the person's opt-out, like our own link (D1)
      if (e.type === 'unsubscribed') return unsubscribeMessageRecipient(ref!.tenantId, ref!.id, 'provider_unsubscribe', depsFromPlatform(p));
      return applyMessageStatus(systemActor(ref!.tenantId, 'provider'), { providerEventRef: `email:${e.eventId}`, message: { id: ref!.id }, providerStatus: e.type, mapped: e.type as MappedStatus, occurredAt: e.occurredAt ? at(e.occurredAt) : p.clock.now() }, depsFromPlatform(p));
    });
  }

  r.post('/webhooks/email/inbound', { ...mail, schema: { body: InboundEmail } }, async (req) => {
    const b = req.body;
    return handleInbound(req, { eventId: b.eventId, from: b.from, recipients: [b.to], subject: b.subject ?? null, text: b.text, headers: b.headers ?? {} });
  });

  const EmailEvent = z.object({
    eventId: z.string().min(1).max(200),
    ref: z.string().max(200),
    type: z.enum(['delivered', 'bounced', 'complained', 'opened', 'clicked', 'failed', 'unsubscribed']),
    occurredAt: z.iso.datetime({ offset: true }).optional(),
  });
  r.post('/webhooks/email/events', { ...mail, schema: { body: EmailEvent } }, async (req) => {
    const b = req.body;
    await handleEvent(req, { eventId: b.eventId, ref: b.ref, type: b.type, occurredAt: b.occurredAt ?? null });
    return { ok: true };
  });

  // ---- vendor formats (each accepted only when configured; the guard checks the vendor's own auth) ----
  const vendor = (format: 'postmark' | 'sendgrid', webhookAuth: 'basic' | 'sendgrid_ecdsa') => ({
    config: { auth: 'webhook' as const, webhookProvider: 'email' as const, webhookAuth },
    preHandler: async (req: FastifyRequest) => {
      if (!req.server.platform.config.emailInbound.formats.includes(format)) throw new AppError('NOT_FOUND');
    },
  });
  const Json = z.unknown();
  r.post('/webhooks/email/postmark/inbound', { ...vendor('postmark', 'basic'), schema: { body: Json } }, async (req) => {
    const n = parsePostmarkInbound(req.body);
    if (!n) throw new AppError('VALIDATION_FAILED');
    return handleInbound(req, n);
  });
  r.post('/webhooks/email/postmark/events', { ...vendor('postmark', 'basic'), schema: { body: Json } }, async (req) => {
    const e = parsePostmarkEvent(req.body);
    if (!e) throw new AppError('VALIDATION_FAILED');
    await handleEvent(req, e);
    return { ok: true };
  });
  r.post('/webhooks/email/sendgrid/events', { ...vendor('sendgrid', 'sendgrid_ecdsa'), schema: { body: Json } }, async (req) => {
    const events = parseSendgridEvents(req.body);
    if (!events) throw new AppError('VALIDATION_FAILED');
    for (const e of events.slice(0, 1000)) await handleEvent(req, e);
    return { ok: true };
  });
  // SendGrid Inbound Parse posts multipart/form-data: parsed only inside this scope (attachments ignored)
  await app.register(async (scope) => {
    scope.addContentTypeParser('multipart/form-data', { parseAs: 'buffer', bodyLimit: 10 * 1_048_576 }, (req, body, done) => {
      const ct = req.headers['content-type'] ?? '';
      new Response(new Uint8Array(body as Buffer), { headers: { 'content-type': ct } })
        .formData()
        .then((fd) => {
          const out: Record<string, string> = {};
          for (const [k, v] of fd) if (typeof v === 'string' && k !== '__proto__' && k !== 'constructor' && k !== 'prototype') out[k] = v;
          done(null, out);
        })
        .catch(() => done(Object.assign(new Error('invalid body'), { statusCode: 400, code: 'REALTY_INVALID_BODY' }), undefined));
    });
    scope.withTypeProvider<ZodTypeProvider>().post('/webhooks/email/sendgrid/inbound', { ...vendor('sendgrid', 'basic'), schema: { body: Form } }, async (req) => {
      const n = parseSendgridInbound(req.body);
      if (!n) throw new AppError('VALIDATION_FAILED');
      return handleInbound(req, n);
    });
  });
}
