// The nightly pass's schedule, idempotency, budget and crash safety (R-OWN-27), retention (R-DATA-6), tenant
// isolation and detail visibility (R-TEN-6, R-PERM-4), and the not-configured provider (R-INT-1). Real Postgres as
// app_user; synthetic models and the deterministic public-records fake only.
import { randomUUID } from 'node:crypto';
import { withPreTenant, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness, testConfig } from '../auth/testHarness.js';
import { createFakeProviders, createProviders } from '../providers/index.js';
import { installNetworkTripwire } from '../providers/integrations/spark.testing.js';
import { memoryAlerts } from '../worker/observability.js';
import { systemActor } from '../worker/systemActor.js';
import { contactOf, feedOf, type WorkspaceWorld, workspaceWorld } from '../workspace/testing.js';
import { makePredictHandlers, predictHandlers, PREDICT_JOBS } from './handlers.js';
import { handlers as registered } from '../worker/handlers/index.js';
import { FakePublicRecords, PUBLIC_RECORDS_NOT_SET_UP, UnconfiguredPublicRecords } from './provider.js';
import { FIRST_PARTY_MODEL, PROPERTY_MODEL, approvedModel, homeAddress, pass, rowsOf, savedListings, setModelStatus, testRegistry, vendorRecord } from './testing.js';
import type { ModelDefinition } from './models.js';
import { normalizeAddress } from '@realty/core/predict';

let h: ApiHarness;
let a: WorkspaceWorld;
let b: WorkspaceWorld;
let model: ModelDefinition;

beforeAll(async () => {
  h = await createApiHarness();
  a = await workspaceWorld(h, { agents: 2 });
  b = await workspaceWorld(h, { agents: 1 });
  model = await approvedModel(h, PROPERTY_MODEL);
}, 240_000);
afterAll(async () => {
  await h?.close();
});

const setZone = (tenantId: string, tz: string) => h.su.query('UPDATE tenant_settings SET default_timezone = $2 WHERE tenant_id = $1', [tenantId, tz]);
/** An Etc/GMT zone where the local hour is `hour` right now. */
function zoneAtLocalHour(hour: number): string {
  let n = (hour - new Date().getUTCHours() + 48) % 24;
  if (n > 14) n -= 24;
  return n === 0 ? 'Etc/GMT' : n > 0 ? `Etc/GMT-${n}` : `Etc/GMT+${-n}`;
}
const localDate = (tz: string) => new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const tableState = async (tenantId: string) =>
  JSON.stringify({
    records: (await h.su.query('SELECT * FROM property_records WHERE tenant_id = $1 ORDER BY id', [tenantId])).rows,
    predictions: (await h.su.query('SELECT * FROM contact_predictions WHERE tenant_id = $1 ORDER BY contact_id, model_version', [tenantId])).rows,
    cards: (await h.su.query(`SELECT * FROM priority_feed_items WHERE tenant_id = $1 AND item_type = 'likely_to_move' ORDER BY id`, [tenantId])).rows,
  });

async function homeWithRecord(w: WorkspaceWorld, records: FakePublicRecords, agentIx = 0) {
  const first = `Kai${randomUUID().slice(0, 4)}`;
  const c = await contactOf(w.agents[agentIx]!, { firstName: first });
  const home = await homeAddress(h, w.tenantId, c.id);
  records.put(home.address, vendorRecord(home.address, [`${first} Doe`]));
  await savedListings(h, w.tenantId, c.id, 3);
  return { id: c.id, home };
}

describe('R-OWN-27: one pass per tenant and local date', () => {
  it('R-OWN-27: computed_on is the tenant\'s local date in a zone whose UTC date differs, and a re-run on the same date writes nothing and makes no lookup', async () => {
    const tz = new Date().getUTCHours() < 11 ? 'Pacific/Pago_Pago' : 'Pacific/Kiritimati';
    await setZone(a.tenantId, tz);
    const utcDate = new Date().toISOString().slice(0, 10);
    expect(localDate(tz)).not.toBe(utcDate);
    const records = new FakePublicRecords();
    const c = await homeWithRecord(a, records);
    const r1 = await pass(h, a.tenantId, { registry: testRegistry(model), publicRecords: records });
    expect(r1.report.localDate).toBe(localDate(tz));
    const stored = await h.su.query('SELECT computed_on::text AS d FROM contact_predictions WHERE contact_id = $1', [c.id]);
    expect(stored.rows[0].d).toBe(localDate(tz));
    const before = await tableState(a.tenantId);
    const calls = records.calls.length;
    // (batch by batch: one contact per transaction)
    const r2 = await pass(h, a.tenantId, { registry: testRegistry(model), publicRecords: records, settings: { batchSize: 1 } });
    expect(r2.report.predictions.evaluated).toBe(r1.report.predictions.evaluated);
    expect(r2.report).toMatchObject({ lookups: { made: 0 }, predictions: { written: 0 }, cards: { inserted: 0, updated: 0, reopened: 0, closed: 0 } });
    expect(records.calls.length).toBe(calls);
    expect(await tableState(a.tenantId)).toBe(before);
  });

  it('R-OWN-27: the handler acts only in the tenant\'s local night window; it is registered once, hourly and standalone', async () => {
    const records = new FakePublicRecords();
    const c = await homeWithRecord(a, records);
    const h1 = makePredictHandlers(() => ({ publicRecords: records, registry: testRegistry(model) }))[0]!;
    expect(h1).toMatchObject({ kind: PREDICT_JOBS.nightly, mode: 'standalone', every: { ms: 3_600_000 } });
    expect(registered.filter((x) => x.kind === PREDICT_JOBS.nightly)).toHaveLength(1);
    expect(predictHandlers.map((x) => x.kind)).toEqual([PREDICT_JOBS.nightly]);
    const run = async () => {
      const alerts = memoryAlerts();
      const logs: unknown[] = [];
      const ctx = {
        actor: systemActor(a.tenantId, 'worker'),
        now: Date.now(),
        providers: h.providers,
        job: { id: 1n, kind: PREDICT_JOBS.nightly, queue: 'default', attempts: 1 },
        log: { info: (...x: unknown[]) => logs.push(x), warn: () => {}, error: () => {}, debug: () => {}, child: () => ctx.log },
        alerts,
        withTx: <T>(fn: (tx: never, now: never) => Promise<T>) => withTenantTx(systemActor(a.tenantId, 'worker'), fn as never, { db: h.database }),
      };
      await (h1 as unknown as { run: (c: unknown, p: unknown) => Promise<void> }).run(ctx, {});
      return logs;
    };
    await setZone(a.tenantId, zoneAtLocalHour(13));
    await run();
    expect(records.calls).toEqual([]);
    expect((await rowsOf(h, c.id)).predictions).toHaveLength(0);
    await setZone(a.tenantId, zoneAtLocalHour(3));
    const logs = await run();
    expect(records.calls).toHaveLength(1);
    expect((await rowsOf(h, c.id)).predictions).toHaveLength(1);
    // counts and ids only (R-TEN-7)
    const line = JSON.stringify(logs);
    expect(line).not.toMatch(/Kai|Doe|Synthetic Test Way|Exampleton/);
  });

  it('R-OWN-27: a crash between a lookup and its write leaves no duplicate row, and the re-run repeats only the lookup that was in flight', async () => {
    await setZone(a.tenantId, 'UTC');
    const records = new FakePublicRecords();
    const cs = [await homeWithRecord(a, records), await homeWithRecord(a, records), await homeWithRecord(a, records)];
    let n = 0;
    records.beforeAnswer = () => {
      n += 1;
      if (n === 2) throw new Error('worker crashed');
    };
    await expect(pass(h, a.tenantId, { registry: testRegistry(model), publicRecords: records })).rejects.toThrow('worker crashed');
    const firstRun = [...records.calls];
    records.calls.length = 0;
    records.beforeAnswer = null;
    await pass(h, a.tenantId, { registry: testRegistry(model), publicRecords: records });
    const repeated = records.calls.filter((k) => firstRun.includes(k));
    expect(repeated).toHaveLength(1);
    expect(repeated[0]).toBe(firstRun[1]);
    for (const c of cs) expect((await rowsOf(h, c.id)).records).toHaveLength(1);
  });

  it('R-OWN-27: lookups per tenant and local date never exceed the budget (rows fetched today plus this pass\'s lookups)', async () => {
    const records = new FakePublicRecords();
    for (let i = 0; i < 3; i += 1) await homeWithRecord(a, records);
    const fetchedToday = Number((await h.su.query(`SELECT count(*)::int AS n FROM property_records WHERE tenant_id = $1 AND (fetched_at AT TIME ZONE 'UTC')::date = (now() AT TIME ZONE 'UTC')::date`, [a.tenantId])).rows[0].n);
    const budget = fetchedToday + 2;
    const r1 = await pass(h, a.tenantId, { registry: testRegistry(model), publicRecords: records, settings: { lookupBudgetPerDay: budget } });
    expect(r1.report.lookups.made).toBe(2);
    const r2 = await pass(h, a.tenantId, { registry: testRegistry(model), publicRecords: records, settings: { lookupBudgetPerDay: budget } });
    expect(r2.report.lookups.made).toBe(0);
    const r3 = await pass(h, a.tenantId, { registry: testRegistry(model), publicRecords: records, settings: { lookupBudgetPerDay: budget + 5 } });
    expect(r3.report.lookups.made).toBe(1);
    // across pages (one candidate per transaction) the rows this pass writes are not counted twice
    for (let i = 0; i < 4; i += 1) await homeWithRecord(a, records);
    const today = fetchedToday + 3;
    const r4 = await pass(h, a.tenantId, { registry: testRegistry(model), publicRecords: records, settings: { lookupBudgetPerDay: today + 3, lookupPageSize: 1 } });
    expect(r4.report.lookups.made).toBe(3);
    const r5 = await pass(h, a.tenantId, { registry: testRegistry(model), publicRecords: records, settings: { lookupBudgetPerDay: today + 3, lookupPageSize: 1 } });
    expect(r5.report.lookups.made).toBe(0);
  });

  it('E122 R-PRED-2: an address edited after its record was fetched is due again; a mailing or property address is never looked up', async () => {
    const records = new FakePublicRecords();
    const c = await homeWithRecord(a, records);
    const mailing = await homeAddress(h, a.tenantId, c.id, undefined, 'mailing');
    records.put(mailing.address, vendorRecord(mailing.address, ['Anyone']));
    const asked = (x: Parameters<typeof normalizeAddress>[0]) => records.calls.filter((k) => k === normalizeAddress(x)).length;
    await pass(h, a.tenantId, { registry: testRegistry(model), publicRecords: records });
    expect([asked(c.home.address), asked(mailing.address)]).toEqual([1, 0]);
    await pass(h, a.tenantId, { registry: testRegistry(model), publicRecords: records });
    expect([asked(c.home.address), asked(mailing.address)]).toEqual([1, 0]);
    await h.su.query(`UPDATE contact_addresses SET line2 = 'Unit 2' WHERE id = $1`, [c.home.id]);
    await pass(h, a.tenantId, { registry: testRegistry(model), publicRecords: records });
    expect(asked({ ...c.home.address, line2: 'Unit 2' })).toBe(1);
    expect(asked(mailing.address)).toBe(0);
    // the new address has no record in the fake: the stale facts no longer feed a feature
    expect((await rowsOf(h, c.id)).records[0]).toMatchObject({ owner_name_match: false, last_sale_date: null });
  });
});

describe('R-DATA-6: app.purge_prediction_data', () => {
  it('R-DATA-6: the purge deletes only its own tenant\'s expired records and predictions not evaluated for 90 days, refuses a user actor and a missing tenant context, and takes no instant', async () => {
    const seed = async (w: WorkspaceWorld) => {
      const c = await contactOf(w.agents[0]!, { firstName: 'Old' });
      const fresh = await contactOf(w.agents[0]!, { firstName: 'New' });
      const ad1 = await homeAddress(h, w.tenantId, c.id);
      const ad2 = await homeAddress(h, w.tenantId, fresh.id);
      await h.su.query(`INSERT INTO property_records (tenant_id, id, contact_id, contact_address_id, owner_name_match, fetched_at, retention_until)
                        VALUES ($1, $2, $3, $4, false, now() - interval '400 days', now() - interval '1 day'), ($1, $5, $6, $7, false, now(), now() + interval '300 days')`,
        [w.tenantId, randomUUID(), c.id, ad1.id, randomUUID(), fresh.id, ad2.id]);
      await h.su.query(`INSERT INTO contact_predictions (tenant_id, contact_id, model_version, band, reasons, inputs_sha256, computed_on)
                        VALUES ($1, $2, $4, 'none', '[]', repeat('a', 64), current_date - 120), ($1, $3, $4, 'none', '[]', repeat('a', 64), current_date - 10)`,
        [w.tenantId, c.id, fresh.id, model.version]);
      return { old: c.id, fresh: fresh.id };
    };
    const sa = await seed(a);
    const sb = await seed(b);
    const purge = (actor: Parameters<typeof withTenantTx>[0]) => withTenantTx(actor, async (tx) => (await sql<{ records_deleted: number; predictions_deleted: number }>`SELECT * FROM app.purge_prediction_data()`.execute(tx)).rows[0], { db: h.database });
    await expect(purge(a.owner.actor())).rejects.toThrow(/PREDICTION_PURGE_SYSTEM_ONLY/);
    await expect(withPreTenant(async (tx) => sql`SELECT * FROM app.purge_prediction_data()`.execute(tx), { db: h.database })).rejects.toThrow(/PREDICTION_PURGE_SYSTEM_ONLY/);
    await expect(withTenantTx(systemActor(a.tenantId, 'worker'), async (tx) => sql`SELECT * FROM app.purge_prediction_data(now())`.execute(tx), { db: h.database })).rejects.toThrow(/does not exist/);
    const r = await purge(systemActor(a.tenantId, 'worker'));
    expect(r!.records_deleted).toBeGreaterThanOrEqual(1);
    expect(r!.predictions_deleted).toBeGreaterThanOrEqual(1);
    for (const [s, kept] of [[sa, false], [sb, true]] as const) {
      expect((await rowsOf(h, s.old)).records.length).toBe(kept ? 1 : 0);
      expect((await rowsOf(h, s.old)).predictions.length).toBe(kept ? 1 : 0);
      expect((await rowsOf(h, s.fresh)).records.length).toBe(1);
      expect((await rowsOf(h, s.fresh)).predictions.length).toBe(1);
    }
    // app_user itself has no DELETE on either table
    await expect(withTenantTx(systemActor(a.tenantId, 'worker'), async (tx) => sql`DELETE FROM property_records`.execute(tx), { db: h.database })).rejects.toThrow(/permission denied/);
    await expect(withTenantTx(systemActor(a.tenantId, 'worker'), async (tx) => sql`DELETE FROM contact_predictions`.execute(tx), { db: h.database })).rejects.toThrow(/permission denied/);
  });
});

describe('tenant isolation and detail visibility (R-TEN-6, R-PERM-4)', () => {
  it('R-PERM-4: tenant A\'s pass reads and writes only A and the fake sees only A\'s addresses; B\'s members and an A member without detail visibility see neither the band nor the card', async () => {
    const records = new FakePublicRecords();
    const ca = await homeWithRecord(a, records);
    const cb = await homeWithRecord(b, records);
    const bBefore = await tableState(b.tenantId);
    await pass(h, a.tenantId, { registry: testRegistry(model), publicRecords: records });
    const aHomes = (await h.su.query(`SELECT line1, line2, city, region, postal_code FROM contact_addresses WHERE tenant_id = $1 AND kind = 'home'`, [a.tenantId])).rows
      .map((r) => normalizeAddress({ line1: r.line1, line2: r.line2, city: r.city, region: r.region, postalCode: r.postal_code }));
    expect(records.calls).toContain(normalizeAddress(ca.home.address));
    expect(records.calls).not.toContain(normalizeAddress(cb.home.address));
    expect(records.calls.every((k) => aHomes.includes(k))).toBe(true);
    expect(await tableState(b.tenantId)).toBe(bBefore);
    expect((await rowsOf(h, ca.id)).cards).toHaveLength(1);

    const readAs = (actor: Parameters<typeof withTenantTx>[0]) =>
      withTenantTx(actor, async (tx) => ({
        predictions: (await sql<{ n: number }>`SELECT count(*)::int AS n FROM contact_predictions WHERE contact_id = ${ca.id}`.execute(tx)).rows[0]!.n,
        records: (await sql<{ n: number }>`SELECT count(*)::int AS n FROM property_records WHERE contact_id = ${ca.id}`.execute(tx)).rows[0]!.n,
        cards: (await sql<{ n: number }>`SELECT count(*)::int AS n FROM priority_feed_items WHERE contact_id = ${ca.id}`.execute(tx)).rows[0]!.n,
      }), { db: h.database });
    expect(await readAs(a.agents[0]!.actor())).toEqual({ predictions: 1, records: 1, cards: 1 });
    expect(await readAs(b.owner.actor())).toEqual({ predictions: 0, records: 0, cards: 0 });
    expect(await readAs(b.agents[0]!.actor())).toEqual({ predictions: 0, records: 0, cards: 0 });
    expect(await readAs(a.agents[1]!.actor())).toEqual({ predictions: 0, records: 0, cards: 0 });
    expect((await feedOf(a.agents[1]!)).all.some((x) => x.contact?.id === ca.id)).toBe(false);
    expect((await feedOf(b.owner)).all.some((x) => x.itemType === 'likely_to_move')).toBe(false);
  });
});

describe('R-INT-1: public records are platform configuration with an honest not-configured state', () => {
  it('R-INT-1: the fake is the default; production without ALLOW_FAKE_PROVIDERS gets the unconfigured stand-in, which looks nothing up; no request leaves the process', async () => {
    expect(createFakeProviders().publicRecords).toBeInstanceOf(FakePublicRecords);
    expect(createProviders(testConfig(), { clock: { now: () => Date.now() } as never }).publicRecords).toBeInstanceOf(FakePublicRecords);
    const prod = createProviders({ ...testConfig(), env: 'production', allowFakeProviders: false }, { clock: { now: () => Date.now() } as never }).publicRecords;
    expect(prod).toBeInstanceOf(UnconfiguredPublicRecords);
    expect([prod.configured, prod.statusText]).toEqual([false, PUBLIC_RECORDS_NOT_SET_UP]);
    expect(createProviders({ ...testConfig(), env: 'production', allowFakeProviders: true }, { clock: { now: () => Date.now() } as never }).publicRecords).toBeInstanceOf(FakePublicRecords);
    const c = await homeWithRecord(a, new FakePublicRecords());
    const trip = installNetworkTripwire();
    try {
      const r = await pass(h, a.tenantId, { registry: testRegistry(model), publicRecords: prod });
      expect(r.report.lookups).toMatchObject({ providerConfigured: false, made: 0 });
      // first-party features alone score
      expect((await rowsOf(h, c.id)).records).toHaveLength(0);
      expect((await rowsOf(h, c.id)).predictions[0]).toMatchObject({ band: 'watch' });
      expect(trip.attempts).toEqual([]);
    } finally {
      trip.restore();
    }
  });

  it('a first-party model next to a withdrawn property model: the withdrawn one is never read', async () => {
    const fp = await approvedModel(h, FIRST_PARTY_MODEL);
    await setModelStatus(h, model.version, 'withdrawn');
    const records = new FakePublicRecords();
    const c = await homeWithRecord(a, records);
    const r = await pass(h, a.tenantId, { registry: testRegistry(model, fp), publicRecords: records });
    expect(r.report.scoringModels).toEqual([fp.version]);
    expect(records.calls).toEqual([]);
    expect((await rowsOf(h, c.id)).predictions.map((p) => p.model_version)).toEqual([fp.version]);
    await setModelStatus(h, model.version, 'approved');
    await setModelStatus(h, fp.version, 'withdrawn');
  });
});
