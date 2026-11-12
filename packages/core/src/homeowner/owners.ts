// The entity-owner filter (R-HOME-3; E564). A county record's owner can be a company, a trust, an estate or a bank.
// Those are dropped before the attach decision, so a contact is matched only to a PERSON named as owner; a record that
// names only entities is "does not name a person as owner" (missing_data) and nothing is kept.
// VERIFY with each county: the words it uses for entities and how it writes co-owners.

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

/** The person owners only: each "A & B" part on its own, entity parts dropped. */
export function personOwnerNames(names: readonly string[]): string[] {
  return names
    .flatMap((n) => n.split('&'))
    .map((n) => n.trim())
    .filter((n) => n !== '' && !isEntityOwner(n));
}
