// Module 45 api/portal: ONE route module (R-PORTAL-8). Staff routes are registered at the /api root under the staff
// guard (portal/staff/**); the client and pre-session routes are one encapsulated plugin at /api/portal, each declaring
// `config: { auth: 'public', portal: 'client' | 'signin' }` and a 4 KB body limit: the staff guard installs nothing for
// a public route (rbac.ts), the Origin allowlist still runs for every unsafe one (server.ts), and the client routes
// carry their own guard (client/guard.ts: the portal cookie and the portal CSRF token). This plugin refuses to start a
// /api/portal route without its `portal` marker, and records each one so architecture.test.ts can prove that every
// client route has the guard and that no other route claims the marker.
//
// Sign-in limits (R-PORTAL-12), DB-backed and counted on every attempt whatever the address (auth/rateLimit.ts):
//   portal_login_ip       20 / hour per IP
//   portal_login_ip_addr   5 / 15 min per IP and address
//   portal_login_addr     10 / hour per address
//   portal_session_ip     20 / 15 min per IP (opening a session from a link)
// Client reads 120 / min and stream tokens 30 / min per session (else IP) are per-route limits (client/routes.ts).
import type { FastifyInstance, FastifyRequest, RouteOptions } from 'fastify';
import { type Limit, enforceLimits } from '../auth/rateLimit.js';
import type { RouteModule } from '../routes.js';
import type { Platform } from '../server.js';
import { GUARD_MARK } from './client/guard.js';
import { registerClientRoutes } from './client/routes.js';
import { registerSigninRoutes, type SigninLimits } from './signin/routes.js';
import { registerStaffRoutes } from './staff/routes.js';

declare module 'fastify' {
  interface FastifyContextConfig {
    /** module 45: which side of the portal boundary a /api/portal route is on */
    portal?: 'client' | 'signin';
  }
}

export const PORTAL_PREFIX = '/portal';

export const LOGIN_LIMITS = (ip: string, address: string): Limit[] => [
  { kind: 'portal_login_ip', parts: [ip], max: 20, windowSeconds: 3600 },
  { kind: 'portal_login_ip_addr', parts: [ip, address], max: 5, windowSeconds: 900 },
  { kind: 'portal_login_addr', parts: [address], max: 10, windowSeconds: 3600 },
];
export const SESSION_LIMITS = (ip: string): Limit[] => [{ kind: 'portal_session_ip', parts: [ip], max: 20, windowSeconds: 900 }];

export interface PortalRouteEntry {
  method: string;
  url: string;
  portal: 'client' | 'signin';
  guarded: boolean;
}
const tables = new WeakMap<Platform, PortalRouteEntry[]>();
/** Every /api/portal route as registered (architecture.test.ts). */
export const portalRouteTable = (p: Platform): readonly PortalRouteEntry[] => tables.get(p) ?? [];

/**
 * The start-up check of every /api/portal route: refuses a route without `config.portal`, or not `public`, or a client
 * route without the client guard. Returns the route's entries for the portal route table (none for HEAD/OPTIONS).
 */
export function checkPortalRoute(route: Pick<RouteOptions, 'method' | 'url' | 'config' | 'preValidation'>): PortalRouteEntry[] {
  const marker = (route.config as { portal?: unknown; auth?: unknown } | undefined)?.portal;
  const methods = (Array.isArray(route.method) ? route.method : [route.method]) as string[];
  if (methods.every((m) => m === 'HEAD' || m === 'OPTIONS')) return [];
  if (marker !== 'client' && marker !== 'signin') throw new Error(`portal: ${methods.join(',')} ${route.url} has no config.portal marker (R-PORTAL-8)`);
  if ((route.config as { auth?: unknown }).auth !== 'public') throw new Error(`portal: ${route.url} must be config.auth 'public' (its own guard runs)`);
  const pv = route.preValidation ? (Array.isArray(route.preValidation) ? route.preValidation : [route.preValidation]) : [];
  const guarded = pv.some((h) => (h as unknown as Record<symbol, unknown>)[GUARD_MARK] === true);
  if (marker === 'client' && !guarded) throw new Error(`portal: client route ${route.url} lacks the client guard`);
  return methods.map((m) => ({ method: m, url: route.url, portal: marker, guarded }));
}

function limitsFor(app: FastifyInstance): SigninLimits {
  const p = app.platform;
  const ipOf = (req: FastifyRequest) => req.ip ?? 'unknown';
  return {
    login: (req, address) => enforceLimits(p.db, p.config.sessionSecret, LOGIN_LIMITS(ipOf(req), address)),
    session: (req) => enforceLimits(p.db, p.config.sessionSecret, SESSION_LIMITS(ipOf(req))),
  };
}

async function registerPortal(app: FastifyInstance): Promise<void> {
  await registerStaffRoutes(app);
  await app.register(
    async (portal) => {
      const entries: PortalRouteEntry[] = [];
      tables.set(portal.platform, entries);
      portal.addHook('onRoute', (route) => {
        entries.push(...checkPortalRoute(route));
      });
      await registerSigninRoutes(portal, limitsFor(portal));
      await registerClientRoutes(portal);
    },
    { prefix: PORTAL_PREFIX },
  );
}

export const portalRoutes: RouteModule = { name: 'portal', register: registerPortal };
