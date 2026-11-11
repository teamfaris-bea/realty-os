// The MLS licence pack: `integration_connections.license_pack` (R-MLS-2, R-MLS-3, R-MLS-4).
//
// The Owner/Admin enters the pack from their MLS agreement (ARCHITECTURE F10: licences are per
// brokerage). Its keys are snake_case JSON. VERIFY WITH COUNSEL / MLS: every value below. Nothing here
// encodes a particular MLS's rules; the pack carries them.
//
// Strictest defaults, per key: a key that is missing or invalid parses to the value that shows the
// least and pauses the most. So the empty pack `{}` (the column default) shows nothing to clients or
// the public, treats the feed as always stale, references photos by URL and requires the brokerage.
// One bad key never loosens another.
import { z } from 'zod';
import { instantFromIso } from '../foundation/index.js';
import { DISPLAY_FIELDS, type DisplayField, LISTING_STATUSES, type LicensePack, type ListingStatus } from './types.js';

const FIELD_SET: ReadonlySet<string> = new Set(DISPLAY_FIELDS);
const STATUS_SET: ReadonlySet<string> = new Set(LISTING_STATUSES);

/** A non-empty trimmed text, else null. */
const Text = z
  .string()
  .transform((s) => s.trim())
  .refine((s) => s.length > 0 && s.length <= 4000)
  .nullable()
  .catch(null);

/** Known names only, deduplicated, in canonical order (unknown names are ignored: never widen). */
function knownList<T extends string>(order: readonly T[], known: ReadonlySet<string>) {
  return z
    .array(z.unknown())
    .transform((xs) => order.filter((k) => known.has(k) && xs.includes(k)))
    .catch([]);
}

const AudienceSchema = z
  .object({
    fields: knownList<DisplayField>(DISPLAY_FIELDS, FIELD_SET),
    statuses: knownList<ListingStatus>(LISTING_STATUSES, STATUS_SET),
  })
  .catch({ fields: [], statuses: [] });

/** The stored JSON shape (snake_case). Every key optional; each falls back to its strictest value. */
export const LicensePackSchema = z
  .object({
    reviewed_by_counsel_at: z
      .string()
      .refine((s) => instantFromIso(s) !== null)
      .nullable()
      .catch(null),
    max_staleness_hours: z.number().positive().max(24 * 365).nullable().catch(null),
    attribution_text: Text,
    disclaimer_text: Text,
    allow_rehost_photos: z.boolean().catch(false),
    require_listing_brokerage: z.boolean().catch(true),
    audiences: z
      .object({ client: AudienceSchema, public: AudienceSchema })
      .catch({ client: { fields: [], statuses: [] }, public: { fields: [], statuses: [] } }),
  })
  .transform(
    (j): LicensePack => ({
      reviewedByCounselAt: j.reviewed_by_counsel_at,
      maxStalenessHours: j.max_staleness_hours,
      attributionText: j.attribution_text,
      disclaimerText: j.disclaimer_text,
      allowRehostPhotos: j.allow_rehost_photos,
      requireListingBrokerage: j.require_listing_brokerage,
      audiences: j.audiences,
    }),
  );

/** The strictest pack: what `{}` (the column default) parses to. */
export const STRICTEST_LICENSE_PACK: LicensePack = Object.freeze({
  reviewedByCounselAt: null,
  maxStalenessHours: null,
  attributionText: null,
  disclaimerText: null,
  allowRehostPhotos: false,
  requireListingBrokerage: true,
  audiences: Object.freeze({
    client: Object.freeze({ fields: [], statuses: [] }),
    public: Object.freeze({ fields: [], statuses: [] }),
  }),
});

/** Parses a stored licence pack. Never throws; anything missing or invalid becomes its strictest value. */
export function parseLicensePack(json: unknown): LicensePack {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) return STRICTEST_LICENSE_PACK;
  const r = LicensePackSchema.safeParse(json);
  /* v8 ignore next -- every key has a .catch fallback, so a plain object always parses */
  return r.success ? r.data : STRICTEST_LICENSE_PACK;
}

/** Whether the pack is counsel-reviewed (R-MLS-2). VERIFY WITH COUNSEL / MLS. */
export function packReviewed(pack: LicensePack): boolean {
  return pack.reviewedByCounselAt !== null;
}
