// Which pond leads reach a member right now (R-OWN-16; journey bug: agents never saw a pond lead).
//
// A pond lead reaches exactly the members allowed to claim it. The rules that depend on the lead (it is in a pond
// the member may claim from, a pond that allows claims, and the member is not in claim cooldown on it) are
// app.my_pond_leads' (migration pond_leads_feed); the incremental feed stores the cards they give. The rules that
// depend only on the member's own running totals are decided here, when the feed or the Pond page is read, with
// core's own claimBlock over the same app.claim_stats a claim reads: claims since the tenant-local day began
// against the pond's claims_per_day, and owned leads still waiting for a first touch against the capacity cap.
// They are never stored: they change with the member's other leads and with the day, and no write marks them.
// The claim itself re-decides everything under the contact lock (core decideClaim), so this only decides what is
// shown; it can never let anyone claim more.
import { type Instant, type Role, type UserActor, type UserId, startOfLocalDay, toIso, zone } from '@realty/core/foundation';
import { type MembershipStatus, type PondFacts, claimBlock } from '@realty/core/ownership';
import type { Tx } from '@realty/db';
import * as repo from './repos/contacts.js';

/** What stops the member claiming from a pond they may claim from, now. */
export type ClaimBlockedBy = 'CLAIM_LIMIT_REACHED' | 'CAPACITY_REACHED';

export interface ClaimablePond {
  id: string;
  name: string;
  isDefault: boolean;
  claimsPerDay: number;
  blockedBy: ClaimBlockedBy | null;
}

export interface ClaimStatus {
  /** the ponds the member may claim from, each with what blocks a claim now (null: nothing) */
  ponds: ClaimablePond[];
  claimsToday: number;
  uncontactedOwned: number;
  capacityCap: number;
}

const BLOCKS: ReadonlySet<string> = new Set<ClaimBlockedBy>(['CLAIM_LIMIT_REACHED', 'CAPACITY_REACHED']);

/** The member's claimable ponds and their own claim totals, as a claim at `now` would read them. */
export async function claimStatus(tx: Tx, actor: UserActor, now: Instant): Promise<ClaimStatus> {
  const settings = await repo.claimSettings(tx);
  const ponds = await repo.myClaimablePonds(tx);
  if (!settings || ponds.length === 0) return { ponds: [], claimsToday: 0, uncontactedOwned: 0, capacityCap: settings?.cap ?? 0 };
  const dayStart = startOfLocalDay(now, zone(settings.zone));
  // no row: not an active member (a claim would refuse too)
  const totals = (await repo.myClaimTotals(tx, actor.userId, toIso(dayStart), toIso(now))) ?? { claimsToday: Number.MAX_SAFE_INTEGER, uncontactedOwned: Number.MAX_SAFE_INTEGER };
  const member = { userId: actor.userId as UserId, role: actor.role as Role, status: 'active' as MembershipStatus, acceptingLeads: true };
  const out: ClaimablePond[] = [];
  for (const p of ponds) {
    const pond: PondFacts = {
      pondId: p.id as never,
      isDefault: p.is_default,
      archived: false,
      openToAll: p.open_to_all,
      eligibleRoles: p.eligible_roles as Role[],
      actorIsMember: p.is_member,
      claimsPerDay: p.claims_per_day,
      claimCooldownHours: p.claim_cooldown_hours,
      reinquiry: p.reinquiry,
    };
    // the cooldown is per lead (app.my_pond_leads), so it is left out here
    const block = claimBlock({ pond, member, stats: { claimsToday: totals.claimsToday, inCooldown: false, uncontactedOwned: totals.uncontactedOwned }, capacityCap: settings.cap });
    if (block !== null && !BLOCKS.has(block)) continue; // not claimable by this member at all (app.my_pond_ids() and core agree)
    out.push({ id: p.id, name: p.name, isDefault: p.is_default, claimsPerDay: p.claims_per_day, blockedBy: block as ClaimBlockedBy | null });
  }
  return { ponds: out, claimsToday: totals.claimsToday, uncontactedOwned: totals.uncontactedOwned, capacityCap: settings.cap };
}

/** The pond ids whose cards the member may not act on now (their totals block a claim there). */
export function blockedPondIds(s: ClaimStatus): string[] {
  return s.ponds.filter((p) => p.blockedBy !== null).map((p) => p.id);
}
