// Jobs of api/stage-automation (parity module 67). Payloads hold ids only (R-TEN-7).
//   stage_automation.reconcile   default  tx          one stage event → its decision (+ the enrollment)
//   stage_automation.scan        default  tx, 1 min   recent user stage events with no decision → reconcile jobs
//   stage_automation.annual      default  tx, 6 h     annual-date reminder tasks (R-PAR-20)
import type { z } from 'zod';
import type { EntityJobContract } from '../worker/contracts.js';
import { jobPayload, zId } from '../worker/payload.js';

export const ReconcilePayload = jobPayload({ stageEventId: zId });
export type ReconcilePayload = z.infer<typeof ReconcilePayload>;

export const STAGE_RECONCILE: EntityJobContract<ReconcilePayload> = {
  kind: 'stage_automation.reconcile',
  queue: 'default',
  priority: 90,
  schema: ReconcilePayload,
  dedupeKey: (p) => `stage_automation.reconcile:${p.stageEventId}`,
};

export const STAGE_SCAN_KIND = 'stage_automation.scan' as const;
export const ANNUAL_KIND = 'stage_automation.annual' as const;

/** How far back the backup scan looks for undecided stage events, and how many per pass. */
export const SCAN_WINDOW_MS = 60 * 60_000;
export const SCAN_LIMIT = 500;
