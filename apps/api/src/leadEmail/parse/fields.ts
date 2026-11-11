// Field cleaning and syntactic validation of lead-email values (pure).
import { MAX_EMAIL, MAX_PHONE } from './limits.js';

/* eslint-disable no-control-regex -- these patterns exist to find and remove control characters */
/** line/paragraph separators and other breaks: become a space */
const BREAKS = /[\r\n\t\v\f\u0085\u2028\u2029]/g;
/** C0/C1 controls, bidi embeddings/overrides/isolates and bidi marks: removed */
const INVISIBLE = /[\u0000-\u001F\u007F-\u009F\u202A-\u202E\u2066-\u2069\u200E\u200F\u061C]/g;
/** C0 (except \t \n) and C1 controls, DEL: removed from the normalized body */
export const BODY_CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;
/* eslint-enable no-control-regex */
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/**
 * Strips CR, LF, other C0/C1 controls, U+2028/2029, bidi overrides (U+202A-202E, U+2066-2069) and bidi
 * marks, removes lone surrogates, collapses whitespace, trims and caps the length (never splitting a
 * surrogate pair).
 */
export function cleanField(s: string, max: number): string {
  if (typeof s !== 'string') return '';
  const cap = typeof max === 'number' && Number.isFinite(max) ? Math.max(0, Math.floor(max)) : 0;
  if (cap === 0) return '';
  let out = s.replace(BREAKS, ' ').replace(INVISIBLE, '').replace(LONE_SURROGATE, '').replace(/\s+/g, ' ').trim();
  if (out.length > cap) {
    out = out.slice(0, cap);
    const last = out.charCodeAt(out.length - 1);
    if (last >= 0xd800 && last <= 0xdbff) out = out.slice(0, -1);
    out = out.trimEnd();
  }
  return out;
}

// One simple syntactic check: local@domain.tld, ASCII only, no spaces, quotes, angle brackets, commas,
// semicolons or CR/LF (none of those are in the character classes).
const EMAIL_RE = /^[A-Za-z0-9.!#$%&*+/=?^_`{|}~-]{1,64}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

export function isValidEmail(s: string): boolean {
  return typeof s === 'string' && s.length >= 6 && s.length <= MAX_EMAIL && EMAIL_RE.test(s);
}

/** The domain part of a (valid) address, lowercased. */
export function emailDomain(email: string): string {
  return email.slice(email.lastIndexOf('@') + 1).toLowerCase();
}

/** `d` is `base` or a subdomain of it. */
export function isDomainOrSub(d: string, base: string): boolean {
  return base !== '' && (d === base || d.endsWith('.' + base));
}

/**
 * The digits of a phone number as written, or null. Accepts only digits and spaces ( ) . - with an
 * optional leading +; 10–15 digits after an optional leading country code 1 (11 digits starting with 1).
 * Anything with letters (or any other character) is rejected.
 */
export function phoneDigits(v: string): string | null {
  if (typeof v !== 'string' || v.length > MAX_PHONE) return null;
  if (!/^\+?[0-9 ().-]+$/.test(v)) return null;
  let d = v.replace(/[^0-9]/g, '');
  if (d.length === 11 && d.startsWith('1')) d = d.slice(1);
  return d.length >= 10 && d.length <= 15 ? d : null;
}

/** A plausible person name: a letter, no '@' '<' '>' (address smuggling / header injection). */
export function isPlausibleName(raw: string, cleaned: string): boolean {
  return cleaned !== '' && /\p{L}/u.test(cleaned) && !/[@<>]/.test(raw);
}

const LISTING_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
export const isValidListingId = (s: string): boolean => LISTING_ID_RE.test(s);

/** The last US 5-digit ZIP (ZIP+4 allowed; the 5-digit part is returned) in `s`, or null. */
export function findZip(s: string): string | null {
  let found: string | null = null;
  for (const m of s.matchAll(/(?<![0-9])([0-9]{5})(?:-[0-9]{4})?(?![0-9])/g)) found = m[1] ?? found;
  return found;
}
