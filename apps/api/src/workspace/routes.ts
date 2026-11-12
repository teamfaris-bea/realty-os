// api/workspace route module (BUILD_PLAN module 14), mounted under /api by routes.ts. Authorization per
// route (rbac.ts): 'self' routes act on rows RLS lets the caller see or write (own feed, own
// notifications, tasks/appointments by the tasks/appointments policies); deal and listing routes run
// core.can on facts read from RLS-visible rows (DATA_MODEL §3). Invisible ⇒ 404 (R-PERM-5).
//
//   feed           GET /feed · POST /feed/:id/{done,snooze,dismiss}
//   tasks          GET/POST /tasks · GET/PATCH /tasks/:id
//   appointments   GET/POST /appointments · PATCH /appointments/:id · POST /appointments/:id/outcome
//   deals          GET/POST /deals · GET/PATCH /deals/:id · POST /deals/:id/stage · GET/PUT /deals/:id/financials
//                  POST /deals/:id/dates · PATCH /deal-dates/:id · POST /deals/:id/members · DELETE /deals/:id/members/:userId
//                  POST /deals/:id/contacts
//   listings       GET/POST /listings · GET/PATCH /listings/:id · PATCH /listings/:id/agent · POST /listings/:id/contacts
//   showings       GET/POST /listings/:id/showings · PATCH /showings/:id · POST /showings/:id/feedback
//   search         GET /search?q=
//   notifications  GET /notifications · POST /notifications/read · GET/PUT /notification-preferences
import type { Instant } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { withTenantTx } from '@realty/db';
import { contactFacts } from '../comms/repos/contacts.js';
import { syncReviewCards } from '../marketing/cards.js';
import { systemActor } from '../worker/systemActor.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import { appointmentById, createAppointment, listAppointments, logOutcome, updateAppointment } from './appointments.js';
import { actorOf, platformOf, wsTx } from './common.js';
import {
  addDealContact,
  addDealDate,
  addDealMember,
  changeStage,
  createDeal,
  dealById,
  dealFacts,
  dealOfDate,
  getFinancials,
  listDeals,
  putFinancials,
  removeDealMember,
  updateDeal,
  updateDealDate,
} from './deals.js';
import { actOnFeedItem, getFeed } from './feed.js';
import {
  addFeedback,
  addListingContact,
  changeListingAgent,
  createListing,
  createShowing,
  listListings,
  listingById,
  listingFacts,
  listingOfShowing,
  showingsOf,
  updateListing,
  updateShowing,
} from './listings.js';
import { listNotifications, listPreferences, markRead, putPreference } from './notifications.js';
import * as S from './schemas.js';
import { search } from './search.js';
import { createTask, listTasks, taskById, updateTask } from './tasks.js';

const idOf = (req: FastifyRequest) => (req.params as { id: string }).id;
const facts = <T>(req: FastifyRequest, fn: (tx: Tx) => Promise<T>) => wsTx(req, (tx) => fn(tx));

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const feedDeps = () => ({ envelope: app.platform.envelope, ids: app.platform.ids });

  // ---- feed ----
  r.get('/feed', { config: { auth: 'self' }, schema: { response: { 200: S.FeedResponse } } }, async (req) => wsTx(req, (tx, now, actor) => getFeed(tx, actor, feedDeps(), now)));
  for (const verb of ['done', 'dismiss'] as const) {
    r.post(`/feed/:id/${verb}`, { config: { auth: 'self' }, schema: { params: S.IdParams, response: { 200: S.FeedActionResponse } } }, async (req) => ({
      item: await wsTx(req, (tx, now, actor) => actOnFeedItem(tx, actor, req.params.id, verb, now)),
    }));
  }
  r.post('/feed/:id/snooze', { config: { auth: 'self' }, schema: { params: S.IdParams, body: S.SnoozeBody, response: { 200: S.FeedActionResponse } } }, async (req) => ({
    item: await wsTx(req, (tx, now, actor) => actOnFeedItem(tx, actor, req.params.id, 'snooze', now, Date.parse(req.body.until) as Instant)),
  }));

  // ---- tasks ----
  r.get('/tasks', { config: { auth: 'self' }, schema: { querystring: S.TasksQuery, response: { 200: S.TasksResponse } } }, async (req) => ({
    tasks: await wsTx(req, (tx, _now, actor) => listTasks(tx, actor, app.platform.envelope, req.query)),
  }));
  r.post('/tasks', { config: { auth: 'self' }, schema: { body: S.CreateTaskBody, response: { 201: S.TaskResponse } } }, async (req, reply) => {
    const task = await wsTx(req, async (tx, _now, actor) => taskById(tx, actor, app.platform.envelope, await createTask(tx, actor, app.platform.ids, req.body)));
    reply.code(201);
    return { task };
  });
  r.get('/tasks/:id', { config: { auth: 'self' }, schema: { params: S.IdParams, response: { 200: S.TaskResponse } } }, async (req) => ({
    task: await wsTx(req, (tx, _now, actor) => taskById(tx, actor, app.platform.envelope, req.params.id)),
  }));
  r.patch('/tasks/:id', { config: { auth: 'self' }, schema: { params: S.IdParams, body: S.UpdateTaskBody, response: { 200: S.TaskResponse } } }, async (req) => ({
    task: await wsTx(req, async (tx, now, actor) => {
      await updateTask(tx, actor, req.params.id, req.body, now);
      return taskById(tx, actor, app.platform.envelope, req.params.id);
    }),
  }));

  // ---- appointments ----
  r.get('/appointments', { config: { auth: 'self' }, schema: { querystring: S.AppointmentsQuery, response: { 200: S.AppointmentsResponse } } }, async (req) => ({
    appointments: await wsTx(req, (tx, _now, actor) => listAppointments(tx, actor, req.query)),
  }));
  r.post('/appointments', { config: { auth: 'self' }, schema: { body: S.CreateAppointmentBody, response: { 201: S.AppointmentResponse } } }, async (req, reply) => {
    const appointment = await wsTx(req, async (tx, _now, actor) => appointmentById(tx, await createAppointment(tx, actor, app.platform.ids, req.body)));
    reply.code(201);
    return { appointment };
  });
  r.patch('/appointments/:id', { config: { auth: 'self' }, schema: { params: S.IdParams, body: S.UpdateAppointmentBody, response: { 200: S.AppointmentResponse } } }, async (req) => ({
    appointment: await wsTx(req, async (tx) => {
      await updateAppointment(tx, req.params.id, req.body);
      return appointmentById(tx, req.params.id);
    }),
  }));
  r.post('/appointments/:id/outcome', { config: { auth: 'self' }, schema: { params: S.IdParams, body: S.OutcomeBody, response: { 200: S.AppointmentResponse } } }, async (req) => ({
    appointment: await wsTx(req, async (tx, now, actor) => {
      await logOutcome(tx, actor, req.params.id, req.body, now);
      return appointmentById(tx, req.params.id);
    }),
  }));

  // ---- deals ----
  const dealView = authorize('deal.view', (req) => facts(req, (tx) => dealFacts(tx, idOf(req))));
  const dealEdit = authorize('deal.edit', (req) => facts(req, (tx) => dealFacts(tx, idOf(req))));
  // module 31: the date routes authorize the milestone Action ("Confirm or move a milestone date", DATA_MODEL §8)
  const dealDates = authorize('milestone.confirm', (req) => facts(req, (tx) => dealFacts(tx, idOf(req))));
  const dateEdit = authorize('milestone.confirm', (req) =>
    facts(req, async (tx) => {
      const dealId = await dealOfDate(tx, idOf(req));
      return dealId ? await dealFacts(tx, dealId) : null;
    }),
  );
  const financials = authorize('deal.financials', (req) => facts(req, (tx) => dealFacts(tx, idOf(req))));

  r.get('/deals', { config: { auth: 'self' }, schema: { querystring: S.DealsQuery, response: { 200: S.DealsResponse } } }, async (req) => ({ deals: await wsTx(req, (tx, _n, actor) => listDeals(tx, actor, req.query)) }));
  r.post(
    '/deals',
    {
      config: { auth: 'deal.edit' },
      // creating a deal edits the contact's pipeline: the caller's relation to the contact decides (O / T / ✅)
      preHandler: authorize('deal.edit', (req) => facts(req, (tx) => contactFacts(tx, (req.body as { primaryContactId: string }).primaryContactId))),
      schema: { body: S.CreateDealBody, response: { 201: S.DealResponse } },
    },
    async (req, reply) => {
      const deal = await wsTx(req, async (tx, now, actor) => dealById(tx, await createDeal(tx, actor, app.platform.ids, req.body, now)));
      reply.code(201);
      return { deal };
    },
  );
  r.get('/deals/:id', { config: { auth: 'deal.view' }, preHandler: dealView, schema: { params: S.IdParams, response: { 200: S.DealResponse } } }, async (req) => ({ deal: await wsTx(req, (tx) => dealById(tx, req.params.id)) }));
  r.patch('/deals/:id', { config: { auth: 'deal.edit' }, preHandler: dealEdit, schema: { params: S.IdParams, body: S.UpdateDealBody, response: { 200: S.DealResponse } } }, async (req) => ({
    deal: await wsTx(req, async (tx) => {
      await updateDeal(tx, req.params.id, req.body);
      return dealById(tx, req.params.id);
    }),
  }));
  r.post('/deals/:id/stage', { config: { auth: 'deal.edit' }, preHandler: dealEdit, schema: { params: S.IdParams, body: S.StageBody, response: { 200: S.DealResponse } } }, async (req) => ({
    deal: await wsTx(req, async (tx, now) => {
      await changeStage(tx, req.params.id, req.body, now);
      return dealById(tx, req.params.id);
    }),
  }));
  r.get('/deals/:id/financials', { config: { auth: 'deal.financials' }, preHandler: financials, schema: { params: S.IdParams, response: { 200: S.FinancialsResponse } } }, async (req) => ({
    financials: await wsTx(req, (tx) => getFinancials(tx, req.params.id)),
  }));
  r.put('/deals/:id/financials', { config: { auth: 'deal.financials' }, preHandler: financials, schema: { params: S.IdParams, body: S.FinancialsBody, response: { 200: S.FinancialsResponse } } }, async (req) => ({
    financials: await wsTx(req, (tx, _now, actor) => putFinancials(tx, actor, req.params.id, req.body)),
  }));
  r.post('/deals/:id/dates', { config: { auth: 'milestone.confirm' }, preHandler: dealDates, schema: { params: S.IdParams, body: S.DealDateBody, response: { 201: S.DealDateResponse } } }, async (req, reply) => {
    const date = await wsTx(req, (tx, now, actor) => addDealDate(tx, actor, app.platform.ids, req.params.id, req.body, now));
    reply.code(201);
    return { date };
  });
  r.patch('/deal-dates/:id', { config: { auth: 'milestone.confirm' }, preHandler: dateEdit, schema: { params: S.IdParams, body: S.UpdateDealDateBody, response: { 200: S.DealDateResponse } } }, async (req) => ({
    date: await wsTx(req, (tx, now, actor) => updateDealDate(tx, actor, app.platform.ids, req.params.id, req.body, now)),
  }));
  r.post('/deals/:id/members', { config: { auth: 'deal.edit' }, preHandler: dealEdit, schema: { params: S.IdParams, body: S.DealMemberBody, response: { 200: S.DealResponse } } }, async (req) => ({
    deal: await wsTx(req, async (tx, _now, actor) => {
      await addDealMember(tx, actor, req.params.id, req.body.userId, req.body.role);
      return dealById(tx, req.params.id);
    }),
  }));
  r.delete('/deals/:id/members/:userId', { config: { auth: 'deal.edit' }, preHandler: dealEdit, schema: { params: S.MemberParams, response: { 200: S.DealResponse } } }, async (req) => ({
    deal: await wsTx(req, async (tx) => {
      await removeDealMember(tx, req.params.id, req.params.userId);
      return dealById(tx, req.params.id);
    }),
  }));
  r.post('/deals/:id/contacts', { config: { auth: 'deal.edit' }, preHandler: dealEdit, schema: { params: S.IdParams, body: S.DealContactBody, response: { 200: S.DealResponse } } }, async (req) => ({
    deal: await wsTx(req, async (tx) => {
      await addDealContact(tx, req.params.id, req.body.contactId, req.body.role);
      return dealById(tx, req.params.id);
    }),
  }));

  // ---- listings and showings ----
  const listingView = authorize('listing.view', (req) => facts(req, (tx) => listingFacts(tx, idOf(req))));
  const listingEdit = authorize('listing.edit', (req) => facts(req, (tx) => listingFacts(tx, idOf(req))));
  const showingEdit = authorize('listing.edit', (req) =>
    facts(req, async (tx) => {
      const l = await listingOfShowing(tx, idOf(req));
      return l ? listingFacts(tx, l) : null;
    }),
  );
  r.get('/listings', { config: { auth: 'self' }, schema: { querystring: S.ListingsQuery, response: { 200: S.ListingsResponse } } }, async (req) => ({
    listings: await wsTx(req, (tx, _n, actor) => listListings(tx, actor, req.query)),
  }));
  r.post(
    '/listings',
    {
      config: { auth: 'listing.edit' },
      preHandler: authorize('listing.edit', (req) => {
        const agent = (req.body as { listingAgentUserId?: string }).listingAgentUserId;
        return { own: agent === undefined || agent === actorOf(req).userId };
      }),
      schema: { body: S.CreateListingBody, response: { 201: S.ListingResponse } },
    },
    async (req, reply) => {
      const listing = await wsTx(req, async (tx, _n, actor) => listingById(tx, await createListing(tx, actor, app.platform.ids, req.body)));
      reply.code(201);
      return { listing };
    },
  );
  r.get('/listings/:id', { config: { auth: 'listing.view' }, preHandler: listingView, schema: { params: S.IdParams, response: { 200: S.ListingResponse } } }, async (req) => ({ listing: await wsTx(req, (tx) => listingById(tx, req.params.id)) }));
  r.patch('/listings/:id', { config: { auth: 'listing.edit' }, preHandler: listingEdit, schema: { params: S.IdParams, body: S.UpdateListingBody, response: { 200: S.ListingResponse } } }, async (req) => ({
    listing: await wsTx(req, async (tx) => {
      await updateListing(tx, req.params.id, req.body);
      return listingById(tx, req.params.id);
    }),
  }));
  // b7 ownership-data/F2: an Owner/Admin hands a listing to an active member (audited); the new agent's marketing review
  // cards are written as the system right after (a feed row of another user is not writable under the caller's RLS)
  r.patch(
    '/listings/:id/agent',
    {
      config: { auth: 'listing.reassign' },
      preHandler: authorize('listing.reassign', (req) => facts(req, (tx) => listingFacts(tx, idOf(req)))),
      schema: { params: S.IdParams, body: S.ListingAgentBody, response: { 200: S.ListingResponse } },
    },
    async (req) => {
      const listing = await wsTx(req, async (tx, _n, actor) => {
        await changeListingAgent(tx, actor, req.params.id, req.body.listingAgentUserId);
        return listingById(tx, req.params.id);
      });
      await withTenantTx(systemActor(actorOf(req).tenantId, 'worker'), (t) => syncReviewCards(t, app.platform.ids, req.params.id), { db: app.platform.db, retries: 2 });
      return { listing };
    },
  );
  r.post('/listings/:id/contacts', { config: { auth: 'listing.edit' }, preHandler: listingEdit, schema: { params: S.IdParams, body: S.ListingContactBody, response: { 200: S.ListingResponse } } }, async (req) => ({
    listing: await wsTx(req, async (tx) => {
      await addListingContact(tx, req.params.id, req.body.contactId, req.body.role);
      return listingById(tx, req.params.id);
    }),
  }));
  r.get('/listings/:id/showings', { config: { auth: 'listing.view' }, preHandler: listingView, schema: { params: S.IdParams, response: { 200: S.ShowingsResponse } } }, async (req) => ({
    showings: await wsTx(req, (tx) => showingsOf(tx, req.params.id)),
  }));
  r.post('/listings/:id/showings', { config: { auth: 'listing.edit' }, preHandler: listingEdit, schema: { params: S.IdParams, body: S.CreateShowingBody, response: { 201: S.ShowingResponse } } }, async (req, reply) => {
    const showing = await wsTx(req, async (tx, _n, actor) => {
      const id = await createShowing(tx, actor, app.platform.ids, req.params.id, req.body);
      return (await showingsOf(tx, req.params.id, id))[0]!;
    });
    reply.code(201);
    return { showing };
  });
  r.patch('/showings/:id', { config: { auth: 'listing.edit' }, preHandler: showingEdit, schema: { params: S.IdParams, body: S.UpdateShowingBody, response: { 200: S.ShowingResponse } } }, async (req) => ({
    showing: await wsTx(req, async (tx) => {
      await updateShowing(tx, req.params.id, req.body.status);
      const l = (await listingOfShowing(tx, req.params.id))!;
      return (await showingsOf(tx, l, req.params.id))[0]!;
    }),
  }));
  r.post('/showings/:id/feedback', { config: { auth: 'listing.edit' }, preHandler: showingEdit, schema: { params: S.IdParams, body: S.FeedbackBody, response: { 201: S.ShowingResponse } } }, async (req, reply) => {
    const showing = await wsTx(req, async (tx, now) => {
      await addFeedback(tx, app.platform.ids, req.params.id, req.body, new Date(now).toISOString());
      const l = (await listingOfShowing(tx, req.params.id))!;
      return (await showingsOf(tx, l, req.params.id))[0]!;
    });
    reply.code(201);
    return { showing };
  });

  // ---- search ----
  r.get('/search', { config: { auth: 'self' }, schema: { querystring: S.SearchQuery, response: { 200: S.SearchResponse } } }, async (req) => search(platformOf(req).db, actorOf(req), req.query.q));

  // ---- notifications ----
  r.get('/notifications', { config: { auth: 'self' }, schema: { querystring: S.NotificationsQuery, response: { 200: S.NotificationsResponse } } }, async (req) =>
    wsTx(req, (tx, _n, actor) => listNotifications(tx, actor, req.query)),
  );
  r.post('/notifications/read', { config: { auth: 'self' }, schema: { body: S.ReadBody, response: { 200: S.ReadResponse } } }, async (req) =>
    wsTx(req, (tx, now, actor) => markRead(tx, actor, req.body as { ids?: string[]; all?: true }, now)),
  );
  r.get('/notification-preferences', { config: { auth: 'self' }, schema: { response: { 200: S.PreferencesResponse } } }, async (req) => ({
    preferences: await wsTx(req, (tx, _n, actor) => listPreferences(tx, actor)),
  }));
  r.put('/notification-preferences', { config: { auth: 'self' }, schema: { body: S.PreferenceBody, response: { 200: S.PreferenceResponse } } }, async (req) => ({
    preference: await wsTx(req, (tx, _n, actor) => putPreference(tx, actor, req.body)),
  }));
}

export const workspaceRoutes: RouteModule = { name: 'workspace', register };
