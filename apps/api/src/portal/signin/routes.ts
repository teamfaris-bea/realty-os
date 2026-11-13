// Pre-session portal routes (R-PORTAL-10, R-PORTAL-12; E640-E646), mounted under /api/portal by plugin.ts.
//
//   POST /portal/login   {team, address}  in order, each the same for every address of its kind: the limits; the
//                        platform:portal clearance (pre-tenant) else 503 PORTAL_NOT_AVAILABLE; the channel can really
//                        send else 503 {channel}; else 202 with ONE body. Only after the reply has left: the lookup
//                        (requestPortalLogin) and the delivery (links.ts). A match, a miss, an unknown team, a disabled
//                        account, a removed point, a throttled account and an opted-out recipient all look the same.
//   POST /portal/session {token}          the limit; consumePortalLogin once; else 401 PORTAL_LINK_INVALID; 503 while
//                        uncleared. Success ends any presented portal session (rotation) and sets the cookie.
import { normalizeEmail, normalizePhone, toIso } from '@realty/core/foundation';
import { type PortalLoginLink, PortalNotClearedError, consumePortalLogin, endPortalSession, requestPortalLogin, withPreTenant } from '@realty/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { sql } from 'kysely';
import { depsFromPlatform } from '../../comms/runtime.js';
import { AppError } from '../../errors.js';
import { SIGNIN_ACCEPTED } from '../shared/copy.js';
import * as S from '../shared/schemas.js';
import { portalCookieName, portalCookieOptions, portalCsrfToken } from '../shared/session.js';
import { linkChannels } from './delivery.js';
import { deliverLinks } from './links.js';

export interface SigninLimits {
  login(req: FastifyRequest, normalizedAddress: string): Promise<void>;
  session(req: FastifyRequest): Promise<void>;
}

/** Test seams (never set in production): observe that the lookup starts only after the reply has left. */
export const signinTestHooks: { onLookup?: (o: { replySent: boolean }) => void; lookup?: typeof requestPortalLogin } = {};
const pending = new Set<Promise<void>>();
/** Waits for every post-reply lookup and delivery started so far (tests). */
export async function settlePortalSignins(): Promise<void> {
  while (pending.size > 0) await Promise.allSettled([...pending]);
}

declare module 'fastify' {
  interface FastifyRequest {
    portalSignin?: { slug: string; address: string };
  }
}

export async function portalCleared(app: FastifyInstance): Promise<boolean> {
  const r = await withPreTenant((tx) => sql<{ ok: boolean }>`SELECT app.platform_cleared('platform:portal') AS ok`.execute(tx), { db: app.platform.db });
  return r.rows[0]?.ok === true;
}

const signin = { config: { auth: 'public' as const, portal: 'signin' as const }, bodyLimit: 4096 };

export async function registerSigninRoutes(app: FastifyInstance, limits: SigninLimits): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();

  r.post(
    '/login',
    {
      ...signin,
      schema: { body: S.LoginBody, response: { 202: S.LoginAccepted } },
      // the lookup and the delivery run only once the response is on the wire (F12, E640)
      onResponse: async (req, reply) => {
        const job = req.portalSignin;
        if (!job || reply.statusCode !== 202) return;
        const p = lookupAndDeliver(app, req, job, reply.sent);
        pending.add(p);
        void p.finally(() => pending.delete(p));
      },
    },
    async (req, reply) => {
      const { team, address } = req.body;
      const email = address.includes('@');
      const n = email ? normalizeEmail(address) : normalizePhone(address, 'US');
      if (!n.ok) throw new AppError(n.code);
      const normalized = 'email' in n ? n.email : n.e164;
      await limits.login(req, normalized);
      if (!(await portalCleared(app))) throw new AppError('PORTAL_NOT_AVAILABLE');
      const channel = email ? 'email' : 'sms';
      if (linkChannels(app.platform.config)[channel] === 'off') throw new AppError('PORTAL_NOT_AVAILABLE', { channel });
      req.portalSignin = { slug: team.toLowerCase(), address: normalized };
      return reply.code(202).send({ status: 'sent_if_matched' as const, message: SIGNIN_ACCEPTED });
    },
  );

  r.post('/session', { ...signin, schema: { body: S.SessionBody, response: { 200: S.SessionResponse } } }, async (req, reply) => {
    await limits.session(req);
    const db = { db: app.platform.db };
    let s;
    try {
      s = await consumePortalLogin(req.body.token, { ip: req.ip ?? null, userAgent: typeof req.headers['user-agent'] === 'string' ? req.headers['user-agent'] : null }, db);
    } catch (e) {
      if (e instanceof PortalNotClearedError) throw new AppError('PORTAL_NOT_AVAILABLE');
      throw e;
    }
    if (!s) throw new AppError('PORTAL_LINK_INVALID');
    const secure = app.platform.config.cookieSecure;
    const presented = req.cookies?.[portalCookieName(secure)];
    if (presented) await endPortalSession(presented, 'rotation', db).catch(() => false);
    reply.setCookie(portalCookieName(secure), s.sessionToken, portalCookieOptions(secure, (s.absoluteExpiresAt - Date.now()) / 1000));
    return { csrfToken: portalCsrfToken(app.platform.config.sessionSecret, s.client.sessionId), idleExpiresAt: toIso(s.idleExpiresAt), absoluteExpiresAt: toIso(s.absoluteExpiresAt) };
  });
}

async function lookupAndDeliver(app: FastifyInstance, req: FastifyRequest, job: { slug: string; address: string }, replySent: boolean): Promise<void> {
  signinTestHooks.onLookup?.({ replySent });
  let links: PortalLoginLink[];
  try {
    links = await (signinTestHooks.lookup ?? requestPortalLogin)(job.slug, job.address, { db: app.platform.db });
  } catch (e) {
    // a withdrawal between the check and the lookup sends nothing (PortalNotClearedError)
    req.log.warn({ code: e instanceof PortalNotClearedError ? 'PORTAL_NOT_CLEARED' : 'PORTAL_LOOKUP_FAILED' }, 'portal: sign-in lookup failed');
    return;
  }
  if (links.length === 0) return;
  const cfg = app.platform.config;
  await deliverLinks({ comms: depsFromPlatform(app.platform), webOrigin: cfg.webOrigins[0]!, log: req.log }, links);
}
