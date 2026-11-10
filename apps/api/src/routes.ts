// Route registry (CONVENTIONS §3). Mounted under the `/api` prefix by server.ts.
//
// SHARED REGISTRATION FILE. A module adds ONE import line and ONE entry, above the marker:
//   import { leadsRoutes } from './leads/routes.js';
//   ...
//   leadsRoutes,
//
// Every route inside a module declares `config.auth` (an Action, 'public', 'webhook', 'session' or
// 'self'); an Action route must carry authorize(<that action>, facts). server.ts refuses to start
// otherwise (rbac.ts), and the route-table test proves no route lacks authorization.
import type { FastifyPluginAsync } from 'fastify';
import { authRoutes } from './auth/routes.js';
import { devicesRoutes } from './auth/devices.js';
import { adminRoutes } from './admin/routes.js';
import { leadsRoutes } from './leads/routes.js';

export interface RouteModule {
  name: string;
  register: FastifyPluginAsync;
}

export const routeModules: RouteModule[] = [
  authRoutes,
  devicesRoutes,
  adminRoutes,
  leadsRoutes,
  // registry: add new entries above this line
];
