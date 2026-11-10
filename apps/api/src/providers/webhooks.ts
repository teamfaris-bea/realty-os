// Provider webhook signature verification (ARCHITECTURE §3 "Webhook lifecycle").
//
//   telephony  Twilio-shaped: X-Twilio-Signature = base64(HMAC-SHA1(secret, fullUrl + sorted(k+v)))
//              over the application/x-www-form-urlencoded parameters
//   email/lead X-Realty-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>,
//              accepted within ±5 minutes (replay window)
//
// A route declares `config: { auth: 'webhook', webhookProvider: 'telephony' }`. The webhook guard
// (installed by server.ts) verifies the signature BEFORE the handler runs. A bad signature records
// app.record_webhook_event(… signature_valid=false, payload NULL) — a global, tenant-less row — and
// answers 403 WEBHOOK_SIGNATURE_INVALID. No tenant row is written and no tenant is resolved.
// Tenant resolution, idempotency and processing belong to the handler (comms/leads modules).
import { createHmac } from 'node:crypto';
import { withPreTenant } from '@realty/db';
import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import { sql } from 'kysely';
import { constantTimeEqual } from '../crypto/primitives.js';
import { AppError } from '../errors.js';
import { tagGuard } from '../rbac.js';

export type WebhookProvider = 'telephony' | 'email' | 'lead';

declare module 'fastify' {
  interface FastifyContextConfig {
    webhookProvider?: WebhookProvider;
  }
  interface FastifyRequest {
    rawBody?: string;
  }
}

export const SIGNATURE_TOLERANCE_S = 300;

export function telephonySignature(secret: string, fullUrl: string, params: Record<string, string>): string {
  const data = Object.keys(params)
    .sort()
    .reduce((acc, k) => acc + k + params[k], fullUrl);
  return createHmac('sha1', secret).update(data, 'utf8').digest('base64');
}

export function signedHeader(secret: string, unixSeconds: number, rawBody: string): string {
  return `t=${unixSeconds},v1=${createHmac('sha256', secret).update(`${unixSeconds}.${rawBody}`, 'utf8').digest('hex')}`;
}

function formParams(req: FastifyRequest): Record<string, string> | null {
  const b = req.body;
  if (b === null || typeof b !== 'object' || Array.isArray(b)) return null;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
    if (typeof v !== 'string') return null;
    out[k] = v;
  }
  return out;
}

/** BUILD_PLAN interface: true iff the request carries a valid signature for `provider`. */
export function verifyWebhook(provider: WebhookProvider, req: FastifyRequest): boolean {
  const p = req.server.platform;
  const secret = p.config.webhookSecrets[provider];
  if (provider === 'telephony') {
    const sig = req.headers['x-twilio-signature'];
    const params = formParams(req);
    if (typeof sig !== 'string' || !params) return false;
    const url = new URL(req.url, p.config.publicBaseUrl).toString();
    return constantTimeEqual(telephonySignature(secret, url, params), sig);
  }
  const header = req.headers['x-realty-signature'];
  const raw = req.rawBody;
  if (typeof header !== 'string' || typeof raw !== 'string') return false;
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header);
  if (!m) return false;
  const t = Number(m[1]);
  const nowS = Math.floor(p.clock.now() / 1000);
  if (Math.abs(nowS - t) > SIGNATURE_TOLERANCE_S) return false;
  return constantTimeEqual(signedHeader(secret, t, raw), header);
}

/** Records a rejected (unsigned / mis-signed) delivery: global row, no tenant, no payload. */
export async function recordRejectedWebhook(req: FastifyRequest, provider: WebhookProvider): Promise<void> {
  const p = req.server.platform;
  const id = p.ids.next<'WebhookEventId'>();
  await withPreTenant(
    async (tx, now) => {
      await sql`SELECT app.record_webhook_event(${id}::uuid, ${provider}, ${'invalid:' + id}, NULL, false, NULL, ${new Date(now)}::timestamptz)`.execute(tx);
    },
    { db: p.db },
  );
}

export const webhookGuard: preHandlerHookHandler = tagGuard(async function webhookGuard(req) {
  const provider = req.routeOptions.config.webhookProvider;
  if (!provider) throw new AppError('INTERNAL_ERROR');
  if (!verifyWebhook(provider, req)) {
    await recordRejectedWebhook(req, provider);
    throw new AppError('WEBHOOK_SIGNATURE_INVALID');
  }
}, 'session');
