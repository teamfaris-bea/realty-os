// api/admin route module (BUILD_PLAN module 10): members and invites, routing rules, ponds, teams,
// settings, brokerage identity, compliance policy versions. Mounted under /api by routes.ts.
//
// Authorization per route (DATA_MODEL §3, core.can()):
//   member.invite / member.role (+ member.suspend / member.remove re-checked in the handler)  Owner/Admin 🔒
//   settings.routing   routing, ponds, teams, lead timers; also the admin READ endpoints
//                      (GET /members, /settings, /routing-rules, /ponds, /teams)              Owner/Admin
//   settings.identity  brokerage identity; recording retention/access inside PATCH /settings   Owner 🔒
//   settings.compliance policy versions (looser: Owner 🔒 + attestation)                      Owner/Admin
import type { FastifyInstance } from 'fastify';
import type { RouteModule } from '../routes.js';
import { registerMemberRoutes } from './members.js';
import { registerPolicyRoutes } from './policy.js';
import { registerPondRoutes } from './ponds.js';
import { registerRoutingRoutes } from './routing.js';
import { registerSettingsRoutes } from './settings.js';
import { registerTeamRoutes } from './teams.js';

export const adminRoutes: RouteModule = {
  name: 'admin',
  async register(app: FastifyInstance) {
    await registerMemberRoutes(app);
    await registerRoutingRoutes(app);
    await registerPondRoutes(app);
    await registerTeamRoutes(app);
    await registerSettingsRoutes(app);
    await registerPolicyRoutes(app);
  },
};
