// Projection shape invariants: core's mirror of the `contacts` CHECKs (R-OWN-1, 0001_init.sql
// contacts_ownership_shape / contacts_owned_period / contacts_period_seq / route_due / closed_reason).
// fold() and decide() refuse to produce a projection that the database would reject.
import type { OwnershipProjection } from './types.js';

/** Returns the violated invariants (empty when the projection is well-formed). */
export function checkShape(p: OwnershipProjection): string[] {
  const issues: string[] = [];
  const owner = p.ownerUserId !== null;
  const pond = p.pondId !== null;
  const offer = p.offerId !== null || p.offeredToUserId !== null || p.offerExpiresAt !== null;
  const fullOffer = p.offerId !== null && p.offeredToUserId !== null && p.offerExpiresAt !== null;
  switch (p.state) {
    case 'unassigned':
      if (owner || pond || offer) issues.push('unassigned has no owner, pond or offer');
      break;
    case 'offered':
      if (owner || pond || !fullOffer) issues.push('offered has exactly an offer (id, offeree, expiry)');
      break;
    case 'owned':
      if (!owner || pond || offer || p.ownedAt === null) issues.push('owned has exactly an owner and owned_at');
      break;
    case 'in_pond':
      if (owner || !pond || offer) issues.push('in_pond has exactly a pond');
      break;
    case 'closed':
      if (owner || pond || offer) issues.push('closed has no owner, pond or offer');
      break;
  }
  if (p.state !== 'owned') {
    if (p.ownedAt !== null || p.firstTouchDueAt !== null || p.firstTouchAt !== null || p.firstTouchBreachedAt !== null || p.releaseDueAt !== null) {
      issues.push('owned-period fields only while owned');
    }
  }
  if ((p.state === 'owned') !== (p.periodSeq !== null)) issues.push('owned <=> ownership_period_seq');
  if (p.periodSeq !== null && (p.periodSeq < 1 || p.periodSeq > p.seq)) issues.push('ownership_period_seq <= ownership_seq');
  if (p.routeDueAt !== null && p.state !== 'unassigned') issues.push('route_due_at => unassigned');
  if ((p.state === 'closed') !== (p.closedReason !== null)) issues.push('closed <=> closed_reason');
  if (!Number.isSafeInteger(p.seq) || p.seq < 1) issues.push('ownership_seq >= 1');
  if (!Number.isInteger(p.offerRound) || p.offerRound < 0) issues.push('offer_round >= 0');
  return issues;
}
