// The MLS admin view and the licence-pack editor's model (GET /admin/mls, PUT /admin/mls/connections/:id/license-pack;
// apps/api/src/mls/admin.ts). Pure; copied field by field from responses.
//
// R-MLS-2: the pack counts as counsel-reviewed only when EVERY value is marked reviewed; until then no MLS listing
// reaches a client. The editor says so, and changing a value clears its mark (counsel reviewed the old value).
// D9: the valuation section (below PackView) is edited apart, with its own stamp; the display editor never sends it.
// Every value is VERIFY WITH COUNSEL / MLS; nothing here encodes a particular MLS's rules.

/**
 * Fields a licence pack can allow per audience: packages/core listings DISPLAY_FIELDS, in its order (pack.test.ts checks
 * they are equal). Restated, not imported, so the phone bundle does not pull core's runtime in (as design/Evidence.tsx).
 * A field missing here would be dropped from a stored pack on the next save, so the D9 sold fields are listed too.
 */
export const DISPLAY_FIELDS = ['mlsNumber', 'status', 'listPrice', 'beds', 'baths', 'sqft', 'propertyType', 'description', 'listDate', 'address', 'locality', 'photos', 'closePrice', 'closeDate', 'yearBuilt', 'lotSize', 'subdivision'] as const;
export const LISTING_STATUSES = ['coming_soon', 'active', 'pending', 'sold', 'withdrawn', 'expired'] as const;
export const PACK_KEYS = ['max_staleness_hours', 'attribution_text', 'disclaimer_text', 'allow_rehost_photos', 'require_listing_brokerage', 'client_fields', 'client_statuses', 'public_fields', 'public_statuses'] as const;
export type PackKey = (typeof PACK_KEYS)[number];

export const FIELD_WORDS: Record<string, string> = {
  mlsNumber: 'MLS number',
  status: 'Status',
  listPrice: 'List price',
  beds: 'Bedrooms',
  baths: 'Bathrooms',
  sqft: 'Square feet',
  propertyType: 'Property type',
  description: 'Description',
  listDate: 'List date',
  address: 'Street address',
  locality: 'City, state and ZIP',
  photos: 'Photos',
  closePrice: 'Sold price',
  closeDate: 'Sold date',
  yearBuilt: 'Year built',
  lotSize: 'Lot size',
  subdivision: 'Subdivision',
};
export const STATUS_WORDS: Record<string, string> = { coming_soon: 'Coming soon', active: 'Active', pending: 'Pending', sold: 'Sold', withdrawn: 'Withdrawn', expired: 'Expired' };

export const KEY_WORDS: Record<PackKey, { label: string; hint: string }> = {
  max_staleness_hours: { label: 'Longest the MLS data may be out of date', hint: 'In hours. When the data is older, MLS listings are paused for clients. Empty means not set, and then the data always counts as out of date.' },
  attribution_text: { label: 'Attribution', hint: 'Shown with every MLS listing a client sees. Clients see no MLS listing without it.' },
  disclaimer_text: { label: 'Disclaimer', hint: 'Shown with every MLS listing a client sees. Clients see no MLS listing without it.' },
  allow_rehost_photos: { label: 'Photos may be copied to our own storage', hint: 'When off, photos are only shown from the MLS’s own address.' },
  require_listing_brokerage: { label: 'Show the listing brokerage on every listing', hint: 'Whether each MLS listing names the brokerage that listed it.' },
  client_fields: { label: 'What clients may see', hint: 'In listing alerts and anything else sent to clients. Nothing not ticked is shown.' },
  client_statuses: { label: 'Listing statuses clients may see', hint: 'A listing in any other status is not shown to clients.' },
  public_fields: { label: 'What the public may see', hint: 'On public listing pages. Nothing not ticked is shown.' },
  public_statuses: { label: 'Listing statuses the public may see', hint: 'A listing in any other status is not shown publicly.' },
};

export interface PackValues {
  max_staleness_hours: number | null;
  attribution_text: string | null;
  disclaimer_text: string | null;
  allow_rehost_photos: boolean;
  require_listing_brokerage: boolean;
  client_fields: string[];
  client_statuses: string[];
  public_fields: string[];
  public_statuses: string[];
}

// ---- the valuation section (D9; R-CMA-6, R-CMA-7; batch 10 review api-ui/F2) ------------------------------------------
//
// What the MLS agreement allows for sold data used in valuations, with its OWN counsel stamp (apps/api/src/mls/admin.ts
// VALUATION_PACK_KEYS, the PUT body's optional `valuation`). Strictest defaults when missing or unreadable, as core
// parseLicensePack: no use allowed, the seller's "no automated valuation" choice holds for every client output, no
// statement. Nothing here ever ticks a use the Owner did not tick. V1 shares nothing built from MLS sales with clients,
// whatever the section says (D9): the page says so beside the client uses.

export const VALUATION_KEYS = ['agent_cma', 'client_cma', 'automated_notes', 'avm_flag_scope', 'statements'] as const;
export type ValuationKey = (typeof VALUATION_KEYS)[number];
export const AVM_SCOPES = ['all_client_outputs', 'internet_display_only'] as const;
export type AvmScope = (typeof AVM_SCOPES)[number];

/** USPS state, district and territory codes and names: packages/core listings USPS_REGIONS (pack.test.ts checks they are equal). */
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

export interface ValuationStatement {
  /** USPS code */
  region: string;
  text: string;
  minPointSize: number;
}

export interface ValuationValues {
  agent_cma: boolean;
  client_cma: boolean;
  automated_notes: boolean;
  avm_flag_scope: AvmScope;
  statements: ValuationStatement[];
}

export interface ValuationView {
  values: ValuationValues;
  marks: Record<ValuationKey, boolean>;
  reviewedByCounselAt: string | null;
  unreviewedCount: number;
  sentence: string;
}

/**
 * Said on the page whatever the section holds (D9). b13 integration (V2B-1's MLS lines): V2-A builds client CMAs and V2-B
 * seller value ranges and in-house home-value notes, all behind platform:cma, so the page says what they wait for,
 * never "in this version" (the API's valuation sentence says the same, apps/api/src/mls/admin.ts VALUATION_NO_SHARING).
 */
export const VALUATION_NOT_SHARED = 'Nothing built from MLS sales reaches a client until counsel review of the in-house CMA wording (platform:cma) is recorded on the Integrations page, whatever is recorded here.';
const CLIENT_USE_HINT = 'Built, and off until counsel review of the in-house CMA wording (platform:cma) is recorded on the Integrations page: nothing built from MLS sales reaches a client before then. Leave it off unless your MLS agreement allows it.';

export const VALUATION_WORDS: Record<ValuationKey, { label: string; hint: string }> = {
  agent_cma: { label: 'Agents may prepare CMAs from MLS sold data', hint: 'Tick this only if your MLS agreement allows sold data to be used for valuations. Agent-facing only: the agent sees the estimate and nothing is sent to a client. Agent CMAs are refused until it is ticked.' },
  client_cma: { label: 'CMAs built from MLS sold data may be shared with clients', hint: CLIENT_USE_HINT },
  automated_notes: { label: 'Automated home-value notes and seller-update value ranges may carry values built from MLS sold data', hint: CLIENT_USE_HINT },
  avm_flag_scope: { label: 'Where a seller’s “no automated valuation” choice applies', hint: 'Some MLS listings say the seller does not want automated valuations shown. The strictest choice holds it for everything that could reach a client.' },
  statements: { label: 'Valuation statement for each state', hint: 'The statement counsel requires with a value shown to a client in that state, and its smallest type size. None is shipped. Readiness checks for one; nothing is shown to a client until counsel review of platform:cma is recorded.' },
};
export const AVM_SCOPE_WORDS: Record<AvmScope, string> = { all_client_outputs: 'Everything that could reach a client (strictest)', internet_display_only: 'Internet display only' };

export interface PackView {
  values: PackValues;
  marks: Record<PackKey, boolean>;
  reviewedByCounselAt: string | null;
  unreviewedCount: number;
  sentence: string;
  valuation: ValuationView;
}

export interface MlsConnection {
  id: string;
  displayName: string;
  status: string;
  statusSentence: string;
  lastSyncedAt: string | null;
  nextSyncAt: string | null;
  mlsDataAsOf: string;
  feedStale: boolean;
  clientDisplay: boolean;
  clientDisplaySentence: string;
  licensePack: PackView;
}

const obj = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const list = (v: unknown, allowed: readonly string[]): string[] => (Array.isArray(v) ? allowed.filter((a) => v.includes(a)) : []);

/** The valuation section of GET /admin/mls (or the PUT response), copied field by field; strictest when unreadable. */
export function pickValuation(raw: unknown): ValuationView {
  const o = obj(raw);
  const byKey = new Map<string, { value: unknown; counselReviewed: boolean }>();
  for (const x of Array.isArray(o.values) ? o.values : []) {
    const v = obj(x);
    if (typeof v.key === 'string') byKey.set(v.key, { value: v.value, counselReviewed: v.counselReviewed === true });
  }
  const val = (k: ValuationKey) => byKey.get(k)?.value;
  const scope = val('avm_flag_scope');
  const raws = val('statements');
  const statements = (Array.isArray(raws) ? raws : []).flatMap((x): ValuationStatement[] => {
    const st = obj(x);
    const size = st.minPointSize;
    return typeof st.region === 'string' && Object.hasOwn(USPS_REGIONS, st.region) && typeof st.text === 'string' && typeof size === 'number' && Number.isFinite(size) ? [{ region: st.region, text: st.text, minPointSize: size }] : [];
  });
  const marks = Object.fromEntries(VALUATION_KEYS.map((k) => [k, byKey.get(k)?.counselReviewed === true])) as Record<ValuationKey, boolean>;
  return {
    values: {
      agent_cma: val('agent_cma') === true,
      client_cma: val('client_cma') === true,
      automated_notes: val('automated_notes') === true,
      avm_flag_scope: scope === 'internet_display_only' ? 'internet_display_only' : 'all_client_outputs',
      statements,
    },
    marks,
    reviewedByCounselAt: strOrNull(o.reviewedByCounselAt),
    unreviewedCount: VALUATION_KEYS.filter((k) => !marks[k]).length,
    sentence: str(o.sentence),
  };
}

/** The PUT body's `valuation`: every value with its mark (sent with the display pack as stored; apps/api mls/routes.ts). */
export function valuationBody(values: ValuationValues, marks: Record<ValuationKey, boolean>): Record<ValuationKey, { value: unknown; counselReviewed: boolean }> {
  return Object.fromEntries(VALUATION_KEYS.map((k) => [k, { value: values[k], counselReviewed: marks[k] === true }])) as Record<ValuationKey, { value: unknown; counselReviewed: boolean }>;
}

/** A statement list the server would accept (routes.ts Statement): a known state once each, a text, a size 6–36. */
export function statementsValid(xs: readonly ValuationStatement[]): boolean {
  const regions = xs.map((x) => x.region);
  return new Set(regions).size === regions.length && xs.every((x) => Object.hasOwn(USPS_REGIONS, x.region) && x.text.trim().length > 0 && x.text.trim().length <= 4000 && Number.isFinite(x.minPointSize) && x.minPointSize >= 6 && x.minPointSize <= 36);
}

export const VALUATION_ERROR_MESSAGES: Record<string, string> = {
  CONNECTION_NOT_CONNECTABLE: 'This MLS connection is disconnected, so its valuation use cannot be changed. Nothing was saved.',
  VALIDATION_FAILED: 'Check the valuation use: each state statement needs a state (each state once), a text of at most 4,000 characters and a type size from 6 to 36 points. Nothing was saved.',
};

export function pickPack(raw: unknown): PackView {
  const o = obj(raw);
  const byKey = new Map<string, { value: unknown; counselReviewed: boolean }>();
  for (const x of Array.isArray(o.values) ? o.values : []) {
    const v = obj(x);
    if (typeof v.key === 'string') byKey.set(v.key, { value: v.value, counselReviewed: v.counselReviewed === true });
  }
  const val = (k: PackKey) => byKey.get(k)?.value;
  const hours = val('max_staleness_hours');
  const marks = Object.fromEntries(PACK_KEYS.map((k) => [k, byKey.get(k)?.counselReviewed === true])) as Record<PackKey, boolean>;
  return {
    values: {
      max_staleness_hours: typeof hours === 'number' && Number.isFinite(hours) ? hours : null,
      attribution_text: strOrNull(val('attribution_text')),
      disclaimer_text: strOrNull(val('disclaimer_text')),
      allow_rehost_photos: val('allow_rehost_photos') === true,
      require_listing_brokerage: val('require_listing_brokerage') === true,
      client_fields: list(val('client_fields'), DISPLAY_FIELDS),
      client_statuses: list(val('client_statuses'), LISTING_STATUSES),
      public_fields: list(val('public_fields'), DISPLAY_FIELDS),
      public_statuses: list(val('public_statuses'), LISTING_STATUSES),
    },
    marks,
    reviewedByCounselAt: strOrNull(o.reviewedByCounselAt),
    // never trust a count over the marks themselves
    unreviewedCount: PACK_KEYS.filter((k) => !marks[k]).length,
    sentence: str(o.sentence),
    valuation: pickValuation(o.valuation),
  };
}

export function pickMls(raw: unknown): MlsConnection[] {
  const conns = obj(raw).connections;
  return (Array.isArray(conns) ? conns : []).map((x) => {
    const c = obj(x);
    return {
      id: str(c.id),
      displayName: str(c.displayName),
      status: str(c.status),
      statusSentence: str(c.statusSentence),
      lastSyncedAt: strOrNull(c.lastSyncedAt),
      nextSyncAt: strOrNull(c.nextSyncAt),
      mlsDataAsOf: str(c.mlsDataAsOf),
      feedStale: c.feedStale === true,
      clientDisplay: c.clientDisplay === true,
      clientDisplaySentence: str(c.clientDisplaySentence),
      licensePack: pickPack(c.licensePack),
    };
  });
}

/** The PUT body: every value with its mark. */
export function packBody(values: PackValues, marks: Record<PackKey, boolean>): Record<PackKey, { value: unknown; counselReviewed: boolean }> {
  return Object.fromEntries(PACK_KEYS.map((k) => [k, { value: values[k], counselReviewed: marks[k] === true }])) as Record<PackKey, { value: unknown; counselReviewed: boolean }>;
}

export const allMarked = (marks: Record<PackKey, boolean>) => PACK_KEYS.every((k) => marks[k]);

/** "Not reviewed by counsel" words for the editor (R-MLS-2). */
export function reviewWords(marks: Record<PackKey, boolean>): { tone: 'ok' | 'warn'; title: string; text: string } {
  const open = PACK_KEYS.filter((k) => !marks[k]).length;
  if (open === 0) return { tone: 'ok', title: 'Every value is marked as reviewed by counsel', text: 'MLS listings may reach clients within these rules, as long as the data is recent enough and the attribution and disclaimer are filled in.' };
  return {
    tone: 'warn',
    title: 'Not reviewed by counsel',
    text: `MLS data cannot reach clients until every value is marked as reviewed by counsel. ${open} of ${PACK_KEYS.length} ${open === 1 ? 'value is' : 'values are'} not marked yet.`,
  };
}

export const MLS_ERROR_MESSAGES: Record<string, string> = {
  CONNECTION_NOT_CONNECTABLE: 'This MLS connection is disconnected, so its licence pack cannot be changed. Nothing was saved.',
  VALIDATION_FAILED: 'Check the licence pack: the hours must be a number above 0 (at most 8,760), and each text at most 4,000 characters. Nothing was saved.',
};
