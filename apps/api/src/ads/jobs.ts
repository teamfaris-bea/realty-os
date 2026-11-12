// Job definitions of api/ads (module 52), shared by the handlers and the routes that enqueue a pass (no import cycle).
import { jobPayload } from '../worker/payload.js';

export const ADS_JOBS = { reconcile: 'ads.reconcile', propose: 'ads.propose' } as const;

/** Payloads carry no ids, names or amounts (R-TEN-7): a pass reads everything from the tenant's own rows. */
export const AdsEmpty = jobPayload({});

/** What enqueueTyped needs to queue an extra reconcile pass now (a cap lowered below spend, a campaign linked). */
export const ADS_RECONCILE_JOB = { kind: ADS_JOBS.reconcile, queue: 'default', schema: AdsEmpty, maxAttempts: 3 } as const;
