// INTERIM (lane V1-C, until lane V1-A merges): the address key and the geo cell of core/listings.
//
// V1-A owns `addressKey` and `geoCell` in packages/core/src/listings (R-CMA-1; F2). Lane V1-C may not edit core, so
// these stand-ins carry the same names and the same contract, and apps/api/src/cma/deps.ts re-exports them. At the
// V1-A merge deps.ts points at @realty/core/listings and this file is deleted (its tests move with it).
//
// The key is built from structured parts: lower case, punctuation removed, the common street suffixes and directions
// abbreviated (USPS Publication 28 style), the unit kept as `#<unit>`, the state folded to its USPS code and the ZIP cut to
// five digits. Two spellings of one address give one key (E365). It never reads names, people or anything but the
// address. R-PRED-4: copied rules, nothing imported from prediction code.

export interface AddressParts {
  line1: string | null;
  line2?: string | null;
  city: string | null;
  region: string | null;
  postalCode: string | null;
}

const SUFFIX: Record<string, string> = {
  street: 'st', str: 'st', avenue: 'ave', av: 'ave', boulevard: 'blvd', drive: 'dr', road: 'rd', lane: 'ln', court: 'ct',
  place: 'pl', terrace: 'ter', circle: 'cir', parkway: 'pkwy', highway: 'hwy', trail: 'trl', way: 'way', square: 'sq',
  north: 'n', south: 's', east: 'e', west: 'w', northeast: 'ne', northwest: 'nw', southeast: 'se', southwest: 'sw',
};

const UNIT_WORDS = new Set(['apt', 'apartment', 'unit', 'suite', 'ste', 'no', '#']);

export const US_STATES: Record<string, string> = {
  alabama: 'AL', alaska: 'AK', arizona: 'AZ', arkansas: 'AR', california: 'CA', colorado: 'CO', connecticut: 'CT', delaware: 'DE',
  'district of columbia': 'DC', florida: 'FL', georgia: 'GA', hawaii: 'HI', idaho: 'ID', illinois: 'IL', indiana: 'IN', iowa: 'IA',
  kansas: 'KS', kentucky: 'KY', louisiana: 'LA', maine: 'ME', maryland: 'MD', massachusetts: 'MA', michigan: 'MI', minnesota: 'MN',
  mississippi: 'MS', missouri: 'MO', montana: 'MT', nebraska: 'NE', nevada: 'NV', 'new hampshire': 'NH', 'new jersey': 'NJ',
  'new mexico': 'NM', 'new york': 'NY', 'north carolina': 'NC', 'north dakota': 'ND', ohio: 'OH', oklahoma: 'OK', oregon: 'OR',
  pennsylvania: 'PA', 'rhode island': 'RI', 'south carolina': 'SC', 'south dakota': 'SD', tennessee: 'TN', texas: 'TX', utah: 'UT',
  vermont: 'VT', virginia: 'VA', washington: 'WA', 'west virginia': 'WV', wisconsin: 'WI', wyoming: 'WY', 'puerto rico': 'PR',
};
const USPS = new Set(Object.values(US_STATES));

/** The USPS code of a state written as a code or a name, else null. */
export function uspsState(region: string | null | undefined): string | null {
  const r = (region ?? '').trim();
  if (r === '') return null;
  const up = r.toUpperCase();
  if (USPS.has(up)) return up;
  return US_STATES[r.toLowerCase().replace(/[^a-z ]/g, '').replace(/\s+/g, ' ')] ?? null;
}

function tokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/#/g, ' # ')
    .replace(/[.,;:'"()]/g, ' ')
    .split(/\s+/)
    .filter((t) => t !== '');
}

/** The street part (number, name, suffix) and the unit of a street line, normalized. */
function street(line1: string, line2: string | null): { street: string[]; unit: string | null } {
  const t = tokens(line1);
  const out: string[] = [];
  let unit: string | null = null;
  for (let i = 0; i < t.length; i++) {
    const w = t[i]!;
    if (UNIT_WORDS.has(w)) {
      unit = t.slice(i + 1).join('') || unit;
      break;
    }
    out.push(SUFFIX[w] ?? w);
  }
  if (unit === null && line2) {
    const u = tokens(line2).filter((w) => !UNIT_WORDS.has(w)).join('');
    unit = u === '' ? null : u;
  }
  return { street: out, unit };
}

/**
 * The address key (R-CMA-1): `<number street suffix>[#unit]|<zip5>|<ST>`, or null when the street line, ZIP or state is
 * missing. The city is left out on purpose: one ZIP spans spellings of a city ("St." and "Saint").
 */
export function addressKey(a: AddressParts): string | null {
  if (!a.line1 || a.line1.trim() === '') return null;
  const zip = (a.postalCode ?? '').replace(/[^0-9]/g, '').slice(0, 5);
  const st = uspsState(a.region);
  if (zip.length !== 5 || st === null) return null;
  const s = street(a.line1, a.line2 ?? null);
  if (s.street.length === 0) return null;
  return `${s.street.join(' ')}${s.unit ? ` #${s.unit}` : ''}|${zip}|${st}`;
}

/** The key without its unit (near matches compare these). */
export function addressKeyBase(key: string): string {
  const [st, zip, region] = key.split('|');
  return `${(st ?? '').replace(/ #.*$/, '')}|${zip ?? ''}|${region ?? ''}`;
}

/** Mirrors listings.geo_cell (0061): ((floor(lat/14493) + 6300) * 25000 + (floor(lon/14493) + 12500)). */
export function geoCell(latE6: number, lonE6: number): number {
  return (Math.floor(latE6 / 14493) + 6300) * 25000 + (Math.floor(lonE6 / 14493) + 12500);
}

/** The cells within `rings` cells of a point (rings 1: the 3 × 3 block). Longitude cells shrink with latitude. */
export function cellsAround(latE6: number, lonE6: number, miles: number): number[] {
  const latRings = Math.ceil(miles / 1.0) + 0;
  const cosLat = Math.max(0.05, Math.cos((latE6 / 1e6) * (Math.PI / 180)));
  const lonRings = Math.ceil(miles / (1.0 * cosLat));
  const la = Math.floor(latE6 / 14493);
  const lo = Math.floor(lonE6 / 14493);
  const out: number[] = [];
  for (let i = -latRings; i <= latRings; i++) for (let j = -lonRings; j <= lonRings; j++) out.push((la + i + 6300) * 25000 + (lo + j + 12500));
  return out;
}

/** Great-circle distance in miles between two microdegree points (haversine). */
export function distanceMiles(a: { latE6: number; lonE6: number }, b: { latE6: number; lonE6: number }): number {
  const r = Math.PI / 180;
  const la1 = (a.latE6 / 1e6) * r;
  const la2 = (b.latE6 / 1e6) * r;
  const dla = la2 - la1;
  const dlo = ((b.lonE6 - a.lonE6) / 1e6) * r;
  const h = Math.sin(dla / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dlo / 2) ** 2;
  return 3958.8 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}
