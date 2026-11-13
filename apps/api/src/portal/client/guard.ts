// The client portal session guard (R-PORTAL-8, R-PORTAL-9; R-TEN-14). Every route in portal/client/** runs it:
// resolvePortalSession once per request (cached; the per-route rate limit key reuses it), else 401
// PORTAL_SESSION_REQUIRED; on an unsafe method, the portal CSRF token (shared/session.ts) else 403 CSRF_INVALID.
// It reads only the portal cookie: a staff cookie (`__Host-sid`) is never looked at here (E148), and the staff guard
// never reads this one.
import { type ClientActor, resolvePortalSession } from '@realty/db';
import type { FastifyRequest, preValidationHookHandler } from 'fastify';
import { AppError } from '../../errors.js';
import { portalCookieName, portalCsrfValid } from '../shared/session.js';

declare module 'fastify' {
  interface FastifyRequest {
    portalClient?: ClientActor;
  }
}

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const resolved = new WeakMap<FastifyRequest, Promise<ClientActor | null>>();

export function portalCookieOf(req: FastifyRequest): string | undefined {
  return req.cookies?.[portalCookieName(req.server.platform.config.cookieSecure)];
}

/** The presented portal session, resolved once per request (null: none, expired, revoked, disabled, uncleared). */
export function portalSessionOf(req: FastifyRequest): Promise<ClientActor | null> {
  let p = resolved.get(req);
  if (!p) {
    const token = portalCookieOf(req);
    p = token ? resolvePortalSession(token, { db: req.server.platform.db }) : Promise.resolve(null);
    resolved.set(req, p);
    p.catch(() => resolved.delete(req));
  }
  return p;
}

export const GUARD_MARK = Symbol.for('realty.portal.clientGuard');

export const clientGuard: preValidationHookHandler = Object.assign(
  async function portalClientGuard(req: FastifyRequest) {
    const c = await portalSessionOf(req);
    if (!c) throw new AppError('PORTAL_SESSION_REQUIRED');
    if (!SAFE.has(req.method) && !portalCsrfValid(req.server.platform.config.sessionSecret, c.sessionId, req.headers['x-csrf-token'])) {
      throw new AppError('CSRF_INVALID');
    }
    req.portalClient = c;
  },
  { [GUARD_MARK]: true },
);

export function clientOf(req: FastifyRequest): ClientActor {
  if (!req.portalClient) throw new AppError('PORTAL_SESSION_REQUIRED');
  return req.portalClient;
}

/** Per-route rate limit key: the portal session when one resolves, else the IP (random cookies open no bucket). */
export async function portalRateKey(req: FastifyRequest): Promise<string> {
  const c = await portalSessionOf(req).catch(() => null);
  return c ? `ps:${c.sessionId}` : `ip:${req.ip}`;
}
