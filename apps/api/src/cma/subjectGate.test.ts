// R-CMA-6 (batch 10 review gates/F3): the agent gate also bounds the subject. Its facts and its sale history come only
// from MLS connections whose licence pack records valuation.agent_cma; a connection without it (live, display pack
// reviewed, no valuation section: E371) still counts for the strict checks: the home's own records are never comps,
// and a live record withholding automated valuations still blocks (E370). Fakes only: MLS rows are RESO fixtures
// stored through V1-A's sync; nothing is sent.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { mlsConnection } from '../mls/testing.js';
import { type CmaBody, type CmaWorld, address, call, cmaPack, cmaWorld, codes, contact, daysAgo, localSales, mlsSale, oneTap, teamListing } from './testing.js';

let h: ApiHarness;
let w: CmaWorld;
/** connection B: live, display pack reviewed, no valuation section (the agent gate does not admit it) */
let b: { h: ApiHarness; tenantId: string; mls: string };

beforeAll(async () => {
  h = await createApiHarness();
  w = await cmaWorld(h);
  b = { h, tenantId: w.tenantId, mls: await mlsConnection(h, w.tenantId, w.owner.userId!, { pack: cmaPack({ valuation: null }), lastSyncedAt: new Date() }) };
  await localSales(w, 8);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

const prepare = (body: Record<string, unknown>) => call<CmaBody>(w.agents[0]!, 'POST', '/cma', { purpose: 'listing_price', ...body });
const details = (r: { body: unknown }) => (r.body as { error: { details: { missing: string[]; sentence: string } } }).error.details;
const ENTERED = { propertyType: 'single_family', sqft: 1500 };

describe('R-CMA-6 E371: the subject is read under the agent gate (gates/F3)', () => {
  it('R-CMA-6 E371: a contact address whose only MLS records are on a connection without valuation use takes no fact and no sale price from them; the strict checks still read them', async () => {
    const c = await contact(w.agents[0]!);
    const line1 = '1501 Sample Avenue';
    await address(h, w.tenantId, c, { kind: 'property', line1 });
    const sale = await mlsSale(b, { line1, sqft: 1555, beds: 4, closePriceCents: 77_700_000, closeDate: daysAgo(300) });
    const live = await mlsSale(b, { line1, status: 'active', closePriceCents: null, closeDate: null, sqft: 1555, beds: 4, avmDisplayAllowed: false });
    const first = await oneTap(w.agents[0]!, c);
    // no admitted record of the home: its type and size are asked for, as for an address not in the MLS history
    expect([first.status, first.code, details(first).missing]).toEqual([422, 'CMA_SUBJECT_INCOMPLETE', ['propertyType', 'sqft']]);
    expect(details(first).sentence).toBe('This address’s MLS records come from a feed whose licence pack does not record valuation use. Enter the property type and size to prepare a CMA.');
    const r = await oneTap(w.agents[0]!, c, { facts: ENTERED });
    expect(r.status).toBe(201);
    expect(r.body.cma.subject.facts['sqft']).toEqual({ value: 1500, source: 'agent' });
    expect(r.body.cma.subject.facts['beds']).toEqual({ value: null, source: null });
    expect(JSON.stringify(r.body.cma)).not.toContain('77700000');
    expect(r.body.cma.subject.saleHistory).toEqual([]);
    // the strict checks read every connection: the live record on B is the home's own and withholds automated valuations
    expect(r.body.cma.clientShare.blockers.find((x) => x.code === 'SELLER_WITHHELD')?.listingIds).toEqual([live]);
    for (const id of [sale, live]) expect(r.body.cma.comps.map((x) => x.saleListingId)).not.toContain(id);
  });

  it('R-CMA-6 E365: with records of the home on both connections, the facts and the sale history are the admitted connection\'s, even when the other one\'s record is newer', async () => {
    const c = await contact(w.agents[0]!);
    const line1 = '1504 Sample Avenue';
    await address(h, w.tenantId, c, { kind: 'property', line1 });
    const own = await mlsSale(w, { line1, sqft: 1500, beds: 3, closePriceCents: 48_000_000, closeDate: daysAgo(4 * 365) });
    await mlsSale(b, { line1, sqft: 1555, beds: 4, closePriceCents: 77_700_000, closeDate: daysAgo(300) });
    const r = await oneTap(w.agents[0]!, c);
    expect(r.status).toBe(201);
    expect(r.body.cma.subject.facts['sqft']).toEqual({ value: 1500, source: 'mls' });
    expect(r.body.cma.subject.facts['beds']).toEqual({ value: 3, source: 'mls' });
    expect(r.body.cma.subject.saleHistory.map((x) => x.listingId)).toEqual([own]);
    expect(JSON.stringify(r.body.cma)).not.toContain('77700000');
    // nothing from B shaped this CMA, so readiness does not judge B's client gate
    expect(codes(r.body)).not.toContain('CLIENT_USE_NOT_ALLOWED');
  });

  it('R-CMA-6: an MLS listing of a connection without valuation use is a subject by its address only: its facts are asked for', async () => {
    const listing = await mlsSale(b, { line1: '1502 Sample Avenue', status: 'active', closePriceCents: null, closeDate: null, sqft: 1600, beds: 5 });
    const first = await prepare({ subject: { kind: 'listing', listingId: listing } });
    expect([first.status, first.code, details(first).missing]).toEqual([422, 'CMA_SUBJECT_INCOMPLETE', ['propertyType', 'sqft']]);
    const r = await prepare({ subject: { kind: 'listing', listingId: listing, facts: ENTERED } });
    expect(r.status).toBe(201);
    expect(r.body.cma.subject.facts['sqft']).toEqual({ value: 1500, source: 'agent' });
    expect(r.body.cma.subject.facts['beds']).toEqual({ value: null, source: null });
  });

  it('R-CMA-6 F4: a team listing whose only MLS mirror is on a connection without valuation use takes its size from the team row (agent-entered), not the mirror', async () => {
    const team = await teamListing(w.agents[0]!, { addressLine1: '1503 Sample Avenue', sqft: 1500, beds: 3, mlsNumber: 'TMB1503' });
    const mirror = await mlsSale(b, { mlsNumber: 'TMB1503', line1: '1503 Sample Ave', status: 'active', sqft: 1480, beds: 2, closePriceCents: null, closeDate: null });
    expect((await h.su.query('SELECT team_listing_id FROM listings WHERE id = $1', [mirror])).rows[0].team_listing_id).toBe(team);
    const r = await prepare({ subject: { kind: 'listing', listingId: team } });
    expect(r.status).toBe(201);
    expect(r.body.cma.subject.facts['sqft']).toEqual({ value: 1500, source: 'agent' });
    expect(r.body.cma.subject.facts['beds']).toEqual({ value: 3, source: 'team' });
    expect(r.body.cma.subject.sizeSentence).toMatch(/^Size entered by the agent, taken as /);
  });
});
