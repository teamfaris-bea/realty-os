// Listings, price history, showings and feedback over real Postgres as app_user (BUILD_PLAN module 14;
// A4 seller-update data; DATA_MODEL §3 listings view/edit; R-PERM-5).
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { call, contactOf, type WorkspaceWorld, workspaceWorld } from './testing.js';

let h: ApiHarness;
let w: WorkspaceWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await workspaceWorld(h, { agents: 2, teamLead: true, others: ['isa'] });
});
afterAll(async () => {
  await h?.close();
});

interface Listing {
  id: string;
  editable: boolean;
  listPriceCents: number | null;
  priceHistory: { priceCents: number }[];
  showings: { total: number; completed: number; withFeedback: number };
  contacts: { contactId: string; role: string }[];
}

const base = { addressLine1: '742 Evergreen Terrace', city: 'Springfield', region: 'OR', postalCode: '97477', listPriceCents: 52_500_000, beds: 4, bathsX10: 25, propertyType: 'single_family', status: 'active' };

describe('listings', () => {
  it('an agent lists their own home; every member reads it; only the listing agent, a Team Lead or Owner/Admin edit it', async () => {
    const [a, b] = w.agents as [(typeof w.agents)[number], (typeof w.agents)[number]];
    const r = await call<{ listing: Listing }>(a, 'POST', '/listings', base);
    expect(r.status).toBe(201);
    expect(r.body.listing.editable).toBe(true);
    const id = r.body.listing.id;
    const seen = await call<{ listing: Listing }>(b, 'GET', `/listings/${id}`);
    expect(seen.status).toBe(200);
    expect(seen.body.listing.editable).toBe(false);
    expect((await call<{ listings: { id: string }[] }>(w.others[0]!, 'GET', '/listings')).body.listings.map((x) => x.id)).toContain(id);
    expect((await call(b, 'PATCH', `/listings/${id}`, { description: 'Mine now' })).code).toBe('NOT_FOUND');
    expect((await call(w.teamLead!, 'PATCH', `/listings/${id}`, { description: 'Freshly painted' })).status).toBe(200);
    // an agent cannot list a home for someone else; an ISA cannot list at all
    expect((await call(a, 'POST', '/listings', { ...base, listingAgentUserId: b.userId })).code).toBe('NOT_FOUND');
    expect((await call(w.others[0]!, 'POST', '/listings', base)).code).toBe('NOT_FOUND');
    // a Team Lead lists on behalf of a team member
    const tl = await call<{ listing: { listingAgentUserId: string } }>(w.teamLead!, 'POST', '/listings', { ...base, addressLine1: '1 Team Way', listingAgentUserId: b.userId });
    expect(tl.status).toBe(201);
    expect(tl.body.listing.listingAgentUserId).toBe(b.userId);
  });

  it('a price change appends price history (DB trigger) and asks the assistant to match saved searches', async () => {
    const a = w.agents[0]!;
    const r = await call<{ listing: Listing }>(a, 'POST', '/listings', { ...base, addressLine1: '12 Price Drop Ln' });
    const id = r.body.listing.id;
    expect(r.body.listing.priceHistory.map((x) => x.priceCents)).toEqual([52_500_000]);
    await h.su.query("UPDATE jobs SET status = 'succeeded', finished_at = now() WHERE kind = 'assistant.match_listing' AND payload->>'listingId' = $1", [id]);
    const p = await call<{ listing: Listing }>(a, 'PATCH', `/listings/${id}`, { listPriceCents: 49_900_000 });
    expect(p.body.listing.listPriceCents).toBe(49_900_000);
    expect(p.body.listing.priceHistory.map((x) => x.priceCents)).toEqual([52_500_000, 49_900_000]);
    const jobs = await h.su.query<{ status: string }>("SELECT status FROM jobs WHERE kind = 'assistant.match_listing' AND payload->>'listingId' = $1 ORDER BY id", [id]);
    expect(jobs.rows.map((x) => x.status)).toEqual(['succeeded', 'pending']);
    // a non-price edit does not re-match
    await call(a, 'PATCH', `/listings/${id}`, { description: 'New photos' });
    expect((await h.su.query("SELECT 1 FROM jobs WHERE kind = 'assistant.match_listing' AND payload->>'listingId' = $1", [id])).rows).toHaveLength(2);
    // the price ledger is append-only (R-AUDIT-7): not even the listing agent can rewrite it
    await expect(withTenantTx(a.actor(), (tx) => sql`UPDATE listing_price_history SET price_cents = 1 WHERE listing_id = ${id}`.execute(tx), { db: h.database })).rejects.toThrow();
  });

  it('showings and feedback are logged by the listing writers and summarized on the listing', async () => {
    const [a, b] = w.agents as [(typeof w.agents)[number], (typeof w.agents)[number]];
    const l = (await call<{ listing: Listing }>(a, 'POST', '/listings', { ...base, addressLine1: '9 Showing St' })).body.listing.id;
    const buyer = await contactOf(a, { firstName: 'Bea' });
    const s = await call<{ showing: { id: string; status: string; feedback: unknown[] } }>(a, 'POST', `/listings/${l}/showings`, {
      startsAt: new Date(Date.now() - 7_200_000).toISOString(),
      endsAt: new Date(Date.now() - 5_400_000).toISOString(),
      buyerAgentName: 'Sam Seller-Side',
      buyerAgentBrokerage: 'Other Brokerage',
      buyerContactId: buyer.id,
    });
    expect(s.status).toBe(201);
    expect(s.body.showing).toMatchObject({ status: 'scheduled', feedback: [] });
    const sid = s.body.showing.id;
    expect((await call(a, 'PATCH', `/showings/${sid}`, { status: 'completed' })).status).toBe(200);
    expect((await call(a, 'POST', `/showings/${sid}/feedback`, {})).code).toBe('VALIDATION_FAILED');
    const f = await call<{ showing: { feedback: { rating: number; comments: string }[] } }>(a, 'POST', `/showings/${sid}/feedback`, { rating: 4, comments: 'Loved the yard, kitchen is small' });
    expect(f.status).toBe(201);
    expect(f.body.showing.feedback).toEqual([expect.objectContaining({ rating: 4, comments: 'Loved the yard, kitchen is small', source: 'manual' })]);
    const detail = await call<{ listing: Listing }>(b, 'GET', `/listings/${l}`);
    expect(detail.body.listing.showings).toEqual({ total: 1, completed: 1, withFeedback: 1 });
    const list = await call<{ showings: { id: string }[] }>(b, 'GET', `/listings/${l}/showings`);
    expect(list.body.showings.map((x) => x.id)).toEqual([sid]);
    // another agent reads but cannot log showings on someone else's listing
    expect((await call(b, 'POST', `/listings/${l}/showings`, { startsAt: new Date().toISOString() })).code).toBe('NOT_FOUND');
    expect((await call(b, 'POST', `/showings/${sid}/feedback`, { rating: 1 })).code).toBe('NOT_FOUND');
    // a buyer contact the writer cannot see is refused
    const hidden = await contactOf(b);
    expect((await call(a, 'POST', `/listings/${l}/showings`, { startsAt: new Date().toISOString(), buyerContactId: hidden.id })).code).toBe('NOT_FOUND');
  });

  it('seller contacts: added by the listing writer, listed only to callers who see the contact', async () => {
    const [a, b] = w.agents as [(typeof w.agents)[number], (typeof w.agents)[number]];
    const l = (await call<{ listing: Listing }>(a, 'POST', '/listings', { ...base, addressLine1: '3 Seller Ct' })).body.listing.id;
    const seller = await contactOf(a, { firstName: 'Sol' });
    const r = await call<{ listing: Listing }>(a, 'POST', `/listings/${l}/contacts`, { contactId: seller.id, role: 'seller' });
    expect(r.body.listing.contacts).toEqual([{ contactId: seller.id, role: 'seller' }]);
    expect((await call<{ listing: Listing }>(b, 'GET', `/listings/${l}`)).body.listing.contacts).toEqual([]);
  });
});
