// The source review's own words (R-LSRC-10, owner decision 2026-11-14). Pure, unit-tested (sourceReview.test.tsx).
//
// A row's sentence is the API's (apps/api/src/leads/importLabels.ts importLabelSentence, unlabeledSentence) and is shown
// as it is. What the web words itself: the row's title and state chip, where and when the label was first imported and
// who last changed its mapping, the counts line of an import's review (before the import and in its summary), what a
// choice will do before the Owner applies it, and what a change stopped. None of them says "mapped" of a label that is
// only suggested, and none says the Owner turned a setting on when the people are only in review.
import { formatStamp, plural } from '../admin/lib/format.js';
import { withdrawnDraftsWords } from './words.js';

export type ImportLabelState = 'mapped' | 'suggested' | 'ambiguous' | 'in_review';
export type ImportKind = 'csv' | 'fub_api' | 'fub_export';

/** One row of the source review, as the API sends it (leads/sourcesSchemas.ts ImportLabel; imports/schemas.ts SourceLabel). */
export interface ImportLabelView {
  /** the review record, or null for a label so far seen only in an import's preview */
  id: string | null;
  /** the label exactly as imported; '' on the row of an import's no-label group (`unlabeledImportId` is then set) */
  label: string;
  /**
   * R-LSRC-9, R-LSRC-10: set on the row of one import's people who came in with NO source label. That row is mapped by
   * this id, never by a label: the server refuses an empty label.
   */
  unlabeledImportId: string | null;
  /** the CRM-wide list: people an import committed with it; an import's rows: that import's people */
  people: number;
  /** of those, the people an import has committed with it (0 on an import's rows before its contacts are imported) */
  committedPeople: number;
  /**
   * E755 (migration 0103): only on an import's own row mapped to a marked source; null (or absent) on every other row.
   * Of `people`, those already in the CRM whom the import only matched: the mapping does not cover them, and automated
   * contact still reaches them. The API's sentence says the numbers; the row adds a chip (notCoveredWords).
   */
  matchedOnlyPeople?: number | null;
  state: ImportLabelState;
  leadSourceId: string | null;
  leadSourceName: string | null;
  /** mapped to a source with "No automated contact for leads from this source" on */
  noAutomatedContact: boolean;
  /** state is not mapped: the people committed with it get no automated contact until the Owner chooses a source */
  inReview: boolean;
  /** state suggested only: the exact match core suggestLeadSource names. Never applied until the Owner confirms it. */
  suggestion: { leadSourceId: string; leadSourceName: string; noAutomatedContact: boolean } | null;
  firstSeen: { importId: string; kind: ImportKind; at: string } | null;
  changedBy: { userId: string; name: string } | null;
  changedAt: string | null;
  sentence: string;
}

/** What the server is asked to map: a label exactly as it was received, or one import's no-label group. */
export const mappingKey = (r: Pick<ImportLabelView, 'label' | 'unlabeledImportId'>): { label: string } | { unlabeledImportId: string } =>
  r.unlabeledImportId ? { unlabeledImportId: r.unlabeledImportId } : { label: r.label };

/** A stable key for a row: the import of a no-label group, else the label itself. */
export const rowKey = (r: Pick<ImportLabelView, 'label' | 'unlabeledImportId'>): string => (r.unlabeledImportId ? `import:${r.unlabeledImportId}` : `label:${r.label}`);

export const NO_LABEL_TITLE = 'No source label';
/** The field label of the no-label row's choice (it has no label to quote). */
export const NO_LABEL_FIELD = 'Lead source for the people imported with no source label';
export const OWNER_MAPS_LABELS = 'Only the Owner maps an imported source label to a lead source.';
/**
 * What choosing a lead source for a label does, in the intro of the review (an import's step and the Lead sources
 * section): it decides automated contact for the people imported with it. It never changes whose lead they count as.
 */
export const WHAT_CHOOSING_DOES =
  "Until an Owner chooses a lead source for a label, the people imported with it are in review. Once one is chosen, automated contact for them follows that source's setting; lead counts and reports do not change. A match is only ever suggested, never applied for you.";
export const NO_AUTOMATED_CONTACT_SETTING = 'No automated contact for leads from this source';

/** The row's heading: the label in quotes, exactly as imported, or the no-label group's name. */
export const rowTitle = (r: Pick<ImportLabelView, 'label' | 'unlabeledImportId'>): string => (r.unlabeledImportId ? NO_LABEL_TITLE : `"${r.label}"`);
/** What a row's group of controls is called (announced before each control in it). */
export const rowGroupName = (r: Pick<ImportLabelView, 'label' | 'unlabeledImportId'>): string => (r.unlabeledImportId ? 'People imported with no source label' : `Source label "${r.label}"`);
export const fieldLabel = (r: Pick<ImportLabelView, 'label' | 'unlabeledImportId'>): string => (r.unlabeledImportId ? NO_LABEL_FIELD : `Lead source for "${r.label}"`);

/** The state chip: "Mapped" only of a label a lead source holds; a suggestion is still in review. */
export function stateWords(r: Pick<ImportLabelView, 'state' | 'noAutomatedContact'>): { text: string; tone: 'ok' | 'warn' | 'neutral' } {
  switch (r.state) {
    case 'mapped':
      return r.noAutomatedContact ? { text: 'Mapped · no automated contact', tone: 'neutral' } : { text: 'Mapped', tone: 'ok' };
    case 'suggested':
      return { text: 'In review · a match is suggested', tone: 'warn' };
    case 'ambiguous':
      return { text: 'In review · more than one match', tone: 'warn' };
    case 'in_review':
      return { text: 'In review', tone: 'warn' };
  }
}

/**
 * E755: the chip of an import's own row mapped to a source with the setting on, while people of the file are already in
 * the CRM and not imported from it: the mapping does not cover them (only a committed import outcome does). Null when
 * the row counts nobody of the kind, which is every row of the CRM-wide list.
 */
export function notCoveredWords(r: Pick<ImportLabelView, 'state' | 'noAutomatedContact' | 'matchedOnlyPeople'>): string | null {
  const n = r.matchedOnlyPeople ?? 0;
  if (r.state !== 'mapped' || !r.noAutomatedContact || n <= 0) return null;
  return n === 1 ? '1 person already in the CRM is not covered' : `${n} people already in the CRM are not covered`;
}

const KIND_WORDS: Record<ImportKind, string> = { csv: 'a CSV file', fub_api: 'Follow Up Boss', fub_export: 'a Follow Up Boss export file' };

/** Where and when the label first came in, and who last changed its mapping (the API's provenance, in words). */
export function provenanceWords(r: Pick<ImportLabelView, 'firstSeen' | 'changedBy' | 'changedAt'>): string {
  const seen = r.firstSeen ? `First imported ${formatStamp(r.firstSeen.at)} from ${KIND_WORDS[r.firstSeen.kind]}.` : 'Not imported yet: seen in a preview only.';
  const changed = r.changedBy && r.changedAt ? ` Mapping last changed by ${r.changedBy.name}, ${formatStamp(r.changedAt)}.` : '';
  return `${seen}${changed}`;
}

export interface ReviewCounts {
  /** label rows still in review */
  labels: number;
  /** a no-label group is still in review */
  blank: boolean;
  /** the people of the rows in review (an import's rows: that import's people) */
  people: number;
  /** of those, the people already imported */
  committed: number;
  mappedRows: number;
}

export function reviewCounts(rows: readonly ImportLabelView[]): ReviewCounts {
  const open = rows.filter((r) => r.inReview);
  return {
    labels: open.filter((r) => !r.unlabeledImportId).length,
    blank: open.some((r) => !!r.unlabeledImportId),
    people: open.reduce((n, r) => n + r.people, 0),
    committed: open.reduce((n, r) => n + r.committedPeople, 0),
    mappedRows: rows.length - open.length,
  };
}

/** "2 labels and the people with no source label" (what is still in review), or null when nothing is. */
function inReviewWhat(c: ReviewCounts): string | null {
  const parts = [c.labels > 0 ? plural(c.labels, 'label') : null, c.blank ? 'the people with no source label' : null].filter((x): x is string => x !== null);
  return parts.length === 0 ? null : parts.join(' and ');
}

/** What "in review" means for the people, in one sentence every screen of the review ends on. */
export const IN_REVIEW_MEANS = 'People whose imported source is in review get no automated contact (no plan, no AI care, no automated text or email) until an Owner chooses a lead source. Anyone on the team can still call, text or email them one to one.';

/** Before the import runs: how much of it is still in review, and that the import may run anyway. */
export function beforeImportLine(rows: readonly ImportLabelView[]): string {
  const c = reviewCounts(rows);
  const what = inReviewWhat(c);
  if (!what) return 'Every source in this import is mapped to a lead source.';
  return `Still in review: ${what} (${plural(c.people, 'person', 'people')}). You can run the import with these left in review.`;
}

/** The summary after the import: the same, with the people it actually brought in. */
export function afterImportLine(rows: readonly ImportLabelView[]): string {
  const c = reviewCounts(rows);
  const what = inReviewWhat(c);
  if (!what) return 'Every source this import brought in is mapped to a lead source.';
  return `Still in review after this import: ${what} (${plural(c.committed, 'person', 'people')} imported).`;
}

/**
 * What applying the chosen source will do, said before the Owner applies it: a mapping decides automated contact for
 * the people imported with the label and nothing else. Attribution is never set from a label (the people's own lead
 * source is not changed), so the source's lead counts and reports stay as they are, and the words say so.
 */
export function choiceWords(source: { name: string; noAiCare?: boolean | undefined }): string {
  if (source.noAiCare) return `${source.name} has "${NO_AUTOMATED_CONTACT_SETTING}" on: nothing automatic will go to the people imported with this, and plans running for them stop.`;
  return `Automated contact for the people imported with this will follow the setting of ${source.name}. Lead counts and reports do not change. If none of their other imported sources is still in review or marked, automated contact is allowed for them again. A plan that already stopped stays stopped.`;
}

/** What removing a mapping does, said before the Owner confirms it. */
export const REMOVE_WARNING =
  'The people imported with it go back in review: nothing automatic goes to them, plans running for them stop, AI care for them pauses and drafts a plan or an alert wrote for them are withdrawn. None of that starts again on its own if you map it later.';

/**
 * What a change stopped for people who are in review after it, or who still carry another unreviewed source (the API's
 * counts: AI care asked to pause, plans asked to stop, drafts withdrawn). Each sentence starts with a space; empty when
 * there was nothing. Never "its leads": no lead source is involved (the marked-source words are words.ts madeSafeWords).
 */
export function stoppedWords(c: { pausing?: number | undefined; stopping?: number | undefined; withdrawn?: number | undefined }): string {
  const p = c.pausing ?? 0;
  const s = c.stopping ?? 0;
  const care = p > 0 ? ` AI care running for ${p} of these people will pause.` : '';
  const plans = s === 1 ? ' 1 plan running for these people will stop.' : s > 1 ? ` ${s} plans running for these people will stop.` : '';
  return `${care}${plans}${withdrawnDraftsWords(c.withdrawn)}`;
}
