// Pure decisions and views of api/duplicates (property-tested in views.test.ts).
//
// The server never merges from here; these only tell the page what the engine WILL decide, so the merge
// sheet can show the owner choice up front instead of failing after the tap. The engine stays the
// authority: decideMerge (core ownership) re-decides everything under both contact locks.
import type { Role } from '@realty/core/foundation';
import type { z } from 'zod';
import type * as repo from './repo.js';
import type { DuplicatePair, DuplicateSide, MATCH_REASONS } from './schemas.js';

export type PairView = z.infer<typeof DuplicatePair>;
type SideView = z.infer<typeof DuplicateSide>;
export type MatchReason = (typeof MATCH_REASONS)[number];

export const REASON_TEXT: Record<MatchReason, string> = {
  shared_phone: 'Same phone number',
  shared_email: 'Same email address',
  phone_email_split: 'Phone matches one person, email the other',
  name_postal: 'Same name and ZIP code',
  trigram_name: 'Very similar name',
  import: 'Found by the import',
};

export interface OwnerFacts {
  id: string;
  ownershipState: string;
  ownerUserId: string | null;
  ownedAt: number | null;
  createdAt: number;
}

/** The suggested survivor: the earlier record (ties: the smaller id), so the original history leads. */
export function suggestedSurvivor(a: OwnerFacts, b: OwnerFacts): string {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? a.id : b.id;
  return a.id < b.id ? a.id : b.id;
}

const ownerOf = (s: OwnerFacts) => (s.ownershipState === 'owned' ? s.ownerUserId : null);

/** Mirrors core mergeOwnership (R-OWN-24): different owners need a choice, preselected by the earliest owned_at. */
export function mergeOwnerRule(survivor: OwnerFacts, loser: OwnerFacts): { rule: 'same'; userId: string | null } | { rule: 'choose'; preselectedUserId: string; candidates: [string, string] } {
  const s = ownerOf(survivor);
  const l = ownerOf(loser);
  if (s !== null && l !== null && s !== l) {
    const pre = (loser.ownedAt ?? Infinity) < (survivor.ownedAt ?? Infinity) ? l : s;
    return { rule: 'choose', preselectedUserId: pre, candidates: [s, l] };
  }
  return { rule: 'same', userId: s ?? l };
}

/**
 * Mirrors the role rules of core decideMerge: Owner/Admin/TL merge any pair they see; an agent or ISA
 * never merges a pond or offer card (they see only the card) nor across two owners; a TC never merges.
 */
export function canMergeAs(role: Role, a: OwnerFacts, b: OwnerFacts): boolean {
  if (role === 'tc') return false;
  if (role === 'owner' || role === 'admin' || role === 'team_lead') return true;
  const card = (s: OwnerFacts) => s.ownershipState === 'in_pond' || s.ownershipState === 'offered';
  if (card(a) || card(b)) return false;
  return mergeOwnerRule(a, b).rule === 'same';
}

export const ownerFacts = (s: repo.SideRow): OwnerFacts => ({
  id: s.id,
  ownershipState: s.ownership_state,
  ownerUserId: s.owner_user_id,
  ownedAt: s.owned_at ? s.owned_at.getTime() : null,
  createdAt: s.created_at.getTime(),
});

function side(s: repo.SideRow, pts: readonly repo.SidePointRow[]): SideView {
  const mine = pts.filter((p) => p.contact_id === s.id);
  const pt = (p: repo.SidePointRow) => ({ kind: p.kind as 'phone' | 'email', address: p.address, label: p.label });
  return {
    id: s.id,
    displayName: s.display_name,
    stage: s.stage,
    ownershipState: s.ownership_state,
    owner: s.owner_user_id ? { userId: s.owner_user_id, displayName: s.owner_display_name } : null,
    ownedAt: s.owned_at ? s.owned_at.toISOString() : null,
    createdAt: s.created_at.toISOString(),
    source: s.source_name,
    doNotContact: s.do_not_contact,
    phones: mine.filter((p) => p.kind === 'phone').map(pt),
    emails: mine.filter((p) => p.kind === 'email').map(pt),
    counts: { notes: s.notes, tags: s.tags, fieldValues: s.field_values, relationships: s.relationships },
  };
}

export function pairView(r: repo.CandidateRow, a: repo.SideRow, b: repo.SideRow, pts: readonly repo.SidePointRow[], role: Role): PairView {
  const fa = ownerFacts(a);
  const fb = ownerFacts(b);
  const survivorId = suggestedSurvivor(fa, fb);
  const [fs, fl] = survivorId === a.id ? [fa, fb] : [fb, fa];
  const rule = mergeOwnerRule(fs, fl);
  const name = (id: string) => (id === a.owner_user_id ? a.owner_display_name : b.owner_display_name);
  return {
    id: r.id,
    matchReason: r.match_reason as MatchReason,
    reasonText: REASON_TEXT[r.match_reason as MatchReason] ?? 'Possible duplicate',
    status: r.status,
    createdAt: r.created_at.toISOString(),
    suggestedSurvivorId: survivorId,
    owner: rule.rule === 'same'
      ? { rule: 'same', userId: rule.userId }
      : { rule: 'choose', preselectedUserId: rule.preselectedUserId, options: rule.candidates.map((u) => ({ userId: u, displayName: name(u) })) },
    canMerge: canMergeAs(role, fa, fb),
    a: side(a, pts),
    b: side(b, pts),
  };
}
