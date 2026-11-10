// SHARED REGISTRATION FILE (CONVENTIONS §3), owned by api/jobs-worker: every job handler of the build.
//
// A module with handlers exports them from apps/api/src/<module>/handlers.ts as `<module>Handlers`
// and adds ONE import line and ONE `...<module>Handlers,` entry above the marker. Never reorder or
// edit another module's lines. Handlers for sweeper-issued kinds must follow worker/contracts.ts
// (kind, queue, payload schema, dedupe key).
import type { JobHandler } from '../types.js';
import { workerHandlers } from './worker.js';
import { leadsHandlers } from '../../leads/handlers.js';

export const handlers: JobHandler<unknown>[] = [
  ...workerHandlers,
  ...leadsHandlers,
  // registry: add new entries above this line
];
