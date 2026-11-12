// Per-source webhook signatures (module 22; DATA_MODEL R-LSRC-3, E333). POST /intake/:sourceToken declares
// config.webhookAuth 'lead_source', and the webhook guard (providers/webhooks.ts verifyRequest) calls this:
//   1 resolve the URL token through app.resolve_lead_source (pre-tenant definer)
//   2 a resolved source with its OWN secret (lead_source_webhook_secrets, decrypted as the system actor of that tenant)
//     accepts only that secret
//   3 a source without one, and an unknown token, keep the deployment secret (an unknown token with a valid
//     signature then reaches the handler, which answers 404 and records the delivery as unrouted, as before)
// The scheme and window are verifyWebhook's exactly: X-Realty-Signature t=<unix s>,v1=<hex HMAC-SHA256(secret,
// `${t}.${rawBody}`)>, at most 5 minutes old and 30 s ahead, compared in constant time.
import { createHash } from 'node:crypto';
import { withPreTenant, withTenantTx } from '@realty/db';
import type { FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { constantTimeEqual } from '../crypto/primitives.js';
import { SIGNATURE_FUTURE_SKEW_S, SIGNATURE_TOLERANCE_S, signedHeader, verifyWebhook } from '../providers/webhooks.js';
import { systemActor } from '../worker/systemActor.js';
import { webhookSecretOf } from './sources.js';

const TOKEN_RE = /^[A-Za-z0-9_-]{20,100}$/;

/** verifyWebhook's X-Realty-Signature check with a given secret. */
export function verifyRealtySignature(secret: string, header: unknown, raw: unknown, nowS: number): boolean {
  if (typeof header !== 'string' || typeof raw !== 'string') return false;
  const m = /^t=(\d{1,12}),v1=([0-9a-f]{64})$/.exec(header);
  if (!m) return false;
  const t = Number(m[1]);
  if (nowS - t > SIGNATURE_TOLERANCE_S || t - nowS > SIGNATURE_FUTURE_SKEW_S) return false;
  return constantTimeEqual(signedHeader(secret, t, raw), header);
}

export async function verifyLeadSourceRequest(req: FastifyRequest): Promise<boolean> {
  const p = req.server.platform;
  const token = (req.params as { sourceToken?: unknown } | undefined)?.sourceToken;
  let resolved: { tenantId: string; leadSourceId: string } | null = null;
  if (typeof token === 'string' && TOKEN_RE.test(token)) {
    const hash = createHash('sha256').update(token, 'utf8').digest();
    resolved = await withPreTenant(
      async (tx) => {
        const r = await sql<{ tenant_id: string; lead_source_id: string }>`SELECT * FROM app.resolve_lead_source(${hash})`.execute(tx);
        const row = r.rows[0];
        return row ? { tenantId: row.tenant_id, leadSourceId: row.lead_source_id } : null;
      },
      { db: p.db },
    );
  }
  if (resolved) {
    const { tenantId, leadSourceId } = resolved;
    const own = await withTenantTx(systemActor(tenantId, 'provider'), (tx) => webhookSecretOf(tx, p.envelope, tenantId, leadSourceId), { db: p.db });
    if (own !== null) return verifyRealtySignature(own, req.headers['x-realty-signature'], req.rawBody, Math.floor(p.clock.now() / 1000));
  }
  return verifyWebhook('lead', req);
}
