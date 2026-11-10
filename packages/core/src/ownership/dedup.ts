// Dedup for intake and manual create (R-OWN-25; R-PERM-12; E19, E20, E61).
//
// The caller takes app.lock_address(hmac) for every normalized identifier in `addressLockOrder`
// order BEFORE matching (so two simultaneous inquiries for one new person produce one contact),
// then looks up existing contacts by address HMAC (app.find_contacts_by_address) and fuzzy
// candidates (name + postal, trigram ≥ 0.8), and asks `matchContacts` what to do:
//   exact phone/email matches          → attach (to the earliest when they point at several contacts,
//                                        plus a duplicate candidate per other contact)
//   fuzzy matches                      → duplicate candidates only, never an automatic merge or attach
// Inquiry-level duplicates (same source + external id, or the same fingerprint within 10 minutes)
// are `duplicate_ignored` before any of this (`inquiryDuplicate`).
import { sha256Hex } from '../compliance/index.js';
import { type ContactId, type Instant, MINUTE_MS } from '../foundation/index.js';
import type { OwnershipState } from './types.js';

export const FUZZY_NAME_THRESHOLD = 0.8;
export const FINGERPRINT_WINDOW_MS = 10 * MINUTE_MS;

/** The incoming person, already normalized (E.164 phones, lower-cased emails) and HMAC-keyed. */
export interface NormalizedPerson {
  phoneHmacs: readonly string[];
  emailHmacs: readonly string[];
  displayName?: string | null;
  postalCode?: string | null;
}

/** One existing contact found by address HMAC (exact) or by name/postal similarity (fuzzy). */
export interface ExistingMatch {
  contactId: ContactId;
  /** contacts.created_at; "earliest" breaks ties by id (UUIDv7 ids sort by creation). */
  createdAt: Instant;
  ownershipState: OwnershipState;
  closedReason?: string | null;
  /** HMACs of this contact's points that equal one of the candidate's. */
  matchedHmacs: readonly string[];
  /** pg_trgm similarity of display names (0..1), when computed. */
  nameSimilarity?: number;
  /** Same 5-digit postal code as the candidate. */
  samePostal?: boolean;
}

export type DuplicateReason = 'shared_phone' | 'shared_email' | 'phone_email_split' | 'name_postal' | 'trigram_name';

export interface DuplicateSuggestion {
  contactId: ContactId;
  reason: DuplicateReason;
}

export type DedupOutcome =
  | { kind: 'attach'; contactId: ContactId; matchedBy: ('phone' | 'email')[]; duplicates: DuplicateSuggestion[] }
  | { kind: 'create'; duplicates: DuplicateSuggestion[] };

/** Sorted, de-duplicated address HMACs: the advisory-lock order (ARCHITECTURE §10). */
export function addressLockOrder(p: NormalizedPerson): string[] {
  return [...new Set([...p.phoneHmacs, ...p.emailHmacs])].sort();
}

function attachable(m: ExistingMatch): boolean {
  // Merged contacts are redirected by the caller; soft-deleted ones never absorb new data (E39).
  return !(m.ownershipState === 'closed' && (m.closedReason === 'merged' || m.closedReason === 'deleted'));
}

function earliestFirst(a: ExistingMatch, b: ExistingMatch): number {
  return a.createdAt - b.createdAt || (a.contactId < b.contactId ? -1 : 1); // ids are unique after grouping
}

/** R-OWN-25 matching. Exact ⇒ attach; fuzzy ⇒ suggest. Never auto-merges. */
export function matchContacts(candidate: NormalizedPerson, existing: ExistingMatch[]): DedupOutcome {
  const phones = new Set(candidate.phoneHmacs);
  const emails = new Set(candidate.emailHmacs);
  const usable = existing.filter(attachable);
  const byId = new Map<string, ExistingMatch>();
  for (const m of usable) {
    const prev = byId.get(m.contactId);
    byId.set(m.contactId, prev ? { ...prev, matchedHmacs: [...new Set([...prev.matchedHmacs, ...m.matchedHmacs])], nameSimilarity: Math.max(prev.nameSimilarity ?? 0, m.nameSimilarity ?? 0), samePostal: prev.samePostal === true || m.samePostal === true } : m);
  }
  const all = [...byId.values()];
  const kinds = (m: ExistingMatch) => ({
    phone: m.matchedHmacs.some((h) => phones.has(h)),
    email: m.matchedHmacs.some((h) => emails.has(h)),
  });
  const exact = all.filter((m) => kinds(m).phone || kinds(m).email).sort(earliestFirst);
  const fuzzy = all
    .filter((m) => !exact.includes(m) && (m.nameSimilarity ?? 0) >= FUZZY_NAME_THRESHOLD)
    .sort(earliestFirst)
    .map((m): DuplicateSuggestion => ({ contactId: m.contactId, reason: m.samePostal ? 'name_postal' : 'trigram_name' }));

  const target = exact[0];
  if (!target) return { kind: 'create', duplicates: fuzzy };
  const tk = kinds(target);
  const matchedBy: ('phone' | 'email')[] = [...(tk.phone ? (['phone'] as const) : []), ...(tk.email ? (['email'] as const) : [])];
  const others = exact.slice(1).map((m): DuplicateSuggestion => {
    const k = kinds(m);
    // phone on one contact and email on another (R-OWN-25): a split; the same identifier on several: shared
    const split = (k.phone && !k.email && tk.email && !tk.phone) || (k.email && !k.phone && tk.phone && !tk.email);
    return { contactId: m.contactId, reason: split ? 'phone_email_split' : k.phone ? 'shared_phone' : 'shared_email' };
  });
  return { kind: 'attach', contactId: target.contactId, matchedBy, duplicates: [...others, ...fuzzy] };
}

/** contact_duplicate_candidates stores pairs with contact_a < contact_b (CHECK). */
export function duplicatePair(a: ContactId, b: ContactId): { contactAId: ContactId; contactBId: ContactId } {
  return a < b ? { contactAId: a, contactBId: b } : { contactAId: b, contactBId: a };
}

// ---- inquiry-level duplicates -------------------------------------------------------------------

/** lead_inquiries.fingerprint: sha256(source + sorted normalized identifier HMACs + type). */
export function inquiryFingerprint(i: { leadSourceId: string; identifierHmacs: readonly string[]; inquiryType: string }): string {
  const ids = [...new Set(i.identifierHmacs)].sort().join(',');
  return sha256Hex(`${i.leadSourceId.toLowerCase()}|${ids}|${i.inquiryType}`);
}

export interface InquiryKey {
  leadSourceId: string;
  externalId: string | null;
  fingerprint: string;
  receivedAt: Instant;
}

/**
 * R-OWN-25 / E19: the same (lead_source, external_id) is ignored; so is the same fingerprint within
 * 10 minutes of an earlier inquiry. `prior` are earlier inquiries with that source/external id or
 * fingerprint. Returns the reason, or null for a genuinely new inquiry.
 */
export function inquiryDuplicate(incoming: InquiryKey, prior: readonly InquiryKey[]): 'EXTERNAL_ID' | 'FINGERPRINT' | null {
  if (incoming.externalId !== null) {
    if (prior.some((p) => p.leadSourceId === incoming.leadSourceId && p.externalId === incoming.externalId)) return 'EXTERNAL_ID';
  }
  const windowHit = prior.some(
    (p) => p.fingerprint === incoming.fingerprint && Math.abs(incoming.receivedAt - p.receivedAt) < FINGERPRINT_WINDOW_MS,
  );
  return windowHit ? 'FINGERPRINT' : null;
}
