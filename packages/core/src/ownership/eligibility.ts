// Routing eligibility (R-OWN-11) and claim eligibility (R-OWN-16), plus R-PERM-15 (TCs never own
// or claim leads). Pure predicates over facts the caller read under its locks.
import { type Role, canOwnLeads } from '../foundation/index.js';
import type { Candidate, MemberFacts, OwnershipErrorCode, PondFacts, SkipReason } from './types.js';

/** Roles that may receive routed offers (R-OWN-11 step 2). Owners and Admins assign; they are not routed to. */
export const ROUTABLE_ROLES: ReadonlySet<Role> = new Set<Role>(['agent', 'team_lead', 'isa']);

/**
 * The first failing R-OWN-11 check, in order, or null when the candidate is eligible:
 *  1 active membership  2 role in {agent, team_lead, isa}  3 accepting_leads
 *  4 a working critical notification channel  5 not already offered this lead in this sequence
 *  6 not in release cooldown for this lead  7 uncontacted owned leads < capacity cap
 */
export function skipReason(c: Candidate, capacityCap: number): SkipReason | null {
  if (c.status !== 'active') return 'MEMBERSHIP_INACTIVE';
  if (!ROUTABLE_ROLES.has(c.role)) return 'ROLE_NOT_ELIGIBLE';
  if (!c.acceptingLeads) return 'NOT_ACCEPTING_LEADS';
  if (!c.hasCriticalChannel) return 'NO_CRITICAL_CHANNEL';
  if (c.alreadyOffered === true) return 'ALREADY_OFFERED';
  if (c.inReleaseCooldown) return 'RELEASE_COOLDOWN';
  if (c.uncontactedOwned >= capacityCap) return 'CAPACITY_REACHED';
  return null;
}

export function isEligible(c: Candidate, capacityCap: number): boolean {
  return skipReason(c, capacityCap) === null;
}

/** Whether `role` may claim from `pond` (eligible roles, open_to_all or a pond member; never a TC). */
export function pondAllows(pond: PondFacts, role: Role): boolean {
  if (!canOwnLeads(role)) return false;
  if (pond.archived) return false;
  if (!pond.eligibleRoles.includes(role)) return false;
  return pond.openToAll || pond.actorIsMember;
}

/**
 * R-OWN-16 checks after the state check, in order: eligible role for the pond, active membership,
 * claims today < claims_per_day, no cooldown, capacity below the cap.
 */
export function claimBlock(i: {
  pond: PondFacts;
  member: MemberFacts;
  stats: { claimsToday: number; inCooldown: boolean; uncontactedOwned: number };
  capacityCap: number;
}): OwnershipErrorCode | null {
  if (!pondAllows(i.pond, i.member.role)) return 'POND_NOT_ELIGIBLE';
  if (i.member.status !== 'active') return 'MEMBERSHIP_INACTIVE';
  if (i.stats.claimsToday >= i.pond.claimsPerDay) return 'CLAIM_LIMIT_REACHED';
  if (i.stats.inCooldown) return 'CLAIM_COOLDOWN';
  if (i.stats.uncontactedOwned >= i.capacityCap) return 'CAPACITY_REACHED';
  return null;
}

/** An assign / handoff / import target: an active member whose role may own leads (R-PERM-15). */
export function canReceiveLead(m: MemberFacts | undefined): boolean {
  return m !== undefined && m.status === 'active' && canOwnLeads(m.role);
}
