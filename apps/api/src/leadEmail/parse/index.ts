// Lead notification emails (Zillow, Realtor.com, a generic labelled format) → structured lead fields.
// Pure: no I/O, no clock, no randomness, links are never followed. Trust (DKIM) is decided by the caller;
// this module only reads an already-decoded body. R-INBOX-9: every extracted field cites its source span
// in the normalized body; a field not found stays empty; no phone and no email ⇒ review. E78: a changed
// vendor template leaves the unparsed fields empty and goes to review. E153: a forged email never throws.
//
// Vendor formats are GUESSES (no real samples yet): see the VERIFY marks in ./labels.ts.
import { type Extraction, earliestType, extract, type Line, splitLines } from './extract.js';
import { BODY_CONTROLS, cleanField, findZip } from './fields.js';
import { cutAt, htmlToText } from './html.js';
import { GENERIC_LABELS, SUBJECT_PROPERTY_RE, VENDOR_TYPE_KEYWORDS, VENDORS, type VendorFormat } from './labels.js';
import { MAX_INPUT_CHARS, MAX_PROPERTY, MAX_SUBJECT } from './limits.js';
import type { Field, LeadFormat, ParsedLead, ParseInput, ParseResult } from './types.js';

export type { Field, LeadFormat, LeadType, ParsedLead, ParseFailure, ParseInput, ParseResult, Span } from './types.js';
export { MAX_INPUT_CHARS } from './limits.js';
export { PORTAL_DOMAINS } from './labels.js';
export { cleanField } from './fields.js';
export { htmlToText } from './html.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/**
 * The body the parser reads (and every span points into): text ?? htmlToText(html) (html only when the
 * text part is empty), CRLF/CR → LF, NFKC, C0/C1 controls except \n \t removed, ≤ MAX_INPUT_CHARS.
 * Inputs are truncated to MAX_INPUT_CHARS before any processing.
 */
export function normalizeBody(input: ParseInput): string {
  const text = cutAt(str(input?.text), MAX_INPUT_CHARS);
  let body = text.trim() !== '' ? text : htmlToText(cutAt(str(input?.html), MAX_INPUT_CHARS), MAX_INPUT_CHARS);
  body = body.replace(/\r\n?/g, '\n').normalize('NFKC').replace(BODY_CONTROLS, '');
  return cutAt(body, MAX_INPUT_CHARS);
}

function normalizeDomain(d: unknown): string {
  return str(d).trim().toLowerCase().replace(/\.+$/, '');
}

const isVendorSender = (v: VendorFormat, sender: string) => v.senderDomains.some((d) => sender === d || sender.endsWith('.' + d));
const hasContactLabel = (ex: Extraction) => ex.seen.has('name') || ex.seen.has('email') || ex.seen.has('phone');
const foundAnything = (l: ParsedLead) =>
  l.name !== null || l.phones.length > 0 || l.emails.length > 0 || l.message !== null || l.property !== null || l.listingId !== null;

/** A vendor subject naming the property, cited where the same text appears in the body. */
function subjectProperty(subject: string, text: string): Field | null {
  const m = SUBJECT_PROPERTY_RE.exec(subject);
  const g = m?.[1] ? cleanField(m[1], MAX_PROPERTY) : '';
  if (g === '') return null;
  const at = text.indexOf(g);
  return at < 0 ? null : { value: g, span: { start: at, end: at + g.length } };
}

function toLead(format: LeadFormat, ex: Extraction, text: string, subject: string): ParsedLead {
  const vendor = format !== 'generic';
  const property = ex.property ?? (vendor ? subjectProperty(subject, text) : null);
  const leadType = ex.labelType ?? (vendor ? (earliestType(subject, VENDOR_TYPE_KEYWORDS) ?? earliestType(text, VENDOR_TYPE_KEYWORDS)) : null) ?? 'general';
  return {
    format,
    name: ex.name,
    phones: ex.phones,
    emails: ex.emails,
    message: ex.message,
    property,
    listingId: ex.listingId,
    postalCode: property ? findZip(property.value) : null,
    leadType,
  };
}

function result(text: string, lead: ParsedLead): ParseResult {
  return lead.phones.length + lead.emails.length > 0 ? { ok: true, text, lead } : { ok: false, text, reason: 'NO_CONTACT_POINT', partial: lead };
}

function parse(input: ParseInput, text: string): ParseResult {
  const sender = normalizeDomain(input?.senderDomain);
  const subject = cleanField(cutAt(str(input?.subject), MAX_SUBJECT * 4), MAX_SUBJECT);
  const lines: Line[] = splitLines(text);

  let vendorPartial: ParsedLead | null = null;
  let vendorSender = false;
  for (const v of VENDORS) {
    if (!isVendorSender(v, sender)) continue;
    vendorSender = true;
    const ex = extract(text, lines, v.labels, sender);
    if (v.marker.test(text) && hasContactLabel(ex)) return result(text, toLead(v.format, ex, text, subject));
    const lead = toLead(v.format, ex, text, subject);
    if (!vendorPartial && foundAnything(lead)) vendorPartial = lead;
  }

  // generic: a "Name:" label and at least one "Email:"/"Phone:" label
  const ex = extract(text, lines, GENERIC_LABELS, sender);
  if (ex.seen.has('name') && (ex.seen.has('email') || ex.seen.has('phone'))) return result(text, toLead('generic', ex, text, subject));

  return vendorSender ? { ok: false, text, reason: 'PARTIAL_FORMAT', partial: vendorPartial } : { ok: false, text, reason: 'UNKNOWN_FORMAT', partial: null };
}

/** Never throws, for any input. ok:true only with a detected format and at least one phone or email. */
export function parseLeadEmail(input: ParseInput): ParseResult {
  let text = '';
  try {
    text = normalizeBody(input);
    return parse(input, text);
  } catch {
    // last resort only: the code above is written not to throw
    return { ok: false, text, reason: 'UNKNOWN_FORMAT', partial: null };
  }
}
