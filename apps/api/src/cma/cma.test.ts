// Module 71 api/cma behaviour against real Postgres (R-CMA-6, R-CMA-7, R-CMA-8; F4, F15; E365, E366, E369, E370,
// E371, E373), on lane V1-A's sold data and lane V1-B's engine. Fakes only: nothing is sent, no real MLS is called (MLS
// rows are RESO fixtures stored through V1-A's sync with a deterministic record feed).
import { CMA_METHOD_VERSION } from '@realty/core/valuation';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { type CmaBody, type CmaWorld, address, call, cmaPack, cmaWorld, codes, contact, daysAgo, feedLastSyncedAt, localSales, mlsSale, oneTap, teamListing } from './testing.js';

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
    expect(v.clientShare.allowed).toBe(false);
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

  it('E368 R-CMA-3: $15,000 of seller concessions lower the adjusted price by $15,000, never raise it', async () => {
    const { c } = await seller();
    const conc = await mlsSale(w, { closeDate: daysAgo(5), sqft: 1500, beds: 3, bathsX10: 20, concessionsCents: 1_500_000, closePriceCents: 52_500_000, subdivision: 'Sample Heights' });
    const a = await oneTap(w.agents[0]!, c);
    const comp = a.body.cma.comps.find((x) => x.listingId === conc);
    expect(comp).toBeDefined();
    expect(comp!.adjustments.find((x) => x.feature === 'concessions')!.amountCents).toBe(-1_500_000);
  });

  it('E377 R-CMA-8: a superseded CMA is not edited (CMA_NOT_DRAFT) and stays unchanged', async () => {
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
    expect([r.status, r.code, e.error.details.sentence]).toEqual([409, 'CMA_VALUATION_NOT_ALLOWED', 'Your MLS licence pack does not say MLS sold data may be used for valuations. An Owner or Admin records this from your MLS agreement.']);
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
    expect(b.sentence).toMatch(/^An MLS listing at 880 Sample Street, Oakland may be this home\. Confirm it is a different home before sharing\. That listing asks that automated valuations not be shown\.$/);
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

  it('R-CMA-7: every blocker code is reachable, each in words, and with every gate met sharing is allowed', async () => {
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
      expect(r.body.cma.clientShare).toMatchObject({ allowed: true, blockers: [], estimateSentence: 'This is an estimate, not an appraisal.' });
    } finally {
      await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL WHERE key = 'platform:cma'");
    }
    const after = await oneTap(wa.agents[0]!, c);
    expect(codes(after.body)).toEqual(['PLATFORM_NOT_CLEARED']); // readiness is computed on every view, never stored
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
    // listed for whoever can see the merged-away record (contacts RLS hides a closed, unowned loser from its former agent:
    // a reported gap, no policy is widened here)
    const list = await call<{ cmas: { id: string; contactId: string; fromMergedRecord: boolean }[] }>(w.owner, 'GET', `/contacts/${survivor}/cmas`);
    expect(list.status).toBe(200);
    expect(list.body.cmas.find((x) => x.id === cma.body.cma.id)).toMatchObject({ contactId: loser, fromMergedRecord: true });
    expect((await h.su.query('SELECT contact_id FROM cma_reports WHERE id = $1', [cma.body.cma.id])).rows[0].contact_id).toBe(loser);
  });
});
