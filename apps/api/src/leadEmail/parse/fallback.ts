// Loose reading of a lead email no template matched (Follow Up Boss style: never drop a trusted email).
//
// The strict parser (./index.ts) does not call this. A trusted email whose template is unknown or only
// partly recognized, and that yielded no phone and no email, is read here. A phone or email in the prose
// becomes a lead flagged for review. Invoice, closing-document, and newsletter mail is not a lead.
// Every field still cites a span of the normalized body. Portal and sender addresses are never a lead's.
import { earliestType, isOwnAddress, labelAt, splitLines } from './extract.js';
import { cleanField, findZip, isPlausibleName, isValidEmail, phoneDigits } from './fields.js';
import { VENDOR_TYPE_KEYWORDS } from './labels.js';
import { MAX_MESSAGE, MAX_NAME, MAX_PHONE, MAX_POINTS, MAX_PROPERTY } from './limits.js';
import type { Field, ParsedLead } from './types.js';

const EMAIL_RE = /[A-Za-z0-9.!#$%&*+/=?^_`{|}~-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}/g;
const PHONE_RE = /(?:\+?1[\s.-]?)?(?:\([0-9]{3}\)[\s.-]?|[0-9]{3}[\s.-])[0-9]{3}[\s.-][0-9]{4}/g;
const NAME_RE = /(?:my name is|this is|i am)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+){0,2})/i;
const PROPERTY_RE = /\d{1,6}\s+(?:[A-Za-z0-9.'-]+\s+){1,5}[A-Za-z0-9.'-]+,\s*[A-Za-z .'-]{2,40},?\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?/;

/**
 * Mail that is not a new lead. Each kind matches on its own: an invoice, a closing-document notice, or a
 * market newsletter / market update. Checked before any lead is created, including when the labels would parse.
 */
export function isNonLeadMail(subject: string | null, text: string): boolean {
  const head = `${subject ?? ''}\n${text}`.slice(0, 8_000);
  if (/\binvoice\b/i.test(head)) return true;
  if (/\bclosing[- ]documents?\b/i.test(head)) return true;
  if (/\bnewsletter\b/i.test(head) || /\bmarket update\b/i.test(head)) return true;
  return false;
}

function field(text: string, start: number, end: number, max: number): Field | null {
  while (start < end && /\s/.test(text.charAt(start))) start++;
  while (end > start && /\s/.test(text.charAt(end - 1))) end--;
  if (start >= end) return null;
  const value = cleanField(text.slice(start, end), max);
  return value === '' ? null : { value, span: { start, end } };
}

/** Lender, military, and loan lines on an AgentDash referral (empty when the line is absent). */
export function agentdashFlags(text: string): { military: string | null; lender: string | null; loanType: string | null } {
  const out = { military: null as string | null, lender: null as string | null, loanType: null as string | null };
  const keys: Record<string, keyof typeof out> = { 'military status': 'military', military: 'military', lender: 'lender', 'loan type': 'loanType' };
  for (const line of splitLines(text)) {
    const hit = labelAt(text, line);
    const key = hit ? keys[hit.label] : undefined;
    if (!hit || !key || out[key]) continue;
    const value = cleanField(text.slice(hit.valueStart, hit.valueEnd), 200);
    if (value !== '') out[key] = value;
  }
  return out;
}

/**
 * A lead from prose: at least one phone or email that is not the portal's and not the sender's.
 * Null when nothing reachable is there. Never throws.
 */
export function fallbackLead(text: string, senderDomain: string): ParsedLead | null {
  if (typeof text !== 'string' || text === '') return null;
  const emails: Field[] = [];
  const phones: Field[] = [];
  const seenE = new Set<string>();
  const seenP = new Set<string>();
  for (const m of text.matchAll(EMAIL_RE)) {
    if (emails.length >= MAX_POINTS) break;
    const raw = m[0] ?? '';
    const at = m.index ?? -1;
    if (at < 0 || !isValidEmail(raw)) continue;
    const value = raw.toLowerCase();
    if (seenE.has(value) || isOwnAddress(value, senderDomain)) continue;
    seenE.add(value);
    emails.push({ value, span: { start: at, end: at + raw.length } });
  }
  for (const m of text.matchAll(PHONE_RE)) {
    if (phones.length >= MAX_POINTS) break;
    const raw = m[0] ?? '';
    const at = m.index ?? -1;
    if (at < 0 || raw.length > MAX_PHONE) continue;
    const value = cleanField(raw, MAX_PHONE);
    const digits = phoneDigits(value);
    if (digits === null || seenP.has(digits)) continue;
    seenP.add(digits);
    phones.push({ value, span: { start: at, end: at + raw.length } });
  }
  if (emails.length + phones.length === 0) return null;

  const nameM = NAME_RE.exec(text);
  let name: Field | null = null;
  if (nameM?.[1] !== undefined && nameM.index !== undefined) {
    const start = nameM.index + nameM[0].length - nameM[1].length;
    const candidate = field(text, start, start + nameM[1].length, MAX_NAME);
    if (candidate && isPlausibleName(text.slice(candidate.span.start, candidate.span.end), candidate.value)) name = candidate;
  }
  const propM = PROPERTY_RE.exec(text);
  const property = propM && propM.index !== undefined ? field(text, propM.index, propM.index + propM[0].length, MAX_PROPERTY) : null;
  const message = field(text, 0, text.length, MAX_MESSAGE);
  return {
    format: 'fallback',
    name,
    phones,
    emails,
    message,
    property,
    listingId: null,
    postalCode: property ? findZip(property.value) : null,
    leadType: earliestType(`${text}`, VENDOR_TYPE_KEYWORDS) ?? 'general',
  };
}
