// Module 71 api/cma behaviour against real Postgres (R-CMA-6, R-CMA-7, R-CMA-8; F4, F15; E365, E366, E369, E370,
// E371, E373), on lane V1-A's sold data and lane V1-B's engine. Fakes only: nothing is sent, no real MLS is called (MLS
// rows are RESO fixtures stored through V1-A's sync with a deterministic record feed).
import { CMA_METHOD_VERSION } from '@realty/core/valuation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { mlsConnection } from '../mls/testing.js';
import { type CmaBody, type CmaWorld, HOME, address, call, cmaPack, cmaWorld, codes, contact, daysAgo, feedLastSyncedAt, localSales, mlsSale, oneTap, saleReso, syncSales, teamListing } from './testing.js';

let h: ApiHarness;
let w: CmaWorld;

beforeAll(async () => {
  h = await createApiHarness();
  w = await cmaWorld(h);
  await localSales(w, 40);
}, 180_000);
afterAll(async () => {
  await h?.close();
});

describe('accept: one call from a seller\'s contact', () => {
  it('R-CMA-6 R-CMA-7: a stored CMA with ≥ 3 comps (adjustments, why), a value inside the adjusted range, the area tier, the back-test and "MLS data as of …", and in words what blocks sharing', async () => {
    const c = await contact(w.agents[0]!);
    await address(h, w.tenantId, c, { kind: 'property', line1: '100 Sample Avenue' });
    await mlsSale(w, { line1: '100 Sample Ave', closeDate: daysAgo(3 * 365), sqft: 1500, beds: 3 }); // the seller bought it three years ago
    const r = await oneTap(w.agents[0]!, c);
    expect(r.status).toBe(201);
    const v = r.body.cma;
    expect(v.status).toBe('draft');
    expect(v.comps.length).toBeGreaterThanOrEqual(3);
    for (const comp of v.comps) {
      expect(comp.why.length).toBeGreaterThan(0);
      expect(comp.distanceM).not.toBeNull();
      expect(comp.why[0]).toMatch(/ mi away\.$/);
    }
    expect(v.result.available).toBe(true);
    expect(v.result.valueCents!).toBeGreaterThanOrEqual(v.result.lowCents!);
    expect(v.result.valueCents!).toBeLessThanOrEqual(v.result.highCents!);
    expect(Math.min(...v.comps.map((x) => x.adjustedPriceCents))).toBe(v.result.lowCents);
    expect(v.area.tier).toBe('subdivision');
    expect(v.backtest.sentence).toMatch(/^On \d+ recent local sales, valued only from earlier sales, this method missed the price by /);
    expect(v.mlsDataAsOfSentence).toMatch(/^MLS data as of /);
    expect(v.market.rates.some((x) => x.applied && x.feature === 'size')).toBe(true);
    expect(v.comps.some((x) => x.adjustments.length > 0)).toBe(true);
    // the engine is core/valuation's, and the stored CMA carries its method version (R-CMA-5)
    expect(v.methodVersion).toBe(CMA_METHOD_VERSION);
    // R-CMA-7: platform:cma ships unreviewed, so the default blocker is always there, in words
    expect(codes(r.body)).toContain('PLATFORM_NOT_CLEARED');
    expect(v.clientShare.ready).toBe(false);
    expect(v.clientShare.sharingAvailable).toBe(false); // D9: nothing is shared in V1, and every view says so
    expect(v.clientShare.blockers.find((b) => b.code === 'PLATFORM_NOT_CLEARED')!.sentence).toMatch(/Client CMAs and seller value ranges/);
    const stored = await h.su.query('SELECT status, value_cents, content_sha256, method_version FROM cma_reports WHERE id = $1', [v.id]);
    expect(stored.rows[0]).toMatchObject({ status: 'draft', value_cents: String(v.result.valueCents), method_version: CMA_METHOD_VERSION });
  });
});

/** A seller contact of agents[0] with a property address whose earlier sale is in the MLS (facts come from it). */
async function seller(o: { line1?: string; region?: string; client?: typeof w.agents[number]; world?: CmaWorld } = {}) {
  const ww = o.world ?? w;
  const agent = o.client ?? ww.agents[0]!;
  const c = await contact(agent);
  const line1 = o.line1 ?? `${300 + Math.floor(Math.random() * 600)} Sample Avenue`;
  const addr = await address(h, ww.tenantId, c, { kind: 'property', line1, region: o.region ?? 'CA' });
  const prior = await mlsSale(ww, { line1, closeDate: daysAgo(4 * 365), sqft: 1500, beds: 3 });
  return { c, addr, line1, prior };
}

const prepare = (client: typeof w.owner, body: Record<string, unknown>) => call<CmaBody>(client, 'POST', '/cma', { purpose: 'listing_price', ...body });

describe('subject resolution (F4, E373)', () => {
  it('F4 R-MLS-5: a team listing with an MLS mirror takes its size from the mirror and shows the agent-entered size beside it', async () => {
    // the MLS record carries the team listing's MLS number, so V1-A's sync links it as the team listing's mirror (E81)
    const team = await teamListing(w.agents[0]!, { addressLine1: '510 Sample Avenue', sqft: 1500, mlsNumber: 'TM510' });
    const mirror = await mlsSale(w, { mlsNumber: 'TM510', line1: '510 Sample Ave', status: 'active', sqft: 1480, closePriceCents: null, closeDate: null });
    expect((await h.su.query('SELECT team_listing_id FROM listings WHERE id = $1', [mirror])).rows[0].team_listing_id).toBe(team);
    const r = await prepare(w.agents[0]!, { subject: { kind: 'listing', listingId: team } });
    expect(r.status).toBe(201);
    expect(r.body.cma.subject.facts['sqft']).toEqual({ value: 1480, source: 'mls' });
    expect(r.body.cma.subject.facts['beds']).toEqual({ value: 3, source: 'team' });
    expect(r.body.cma.subject.sizeSentence).toMatch(/Size from the MLS record \(LivingArea\); agent-entered size 1500 sq ft\./);
  });

  it('F4: a team listing without a mirror labels its size agent-entered, taken as the connection\'s size field', async () => {
    const team = await teamListing(w.agents[0]!, { addressLine1: '520 Sample Avenue', sqft: 1450 });
    const r = await prepare(w.agents[0]!, { subject: { kind: 'listing', listingId: team } });
    expect(r.status).toBe(201);
    expect(r.body.cma.subject.facts['sqft']).toEqual({ value: 1450, source: 'agent' });
    expect(r.body.cma.subject.sizeSentence).toMatch(/taken as LivingArea/);
  });

  it('E373 R-CMA-2: entered facts with only type and size work; without coordinates the distance tiers do not run and every distance is "not known"', async () => {
    const r = await prepare(w.agents[0]!, { subject: { kind: 'entered', anchor: { region: 'CA', postalCode: '94110', city: 'Oakland' }, facts: { propertyType: 'single_family', sqft: 1400 } } });
    expect(r.status).toBe(201);
    expect(r.body.cma.subject.facts['propertyType']).toEqual({ value: 'single_family', source: 'agent' });
    // neither distance read runs (V1-A), the engine skips both distance tiers and the subdivision tier and says so (V1-B)
    for (const t of ['within_1mi', 'within_3mi', 'subdivision']) expect(r.body.cma.area.reads.find((x) => x.tier === t)).toMatchObject({ ran: false, rows: 0 });
    expect([...r.body.cma.area.tiersSkipped].sort()).toEqual(['subdivision', 'within_1mi', 'within_3mi']);
    expect(r.body.cma.area.sentences).toContain('Distance tiers were skipped because the home has no coordinates; the subdivision tier was skipped because the home has no subdivision.');
    expect(r.body.cma.comps.length).toBeGreaterThanOrEqual(3);
    for (const comp of r.body.cma.comps) {
      expect(comp.distanceM).toBeNull();
      expect(comp.why[0]).toMatch(/; distance not known\.$/);
    }
    expect(r.body.cma.subject.sizeSentence).toMatch(/entered by the agent, taken as LivingArea/);
  });

  it('E373: entered facts need the type and the size (CMA_SUBJECT_INCOMPLETE names what is missing); land and other types are not valued yet', async () => {
    const r = await prepare(w.agents[0]!, { subject: { kind: 'entered', anchor: { region: 'CA', postalCode: '94110' }, facts: { propertyType: 'condo' } } });
    expect([r.status, r.code, (r.body as unknown as { error: { details: { missing: string[] } } }).error.details.missing]).toEqual([422, 'CMA_SUBJECT_INCOMPLETE', ['sqft']]);
    // owner question (g) default, held by core/valuation CMA_SUPPORTED_TYPES: land and 'other' are not valued yet
    for (const propertyType of ['land', 'other']) {
      const r2 = await prepare(w.agents[0]!, { subject: { kind: 'entered', anchor: { region: 'CA', postalCode: '94110' }, facts: { propertyType, sqft: 9000 } } });
      expect([propertyType, r2.status, r2.code]).toEqual([propertyType, 422, 'CMA_SUBJECT_TYPE_NOT_SUPPORTED']);
    }
  });

  it('E373: a contact address that is not in the MLS history prompts for type and size; with them, the one-tap CMA is stored with the facts labelled agent', async () => {
    const c = await contact(w.agents[0]!);
    await address(h, w.tenantId, c, { kind: 'home', line1: '999 Unknown Way' });
    const first = await oneTap(w.agents[0]!, c);
    const err = first.body as unknown as { error: { details: { missing: string[]; sentence: string } } };
    expect([first.status, first.code, err.error.details.missing]).toEqual([422, 'CMA_SUBJECT_INCOMPLETE', ['propertyType', 'sqft']]);
    expect(err.error.details.sentence).toBe('This address is not in the MLS history. Enter the property type and size to prepare a CMA.');
    const second = await oneTap(w.agents[0]!, c, { facts: { propertyType: 'single_family', sqft: 1350 } });
    expect(second.status).toBe(201);
    expect(second.body.cma.subject.facts['sqft']).toEqual({ value: 1350, source: 'agent' });
    expect(second.body.cma.subject.facts['propertyType']).toEqual({ value: 'single_family', source: 'agent' });
  });

  it('E365 E370: a street address without a city is refused (CMA_SUBJECT_INCOMPLETE names the city) on every prepare path, and nothing is stored', async () => {
    const c = await contact(w.agents[0]!);
    const line1 = '1040 Sample Avenue';
    // an imported lead's address: the people API stores one without a city
    const a = await call<{ address: { id: string } }>(w.agents[0]!, 'POST', `/contacts/${c}/addresses`, { kind: 'property', line1, region: 'CA', postalCode: '94110' });
    expect(a.status).toBe(201);
    // the home's own earlier sale, in the same ZIP: without an address key it could be chosen as a comp
    await mlsSale(w, { line1, closeDate: daysAgo(100), sqft: 1500 });
    const facts = { propertyType: 'single_family', sqft: 1500 };
    const tap = await oneTap(w.agents[0]!, c, { facts });
    const post = await prepare(w.agents[0]!, { contactId: c, subject: { kind: 'contact_address', contactAddressId: a.body.address.id, facts } });
    for (const r of [tap, post]) {
      const err = r.body as unknown as { error: { details: { missing: string[]; sentence: string } } };
      expect([r.status, r.code, err.error.details.missing]).toEqual([422, 'CMA_SUBJECT_INCOMPLETE', ['city']]);
      expect(err.error.details.sentence).toBe('Add the home’s city to prepare a CMA: without it the address’s MLS history can’t be looked up.');
    }
    const entered = await prepare(w.agents[0]!, { subject: { kind: 'entered', anchor: { line1, region: 'CA', postalCode: '94110' }, facts } });
    expect([entered.status, entered.code]).toEqual([422, 'CMA_SUBJECT_INCOMPLETE']);
    expect((await h.su.query('SELECT count(*)::int AS n FROM cma_reports WHERE contact_id = $1', [c])).rows[0].n).toBe(0);
  });

  it('E370 F2 R-CMA-7: an entered subject with no street is valued on its area, and readiness says the seller-flag and near-match checks could not run (SUBJECT_ADDRESS_UNKNOWN)', async () => {
    const r = await prepare(w.agents[0]!, { subject: { kind: 'entered', anchor: { region: 'CA', postalCode: '94110', city: 'Oakland' }, facts: { propertyType: 'single_family', sqft: 1400 } } });
    expect(r.status).toBe(201);
    expect(r.body.cma.clientShare.ready).toBe(false);
    // the address cannot be added to this CMA (PATCH has no address): the agent is told to prepare a new one (api-ui/F4)
    expect(r.body.cma.clientShare.blockers.find((b) => b.code === 'SUBJECT_ADDRESS_UNKNOWN')?.sentence).toMatch(/could not be checked\. To check them, prepare a new CMA with the home’s full address\.$/);
  });

  it('owner question (c): the one-tap address is the contact\'s property address, else home; a contact without one is told to add it', async () => {
    const c = await contact(w.agents[0]!);
    const none = await oneTap(w.agents[0]!, c);
    expect([none.status, none.code]).toEqual([422, 'CMA_SUBJECT_INCOMPLETE']);
    const line1 = '610 Sample Avenue';
    await mlsSale(w, { line1, closeDate: daysAgo(2000) });
    await address(h, w.tenantId, c, { kind: 'home', line1: '777 Elsewhere Rd', updatedAt: new Date() });
    const prop = await address(h, w.tenantId, c, { kind: 'property', line1, updatedAt: new Date(Date.now() - 86_400_000) });
    const r = await oneTap(w.agents[0]!, c);
    expect(r.status).toBe(201);
    expect((await h.su.query('SELECT contact_address_id FROM cma_reports WHERE id = $1', [r.body.cma.id])).rows[0].contact_address_id).toBe(prop);
  });

  describe('V3: a subject MLS record stored before its size field was recorded (mls_normalize_version 1, size_source NULL)', () => {
    /** The row as the sync stored it before 0061 and before the backfill reached it: the size is there, its field is not. */
    const asVersion1 = (id: string) => h.su.query('UPDATE listings SET size_source = NULL, mls_normalize_version = 1 WHERE id = $1', [id]);
    const assumed = /taken as LivingArea \(the record does not say which field it came from\)/;

    it('an MLS listing subject is valued with the connection\'s size field, said to be assumed (not NO_SALES)', async () => {
      const subject = await mlsSale(w, { line1: '1010 Sample Avenue', status: 'active', closePriceCents: null, closeDate: null, sqft: 1500 });
      await asVersion1(subject);
      const r = await prepare(w.agents[0]!, { subject: { kind: 'listing', listingId: subject } });
      expect(r.status).toBe(201);
      expect(r.body.cma.result).toMatchObject({ available: true });
      expect(r.body.cma.notUsed.filter((x) => x.reason === 'other_size_source')).toEqual([]);
      expect(r.body.cma.subject.sizeSentence).toMatch(assumed);
    });

    it('the MLS mirror of a team listing gives its size the same way', async () => {
      const team = await teamListing(w.agents[0]!, { addressLine1: '1020 Sample Avenue', sqft: 1500, mlsNumber: 'TM1020' });
      const mirror = await mlsSale(w, { mlsNumber: 'TM1020', line1: '1020 Sample Ave', status: 'active', sqft: 1480, closePriceCents: null, closeDate: null });
      await asVersion1(mirror);
      const r = await prepare(w.agents[0]!, { subject: { kind: 'listing', listingId: team } });
      expect(r.status).toBe(201);
      expect(r.body.cma.subject.facts['sqft']).toEqual({ value: 1480, source: 'mls' });
      expect(r.body.cma.result).toMatchObject({ available: true });
      expect(r.body.cma.subject.sizeSentence).toMatch(assumed);
      expect(r.body.cma.subject.sizeSentence).toMatch(/; agent-entered size 1500 sq ft\.$/);
    });

    it('a contact address whose newest MLS record is version 1 gives its size the same way', async () => {
      const c = await contact(w.agents[0]!);
      const line1 = '1030 Sample Avenue';
      await address(h, w.tenantId, c, { kind: 'property', line1 });
      await asVersion1(await mlsSale(w, { line1, closeDate: daysAgo(4 * 365), sqft: 1500, beds: 3 }));
      const r = await oneTap(w.agents[0]!, c);
      expect(r.status).toBe(201);
      expect(r.body.cma.result).toMatchObject({ available: true });
      expect(r.body.cma.subject.sizeSentence).toMatch(/^Size from the newest MLS record of this address, taken as LivingArea \(the record does not say which field it came from\)\.$/);
    });
  });

  it('E365 R-CMA-2: the subject\'s earlier sale under another MLS number and another spelling is its sale history, never a comp', async () => {
    const c = await contact(w.agents[0]!);
    await address(h, w.tenantId, c, { kind: 'property', line1: '640 Sample Ave.', line2: 'Apt 2', region: 'California', postalCode: '94110-1234' });
    const earlier = await mlsSale(w, { line1: '640 SAMPLE AVENUE', line2: 'Unit 2', region: 'CA', postalCode: '94110', closeDate: daysAgo(90), sqft: 1500 });
    const r = await oneTap(w.agents[0]!, c);
    expect(r.status).toBe(201);
    expect(r.body.cma.subject.saleHistory.map((x) => x.listingId)).toEqual([earlier]);
    expect(r.body.cma.comps.map((x) => x.listingId)).not.toContain(earlier);
    // the engine matched it by the address key: the subject's own sale, never a comp and never offered back as one
    expect(r.body.cma.notUsed.map((x) => x.listingId)).not.toContain(earlier);
    expect(r.body.cma.subjectSales.map((x) => x.listingId)).toEqual([earlier]);
  });
});

describe('E366 R-MLS-5: a mirrored team sale', () => {
  it('E366: a team listing mirrored in the MLS as sold is one comp: the team row\'s identity and facts, the MLS close price and size; its client rendering is the mirror\'s', async () => {
    const team = await teamListing(w.agents[1]!, { addressLine1: '700 Sample Avenue', status: 'sold', sqft: 1500, beds: 3, mlsNumber: 'TM700' });
    const mirror = await mlsSale(w, { mlsNumber: 'TM700', line1: '700 Sample Ave', closeDate: daysAgo(15), sqft: 1490, beds: 2, closePriceCents: 52_000_000, displayAllowed: false });
    expect((await h.su.query('SELECT team_listing_id FROM listings WHERE id = $1', [mirror])).rows[0].team_listing_id).toBe(team);
    const { c } = await seller();
    const r = await oneTap(w.agents[0]!, c);
    const as = r.body.cma.comps.filter((x) => x.listingId === team || x.saleListingId === mirror);
    const out = r.body.cma.notUsed.filter((x) => x.listingId === team || x.listingId === mirror);
    expect(out).toEqual([]);
    expect(as).toHaveLength(1);
    expect(as[0]).toMatchObject({ listingId: team, saleListingId: mirror, sourceLabel: 'Team', closePriceCents: 52_000_000 });
    // the team row's facts with the MLS close price and size (E366, R-MLS-5: the team row wins where it has a value)
    expect(as[0]!.facts).toMatchObject({ beds: 3, sqft: 1490, sizeSource: 'LivingArea' });
    // the mirror is hidden from internet display, so the comp is hidden from clients (judged as the MLS row it is)
    expect(r.body.cma.clientShare.blockers.find((b) => b.code === 'COMPS_HIDDEN')!.listingIds).toEqual([mirror]);
  });
});

describe('one tap (F15)', () => {
  it('F15: a second tap on unchanged data returns the same draft (200)', async () => {
    const { c } = await seller();
    const a = await oneTap(w.agents[0]!, c);
    const b = await oneTap(w.agents[0]!, c);
    expect([a.status, b.status]).toEqual([201, 200]);
    expect(b.body.cma.id).toBe(a.body.cma.id);
  });

  it('F15 R-CMA-6: a new sale supersedes the caller\'s own draft; the old one is kept unchanged', async () => {
    const { c } = await seller();
    const a = await oneTap(w.agents[0]!, c);
    await mlsSale(w, { closeDate: daysAgo(2), sqft: 1500, closePriceCents: 53_000_000 });
    const b = await oneTap(w.agents[0]!, c);
    expect(b.status).toBe(201);
    expect(b.body.cma.id).not.toBe(a.body.cma.id);
    const old = await h.su.query('SELECT status, content_sha256 FROM cma_reports WHERE id = $1', [a.body.cma.id]);
    expect(old.rows[0].status).toBe('superseded');
  });

  it('F15: a concurrent double tap yields one draft', async () => {
    const { c } = await seller();
    const [a, b] = await Promise.all([oneTap(w.agents[0]!, c), oneTap(w.agents[0]!, c)]);
    expect([a.status, b.status].sort()).toEqual([200, 201]);
    expect(a.body.cma.id).toBe(b.body.cma.id);
    expect((await h.su.query("SELECT count(*)::int AS n FROM cma_reports WHERE contact_id = $1 AND status = 'draft'", [c])).rows[0].n).toBe(1);
  });

  it('F15 R-CMA-6: a Team Lead\'s tap on an agent\'s contact creates the Team Lead\'s own draft and leaves the agent\'s untouched', async () => {
    const { c } = await seller();
    const mine = await oneTap(w.agents[0]!, c);
    const tl = await oneTap(w.teamLead, c);
    expect(tl.status).toBe(201);
    expect(tl.body.cma.createdByUserId).toBe(w.teamLead.userId);
    expect((await h.su.query('SELECT status FROM cma_reports WHERE id = $1', [mine.body.cma.id])).rows[0].status).toBe('draft');
    // the agent's draft is read-only to the Team Lead (R-CMA-8)
    expect((await call(w.teamLead, 'GET', `/cma/${mine.body.cma.id}`)).status).toBe(200);
    expect((await call(w.teamLead, 'PATCH', `/cma/${mine.body.cma.id}`, { notes: 'mine now' })).status).toBe(404);
    const list = await call<{ cmas: { id: string; mine: boolean }[] }>(w.teamLead, 'GET', `/contacts/${c}/cmas`);
    expect(list.body.cmas.find((x) => x.id === mine.body.cma.id)!.mine).toBe(false);
  });
});

describe('PATCH (R-CMA-8)', () => {
  it('R-CMA-8: exclude and include re-run the engine; a short sale is not used until the agent adds it, then it is labelled (E367)', async () => {
    const { c } = await seller();
    const short = await mlsSale(w, { closeDate: daysAgo(20), sqft: 1500, saleConditions: ['short_sale'], closePriceCents: 40_000_000 });
    const a = await oneTap(w.agents[0]!, c);
    expect(a.body.cma.notUsed.find((x) => x.listingId === short)).toMatchObject({ reason: 'sale_condition', sentence: 'Not used: short sale.', includable: true });
    const first = a.body.cma.comps[0]!.listingId;
    const b = await call<CmaBody>(w.agents[0]!, 'PATCH', `/cma/${a.body.cma.id}`, { exclude: [first], include: [short] });
    expect(b.status).toBe(200);
    expect(b.body.cma.notUsed.find((x) => x.listingId === first)).toMatchObject({ reason: 'excluded_by_agent' });
    // the engine keeps an agent-added sale among the comps, labelled with what kept it out (E367)
    const added = b.body.cma.comps.find((x) => x.listingId === short)!;
    expect(added).toMatchObject({ includedByAgent: true, labels: ['short sale'] });
    expect(added.why).toContain('Added by the agent after review: short sale.');
  });

  it('R-CMA-8: an exclusion survives when more than 50 not-used sales are closer than the excluded comp: stored, listed, and kept by a later PATCH and a re-tap', async () => {
    const wd = await cmaWorld(h);
    const at = (dLat: number) => ({ latE6: HOME.latE6 + dLat, lonE6: HOME.lonE6 });
    // 60 sales right next to the home but twice its size (never comps), then 8 comparable sales further out
    await syncSales(wd, Array.from({ length: 60 }, (_, i) => saleReso({ sqft: 3000, closeDate: daysAgo(20 + i), ...at(100 + i * 5) })));
    await syncSales(wd, Array.from({ length: 8 }, (_, i) => saleReso({ sqft: 1450 + i * 10, beds: 3, closeDate: daysAgo(30 + i * 7), closePriceCents: 50_000_000 + i * 200_000, ...at(4000 + i * 600) })));
    const c = await contact(wd.agents[0]!);
    const line1 = '1050 Sample Avenue';
    await address(h, wd.tenantId, c, { kind: 'property', line1 });
    await mlsSale(wd, { line1, closeDate: daysAgo(4 * 365), sqft: 1500, beds: 3, ...at(0) });
    const a = await oneTap(wd.agents[0]!, c);
    expect(a.status).toBe(201);
    const far = [...a.body.cma.comps].sort((x, y) => (y.distanceM ?? 0) - (x.distanceM ?? 0))[0]!.listingId;
    const p = await call<CmaBody>(wd.agents[0]!, 'PATCH', `/cma/${a.body.cma.id}`, { exclude: [far] });
    expect(p.status).toBe(200);
    expect(p.body.cma.notUsed.filter((x) => x.reason === 'size_not_similar').length).toBeGreaterThanOrEqual(50);
    expect(p.body.cma.comps.map((x) => x.listingId)).not.toContain(far);
    expect(p.body.cma.subject.exclude).toEqual([far]);
    expect(p.body.cma.notUsed.find((x) => x.listingId === far)).toMatchObject({ reason: 'excluded_by_agent' });
    const n = await call<CmaBody>(wd.agents[0]!, 'PATCH', `/cma/${a.body.cma.id}`, { notes: 'checked the street' });
    expect(n.body.cma.subject.exclude).toEqual([far]);
    expect(n.body.cma.comps.map((x) => x.listingId)).not.toContain(far);
    const again = await oneTap(wd.agents[0]!, c);
    expect([again.status, again.body.cma.id]).toEqual([200, a.body.cma.id]);
    expect(again.body.cma.comps.map((x) => x.listingId)).not.toContain(far);
  });

  it('F12 R-CMA-4: the read reaches back as far as V1-B\'s back-test needs (30 months): a sale closed 27 months ago is read, shown as too old, and never offered for inclusion', async () => {
    const wo = await cmaWorld(h);
    await localSales(wo, 6);
    const old = await mlsSale(wo, { closeDate: daysAgo(27 * 30 + 15), sqft: 1500, beds: 3 });
    const oldShort = await mlsSale(wo, { closeDate: daysAgo(27 * 30 + 20), sqft: 1500, beds: 3, saleConditions: ['short_sale'] });
    const { c } = await seller({ world: wo });
    const r = await oneTap(wo.agents[0]!, c);
    expect(r.status).toBe(201);
    expect(r.body.cma.notUsed.find((x) => x.listingId === old)).toMatchObject({ reason: 'too_old', includable: false });
    expect(r.body.cma.notUsed.find((x) => x.listingId === oldShort)).toMatchObject({ reason: 'too_old', includable: false });
    expect(r.body.cma.comps.map((x) => x.listingId)).not.toContain(old);
  });

  it('E368 R-CMA-3: $15,000 of seller concessions lower the adjusted price by $15,000, never raise it', async () => {
    const { c } = await seller();
    const conc = await mlsSale(w, { closeDate: daysAgo(5), sqft: 1500, beds: 3, bathsX10: 20, concessionsCents: 1_500_000, closePriceCents: 52_500_000, subdivision: 'Sample Heights' });
    const a = await oneTap(w.agents[0]!, c);
    const comp = a.body.cma.comps.find((x) => x.listingId === conc);
    expect(comp).toBeDefined();
    expect(comp!.adjustments.find((x) => x.feature === 'concessions')!.amountCents).toBe(-1_500_000);
  });

  // E377 (a PATCH after share) is V2's sharing lane: no V1 path makes a shared CMA, so these test the superseded case
  it('R-CMA-8: a superseded CMA is not edited (CMA_NOT_DRAFT) and stays unchanged', async () => {
    const { c } = await seller();
    const a = await oneTap(w.agents[0]!, c);
    await mlsSale(w, { closeDate: daysAgo(1), sqft: 1500 });
    await oneTap(w.agents[0]!, c);
    const before = (await h.su.query('SELECT content_sha256, updated_at FROM cma_reports WHERE id = $1', [a.body.cma.id])).rows[0];
    const p = await call(w.agents[0]!, 'PATCH', `/cma/${a.body.cma.id}`, { notes: 'late edit' });
    expect([p.status, p.code]).toEqual([409, 'CMA_NOT_DRAFT']);
    expect((await h.su.query('SELECT content_sha256, updated_at FROM cma_reports WHERE id = $1', [a.body.cma.id])).rows[0]).toEqual(before);
  });
});

describe('market context (E360)', () => {
  it('E360 (b10 review ownership-data/F5): an active lease nearby is never in the CMA\'s market context, so a rent is never shown as a list price or counted', async () => {
    const c = await contact(w.agents[0]!);
    await address(h, w.tenantId, c, { line1: '4321 Context Ave' });
    const lease = await mlsSale(w, { status: 'active', isLease: true, listPriceCents: 300_000, line1: '77 Lease St' });
    const sale = await mlsSale(w, { status: 'active', listPriceCents: 60_000_000, line1: '78 Sale St' });
    const r = await oneTap(w.agents[0]!, c, { facts: { propertyType: 'single_family', sqft: 1500 } });
    expect(r.status).toBe(201);
    const cma = r.body.cma as unknown as { context: { listingId: string; listPriceCents: number | null }[]; contextSentence: string };
    const ids = cma.context.map((x) => x.listingId);
    expect(ids).toContain(sale);
    expect(ids).not.toContain(lease);
    expect(cma.context.some((x) => x.listPriceCents === 300_000)).toBe(false);
    expect(cma.contextSentence).toBe(`${cma.context.length} active or pending listings nearby, shown for the market only: they are not sales and are not used in the value.`);
  });
});

describe('gates and readiness (R-CMA-6, R-CMA-7)', () => {
  it('E369 R-CMA-6: a feed stale for 3 days still gives the agent a CMA with "MLS data as of …", and blocks client sharing (FEED_STALE)', async () => {
    const ws = await cmaWorld(h);
    await localSales(ws, 8);
    const { c } = await seller({ world: ws });
    // the sync that stored the records moved last_synced_at to now; the feed then goes quiet for 3 days
    await feedLastSyncedAt(ws, new Date(Date.now() - 3 * 86_400_000));
    const r = await oneTap(ws.agents[0]!, c);
    expect(r.status).toBe(201);
    expect(r.body.cma.mlsDataAsOfSentence).toMatch(/^MLS data as of /);
    expect(new Date(r.body.cma.mlsDataAsOf!).getTime()).toBeLessThan(Date.now() - 2 * 86_400_000);
    expect(codes(r.body)).toContain('FEED_STALE');
  });

  it('E369 R-CMA-7: a stale feed does not hide the display-pack blocker; with an unreviewed display pack and no client use, all three are listed at once', async () => {
    // the valuation section refuses first (client_cma false), so V1-A's client gate alone reports CLIENT_USE_NOT_ALLOWED:
    // MLS_CLIENT_DISPLAY_OFF must come from readiness's own display check, whatever the feed's freshness
    const ws = await cmaWorld(h, { pack: cmaPack({ reviewed: false, valuation: { client_cma: false } }) });
    await localSales(ws, 5);
    const { c } = await seller({ world: ws });
    await feedLastSyncedAt(ws, new Date(Date.now() - 3 * 86_400_000));
    const r = await oneTap(ws.agents[0]!, c);
    expect(r.status).toBe(201);
    expect(codes(r.body)).toEqual(expect.arrayContaining(['MLS_CLIENT_DISPLAY_OFF', 'FEED_STALE', 'CLIENT_USE_NOT_ALLOWED']));
  });

  it('E371 R-CMA-6: a reviewed pack with no valuation section refuses the agent CMA in words; the display pack keeps its review state', async () => {
    const wn = await cmaWorld(h, { pack: cmaPack({ valuation: null }) });
    const c = await contact(wn.agents[0]!);
    await address(h, wn.tenantId, c);
    const r = await oneTap(wn.agents[0]!, c);
    const e = r.body as unknown as { error: { details: { sentence: string } } };
    // b10 review api-ui/F2: the refusal names the page where an Owner or Admin records the use (module 41's MLS page)
    expect([r.status, r.code, e.error.details.sentence]).toEqual([409, 'CMA_VALUATION_NOT_ALLOWED', 'Your MLS licence pack does not say MLS sold data may be used for valuations. An Owner or Admin records this from your MLS agreement on the MLS admin page, under Valuation use.']);
    const pack = (await h.su.query('SELECT license_pack FROM integration_connections WHERE id = $1', [wn.mls])).rows[0].license_pack;
    expect(pack.reviewed_by_counsel_at).toBe('2026-11-01T00:00:00Z');
  });

  it('R-CMA-6: with no live MLS connection the CMA is refused: "No MLS feed is connected, so there are no sold homes to compare."', async () => {
    const wn = await cmaWorld(h);
    await h.su.query("UPDATE integration_connections SET status = 'disconnected', disconnected_at = now() WHERE id = $1", [wn.mls]);
    const r = await prepare(wn.agents[0]!, { subject: { kind: 'entered', anchor: { region: 'CA', postalCode: '94110' }, facts: { propertyType: 'condo', sqft: 900 } } });
    const e = r.body as unknown as { error: { details: { sentence: string } } };
    expect([r.status, r.code, e.error.details.sentence]).toEqual([409, 'CMA_NO_MLS_CONNECTION', 'No MLS feed is connected, so there are no sold homes to compare.']);
  });

  it('E370 R-CMA-7: the subject\'s active listing withholding automated valuations blocks sharing (SELLER_WITHHELD), not under internet_display_only; the agent CMA still works', async () => {
    const { c, line1 } = await seller();
    const live = await mlsSale(w, { line1, status: 'active', closePriceCents: null, closeDate: null, avmDisplayAllowed: false });
    const r = await oneTap(w.agents[0]!, c);
    expect(r.status).toBe(201);
    expect(r.body.cma.clientShare.blockers.find((b) => b.code === 'SELLER_WITHHELD')!.listingIds).toEqual([live]);
    const wi = await cmaWorld(h, { pack: cmaPack({ valuation: { avm_flag_scope: 'internet_display_only' } }) });
    await localSales(wi, 6);
    const s2 = await seller({ world: wi });
    await mlsSale(wi, { line1: s2.line1, status: 'active', closePriceCents: null, closeDate: null, avmDisplayAllowed: false });
    const r2 = await oneTap(wi.agents[0]!, s2.c);
    expect(codes(r2.body)).not.toContain('SELLER_WITHHELD');
  });

  it('E370 F2 R-CMA-7: a live listing at a near-identical address blocks sharing (POSSIBLE_LIVE_LISTING) until the agent confirms it is a different home; the dismissal is audited with ids only', async () => {
    const { c } = await seller({ line1: '880 Sample Avenue' });
    const near = await mlsSale(w, { line1: '880 Sample Street', status: 'active', closePriceCents: null, closeDate: null, avmDisplayAllowed: false });
    const r = await oneTap(w.agents[0]!, c);
    const b = r.body.cma.clientShare.blockers.find((x) => x.code === 'POSSIBLE_LIVE_LISTING')!;
    expect(b.listingIds).toEqual([near]);
    expect(b.sentence).toMatch(/^An MLS listing at 880 Sample Street, Oakland may be this home\. Confirm it is a different home, or this CMA could not be shown to a client\. That listing asks that automated valuations not be shown\.$/);
    expect(r.body.cma.nearMatches).toEqual([expect.objectContaining({ listingId: near, avmDisplayAllowed: false, dismissed: false })]);
    const p = await call<CmaBody>(w.agents[0]!, 'PATCH', `/cma/${r.body.cma.id}`, { nearMatchDismissed: [near] });
    expect(p.status).toBe(200);
    expect(codes(p.body)).not.toContain('POSSIBLE_LIVE_LISTING');
    expect(p.body.cma.subject.nearMatchDismissed).toEqual([near]);
    const a = await h.su.query("SELECT changes, entity_id FROM audit_log WHERE action = 'cma.near_match_dismissed' AND entity_id = $1", [r.body.cma.id]);
    expect(a.rows).toHaveLength(1);
    expect(JSON.stringify(a.rows[0].changes)).not.toMatch(/Sample|Oakland/);
    expect(a.rows[0].changes).toEqual({ dismissed_listing_ids: { from: [], to: [near] } });
  });

  it('E364 R-CMA-4: with only 2 eligible sales there is no value; the 2 sales are listed (NO_VALUE)', async () => {
    const w2 = await cmaWorld(h);
    await localSales(w2, 2);
    const { c } = await seller({ world: w2 });
    const r = await oneTap(w2.agents[0]!, c);
    expect(r.status).toBe(201);
    expect(r.body.cma.result).toMatchObject({ available: false, reason: 'INSUFFICIENT_COMPS', valueCents: null });
    expect(r.body.cma.comps).toHaveLength(2);
    expect(codes(r.body)).toContain('NO_VALUE');
  });

  it('R-CMA-7: every blocker code is reachable, each in words, and with every gate met the CMA is ready (V1 still shares nothing)', async () => {
    const cases: { pack: Record<string, unknown>; code: string; sentence: RegExp }[] = [
      { pack: cmaPack({ reviewed: false }), code: 'MLS_CLIENT_DISPLAY_OFF', sentence: /does not allow showing MLS data to clients/ },
      { pack: cmaPack({ valuation: { client_cma: false } }), code: 'CLIENT_USE_NOT_ALLOWED', sentence: /may be used in CMAs for clients/ },
      { pack: cmaPack({ valuation: { reviewed_by_counsel_at: null } }), code: 'VALUATION_NOT_REVIEWED', sentence: /has not been reviewed by counsel/ },
      { pack: cmaPack({ valuation: { statements: {} } }), code: 'NO_VALUATION_STATEMENT', sentence: /^No valuation statement is recorded for CA\.$/ },
      { pack: cmaPack({ clientSold: false }), code: 'COMPS_HIDDEN', sentence: /^\d+ of these sales can’t be shown to clients/ },
    ];
    for (const k of cases) {
      const wk = await cmaWorld(h, { pack: k.pack });
      await localSales(wk, 5);
      const { c } = await seller({ world: wk });
      const r = await oneTap(wk.agents[0]!, c);
      expect([k.code, r.status]).toEqual([k.code, 201]);
      const b = r.body.cma.clientShare.blockers.find((x) => x.code === k.code);
      expect(b?.sentence, k.code).toMatch(k.sentence);
    }
    // all gates met (platform:cma cleared for this check only)
    const wa = await cmaWorld(h);
    await localSales(wa, 6);
    const { c } = await seller({ world: wa });
    await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:cma'");
    try {
      const r = await oneTap(wa.agents[0]!, c);
      expect(r.body.cma.clientShare).toMatchObject({ ready: true, sharingAvailable: false, blockers: [], estimateSentence: 'This is an estimate, not an appraisal.' });
    } finally {
      await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL WHERE key = 'platform:cma'");
    }
    const after = await oneTap(wa.agents[0]!, c);
    expect(codes(after.body)).toEqual(['PLATFORM_NOT_CLEARED']); // readiness is computed on every view, never stored
  });

  it('R-CMA-7: readiness checks every MLS connection the CMA was built from: withdrawing one connection\'s valuation use after the CMA was prepared blocks sharing, for its comps and for its rate-pool sales alike', async () => {
    const withdrawn = JSON.stringify(cmaPack({ valuation: { agent_cma: false, client_cma: false } }));
    // A and B both fully allowed; B's sales are comps in the first CMA, and only rate-pool sales (too large to compare) in the second
    const wa = await cmaWorld(h);
    const b = { h, tenantId: wa.tenantId, mls: await mlsConnection(h, wa.tenantId, wa.owner.userId!, { pack: cmaPack(), lastSyncedAt: new Date() }) };
    await localSales(wa, 4);
    await localSales(b, 4);
    const first = await seller({ world: wa });
    const r1 = await oneTap(wa.agents[0]!, first.c);
    const compConns = (await h.su.query<{ c: string }>('SELECT DISTINCT mls_connection_id AS c FROM listings WHERE id = ANY ($1::uuid[])', [r1.body.cma.comps.map((x) => x.saleListingId)])).rows.map((x) => x.c);
    expect(compConns.sort()).toEqual([wa.mls, b.mls].sort());
    const wv = await cmaWorld(h);
    const bv = { h, tenantId: wv.tenantId, mls: await mlsConnection(h, wv.tenantId, wv.owner.userId!, { pack: cmaPack(), lastSyncedAt: new Date() }) };
    await localSales(wv, 6);
    await localSales(bv, 6, { sqft: 3000 });
    const second = await seller({ world: wv });
    const r2 = await oneTap(wv.agents[0]!, second.c);
    const compConns2 = (await h.su.query<{ c: string }>('SELECT DISTINCT mls_connection_id AS c FROM listings WHERE id = ANY ($1::uuid[])', [r2.body.cma.comps.map((x) => x.saleListingId)])).rows.map((x) => x.c);
    expect(compConns2).toEqual([wv.mls]);
    await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:cma'");
    try {
      for (const [client, id] of [[wa.agents[0]!, r1.body.cma.id], [wv.agents[0]!, r2.body.cma.id]] as const) {
        expect((await call<CmaBody>(client, 'GET', `/cma/${id}`)).body.cma.clientShare).toMatchObject({ ready: true, blockers: [] });
      }
      // an Admin withdraws B's valuation use; B stays live and its display pack stays reviewed
      for (const conn of [b.mls, bv.mls]) await h.su.query('UPDATE integration_connections SET license_pack = $2::jsonb WHERE id = $1', [conn, withdrawn]);
      for (const [client, id] of [[wa.agents[0]!, r1.body.cma.id], [wv.agents[0]!, r2.body.cma.id]] as const) {
        const v = await call<CmaBody>(client, 'GET', `/cma/${id}`);
        expect(v.status).toBe(200);
        expect(v.body.cma.clientShare.ready).toBe(false);
        expect(codes(v.body)).toContain('CLIENT_USE_NOT_ALLOWED');
      }
    } finally {
      await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL WHERE key = 'platform:cma'");
    }
  });
});

describe('erasure and merge (R-CMA-8)', () => {
  it('R-CMA-8 R-DATA-4: an erased contact\'s CMAs are gone', async () => {
    const { c } = await seller({ client: w.owner });
    const r = await oneTap(w.owner, c);
    expect(r.status).toBe(201);
    const { freshReauth } = await import('../leads/testing.js');
    await freshReauth(h, w.owner);
    const er = await call(w.owner, 'POST', `/contacts/${c}/erase`, { reason: 'PRIVACY_REQUEST' });
    expect(er.status).toBe(200);
    expect((await h.su.query('SELECT count(*)::int AS n FROM cma_reports WHERE contact_id = $1', [c])).rows[0].n).toBe(0);
  });

  it('R-CMA-8: merge moves nothing; the survivor lists the merged-away record\'s CMAs', async () => {
    const { command } = await import('../leads/testing.js');
    const survivor = await contact(w.agents[0]!, 'Pat Survivor');
    const { c: loser } = await seller();
    const cma = await oneTap(w.agents[0]!, loser);
    expect(cma.status).toBe(201);
    const m = await command(w.owner, survivor, 'merge', { loserId: loser, ownerChoice: w.agents[0]!.userId });
    expect(m.status).toBe(200);
    // listed for whoever sees the survivor (b11 ownership-data/F1, 0077: the agents and Team Lead case is the next test)
    const list = await call<{ cmas: { id: string; contactId: string; fromMergedRecord: boolean }[] }>(w.owner, 'GET', `/contacts/${survivor}/cmas`);
    expect(list.status).toBe(200);
    expect(list.body.cmas.find((x) => x.id === cma.body.cma.id)).toMatchObject({ contactId: loser, fromMergedRecord: true });
    expect((await h.su.query('SELECT contact_id FROM cma_reports WHERE id = $1', [cma.body.cma.id])).rows[0].contact_id).toBe(loser);
  });

  // b11 ownership-data/F1 (the CMA half; 0077): contacts RLS hides a closed, unowned merged-away record from the
  // survivor's agent and Team Lead, so cma_reports_select admitted its CMAs only to tenant-wide roles and the creator
  it('R-CMA-6 R-CMA-8: after a merge the survivor\'s agent (not the CMA\'s creator) and its Team Lead list and open the merged-away record\'s CMA; an agent who sees neither record still gets 404', async () => {
    const { command } = await import('../leads/testing.js');
    const survivor = await contact(w.agents[0]!, 'Pat Survivor');
    const { c: loser } = await seller({ client: w.agents[1]! });
    const cma = await oneTap(w.agents[1]!, loser);
    expect(cma.status).toBe(201);
    const id = cma.body.cma.id;
    const m = await command(w.owner, survivor, 'merge', { loserId: loser, ownerChoice: w.agents[0]!.userId });
    expect(m.status).toBe(200);
    expect((await h.su.query('SELECT merged_into_contact_id, owner_user_id FROM contacts WHERE id = $1', [loser])).rows[0]).toEqual({ merged_into_contact_id: survivor, owner_user_id: null });
    for (const viewer of [w.agents[0]!, w.teamLead]) {
      const list = await call<{ cmas: { id: string; contactId: string; fromMergedRecord: boolean; mine: boolean; canEdit: boolean }[] }>(viewer, 'GET', `/contacts/${survivor}/cmas`);
      expect(list.status).toBe(200);
      expect(list.body.cmas.find((x) => x.id === id)).toMatchObject({ contactId: loser, fromMergedRecord: true, mine: false, canEdit: false });
      const one = await call<CmaBody & { cma: { canEdit: boolean } }>(viewer, 'GET', `/cma/${id}`);
      expect(one.status).toBe(200);
      expect([one.body.cma.id, one.body.cma.canEdit]).toEqual([id, false]);
      // reading it is all they gain: another person's draft is edited only by its creator or a tenant-wide role (404,
      // R-CMA-8), and a merged-away record's draft by nobody (CONTACT_MERGED, batch 10 db-public/F2; the combined rule)
      const p = await call(viewer, 'PATCH', `/cma/${id}`, { notes: 'not theirs to edit' });
      expect([viewer.role, p.status, p.code]).toEqual([viewer.role, 404, 'NOT_FOUND']);
    }
    expect((await h.su.query('SELECT status, agent_notes FROM cma_reports WHERE id = $1', [id])).rows[0]).toEqual({ status: 'draft', agent_notes: null });
    // the merged-away record itself stays hidden from them (only its CMA is read through the survivor)
    expect((await call(w.agents[0]!, 'GET', `/contacts/${loser}/cmas`)).status).toBe(404);
    const peer = await h.invite(w.owner, 'agent');
    expect((await call(peer, 'GET', `/contacts/${survivor}/cmas`)).status).toBe(404);
    expect((await call(peer, 'GET', `/cma/${id}`)).status).toBe(404);
    // the CMA did not move, and a merged-away record takes no new CMA (cma_reports_insert still needs its own detail)
    expect((await h.su.query('SELECT contact_id FROM cma_reports WHERE id = $1', [id])).rows[0].contact_id).toBe(loser);
  });

  // b11 ownership-data/F2 (the part left open): the survivor lists the merged-away record's CMA, but it stayed on that
  // record, so erasing the record deletes it; the erasure preview says how many before the tap
  it('R-CMA-8 R-DATA-4 (b11 ownership-data/F2): a merged-away record\'s erasure preview counts the CMA report the survivor lists, and erasing the record deletes it', async () => {
    const { command, freshReauth } = await import('../leads/testing.js');
    const survivor = await contact(w.agents[0]!, 'Pat Survivor');
    const { c: loser } = await seller();
    const cma = await oneTap(w.agents[0]!, loser);
    expect(cma.status).toBe(201);
    expect((await command(w.owner, survivor, 'merge', { loserId: loser, ownerChoice: w.agents[0]!.userId })).status).toBe(200);
    await freshReauth(h, w.owner);
    const p = await call<{ mergedInto: string | null; erasedWith: { callRecordings: number; documents: number; cmaReports: number } }>(w.owner, 'GET', `/contacts/${loser}/erasure`);
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ mergedInto: survivor, erasedWith: { callRecordings: 0, documents: 0, cmaReports: 1 } });
    await freshReauth(h, w.owner);
    expect((await call(w.owner, 'POST', `/contacts/${loser}/erase`, { reason: 'DUPLICATE_RECORD' })).status).toBe(200);
    expect((await h.su.query('SELECT count(*)::int AS n FROM cma_reports WHERE id = $1', [cma.body.cma.id])).rows[0].n).toBe(0);
    const list = await call<{ cmas: { id: string }[] }>(w.owner, 'GET', `/contacts/${survivor}/cmas`);
    expect(list.body.cmas.some((x) => x.id === cma.body.cma.id)).toBe(false);
  });
});
