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
import { commsRoutes } from './comms/routes.js';
import { assistantRoutes } from './assistant/routes.js';
import { importsRoutes } from './imports/routes.js';
import { workspaceRoutes } from './workspace/routes.js';
import { accountabilityRoutes } from './accountability/routes.js';
import { healthRoutes } from './health.js';
import { systemRoutes } from './observability/systemRoutes.js';
import { integrationsRoutes } from './integrations/routes.js';
import { sparkMlsRoutes } from './mls/spark/routes.js';
import { peopleRoutes } from './people/routes.js';
import { duplicatesRoutes } from './duplicates/routes.js';
import { listsRoutes } from './lists/routes.js';
import { templatesRoutes } from './templates/routes.js';
import { bulkRoutes } from './bulk/routes.js';
import { stageAutomationRoutes } from './stageAutomation/routes.js';
import { leadEmailRoutes } from './leadEmail/routes.js';
import { mlsRoutes } from './mls/routes.js';
import { channelRoutes } from './channels/routes.js';
import { leadSourcesRoutes } from './leads/sources.js';
import { leadFormsRoutes } from './leadForms/routes.js';
import { nurtureRoutes } from './nurture/routes.js';
import { mailSyncRoutes } from './mailSync/routes.js';
import { marketingRoutes } from './marketing/routes.js';
import { sellerUpdatesRoutes } from './sellerUpdates/routes.js';
import { calendarRoutes } from './calendar/routes.js';
import { insightsRoutes } from './insights/routes.js';
import { coachingRoutes } from './coaching/routes.js';
import { transactionRoutes } from './transactions/routes.js';

export interface RouteModule {
  name: string;
  register: FastifyPluginAsync;
}

export const routeModules: RouteModule[] = [
  authRoutes,
  devicesRoutes,
  adminRoutes,
  leadsRoutes,
  commsRoutes,
  assistantRoutes,
  importsRoutes,
  workspaceRoutes,
  accountabilityRoutes,
  healthRoutes,
  systemRoutes,
  integrationsRoutes,
  sparkMlsRoutes,
  peopleRoutes,
  duplicatesRoutes,
  listsRoutes,
  templatesRoutes,
  bulkRoutes,
  stageAutomationRoutes,
  leadEmailRoutes,
  mlsRoutes,
  channelRoutes,
  leadSourcesRoutes,
  leadFormsRoutes,
  nurtureRoutes,
  mailSyncRoutes,
  marketingRoutes,
  sellerUpdatesRoutes,
  calendarRoutes,
  insightsRoutes,
  coachingRoutes,
  transactionRoutes,
  // registry: add new entries above this line
];
