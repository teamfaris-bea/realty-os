// Types of the lead-email parser (re-exported by ./index.ts).

/** 'leadmetadata': the leadmetadata.org <meta name="lead_*"> convention (./leadmetadata.ts), for any sender */
export type LeadFormat = 'zillow' | 'realtor' | 'generic' | 'leadmetadata';
export type LeadType = 'buy' | 'sell' | 'rent' | 'value' | 'general';
/** UTF-16 offsets into ParseInput.text AFTER normalizeBody (i.e. into the `text` the result returns) */
export interface Span {
  start: number;
  end: number;
}
export interface Field {
  value: string;
  span: Span;
}
export interface ParsedLead {
  format: LeadFormat;
  name: Field | null;
  /** as written (intake normalizes); max 5 */
  phones: Field[];
  /** lowercased, syntactically valid only; max 5 */
  emails: Field[];
  /** ≤ 2000 chars */
  message: Field | null;
  /** property address / listing title text, ≤ 300 chars */
  property: Field | null;
  /** ≤ 64 chars, [A-Za-z0-9-] */
  listingId: Field | null;
  /** US 5-digit ZIP found inside property, else null */
  postalCode: string | null;
  leadType: LeadType;
}
export type ParseFailure = 'UNKNOWN_FORMAT' | 'NO_CONTACT_POINT' | 'PARTIAL_FORMAT';
export type ParseResult = { ok: true; text: string; lead: ParsedLead } | { ok: false; text: string; reason: ParseFailure; partial: ParsedLead | null };
export interface ParseInput {
  subject: string | null;
  /** provider's text/plain part (may be null/empty) */
  text: string | null;
  /** provider's HTML part (used only when text is empty) */
  html: string | null;
  /** lowercased domain of the trusted sender (e.g. 'zillow.com', 'mail.zillow.com'); null if unknown */
  senderDomain: string | null;
  /**
   * A lead forwarded by hand (PERSONAL_MAILBOX, R-LEM-11): read only the forwarded block, i.e. after the first
   * forwarded-message marker of the normalized body; with no marker nothing is read. Spans still index the whole body.
   */
  forwardedOnly?: boolean;
}
