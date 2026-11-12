// The public-records adapter of module 50 (PHASE2_3_PLAN §5.4 "49. core/predict and 50. api/predict"; R-PRED-2,
// R-INT-1, N13).
//
// Public records are PLATFORM configuration, never an integration_connections row (R-INT-1): no tenant connects a
// source, and the adapter receives no tenant context. The interface is SOURCE-NEUTRAL (owner decision of 2026-11-12,
// to be recorded as D10: records come from public county data, the assessor and the register of deeds, through
// connectors a later lane builds): no source-specific name, id or field appears here, and one record shape can be
// filled by a county connector or any provider, with each value's source and as-of date (`provenance`). A later
// homeowner-profile lane extends this record type on the same interface; there is no second records adapter. This
// build ships the interface, a deterministic fake for dev and tests, and an unconfigured stand-in for production
// that looks nothing up and reports "not set up on this platform"; property features are then absent and
// first-party features alone score.
//
// Input: ONE explicit postal address. Never the contact's name, phone, email or any other contact datum.
// Output: "not available", or one candidate: the address on the record and the owner names on title (both used
// only in memory by core attachPropertyRecord, never stored, hashed or logged), the four property facts core
// reads, each value's source and as-of date, and the source's record reference. `parsePublicRecord` builds the
// candidate field by field from an untrusted payload, so no person-level datum (age, marital status, phone, lender,
// other owners' addresses, ...) can pass even if a source sends one (R-PRED-2).
//
// VERIFY with each data source (N13; county connectors per D10): field names and formats (owner names, co-owners,
// trusts, permits), whether "not available" can be told apart from a failure, licence and caching terms, refresh
// frequency, cost, rate limits.
// The homeowner-profile lane (D10) adds `lookupHomeowner` on this same interface (the closed field list of core/homeowner, each value with its source and as-of date); module 50 never calls it (R-PRED-2).
import { parseHomeownerRecord, type HomeownerLookup } from '@realty/core/homeowner';
import { normalizeAddress, type PostalAddress, type PropertyRecordCandidate } from '@realty/core/predict';
import { ProviderError } from '../providers/types.js';

/** The facts core derives features from (derivePropertyFeatures); nothing else is kept. */
export interface PublicRecordFacts {
  /** YYYY-MM-DD */
  lastSaleDate: string | null;
  lastSalePriceCents: number | null;
  assessedValueCents: number | null;
  recentPermit: boolean | null;
}

/** Where one value came from: a source label (e.g. a county office or a provider, never a person) and its as-of date. */
export interface FactProvenance {
  source: string;
  /** YYYY-MM-DD */
  asOf: string | null;
}

export type PublicRecordCandidate = PropertyRecordCandidate & {
  facts: PublicRecordFacts;
  /** per present value: its source and as-of date (not stored by module 50; kept for the homeowner-profile lane) */
  provenance: Partial<Record<keyof PublicRecordFacts, FactProvenance>>;
  /** the source's own record reference */
  providerRef: string | null;
};

export type PublicRecordLookup = { status: 'not_available' } | { status: 'found'; candidate: PublicRecordCandidate };

export interface PublicRecordsProvider {
  /** false in production until a vendor is procured (N13): the pass then makes no lookup at all */
  readonly configured: boolean;
  /** shown wherever the platform reports the adapter's state */
  readonly statusText: string;
  /**
   * true only for the deterministic fake (dev, tests, a staging demo with ALLOW_FAKE_PROVIDERS): it is configured, so
   * without this flag its answers read as county findings. The homeowner panel then shows `statusText` on every home
   * (b11 api-ui/F5), as module 42's scanner and extractor do.
   */
  readonly test: boolean;
  /** One address; no tenant context, no contact data. Throws ProviderError on a failure. */
  lookup(address: PostalAddress): Promise<PublicRecordLookup>;
  /** D10: one address; the homeowner record (core/homeowner's closed field list). Throws ProviderError on a failure. */
  lookupHomeowner(address: PostalAddress): Promise<HomeownerLookup>;
}

export const PUBLIC_RECORDS_NOT_SET_UP = 'Public records are not set up on this platform';
/** The fake's status (b11 api-ui/F5): shown on every home of the homeowner panel while the fake answers. */
export const PUBLIC_RECORDS_TEST_TEXT = 'This deployment uses test public records: no county was asked, and these answers are test data.';

/** Production without ALLOW_FAKE_PROVIDERS: looks nothing up (R-INT-1, N13). */
export class UnconfiguredPublicRecords implements PublicRecordsProvider {
  readonly configured = false;
  readonly test = false;
  readonly statusText = PUBLIC_RECORDS_NOT_SET_UP;
  async lookup(): Promise<never> {
    throw new ProviderError('not_configured', 'PUBLIC_RECORDS_NOT_CONFIGURED');
  }
  async lookupHomeowner(): Promise<never> {
    throw new ProviderError('not_configured', 'PUBLIC_RECORDS_NOT_CONFIGURED');
  }
}

// ---- the strict parser -----------------------------------------------------------------------------------

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown, max: number): string | null => (typeof v === 'string' && v.trim() !== '' && v.length <= max ? v : null);
const cents = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const date = (v: unknown): string | null => (typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) ? v : null);
const REF_RE = /^[A-Za-z0-9._:-]{1,120}$/;
const SOURCE_RE = /^[A-Za-z0-9 .,:()_-]{1,80}$/;
const sourceLabel = (v: unknown): string | null => (typeof v === 'string' && SOURCE_RE.test(v) ? v : null);

function address(v: unknown): PostalAddress | null {
  if (!isObj(v)) return null;
  const line1 = str(v.line1, 200);
  const city = str(v.city, 100);
  const region = str(v.region, 50);
  const postalCode = str(v.postalCode, 20);
  if (line1 === null || city === null || region === null || postalCode === null) return null;
  return { line1, line2: str(v.line2, 100), city, region, postalCode };
}

/**
 * The source payload, cut down to the fields core reads. Every other field is dropped; a malformed fact becomes
 * null (no feature derives from it); a payload without a usable address or with `available: false` is "not
 * available". Owner names are kept only as strings for the in-memory attach decision.
 */
export function parsePublicRecord(raw: unknown): PublicRecordLookup {
  if (!isObj(raw) || raw.available === false) return { status: 'not_available' };
  const a = address(raw.address);
  if (a === null) return { status: 'not_available' };
  const owners = Array.isArray(raw.ownerNames) ? raw.ownerNames.map((n) => str(n, 200)).filter((n): n is string => n !== null).slice(0, 10) : [];
  const defaultSource = sourceLabel(raw.source);
  const defaultAsOf = date(raw.asOf);
  const facts: PublicRecordFacts = { lastSaleDate: null, lastSalePriceCents: null, assessedValueCents: null, recentPermit: null };
  const provenance: PublicRecordCandidate['provenance'] = {};
  const take = <K extends keyof PublicRecordFacts>(k: K, check: (v: unknown) => PublicRecordFacts[K]) => {
    // a value is either bare or { value, source, asOf }
    const f = raw[k];
    const wrapped = isObj(f) && 'value' in f;
    const v = check(wrapped ? f.value : f);
    if (v === null) return;
    facts[k] = v;
    const source = wrapped ? (sourceLabel(f.source) ?? defaultSource) : defaultSource;
    if (source !== null) provenance[k] = { source, asOf: (wrapped ? date(f.asOf) : null) ?? defaultAsOf };
  };
  take('lastSaleDate', date);
  take('lastSalePriceCents', cents);
  take('assessedValueCents', cents);
  take('recentPermit', (v) => (typeof v === 'boolean' ? v : null));
  const ref = typeof raw.providerRef === 'string' && REF_RE.test(raw.providerRef) ? raw.providerRef : null;
  return { status: 'found', candidate: { address: a, ownerNames: owners, facts, provenance, providerRef: ref } };
}

// ---- the deterministic fake ------------------------------------------------------------------------------

/**
 * Deterministic in-memory public records keyed by the normalized address. Tests put SYNTHETIC source payloads in
 * (`put`), and the fake runs every answer through `parsePublicRecord`, as a real adapter would. `calls` records
 * each looked-up address (normalized), so tests can prove what was and was not asked. Nothing leaves the process.
 */
export class FakePublicRecords implements PublicRecordsProvider {
  readonly configured = true;
  readonly test = true;
  readonly statusText = PUBLIC_RECORDS_TEST_TEXT;
  readonly calls: string[] = [];
  readonly #records = new Map<string, unknown>();
  /** test hook: runs before an answer is returned (a throw is a provider failure or a crash mid-lookup) */
  beforeAnswer: ((normalized: string) => void | Promise<void>) | null = null;

  /** A synthetic source payload for an address (any shape: the parser decides what survives). */
  put(address: PostalAddress, payload: unknown): void {
    const k = normalizeAddress(address);
    if (k === null) throw new Error('FakePublicRecords.put: the address does not normalize');
    this.#records.set(k, payload);
  }

  async lookup(a: PostalAddress): Promise<PublicRecordLookup> {
    // the adapter receives exactly a PostalAddress: anything else on the argument is a caller bug
    const extra = Object.keys(a).filter((k) => !['line1', 'line2', 'city', 'region', 'postalCode'].includes(k));
    if (extra.length > 0) throw new Error(`FakePublicRecords.lookup: only an address may be sent (got ${extra.join(', ')})`);
    const k = normalizeAddress(a);
    if (k === null) throw new ProviderError('rejected', 'ADDRESS_INVALID');
    this.calls.push(k);
    if (this.beforeAnswer) await this.beforeAnswer(k);
    return this.#records.has(k) ? parsePublicRecord(this.#records.get(k)) : { status: 'not_available' };
  }

  /** D10: each homeowner lookup's address (normalized; nothing else is recorded) */
  readonly homeownerCalls: string[] = [];
  /** the date the parser bounds dates by (tests set it) */
  today: () => string = () => new Date().toISOString().slice(0, 10);

  async lookupHomeowner(a: PostalAddress): Promise<HomeownerLookup> {
    const extra = Object.keys(a).filter((k) => !['line1', 'line2', 'city', 'region', 'postalCode'].includes(k));
    if (extra.length > 0) throw new Error(`FakePublicRecords.lookupHomeowner: only an address may be sent (got ${extra.join(', ')})`);
    const k = normalizeAddress(a);
    if (k === null) throw new ProviderError('rejected', 'ADDRESS_INVALID');
    this.homeownerCalls.push(k);
    if (this.beforeAnswer) await this.beforeAnswer(k);
    return this.#records.has(k) ? parseHomeownerRecord(this.#records.get(k), { today: this.today() }) : { status: 'not_available', detail: 'no_record' };
  }
}
