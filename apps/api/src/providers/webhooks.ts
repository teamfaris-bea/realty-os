// Provider webhook signature verification (ARCHITECTURE §3 "Webhook lifecycle").
//
//   telephony  Twilio's scheme: X-Twilio-Signature = base64(HMAC-SHA1(token, fullUrl + sorted(k+v)))
//              over the application/x-www-form-urlencoded parameters (matches Twilio's published example,
//              see webhooks.test.ts). With the fake, `token` is TELEPHONY_WEBHOOK_SECRET. With
//              TELEPHONY_PROVIDER=twilio it is the auth token of the account the request names
//              (AccountSid): the platform master account, or a tenant subaccount resolved through
//              app.resolve_telephony_account and decrypted as the system actor. The tenant found that way
//              is put on the request (req.webhookTenantId) for the handlers to cross-check.
//              Twilio signs no timestamp, so replay protection is idempotency: every handler records
//              (provider, event id) once in webhook_events, and a replayed delivery is a no-op duplicate.
//   vendor email formats (route config webhookAuth):
//     basic           HTTP Basic credentials embedded in the vendor's webhook URL (Postmark webhooks and
//                     inbound, SendGrid Inbound Parse). No timestamp: replay protection is idempotency on
//                     the vendor's event/message id, as for Twilio.
//     sendgrid_ecdsa  SendGrid Event Webhook: ECDSA P-256/SHA-256 over `${timestamp}${rawBody}`
//                     (X-Twilio-Email-Event-Webhook-Signature / -Timestamp), timestamp within ±5 minutes.
//     sns             Amazon SES events via SNS: SHA1/SHA256withRSA over AWS's canonical string, certificate
//                     only from https://sns.<region>.amazonaws.com(.cn)/….pem, TopicArn in SES_SNS_TOPIC_ARNS,
//                     Timestamp at most 1 hour old (SNS retries; see email/ses.ts)
//     mailgun_hmac    Mailgun webhooks: hex HMAC-SHA256(signing key, timestamp + token), timestamp within ±5 min
//   email/lead X-Realty-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256(secret, `${t}.${rawBody}`)>,
//              accepted while t is at most 5 minutes old and at most 30 s in the future (clock skew),
//              so a captured delivery can be replayed for at most ~5.5 minutes; inside that window the
//              handlers are idempotent (provider event ids; lead intake's 10-minute fingerprint dedup)
//
// A route declares `config: { auth: 'webhook', webhookProvider: 'telephony' }`. The webhook guard
// (installed by server.ts) verifies the signature BEFORE the handler runs. A bad signature records
// app.record_webhook_event(… signature_valid=false, payload NULL) — a global, tenant-less row — and
// answers 403 WEBHOOK_SIGNATURE_INVALID. No tenant row is written and no tenant is resolved.
// Tenant resolution, idempotency and processing belong to the handler (comms/leads modules).
import { createHmac, createPublicKey, verify as verifySignature } from 'node:crypto';
import { withPreTenant, withTenantTx } from '@realty/db';
import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import { sql } from 'kysely';
import { constantTimeEqual } from '../crypto/primitives.js';
import { AppError } from '../errors.js';
import { telephonyAccount } from '../comms/repos/credentials.js';
import { verifyMailgunSignature } from './email/mailgun.js';
import { snsVerifier } from './email/ses.js';
import { tagGuard } from '../rbac.js';
import { verifyLeadSourceRequest } from '../leads/webhookAuth.js';
import { verifyGoogleLeadKey } from '../leadForms/auth.js';
import { systemActor } from '../worker/systemActor.js';

export type WebhookProvider = 'telephony' | 'email' | 'lead';

declare module 'fastify' {
  interface FastifyContextConfig {
    webhookProvider?: WebhookProvider;
    /** a vendor email format's own authentication instead of the generic X-Realty-Signature */
    webhookAuth?: 'basic' | 'sendgrid_ecdsa' | 'sns' | 'mailgun_hmac' | 'lead_source' | 'google_lead_key';
  }
  interface FastifyRequest {
    rawBody?: string;
    /** TELEPHONY_PROVIDER=twilio: the tenant whose subaccount signed this request (null: the master account) */
    webhookTenantId?: string | null;
    /** webhookAuth 'google_lead_key': the hook the body's google_key resolved to (leadForms/auth.ts) */
    googleLeadHook?: { tenantId: string; hookId: string; leadSourceId: string };
  }
}

export const SIGNATURE_TOLERANCE_S = 300;
/** how far a signature timestamp may lie in the future (sender clock skew) */
export const SIGNATURE_FUTURE_SKEW_S = 30;

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
  if (nowS - t > SIGNATURE_TOLERANCE_S || t - nowS > SIGNATURE_FUTURE_SKEW_S) return false;
  return constantTimeEqual(signedHeader(secret, t, raw), header);
}

/** Basic credentials from an Authorization header, compared in constant time. */
export function verifyBasicAuth(header: unknown, expected: { username: string; password: string } | undefined): boolean {
  if (!expected || typeof header !== 'string') return false;
  const m = /^Basic ([A-Za-z0-9+/=]{1,1024})$/.exec(header.trim());
  if (!m) return false;
  const got = Buffer.from(m[1]!, 'base64').toString('utf8');
  return constantTimeEqual(got, `${expected.username}:${expected.password}`);
}

/** SendGrid Event Webhook signature (ECDSA over timestamp + raw body), timestamp within the replay window. */
export function verifySendgridSignature(publicKeyBase64: string | undefined, signature: unknown, timestamp: unknown, rawBody: string | undefined, nowS: number): boolean {
  if (!publicKeyBase64 || typeof signature !== 'string' || typeof timestamp !== 'string' || typeof rawBody !== 'string') return false;
  if (!/^\d{1,12}$/.test(timestamp) || Math.abs(nowS - Number(timestamp)) > SIGNATURE_TOLERANCE_S) return false;
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeyBase64, 'base64'), format: 'der', type: 'spki' });
    return verifySignature('sha256', Buffer.from(timestamp + rawBody, 'utf8'), key, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}

/** TELEPHONY_PROVIDER=twilio: verify with the auth token of the account the request names. */
async function verifyTwilioAccount(req: FastifyRequest): Promise<boolean> {
  const p = req.server.platform;
  const t = p.config.twilio;
  const sig = req.headers['x-twilio-signature'];
  const params = formParams(req);
  if (!t || typeof sig !== 'string' || !params) return false;
  const accountSid = params.AccountSid ?? '';
  if (!/^AC[0-9a-f]{32}$/.test(accountSid)) return false;
  const url = new URL(req.url, p.config.publicBaseUrl).toString();
  if (accountSid === t.accountSid) {
    if (!constantTimeEqual(telephonySignature(t.authToken, url, params), sig)) return false;
    req.webhookTenantId = null;
    return true;
  }
  const tenantId = await withPreTenant(
    async (tx) => (await sql<{ tenant_id: string }>`SELECT tenant_id FROM app.resolve_telephony_account(${accountSid})`.execute(tx)).rows.map((r) => r.tenant_id),
    { db: p.db },
  );
  if (tenantId.length !== 1) return false;
  const account = await withTenantTx(systemActor(tenantId[0]!, 'provider'), (tx) => telephonyAccount(tx, p.envelope, tenantId[0]!), { db: p.db });
  if (!account || account.accountRef !== accountSid) return false;
  if (!constantTimeEqual(telephonySignature(account.secret, url, params), sig)) return false;
  req.webhookTenantId = tenantId[0]!;
  return true;
}

/** The guard's check: the route's scheme, including the ones that need a database lookup. */
export async function verifyRequest(provider: WebhookProvider, req: FastifyRequest): Promise<boolean> {
  const p = req.server.platform;
  const auth = req.routeOptions.config.webhookAuth;
  if (provider === 'email' && auth === 'basic') return verifyBasicAuth(req.headers.authorization, p.config.emailInbound.basicAuth);
  if (provider === 'email' && auth === 'sendgrid_ecdsa') {
    return verifySendgridSignature(
      p.config.emailInbound.sendgridEventPublicKey,
      req.headers['x-twilio-email-event-webhook-signature'],
      req.headers['x-twilio-email-event-webhook-timestamp'],
      req.rawBody,
      Math.floor(p.clock.now() / 1000),
    );
  }
  if (provider === 'email' && auth === 'sns') return snsVerifier.verify(req.body, p.config.emailInbound.sesSnsTopicArns, p.clock.now());
  if (provider === 'email' && auth === 'mailgun_hmac') return verifyMailgunSignature(p.config.emailInbound.mailgunWebhookSigningKey, req.body, Math.floor(p.clock.now() / 1000), SIGNATURE_TOLERANCE_S);
  if (provider === 'telephony' && p.config.providers.telephony === 'twilio') return verifyTwilioAccount(req);
  // module 22: a lead source's own signing secret (R-LSRC-3); without one, the deployment secret below
  if (provider === 'lead' && auth === 'lead_source') return verifyLeadSourceRequest(req);
  // module 22: a Google Ads lead form's key in the body (R-GADS-1); a lookup that throws is WEBHOOK_UNAVAILABLE
  if (provider === 'lead' && auth === 'google_lead_key') return verifyGoogleLeadKey(req);
  return verifyWebhook(provider, req);
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
  // A check that could not run (WEBHOOK_UNAVAILABLE: the database was unreachable) is a 503 the provider retries,
  // with no rejected row (module 22, R-GADS-1 E591). Every other exception is still a 403.
  const ok = await verifyRequest(provider, req).catch((e: unknown) => {
    if (e instanceof AppError && e.code === 'WEBHOOK_UNAVAILABLE') throw e;
    return false;
  });
  if (!ok) {
    await recordRejectedWebhook(req, provider);
    throw new AppError('WEBHOOK_SIGNATURE_INVALID');
  }
}, 'session');
