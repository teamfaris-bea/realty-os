// Team listings, showings and showing feedback (BUILD_PLAN module 14; A4 seller-update data, C21).
//
//   GET  /listings, GET /listings/:id            every member reads the team's inventory                 self / listing.view
//   POST /listings                               create (listing agent: self; TL/Admin/Owner anyone)     listing.edit
//   PATCH /listings/:id                          edit; a price change appends listing_price_history      listing.edit
//   POST /listings/:id/contacts                  seller / interested contacts                            listing.edit
//   GET  /listings/:id/showings                  showings with their feedback                            listing.view
//   POST /listings/:id/showings, PATCH /showings/:id, POST /showings/:id/feedback                         listing.edit
//
// Writes are the listing writers' (RLS listing_writable: the listing agent, a Team Lead, Owner/Admin; the
// matrix agrees: agents edit their own). A new listing or a price change enqueues
// assistant.match_listing, which matches active saved searches and sends alerts through the gate
// (api/assistant); the price history row is written by the DB trigger, never by this code.
// Seller-update ASSEMBLY is Phase 2; Phase 1 only captures showings and feedback.
import type { IdGenerator, ResourceFacts, UserActor } from '@realty/core/foundation';
import { enqueueJob, type Tx } from '@realty/db';
import { sql } from 'kysely';
import type { z } from 'zod';
import { ASSISTANT_JOBS } from '../assistant/types.js';
import { audit, redactDiff } from '../audit.js';
import { AppError } from '../errors.js';
import { assertAssignable, iso, isoOrNull } from './common.js';
import type { CreateListingBody, CreateShowingBody, FeedbackBody, ListingDetailSchema, ListingSchema, ListingsQuery, ShowingSchema, UpdateListingBody } from './schemas.js';
import { assertRefsVisible } from './tasks.js';
import { enqueueTeamListingChange } from '../nurture/detect.js';
import type { ListingStatus } from '@realty/core/nurture';

export type ListingView = z.infer<typeof ListingSchema>;
export type ListingDetail = z.infer<typeof ListingDetailSchema>;
export type ShowingView = z.infer<typeof ShowingSchema>;

/** The caller's relation to a visible listing: own = listing agent (null: invisible / nonexistent). */
export async function listingFacts(tx: Tx, listingId: string): Promise<ResourceFacts | null> {
  const r = await sql<{ own: boolean }>`
    SELECT listing_agent_user_id IS NOT DISTINCT FROM app.user_id() AS own FROM listings WHERE tenant_id = app.tenant_id() AND id = ${listingId}`.execute(tx);
  return r.rows[0] ? { own: r.rows[0].own === true } : null;
}

export async function listingOfShowing(tx: Tx, showingId: string): Promise<string | null> {
  const r = await sql<{ listing_id: string }>`SELECT listing_id FROM showings WHERE tenant_id = app.tenant_id() AND id = ${showingId}`.execute(tx);
  return r.rows[0]?.listing_id ?? null;
}

interface ListingRow {
  id: string;
  source: 'team' | 'mls';
  mls_number: string | null;
  status: ListingView['status'];
  address_line1: string;
  address_line2: string | null;
  city: string;
  region: string;
  postal_code: string;
  list_price_cents: string | null;
  beds: number | null;
  baths_x10: number | null;
  sqft: number | null;
  property_type: ListingView['propertyType'];
  listing_agent_user_id: string | null;
  description: string | null;
  list_date: string | null;
  editable: boolean;
  created_at: Date;
}

const SELECT = sql`
  SELECT l.id, l.source, l.mls_number, l.status, l.address_line1, l.address_line2, l.city, l.region, l.postal_code, l.list_price_cents, l.beds, l.baths_x10,
         l.sqft, l.property_type, l.listing_agent_user_id, l.description, l.list_date::text AS list_date, app.listing_writable(l.tenant_id, l.id) AS editable, l.created_at
    FROM listings l`;

function view(r: ListingRow): ListingView {
  return {
    id: r.id,
    source: r.source,
    mlsNumber: r.mls_number,
    status: r.status,
    addressLine1: r.address_line1,
    addressLine2: r.address_line2,
    city: r.city,
    region: r.region,
    postalCode: r.postal_code,
    listPriceCents: r.list_price_cents === null ? null : Number(r.list_price_cents),
    beds: r.beds,
    bathsX10: r.baths_x10,
    sqft: r.sqft,
    propertyType: r.property_type,
    listingAgentUserId: r.listing_agent_user_id,
    description: r.description,
    listDate: r.list_date,
    editable: r.editable === true,
    createdAt: iso(r.created_at),
  };
}

export async function listListings(tx: Tx, actor: UserActor, q: z.infer<typeof ListingsQuery>): Promise<ListingView[]> {
  const mine = q.mine === 'true';
  const r = await sql<ListingRow>`${SELECT}
     WHERE l.tenant_id = app.tenant_id() AND l.source = 'team'
       AND (${q.status ?? null}::text IS NULL OR l.status = ${q.status ?? null})
       AND (NOT ${mine} OR l.listing_agent_user_id = ${actor.userId})
     ORDER BY (l.status IN ('active','coming_soon','pending')) DESC, l.list_date DESC NULLS LAST, l.created_at DESC LIMIT ${q.limit ?? 100}`.execute(tx);
  return r.rows.map(view);
}

export async function listingById(tx: Tx, id: string): Promise<ListingDetail> {
  const r = await sql<ListingRow>`${SELECT} WHERE l.tenant_id = app.tenant_id() AND l.id = ${id}`.execute(tx);
  if (!r.rows[0]) throw new AppError('NOT_FOUND');
  const [history, contacts, showings] = await Promise.all([
    sql<{ price_cents: string; changed_at: Date }>`SELECT price_cents, changed_at FROM listing_price_history WHERE tenant_id = app.tenant_id() AND listing_id = ${id} ORDER BY changed_at, id`.execute(tx),
    // listing_contacts follow the contact's detail visibility (RLS): a contact the caller cannot see is not listed
    sql<{ contact_id: string; role: 'seller' | 'co_seller' | 'interested' }>`SELECT contact_id, role FROM listing_contacts WHERE tenant_id = app.tenant_id() AND listing_id = ${id} ORDER BY role, contact_id`.execute(tx),
    sql<{ total: number; completed: number; with_feedback: number }>`
      SELECT count(*)::int AS total, count(*) FILTER (WHERE s.status = 'completed')::int AS completed,
             count(*) FILTER (WHERE EXISTS (SELECT 1 FROM showing_feedback f WHERE f.tenant_id = s.tenant_id AND f.showing_id = s.id))::int AS with_feedback
        FROM showings s WHERE s.tenant_id = app.tenant_id() AND s.listing_id = ${id}`.execute(tx),
  ]);
  const s = showings.rows[0] ?? { total: 0, completed: 0, with_feedback: 0 };
  return {
    ...view(r.rows[0]),
    priceHistory: history.rows.map((h) => ({ priceCents: Number(h.price_cents), changedAt: iso(h.changed_at) })),
    contacts: contacts.rows.map((c) => ({ contactId: c.contact_id, role: c.role })),
    showings: { total: s.total, completed: s.completed, withFeedback: s.with_feedback },
  };
}

async function enqueueMatch(tx: Tx, listingId: string): Promise<void> {
  await enqueueJob(tx, { queue: 'default', kind: ASSISTANT_JOBS.matchListing, payload: { listingId }, dedupeKey: `${ASSISTANT_JOBS.matchListing}:${listingId}` });
}

export async function createListing(tx: Tx, actor: UserActor, ids: IdGenerator, b: z.infer<typeof CreateListingBody>): Promise<string> {
  const agent = b.listingAgentUserId ?? actor.userId;
  if (agent !== actor.userId) await assertAssignable(tx, actor, agent, { canOwnLeads: true });
  const id = ids.next<'ListingId'>();
  await sql`
    INSERT INTO listings (tenant_id, id, source, mls_number, status, address_line1, address_line2, city, region, postal_code, list_price_cents, beds, baths_x10,
                          sqft, property_type, listing_agent_user_id, description, list_date)
    VALUES (app.tenant_id(), ${id}, 'team', ${b.mlsNumber ?? null}, ${b.status ?? 'coming_soon'}, ${b.addressLine1}, ${b.addressLine2 ?? null}, ${b.city},
            ${b.region}, ${b.postalCode}, ${b.listPriceCents ?? null}, ${b.beds ?? null}, ${b.bathsX10 ?? null}, ${b.sqft ?? null}, ${b.propertyType ?? null},
            ${agent}, ${b.description ?? null}, ${b.listDate ?? null}::date)`.execute(tx);
  await enqueueMatch(tx, id);
  return id;
}

const LISTING_COLUMNS = {
  status: 'status',
  mlsNumber: 'mls_number',
  addressLine1: 'address_line1',
  addressLine2: 'address_line2',
  city: 'city',
  region: 'region',
  postalCode: 'postal_code',
  listPriceCents: 'list_price_cents',
  beds: 'beds',
  bathsX10: 'baths_x10',
  sqft: 'sqft',
  propertyType: 'property_type',
  description: 'description',
  listDate: 'list_date',
} as const;

export async function updateListing(tx: Tx, id: string, b: z.infer<typeof UpdateListingBody>): Promise<void> {
  const cur = await sql<{ list_price_cents: string | null; status: string; source: string }>`
    SELECT list_price_cents, status, source FROM listings WHERE tenant_id = app.tenant_id() AND id = ${id} FOR UPDATE`.execute(tx);
  const c = cur.rows[0];
  if (!c) throw new AppError('NOT_FOUND');
  if (c.source !== 'team') throw new AppError('NOT_FOUND'); // MLS rows are written by the system only
  const sets = Object.entries(LISTING_COLUMNS)
    .filter(([k]) => (b as Record<string, unknown>)[k] !== undefined)
    .map(([k, col]) => {
      const v = (b as Record<string, unknown>)[k] ?? null;
      return col === 'list_date' ? sql`${sql.ref(col)} = ${v}::date` : sql`${sql.ref(col)} = ${v}`;
    });
  if (sets.length === 0) return;
  await sql`UPDATE listings SET ${sql.join(sets, sql`, `)}, updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  const priceChanged = b.listPriceCents !== undefined && String(b.listPriceCents ?? '') !== String(c.list_price_cents ?? '');
  const statusChanged = b.status !== undefined && b.status !== c.status;
  if (priceChanged || statusChanged) await enqueueMatch(tx, id);
  // module 26 (flagged): a price decrease or a return to market on a followed home is a trigger fact (R-NURT-2)
  await enqueueTeamListingChange(tx, { listingId: id, before: { status: c.status as ListingStatus, priceCents: c.list_price_cents === null ? null : Number(c.list_price_cents) }, priceChanged, statusChanged });
}

/**
 * PATCH /listings/:id/agent (listing.reassign; b7 ownership-data/F2): an Owner/Admin hands a team listing to another
 * active member who may own leads (not a TC). Audited. The listing's open seller-update draft of the previous agent is
 * retired by the next seller-update reconcile (changed agent: invalidated, the same period drafted for the new agent),
 * and its "no active listing agent" card closes there too. Sellers and other listing roles are not touched.
 */
export async function changeListingAgent(tx: Tx, actor: UserActor, listingId: string, agentUserId: string): Promise<void> {
  const cur = await sql<{ source: string; agent: string | null }>`
    SELECT source, listing_agent_user_id AS agent FROM listings WHERE tenant_id = app.tenant_id() AND id = ${listingId} FOR UPDATE`.execute(tx);
  const c = cur.rows[0];
  if (!c || c.source !== 'team') throw new AppError('NOT_FOUND'); // MLS rows have no listing agent of ours
  if (c.agent === agentUserId) return;
  await assertAssignable(tx, actor, agentUserId, { canOwnLeads: true });
  await sql`UPDATE listings SET listing_agent_user_id = ${agentUserId}, updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${listingId}`.execute(tx);
  await audit(tx, actor, { action: 'listing.agent_changed', entity: { type: 'listing', id: listingId }, changes: redactDiff({ listing_agent_user_id: c.agent }, { listing_agent_user_id: agentUserId }) });
}

export async function addListingContact(tx: Tx, listingId: string, contactId: string, role: string): Promise<void> {
  await assertRefsVisible(tx, { contactId });
  await sql`INSERT INTO listing_contacts (tenant_id, listing_id, contact_id, role) VALUES (app.tenant_id(), ${listingId}, ${contactId}, ${role})
            ON CONFLICT (tenant_id, listing_id, contact_id) DO UPDATE SET role = EXCLUDED.role`.execute(tx);
}

// ---- showings ------------------------------------------------------------------------------------------------

export async function showingsOf(tx: Tx, listingId: string, showingId?: string): Promise<ShowingView[]> {
  const s = await sql<{ id: string; listing_id: string; starts_at: Date; ends_at: Date | null; buyer_agent_name: string | null; buyer_agent_brokerage: string | null; buyer_contact_id: string | null; status: ShowingView['status']; source: ShowingView['source'] }>`
    SELECT id, listing_id, starts_at, ends_at, buyer_agent_name, buyer_agent_brokerage, buyer_contact_id, status, source FROM showings
     WHERE tenant_id = app.tenant_id() AND listing_id = ${listingId} AND (${showingId ?? null}::uuid IS NULL OR id = ${showingId ?? null}::uuid)
     ORDER BY starts_at DESC, id LIMIT 200`.execute(tx);
  const ids = s.rows.map((x) => x.id);
  const f =
    ids.length === 0
      ? { rows: [] }
      : await sql<{ id: string; showing_id: string; rating: number | null; comments: string | null; source: string; received_at: Date }>`
          SELECT id, showing_id, rating, comments, source, received_at FROM showing_feedback WHERE tenant_id = app.tenant_id() AND showing_id = ANY (${ids}::uuid[])
           ORDER BY received_at, id`.execute(tx);
  return s.rows.map((x) => ({
    id: x.id,
    listingId: x.listing_id,
    startsAt: iso(x.starts_at),
    endsAt: isoOrNull(x.ends_at),
    buyerAgentName: x.buyer_agent_name,
    buyerAgentBrokerage: x.buyer_agent_brokerage,
    // a buyer contact the caller cannot see is not named (RLS on contacts decides; the id stays a reference)
    buyerContactId: x.buyer_contact_id,
    status: x.status,
    source: x.source,
    feedback: f.rows.filter((y) => y.showing_id === x.id).map((y) => ({ id: y.id, rating: y.rating, comments: y.comments, source: y.source, receivedAt: iso(y.received_at) })),
  }));
}

export async function createShowing(tx: Tx, actor: UserActor, ids: IdGenerator, listingId: string, b: z.infer<typeof CreateShowingBody>): Promise<string> {
  if (b.buyerContactId) await assertRefsVisible(tx, { contactId: b.buyerContactId });
  const id = ids.next<'ShowingId'>();
  await sql`
    INSERT INTO showings (tenant_id, id, listing_id, starts_at, ends_at, buyer_agent_name, buyer_agent_brokerage, buyer_contact_id, status, source, created_by_user_id)
    VALUES (app.tenant_id(), ${id}, ${listingId}, ${b.startsAt}::timestamptz, ${b.endsAt ?? null}::timestamptz, ${b.buyerAgentName ?? null},
            ${b.buyerAgentBrokerage ?? null}, ${b.buyerContactId ?? null}, ${b.status ?? 'scheduled'}, 'manual', ${actor.userId})`.execute(tx);
  return id;
}

export async function updateShowing(tx: Tx, id: string, status: ShowingView['status']): Promise<void> {
  const r = await sql`UPDATE showings SET status = ${status}, updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  if (Number(r.numAffectedRows ?? 0) === 0) throw new AppError('NOT_FOUND');
}

export async function addFeedback(tx: Tx, ids: IdGenerator, showingId: string, b: z.infer<typeof FeedbackBody>, nowIso: string): Promise<void> {
  await sql`
    INSERT INTO showing_feedback (tenant_id, id, showing_id, rating, comments, source, received_at)
    VALUES (app.tenant_id(), ${ids.next<'ShowingFeedbackId'>()}, ${showingId}, ${b.rating ?? null}, ${b.comments ?? null}, 'manual', ${b.receivedAt ?? nowIso}::timestamptz)`.execute(tx);
}
