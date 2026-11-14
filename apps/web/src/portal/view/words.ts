// module 46: the words of the client's view (R-PORTALWEB-5, R-PORTALWEB-6, R-PORTALWEB-8, R-PORTALWEB-10). The client
// portal and the staff preview render the same sentences. Plain, calm, no code, no "AI", no urgency. VERIFY WITH
// COUNSEL (C10, VERIFY 1): "You can see this until {date}", "Shared {date}", the preview banner, dates with no done mark;
// the full list is in PHASE2_3_PLAN #### 46 and DEPLOY §10.1, pinned to these words by test/verify1.test.ts.

export const VIEW_WORDS = {
  portalTitle: 'Your client portal',
  nothingShared: 'Nothing is shared with you right now. If you expected to see your home here, ask your agent.',
  noLongerShared: 'This is no longer shared with you.',
  noDates: 'No dates are shared yet.',
  noDocuments: 'No documents are shared yet.',
  timeline: 'Timeline',
  documents: 'Documents',
  nextSteps: 'Next steps',
  yourAgent: 'Your agent',
  contactFallback: 'Reply to any text or email from your agent.',
  fileUnavailable: "This file isn't available now. It may no longer be shared with you. Try again, or ask your agent.",
  downloading: 'Getting the file',
  /** a reason 45 did not give (the banner reads "{Name} can't see this now: the reason is not known.") */
  previewGeneric: 'the reason is not known.',
} as const;

export const visibleUntil = (date: string): string => `You can see this until ${date}.`;
export const sharedOn = (date: string): string => `Shared ${date}`;
export const byDate = (date: string): string => `By ${date}`;
export const textAgent = (name: string | null): string => `Text ${name ?? 'your agent'}`;
export const emailAgent = (name: string | null): string => `Email ${name ?? 'your agent'}`;
export const downloadLabel = (title: string): string => `Download ${title}`;

/** The staff preview banner (R-PORTALWEB-10): the client's name verbatim, 45's reason sentences as given. */
export const previewVisible = (name: string): string => `This is what ${name} sees now.`;
export const previewHidden = (name: string, reason: string): string => `${capitalize(name)} can't see this now: ${lowerFirst(reason)}`;

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
function lowerFirst(s: string): string {
  // "The client portal is not turned on…" reads "…: the client portal is not turned on…"; a name stays as written
  return /^The\b/.test(s) ? `t${s.slice(1)}` : s;
}
