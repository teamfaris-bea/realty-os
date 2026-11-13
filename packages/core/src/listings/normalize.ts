// RESO record → our listing facts (PHASE2_3_PLAN module 23; R-MLS-1 shape, R-MLS-2 display flags).
//
// - Never throws for feed data: every problem becomes an `Issue` and the sync skips the record
//   (module 24 logs the issues). All issues of a record are reported at once.
// - R-MLS-1: an mls row needs its connection (from the mapping), its modification time
//   (ModificationTimestamp, ISO with an offset) and its listing brokerage (ListOfficeName). The
//   monotonic check (an older modification never overwrites a newer one) is `isNewerModification`
//   and the DB trigger `listings_mls_monotonic`.
// - R-MLS-2: display flags are true only when the feed says yes explicitly. A missing or unreadable
//   InternetEntireListingDisplayYN / InternetAddressDisplayYN is "not allowed".
// - Money is integer cents parsed from the decimal text, never through float arithmetic.
// - Status: the RESO StandardStatus vocabulary maps onto our statuses; an unknown value is an issue,
//   never a guess. Hold / Delete / Incomplete are deliberately unmapped (VERIFY WITH MLS: how each
//   MLS uses them); a mapping may map them.
// - Column bounds (F3): every value is checked here against its listings column's CHECK and type bound before it
//   is returned. beds / baths_x10 (smallint) and sqft (integer) out of bound are MLS_FIELD_INVALID like any
//   invalid count. Dates must be real calendar dates (year, month and day round-trip), never just the prefix.
// - Sale and property facts (R-CMA-1, `valuation`): never block a record. An invalid or out-of-bound value is
//   null and its RESO name is listed in `valuation.unreadable`. Lot size is whole square feet (LotSizeSquareFeet,
//   else LotSizeAcres × 43,560, else LotSizeArea with LotSizeUnits; a disagreement over 1 % keeps the first and
//   names the others). Coordinates are integer microdegrees from signed decimal text or numbers; a lone or
//   invalid coordinate, or (0,0), nulls both (VERIFY WITH MLS: whether the feed uses 0,0 for "unknown").
//   SubdivisionName placeholders ("None", "N/A", "0", …) are null. A PropertyType of Residential Lease or
//   Commercial Lease (or a mapping's `leasePropertyTypes`) sets isLease: a lease is never a sale (VERIFY WITH MLS:
//   the Lookup values). InternetAutomatedValuationDisplayYN is true only for an explicit yes; PoolPrivateYN is
//   tri-state.
// - Size (R-MLS-7): sqft is finished living area, read from exactly one field, the mapping's size field (RESO default
//   LivingArea). A mapping with `sqft: null` (an MLS whose finished-living-area field is not confirmed: Spark) reads no
//   size, and a field of SIZE_FIELDS_NEVER_USED (BuildingAreaTotal: total building area; unfinished or below-grade area
//   alone) is never read, whatever the mapping says. Fields are never added together and never stand in for each other.
//   A size of 0 is unknown (null, with no source and no issue): many feeds send 0 for "not entered".
//   PostalCode is stored as sent: a ZIP+4 is not folded and not inferred (VERIFY WITH MLS).
import { type Instant, instantFromIso } from '../foundation/index.js';
import { PROPERTY_TYPES } from '../assistant/index.js';
import { SALE_CONDITIONS, type FactField, type FieldMapping, type Issue, type ListingFacts, type ListingStatus, type PropertyType, type ResoLike, type SaleCondition, type ValuationFacts } from './types.js';

/** RESO Data Dictionary field names read by default. */
export const RESO_DEFAULT_FIELDS: Readonly<Record<FactField, string>> = Object.freeze({
  listingKey: 'ListingKey',
  mlsNumber: 'ListingId',
  status: 'StandardStatus',
  listPrice: 'ListPrice',
  beds: 'BedroomsTotal',
  baths: 'BathroomsTotalInteger',
  sqft: 'LivingArea',
  unparsedAddress: 'UnparsedAddress',
  streetNumber: 'StreetNumber',
  streetDirPrefix: 'StreetDirPrefix',
  streetName: 'StreetName',
  streetSuffix: 'StreetSuffix',
  streetDirSuffix: 'StreetDirSuffix',
  unitNumber: 'UnitNumber',
  city: 'City',
  region: 'StateOrProvince',
  postalCode: 'PostalCode',
  propertyType: 'PropertyType',
  propertySubType: 'PropertySubType',
  description: 'PublicRemarks',
  listDate: 'ListingContractDate',
  modifiedAt: 'ModificationTimestamp',
  listingBrokerageName: 'ListOfficeName',
  internetDisplay: 'InternetEntireListingDisplayYN',
  addressDisplay: 'InternetAddressDisplayYN',
  photosCount: 'PhotosCount',
  media: 'Media',
  closePrice: 'ClosePrice',
  closeDate: 'CloseDate',
  contractDate: 'PurchaseContractDate',
  originalListPrice: 'OriginalListPrice',
  concessions: 'ConcessionsAmount',
  saleConditions: 'SpecialListingConditions',
  daysOnMarket: 'DaysOnMarket',
  latitude: 'Latitude',
  longitude: 'Longitude',
  yearBuilt: 'YearBuilt',
  lotSizeArea: 'LotSizeArea',
  lotSizeUnits: 'LotSizeUnits',
  lotSizeAcres: 'LotSizeAcres',
  lotSizeSquareFeet: 'LotSizeSquareFeet',
  subdivisionName: 'SubdivisionName',
  garageSpaces: 'GarageSpaces',
  poolPrivate: 'PoolPrivateYN',
  stories: 'Stories',
  avmDisplay: 'InternetAutomatedValuationDisplayYN',
});

/**
 * RESO area fields that are never finished living area (R-MLS-7), so never a size: BuildingAreaTotal is the total
 * building area (finished and unfinished), and unfinished or below-grade area alone is not living area either. A
 * mapping that names one reads no size; the database refuses them as listings.size_source (the 0082 size migration).
 * Compared in any letter case. This list is the only place code may name BuildingAreaTotal (an architecture test).
 */
export const SIZE_FIELDS_NEVER_USED: readonly string[] = Object.freeze(['BuildingAreaTotal', 'AboveGradeUnfinishedArea', 'BelowGradeFinishedArea', 'BelowGradeUnfinishedArea']);

/**
 * The RESO field the size (finished living area) is read from under a mapping, or null when none is: the mapping says
 * `sqft: null` (no confirmed field) or names a field of SIZE_FIELDS_NEVER_USED (R-MLS-7). Default: LivingArea.
 */
export function sizeFieldOf(mapping: Pick<FieldMapping, 'fields'>): string | null {
  const mapped = mapping.fields?.sqft;
  if (mapped === null) return null;
  const field = mapped ?? RESO_DEFAULT_FIELDS.sqft;
  const key = field.toLowerCase();
  return SIZE_FIELDS_NEVER_USED.some((f) => f.toLowerCase() === key) ? null : field;
}

/** The RESO field name of each of our fields under a mapping (sqft: the size field, or the default when none is read). */
function fieldNames(mapping: Pick<FieldMapping, 'fields'>): Record<FactField, string> {
  const { sqft, ...rest } = mapping.fields ?? {};
  return { ...RESO_DEFAULT_FIELDS, ...rest, sqft: sizeFieldOf(mapping) ?? sqft ?? RESO_DEFAULT_FIELDS.sqft };
}

/** RESO SpecialListingConditions → ours (vocabulary keys). Unknown ⇒ 'other'. VERIFY WITH MLS: the Lookup values. */
export const RESO_SALE_CONDITION_MAP: Readonly<Record<string, SaleCondition>> = Object.freeze({
  standard: 'standard',
  shortsale: 'short_sale',
  realestateowned: 'reo',
  reo: 'reo',
  bankowned: 'reo',
  auction: 'auction',
  probatelisting: 'probate',
  probate: 'probate',
});

/** SubdivisionName values that mean "not in a subdivision" (keys: letters and digits only). VERIFY WITH MLS. */
export const SUBDIVISION_PLACEHOLDERS: readonly string[] = Object.freeze(['none', 'na', 'notapplicable', 'notinasubdivision', 'nosubdivision', 'unknown', 'other', '0']);

/** PropertyType values that are leases (vocabulary keys). VERIFY WITH MLS: the Lookup values. */
export const LEASE_PROPERTY_TYPES: readonly string[] = Object.freeze(['residentiallease', 'commerciallease']);

/** Column bounds (F3): smallint, integer and the JS safe integer (inside bigint). */
export const SMALLINT_MAX = 32_767;
export const INTEGER_MAX = 2_147_483_647;
const SQFT_PER_ACRE = 43_560;
const SQFT_PER_SQM = 10.7639;
const LOT_UNITS: Readonly<Record<string, number>> = Object.freeze({
  acres: SQFT_PER_ACRE,
  acre: SQFT_PER_ACRE,
  ac: SQFT_PER_ACRE,
  squarefeet: 1,
  squarefoot: 1,
  sqft: 1,
  sf: 1,
  squaremeters: SQFT_PER_SQM,
  squaremetres: SQFT_PER_SQM,
  sqm: SQFT_PER_SQM,
});

/** RESO StandardStatus → ours (keys are vocabulary keys: lower case, no spaces/underscores/hyphens). */
export const RESO_STATUS_MAP: Readonly<Record<string, ListingStatus>> = Object.freeze({
  active: 'active',
  activeundercontract: 'pending',
  pending: 'pending',
  closed: 'sold',
  withdrawn: 'withdrawn',
  canceled: 'withdrawn',
  cancelled: 'withdrawn',
  expired: 'expired',
  comingsoon: 'coming_soon',
});

/** RESO PropertySubType / PropertyType → ours. Unknown ⇒ null (the column is nullable). */
export const RESO_PROPERTY_TYPE_MAP: Readonly<Record<string, PropertyType>> = Object.freeze({
  singlefamilyresidence: 'single_family',
  condominium: 'condo',
  townhouse: 'townhouse',
  duplex: 'multi_family',
  triplex: 'multi_family',
  quadruplex: 'multi_family',
  multifamily: 'multi_family',
  residentialincome: 'multi_family',
  manufacturedhome: 'manufactured',
  manufacturedonland: 'manufactured',
  mobilehome: 'manufactured',
  land: 'land',
  unimprovedland: 'land',
});

/** Vocabulary key: case-, space-, underscore- and hyphen-insensitive. */
function vocabKey(s: string): string {
  return s.normalize('NFKC').toLowerCase().replace(/[\s_-]+/g, '');
}

function vocab<T>(defaults: Readonly<Record<string, T>>, overrides: Readonly<Record<string, T>> | undefined): Map<string, T> {
  const m = new Map<string, T>(Object.entries(defaults));
  for (const [k, v] of Object.entries(overrides ?? {})) m.set(vocabKey(k), v);
  return m;
}

const PRICE_TEXT = /^\$?\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?$/;

/**
 * A price as integer cents: a non-negative number or decimal text with at most two decimals
 * (`$1,299,999.99`). Anything else (negative, exponent, more decimals, NaN) is null.
 */
export function priceToCents(v: unknown): number | null {
  let text: string;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    text = String(v);
  } else if (typeof v === 'string') {
    text = v.trim();
  } else {
    return null;
  }
  const m = PRICE_TEXT.exec(text);
  if (!m) return null;
  const whole = Number((m[1] as string).replaceAll(',', ''));
  const frac = Number((m[2] ?? '').padEnd(2, '0'));
  const cents = whole * 100 + frac;
  return Number.isSafeInteger(cents) ? cents : null;
}

const DECIMAL_TEXT = /^\d+(?:\.\d+)?$/;

/** A non-negative finite number from a number or numeric text. */
function numberOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) && v >= 0 ? v : null;
  if (typeof v === 'string' && DECIMAL_TEXT.test(v.trim())) return Number(v.trim());
  return null;
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === 'string' && v.trim() === '');
}

/** Trimmed text, or null when blank. Numbers become text (feeds send numeric keys). */
function textOf(v: unknown): string | null | undefined {
  if (isBlank(v)) return null;
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined; // present but not text
}

const YES = new Set(['y', 'yes', 'true', '1']);

/** RESO YN flag: true only for an explicit yes. VERIFY WITH MLS: feeds that omit the flag mean "not allowed" here. */
function yes(v: unknown): boolean {
  if (v === true || v === 1) return true;
  return typeof v === 'string' && YES.has(v.trim().toLowerCase());
}

const NO = new Set(['n', 'no', 'false', '0']);

/** RESO YN flag, tri-state: explicit yes ⇒ true, explicit no ⇒ false, anything else ⇒ null. */
export function yesNo(v: unknown): boolean | null {
  if (v === true || v === 1) return true;
  if (v === false || v === 0) return false;
  if (typeof v !== 'string') return null;
  const t = v.trim().toLowerCase();
  return YES.has(t) ? true : NO.has(t) ? false : null;
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})(?:$|T)/;

/** A real calendar date `YYYY-MM-DD` (year 1–9999; month and day round-trip), else null. '2024-02-30' is null. */
export function calendarDate(v: unknown): string | null {
  if (typeof v !== 'string') return null;
  const m = ISO_DATE.exec(v.trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1 || mo < 1 || mo > 12 || d < 1) return null;
  const t = new Date(Date.UTC(2000, mo - 1, d)); // year 2000 is a leap year: only Feb 29 depends on the year
  if (t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
  if (mo === 2 && d === 29 && !(y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0))) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

const SIGNED_DECIMAL = /^([+-]?)(\d{1,3})(?:\.(\d+))?$/;

/**
 * Degrees as integer microdegrees from a signed number or signed decimal text ("-80.1234567" ⇒ -80123457), rounded
 * half away from zero on the decimal digits (no float arithmetic on the fraction), or null. `numberOf` is not used:
 * it rejects negatives, so it would drop every western longitude.
 */
export function microdegrees(v: unknown, bound: number): number | null {
  let text: string;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null;
    text = /e/i.test(String(v)) ? v.toFixed(8) : String(v);
  } else if (typeof v === 'string') {
    text = v.trim();
  } else {
    return null;
  }
  const m = SIGNED_DECIMAL.exec(text);
  if (!m) return null;
  const frac = (m[3] ?? '').padEnd(7, '0');
  let e6 = Number(m[2]) * 1_000_000 + Number(frac.slice(0, 6));
  if (Number(frac[6]) >= 5) e6 += 1;
  const signed = m[1] === '-' ? -e6 : e6;
  return Math.abs(signed) <= bound ? signed + 0 : null; // + 0: never -0
}

const HTTP_URL = /^https?:\/\/\S+$/i;
const PHOTO_CATEGORIES = new Set(['photo', 'photos', 'image', 'images']);

function photoUrls(media: unknown, urlKey: string): string[] {
  if (!Array.isArray(media)) return [];
  const out: { url: string; order: number; index: number }[] = [];
  media.forEach((m: unknown, index) => {
    if (typeof m !== 'object' || m === null) return;
    const rec = m as Record<string, unknown>;
    const url = rec[urlKey];
    const category = rec['MediaCategory'];
    if (typeof category === 'string' && !PHOTO_CATEGORIES.has(category.trim().toLowerCase())) return;
    if (typeof url !== 'string' || !HTTP_URL.test(url.trim())) return;
    const order = typeof rec['Order'] === 'number' && Number.isFinite(rec['Order']) ? rec['Order'] : Number.MAX_SAFE_INTEGER;
    out.push({ url: url.trim(), order, index });
  });
  out.sort((a, b) => a.order - b.order || a.index - b.index);
  return out.map((p) => p.url);
}

/** Placeholder key: letters and digits only ("N/A" ⇒ "na"). */
const placeholderKey = (s: string): string => s.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** The structured address parts of a record (for core addressKey; the api computes listings.address_key). */
export function resoAddressParts(raw: ResoLike, mapping: Pick<FieldMapping, 'fields'>): {
  streetNumber: string | null; streetDirPrefix: string | null; streetName: string | null; streetSuffix: string | null; streetDirSuffix: string | null; unitNumber: string | null; postalCode: string | null;
} {
  const names = fieldNames(mapping);
  const t = (f: FactField): string | null => {
    const v = textOf(raw[names[f]]);
    return typeof v === 'string' ? v : null;
  };
  return { streetNumber: t('streetNumber'), streetDirPrefix: t('streetDirPrefix'), streetName: t('streetName'), streetSuffix: t('streetSuffix'), streetDirSuffix: t('streetDirSuffix'), unitNumber: t('unitNumber'), postalCode: t('postalCode') };
}

/** The sale and property facts of a record (R-CMA-1). Never throws, never blocks: see the header. */
function valuationFacts(read: (f: FactField) => unknown, names: Record<FactField, string>, mapping: FieldMapping, sqftRead: boolean): ValuationFacts {
  const unreadable: string[] = [];
  const bad = (f: FactField): null => {
    unreadable.push(names[f]);
    return null;
  };
  const money = (f: FactField): number | null => {
    const v = read(f);
    if (isBlank(v)) return null;
    return priceToCents(v) ?? bad(f);
  };
  const date = (f: FactField): string | null => {
    const v = read(f);
    if (isBlank(v)) return null;
    return calendarDate(v) ?? bad(f);
  };
  const tenths = (f: FactField): number | null => {
    const v = read(f);
    if (isBlank(v)) return null;
    const n = numberOf(v);
    if (n === null) return bad(f);
    const x = Math.round(n * 10);
    return x <= SMALLINT_MAX ? x : bad(f);
  };
  const flagPresent = (f: FactField): boolean | null => {
    const v = read(f);
    if (isBlank(v)) return null;
    const b = yesNo(v);
    return b === null ? bad(f) : b;
  };

  // days on market: an integer within integer
  let daysOnMarket: number | null = null;
  const rawDom = read('daysOnMarket');
  if (!isBlank(rawDom)) {
    const n = numberOf(rawDom);
    daysOnMarket = n !== null && Number.isInteger(n) && n <= INTEGER_MAX ? n : bad('daysOnMarket');
  }

  // year built: an integer 1600–2100; 0 means unknown
  let yearBuilt: number | null = null;
  const rawYear = read('yearBuilt');
  if (!isBlank(rawYear)) {
    const n = numberOf(rawYear);
    yearBuilt = n !== null && Number.isInteger(n) && n >= 1600 && n <= 2100 ? n : bad('yearBuilt');
  }

  // coordinates: a valid pair or nothing; (0,0) is nothing
  const rawLat = read('latitude');
  const rawLon = read('longitude');
  const lat = isBlank(rawLat) ? null : microdegrees(rawLat, 90_000_000);
  const lon = isBlank(rawLon) ? null : microdegrees(rawLon, 180_000_000);
  let latitudeE6: number | null = null;
  let longitudeE6: number | null = null;
  if (lat !== null && lon !== null && !(lat === 0 && lon === 0)) {
    latitudeE6 = lat;
    longitudeE6 = lon;
  } else {
    if (!isBlank(rawLat)) bad('latitude');
    if (!isBlank(rawLon)) bad('longitude');
  }

  // lot size in whole square feet
  const lotCandidates: { f: FactField; sqft: number }[] = [];
  const lotField = (f: FactField, factor: number): void => {
    const v = read(f);
    if (isBlank(v)) return;
    const n = numberOf(v);
    const sqft = n === null ? null : Math.round(n * factor);
    if (sqft === null || !Number.isSafeInteger(sqft)) bad(f);
    else lotCandidates.push({ f, sqft });
  };
  lotField('lotSizeSquareFeet', 1);
  lotField('lotSizeAcres', SQFT_PER_ACRE);
  const rawArea = read('lotSizeArea');
  if (!isBlank(rawArea)) {
    const units = textOf(read('lotSizeUnits'));
    const factor = typeof units === 'string' ? LOT_UNITS[vocabKey(units).replace(/[^a-z]/g, '')] : undefined;
    if (factor === undefined) bad('lotSizeArea');
    else lotField('lotSizeArea', factor);
  }
  let lotSqft: number | null = null;
  if (lotCandidates.length > 0) {
    const first = lotCandidates[0]!;
    lotSqft = first.sqft;
    for (const c of lotCandidates.slice(1)) {
      if (Math.abs(c.sqft - first.sqft) > 0.01 * Math.max(first.sqft, c.sqft)) bad(c.f);
    }
  }

  // subdivision: placeholders are none
  let subdivisionName: string | null = null;
  const rawSub = textOf(read('subdivisionName'));
  if (rawSub === undefined) bad('subdivisionName');
  else if (rawSub !== null) {
    const placeholders = new Set([...SUBDIVISION_PLACEHOLDERS, ...(mapping.subdivisionPlaceholders ?? []).map(placeholderKey)]);
    subdivisionName = placeholders.has(placeholderKey(rawSub)) || placeholderKey(rawSub) === '' ? null : rawSub;
  }

  // sale conditions: array or comma-separated text; unknown ⇒ other
  const conditionMap = vocab(RESO_SALE_CONDITION_MAP, mapping.saleConditionMap);
  const rawCond = read('saleConditions');
  const condValues: unknown[] = isBlank(rawCond) ? [] : Array.isArray(rawCond) ? rawCond : typeof rawCond === 'string' ? rawCond.split(',') : [rawCond];
  const conditions = new Set<SaleCondition>();
  let condBad = false;
  for (const c of condValues) {
    if (typeof c !== 'string') {
      condBad = true;
      continue;
    }
    if (c.trim() === '') continue;
    conditions.add(conditionMap.get(vocabKey(c.trim())) ?? 'other');
  }
  if (condBad) bad('saleConditions');

  // lease
  const top = textOf(read('propertyType'));
  const leaseTypes = new Set([...LEASE_PROPERTY_TYPES, ...(mapping.leasePropertyTypes ?? []).map(vocabKey)]);
  const isLease = typeof top === 'string' && leaseTypes.has(vocabKey(top));

  const closePriceCents = money('closePrice');
  const closeDate = date('closeDate');
  const contractDate = date('contractDate');
  const originalListPriceCents = money('originalListPrice');
  const concessionsCents = money('concessions');
  const garageSpacesX10 = tenths('garageSpaces');
  const storiesX10 = tenths('stories');
  const poolPrivate = flagPresent('poolPrivate');

  return {
    closePriceCents,
    closeDate,
    contractDate,
    originalListPriceCents,
    concessionsCents,
    saleConditions: SALE_CONDITIONS.filter((c) => conditions.has(c)),
    daysOnMarket,
    latitudeE6,
    longitudeE6,
    yearBuilt,
    lotSqft,
    subdivisionName,
    garageSpacesX10,
    poolPrivate,
    storiesX10,
    sizeSource: sqftRead ? names.sqft : null,
    isLease,
    avmDisplayAllowed: yes(read('avmDisplay')),
    unreadable: [...new Set(unreadable)],
  };
}

/**
 * Normalizes one RESO record. Returns the facts, or every issue found (non-empty). `id`,
 * `teamListingId`, `lastSeenInFeedAt` and `offMarketAt` are the sync's to fill (null here).
 */
export function normalizeMlsListing(raw: ResoLike, mapping: FieldMapping): ListingFacts | Issue[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return [{ code: 'MLS_RECORD_INVALID', field: '*', detail: 'The feed record is not an object.' }];
  }
  const names = fieldNames(mapping);
  const sizeField = sizeFieldOf(mapping);
  const read = (f: FactField): unknown => raw[names[f]];
  const issues: Issue[] = [];
  const missing = (f: FactField, what: string): void => {
    issues.push({ code: 'MLS_FIELD_MISSING', field: names[f], detail: `${what} is missing.` });
  };
  const invalid = (f: FactField, what: string): void => {
    issues.push({ code: 'MLS_FIELD_INVALID', field: names[f], detail: `${what} is not valid.` });
  };

  const requiredText = (f: FactField, what: string): string => {
    const t = textOf(read(f));
    if (t === null) missing(f, what);
    else if (t === undefined) invalid(f, what);
    return t ?? '';
  };
  const optionalText = (f: FactField): string | null => textOf(read(f)) ?? null;
  const count = (f: FactField, what: string, integer: boolean): number | null => {
    const v = read(f);
    if (isBlank(v)) return null;
    const n = numberOf(v);
    if (n === null || (integer && !Number.isInteger(n))) {
      invalid(f, what);
      return null;
    }
    return n;
  };

  // identity
  const listingKey = requiredText('listingKey', 'The listing key');
  const mlsNumber = optionalText('mlsNumber') ?? listingKey;

  // status
  let status: ListingStatus = 'active';
  const rawStatus = textOf(read('status'));
  if (rawStatus === null) missing('status', 'The status');
  else if (rawStatus === undefined) invalid('status', 'The status');
  else {
    const mapped = vocab(RESO_STATUS_MAP, mapping.statusMap).get(vocabKey(rawStatus));
    if (mapped === undefined) {
      issues.push({ code: 'MLS_STATUS_UNKNOWN', field: names.status, detail: `The status "${rawStatus.slice(0, 60)}" has no mapping for this MLS.` });
    } else {
      status = mapped;
    }
  }

  // money and counts
  let listPriceCents: number | null = null;
  const rawPrice = read('listPrice');
  if (!isBlank(rawPrice)) {
    listPriceCents = priceToCents(rawPrice);
    if (listPriceCents === null) invalid('listPrice', 'The list price');
  }
  // column bounds (F3): beds and baths_x10 are smallint, sqft is integer
  const bounded = (f: FactField, what: string, n: number | null, max: number): number | null => {
    if (n === null || n <= max) return n;
    invalid(f, what);
    return null;
  };
  const beds = bounded('beds', 'The bedroom count', count('beds', 'The bedroom count', true), SMALLINT_MAX);
  const bathsRaw = count('baths', 'The bathroom count', false);
  const baths = bathsRaw === null ? null : bounded('baths', 'The bathroom count', Math.round(bathsRaw * 10), SMALLINT_MAX);
  // R-MLS-7: only the confirmed finished-living-area field is read; with none, the size is unknown (never another field).
  // A size of 0 (or one that rounds to 0) is a feed's placeholder, not a living area: unknown too, with no issue.
  const areaRaw = sizeField === null ? null : count('sqft', 'The living area', false);
  const areaWhole = areaRaw === null ? null : Math.round(areaRaw);
  const area = areaWhole === null || areaWhole <= 0 ? null : bounded('sqft', 'The living area', areaWhole, INTEGER_MAX);
  const photosCount = count('photosCount', 'The photo count', true);

  // address
  let addressLine1 = optionalText('unparsedAddress');
  if (addressLine1 === null) {
    const parts = (['streetNumber', 'streetDirPrefix', 'streetName', 'streetSuffix', 'streetDirSuffix'] as const)
      .map((f) => optionalText(f))
      .filter((p): p is string => p !== null);
    if (optionalText('streetName') !== null) addressLine1 = parts.join(' ');
  }
  if (addressLine1 === null) missing('unparsedAddress', 'The street address');
  const unit = optionalText('unitNumber');
  const addressLine2 = unit === null ? null : /^[#]/.test(unit) || /^(unit|apt|suite|ste)\b/i.test(unit) ? unit : `Unit ${unit}`;
  const city = requiredText('city', 'The city');
  const region = requiredText('region', 'The state or province').toUpperCase();
  const postalCode = requiredText('postalCode', 'The postal code');

  // R-MLS-1: modification time and listing brokerage
  let mlsModifiedAt: Instant | null = null;
  const rawModified = read('modifiedAt');
  if (isBlank(rawModified)) missing('modifiedAt', 'The modification time');
  else {
    mlsModifiedAt = typeof rawModified === 'string' ? instantFromIso(rawModified.trim()) : null;
    if (mlsModifiedAt === null) invalid('modifiedAt', 'The modification time (ISO 8601 with an offset)');
  }
  const listingBrokerageName = requiredText('listingBrokerageName', 'The listing brokerage (ListOfficeName)');

  if (issues.length > 0) return issues;

  // descriptive fields: never block a record
  const types = vocab(RESO_PROPERTY_TYPE_MAP, mapping.propertyTypeMap);
  const sub = optionalText('propertySubType');
  const top = optionalText('propertyType');
  const propertyType = (sub !== null ? types.get(vocabKey(sub)) : undefined) ?? (top !== null ? types.get(vocabKey(top)) : undefined) ?? null;
  const listDateText = optionalText('listDate');
  const listDate = listDateText === null ? null : calendarDate(listDateText);
  const valuation = valuationFacts(read, names, mapping, area !== null);
  const unreadable = listDateText !== null && listDate === null ? [...valuation.unreadable, names.listDate] : valuation.unreadable;

  return {
    id: null,
    source: 'mls',
    listingKey,
    mlsNumber,
    status,
    addressLine1: addressLine1 as string,
    addressLine2,
    city,
    region,
    postalCode,
    listPriceCents,
    beds,
    bathsX10: baths,
    sqft: area,
    propertyType: propertyType !== null && (PROPERTY_TYPES as readonly string[]).includes(propertyType) ? propertyType : null,
    description: optionalText('description'),
    listDate,
    mlsConnectionId: mapping.connectionId,
    mlsModifiedAt,
    listingBrokerageName,
    displayAllowed: yes(read('internetDisplay')),
    addressDisplayAllowed: yes(read('addressDisplay')),
    photoUrls: photoUrls(read('media'), mapping.mediaUrlKey ?? 'MediaURL'),
    photosCount,
    teamListingId: null,
    lastSeenInFeedAt: null,
    offMarketAt: null,
    valuation: unreadable === valuation.unreadable ? valuation : { ...valuation, unreadable },
  };
}
