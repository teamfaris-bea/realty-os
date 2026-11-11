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
import { type Instant, instantFromIso } from '../foundation/index.js';
import { PROPERTY_TYPES } from '../assistant/index.js';
import type { FactField, FieldMapping, Issue, ListingFacts, ListingStatus, PropertyType, ResoLike } from './types.js';

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

const ISO_DATE_PREFIX = /^(\d{4}-\d{2}-\d{2})(?:$|T)/;

/**
 * Normalizes one RESO record. Returns the facts, or every issue found (non-empty). `id`,
 * `teamListingId`, `lastSeenInFeedAt` and `offMarketAt` are the sync's to fill (null here).
 */
export function normalizeMlsListing(raw: ResoLike, mapping: FieldMapping): ListingFacts | Issue[] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return [{ code: 'MLS_RECORD_INVALID', field: '*', detail: 'The feed record is not an object.' }];
  }
  const names: Record<FactField, string> = { ...RESO_DEFAULT_FIELDS, ...mapping.fields };
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
  const beds = count('beds', 'The bedroom count', true);
  const baths = count('baths', 'The bathroom count', false);
  const area = count('sqft', 'The living area', false);
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
  const listDate = listDateText === null ? null : (ISO_DATE_PREFIX.exec(listDateText)?.[1] ?? null);

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
    bathsX10: baths === null ? null : Math.round(baths * 10),
    sqft: area === null ? null : Math.round(area),
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
  };
}
