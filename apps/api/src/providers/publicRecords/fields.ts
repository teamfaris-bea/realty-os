// Every county service path and field name the Beaufort connector uses (owner decision D10; R-HOME-6). Code
// constants, never configuration: an operator cannot point the connector at another host or path. EVERY value below
// is VERIFY with the county before any live call (docs/DEPLOY.md "Before any live county call"): the service root,
// each layer number, each field name and type, how the county writes empty values, and its usage terms.

/** The ArcGIS REST services root (VERIFY). Its host must be on PUBLIC_RECORDS_ALLOWED_HOSTS. */
export const BEAUFORT_SERVICES_ROOT = 'https://gis.beaufortcountysc.gov/server/rest/services';
export const BEAUFORT_DEFAULT_HOSTS: readonly string[] = ['gis.beaufortcountysc.gov'];

/** Step 1: the address point layer (VERIFY). */
export const ADDRESS_LAYER = {
  path: 'Addresses/MapServer/0',
  number: 'STREETNUM',
  preDirection: 'PREDIRECT',
  name: 'STREETNAME',
  type: 'TYPE',
  postDirection: 'POSTDIRECT',
  unit: 'UNITNUM',
  /** the layer maps no city or ZIP field (OpenAddresses shape); null means "take them from the request" (VERIFY) */
  city: null as string | null,
  zip: null as string | null,
} as const;

/** Step 2: the parcel polygon layer queried by the address point (VERIFY). */
export const PARCEL_LAYER = {
  path: 'EnerGov/MapServer/1',
  pin: 'GisFile_PIN',
  owner1: 'GisFile_Owner1',
  owner2: 'GisFile_Owner2',
  mailing: 'GisFile_MailingAdd',
} as const;

/** Step 3 (only with useGisfileTable): the sale date and price by PIN (VERIFY; LEGRES is not mapped). */
export const GISFILE_TABLE = {
  path: 'SwrAddLookUp/MapServer/1',
  pin: 'PIN',
  /** epoch milliseconds in ArcGIS JSON (VERIFY) */
  saleDate: 'SALEDATE',
  /** whole dollars (VERIFY) */
  salePrice: 'SALEPRICE',
} as const;

/** Off by default: the table and its fields are unverified (VERIFY). One flag turns step 3 on. */
export const USE_GISFILE_TABLE_DEFAULT = false;

/** The source label every value carries (SOURCE_RE). A layer edit date would cost a fourth request (VERIFY), so asOf is null. */
export const BEAUFORT_SOURCE = 'Beaufort County GIS parcel layer';
