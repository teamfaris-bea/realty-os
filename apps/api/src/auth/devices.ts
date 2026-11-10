// Device routes (BUILD_PLAN module 8; needed before routing, R-OWN-11 #4: a working critical channel):
//   POST   /push-subscriptions          register (or refresh) this device's Web Push subscription
//   DELETE /push-subscriptions/:id      revoke one of the caller's own subscriptions
//   POST   /me/alert-phone              send a verification code to a new alert phone (E54)
//   POST   /me/alert-phone/verify       set the alert phone once the code is confirmed (audited)
//
// All are `self` routes: the caller's own rows only (push_subscriptions / memberships RLS).
// Push endpoints and keys are field-encrypted with the tenant key, AAD bound to the row (R-DATA-1);
// the dedupe hash is an HMAC with the tenant hmac key. The alert-phone challenge is stateless: an
// HMAC over (tenant, user, phone, expiry, code) with the server secret, valid 10 minutes, at most 5
// attempts. A number that opted out of SMS or carries an active SMS suppression is refused (E60).
import { normalizePhone, toIso } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { z } from 'zod';
import { audit, redactDiff } from '../audit.js';
import { base64url, ciphertextKeyVersion, constantTimeEqual, fromBase64url, hmacSha256 } from '../crypto/primitives.js';
import { AppError } from '../errors.js';
import type { RouteModule } from '../routes.js';
import { AlertPhoneChallengeResponse, AlertPhoneVerifiedResponse, OkResponse, PushSubscriptionResponse, maskPhone, platformOf } from './common.js';
import { enforceLimits } from './rateLimit.js';
import { sixDigitCode } from './sessions.js';

const CHALLENGE_TTL_MS = 10 * 60_000;

const INTERNAL_SUFFIX = /(^|\.)(localhost|local|internal|intranet|corp|lan|home|home\.arpa)$/i;

/**
 * Push endpoints are URLs the server will later POST to (web push), so a subscription must name a
 * public push service: https on the default port, no credentials, a dotted DNS name (never an IP
 * literal, localhost, or an internal/reserved suffix). Blocks registering an SSRF target.
 */
export function isPublicPushEndpoint(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username !== '' || u.password !== '') return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') || /^[0-9.]+$/.test(host) || /^0x/i.test(host)) return false;
  if (!host.includes('.') || INTERNAL_SUFFIX.test(host)) return false;
  return /^[a-z0-9.-]+$/.test(host);
}

function challengeMac(secret: Uint8Array, tenantId: string, userId: string, payload: string, code: string): string {
  return base64url(hmacSha256(secret, `alert-phone:v1:${tenantId}:${userId}:${payload}:${code}`));
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/push-subscriptions',
    {
      config: { auth: 'self' },
      schema: {
        body: z
          .object({
            endpoint: z.url({ protocol: /^https$/ }).max(2048).refine(isPublicPushEndpoint, { message: 'not a public push service URL' }),
            keys: z.object({ p256dh: z.string().regex(/^[A-Za-z0-9_-]{20,200}={0,2}$/), auth: z.string().regex(/^[A-Za-z0-9_-]{8,100}={0,2}$/) }).strict(),
          })
          .strict(),
        response: { 201: PushSubscriptionResponse },
      },
    },
    async (req, reply) => {
      const p = platformOf(req);
      const actor = req.actor!;
      const id = await withTenantTx(
        actor,
        async (tx, now) => {
          const env = p.envelope.inTx(tx, actor.tenantId);
          const hash = Buffer.from(await env.hmacAddress(actor.tenantId, `push-endpoint:${req.body.endpoint}`));
          const existing = await sql<{ id: string }>`
            SELECT id FROM push_subscriptions WHERE tenant_id = app.tenant_id() AND user_id = app.user_id() AND endpoint_hash = ${hash} FOR UPDATE`.execute(tx);
          const rowId = existing.rows[0]?.id ?? p.ids.next<'PushSubscriptionId'>();
          const endpointEnc = await env.encrypt(actor.tenantId, { table: 'push_subscriptions', column: 'endpoint_enc', rowId }, Buffer.from(req.body.endpoint, 'utf8'));
          const keysEnc = await env.encrypt(actor.tenantId, { table: 'push_subscriptions', column: 'keys_enc', rowId }, Buffer.from(JSON.stringify(req.body.keys), 'utf8'));
          const kv = ciphertextKeyVersion(endpointEnc);
          if (existing.rows[0]) {
            await sql`UPDATE push_subscriptions SET endpoint_enc = ${Buffer.from(endpointEnc)}, keys_enc = ${Buffer.from(keysEnc)}, key_version = ${kv},
                             revoked_at = NULL, last_seen_at = ${new Date(now)}::timestamptz
                       WHERE tenant_id = app.tenant_id() AND id = ${rowId}::uuid`.execute(tx);
          } else {
            await sql`INSERT INTO push_subscriptions (tenant_id, id, user_id, endpoint_enc, keys_enc, key_version, endpoint_hash, created_at, last_seen_at)
                      VALUES (app.tenant_id(), ${rowId}::uuid, app.user_id(), ${Buffer.from(endpointEnc)}, ${Buffer.from(keysEnc)}, ${kv}, ${hash},
                              ${new Date(now)}::timestamptz, ${new Date(now)}::timestamptz)`.execute(tx);
          }
          return rowId;
        },
        { db: p.db, retries: 1 },
      );
      reply.status(201);
      return { id };
    },
  );

  r.delete(
    '/push-subscriptions/:id',
    { config: { auth: 'self' }, schema: { params: z.object({ id: z.uuid() }), response: { 200: OkResponse } } },
    async (req) => {
      const p = platformOf(req);
      const n = await withTenantTx(
        req.actor!,
        async (tx, now) =>
          Number(
            (
              await sql`UPDATE push_subscriptions SET revoked_at = ${new Date(now)}::timestamptz
                         WHERE tenant_id = app.tenant_id() AND id = ${req.params.id}::uuid AND user_id = app.user_id() AND revoked_at IS NULL`.execute(tx)
            ).numAffectedRows ?? 0,
          ),
        { db: p.db },
      );
      if (n === 0) throw new AppError('NOT_FOUND');
      return { ok: true as const };
    },
  );

  r.post(
    '/me/alert-phone',
    { config: { auth: 'self' }, schema: { body: z.object({ phone: z.string().min(7).max(32) }).strict(), response: { 200: AlertPhoneChallengeResponse } } },
    async (req) => {
      const p = platformOf(req);
      const actor = req.actor!;
      const ph = normalizePhone(req.body.phone, 'US');
      if (!ph.ok || ph.extension) throw new AppError('PHONE_INVALID');
      await enforceLimits(p.db, p.config.sessionSecret, [
        { kind: 'alert_phone_user', parts: [actor.userId], max: 3, windowSeconds: 3600 },
        { kind: 'alert_phone_day', parts: [actor.userId], max: 10, windowSeconds: 86_400 },
      ]);
      const { optedOut, now } = await withTenantTx(
        actor,
        async (tx, t) => {
          const h = Buffer.from(await p.envelope.inTx(tx, actor.tenantId).hmacAddress(actor.tenantId, ph.e164));
          const c = await sql<{ n: number }>`
            SELECT (SELECT count(*) FROM consent_state WHERE tenant_id = app.tenant_id() AND channel = 'sms' AND address_hmac = ${h} AND status = 'revoked')::int
                 + (SELECT count(*) FROM suppressions WHERE tenant_id = app.tenant_id() AND address_hmac = ${h} AND channel IN ('sms','all') AND lifted_at IS NULL)::int AS n`.execute(tx);
          return { optedOut: (c.rows[0]?.n ?? 0) > 0, now: t };
        },
        { db: p.db },
      );
      if (optedOut) throw new AppError('ALERT_PHONE_OPTED_OUT');
      const code = sixDigitCode();
      const exp = now + CHALLENGE_TTL_MS;
      const payload = base64url(Buffer.from(JSON.stringify({ v: 1, p: ph.e164, e: exp, n: base64url(hmacSha256(p.config.sessionSecret, `${p.ids.next()}`)).slice(0, 12) })));
      const challenge = `${payload}.${challengeMac(p.config.sessionSecret, actor.tenantId, actor.userId, payload, code)}`;
      await p.providers.telephony.deliverVerificationCode({ to: ph.e164, code });
      return { challenge, expiresAt: toIso(exp as typeof now), maskedPhone: maskPhone(ph.e164) };
    },
  );

  r.post(
    '/me/alert-phone/verify',
    {
      config: { auth: 'self' },
      schema: { body: z.object({ challenge: z.string().min(20).max(600), code: z.string().regex(/^\d{6}$/) }).strict(), response: { 200: AlertPhoneVerifiedResponse } },
    },
    async (req) => {
      const p = platformOf(req);
      const actor = req.actor!;
      const [payload, mac] = req.body.challenge.split('.');
      if (!payload || !mac) throw new AppError('VERIFICATION_INVALID');
      await enforceLimits(p.db, p.config.sessionSecret, [
        { kind: 'alert_verify', parts: [payload], max: 5, windowSeconds: 900 },
        { kind: 'alert_verify_user', parts: [actor.userId], max: 20, windowSeconds: 3600 },
      ]);
      const raw = fromBase64url(payload);
      let parsed: { v?: number; p?: string; e?: number } = {};
      try {
        parsed = raw ? (JSON.parse(Buffer.from(raw).toString('utf8')) as typeof parsed) : {};
      } catch {
        parsed = {};
      }
      const expected = challengeMac(p.config.sessionSecret, actor.tenantId, actor.userId, payload, req.body.code);
      if (!constantTimeEqual(expected, mac) || parsed.v !== 1 || typeof parsed.p !== 'string' || typeof parsed.e !== 'number') throw new AppError('VERIFICATION_INVALID');
      const e164 = parsed.p;
      const exp = parsed.e;
      const verifiedAt = await withTenantTx(
        actor,
        async (tx, now) => {
          if (now > exp) throw new AppError('VERIFICATION_INVALID');
          const before = await sql<{ alert_phone_e164: string | null; alert_phone_verified_at: Date | null }>`
            SELECT alert_phone_e164, alert_phone_verified_at FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = app.user_id() FOR UPDATE`.execute(tx);
          await sql`UPDATE memberships SET alert_phone_e164 = ${e164}, alert_phone_verified_at = ${new Date(now)}::timestamptz
                     WHERE tenant_id = app.tenant_id() AND user_id = app.user_id()`.execute(tx);
          await audit(tx, actor, {
            action: 'member.alert_phone_verified',
            entity: { type: 'membership', id: actor.userId },
            changes: redactDiff(
              { alert_phone_e164: before.rows[0]?.alert_phone_e164 ?? null, alert_phone_verified_at: before.rows[0]?.alert_phone_verified_at ?? null },
              { alert_phone_e164: e164, alert_phone_verified_at: new Date(now) },
            ),
          });
          return now;
        },
        { db: p.db },
      );
      return { maskedPhone: maskPhone(e164), verifiedAt: toIso(verifiedAt) };
    },
  );
}

export const devicesRoutes: RouteModule = { name: 'devices', register };
