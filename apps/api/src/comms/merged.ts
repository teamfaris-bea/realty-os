// F1 (D1, R-OWN-24, R-PAR-45): a merged-away record is never a send target.
//
// A merge moves the loser's messages and calls to the survivor's conversation, copies its points onto the survivor
// and carries its do-not-contact to the survivor's own row (app.contacts_dnc_follow_merge), so the person lives on the
// survivor. Anything newly addressed to the merged-away record would be stranded on it, off the survivor's timeline,
// like the people writes that are 404 there (people/common.ts liveDetailFacts). So a text, an email, a compose preview
// and a call addressed to one are refused before anything is created, and no assistant or system message is queued to
// one (compose.ts queueOutboundInTx; the saved-search alerts skip it). This is not an opt-out rule: whatever reaches a
// merged-away record anyway (a message composed while the merge committed) is judged as the whole person, in core
// canContact (repos/gate.ts) and in both DB dispatch guards (migration 0041, app.contact_person_ids).
import type { Tx } from '@realty/db';
import { AppError } from '../errors.js';
import { visibleSurvivorOf } from './repos/contacts.js';

/**
 * Throws 409 CONTACT_MERGED for a merged-away record; `details.mergedInto` names the record the person lives on now,
 * only when the caller's RLS shows its detail (R-PERM-5: a collaborator of the loser is not told about the survivor).
 */
export async function refuseMergedAway(tx: Tx, contact: { id: string; mergedIntoContactId: string | null }): Promise<void> {
  if (contact.mergedIntoContactId === null) return;
  const survivor = await visibleSurvivorOf(tx, contact.id);
  throw new AppError('CONTACT_MERGED', survivor ? { mergedInto: survivor } : {});
}
