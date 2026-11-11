// api/leads route module (BUILD_PLAN module 11), mounted under /api by routes.ts:
//   POST /intake/:sourceToken                       lead source API (signed webhook, 'lead')
//   GET/POST /lead-sources                          Owner/Admin (settings.routing)
//   POST /contacts, GET /contacts/:id               contact.create / contact.view (card | full)
//   GET  /contacts/:id/timeline                     contact.view_detail
//   POST /leads/:contactId/<verb>                   ownership commands (see commands.ts)
//   GET  /ponds/:id/cards                           masked pond cards (contact.view, pond relation)
//   GET  /me/ponds                                  the ponds I may claim from, and what blocks a claim now (self)
//   POST /members/:userId/deactivate                staged deactivation (member.remove 🔒)
import type { FastifyInstance } from 'fastify';
import type { RouteModule } from '../routes.js';
import { registerCommandRoutes } from './commands.js';
import { registerContactRoutes } from './contacts.js';
import { registerDeactivationRoutes } from './deactivation.js';
import { registerIntakeRoutes } from './intake.js';
import { registerPondRoutes } from './ponds.js';
import { registerTimelineRoutes } from './timeline.js';

export const leadsRoutes: RouteModule = {
  name: 'leads',
  async register(app: FastifyInstance) {
    await registerIntakeRoutes(app);
    await registerContactRoutes(app);
    await registerTimelineRoutes(app);
    await registerCommandRoutes(app);
    await registerPondRoutes(app);
    await registerDeactivationRoutes(app);
  },
};
