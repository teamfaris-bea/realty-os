// The Google lead form webhook's check (module 22 scope 7; DATA_MODEL R-GADS-1, E315, E591). The webhook guard
// (providers/webhooks.ts verifyRequest, webhookAuth 'google_lead_key') calls verifyGoogleLeadKey:
//
//   1 body.google_key must be a string of 1–200 characters (else: false)
//   2 sha256(key) → app.resolve_google_lead_form (pre-tenant definer): the CURRENT hook of an ACTIVE source in an
//     ACTIVE tenant, or nothing (unknown, retired, source off, tenant inactive: false)
//   3 resolved: req.googleLeadHook = { tenantId, hookId, leadSourceId } and true
// false ⇒ the guard records the tenant-less rejected row and answers 403 WEBHOOK_SIGNATURE_INVALID (same for every
// reason). A lookup that THROWS (pool exhausted, statement timeout, database down) ⇒ WEBHOOK_UNAVAILABLE, which the
// guard rethrows: 503 (Google retries), no rejected row.
//
// Rate limit: a rejected delivery (only after its key failed to resolve) is counted per client IP (auth.rate_limit_hit,
// kind 'google_lead_reject_ip'). A request whose key resolves is never counted and never refused by any limiter (the
// route also opts out of the global per-IP limiter: Google posts from a few shared addresses). Over the limit the
// answer stays the same 403 (the guard turns every refusal into WEBHOOK_SIGNATURE_INVALID); the limit adds a warning
// log line (code GOOGLE_LEAD_KEY_REJECTS_LIMITED, no IP, no key) for alerting.
//
// The key never appears in a log line, an error, an audit row, a webhook_events payload or a response.
import { createHash } from 'node:crypto';
import { withPreTenant } from '@realty/db';
import type { FastifyRequest } from 'fastify';
import { sql } from 'kysely';
import { clientIp } from '../auth/common.js';
import { type Limit, enforceLimits } from '../auth/rateLimit.js';
import { AppError } from '../errors.js';

/** Rejected Google lead form deliveries per client IP (fixed window). */
export const GOOGLE_LEAD_REJECT_LIMIT = { kind: 'google_lead_reject_ip', max: 20, windowSeconds: 600 } as const;
export const rejectLimits = (ip: string): Limit[] => [{ kind: GOOGLE_LEAD_REJECT_LIMIT.kind, parts: [ip], max: GOOGLE_LEAD_REJECT_LIMIT.max, windowSeconds: GOOGLE_LEAD_REJECT_LIMIT.windowSeconds }];

export const MAX_KEY_CHARS = 200;

export interface GoogleLeadHook {
  tenantId: string;
  hookId: string;
  leadSourceId: string;
}

/** sha256 of a key as stored in google_lead_form_hooks.key_hash. */
export const keyHash = (key: string): Buffer => createHash('sha256').update(key, 'utf8').digest();

/** The key a body carries, or null (absent, not a string, empty, too long). */
export function keyOf(body: unknown): string | null {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null;
  if (!Object.prototype.hasOwnProperty.call(body, 'google_key')) return null;
  const k = (body as Record<string, unknown>).google_key;
  return typeof k === 'string' && k.length >= 1 && k.length <= MAX_KEY_CHARS ? k : null;
}

async function resolveHook(req: FastifyRequest, key: string): Promise<GoogleLeadHook | null> {
  try {
    return await withPreTenant(
      async (tx) => {
        const r = await sql<{ tenant_id: string; hook_id: string; lead_source_id: string }>`
          SELECT tenant_id, hook_id, lead_source_id FROM app.resolve_google_lead_form(${keyHash(key)})`.execute(tx);
        const rows = r.rows;
        return rows.length === 1 ? { tenantId: rows[0]!.tenant_id, hookId: rows[0]!.hook_id, leadSourceId: rows[0]!.lead_source_id } : null;
      },
      { db: req.server.platform.db },
    );
  } catch {
    // the check could not run: never a rejection (no rejected row, no 403); the error itself is not passed on (it
    // could quote the statement's parameters)
    throw new AppError('WEBHOOK_UNAVAILABLE');
  }
}

/** Counts a rejected delivery for its IP; true when the IP is over the limit. Never throws. */
async function countRejected(req: FastifyRequest): Promise<boolean> {
  const p = req.server.platform;
  try {
    await enforceLimits(p.db, p.config.sessionSecret, rejectLimits(clientIp(req)));
    return false;
  } catch (e) {
    return e instanceof AppError && e.code === 'RATE_LIMITED';
  }
}

export async function verifyGoogleLeadKey(req: FastifyRequest): Promise<boolean> {
  const key = keyOf(req.body);
  const hook = key === null ? null : await resolveHook(req, key);
  if (hook) {
    req.googleLeadHook = hook;
    return true;
  }
  if (await countRejected(req)) req.log.warn({ code: 'GOOGLE_LEAD_KEY_REJECTS_LIMITED' }, 'google lead form: rejected deliveries over the per-IP limit');
  return false;
}
