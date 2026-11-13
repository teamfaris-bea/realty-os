// The seller watch (ISA-3 scope 7; R-ISA-17, R-ISA-18; E535, E537). Real Postgres through the API harness; fakes only.
// Delivery goes through STUB(ISA-2) enqueueListingEventInTx (not built yet), so events are recorded as not delivered.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../../auth/testHarness.js';
import { feedLastSyncedAt, saleReso, syncSales } from '../../cma/testing.js';
import { depsFromPlatform } from '../../comms/runtime.js';
import { mlsEligibility } from './cmaSeam.js';
import { competitorLine, smsFits } from './competition.js';
import { fitsSms } from './isa1Seam.js';
import type { IsaDeps } from './isa2Seam.js';
import { type SellerLead, type SellerWorld, asSystem, confirm, nowInstant, sellerLead, sellerWorld } from './testing.js';
import { runSellerWatchInTx } from './watch.js';

let h: ApiHarness;
let w: SellerWorld;
let l: SellerLead;
const fw = () => ({ h, tenantId: w.tenantId, mls: w.mls });
const deps = (): IsaDeps => depsFromPlatform(h.app.platform) as unknown as IsaDeps;
const run = () => asSystem(h, w, l, (tx, _a, actor) => runSellerWatchInTx(tx, deps(), actor, l.assignmentId, nowInstant()));
const yesterday = () => h.su.query(`UPDATE ai_isa_seller_watch SET last_run_at = now() - interval '2 days' WHERE assignment_id = $1`, [l.assignmentId]);
const snapshot = async () => (await h.su.query<{ s: Record<string, { status: string }> }>(`SELECT last_snapshot AS s FROM ai_isa_seller_watch WHERE assignment_id = $1`, [l.assignmentId])).rows[0]!.s;

beforeAll(async () => {
  h = await createApiHarness();
  w = await sellerWorld(h);
  l = await sellerLead(h, w);
  expect((await confirm(w, l)).status).toBe(200);
});
afterAll(async () => {
  await h?.close();
});

describe('ai_isa.seller_watch (E535, E537)', () => {
  const rival = saleReso({ status: 'active', line1: '400 Rival St', beds: 3, sqft: 1500, listPriceCents: 52_000_000 });
  let rivalId = '';

  it('E537: the first run resets the snapshot silently (no event); a run the same local day does nothing', async () => {
    rivalId = (await syncSales(fw(), [rival]))[0]!;
    const first = await run();
    expect(first).toEqual({ code: 'VERSION_RESET', events: [] });
    expect(Object.keys(await snapshot())).toContain(rivalId);
    expect((await run()).code).toBe('ALREADY_RAN');
  });

  it('E537: an event only from a row’s own newer record (competitor_pending), delivered through the STUB (not delivered); none from absence', async () => {
    await yesterday();
    expect(await run()).toEqual({ code: 'RAN', events: [] });
    await syncSales(fw(), [{ ...rival, StandardStatus: 'Pending', ModificationTimestamp: new Date().toISOString() }]);
    await yesterday();
    expect(await run()).toEqual({ code: 'RAN', events: [{ event: 'competitor_pending', listingId: rivalId, delivered: false }] });
    // absence: the row leaves the competing set (display withdrawn) with no newer record → no event
    await h.su.query(`UPDATE listings SET display_allowed = false WHERE id = $1`, [rivalId]);
    await yesterday();
    expect((await run()).events).toEqual([]);
    await h.su.query(`UPDATE listings SET display_allowed = true WHERE id = $1`, [rivalId]);
  });

  it('E537 R-ISA-18: competitor_sold is recorded, never rendered (SOLD_NOT_CLEARED)', async () => {
    await syncSales(fw(), [{ ...rival, StandardStatus: 'Closed', ClosePrice: '510000.00', CloseDate: new Date().toISOString().slice(0, 10), ModificationTimestamp: new Date(Date.now() + 1000).toISOString() }]);
    await yesterday();
    const r = await run();
    expect(r.events).toEqual([{ event: 'competitor_sold', listingId: rivalId, delivered: false }]);
    expect(Object.keys(await snapshot())).not.toContain(rivalId);
    const line = await asSystem(h, w, l, async (tx) => {
      const e = await mlsEligibility(tx, nowInstant());
      const row = (await tx.selectFrom('listings').selectAll().where('id', '=', rivalId).execute())[0] as never;
      return competitorLine(e, row, 'competitor_sold', 'Team', nowInstant());
    });
    expect(line).toEqual({ ok: false, refusal: 'SOLD_NOT_CLEARED' });
  });

  it('E535: a stale feed skips the run and keeps the snapshot', async () => {
    const before = await snapshot();
    await feedLastSyncedAt({ h, mls: w.mls }, new Date(Date.now() - 3 * 86_400_000));
    try {
      await yesterday();
      expect((await run()).code).toBe('SKIPPED_STALE');
      expect(await snapshot()).toEqual(before);
    } finally {
      await feedLastSyncedAt({ h, mls: w.mls }, new Date());
    }
  });

  it('E537: a changed display-rules version (the attribution) resets the snapshot silently', async () => {
    await h.su.query(`UPDATE integration_connections SET license_pack = jsonb_set(license_pack, '{attribution_text}', '"Changed attribution (test)."') WHERE id = $1`, [w.mls]);
    await yesterday();
    expect(await run()).toEqual({ code: 'VERSION_RESET', events: [] });
  });

  it('R-ISA-17: fitsSms true with smsSegments > 3 goes by email (the middle dot is not GSM-7)', () => {
    const body = Array.from({ length: 20 }, (_, i) => `Item ${i} · listed`).join(' ');
    expect(fitsSms(body)).toBe(true);
    expect(smsFits(body)).toBe(false);
  });
});
