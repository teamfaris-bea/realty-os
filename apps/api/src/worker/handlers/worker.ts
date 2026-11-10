// The handlers api/jobs-worker itself owns (registered through handlers/index.ts).
import type { JobHandler } from '../types.js';
import { blobDeleteHandler } from './blobDelete.js';
import { dispatchStaleHandler } from './dispatchStale.js';
import { consentDriftHandler, ownershipDriftHandler } from './drift.js';
import { ownershipFollowupHandler } from './followup.js';

export const workerHandlers: JobHandler<unknown>[] = [
  ownershipFollowupHandler(),
  dispatchStaleHandler(),
  ownershipDriftHandler(),
  consentDriftHandler(),
  blobDeleteHandler(),
];
