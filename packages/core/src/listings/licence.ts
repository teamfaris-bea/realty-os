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
//
// The `valuation` section (D9; R-CMA-6, R-CMA-7) says what the agreement allows for values built from the sold
// data. It has its own counsel stamp, so adding it never changes the display pack's review state (E371):
//   valuation.agent_cma            agents may prepare CMAs (owner question (a): the Owner/Admin's statement)
//   valuation.client_cma           CMAs may be shared with clients
//   valuation.automated_notes      automated home-value notes and seller-update ranges may carry values
//   valuation.avm_flag_scope       'all_client_outputs' (default) or 'internet_display_only' (V6)
//   valuation.statements           { USPS code: { text, min_point_size } }: the state's required statement, from
//                                  counsel; an unknown code, an empty or over-long text or a size outside 6–36 is
//                                  ignored (never loosened). None is shipped (V4).
//   valuation.reviewed_by_counsel_at
// Strictest defaults: false, false, false, 'all_client_outputs', {}, null.
import { z } from 'zod';
import { instantFromIso } from '../foundation/index.js';
import { USPS_REGIONS, uspsCode } from './address.js';
import { DISPLAY_FIELDS, type DisplayField, LISTING_STATUSES, type LicensePack, type ListingStatus, type ValuationLicence, type ValuationUse } from './types.js';

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

const Reviewed = z
  .string()
  .refine((s) => instantFromIso(s) !== null)
  .nullable()
  .catch(null);

const Statements = z
  .record(z.string(), z.unknown())
  .transform((rec) => {
    const out: Record<string, { text: string; minPointSize: number }> = {};
    for (const code of Object.keys(USPS_REGIONS)) {
      const v = Object.hasOwn(rec, code) ? rec[code] : undefined;
      if (typeof v !== 'object' || v === null || Array.isArray(v)) continue;
      const o = v as Record<string, unknown>;
      const text = typeof o['text'] === 'string' ? o['text'].trim() : '';
      const size = o['min_point_size'];
      if (text.length === 0 || text.length > 4000 || typeof size !== 'number' || !Number.isFinite(size) || size < 6 || size > 36) continue;
      out[code] = { text, minPointSize: size };
    }
    return out;
  })
  .catch({});

export const STRICTEST_VALUATION_LICENCE: ValuationLicence = Object.freeze({
  agentCma: false,
  clientCma: false,
  automatedNotes: false,
  aiIsaComps: false,
  avmFlagScope: 'all_client_outputs',
  statements: Object.freeze({}),
  reviewedByCounselAt: null,
});

export const ValuationLicenceSchema = z
  .object({
    agent_cma: z.boolean().catch(false),
    client_cma: z.boolean().catch(false),
    automated_notes: z.boolean().catch(false),
    ai_isa_comps: z.boolean().catch(false),
    avm_flag_scope: z.enum(['all_client_outputs', 'internet_display_only']).catch('all_client_outputs'),
    statements: Statements,
    reviewed_by_counsel_at: Reviewed,
  })
  .transform(
    (j): ValuationLicence => ({
      agentCma: j.agent_cma,
      clientCma: j.client_cma,
      automatedNotes: j.automated_notes,
      aiIsaComps: j.ai_isa_comps,
      avmFlagScope: j.avm_flag_scope,
      statements: j.statements,
      reviewedByCounselAt: j.reviewed_by_counsel_at,
    }),
  )
  .catch(STRICTEST_VALUATION_LICENCE);

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
    valuation: ValuationLicenceSchema.optional().transform((v) => v ?? STRICTEST_VALUATION_LICENCE),
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
      valuation: j.valuation,
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
  valuation: STRICTEST_VALUATION_LICENCE,
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

export type ValuationUseResult = { ok: true } | { ok: false; reason: 'PACK_DOES_NOT_ALLOW' | 'VALUATION_NOT_REVIEWED' | 'NO_VALUATION_STATEMENT' };

/** The valuation statement for a region (a USPS code or a state name), or null. */
export function valuationStatement(pack: LicensePack, region: string | null): { text: string; minPointSize: number } | null {
  const code = region === null ? null : uspsCode(region);
  return code === null ? null : (pack.valuation.statements[code] ?? null);
}

/**
 * Whether the pack allows a valuation use (R-CMA-6, R-CMA-7; the licence part only). agent_cma needs only its value
 * (owner question (a)); client uses also need the section counsel-reviewed and a statement for the subject's state.
 * VERIFY WITH COUNSEL / MLS.
 */
export function valuationUse(pack: LicensePack, use: ValuationUse, region: string | null): ValuationUseResult {
  const v = pack.valuation;
  // an exhaustive switch (ISA-3): an unknown use never falls through to another use's value (E534)
  let allowed: boolean;
  switch (use) {
    case 'agent_cma':
      allowed = v.agentCma;
      break;
    case 'client_cma':
      allowed = v.clientCma;
      break;
    case 'automated_notes':
      allowed = v.automatedNotes;
      break;
    case 'ai_isa_comps':
      allowed = v.aiIsaComps;
      break;
    default: {
      const never: never = use;
      throw new Error(`unknown valuation use ${String(never)}`);
    }
  }
  if (!allowed) return { ok: false, reason: 'PACK_DOES_NOT_ALLOW' };
  if (use === 'agent_cma') return { ok: true };
  if (v.reviewedByCounselAt === null) return { ok: false, reason: 'VALUATION_NOT_REVIEWED' };
  if (valuationStatement(pack, region) === null) return { ok: false, reason: 'NO_VALUATION_STATEMENT' };
  return { ok: true };
}
