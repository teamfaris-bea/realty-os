// Labelled-line extraction over a normalized body (pure, linear in the body length).
import { cleanField, emailDomain, isDomainOrSub, isPlausibleName, isValidEmail, isValidListingId, phoneDigits } from './fields.js';
import { type FieldKey, type LabelTable, LABEL_TYPE_KEYWORDS, PORTAL_DOMAINS } from './labels.js';
import { MAX_LISTING_ID, MAX_MESSAGE, MAX_NAME, MAX_PHONE, MAX_POINTS, MAX_PROPERTY } from './limits.js';
import type { Field, LeadType } from './types.js';

/** A label is at most this long (up to its ':'). */
const MAX_LABEL = 40;

export interface Line {
  start: number;
  end: number;
}

export interface LabelHit {
  label: string;
  valueStart: number;
  valueEnd: number;
}

export interface Extraction {
  name: Field | null;
  phones: Field[];
  emails: Field[];
  message: Field | null;
  property: Field | null;
  listingId: Field | null;
  /** from an explicit type label only */
  labelType: LeadType | null;
  /** keys whose label appeared (valid value or not) */
  seen: Set<FieldKey>;
}

export function splitLines(text: string): Line[] {
  const lines: Line[] = [];
  let s = 0;
  for (;;) {
    const e = text.indexOf('\n', s);
    if (e < 0) {
      lines.push({ start: s, end: text.length });
      return lines;
    }
    lines.push({ start: s, end: e });
    s = e + 1;
  }
}

const isBlank = (c: number) => c === 32 || c === 9;
const isLabelChar = (c: number) =>
  (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 32 || c === 9 || c === 35 /* # */ || c === 45 /* - */ || c === 46 /* . */;
/** bullets allowed before a label: - * • · (followed by a space or tab) */
const isBullet = (c: number) => c === 45 || c === 42 || c === 0x2022 || c === 0xb7;

/** `Label: value` at a line start (after optional whitespace and a bullet), or null. */
export function labelAt(text: string, line: Line): LabelHit | null {
  let p = line.start;
  const end = line.end;
  while (p < end && isBlank(text.charCodeAt(p))) p++;
  if (p + 1 < end && isBullet(text.charCodeAt(p)) && isBlank(text.charCodeAt(p + 1))) {
    p += 2;
    while (p < end && isBlank(text.charCodeAt(p))) p++;
  }
  const ls = p;
  let colon = -1;
  for (let q = p; q < end && q <= ls + MAX_LABEL; q++) {
    const c = text.charCodeAt(q);
    if (c === 58 /* : */) {
      colon = q;
      break;
    }
    if (!isLabelChar(c)) return null;
  }
  if (colon <= ls) return null;
  const label = text.slice(ls, colon).toLowerCase().replace(/\s+/g, ' ').trim();
  if (label === '') return null;
  let vs = colon + 1;
  while (vs < end && isBlank(text.charCodeAt(vs))) vs++;
  let ve = end;
  while (ve > vs && isBlank(text.charCodeAt(ve - 1))) ve--;
  return { label, valueStart: vs, valueEnd: ve };
}

/** The first non-blank..last non-blank range of a line, or null when blank. */
function contentOf(text: string, line: Line): Line | null {
  let s = line.start;
  let e = line.end;
  while (s < e && /\s/.test(text.charAt(s))) s++;
  while (e > s && /\s/.test(text.charAt(e - 1))) e--;
  return s < e ? { start: s, end: e } : null;
}

/** The lead type named by a type label's value; null when it names none. */
export function labelLeadType(value: string): LeadType | null {
  return earliestType(value, LABEL_TYPE_KEYWORDS);
}

export function earliestType(s: string, keywords: ReadonlyArray<readonly [Exclude<LeadType, 'general'>, RegExp]>): LeadType | null {
  let best: LeadType | null = null;
  let at = Infinity;
  for (const [type, re] of keywords) {
    const i = s.search(re);
    if (i >= 0 && i < at) {
      at = i;
      best = type;
    }
  }
  return best;
}

/** An address is never the portal's or the trusted sender's own. */
export function isOwnAddress(email: string, senderDomain: string): boolean {
  const d = emailDomain(email);
  return isDomainOrSub(d, senderDomain) || PORTAL_DOMAINS.some((p) => isDomainOrSub(d, p));
}

export function extract(text: string, lines: readonly Line[], labels: LabelTable, senderDomain: string): Extraction {
  const ex: Extraction = { name: null, phones: [], emails: [], message: null, property: null, listingId: null, labelType: null, seen: new Set() };
  const phoneKeys = new Set<string>();
  const emailKeys = new Set<string>();
  const keyOf = (line: Line): { hit: LabelHit; key: FieldKey } | null => {
    const hit = labelAt(text, line);
    const key = hit ? labels.get(hit.label) : undefined;
    return hit && key ? { hit, key } : null;
  };

  for (let idx = 0; idx < lines.length; idx++) {
    const line = lines[idx]!;
    const found = keyOf(line);
    if (!found) continue;
    const { hit, key } = found;
    ex.seen.add(key);
    const span = { start: hit.valueStart, end: hit.valueEnd };
    const raw = text.slice(span.start, span.end);

    switch (key) {
      case 'name': {
        if (ex.name || raw === '') break;
        const value = cleanField(raw, MAX_NAME);
        if (isPlausibleName(raw, value)) ex.name = { value, span };
        break;
      }
      case 'email': {
        // validated on the raw text: an address carrying control, bidi or separator characters is rejected
        if (ex.emails.length >= MAX_POINTS || !isValidEmail(raw)) break;
        const value = raw.toLowerCase();
        if (isOwnAddress(value, senderDomain) || emailKeys.has(value)) break;
        emailKeys.add(value);
        ex.emails.push({ value, span });
        break;
      }
      case 'phone': {
        if (ex.phones.length >= MAX_POINTS || raw.length > MAX_PHONE) break;
        const value = cleanField(raw, MAX_PHONE);
        const digits = phoneDigits(value);
        if (digits === null || phoneKeys.has(digits)) break;
        phoneKeys.add(digits);
        ex.phones.push({ value, span });
        break;
      }
      case 'message': {
        if (ex.message) break;
        // the value may continue on the following lines, until a blank line or the next known label
        let start = raw === '' ? -1 : span.start;
        let end = raw === '' ? -1 : span.end;
        let j = idx + 1;
        for (; j < lines.length; j++) {
          const next = lines[j]!;
          const content = contentOf(text, next);
          if (!content || keyOf(next)) break;
          if (start < 0) start = content.start;
          end = content.end;
        }
        idx = j - 1;
        if (start < 0) break;
        const value = cleanField(text.slice(start, end), MAX_MESSAGE);
        if (value !== '') ex.message = { value, span: { start, end } };
        break;
      }
      case 'property': {
        if (ex.property) break;
        const value = cleanField(raw, MAX_PROPERTY);
        if (value !== '') ex.property = { value, span };
        break;
      }
      case 'listingId': {
        if (ex.listingId) break;
        let s = span.start;
        while (s < span.end && (text.charCodeAt(s) === 35 /* # */ || isBlank(text.charCodeAt(s)))) s++;
        const id = text.slice(s, span.end);
        if (id.length <= MAX_LISTING_ID && isValidListingId(id)) ex.listingId = { value: id, span: { start: s, end: span.end } };
        break;
      }
      case 'leadType': {
        if (ex.labelType) break;
        ex.labelType = labelLeadType(cleanField(raw, 200));
        break;
      }
    }
  }
  return ex;
}
