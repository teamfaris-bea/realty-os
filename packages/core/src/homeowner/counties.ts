// County routing and links (R-HOME-2; E575, E576, E577). A PLATFORM table: which county a subject address is in,
// whether the county has a connector (Beaufort: fixtures only, live calls off) or links only (Jasper), and the public
// county pages an agent can open to look further. Links come from this table only and never carry the address or any
// other contact datum. Every ZIP list and URL is VERIFY (ZIP codes cross county lines; county sites move).

import type { PostalAddress } from './types.js';

export type CountyKey = 'sc-beaufort' | 'sc-jasper';
export type CountyRoute =
  | { key: 'sc-beaufort'; mode: 'connector' }
  | { key: 'sc-jasper'; mode: 'links' }
  | { mode: 'shared'; try: 'sc-beaufort'; also: 'sc-jasper' };

export interface CountyLink {
  label: string;
  url: string;
}
export interface CountyInfo {
  key: CountyKey;
  name: string;
  /** where to look up the owner and the county's values */
  records: CountyLink;
  /** where recorded loans and transfers are searched (no automated source, R-HOME-4) */
  deeds: CountyLink;
  /** the county's tax rates (millage), shown where tax values are; null when the table has none */
  taxRates: CountyLink | null;
}

/** ZIPs wholly in Beaufort County for this table. VERIFY. */
export const BEAUFORT_ZIPS: readonly string[] = ['29902', '29903', '29904', '29905', '29906', '29907', '29920', '29925', '29926', '29928', '29935', '29938', '29941'];
/** ZIPs that cross into Jasper County: Beaufort is tried, then the Jasper links are shown. VERIFY. */
export const SHARED_BEAUFORT_JASPER_ZIPS: readonly string[] = ['29909', '29910'];
/** ZIPs in Jasper County (links only). VERIFY. */
export const JASPER_ZIPS: readonly string[] = ['29927', '29934', '29936', '29943'];

/**
 * Public county pages: the brief's candidate pages (verify_items 6; b11 reconciliation homeowner-11). Each URL is
 * VERIFY with the county before a deployment relies on it; none carries the address or any contact datum, and the panel
 * opens https links only.
 */
export const COUNTIES: Readonly<Record<CountyKey, CountyInfo>> = {
  'sc-beaufort': {
    key: 'sc-beaufort',
    name: 'Beaufort County',
    // VERIFY: the assessor's public property search (Public Access)
    records: { label: 'Beaufort County Public Access (assessor records)', url: 'https://sc-beaufort.publicaccessnow.com/' },
    // VERIFY: a new system since 2/23/2026; recorded amounts are probably on the document images only
    deeds: { label: 'Beaufort County Register of Deeds', url: 'https://www.beaufortcountysc.gov/register-of-deeds/index.html' },
    // VERIFY: the auditor's millage page
    taxRates: { label: 'Beaufort County millage rates', url: 'https://beaufortcountysc.gov/auditor/millage-info.html' },
  },
  'sc-jasper': {
    key: 'sc-jasper',
    name: 'Jasper County',
    // VERIFY: the brief lists http://qpublic.net/sc/jasper/; whether the https form below answers is NOT verified (the
    // panel opens https links only, so an http-only page would need a reviewed change, never a downgrade here)
    records: { label: 'Jasper County Assessor on qPublic', url: 'https://qpublic.net/sc/jasper/' },
    // VERIFY: the index is complete from April 2007
    deeds: { label: 'Jasper County Register of Deeds', url: 'https://www.jaspercountysc.gov/services/register-of-deeds/' },
    taxRates: null,
  },
};

const SC = new Set(['SC', 'SOUTH CAROLINA', 'S C']);

/** True for "SC", "S.C." or "South Carolina" in any case. */
export function isSouthCarolina(region: string): boolean {
  return SC.has(region.toUpperCase().replace(/\./g, ' ').replace(/\s+/g, ' ').trim());
}

/** The first five digits of a postal code, or null. */
export function zip5(postalCode: string): string | null {
  const m = /^\s*(\d{5})(?:-?\d{4})?\s*$/.exec(postalCode);
  return m ? m[1]! : null;
}

/** The county route of an address, or null (another state or an unlisted ZIP). */
export function countyOf(a: Pick<PostalAddress, 'region' | 'postalCode'>): CountyRoute | null {
  if (!isSouthCarolina(a.region)) return null;
  const z = zip5(a.postalCode);
  if (z === null) return null;
  if (BEAUFORT_ZIPS.includes(z)) return { key: 'sc-beaufort', mode: 'connector' };
  if (SHARED_BEAUFORT_JASPER_ZIPS.includes(z)) return { mode: 'shared', try: 'sc-beaufort', also: 'sc-jasper' };
  if (JASPER_ZIPS.includes(z)) return { key: 'sc-jasper', mode: 'links' };
  return null;
}

/** The ZIPs the connector can look up (fed to the job's candidate SQL as a parameter). */
export function connectorZips(): string[] {
  return [...BEAUFORT_ZIPS, ...SHARED_BEAUFORT_JASPER_ZIPS];
}

/** The county a connector lookup goes to for a route (Beaufort for both connector and shared), else null. */
export function connectorCountyOf(route: CountyRoute | null): 'sc-beaufort' | null {
  if (route === null) return null;
  if (route.mode === 'shared') return route.try;
  return route.mode === 'connector' ? route.key : null;
}

/** The subject address with the region written as "SC", so a county record ("SC") and "South Carolina" compare equal. */
export function canonicalRegion<T extends PostalAddress>(a: T): T {
  return isSouthCarolina(a.region) ? { ...a, region: 'SC' } : a;
}
