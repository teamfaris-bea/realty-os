// Bearer-token guard for the CRM read API (WP3a).
//
// The token is a header, never a URL parameter, so it is not a capability path and it is not written
// to an access log by the route pattern. Every request resolves the sha256 again: a revocation is
// visible on the next request. Unknown, malformed and revoked tokens are the same 401.
import { createHash } from 'node:crypto';
import { withPreTenant } from '@realty/db';
import type { FastifyRequest, preHandlerHookHandler } from 'fastify';
import { sql } from 'kysely';
import { AppError } from '../errors.js';
import { tagGuard } from '../rbac.js';

const TOKEN = /^ros_[A-Za-z0-9_-]{43}$/;

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by crmReadGuard after the bearer token resolves. Absent on every other route. */
    crmRead?: { tenantId: string; tokenId: string };
  }
}

export function sha256Token(token: string): Buffer {
  return createHash('sha256').update(token, 'utf8').digest();
}

function presentedToken(req: FastifyRequest): string | null {
  const header = req.headers.authorization;
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(\S+)\s*$/i.exec(header);
  const token = match?.[1] ?? '';
  return TOKEN.test(token) ? token : null;
}

export const crmReadGuard: preHandlerHookHandler = tagGuard(async function crmReadGuard(req) {
  const token = presentedToken(req);
  if (!token) throw new AppError('UNAUTHENTICATED');
  const row = await withPreTenant(
    async (tx) => {
      const found = await sql<{ tenant_id: string; token_id: string }>`SELECT tenant_id, token_id FROM app.resolve_crm_read_token(${sha256Token(token)})`.execute(tx);
      return found.rows[0] ?? null;
    },
    { db: req.server.platform.db },
  );
  if (!row) throw new AppError('UNAUTHENTICATED');
  req.crmRead = { tenantId: row.tenant_id, tokenId: row.token_id };
}, 'session');
