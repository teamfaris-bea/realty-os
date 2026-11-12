// The entity-owner filter (R-HOME-3; E564). A county record's owner can be a company, a trust, an estate or a bank.
// Those are dropped before the attach decision, so a contact is matched only to a PERSON named as owner; a record that
// names only entities is "does not name a person as owner" (missing_data) and nothing is kept.
// VERIFY with each county: the words it uses for entities and how it writes co-owners.
// VERIFY WITH COUNSEL (verify_items 9; owner question 9): never matching an LLC or trust owner, even one that carries the
// contact's name, is the recommended default; whether SC Code 30-2-50 treats LLC and out-of-state owners differently
// is open.

/** Whole words (after punctuation is removed) that mark an owner as an entity. VERIFY. */
export const ENTITY_OWNER_WORDS: readonly string[] = [
  'LLC', 'INC', 'INCORPORATED', 'CORP', 'CORPORATION', 'TRUST', 'TRUSTS', 'TRUSTEE', 'TRUSTEES', 'ESTATE',
  'LP', 'LLP', 'LTD', 'BANK', 'ASSOCIATION', 'ASSN',
];
const ENTITY = new Set(ENTITY_OWNER_WORDS);

/** True when a name is an entity (any entity word, "L.L.C." included). */
export function isEntityOwner(name: string): boolean {
  const words = name.toUpperCase().replace(/\./g, '').replace(/[^A-Z0-9]+/g, ' ').trim().split(' ');
  return words.some((w) => ENTITY.has(w));
}

/**
 * The person owners only: each "A & B" part on its own, entity parts dropped. VERIFY (verify_items 14): the owner-name
 * formats on the real layer (middle initials, "LAST FIRST & FIRST2", ETAL, JR) against core/predict normalizeOwnerName's
 * exact token sets; measure the not_matched rate on a sample before relying on it. Any tolerance (initials, suffixes, a
 * shared last name) is a reviewed module-49 change, never a tweak here.
 */
export function personOwnerNames(names: readonly string[]): string[] {
  return names
    .flatMap((n) => n.split('&'))
    .map((n) => n.trim())
    .filter((n) => n !== '' && !isEntityOwner(n));
}
