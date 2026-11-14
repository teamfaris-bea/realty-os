// Q-PORTAL-16 (owner product direction 2026-11-14; batch 18 item a): a client's own inbound message can quote the
// sign-in link they were sent (an SMS reaction "Liked “… <link>”", an email reply quoting the sign-in email, a link
// pasted into web chat). Module 22 replaces the quoted token VALUE before the content is stored, so no stored body, text
// part, handback snippet, feed card or log line carries it; the stored record is labelled `content_redacted =
// 'portal_signin_token'` (0093), and the thread view shows the label. The timeline also hides a token in a message
// stored before this change at read time ("display"), and never rewrites that stored record.
//
// Pure: no I/O. Conservative by design: ANY `#token=` value is removed (the sign-in link's fragment, PORTAL_PAGE
// #token=, and the staff invite and reset links' fragments, none of which a client should quote), in the encodings a
// mail client, a link wrapper or an HTML body uses for the `#` and the `=` (percent, double percent, HTML entities). It
// never weakens sign-in: the link is single use for 15 minutes whatever is stored; this only keeps the value out of our
// records. Opt-out and keyword classification still read the message as it was sent (comms/inbound.ts), so an opt-out
// is never lost to a redaction.

/** The stored label of a redacted record (the content_redacted column of a message and of an MMS text part; 0093). */
export const SIGNIN_TOKEN_REDACTION = 'portal_signin_token' as const;
/** What replaces the token value: the link stays recognisable, its secret part does not. */
export const SIGNIN_TOKEN_PLACEHOLDER = '[sign-in token removed]';

// `#` as written, percent-encoded (once or twice: link wrappers such as safe-links re-encode), or as an HTML entity
const HASH = String.raw`(?:#|%23|%2523|&#0*35;|&#x0*23;|&num;)`;
// `=` the same ways
const EQ = String.raw`(?:=|%3D|%253D|&#0*61;|&#x0*3D;|&equals;)`;
// the value: base64url (newPortalToken), percent escapes, and the few URL characters a wrapper may leave
const VALUE = String.raw`(?:[A-Za-z0-9_\-.~]|%[0-9A-Fa-f]{2})+`;
const TOKEN = new RegExp(`(${HASH}token${EQ})${VALUE}`, 'gi');

export interface Redacted {
  text: string;
  /** how many token values were removed (0: the text is unchanged) */
  removed: number;
}

/** Removes every quoted sign-in token value from `text`. */
export function redactSignInTokens(text: string): Redacted {
  let removed = 0;
  const out = text.replace(TOKEN, (_m, prefix: string) => {
    removed += 1;
    return `${prefix}${SIGNIN_TOKEN_PLACEHOLDER}`;
  });
  return { text: removed === 0 ? text : out, removed };
}

/** The same for a nullable field (a subject, a preview). */
export function redactNullable(text: string | null): { text: string | null; removed: number } {
  return text === null ? { text: null, removed: 0 } : redactSignInTokens(text);
}
