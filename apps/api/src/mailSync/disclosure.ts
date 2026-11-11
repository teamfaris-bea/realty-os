// The Gmail connect disclosures the API accepts (module 69 shows the text; PHASE2_3_PLAN §5.4 #69). The connect
// request carries the SHA-256 of the exact paragraphs shown (apps/web/src/surfaces/settings/mail/disclosure.json,
// joined by two newlines); a link stores it in user_mail_links.disclosure_sha256. disclosure.test.ts proves the web
// file's current hash is listed here, so a copy change cannot ship without updating this list. VERIFY WITH COUNSEL
// (C14). Add a new hash on top when the text changes; keep older ones only while a deployed web build still shows them.
export const ACCEPTED_DISCLOSURE_SHA256: readonly string[] = ['0fc89b11aa794b0fe0ac5351130cee35bd6dbbb5d669452996cdce21209bf830'];

export const CURRENT_DISCLOSURE_SHA256 = ACCEPTED_DISCLOSURE_SHA256[0]!;
