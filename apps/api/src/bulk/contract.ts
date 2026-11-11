// The bulk.run job (parity module 63): payload = the action id only (R-TEN-7); one live job per action.
import type { z } from 'zod';
import type { EntityJobContract } from '../worker/contracts.js';
import { jobPayload, zId } from '../worker/payload.js';

export const BulkRunPayload = jobPayload({ actionId: zId });
export type BulkRunPayload = z.infer<typeof BulkRunPayload>;

export const BULK_RUN: EntityJobContract<BulkRunPayload> = {
  kind: 'bulk.run',
  queue: 'default',
  priority: 120,
  schema: BulkRunPayload,
  dedupeKey: (p) => `bulk.run:${p.actionId}`,
};
