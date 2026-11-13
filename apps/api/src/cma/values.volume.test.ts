// Lane V2-B at volume (R-CMA-10; owner question 7; VERIFY E4, E8) on lane V1-A's 500k skewed fixture (mls/testing.ts
// mlsVolumeFixture), under app_user and FORCE RLS. Reported, not asserted against a threshold (owner question 7: decide
// after the measured share): the share of in-house ranges wider than avm_max_range_bps' 2,500 default and of
// month-on-month jumps over 1,000 bps (two passes 30 days apart: the same subjects valued as of today and 30 days
// earlier); the queue-time gate's time (the work done under the contact lock: E8); the seller-update view with
// platform:cma cleared (freshHash runs the value section on every view: E4, proposed <= 2.5 s). Timings are printed.
// VERIFY on production hardware.
import { addLocalDays } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { MLS_VOLUME, mlsVolumeFixture } from '../mls/testing.js';
import { call, reconcile, sellerListing } from '../sellerUpdates/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { automatedGate } from './avm.js';
import { valueForSubjectInTx } from './pipeline.js';
import { readinessInputOf } from './service.js';
import { type CmaWorld, address, cmaWorld, contact, daysAgo, mlsSale } from './testing.js';

const { ROWS, HOT_ZIP, HOT_LAT, HOT_LON, BIG_CITY, BIG_SUBDIVISION } = MLS_VOLUME;
let h: ApiHarness;
let w: CmaWorld;

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * 0.95))]!;
const share = (n: number, of: number) => `${n}/${of} (${of === 0 ? 0 : Math.round((n * 1000) / of) / 10} %)`;

beforeAll(async () => {
  h = await createApiHarness();
  w = await cmaWorld(h);
  const t0 = performance.now();
  await mlsVolumeFixture(h, w.tenantId, w.mls, { anchorDate: daysAgo(0), sizeSource: 'LivingArea' });
  await h.su.query('ANALYZE listings');
  console.info(`[values volume] inserted ${ROWS} MLS rows in ${Math.round(performance.now() - t0)} ms`);
}, 900_000);
afterAll(async () => {
  await h?.close();
});

function readOnly<T>(fn: (tx: Tx, now: Parameters<Parameters<typeof withTenantTx>[1]>[1]) => Promise<T>): Promise<T> {
  return withTenantTx(
    systemActor(w.tenantId, 'provider'),
    async (tx, now) => {
      await sql`SET TRANSACTION READ ONLY`.execute(tx);
      return fn(tx, now);
    },
    { db: h.database },
  );
}

async function withCmaCleared<T>(fn: () => Promise<T>): Promise<T> {
  await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:cma' AND status = 'published'");
  try {
    return await fn();
  } finally {
    await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL WHERE key = 'platform:cma'");
  }
}

describe('lane V2-B at volume (reported, VERIFY)', () => {
  it('R-CMA-10 owner question 7: the shares of ranges over 2,500 bps and of 30-day jumps over 1,000 bps; the queue-time gate\'s time (E8)', async () => {
    const N = 20;
    const widths: number[] = [];
    const jumps: number[] = [];
    const gate: number[] = [];
    const run: number[] = [];
    let unavailable = 0;
    for (let i = 0; i < N; i++) {
      const c = await contact(w.agents[0]!);
      const line1 = `${300 + i} Sample Avenue`;
      const a = await address(h, w.tenantId, c, { kind: 'home', line1, city: BIG_CITY, postalCode: HOT_ZIP });
      await mlsSale(w, { line1, city: BIG_CITY, postalCode: HOT_ZIP, subdivision: BIG_SUBDIVISION, closeDate: daysAgo(3000), sqft: 1200 + i * 40, yearBuilt: 1960 + i, latE6: HOT_LAT + 5_000 * i, lonE6: HOT_LON - 5_000 * i });
      await readOnly(async (tx, now) => {
        const t = performance.now();
        const today = await valueForSubjectInTx(tx, now, { kind: 'contact_address', contactAddressId: a }, { contactId: c, use: 'automated_notes' });
        run.push(performance.now() - t);
        const earlier = await valueForSubjectInTx(tx, now, { kind: 'contact_address', contactAddressId: a }, { contactId: c, use: 'automated_notes', valuationDate: daysAgo(30) });
        if (!today.ok || !today.result.available) {
          unavailable += 1;
          return;
        }
        widths.push(((today.result.highCents - today.result.lowCents) * 10_000) / today.result.valueCents);
        if (earlier.ok && earlier.result.available) jumps.push((Math.abs(today.result.valueCents - earlier.result.valueCents) * 10_000) / earlier.result.valueCents);
        const g = performance.now();
        await automatedGate(tx, now, readinessInputOf(today.resolved, today.result, today.conns, now, { nearMatchDismissed: [], hasValue: true, use: 'automated_notes', selfListingIds: today.resolved.selfListingIds }), { output: 'note' });
        gate.push(performance.now() - g);
      });
    }
    console.info(`[values volume] ranges over 2,500 bps: ${share(widths.filter((x) => x > 2500).length, widths.length)}; jumps over 1,000 bps over 30 days: ${share(jumps.filter((x) => x > 1000).length, jumps.length)}; unavailable: ${unavailable}/${N}`);
    console.info(`[values volume] range widths bps: ${widths.map((x) => Math.round(x)).join(', ')}`);
    console.info(`[values volume] value run p95 ${Math.round(p95(run))} ms; queue-time gate (automatedGate 'note') p95 ${Math.round(p95(gate))} ms over ${gate.length}`);
    expect(widths.length + unavailable).toBe(N);
  }, 600_000);

  it('E4: the seller-update view with platform:cma cleared (freshHash runs the value section per view)', async () => {
    const l = await sellerListing(w.agents[0]!, { postalCode: HOT_ZIP });
    await h.su.query('UPDATE listings SET city = $2 WHERE id = $1', [l.listingId, BIG_CITY]);
    const times: number[] = [];
    let kind = '';
    await withCmaCleared(async () => {
      await reconcile(h, w.tenantId, addLocalDays(Date.now() as never, 0, 'UTC' as never));
      const r = await call<{ update: { id: string; sections: { kind: string; state: string }[] } }>(w.agents[0]!, 'GET', `/listings/${l.listingId}/seller-update`);
      expect(r.status).toBe(200);
      kind = r.body.update.sections.find((s) => s.kind === 'value')!.state;
      for (let i = 0; i < 8; i++) {
        const t = performance.now();
        const v = await call(w.agents[0]!, 'GET', `/seller-updates/${r.body.update.id}`);
        times.push(performance.now() - t);
        expect(v.status).toBe(200);
      }
    });
    console.info(`[values volume] seller-update view p95 ${Math.round(p95(times))} ms over ${times.length} (value section: ${kind}; ${times.map((x) => Math.round(x)).join(', ')})`);
  }, 600_000);
});
