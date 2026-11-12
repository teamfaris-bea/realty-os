// The MLS admin view and the licence-pack editor's model (GET /admin/mls, PUT /admin/mls/connections/:id/license-pack;
// apps/api/src/mls/admin.ts). Pure; copied field by field from responses.
//
// R-MLS-2: the pack counts as counsel-reviewed only when EVERY value is marked reviewed; until then no MLS listing
// reaches a client. The editor says so, and changing a value clears its mark (counsel reviewed the old value).
// Every value is VERIFY WITH COUNSEL / MLS; nothing here encodes a particular MLS's rules.

/** Fields a licence pack can allow per audience (packages/core listings DISPLAY_FIELDS; the server drops unknown ones). */
export const DISPLAY_FIELDS = ['mlsNumber', 'status', 'listPrice', 'beds', 'baths', 'sqft', 'propertyType', 'description', 'listDate', 'address', 'locality', 'photos'] as const;
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

export interface PackView {
  values: PackValues;
  marks: Record<PackKey, boolean>;
  reviewedByCounselAt: string | null;
  unreviewedCount: number;
  sentence: string;
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
