// Keys of the transaction module (R-ACC-6, PHASE2_3_PLAN module 31).
import type { DealDateId } from '../foundation/index.js';

/** exception_items key of a milestone risk: `milestone:{deal_date}:{due_version}`. */
export function milestoneKey(dealDateId: DealDateId | string, dueVersion: number): string {
  return `milestone:${dealDateId}:${dueVersion}`;
}
