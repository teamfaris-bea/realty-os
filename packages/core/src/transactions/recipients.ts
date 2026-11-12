// Who on a deal is the team's client (K1, b8 deals sends/F1; R-TXN-4, R-AVM-3). Pure.
//
// deals.side says which side the team represents. Only that side's client roles are the team's clients:
//   buy  -> buyer, co_buyer
//   sell -> seller, co_seller
//   dual -> all four
//   lease -> none (owner default: no automatic milestone updates on lease deals)
// The other side's buyer or seller (often another agent's client) is never sent the team's automatic messages.
// Lender, title and attorney are not client roles: they stay exactly as an approved step names them.
import type { DealSide } from './types.js';

export const CLIENT_ROLES = ['buyer', 'seller', 'co_buyer', 'co_seller'] as const;
export type ClientRole = (typeof CLIENT_ROLES)[number];

const SIDE_CLIENT_ROLES: Readonly<Record<DealSide, readonly ClientRole[]>> = {
  buy: ['buyer', 'co_buyer'],
  sell: ['seller', 'co_seller'],
  dual: ['buyer', 'seller', 'co_buyer', 'co_seller'],
  lease: [],
};

export function isClientRole(role: string): role is ClientRole {
  return (CLIENT_ROLES as readonly string[]).includes(role);
}

/** The client roles the team represents on a deal of this side. */
export function teamClientRoles(side: DealSide): readonly ClientRole[] {
  return SIDE_CLIENT_ROLES[side] ?? [];
}

/**
 * The deal roles of a contact that may receive the team's automatic deal messages: its non-client roles (as an
 * approved step names them) and its client roles on the team's side. The caller still intersects with the step.
 */
export function updateRoles(side: DealSide, roles: readonly string[]): string[] {
  const team = teamClientRoles(side) as readonly string[];
  return roles.filter((r) => !isClientRole(r) || team.includes(r));
}

/** The contact's client roles that belong to the other side of the deal (or any client role on a lease deal). */
export function otherSideRoles(side: DealSide, roles: readonly string[]): string[] {
  const team = teamClientRoles(side) as readonly string[];
  return roles.filter((r) => isClientRole(r) && !team.includes(r));
}

/** The step's roles a deal of this side can actually reach (for the deal screen's "who gets updates" line). */
export function reachableStepRoles(side: DealSide, stepRoles: readonly string[]): string[] {
  return updateRoles(side, stepRoles);
}
