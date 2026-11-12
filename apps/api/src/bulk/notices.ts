// Bulk notices (parity module 63; R-PAR-35, R-PAR-41). Text-free of PII: kinds, codes and counts only.
//   bulk_finished      one per action, to its creator: "Emailed 398 of 412: 9 opted out, 5 no address"
//   assign summary     one per affected user (replaces the per-person reassignment notices), and one per agent whose
//                      offers it withdrew (batch 6 review F6)
import type { IdGenerator } from '@realty/core/foundation';
import { type BulkCounts, finishedSentence } from '@realty/core/parity/bulk';
import type { Tx } from '@realty/db';
import * as B from './repos/bulk.js';

/** The creator's bulk_finished notification (system actor). Deduplicated per action. */
export async function notifyFinished(tx: Tx, ids: IdGenerator, a: Pick<B.ActionRow, 'id' | 'kind' | 'createdByUserId'>, counts: BulkCounts, outcome: 'completed' | 'canceled' | 'failed'): Promise<void> {
  await B.notify(tx, ids.next<'NotificationId'>(), {
    userId: a.createdByUserId,
    kind: 'bulk_finished',
    title: finishedSentence(a.kind, counts, outcome),
    body: null,
    subjectId: a.id,
    dedupeKey: `bulk_finished:${a.id}`,
  }, () => ids.next<'NotificationDeliveryId'>());
}

/** R-PAR-35: one summary per user whose leads a bulk assign moved (gained or lost), instead of one per lead. */
export async function notifyAssignSummaries(tx: Tx, ids: IdGenerator, actionId: string, gained: ReadonlyMap<string, number>, lost: ReadonlyMap<string, number>): Promise<void> {
  for (const [userId, n] of [...gained].sort()) {
    await B.notify(tx, ids.next<'NotificationId'>(), { userId, kind: 'reassigned_to_you', title: `${n} ${n === 1 ? 'lead was' : 'leads were'} assigned to you`, body: null, subjectId: actionId, dedupeKey: `bulk_assign:${actionId}:to` }, () => ids.next<'NotificationDeliveryId'>());
  }
  for (const [userId, n] of [...lost].sort()) {
    if (gained.has(userId)) continue;
    await B.notify(tx, ids.next<'NotificationId'>(), { userId, kind: 'reassigned_away', title: `${n} of your ${n === 1 ? 'leads was' : 'leads were'} reassigned`, body: null, subjectId: actionId, dedupeKey: `bulk_assign:${actionId}:away` }, () => ids.next<'NotificationDeliveryId'>());
  }
}

/**
 * Batch 6 review F6: one summary per agent who had leads on offer that a bulk assign took (the engine withdraws an offer
 * when it assigns the lead, R-OWN-18), instead of one per lead. Their offer cards just resolved before.
 */
export async function notifyOfferSummaries(tx: Tx, ids: IdGenerator, actionId: string, withdrawn: ReadonlyMap<string, number>): Promise<void> {
  for (const [userId, n] of [...withdrawn].sort()) {
    await B.notify(tx, ids.next<'NotificationId'>(), { userId, kind: 'reassigned_away', title: `${n} ${n === 1 ? 'lead offered to you was' : 'leads offered to you were'} withdrawn: ${n === 1 ? 'it was' : 'they were'} assigned to someone else`, body: null, subjectId: actionId, dedupeKey: `bulk_assign:${actionId}:offer` }, () => ids.next<'NotificationDeliveryId'>());
  }
}
