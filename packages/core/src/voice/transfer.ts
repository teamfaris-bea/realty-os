// Who a caller can be transferred to (R-VOICE-6, R-GATE-9 core side).
//
// Only the contact's CURRENT owner, when that owner's membership is active, they are accepting
// leads and the call is inside routing hours. Everyone else (unowned, after hours, owner
// unavailable) gets a booking or a message, and the critical handback goes to the owner or, for an
// unowned caller, to whoever the normal intake offer reaches. It never names anyone else (the
// on-duty roster is cut, PHASE2_3_PLAN §3) and never an address; nothing here dials or changes
// ownership. Whether the owner actually answers within the hold is the policy machine's job.
import { type Instant, type UserId, isBusinessOpen } from '../foundation/index.js';
import type { ContactFacts } from './types.js';

/** R-VOICE-6 default hold (known gap (b): the pack value voice_transfer_hold_seconds is not seeded). VERIFY. */
export const DEFAULT_TRANSFER_HOLD_SECONDS = 20;
/** The content's own bounds (VoiceContent.transferHoldSeconds 5–60). */
export const MIN_TRANSFER_HOLD_SECONDS = 5;
export const MAX_TRANSFER_HOLD_SECONDS = 60;

export type TransferTarget = { kind: 'owner'; userId: UserId; holdSeconds: number } | { kind: 'message'; handbackTo: 'owner' | 'intake_offer' };

export function holdSecondsOf(contact: ContactFacts): number {
  const h = contact.holdSeconds;
  if (h === undefined || !Number.isFinite(h)) return DEFAULT_TRANSFER_HOLD_SECONDS;
  return Math.min(MAX_TRANSFER_HOLD_SECONDS, Math.max(MIN_TRANSFER_HOLD_SECONDS, Math.round(h)));
}

export function transferTarget(contact: ContactFacts, now: Instant): TransferTarget {
  const o = contact.owner;
  if (o === null) return { kind: 'message', handbackTo: 'intake_offer' };
  if (o.status === 'active' && o.acceptingLeads && isBusinessOpen(now, contact.routingHours)) return { kind: 'owner', userId: o.userId, holdSeconds: holdSecondsOf(contact) };
  return { kind: 'message', handbackTo: 'owner' };
}
