/** Trusted, tenant-scoped catalog input; labels must already have been confirmed by an Owner. */
export interface LeadSourceSuggestionCandidate {
  readonly id: string;
  readonly name: string;
  /** Owner-confirmed imported labels only (lead_sources.import_labels), never inferred aliases. */
  readonly ownerConfirmedLabels: readonly string[];
}

export type LeadSourceSuggestion =
  | { status: 'no_match' }
  | { status: 'ambiguous' }
  | { status: 'suggestion'; leadSourceId: string; requiresOwnerConfirmation: true };

/**
 * Suggests only an exact name or Owner-confirmed label match, ignoring case and surrounding whitespace.
 * The caller supplies sources from the authorized tenant only; this pure helper cannot verify provenance.
 * A suggestion is review data, never an applied mapping. Even a confirmed-label match requires the Owner
 * to confirm this imported label through the existing Owner-only mapping path before it takes effect.
 * Does not truncate, collapse internal spaces, infer aliases, or alter existing import mapping semantics.
 */
export function suggestLeadSource(
  importedLabel: string | null | undefined,
  sources: readonly LeadSourceSuggestionCandidate[],
): LeadSourceSuggestion {
  const label = importedLabel?.trim().toLowerCase();
  if (!label) return { status: 'no_match' };

  const matches = new Set<string>();
  for (const source of sources) {
    if (source.name.trim().toLowerCase() === label
      || source.ownerConfirmedLabels.some((confirmed) => confirmed.trim().toLowerCase() === label)) {
      matches.add(source.id);
    }
  }
  if (matches.size > 1) return { status: 'ambiguous' };
  for (const leadSourceId of matches) {
    return { status: 'suggestion', leadSourceId, requiresOwnerConfirmation: true };
  }
  return { status: 'no_match' };
}
