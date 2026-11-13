// Lane V2-B deliverable 2 (R-CMA-10, R-AVM-3, R-INT-1, R-TEN-1..3): the in-house provider tried against its own risk
// rules: its own read-only transaction outside every lock (E635), tenancy, data versus configuration failures (E626,
// E620), the fail-closed ref (E634) and the production registration. Real Postgres; fakes only; nothing is sent.
import { randomUUID } from 'node:crypto';
import type { ResoLike } from '@realty/core/listings';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness, testConfig } from '../auth/testHarness.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { avmRefresh } from '../nurture/avm.js';
import { type NurtureWorld, type PastClient, approveTemplate, nurtureWorld, pastClient, valuationsOf, withAvmCleared } from '../nurture/testing.js';
import { createProviders } from '../providers/index.js';
import { FakeAvmP2 } from '../providers/integrations/fakes.js';
import type { TenantId } from '@realty/core/foundation';
import { syncConnection } from '../mls/sync.js';
import { makeDue, mlsDeps, pagedFeed } from '../mls/testing.js';
import { SPARK_FIELD_MAPPING } from '../providers/integrations/spark.js';
import { IN_HOUSE_PROVIDER, IN_HOUSE_REF, InHouseAvm, readOnlySystemTx } from './avm.js';
import { valueForSubjectInTx } from './pipeline.js';
import { TEST_STATEMENT, cmaPack, daysAgo, feedLastSyncedAt, localSales, mlsSale, saleReso, syncSales } from './testing.js';

let h: ApiHarness;
let a: NurtureWorld;
let b: NurtureWorld;

/** The home's area (pastClient's synthetic Springfield, SC 29401) and a valuation statement for SC. */
const SC = { city: 'Springfield', region: 'SC', postalCode: '29401' } as const;
export const scPack = (valuation: Record<string, unknown> = {}, o: Parameters<typeof cmaPack>[0] = {}) => cmaPack({ ...o, valuation: { statements: { SC: { text: TEST_STATEMENT, min_point_size: 10 } }, ...valuation } });
const setPack = (conn: string, pack: Record<string, unknown>) => h.su.query('UPDATE integration_connections SET license_pack = $2::jsonb WHERE id = $1', [conn, JSON.stringify(pack)]);

/** Clears platform:cma for `fn` (counsel review is platform data of this test database; restored to NULL after). */
async function withCmaCleared<T>(fn: () => Promise<T>): Promise<T> {
  await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = now() WHERE key = 'platform:cma' AND status = 'published'");
  try {
    return await fn();
  } finally {
    await h.su.query("UPDATE jurisdiction_packs SET reviewed_by_counsel_at = NULL WHERE key = 'platform:cma'");
  }
}
const bothCleared = <T>(fn: () => Promise<T>) => withCmaCleared(() => withAvmCleared(h, fn));

/** A past client whose home's earlier sale is in the MLS (its facts) next to `n` local sales of the same ZIP. */
async function covered(w: NurtureWorld, n = 8, sale: Record<string, unknown> = {}): Promise<PastClient> {
  const c = await pastClient(h, w, w.agents[0]!);
  if (n > 0) await localSales(mw(w), n, SC);
  await mlsSale(mw(w), { line1: c.line1, ...SC, closeDate: daysAgo(1500), sqft: 1500, beds: 3, ...sale });
  return c;
}

/** The world as cma/testing.ts's MLS fixtures take it. */
const mw = (w: NurtureWorld) => ({ h, tenantId: w.tenantId, mls: w.mls });
const ctx = (w: NurtureWorld, c: PastClient) => ({ tenantId: w.tenantId, contactId: c.id, contactAddressId: c.addressId, db: h.database });
const facts = (c: PastClient) => ({ line1: c.line1, ...SC, postalCode: c.postalCode });
const pass = (w: NurtureWorld, avm: InHouseAvm | FakeAvmP2 = new InHouseAvm()) => avmRefresh({ db: h.database, ids: depsFromPlatform(h.app.platform).ids, avm }, w.tenantId);

beforeAll(async () => {
  h = await createApiHarness();
  a = await nurtureWorld(h);
  b = await nurtureWorld(h);
  for (const w of [a, b]) {
    await setPack(w.mls, scPack());
    await approveTemplate(w.agents[0]!, 'after_closing_alerts');
  }
}, 240_000);
afterAll(async () => {
  await h?.close();
});

describe('E635 R-CMA-10: the provider\'s own transaction', () => {
  it('E635 R-AVM-3: transaction_read_only is on, no advisory lock is held in any backend while it reads, and a write in it fails 25006', async () => {
    const c = await covered(a);
    const avm = new InHouseAvm();
    const seen: { ro: string; advisory: number }[] = [];
    avm.onRead = async (tx) => {
      const ro = (await sql<{ v: string }>`SELECT current_setting('transaction_read_only') AS v`.execute(tx)).rows[0]!.v;
      const r = await h.su.query<{ n: number }>("SELECT count(*)::int AS n FROM pg_locks l JOIN pg_stat_activity s ON s.pid = l.pid WHERE l.locktype = 'advisory' AND s.datname = current_database()");
      seen.push({ ro, advisory: r.rows[0]!.n });
    };
    await bothCleared(() => pass(a, avm));
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen).toEqual(seen.map(() => ({ ro: 'on', advisory: 0 })));
    expect((await valuationsOf(h, c.addressId)).map((v) => v.status)).toEqual(['ok']);
    const err = await readOnlySystemTx(a.tenantId, h.database, (tx) => sql`UPDATE tenant_settings SET avm_max_range_bps = avm_max_range_bps WHERE tenant_id = app.tenant_id()`.execute(tx)).then(
      () => null,
      (e: { code?: string }) => e.code,
    );
    expect(err).toBe('25006');
  });

  it('R-CMA-10: without a call context the provider refuses (AVM_CONTEXT_REQUIRED) and reads nothing', async () => {
    await expect(new InHouseAvm().estimate({ line1: '1 Example St', ...SC })).rejects.toMatchObject({ kind: 'not_configured', providerCode: 'AVM_CONTEXT_REQUIRED' });
  });
});

describe('R-TEN-1..3 R-CMA-10: tenancy', () => {
  it('R-TEN-1: A never reads B\'s sales in the same ZIP; interleaved tenants on one InHouseAvm get what each gets alone', async () => {
    const mine = await covered(a);
    const avm = new InHouseAvm();
    const alone = await avm.estimate(facts(mine), ctx(a, mine));
    if (!alone.available) throw new Error('fixture');
    expect(alone.ref).toMatch(IN_HOUSE_REF);
    expect(alone.ref).toContain(a.mls);
    // B's sales in A's ZIP at twice the price: A's value does not move
    await localSales(mw(b), 12, { ...SC, closePriceCents: 120_000_000 });
    const theirs = await covered(b, 0);
    const again = await avm.estimate(facts(mine), ctx(a, mine));
    expect(again).toEqual(alone);
    const [x, y] = await Promise.all([avm.estimate(facts(mine), ctx(a, mine)), avm.estimate(facts(theirs), ctx(b, theirs))]);
    expect(x).toEqual(alone);
    const yAlone = await new InHouseAvm().estimate(facts(theirs), ctx(b, theirs));
    expect(y).toEqual(yAlone);
    if (y.available) expect(y.ref).not.toContain(a.mls);
    // a call naming A's address under B's tenant reads nothing of A (RLS: the address is not found)
    await expect(avm.estimate(facts(mine), { ...ctx(b, mine) })).rejects.toBeTruthy();
  });
});

describe('b13 audit V2B-4 R-MLS-7: an in-house value never rests on BuildingAreaTotal (fix/mls-size merged before V2-B)', () => {
  /** A Spark-style record: the total area only (synthetic, larger than the living area it replaces), no LivingArea. */
  const totalAreaOnly = (r: ResoLike): ResoLike => ({ ...r, BuildingAreaTotal: Math.round(Number(r['LivingArea']) * 1.3), LivingArea: null });
  /** RESO records through V1-A's real sync under the Spark field mapping (as a Spark connection's sync reads them). */
  async function sparkSync(w: NurtureWorld, records: ResoLike[]): Promise<void> {
    await makeDue(h, w.mls);
    const r = await syncConnection(mlsDeps(h, { [w.mls]: { ...pagedFeed([records]), fields: SPARK_FIELD_MAPPING } }), w.tenantId as TenantId, w.mls);
    expect(r).toMatchObject({ outcome: 'synced', skippedInvalid: 0, inserted: records.length });
  }

  it('E626 E642 R-MLS-7 R-CMA-10: a past client\'s home and its local sales synced under the Spark mapping with only BuildingAreaTotal store no size; the run is CMA_SUBJECT_INCOMPLETE (the size), and the monthly estimate is an unavailable row with no value, never a value from the total area', async () => {
    const w = await nurtureWorld(h);
    await setPack(w.mls, scPack());
    await approveTemplate(w.agents[0]!, 'after_closing_alerts');
    const c = await pastClient(h, w, w.agents[0]!);
    const sales = Array.from({ length: 8 }, (_, i) => saleReso({ ...SC, sqft: 1200 + i * 60, beds: 3, closeDate: daysAgo(20 + i * 25), contractDate: daysAgo(50 + i * 25), closePriceCents: 42_000_000 + i * 1_500_000 }));
    const home = saleReso({ line1: c.line1, ...SC, closeDate: daysAgo(1500), sqft: 1500, beds: 3 });
    await sparkSync(w, [...sales, home].map(totalAreaOnly));
    const stored = (await h.su.query<{ n: number; sized: number; sourced: number }>("SELECT count(*)::int AS n, count(sqft)::int AS sized, count(size_source)::int AS sourced FROM listings WHERE tenant_id = $1 AND source = 'mls'", [w.tenantId])).rows[0]!;
    expect(stored).toEqual({ n: 9, sized: 0, sourced: 0 });
    const run = await readOnlySystemTx(w.tenantId, h.database, (tx, now) => valueForSubjectInTx(tx, now, { kind: 'contact_address', contactAddressId: c.addressId }, { contactId: c.id, use: 'automated_notes' }));
    expect(run).toMatchObject({ ok: false, code: 'CMA_SUBJECT_INCOMPLETE', sentence: expect.stringMatching(/^Size not available from the MLS/) });
    expect(await bothCleared(() => pass(w))).toMatchObject({ requested: 1, recorded: 1, failed: 0 });
    expect((await valuationsOf(h, c.addressId)).map((v) => [v.status, v.value_cents, v.low_cents, v.high_cents, v.display_allowed, v.provider])).toEqual([['unavailable', null, null, null, false, IN_HOUSE_PROVIDER]]);
  });
});

describe('E626 E99 R-CMA-10: data reasons answer unavailable; configuration and sync failures record nothing', () => {
  it('E626: an address with no MLS record, a home with two comparable sales, and land are unavailable rows ("No estimate available")', async () => {
    const w = await nurtureWorld(h);
    await setPack(w.mls, scPack());
    await approveTemplate(w.agents[0]!, 'after_closing_alerts');
    const none = await pastClient(h, w, w.agents[0]!); // no MLS record at its key
    await localSales(mw(w), 2, SC);
    const two = await pastClient(h, w, w.agents[0]!);
    await mlsSale(mw(w), { line1: two.line1, ...SC, closeDate: daysAgo(1500), sqft: 1500 });
    const land = await pastClient(h, w, w.agents[0]!);
    const r: ResoLike = { ...saleReso({ line1: land.line1, ...SC, closeDate: daysAgo(1500), sqft: 1500 }), PropertyType: 'Land', PropertySubType: 'Unimproved Land' };
    await syncSales(mw(w), [r]);
    const res = await bothCleared(() => pass(w));
    expect(res).toMatchObject({ requested: 3, recorded: 3, failed: 0 });
    for (const c of [none, two, land]) expect((await valuationsOf(h, c.addressId)).map((v) => [v.status, v.value_cents, v.provider])).toEqual([['unavailable', null, IN_HOUSE_PROVIDER]]);
  });

  it('R-CMA-10: a live connection that never synced records nothing (failed); a later pass after a sync records the estimate', async () => {
    const w = await nurtureWorld(h);
    await setPack(w.mls, scPack());
    await approveTemplate(w.agents[0]!, 'after_closing_alerts');
    const c = await covered(w);
    await h.su.query('UPDATE integration_connections SET last_synced_at = NULL WHERE id = $1', [w.mls]);
    expect(await bothCleared(() => pass(w))).toMatchObject({ requested: 1, recorded: 0, failed: 1 });
    expect(await valuationsOf(h, c.addressId)).toEqual([]);
    await feedLastSyncedAt(mw(w), new Date());
    expect(await bothCleared(() => pass(w))).toMatchObject({ requested: 1, recorded: 1 });
    const [v] = await valuationsOf(h, c.addressId);
    expect(v).toMatchObject({ status: 'ok', provider: IN_HOUSE_PROVIDER, display_allowed: true });
    const ref = (await h.su.query<{ r: string }>('SELECT provider_ref AS r FROM home_valuations WHERE id = $1', [v!.id])).rows[0]!.r;
    expect(ref).toMatch(IN_HOUSE_REF);
  });

  it('E620 R-INT-6: platform:avm alone, platform:cma alone, or no live connection recording automated_notes: nothing is requested or written', async () => {
    const c = await covered(a);
    const avm = new InHouseAvm();
    let calls = 0;
    avm.onRead = async () => {
      calls += 1;
    };
    expect(await withAvmCleared(h, () => pass(a, avm))).toMatchObject({ requested: 0, recorded: 0 });
    expect(await withCmaCleared(() => pass(a, avm))).toMatchObject({ requested: 0, recorded: 0 });
    await setPack(a.mls, scPack({ automated_notes: false }));
    try {
      expect(await bothCleared(() => pass(a, avm))).toMatchObject({ requested: 0, recorded: 0 });
    } finally {
      await setPack(a.mls, scPack());
    }
    expect(calls).toBe(0);
    expect(await valuationsOf(h, c.addressId)).toEqual([]);
    expect(await new InHouseAvm().availability({ tenantId: a.tenantId, db: h.database })).toEqual({ available: false, sentence: 'Home-value notes from recent MLS sales wait for counsel review of both platform:cma and platform:avm. Nothing is requested or sent until it is recorded.' });
  });
});

describe('E634 R-CMA-10: the fail-closed ref', () => {
  it('E634: a present but malformed ref makes the answer unparseable: no row, no firing, retried later; a well-formed one is stored', async () => {
    const w = await nurtureWorld(h);
    await approveTemplate(w.agents[0]!, 'after_closing_alerts');
    const bad = await pastClient(h, w, w.agents[0]!);
    const good = await pastClient(h, w, w.agents[0]!);
    const fake = new FakeAvmP2();
    const answer = { available: true, valueCents: 40_000_000, lowCents: 38_000_000, highCents: 42_000_000, asOf: new Date().toISOString().slice(0, 10), method: 'comparable sales', comparables: [], provider: 'Example', displayAllowed: true };
    const ref = `inhouse:cma/1:${randomUUID()}:${'a'.repeat(64)}`;
    fake.answers.set(FakeAvmP2.key({ line1: bad.line1, postalCode: bad.postalCode }), { kind: 'raw', answer: { ...answer, ref: 'inhouse:cma/1:not-a-connection:abc' } });
    fake.answers.set(FakeAvmP2.key({ line1: good.line1, postalCode: good.postalCode }), { kind: 'raw', answer: { ...answer, ref } });
    expect(await pass(w, fake)).toMatchObject({ requested: 2, recorded: 1, failed: 1 });
    expect(await valuationsOf(h, bad.addressId)).toEqual([]);
    expect((await h.su.query<{ r: string }>('SELECT provider_ref AS r FROM home_valuations WHERE contact_address_id = $1', [good.addressId])).rows[0]!.r).toBe(ref);
    expect(fake.contexts.at(-1)).toEqual({ tenantId: w.tenantId, contactId: expect.any(String), contactAddressId: expect.any(String) });
  });
});

describe('R-CMA-10 owner question 9: which provider each deployment gets', () => {
  it('production without fakes registers InHouseAvm (configured); dev, test and the staging demo keep the fake', () => {
    const prod = createProviders(testConfig({ env: 'production', allowFakeProviders: false }), { clock: { now: () => 0 as never } });
    expect(prod.integrations.avm).toBeInstanceOf(InHouseAvm);
    expect(prod.integrations.avm.configured).toBe(true);
    expect(createProviders(testConfig(), { clock: { now: () => 0 as never } }).integrations.avm).toBeInstanceOf(FakeAvmP2);
    expect(createProviders(testConfig({ env: 'production', allowFakeProviders: true }), { clock: { now: () => 0 as never } }).integrations.avm).toBeInstanceOf(FakeAvmP2);
  });
});
