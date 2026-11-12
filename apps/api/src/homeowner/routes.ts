// api/homeowner route module (module 78; owner decision D10), mounted under /api by routes.ts:
//   GET /contacts/:id/homeowner   the internal homeowner profile panel: recognition reasons, per home the county,
//                                 the check state, each value with its source and date or why it is missing, years
//                                 owned, whether tax mail goes elsewhere, the loans link, the D9 slots, and the
//                                 outreach line                                                  contact.view_detail
// Read-only, under the viewer's RLS (R-HOME-8): profiles and facts follow the contact's detail visibility; a past
// buyer's date is shown only when the viewer can see the deal; a contact the viewer cannot see is 404 (R-PERM-5).
// No audit row, no new error code, no home_valuations read (decision (d)), no write of any kind.
import type { UserActor } from '@realty/core/foundation';
import { HOMEOWNER_FIELDS, RECOGNITION_REASONS, homeownerView, type HomeownerFacts, type HomeownerField, type RecognitionReason, type ViewHome } from '@realty/core/homeowner';
import { withTenantTx } from '@realty/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { contactFacts } from '../comms/repos/contacts.js';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import * as R from './repos.js';
import { HomeownerResponse, type HomeownerResponseT } from './schemas.js';
import { HOMEOWNER_SETTINGS } from './settings.js';

const IdParams = z.object({ id: z.uuid() });

function actorOf(req: FastifyRequest): UserActor {
  if (!req.actor) throw new AppError('UNAUTHENTICATED');
  return req.actor;
}

function factsOf(rows: R.ViewFactRow[]): HomeownerFacts {
  const out: Record<string, unknown> = {};
  for (const f of rows) {
    if (!(HOMEOWNER_FIELDS as readonly string[]).includes(f.field)) continue;
    const value = f.date_value ?? (f.cents_value !== null ? Number(f.cents_value) : null) ?? f.int_value ?? f.bool_value ?? f.text_value;
    if (value === null) continue;
    out[f.field as HomeownerField] = { value, source: f.source, asOf: f.as_of };
  }
  return out as HomeownerFacts;
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const db = () => app.platform.db;

  r.get(
    '/contacts/:id/homeowner',
    {
      config: { auth: 'contact.view_detail' },
      preHandler: authorize('contact.view_detail', (req) => withTenantTx(actorOf(req), (tx) => contactFacts(tx, (req.params as { id: string }).id), { db: db() })),
      schema: { params: IdParams, response: { 200: HomeownerResponse } },
    },
    async (req): Promise<HomeownerResponseT> => {
      const provider = app.platform.providers.publicRecords;
      return withTenantTx(actorOf(req), async (tx) => {
        const v = await R.viewReasons(tx, req.params.id, HOMEOWNER_SETTINGS.homeownerTagKeys);
        if (!v) throw new AppError('NOT_FOUND');
        const homes = await R.viewHomes(tx, req.params.id, v.tz);
        const facts = await R.viewFacts(tx, homes.map((h) => h.profile_id).filter((x): x is string => x !== null));
        // reasons the viewer can see, unioned with the labels stored on the profiles they can see
        const stored = new Set(homes.flatMap((h) => h.recognized_by ?? []));
        const visible: Record<RecognitionReason, boolean> = { seller_intent: v.seller_intent, seller_inquiry: v.seller_inquiry, homeowner_tag: v.homeowner_tag, past_buyer: v.past_buyer };
        // a date only where the viewer may see it: a past buyer's closing (the deal), the latest seller inquiry (owner question 16)
        const since = (reason: RecognitionReason): string | null =>
          reason === 'past_buyer' && v.past_buyer ? v.past_buyer_since : reason === 'seller_inquiry' && v.seller_inquiry ? v.seller_inquiry_on : null;
        const reasons = RECOGNITION_REASONS.filter((x) => visible[x] || stored.has(x)).map((reason) => ({ reason, since: since(reason) }));
        const viewHomes: ViewHome[] = homes.map((h) => ({
          address: { line1: h.line1 ?? '', line2: h.line2, city: h.city ?? '', region: h.region ?? '', postalCode: h.postal_code ?? '' },
          kind: h.kind,
          teamClosingOn: h.team_closed_on,
          profile: h.profile_id === null ? null : {
            status: h.status as never,
            matchDetail: h.match_detail as never,
            source: h.source,
            checkedOn: h.checked_on,
            lastFailureOn: h.last_failure_on,
            lastFailureCode: h.last_failure_code as never,
            nextCheckOn: h.next_check_on!,
            facts: factsOf(facts.filter((f) => f.profile_id === h.profile_id)),
          },
        }));
        return homeownerView({ today: v.today, configured: provider.configured, test: provider.test, statusText: provider.statusText, reasons, homes: viewHomes, mergedRecords: v.merged_records, outreachClearanceOn: v.clearance_on });
      }, { db: db() });
    },
  );
}

export const homeownerRoutes: RouteModule = { name: 'homeowner', register };
