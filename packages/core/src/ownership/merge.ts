// Merge ownership (R-OWN-24) and merge redirects (R-OWN-20). The transactional half (re-pointing
// messages and calls, pause-wins, stopping the loser's enrollment, moving handbacks and drafts) is
// db/client's; core decides who owns the survivor and which ledger events each side gets.
import type { ContactId, Instant, UserId } from '../foundation/index.js';
import type { OwnershipProjection } from './types.js';

export type MergeOwnerRule = 'neither_owned' | 'only_survivor_owned' | 'only_loser_owned' | 'same_owner' | 'different_owners';

export type MergeOwnership =
  | { ok: true; rule: MergeOwnerRule; ownerUserId: UserId | null; losingOwnerUserId: UserId | null; preselected: UserId | null }
  | { ok: false; code: 'MERGE_OWNER_REQUIRED'; preselected: UserId; candidates: [UserId, UserId] }
  | { ok: false; code: 'VALIDATION_FAILED' | 'LEAD_STATE_CHANGED'; preselected: UserId | null };

function ownerOf(p: OwnershipProjection): UserId | null {
  return p.state === 'owned' ? p.ownerUserId : null;
}

/** The owner preselected for a TL/Admin choice: the earliest owned_at (ties: the survivor's). */
export function preselectMergeOwner(survivor: OwnershipProjection, loser: OwnershipProjection): UserId | null {
  const s = ownerOf(survivor);
  const l = ownerOf(loser);
  if (s === null) return l;
  if (l === null) return s;
  return (loser.ownedAt as Instant) < (survivor.ownedAt as Instant) ? l : s;
}

/**
 * R-OWN-24 ownership matrix:
 *   only one owned       → its owner survives
 *   same owner           → that owner
 *   different owners     → a TL/Admin must choose one of the two (preselected: earliest owned_at);
 *                          the losing owner is notified
 *   neither owned        → the survivor's state is kept
 * `ownerChoice` is required only for different owners; elsewhere it must be null or equal the
 * computed owner (a stale choice ⇒ LEAD_STATE_CHANGED).
 */
export function mergeOwnership(survivor: OwnershipProjection, loser: OwnershipProjection, ownerChoice: UserId | null): MergeOwnership {
  const s = ownerOf(survivor);
  const l = ownerOf(loser);
  const preselected = preselectMergeOwner(survivor, loser);
  if (s !== null && l !== null && s !== l) {
    if (ownerChoice === null) return { ok: false, code: 'MERGE_OWNER_REQUIRED', preselected: preselected as UserId, candidates: [s, l] };
    if (ownerChoice !== s && ownerChoice !== l) return { ok: false, code: 'VALIDATION_FAILED', preselected };
    return { ok: true, rule: 'different_owners', ownerUserId: ownerChoice, losingOwnerUserId: ownerChoice === s ? l : s, preselected };
  }
  const rule: MergeOwnerRule = s === null && l === null ? 'neither_owned' : s !== null && l !== null ? 'same_owner' : s !== null ? 'only_survivor_owned' : 'only_loser_owned';
  const owner = s ?? l;
  if (ownerChoice !== null && ownerChoice !== owner) return { ok: false, code: 'LEAD_STATE_CHANGED', preselected };
  return { ok: true, rule, ownerUserId: owner, losingOwnerUserId: null, preselected };
}

/** Both contacts are locked in ascending id order (R-OWN-24, ARCHITECTURE §10 lock order). */
export function mergeLockOrder(a: ContactId, b: ContactId): [ContactId, ContactId] {
  return a <= b ? [a, b] : [b, a];
}

export const MERGE_REDIRECT_MAX_DEPTH = 5;

/**
 * R-OWN-20: an inquiry for a contact closed as merged is redirected along merged_into, at most
 * five hops. `mergedInto(id)` returns the contact's merged_into_contact_id (null when it is not
 * merged). Cycles and chains longer than five hops are refused.
 */
export function resolveMergeRedirect(
  start: ContactId,
  mergedInto: (id: ContactId) => ContactId | null,
): { ok: true; contactId: ContactId; hops: number } | { ok: false; code: 'MERGE_REDIRECT_TOO_DEEP' | 'MERGE_REDIRECT_CYCLE' } {
  const seen = new Set<string>([start]);
  let cur = start;
  for (let hops = 0; ; hops++) {
    const next = mergedInto(cur);
    if (next === null) return { ok: true, contactId: cur, hops };
    if (hops >= MERGE_REDIRECT_MAX_DEPTH) return { ok: false, code: 'MERGE_REDIRECT_TOO_DEEP' };
    if (seen.has(next)) return { ok: false, code: 'MERGE_REDIRECT_CYCLE' };
    seen.add(next);
    cur = next;
  }
}
