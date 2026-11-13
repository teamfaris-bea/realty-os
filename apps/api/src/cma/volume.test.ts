// Volume check for module 71 (PHASE2_3_PLAN §6, owner budget "POST /cma p95 < 2 s", VERIFY budget) on lane V1-A's 500k
// skewed fixture (mls/testing.ts mlsVolumeFixture: 250k active/pending and 250k sold rows; one postal code with 40,000
// sales in a 2 x 2 mi grid, one city with 120,000, one subdivision with 5,000, the rest spread far apart), under app_user
// and FORCE RLS, through the real route, V1-A's soldCandidates (its 0068_cma_mls_data indexes) and V1-B's engine. The fixture is a
// superuser bulk load, not an application path: V1-A's sync writes at most SYNC_BATCH (500) records a run, so it cannot
// load this volume in a test. Its sold rows close over the 730 days before today, so the main run's 24-month reach is
// full. The read reaches 30 months back for the back-test (service.ts); the fixture holds no older rows, and each tier
// read is newest first up to its limit, so the hot area's reads are the same rows either way.
// The subjects' own earlier sales go through the sync like every other CMA fixture. Every subject sits in the hot area,
// so every tier reaches its limit (F6). The budget is asserted loosely enough for a shared CI box; timings are printed.
// VERIFY on production hardware.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { MLS_VOLUME, mlsVolumeFixture } from '../mls/testing.js';
import { randomUUID } from 'node:crypto';
import { type CmaWorld, address, call, cmaWorld, contact, daysAgo, fixtureEmail, mlsSale, sharePreview } from './testing.js';
import { randomPhone } from '../leads/testing.js';

const { ROWS, HOT_ZIP, HOT_LAT, HOT_LON, BIG_CITY, BIG_SUBDIVISION } = MLS_VOLUME;
let h: ApiHarness;
let w: CmaWorld;

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))]!;

beforeAll(async () => {
  h = await createApiHarness();
  w = await cmaWorld(h);
  const t0 = performance.now();
  await mlsVolumeFixture(h, w.tenantId, w.mls, { anchorDate: daysAgo(0), sizeSource: 'LivingArea' });
  await h.su.query('ANALYZE listings');
  console.info(`[cma volume] inserted ${ROWS} MLS rows in ${Math.round(performance.now() - t0)} ms`);
}, 900_000);
afterAll(async () => {
  await h?.close();
});

describe('POST /cma at volume (VERIFY budget)', () => {
  it('POST /cma and the one-tap CMA stay under p95 2 s on 500k skewed rows; every tier reads its own most recent sales up to its limit (F6)', async () => {
    const times: number[] = [];
    type Body = { cma: { area: { reads: { tier: string; ran: boolean; limitReached: boolean }[] }; comps: unknown[] } };
    let last: Body | null = null;
    for (let i = 0; i < 8; i++) {
      const c = await contact(w.agents[0]!);
      const line1 = `${50 + i} Sample Avenue`;
      await address(h, w.tenantId, c, { line1, city: BIG_CITY, postalCode: HOT_ZIP });
      // the seller bought it eight years ago: its record gives the subject's facts and location (the hot grid's centre)
      await mlsSale(w, { line1, city: BIG_CITY, postalCode: HOT_ZIP, subdivision: BIG_SUBDIVISION, closeDate: daysAgo(3000), sqft: 1500, yearBuilt: 1975, latE6: HOT_LAT + 15_000, lonE6: HOT_LON - 15_000 });
      const t = performance.now();
      const r = await call<Body>(w.agents[0]!, 'POST', `/contacts/${c}/cma`);
      times.push(performance.now() - t);
      expect(r.status).toBe(201);
      last = r.body;
    }
    const t2 = performance.now();
    const e = await call(w.agents[0]!, 'POST', '/cma', { subject: { kind: 'entered', anchor: { region: 'CA', postalCode: HOT_ZIP, city: BIG_CITY }, facts: { propertyType: 'single_family', sqft: 1500 } }, purpose: 'listing_price' });
    times.push(performance.now() - t2);
    expect(e.status).toBe(201);
    console.info(`[cma volume] POST /cma p95 ${Math.round(p95(times))} ms over ${times.length} runs (${times.map((x) => Math.round(x)).join(', ')})`);
    expect(last!.cma.comps.length).toBeGreaterThanOrEqual(3);
    expect(last!.cma.area.reads.map((t) => t.tier)).toEqual(['subdivision', 'within_1mi', 'postal_code', 'within_3mi', 'city', 'rate_pool']);
    for (const t of last!.cma.area.reads) expect([t.tier, t.ran, t.limitReached]).toEqual([t.tier, true, true]);
    expect(p95(times)).toBeLessThan(2000);
  }, 300_000);

  it('VERIFY 5 R-CMA-9: GET /cma/:id/share-preview (its read transaction and comms\' preview transaction) stays under p95 2 s on the same rows', async () => {
    const times: number[] = [];
    for (let i = 0; i < 6; i++) {
      const r0 = await call<{ contact: { id: string } }>(w.agents[0]!, 'POST', '/contacts', { commandId: randomUUID(), displayName: 'Vol Seller', phones: [randomPhone()], emails: [fixtureEmail()] });
      const c = r0.body.contact.id;
      const line1 = `${80 + i} Sample Avenue`;
      await address(h, w.tenantId, c, { line1, city: BIG_CITY, postalCode: HOT_ZIP });
      await mlsSale(w, { line1, city: BIG_CITY, postalCode: HOT_ZIP, subdivision: BIG_SUBDIVISION, closeDate: daysAgo(3000), sqft: 1500, yearBuilt: 1975, latE6: HOT_LAT + 15_000, lonE6: HOT_LON - 15_000 });
      const tap = await call<{ cma: { id: string } }>(w.agents[0]!, 'POST', `/contacts/${c}/cma`);
      expect(tap.status).toBe(201);
      const t = performance.now();
      const p = await sharePreview(w.agents[0]!, tap.body.cma.id);
      times.push(performance.now() - t);
      expect(p.status).toBe(200);
      expect(p.body.preview.decision).not.toBeNull(); // comms' preview ran (no sender in this world: a deny, in words)
    }
    console.info(`[cma volume] share-preview p95 ${Math.round(p95(times))} ms over ${times.length} runs (${times.map((x) => Math.round(x)).join(', ')})`);
    expect(p95(times)).toBeLessThan(2000);
  }, 300_000);
});
