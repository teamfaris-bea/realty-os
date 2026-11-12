// R-CMA-7 client readiness after the batch 10 review (gates/F4, gates/F5, api-ui/F1, api-ui/F4, api-ui/F8): every
// blocker that holds is listed with its own reason, on every view, also after the feed is disconnected or its valuation
// use withdrawn; the home's own live record is never a dismissable near match; nothing reads as if sharing existed in
// V1. Fakes only: MLS rows are RESO fixtures stored through V1-A's sync; nothing is sent.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { mlsConnection } from '../mls/testing.js';
import { ESTIMATE_SENTENCE } from './gates.js';
import { type CmaBody, type CmaWorld, address, call, cmaPack, cmaWorld, codes, contact, daysAgo, feedLastSyncedAt, localSales, mlsSale, oneTap } from './testing.js';

let h: ApiHarness;

beforeAll(async () => {
  h = await createApiHarness();
}, 180_000);
afterAll(async () => {
  await h?.close();
});

/** A seller of agents[0] whose home's earlier sale is in the MLS (facts come from it). */
async function seller(w: CmaWorld, line1: string) {
  const c = await contact(w.agents[0]!);
  await address(h, w.tenantId, c, { kind: 'property', line1 });
  await mlsSale(w, { line1, closeDate: daysAgo(4 * 365), sqft: 1500, beds: 3 });
  return c;
}

const view = (w: CmaWorld, id: string) => call<CmaBody>(w.agents[0]!, 'GET', `/cma/${id}`);
const sentenceOf = (b: CmaBody, code: string) => b.cma.clientShare.blockers.find((x) => x.code === code)?.sentence;
const setPack = (conn: string, pack: Record<string, unknown>) => h.su.query('UPDATE integration_connections SET license_pack = $2::jsonb WHERE id = $1', [conn, JSON.stringify(pack)]);
const disconnect = (conn: string) => h.su.query("UPDATE integration_connections SET status = 'disconnected', disconnected_at = now() WHERE id = $1", [conn]);

describe('R-CMA-7: readiness without the agent gate (gates/F5, api-ui/F1)', () => {
  it('R-CMA-7 E371: with one feed, withdrawing its valuation use and then disconnecting it keep every blocker that holds, each with its own reason, and the live near match', async () => {
    const w = await cmaWorld(h);
    await localSales(w, 8);
    const c = await seller(w, '881 Sample Avenue');
    const near = await mlsSale(w, { line1: '881 Sample Street', status: 'active', closePriceCents: null, closeDate: null });
    const r = await oneTap(w.agents[0]!, c);
    expect(r.status).toBe(201);
    expect(codes(r.body)).toEqual(['PLATFORM_NOT_CLEARED', 'POSSIBLE_LIVE_LISTING']);
    expect(r.body.cma.nearMatches.map((x) => x.listingId)).toEqual([near]);

    // an Admin withdraws the agent use (the client use stays recorded): the stored CMA stays readable
    await setPack(w.mls, cmaPack({ valuation: { agent_cma: false } }));
    const withdrawn = await view(w, r.body.cma.id);
    expect(withdrawn.status).toBe(200);
    expect(codes(withdrawn.body)).toEqual(['PLATFORM_NOT_CLEARED', 'VALUATION_USE_WITHDRAWN', 'POSSIBLE_LIVE_LISTING']);
    expect(sentenceOf(withdrawn.body, 'VALUATION_USE_WITHDRAWN')).toBe('Your MLS licence pack no longer says this feed’s sold data may be used for valuations, so this CMA could not be shown to a client. An Owner or Admin records this from your MLS agreement.');
    expect(withdrawn.body.cma.nearMatches.map((x) => x.listingId)).toEqual([near]);
    expect((withdrawn.body.cma.clientShare as { estimateSentence?: string }).estimateSentence).toBe(ESTIMATE_SENTENCE);

    // then the feed is disconnected: its own reason, never "no sold homes to compare" beside the stored comps
    await disconnect(w.mls);
    const gone = await view(w, r.body.cma.id);
    expect(gone.status).toBe(200);
    // its comps can no longer reach a client either (V1-A's clientView refuses a feed that is not live)
    expect(codes(gone.body)).toEqual(['PLATFORM_NOT_CLEARED', 'FEED_DISCONNECTED', 'VALUATION_USE_WITHDRAWN', 'COMPS_HIDDEN', 'POSSIBLE_LIVE_LISTING']);
    expect(sentenceOf(gone.body, 'FEED_DISCONNECTED')).toBe('An MLS feed this CMA was built from is no longer connected, so nothing from it could be shown to a client.');
    expect(gone.body.cma.comps.length).toBeGreaterThanOrEqual(3);
    expect(gone.body.cma.nearMatches.map((x) => x.listingId)).toEqual([near]);
  });

  it('R-CMA-7: a second feed the CMA read is disconnected while the first stays live: FEED_DISCONNECTED, never the display-pack reason', async () => {
    const w = await cmaWorld(h);
    const b = { h, tenantId: w.tenantId, mls: await mlsConnection(h, w.tenantId, w.owner.userId!, { pack: cmaPack(), lastSyncedAt: new Date() }) };
    await localSales(w, 4);
    await localSales(b, 4);
    const r = await oneTap(w.agents[0]!, await seller(w, '882 Sample Avenue'));
    expect(r.status).toBe(201);
    const compConns = (await h.su.query<{ c: string }>('SELECT DISTINCT mls_connection_id AS c FROM listings WHERE id = ANY ($1::uuid[])', [r.body.cma.comps.map((x) => x.saleListingId)])).rows.map((x) => x.c);
    expect(compConns.sort()).toEqual([w.mls, b.mls].sort());
    await disconnect(b.mls);
    const v = await view(w, r.body.cma.id);
    // B's comps are hidden from clients too; A's display pack is reviewed, so the display-pack reason is never given
    expect(codes(v.body)).toEqual(['PLATFORM_NOT_CLEARED', 'FEED_DISCONNECTED', 'COMPS_HIDDEN']);
  });
});

describe('E370 F2: MLS records the 0068 backfill has not re-read yet (mls_normalize_version 1, no stored address key) (gates/F4)', () => {
  /** The row as it was stored before 0061 and before the backfill reached it: no address key, the AVM flag column at its default. */
  const asVersion1 = (id: string) => h.su.query('UPDATE listings SET address_key = NULL, mls_normalize_version = 1 WHERE id = $1', [id]);
  const NOT_READ = 'An MLS listing of this home has not been re-read since the feed’s automated-valuation flag was added, so whether the seller allows automated valuations is not known yet. Until it is, this CMA could not be shown to a client.';

  it('E370 R-CMA-7: the home\'s own live record without a stored key is the subject\'s (SELLER_WITHHELD, never a dismissable near match), and its unread flag is not stated, whatever the column holds', async () => {
    const w = await cmaWorld(h);
    await localSales(w, 6);
    for (const [line1, avmDisplayAllowed] of [['883 Sample Avenue', false], ['885 Sample Avenue', true]] as const) {
      const c = await seller(w, line1);
      const live = await mlsSale(w, { line1, status: 'active', closePriceCents: null, closeDate: null, avmDisplayAllowed });
      await asVersion1(live);
      const r = await oneTap(w.agents[0]!, c);
      expect(r.status).toBe(201);
      const withheld = r.body.cma.clientShare.blockers.find((x) => x.code === 'SELLER_WITHHELD');
      expect([line1, withheld?.listingIds, withheld?.sentence]).toEqual([line1, [live], NOT_READ]);
      expect(codes(r.body)).not.toContain('POSSIBLE_LIVE_LISTING');
      expect(r.body.cma.nearMatches).toEqual([]);
      // it is not a near match, so it cannot be dismissed as "a different home"
      const p = await call<CmaBody>(w.agents[0]!, 'PATCH', `/cma/${r.body.cma.id}`, { nearMatchDismissed: [live] });
      expect(p.status).toBe(200);
      expect(p.body.cma.subject.nearMatchDismissed).toEqual([]);
      expect(codes(p.body)).toContain('SELLER_WITHHELD');
    }
  });

  it('F2: a near match not re-read yet is listed with its AVM flag unknown, and its sentence says nothing about the flag', async () => {
    const w = await cmaWorld(h);
    await localSales(w, 6);
    const c = await seller(w, '884 Sample Avenue');
    const near = await mlsSale(w, { line1: '884 Sample Street', status: 'active', closePriceCents: null, closeDate: null, avmDisplayAllowed: false });
    await asVersion1(near);
    const r = await oneTap(w.agents[0]!, c);
    expect(r.status).toBe(201);
    expect(r.body.cma.nearMatches).toEqual([expect.objectContaining({ listingId: near, avmDisplayAllowed: null, dismissed: false })]);
    const b = r.body.cma.clientShare.blockers.find((x) => x.code === 'POSSIBLE_LIVE_LISTING')!;
    expect(b.listingIds).toEqual([near]);
    expect(b.sentence).toMatch(/^An MLS listing at 884 Sample Street, Oakland may be this home\./);
    expect(b.sentence).not.toMatch(/automated valuations/);
  });
});

describe('E369: "MLS data as of …" with two feeds (api-ui/F8)', () => {
  it('E369 R-CMA-6: comps from a fresh feed and a stale one are dated by the stale one, the oldest data they came from', async () => {
    const w = await cmaWorld(h);
    const b = { h, tenantId: w.tenantId, mls: await mlsConnection(h, w.tenantId, w.owner.userId!, { pack: cmaPack(), lastSyncedAt: new Date() }) };
    await localSales(w, 4);
    await localSales(b, 4);
    const c = await seller(w, '886 Sample Avenue'); // A's sync just ran: A is fresh
    const stale = new Date(Date.now() - 2 * 86_400_000);
    await feedLastSyncedAt(b, stale);
    const r = await oneTap(w.agents[0]!, c);
    expect(r.status).toBe(201);
    const compConns = (await h.su.query<{ c: string }>('SELECT DISTINCT mls_connection_id AS c FROM listings WHERE id = ANY ($1::uuid[])', [r.body.cma.comps.map((x) => x.saleListingId)])).rows.map((x) => x.c);
    expect(compConns.sort()).toEqual([w.mls, b.mls].sort());
    expect(r.body.cma.mlsDataAsOf).toBe(stale.toISOString());
    expect((await h.su.query('SELECT mls_data_as_of FROM cma_reports WHERE id = $1', [r.body.cma.id])).rows[0].mls_data_as_of.toISOString()).toBe(stale.toISOString());
    expect(codes(r.body)).toContain('FEED_STALE');
  });
});

describe('D9 R-CMA-7: readiness reads as readiness: V1 shares nothing (api-ui/F4)', () => {
  const V1 = 'Sharing with clients is not available in this version, so nothing from this CMA reaches a client. Readiness lists what would also have to change before it could be shown to one.';
  type Share = { ready?: boolean; allowed?: unknown; sharingAvailable?: unknown; sentence?: unknown; blockers: { code: string; sentence: string }[] };
  const shareOf = (b: CmaBody) => b.cma.clientShare as unknown as Share;

  it('D9 R-CMA-7: every view says sharing is not in this version; no blocker sentence tells the agent to share; a home with no street is told to prepare a new CMA', async () => {
    // one world where nearly every blocker holds: an unreviewed display pack without client sold fields, no client use,
    // an unreviewed valuation section with no statement, a stale feed, two sales only (no value)
    const w = await cmaWorld(h, { pack: cmaPack({ reviewed: false, clientSold: false, valuation: { client_cma: false, reviewed_by_counsel_at: null, statements: {} } }) });
    await localSales(w, 2);
    const c = await seller(w, '887 Sample Avenue');
    await mlsSale(w, { line1: '887 Sample Avenue', status: 'active', closePriceCents: null, closeDate: null, avmDisplayAllowed: false });
    await mlsSale(w, { line1: '887 Sample Street', status: 'active', closePriceCents: null, closeDate: null, avmDisplayAllowed: false });
    await feedLastSyncedAt(w, new Date(Date.now() - 3 * 86_400_000));
    const tap = await oneTap(w.agents[0]!, c);
    const area = await call<CmaBody>(w.agents[0]!, 'POST', '/cma', { purpose: 'listing_price', subject: { kind: 'entered', anchor: { region: 'CA', postalCode: '94110', city: 'Oakland' }, facts: { propertyType: 'single_family', sqft: 1400 } } });
    expect([tap.status, area.status]).toEqual([201, 201]);
    const seen = new Set([...codes(tap.body), ...codes(area.body)]);
    for (const code of ['PLATFORM_NOT_CLEARED', 'MLS_CLIENT_DISPLAY_OFF', 'FEED_STALE', 'CLIENT_USE_NOT_ALLOWED', 'VALUATION_NOT_REVIEWED', 'NO_VALUATION_STATEMENT', 'COMPS_HIDDEN', 'SUBJECT_ADDRESS_UNKNOWN', 'SELLER_WITHHELD', 'POSSIBLE_LIVE_LISTING', 'NO_VALUE']) expect([code, seen.has(code)]).toEqual([code, true]);
    // the two codes of a stored CMA whose feed changed since
    await setPack(w.mls, cmaPack({ valuation: { agent_cma: false } }));
    await disconnect(w.mls);
    const later = await view(w, tap.body.cma.id);
    expect(codes(later.body)).toEqual(expect.arrayContaining(['FEED_DISCONNECTED', 'VALUATION_USE_WITHDRAWN']));
    for (const b of [tap.body, area.body, later.body]) {
      expect(shareOf(b)).toMatchObject({ ready: false, sharingAvailable: false, sentence: V1 });
      expect('allowed' in shareOf(b)).toBe(false);
      for (const x of shareOf(b).blockers) expect([x.code, /\bshar(e|ed|ing)\b/i.test(x.sentence)]).toEqual([x.code, false]);
    }
    expect(sentenceOf(area.body, 'SUBJECT_ADDRESS_UNKNOWN')).toBe('The home’s full address (street, city, state and ZIP code) is not known, so its own MLS listings and live listings that may be this home could not be checked. To check them, prepare a new CMA with the home’s full address.');
    expect(sentenceOf(tap.body, 'PLATFORM_NOT_CLEARED')).toBe('Client CMAs and seller value ranges wait for counsel review of the in-house CMA wording (platform:cma), which is not recorded.');
  });

  it('D9 R-CMA-7: with every check met (platform:cma cleared for this check only) the CMA is ready, and sharing is still not available', async () => {
    const w = await cmaWorld(h);
    await localSales(w, 6);
    const c = await seller(w, '888 Sample Avenue');
    await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:cma'");
    try {
      const r = await oneTap(w.agents[0]!, c);
      expect(r.status).toBe(201);
      expect(shareOf(r.body)).toEqual({ ready: true, sharingAvailable: false, sentence: V1, blockers: [], estimateSentence: ESTIMATE_SENTENCE });
    } finally {
      await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL WHERE key = 'platform:cma'");
    }
  });
});
