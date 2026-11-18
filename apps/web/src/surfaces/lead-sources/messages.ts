// Error code → sentence for the Lead sources surface (CONVENTIONS §7: the web never shows a raw code). Registered on
// this surface's `errorMessages`; the components look codes up through sentenceFor, which adds the lead-email,
// lead-admin and agent sentences and the shell's (REAUTH_REQUIRED, NOT_FOUND, ...).
import { LEAD_EMAIL_MESSAGES, sentenceFor as leadEmailSentence } from '../lead-email/messages.js';

export const LEAD_SOURCES_ERROR_MESSAGES: Record<string, string> = {
  LEAD_SOURCE_OFF: 'This source is off. Turn it on first, then set this up.',
  NUMBER_NOT_TRACKING: 'Only a live tracking number can be tied to a lead source.',
  GOOGLE_LEAD_FORM_NOT_AVAILABLE: "This deployment has no public https address, so Google can't reach it.",
  GOOGLE_LEAD_FORM_ALREADY_ON: 'The Google lead form is already on for this source. What you see now is up to date.',
  // R-LSRC-10: the Owner confirmed a suggestion that no longer holds (a lead source was renamed, or the label was mapped meanwhile)
  IMPORT_LABEL_SUGGESTION_CHANGED: 'The suggestion for this label changed while you were looking at it. The list now shows what is true.',
};

/** R-LSRC-10 (E742): one lead source holds at most `limit` imported labels; the Owner maps this one to another source. */
export function labelLimitSentence(limit: unknown): string {
  return `This lead source already holds ${typeof limit === 'number' ? limit : 200} imported labels, the most one lead source can hold. Choose another lead source for this one.`;
}

export const NAME_TAKEN = 'Another lead source already has this name. Pick a different one.';

const ALL: Record<string, string> = { ...LEAD_EMAIL_MESSAGES, ...LEAD_SOURCES_ERROR_MESSAGES };

/** The sentence for a failure (never the code). A duplicate name (409 VERSION_CONFLICT {field:'name'}) says so. */
export function sentenceFor(e: { code: string; details?: Record<string, unknown> | null } | string): string {
  if (typeof e !== 'string' && e.code === 'VERSION_CONFLICT' && e.details?.field === 'name') return NAME_TAKEN;
  if (typeof e !== 'string' && e.code === 'VALIDATION_FAILED' && Array.isArray(e.details?.issues) && (e.details.issues[0] as { code?: unknown } | undefined)?.code === 'lead_source_label_limit') return labelLimitSentence(e.details.limit);
  const code = typeof e === 'string' ? e : e.code;
  if (Object.hasOwn(LEAD_SOURCES_ERROR_MESSAGES, code)) return ALL[code]!;
  return leadEmailSentence(e);
}
