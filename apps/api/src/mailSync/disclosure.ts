// The Gmail connect disclosures the API accepts (module 69 shows the text; PHASE2_3_PLAN §5.4 #69). The connect
// request carries the SHA-256 of the exact paragraphs shown (apps/web/src/surfaces/settings/mail/disclosure.json,
// joined by two newlines); a link stores it in user_mail_links.disclosure_sha256. disclosure.test.ts proves the web
// file's current hash is listed here, so a copy change cannot ship without updating this list. VERIFY WITH COUNSEL
// (C14). Add a new hash on top when the text changes; keep older ones only while a deployed web build still shows them.
// Batch 7 review sends/F4 added "Replies you send from Gmail don't count as first contact. Reply here to stop the
// clock." (R-GMAIL-14). The previous hash (1d934711…) is not kept: module 69 is dark behind platform:gmail and no
// deployed web build showed that text to a real team.
export const ACCEPTED_DISCLOSURE_SHA256: readonly string[] = ['ec50c5cae564be2d99e7e3f8720e0e91b26491bc8bb0cf2d2233416910793306'];

export const CURRENT_DISCLOSURE_SHA256 = ACCEPTED_DISCLOSURE_SHA256[0]!;
