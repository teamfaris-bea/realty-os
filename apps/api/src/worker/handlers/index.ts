// SHARED REGISTRATION FILE (CONVENTIONS §3), owned by api/jobs-worker: every job handler of the build.
//
// A module with handlers exports them from apps/api/src/<module>/handlers.ts as `<module>Handlers`
// and adds ONE import line and ONE `...<module>Handlers,` entry above the marker. Never reorder or
// edit another module's lines. Handlers for sweeper-issued kinds must follow worker/contracts.ts
// (kind, queue, payload schema, dedupe key).
import type { JobHandler } from '../types.js';
import { workerHandlers } from './worker.js';
import { leadsHandlers } from '../../leads/handlers.js';
import { commsHandlers } from '../../comms/handlers.js';
import { assistantHandlers } from '../../assistant/handlers.js';
import { importHandlers } from '../../imports/handlers.js';
import { workspaceHandlers } from '../../workspace/handlers.js';
import { accountabilityHandlers } from '../../accountability/handlers.js';
import { integrationHandlers } from '../../integrations/handlers.js';
import { bulkHandlers } from '../../bulk/handlers.js';
import { stageAutomationHandlers } from '../../stageAutomation/handlers.js';
import { mlsHandlers } from '../../mls/handlers.js';
import { channelHandlers } from '../../channels/handlers.js';
import { nurtureHandlers } from '../../nurture/handlers.js';
import { mailSyncHandlers } from '../../mailSync/handlers.js';
import { marketingHandlers } from '../../marketing/handlers.js';
import { sellerUpdateHandlers } from '../../sellerUpdates/handlers.js';
import { calendarHandlers } from '../../calendar/handlers.js';
import { insightsHandlers } from '../../insights/handlers.js';
import { coachingHandlers } from '../../coaching/handlers.js';
import { predictHandlers } from '../../predict/handlers.js';
import { transactionHandlers } from '../../transactions/handlers.js';
import { adsHandlers } from '../../ads/handlers.js';

export const handlers: JobHandler<unknown>[] = [
  ...workerHandlers,
  ...leadsHandlers,
  ...commsHandlers,
  ...assistantHandlers,
  ...importHandlers,
  ...workspaceHandlers,
  ...accountabilityHandlers,
  ...integrationHandlers,
  ...bulkHandlers,
  ...stageAutomationHandlers,
  ...mlsHandlers,
  ...channelHandlers,
  ...nurtureHandlers,
  ...mailSyncHandlers,
  ...marketingHandlers,
  ...sellerUpdateHandlers,
  ...calendarHandlers,
  ...insightsHandlers,
  ...coachingHandlers,
  ...predictHandlers,
  ...transactionHandlers,
  ...adsHandlers,
  // registry: add new entries above this line
];
