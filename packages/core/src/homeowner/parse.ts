// The strict homeowner-record parser (R-HOME-5; E580, E581). It mirrors module 50's parsePublicRecord
// (apps/api/src/predict/provider.ts): the record is built field by field from an untrusted payload, so a datum the
// closed field list cannot hold (age, phone, email, lender, recorded instruments, other owners' addresses, ...) never
// passes, even if a source sends it. Values sit in the payload's `homeowner` block (module 50's property parser
// ignores that block, and this parser ignores the property keys); each is bare or { value, source, asOf }. A value
// without a valid source label (its own or the record's) is dropped, as is a malformed value.
import { SOURCE_RE, REF_RE, type HomeownerFact, type HomeownerFacts, type HomeownerField, type HomeownerLookup, type PostalAddress } from './types.js';

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
// C0/C1 controls and the bidirectional formatting characters (a spoofed owner or address must not reorder text)
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩]/;
export const MAX_OWNERS = 10;

/** A trimmed, capped string with no control or bidi character, else null. */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t !== '' && t.length <= max && !UNSAFE.test(t) ? t : null;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
/** YYYY-MM-DD, a real calendar date, from 1800-01-01 to today + 1 day. */
export function cleanDate(v: unknown, today: string): string | null {
  if (typeof v !== 'string') return null;
  const m = DATE_RE.exec(v);
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (Number.isNaN(t) || new Date(t).toISOString().slice(0, 10) !== v) return null;
  if (Number(m[1]) < 1800) return null;
  const max = Date.parse(`${today}T00:00:00Z`) + 86_400_000;
  return t <= max ? v : null;
}

const cents = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
const taxYear = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v >= 1900 && v <= 2200 ? v : null);
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const source = (v: unknown): string | null => (typeof v === 'string' && SOURCE_RE.test(v) ? v : null);

function address(v: unknown): PostalAddress | null {
  if (!isObj(v)) return null;
  const line1 = cleanText(v.line1, 200);
  const city = cleanText(v.city, 100);
  const region = cleanText(v.region, 50);
  const postalCode = cleanText(v.postalCode, 20);
  if (line1 === null || city === null || region === null || postalCode === null) return null;
  return { line1, line2: cleanText(v.line2, 100), city, region, postalCode };
}

/**
 * The source payload cut down to the homeowner fields. No usable address, or `available: false`, is "not
 * available" (`detail: 'ambiguous'` passes through; anything else is `no_record`).
 */
export function parseHomeownerRecord(raw: unknown, opts: { today: string }): HomeownerLookup {
  if (!isObj(raw) || raw.available === false) {
    return { status: 'not_available', detail: isObj(raw) && raw.detail === 'ambiguous' ? 'ambiguous' : 'no_record' };
  }
  const a = address(raw.address);
  if (a === null) return { status: 'not_available', detail: 'no_record' };
  const ownerNames = Array.isArray(raw.ownerNames)
    ? raw.ownerNames.slice(0, MAX_OWNERS).map((n) => cleanText(n, 200)).filter((n): n is string => n !== null)
    : [];
  const recordSource = source(raw.source);
  const recordAsOf = cleanDate(raw.asOf, opts.today);
  const block = isObj(raw.homeowner) ? raw.homeowner : {};
  const facts: HomeownerFacts = {};
  const take = <F extends HomeownerField>(f: F, check: (v: unknown) => HomeownerFact<F>['value'] | null) => {
    const x = block[f];
    const wrapped = isObj(x) && 'value' in x;
    const v = check(wrapped ? x.value : x);
    if (v === null) return;
    const src = (wrapped ? source(x.source) : null) ?? recordSource;
    if (src === null) return; // a value whose source cannot be shown is not kept
    const asOf = (wrapped ? cleanDate(x.asOf, opts.today) : null) ?? recordAsOf;
    (facts as Record<string, HomeownerFact>)[f] = { value: v, source: src, asOf } as HomeownerFact;
  };
  take('last_transfer_date', (v) => cleanDate(v, opts.today));
  take('last_transfer_price_cents', cents);
  take('county_market_value_cents', cents);
  take('assessed_value_cents', cents);
  take('annual_tax_cents', cents);
  take('tax_year', taxYear);
  take('exemption_legal_residence', bool);
  take('exemption_homestead', bool);
  take('owner_mailing_address', (v) => cleanText(v, 300));
  const providerRef = typeof raw.providerRef === 'string' && REF_RE.test(raw.providerRef) ? raw.providerRef : null;
  return { status: 'found', record: { address: a, ownerNames, providerRef, recordAsOf, source: recordSource, facts } };
}
