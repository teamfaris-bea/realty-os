// api/mls routes, mounted under /api (PHASE2_3_PLAN §5.4 #24).
//
//   GET /listings/:id/competing                       competing listings, agent view       listing.view (every member)
//   GET /admin/mls                                    MLS connections and licence packs    integration.view (Owner/Admin)
//   PUT /admin/mls/connections/:id/license-pack       the licence-pack editor              integration.manage (Owner/Admin 🔒)
//
// Every handler runs in the caller's tenant transaction under RLS: another tenant's listing or connection is
// 404. CSRF and Origin are the global guard's; re-auth comes from integration.manage. Response schemas carry
// no tenant id and no confidence score.
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { DISPLAY_FIELDS, LISTING_STATUSES } from '@realty/core/listings';
import { actorOf, adminTx } from '../admin/common.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import { listingFacts } from '../workspace/listings.js';
import { PACK_KEYS, mlsAdminView, saveLicensePack, type PackInput } from './admin.js';
import { competingFor } from './competing.js';

const IdParams = z.object({ id: z.uuid() });
const Text = z.string().trim().min(1).max(4000).nullable();
const Field = z.enum(DISPLAY_FIELDS);
const Status = z.enum(LISTING_STATUSES);
const mark = <T extends z.ZodType>(v: T) => z.object({ value: v, counselReviewed: z.boolean() }).strict();

export const LicensePackBody = z
  .object({
    max_staleness_hours: mark(z.number().positive().max(24 * 365).nullable()),
    attribution_text: mark(Text),
    disclaimer_text: mark(Text),
    allow_rehost_photos: mark(z.boolean()),
    require_listing_brokerage: mark(z.boolean()),
    client_fields: mark(z.array(Field).max(DISPLAY_FIELDS.length)),
    client_statuses: mark(z.array(Status).max(LISTING_STATUSES.length)),
    public_fields: mark(z.array(Field).max(DISPLAY_FIELDS.length)),
    public_statuses: mark(z.array(Status).max(LISTING_STATUSES.length)),
  })
  .strict();

const PackValue = z.union([z.number(), z.string(), z.boolean(), z.null(), z.array(z.string())]);
export const PackViewSchema = z.object({
  values: z.array(z.object({ key: z.enum(PACK_KEYS), value: PackValue, counselReviewed: z.boolean() })),
  reviewedByCounselAt: z.string().nullable(),
  unreviewedCount: z.number(),
  sentence: z.string(),
});
export const MlsAdminResponse = z.object({
  connections: z.array(
    z.object({
      id: z.uuid(),
      displayName: z.string(),
      status: z.string(),
      statusSentence: z.string(),
      lastSyncedAt: z.string().nullable(),
      nextSyncAt: z.string().nullable(),
      mlsDataAsOf: z.string(),
      feedStale: z.boolean(),
      clientDisplay: z.boolean(),
      clientDisplaySentence: z.string(),
      licensePack: PackViewSchema,
    }),
  ),
});

const Photo = z.object({ url: z.string(), mode: z.enum(['reference', 'rehost_allowed']) });
const Display = z.object({
  id: z.string().nullable(),
  source: z.enum(['team', 'mls']),
  sourceLabel: z.enum(['MLS', 'Team']),
  isTeamListing: z.boolean(),
  listingBrokerageName: z.string().nullable(),
  attribution: z.string().nullable(),
  disclaimer: z.string().nullable(),
  addressHidden: z.boolean(),
  mlsNumber: z.string().nullable().optional(),
  status: z.string().optional(),
  listPriceCents: z.number().nullable().optional(),
  beds: z.number().nullable().optional(),
  bathsX10: z.number().nullable().optional(),
  sqft: z.number().nullable().optional(),
  propertyType: z.string().nullable().optional(),
  address: z.object({ line1: z.string(), line2: z.string().nullable() }).optional(),
  locality: z.object({ city: z.string(), region: z.string(), postalCode: z.string() }).optional(),
  description: z.string().nullable().optional(),
  listDate: z.string().nullable().optional(),
  omittedFields: z.array(z.string()).readonly(),
  photos: z.array(Photo).readonly().optional(),
});
export const CompetingResponse = z.object({
  subjectId: z.uuid(),
  listings: z.array(Display).readonly(),
  why: z.array(z.object({ listing: z.string(), criterion: z.string(), detail: z.string() })),
  mirrorMismatches: z.array(z.object({ teamListingId: z.string(), mlsListing: z.string(), teamStatus: z.string(), mlsStatus: z.string() })),
  mlsPaused: z.boolean(),
  mlsDataAsOf: z.string().nullable(),
});

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const listingView = authorize('listing.view', (req) => adminTx(req, (tx) => listingFacts(tx, (req.params as { id: string }).id)));
  const view = { config: { auth: 'integration.view' as const }, preHandler: authorize('integration.view', () => ({})) };
  const manage = { config: { auth: 'integration.manage' as const }, preHandler: authorize('integration.manage', () => ({})) };

  r.get('/listings/:id/competing', { config: { auth: 'listing.view' }, preHandler: listingView, schema: { params: IdParams, response: { 200: CompetingResponse } } }, async (req) =>
    adminTx(req, (tx, now) => competingFor(tx, req.params.id, now)),
  );

  r.get('/admin/mls', { ...view, schema: { response: { 200: MlsAdminResponse } } }, async (req) => adminTx(req, (tx, now) => mlsAdminView(tx, now)));

  r.put('/admin/mls/connections/:id/license-pack', { ...manage, bodyLimit: 64 * 1024, schema: { params: IdParams, body: LicensePackBody, response: { 200: z.object({ licensePack: PackViewSchema }) } } }, async (req) => ({
    licensePack: await adminTx(req, (tx, now) => saveLicensePack(tx, actorOf(req), req.params.id, req.body as PackInput, now)),
  }));
}

export const mlsRoutes: RouteModule = { name: 'mls', register };
