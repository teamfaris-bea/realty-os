// Lead notification emails (leadmetadata.org meta tags, Zillow, Realtor.com, a generic labelled format) → structured
// lead fields.
// Pure: no I/O, no clock, no randomness, links are never followed. Trust (DKIM) is decided by the caller;
// this module only reads an already-decoded body. R-INBOX-9: every extracted field cites its source span
// in the normalized body; a field not found stays empty; no phone and no email ⇒ review. E78: a changed
// vendor template leaves the unparsed fields empty and goes to review. E153: a forged email never throws.
//
// Vendor formats are GUESSES (no real samples yet): see the VERIFY marks in ./labels.ts.
import { type Extraction, earliestType, extract, isOwnAddress, labelLeadType, type Line, splitLines } from './extract.js';
import { type LeadMetadata, metadataPrefix, scanLeadMetadata } from './leadmetadata.js';
import { BODY_CONTROLS, cleanField, findZip, isPlausibleName, isValidEmail, phoneDigits } from './fields.js';
import { cutAt, htmlToText } from './html.js';
import { GENERIC_LABELS, SUBJECT_PROPERTY_RE, VENDOR_TYPE_KEYWORDS, VENDORS, type VendorFormat } from './labels.js';
import { MAX_INPUT_CHARS, MAX_MESSAGE, MAX_NAME, MAX_PHONE, MAX_PROPERTY, MAX_SUBJECT } from './limits.js';
import type { Field, LeadFormat, ParsedLead, ParseInput, ParseResult } from './types.js';

export type { Field, LeadFormat, LeadType, ParsedLead, ParseFailure, ParseInput, ParseResult, Span } from './types.js';
export { MAX_INPUT_CHARS } from './limits.js';
export { PORTAL_DOMAINS } from './labels.js';
export { cleanField } from './fields.js';
export { htmlToText } from './html.js';
export { LEAD_META_NAMES, LEAD_META_VERSION, scanLeadMetadata } from './leadmetadata.js';

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** The lead metadata of the raw HTML part (never for a hand-forwarded email: only its forwarded block is read). */
function metadataOf(input: ParseInput): LeadMetadata {
  return input?.forwardedOnly === true ? { declared: false, values: [], conflicts: [] } : scanLeadMetadata(input?.html);
}

function normalizeWith(input: ParseInput, meta: LeadMetadata): string {
  const text = cutAt(str(input?.text), MAX_INPUT_CHARS);
  let body = text.trim() !== '' ? text : htmlToText(cutAt(str(input?.html), MAX_INPUT_CHARS), MAX_INPUT_CHARS);
  body = (metadataPrefix(meta) + body).replace(/\r\n?/g, '\n').normalize('NFKC').replace(BODY_CONTROLS, '');
  return cutAt(body, MAX_INPUT_CHARS);
}

/**
 * The body the parser reads (and every span points into): text ?? htmlToText(html) (html only when the
 * text part is empty), CRLF/CR → LF, NFKC, C0/C1 controls except \n \t removed, ≤ MAX_INPUT_CHARS.
 * Inputs are truncated to MAX_INPUT_CHARS before any processing. When the raw HTML part declares lead
 * metadata (./leadmetadata.ts), its values come first as "lead_name: …" lines, then a blank line.
 */
export function normalizeBody(input: ParseInput): string {
  return normalizeWith(input, metadataOf(input));
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

/** A forwarded-message marker line is at most this long. */
const MAX_MARKER_LINE = 200;

/**
 * The index of the first line of the forwarded block: after the first forwarded-message marker, or -1 (VERIFY 14:
 * client wordings; English only so far). Gmail "---------- Forwarded message ---------"; Apple Mail "Begin forwarded
 * message:"; Outlook "-----Original Message-----", or its header block "From: …" followed within 3 lines by "Sent: …"
 * (the block itself is read from its From: line; From/Sent/To/Subject are not lead labels).
 */
export function forwardedStart(text: string, lines: readonly Line[]): number {
  const content = (l: Line | undefined) => (l && l.end - l.start <= MAX_MARKER_LINE ? text.slice(l.start, l.end).trim().toLowerCase() : '');
  for (let idx = 0; idx < lines.length; idx++) {
    const c = content(lines[idx]);
    if (c === '') continue;
    if (c.startsWith('-') && c.includes('forwarded message')) return idx + 1;
    if (c === 'begin forwarded message:') return idx + 1;
    if (/^-+ ?original message ?-+$/.test(c)) return idx + 1;
    if (c.startsWith('from:')) {
      for (let k = idx + 1; k <= idx + 3 && k < lines.length; k++) if (content(lines[k]).startsWith('sent:')) return idx;
    }
  }
  return -1;
}

/** The leadmetadata.org values, read back from the prefix lines of the normalized body (spans into it). */
function metadataLead(meta: LeadMetadata, text: string, lines: readonly Line[], sender: string): ParsedLead {
  const lead: ParsedLead = { format: 'leadmetadata', name: null, phones: [], emails: [], message: null, property: null, listingId: null, postalCode: null, leadType: 'general' };
  for (let idx = 0; idx < meta.values.length && idx < lines.length; idx++) {
    const { name } = meta.values[idx]!;
    const line = lines[idx]!;
    const head = `${name}: `;
    if (!text.startsWith(head, line.start)) break; // defensive: the prefix was cut
    const span = { start: line.start + head.length, end: line.end };
    while (span.end > span.start && /[ \t]/.test(text.charAt(span.end - 1))) span.end--;
    const raw = text.slice(span.start, span.end);
    switch (name) {
      case 'lead_name': {
        const value = cleanField(raw, MAX_NAME);
        if (isPlausibleName(raw, value)) lead.name = { value, span };
        break;
      }
      case 'lead_email': {
        const value = raw.toLowerCase();
        if (isValidEmail(raw) && !isOwnAddress(value, sender)) lead.emails.push({ value, span });
        break;
      }
      case 'lead_phone': {
        const value = cleanField(raw, MAX_PHONE);
        if (raw.length <= MAX_PHONE && phoneDigits(value) !== null) lead.phones.push({ value, span });
        break;
      }
      case 'lead_message': {
        const value = cleanField(raw, MAX_MESSAGE);
        if (value !== '') lead.message = { value, span };
        break;
      }
      case 'lead_property_address': {
        const value = cleanField(raw, MAX_PROPERTY);
        if (value !== '') lead.property = { value, span };
        break;
      }
      case 'lead_type':
        lead.leadType = labelLeadType(cleanField(raw, 200)) ?? 'general';
        break;
      case 'lead_source':
        // never changes the lead source (the inbox's lead source is the source); not recorded
        break;
    }
  }
  lead.postalCode = lead.property ? findZip(lead.property.value) : null;
  return lead;
}

function parse(input: ParseInput, text: string, meta: LeadMetadata): ParseResult {
  const sender = normalizeDomain(input?.senderDomain);
  const subject = cleanField(cutAt(str(input?.subject), MAX_SUBJECT * 4), MAX_SUBJECT);
  let lines: Line[] = splitLines(text);

  if (input?.forwardedOnly === true) {
    // a lead forwarded by hand: only the forwarded block; no marker ⇒ nothing is pre-filled
    const from = forwardedStart(text, lines);
    if (from < 0 || from >= lines.length) return { ok: false, text, reason: 'UNKNOWN_FORMAT', partial: null };
    lines = lines.slice(from);
  }

  // leadmetadata.org first, for any sender (trust is decided by the caller)
  let metaResult: ParseResult | null = null;
  if (meta.declared) {
    const lead = metadataLead(meta, text, lines, sender);
    if (meta.conflicts.length > 0) return { ok: false, text, reason: 'PARTIAL_FORMAT', partial: foundAnything(lead) ? lead : null };
    metaResult = result(text, lead);
    if (metaResult.ok) return metaResult;
  }

  const scope = lines.length > 0 && lines[0]!.start > 0 ? text.slice(lines[0]!.start) : text;
  let vendorPartial: ParsedLead | null = null;
  let vendorSender = false;
  for (const v of VENDORS) {
    if (!isVendorSender(v, sender)) continue;
    vendorSender = true;
    const ex = extract(text, lines, v.labels, sender);
    if (v.marker.test(scope) && hasContactLabel(ex)) return result(text, toLead(v.format, ex, text, subject));
    const lead = toLead(v.format, ex, text, subject);
    if (!vendorPartial && foundAnything(lead)) vendorPartial = lead;
  }

  // generic: a "Name:" label and at least one "Email:"/"Phone:" label
  const ex = extract(text, lines, GENERIC_LABELS, sender);
  if (ex.seen.has('name') && (ex.seen.has('email') || ex.seen.has('phone'))) {
    const g = result(text, toLead('generic', ex, text, subject));
    if (g.ok || !metaResult) return g;
  }
  if (metaResult) return metaResult;

  return vendorSender ? { ok: false, text, reason: 'PARTIAL_FORMAT', partial: vendorPartial } : { ok: false, text, reason: 'UNKNOWN_FORMAT', partial: null };
}

/** Never throws, for any input. ok:true only with a detected format and at least one phone or email. */
export function parseLeadEmail(input: ParseInput): ParseResult {
  let text = '';
  try {
    const meta = metadataOf(input);
    text = normalizeWith(input, meta);
    return parse(input, text, meta);
  } catch {
    // last resort only: the code above is written not to throw
    return { ok: false, text, reason: 'UNKNOWN_FORMAT', partial: null };
  }
}
