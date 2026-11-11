// The Gmail connect disclosure (module 69). The text lives in disclosure.json (one source, read by the API's
// disclosure test too); the connect request carries the SHA-256 hex of the paragraphs joined by two
// newlines, exactly as shown. Changing a word changes the hash: the API then refuses the connect
// (MAIL_DISCLOSURE_STALE) until apps/api/src/mailSync/disclosure.ts lists the new hash. VERIFY WITH COUNSEL (C14).
import disclosure from './disclosure.json';

export const DISCLOSURE_TITLE: string = disclosure.title;
export const DISCLOSURE_PARAGRAPHS: readonly string[] = disclosure.paragraphs;

/** The exact text the hash covers. */
export const disclosureText = (paragraphs: readonly string[] = DISCLOSURE_PARAGRAPHS): string => paragraphs.join('\n\n');

/** SHA-256 hex (Web Crypto) of the disclosure text. */
export async function disclosureSha256(paragraphs: readonly string[] = DISCLOSURE_PARAGRAPHS): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(disclosureText(paragraphs)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
