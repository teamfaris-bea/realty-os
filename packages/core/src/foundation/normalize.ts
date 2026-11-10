// Phone and email normalization (BUILD_PLAN module 1). These are the canonical forms used for
// dedup (R-OWN-25), consent keys (the HMAC input of R-CONSENT-1) and import validation (E45).
//
// Phones: E.164 via libphonenumber-js with full ("max") metadata so validity is checked against
// real numbering plans, not only length. US is the default country for numbers without a `+`.
// Short codes, N11 service numbers, 7-digit numbers without an area code and vanity (letter)
// numbers are rejected. An extension ("x123", "ext. 123", ";ext=123") is not part of E.164: it is
// stripped from `e164` and returned separately.
import { parsePhoneNumberWithError } from 'libphonenumber-js/max';

export type NormalizeErrorCode = 'PHONE_INVALID' | 'EMAIL_INVALID';

export type PhoneResult = { ok: true; e164: string; extension?: string } | { ok: false; code: 'PHONE_INVALID' };
export type EmailResult = { ok: true; email: string } | { ok: false; code: 'EMAIL_INVALID' };

const PHONE_INVALID = { ok: false, code: 'PHONE_INVALID' } as const;
const EMAIL_INVALID = { ok: false, code: 'EMAIL_INVALID' } as const;

/** Longest raw phone string worth parsing (formatting, an extension and a tel: prefix included). */
const MAX_PHONE_INPUT = 64;

export function normalizePhone(raw: string, defaultCountry: 'US'): PhoneResult {
  if (typeof raw !== 'string') return PHONE_INVALID;
  const input = raw.normalize('NFKC').trim();
  if (input === '' || input.length > MAX_PHONE_INPUT) return PHONE_INVALID;
  // Vanity numbers (1-800-FLOWERS) are not accepted: letters other than an extension marker or a
  // tel: scheme mean the input is not a plain number.
  const lettersRemoved = input.replace(/^tel:/i, '').replace(/(?:;\s*ext=|\s*(?:ext\.?|extension|x|#)\s*)\d+\s*$/i, '');
  if (/\p{L}/u.test(lettersRemoved)) return PHONE_INVALID;
  try {
    const parsed = parsePhoneNumberWithError(input, defaultCountry);
    if (!parsed.isValid()) return PHONE_INVALID;
    const e164 = parsed.number; // libphonenumber guarantees E.164 for a valid number
    return parsed.ext ? { ok: true, e164, extension: parsed.ext } : { ok: true, e164 };
  } catch {
    return PHONE_INVALID;
  }
}

// Emails: trimmed, NFC, lower-cased (Postgres stores them as citext; providers treat local parts
// case-insensitively in practice). A leading `mailto:` and surrounding angle brackets are removed.
// Quoted local parts, IP-literal domains, display names and comments are rejected: they are not
// addresses we can safely send to or dedup on. Provider-specific rewriting (Gmail dots, +tags) is
// deliberately NOT done: it would merge different people on other providers.
const LOCAL_ATOM = "[\\p{L}\\p{N}!#$%&'*+/=?^_`{|}~-]+";
const LOCAL_RE = new RegExp(`^${LOCAL_ATOM}(?:\\.${LOCAL_ATOM})*$`, 'u');
const LABEL_RE = /^(?!-)[\p{L}\p{N}-]{1,63}(?<!-)$/u;
const TLD_RE = /^(?:\p{L}{2,63}|xn--[a-z0-9-]{1,59})$/u;

export function normalizeEmail(raw: string): EmailResult {
  if (typeof raw !== 'string') return EMAIL_INVALID;
  let s = raw.normalize('NFC').trim();
  s = s.replace(/^mailto:/i, '');
  if (s.startsWith('<') && s.endsWith('>')) s = s.slice(1, -1).trim();
  s = s.toLowerCase();
  if (s.length === 0 || s.length > 254) return EMAIL_INVALID;
  const at = s.indexOf('@');
  if (at <= 0 || at !== s.lastIndexOf('@')) return EMAIL_INVALID;
  const local = s.slice(0, at);
  const domain = s.slice(at + 1);
  if (local.length > 64 || !LOCAL_RE.test(local)) return EMAIL_INVALID;
  if (domain.length === 0 || domain.length > 253) return EMAIL_INVALID;
  const labels = domain.split('.');
  if (labels.length < 2) return EMAIL_INVALID;
  if (!labels.every((l) => LABEL_RE.test(l))) return EMAIL_INVALID;
  if (!TLD_RE.test(labels[labels.length - 1] as string)) return EMAIL_INVALID;
  return { ok: true, email: s };
}
