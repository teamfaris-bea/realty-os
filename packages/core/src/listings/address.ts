// Address keys and geo cells for MLS sold data (R-CMA-1; F2). Pure.
//
// addressKey: one canonical string per home, so the same address matches across the MLS (structured RESO parts or
// UnparsedAddress) and a contact's address. Format and token rules follow core/predict `normalizeAddress`
// (`line1|unit X|city|region|zip`, street-type and directional words abbreviated), copied here rather than imported:
// R-PRED-4 keeps prediction code out of pricing. It goes further than predict:
//   - the structured RESO parts (StreetNumber, StreetDirPrefix, StreetName, StreetSuffix, StreetDirSuffix, UnitNumber,
//     PostalCode) are used when StreetName is present;
//   - otherwise line1 is used with a trailing ", City, ST 12345" removed and a unit designator (unit, apt, apartment,
//     suite, ste, #) moved to the unit part;
//   - the region is folded to its two-letter USPS code from a fixed table (for MLS rows and contact addresses alike);
//   - the postal code is its first 5 digits.
// A parity test proves it equals predict's normalizeAddress on predict's own fixture table.
//
// geoCell: the S0 generated column listings.geo_cell, about 1 mi of latitude per cell. A DB parity test checks it.

/** USPS state, district and territory codes and their names (fixed; folding only, never a legal fact). */
export const USPS_REGIONS: Readonly<Record<string, string>> = Object.freeze({
  AL: 'Alabama', AK: 'Alaska', AZ: 'Arizona', AR: 'Arkansas', CA: 'California', CO: 'Colorado', CT: 'Connecticut', DE: 'Delaware',
  DC: 'District of Columbia', FL: 'Florida', GA: 'Georgia', HI: 'Hawaii', ID: 'Idaho', IL: 'Illinois', IN: 'Indiana', IA: 'Iowa',
  KS: 'Kansas', KY: 'Kentucky', LA: 'Louisiana', ME: 'Maine', MD: 'Maryland', MA: 'Massachusetts', MI: 'Michigan', MN: 'Minnesota',
  MS: 'Mississippi', MO: 'Missouri', MT: 'Montana', NE: 'Nebraska', NV: 'Nevada', NH: 'New Hampshire', NJ: 'New Jersey',
  NM: 'New Mexico', NY: 'New York', NC: 'North Carolina', ND: 'North Dakota', OH: 'Ohio', OK: 'Oklahoma', OR: 'Oregon',
  PA: 'Pennsylvania', RI: 'Rhode Island', SC: 'South Carolina', SD: 'South Dakota', TN: 'Tennessee', TX: 'Texas', UT: 'Utah',
  VT: 'Vermont', VA: 'Virginia', WA: 'Washington', WV: 'West Virginia', WI: 'Wisconsin', WY: 'Wyoming',
  PR: 'Puerto Rico', VI: 'Virgin Islands', GU: 'Guam', AS: 'American Samoa', MP: 'Northern Mariana Islands',
});

function fold(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

const plain = (s: string): string => fold(s).replace(/[^a-z0-9]+/g, ' ').trim();

const REGION_BY_NAME: ReadonlyMap<string, string> = new Map([
  ...Object.entries(USPS_REGIONS).flatMap(([code, name]): [string, string][] => [
    [plain(name), code],
    [code.toLowerCase(), code],
  ]),
  ['us virgin islands', 'VI'],
  ['washington dc', 'DC'],
]);

/** The USPS code of a region written as a code or a name ("SC", "sc", "South Carolina"), else null. */
export function uspsCode(region: string): string | null {
  return REGION_BY_NAME.get(plain(region)) ?? null;
}

// predict's token rules (core/predict/property.ts), copied (R-PRED-4).
const STREET_WORDS: Readonly<Record<string, string>> = {
  street: 'st', str: 'st', avenue: 'ave', av: 'ave', boulevard: 'blvd', road: 'rd', drive: 'dr', lane: 'ln', court: 'ct', place: 'pl',
  terrace: 'ter', circle: 'cir', parkway: 'pkwy', highway: 'hwy', square: 'sq', trail: 'trl', way: 'way', north: 'n', south: 's', east: 'e', west: 'w',
  northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw', apartment: 'unit', apt: 'unit', suite: 'unit', ste: 'unit', unit: 'unit', number: 'unit',
};

function tokens(s: string): string[] {
  return fold(s)
    .replace(/#/g, ' unit ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w !== '')
    .map((w) => STREET_WORDS[w] ?? w);
}

/** Words that start a unit inside a street line (before token mapping). */
const UNIT_DESIGNATORS = new Set(['unit', 'apt', 'apartment', 'suite', 'ste']);

function rawWords(s: string): string[] {
  return fold(s)
    .replace(/#/g, ' # ')
    .replace(/[^a-z0-9#]+/g, ' ')
    .trim()
    .split(' ')
    .filter((w) => w !== '');
}

/** The structured RESO address parts (each optional). */
export interface AddressParts {
  readonly streetNumber?: string | null;
  readonly streetDirPrefix?: string | null;
  readonly streetName?: string | null;
  readonly streetSuffix?: string | null;
  readonly streetDirSuffix?: string | null;
  readonly unitNumber?: string | null;
  readonly postalCode?: string | null;
}

export interface AddressInput {
  readonly line1: string;
  readonly line2?: string | null;
  readonly city: string;
  readonly region: string;
  readonly postalCode: string;
  readonly parts?: AddressParts | null;
}

const zip5 = (s: string): string => (s.match(/\d/g) ?? []).join('').slice(0, 5);

function regionTokens(region: string): string[] {
  const code = uspsCode(region);
  return code !== null ? [code.toLowerCase()] : tokens(region);
}

/** Removes a trailing "City, ST 12345" (comma-separated, or without commas when the state is there). */
function streetLine(line1: string, city: string, region: string): { street: string[]; unit: string[] } {
  const segments = line1.split(',').map((s) => s.trim()).filter((s) => s !== '');
  let words = rawWords(segments[0] ?? '');
  const unit: string[] = [];
  // a later segment that is a unit ("123 Main St, Apt 4, City, ST")
  for (const seg of segments.slice(1)) {
    const w = rawWords(seg);
    if (w.length > 0 && (UNIT_DESIGNATORS.has(w[0]!) || w[0] === '#')) unit.push(...w.slice(1));
  }
  // no commas: drop a tail of [city] STATE [zip], but only when the state is the address's own and the tail is
  // certain (a zip after it, or the city before it): "12 Oak Ct" (CT) and "12 Main St NE" (NE) keep their words
  if (segments.length === 1) {
    const own = uspsCode(region);
    let end = words.length;
    const zipAtEnd = end > 0 && /^\d{5}(\d{4})?$/.test(words[end - 1]!);
    if (zipAtEnd) end -= 1;
    let regionAt = -1;
    for (let k = Math.max(1, end - 3); k < end; k++) {
      if (own !== null && uspsCode(words.slice(k, end).join(' ')) === own) {
        regionAt = k;
        break;
      }
    }
    if (regionAt > 0) {
      const cityWords = rawWords(city);
      const cityAt = regionAt - cityWords.length;
      const cityBefore = cityWords.length > 0 && cityAt > 0 && words.slice(cityAt, regionAt).join(' ') === cityWords.join(' ');
      if (cityBefore) words = words.slice(0, cityAt);
      else if (zipAtEnd) words = words.slice(0, regionAt);
    }
  }
  // a unit designator inside the street line moves to the unit
  const at = words.findIndex((w, i) => i > 0 && (UNIT_DESIGNATORS.has(w) || w === '#'));
  if (at > 0) {
    unit.unshift(...words.slice(at + 1).filter((w) => !UNIT_DESIGNATORS.has(w) && w !== '#'));
    words = words.slice(0, at);
  }
  return { street: tokens(words.join(' ')), unit };
}

/**
 * The canonical key of an address, or null when a required part (street, city, region, 5-digit postal code) is
 * missing. Same format as predict's normalizeAddress.
 */
export function addressKey(a: AddressInput): string | null {
  const p = a.parts ?? null;
  const text = (v: string | null | undefined): string => (typeof v === 'string' ? v : '');
  let street: string[];
  let unitWords: string[];
  if (p !== null && text(p.streetName).trim() !== '') {
    street = tokens([p.streetNumber, p.streetDirPrefix, p.streetName, p.streetSuffix, p.streetDirSuffix].map(text).join(' '));
    unitWords = [];
  } else {
    const s = streetLine(a.line1, a.city, a.region);
    street = s.street;
    unitWords = s.unit;
  }
  const explicitUnit = text(p?.unitNumber).trim() !== '' ? text(p?.unitNumber) : text(a.line2);
  if (explicitUnit.trim() !== '') unitWords = rawWords(explicitUnit);
  const unit = tokens(unitWords.join(' ')).filter((w) => w !== 'unit');
  const city = tokens(a.city);
  const region = regionTokens(a.region);
  const zip = zip5(text(p?.postalCode).trim() !== '' ? text(p?.postalCode) : a.postalCode);
  if (street.length === 0 || city.length === 0 || region.length === 0 || zip.length !== 5) return null;
  return [street.join(' '), unit.length > 0 ? `unit ${unit.join(' ')}` : '', city.join(' '), region.join(' '), zip].join('|');
}

/** The street number and street-name tokens of a key (for near-match lookups, F2), or null. */
export function streetOfKey(key: string): { streetNumber: string; streetNameTokens: string[]; postalCode: string } | null {
  const [line1, , , , zip] = key.split('|');
  const words = (line1 ?? '').split(' ').filter((w) => w !== '');
  if (words.length < 2 || !/^\d+[a-z]?$/.test(words[0]!) || zip === undefined || zip.length !== 5) return null;
  return { streetNumber: words[0]!, streetNameTokens: words.slice(1), postalCode: zip };
}

/** S0's listings.geo_cell: ((floor(lat/14493) + 6300) * 25000 + (floor(lon/14493) + 12500)); null without a pair. */
export function geoCell(latE6: number | null, lonE6: number | null): number | null {
  if (latE6 === null || lonE6 === null) return null;
  return (Math.floor(latE6 / 14493) + 6300) * 25000 + (Math.floor(lonE6 / 14493) + 12500);
}

/** Miles per cell of latitude (14,493 µ° of a 69.09 mi degree). */
export const CELL_MILES = 1.0013;

/**
 * The geo cells that cover every point within `miles` of a coordinate: whole cells, so a superset (the engine
 * measures the real distance). Longitude cells narrow with latitude, so more of them are taken away from the equator.
 */
export function cellsWithin(latE6: number, lonE6: number, miles: number): number[] {
  const la = Math.floor(latE6 / 14493);
  const lo = Math.floor(lonE6 / 14493);
  const latRings = Math.ceil(miles / CELL_MILES);
  const maxLat = Math.min(89.9, Math.abs(latE6 / 1e6) + (latRings * 14493) / 1e6);
  const lonRings = Math.ceil(miles / (CELL_MILES * Math.cos((maxLat * Math.PI) / 180)));
  const out: number[] = [];
  for (let dy = -latRings; dy <= latRings; dy++) {
    for (let dx = -lonRings; dx <= lonRings; dx++) out.push((la + dy + 6300) * 25000 + (lo + dx + 12500));
  }
  return out.sort((a, b) => a - b);
}
