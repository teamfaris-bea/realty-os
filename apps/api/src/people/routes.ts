// api/people route module (PARITY_PLAN module 57), mounted under /api by routes.ts. See each file's header:
//   contacts.ts  details, PATCH contact, stage, stage labels, person-level do-not-contact
//   points.ts    phones and emails: add, replace, remove, primary, label
//   links.ts     addresses, collaborators, relationships
//   notes.ts     notes (mentions, pin, edit, delete) and logged outside activity
import type { FastifyInstance } from 'fastify';
import type { RouteModule } from '../routes.js';
import { registerContactEditRoutes } from './contacts.js';
import { registerLinkRoutes } from './links.js';
import { registerNoteRoutes } from './notes.js';
import { registerPointRoutes } from './points.js';

export const peopleRoutes: RouteModule = {
  name: 'people',
  async register(app: FastifyInstance) {
    await registerContactEditRoutes(app);
    await registerPointRoutes(app);
    await registerLinkRoutes(app);
    await registerNoteRoutes(app);
  },
};
