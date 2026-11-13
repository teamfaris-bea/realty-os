// Lane V2-B at volume (R-CMA-10; owner question 7; VERIFY E4, E8) on lane V1-A's 500k skewed fixture (mls/testing.ts
// mlsVolumeFixture), under app_user and FORCE RLS. Reported, not asserted against a threshold (owner question 7: decide
// after the measured share): the share of in-house ranges wider than avm_max_range_bps' 2,500 default and of
// month-on-month jumps over 1,000 bps (two passes 30 days apart: the same subjects valued as of today and 30 days
// earlier); the queue-time gate's time (the work done under the contact lock: E8); the seller-update view with
// platform:cma cleared (freshHash runs the value section on every view: E4, proposed <= 2.5 s). Timings are printed.
// VERIFY on production hardware. Asserted (the brief's tests §4; b13 audit V2B-6): the home-value sweep's candidate
// read on this fixture plus 10,000 queued in-house notes uses no Seq Scan on messages, playbook_step_runs or
// home_valuations. Its pass time (it runs in the shared 5-minute compliance transaction) is printed; the brief's
// p95 < 50 ms is not met at this volume (VERIFY below), and the assertion only guards against the per-run seq scan.
import { addLocalDays } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type ApiHarness, createApiHarness } from '../auth/testHarness.js';
import { MLS_VOLUME, mlsVolumeFixture } from '../mls/testing.js';
import { call, reconcile, sellerListing } from '../sellerUpdates/testing.js';
import { systemActor } from '../worker/systemActor.js';
import { depsOf } from '../assistant/testing.js';
import { depsFromPlatform } from '../comms/runtime.js';
import { avmRefresh } from '../nurture/avm.js';
import { executeTriggerRunInTx } from '../nurture/execute.js';
import { approveTemplate, firingsDue, nurtureWorld, pastClient, triggerRuns, withAvmCleared } from '../nurture/testing.js';
import { HOME_VALUE_SWEEP_LIMIT, InHouseAvm, automatedGate, cancelIneligibleHomeValueNotesInTx, homeValueSweepCandidates } from './avm.js';
import { valueForSubjectInTx } from './pipeline.js';
import { readinessInputOf } from './service.js';
import { type CmaWorld, TEST_STATEMENT, address, cmaPack, cmaWorld, contact, daysAgo, localSales, mlsSale } from './testing.js';

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

describe('b13 audit V2B-6: the home-value sweep at volume (E623; lane V2-B brief tests §4)', () => {
  /** Every plan node of an EXPLAIN (FORMAT JSON) answer. */
  function nodesOf(plan: Record<string, unknown>): Record<string, unknown>[] {
    const kids = (plan['Plans'] as Record<string, unknown>[] | undefined) ?? [];
    return [plan, ...kids.flatMap(nodesOf)];
  }

  it('E623 R-CMA-7: with 10,000 queued in-house notes (and the 500k MLS fixture), the sweep\'s candidate read has no Seq Scan on messages, playbook_step_runs or home_valuations (valuations by primary key), returns its page, and a pass that cancels nothing is timed (p95 printed; VERIFY against the brief\'s 50 ms)', async () => {
    const SC = { city: 'Springfield', region: 'SC', postalCode: '29401' } as const;
    const QUEUED = 10_000;
    const n = await nurtureWorld(h);
    const nw = { h, tenantId: n.tenantId, mls: n.mls };
    await h.su.query('UPDATE integration_connections SET license_pack = $2::jsonb WHERE id = $1', [n.mls, JSON.stringify(cmaPack({ valuation: { statements: { SC: { text: TEST_STATEMENT, min_point_size: 10 } } } }))]);
    await approveTemplate(n.agents[0]!, 'after_closing_alerts');
    await h.su.query('UPDATE tenant_settings SET avm_max_range_bps = 10000 WHERE tenant_id = $1', [n.tenantId]);
    // one real queued in-house note, built by the product (avm.refresh, then executeTriggerRun), the template of the rest
    const c = await pastClient(h, n, n.agents[0]!);
    await localSales(nw, 8, SC);
    await mlsSale(nw, { line1: c.line1, ...SC, closeDate: daysAgo(1500), sqft: 1500, beds: 3 });
    await withCmaCleared(() =>
      withAvmCleared(h, async () => {
        await avmRefresh({ db: h.database, ids: depsFromPlatform(h.app.platform).ids, avm: new InHouseAvm() }, n.tenantId);
        await firingsDue(h, c.id);
        const [run] = await triggerRuns(h, c.id);
        await withTenantTx(systemActor(n.tenantId, 'assistant'), (tx, now) => executeTriggerRunInTx(tx, depsOf(h), n.tenantId, run!.id, now), { db: h.database });
      }),
    );
    const t = (await h.su.query<{ run_id: string; message_id: string; valuation_id: string; address_id: string }>(
      `SELECT r.id AS run_id, r.message_id, (r.trigger_ref->'ref'->>'valuationId') AS valuation_id, v.contact_address_id AS address_id
         FROM playbook_step_runs r JOIN messages m ON m.id = r.message_id JOIN home_valuations v ON v.id = (r.trigger_ref->'ref'->>'valuationId')::uuid
        WHERE r.contact_id = $1 AND r.status = 'scheduled' AND m.status = 'queued' AND v.provider_ref LIKE 'inhouse:%'`,
      [c.id],
    )).rows;
    expect(t).toHaveLength(1);
    // fixture rows cloned from the template (superuser, replica role: no triggers or FK checks; every CHECK still holds):
    // 10,000 queued notes, each with its own contact, address, valuation and scheduled run; and history that a seq scan
    // would have to read: 150,000 canceled outbound messages, 100,000 sent trigger runs and 50,000 older valuations
    const x = await h.su.connect();
    try {
      await x.query('BEGIN');
      await x.query('SET LOCAL session_replication_role = replica');
      /** INSERT … SELECT of `n` copies of one row of `table` with `set` (SQL over the copy number g) laid over it; generated columns are left to the database. */
      const clone = async (table: string, from: string, n: number, set: string) => {
        const cols = (await x.query<{ c: string }>("SELECT quote_ident(column_name) AS c FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1 AND is_generated = 'NEVER' ORDER BY ordinal_position", [table])).rows.map((r) => r.c);
        await x.query(`INSERT INTO ${table} (${cols.join(', ')}) SELECT ${cols.map((k) => `n.${k}`).join(', ')} FROM ${table} t CROSS JOIN generate_series(1, $2::int) g CROSS JOIN LATERAL jsonb_populate_record(NULL::${table}, to_jsonb(t) || ${set}) n WHERE t.id = $1`, [from, n]);
      };
      const id = (k: string) => `md5('v2b6:${k}:' || g)::uuid`;
      // history rows belong to 15,000 contacts of their own (g % 15000)
      const hid = (k: string) => `md5('v2b6:${k}:' || (g % 15000))::uuid`;
      const [tm] = t;
      // the contacts exist (messages_select reads the contact row under RLS)
      await clone('contacts', c.id, QUEUED, `jsonb_build_object('id', ${id('c')})`);
      await clone('contacts', c.id, 15_000, `jsonb_build_object('id', ${hid('ch')})`);
      await clone('contact_addresses', tm!.address_id, QUEUED, `jsonb_build_object('id', ${id('a')}, 'contact_id', ${id('c')})`);
      await clone('home_valuations', tm!.valuation_id, QUEUED, `jsonb_build_object('id', ${id('v')}, 'contact_id', ${id('c')}, 'contact_address_id', ${id('a')})`);
      await clone('messages', tm!.message_id, QUEUED, `jsonb_build_object('id', ${id('m')}, 'contact_id', ${id('c')}, 'idempotency_key', NULL, 'provider_message_ref', NULL, 'playbook_step_run_id', ${id('r')})`);
      await clone('playbook_step_runs', tm!.run_id, QUEUED, `jsonb_build_object('id', ${id('r')}, 'contact_id', ${id('c')}, 'message_id', ${id('m')}, 'trigger_key', 'v2b6:' || g, 'trigger_ref', jsonb_set(t.trigger_ref, '{ref,valuationId}', to_jsonb(${id('v')}::text)))`);
      await clone('messages', tm!.message_id, 150_000, `jsonb_build_object('id', ${id('mh')}, 'contact_id', ${hid('ch')}, 'idempotency_key', NULL, 'provider_message_ref', NULL, 'playbook_step_run_id', NULL, 'status', 'canceled', 'status_reason', 'TEST_HISTORY')`);
      await clone('playbook_step_runs', tm!.run_id, 100_000, `jsonb_build_object('id', ${id('rh')}, 'contact_id', ${hid('ch')}, 'message_id', NULL, 'status', 'sent', 'trigger_key', 'v2b6h:' || g)`);
      await clone('home_valuations', tm!.valuation_id, 50_000, `jsonb_build_object('id', ${id('vh')}, 'contact_id', ${hid('ch')}, 'contact_address_id', NULL, 'valued_at', t.valued_at - interval '400 days')`);
      await x.query('COMMIT');
    } catch (e) {
      await x.query('ROLLBACK');
      throw e;
    } finally {
      x.release();
    }
    await h.su.query('ANALYZE contacts, messages, playbook_step_runs, home_valuations, contact_addresses');
    const sweepTx = <T>(fn: (tx: Tx, now: Parameters<Parameters<typeof withTenantTx>[1]>[1]) => Promise<T>) => withTenantTx(systemActor(n.tenantId, 'worker'), fn, { db: h.database });
    const plan = await sweepTx(async (tx) => (await sql<{ 'QUERY PLAN': { Plan: Record<string, unknown> }[] }>`EXPLAIN (FORMAT JSON) ${homeValueSweepCandidates(HOME_VALUE_SWEEP_LIMIT)}`.execute(tx)).rows[0]!['QUERY PLAN'][0]!.Plan);
    const nodes = nodesOf(plan);
    console.info(`[values volume] home-value sweep plan: ${nodes.map((x) => `${String(x['Node Type'])}${x['Relation Name'] ? ` on ${String(x['Relation Name'])}` : ''}${x['Index Name'] ? ` using ${String(x['Index Name'])}` : ''}`).join(' > ')}`);
    // the inline `v.id = CASE … END` join had PostgreSQL seq-scan home_valuations once per run (FORCE RLS keeps a
    // non-leakproof join clause from being an index condition) and hit the statement timeout at this volume
    expect(nodes.filter((x) => x['Node Type'] === 'Seq Scan' && ['messages', 'playbook_step_runs', 'home_valuations'].includes(String(x['Relation Name']))).map((x) => x['Relation Name'])).toEqual([]);
    expect(nodes.some((x) => x['Relation Name'] === 'home_valuations' && x['Index Name'] === 'home_valuations_pkey')).toBe(true);
    const cands = await sweepTx(async (tx) => (await homeValueSweepCandidates(HOME_VALUE_SWEEP_LIMIT).execute(tx)).rows.length);
    expect(cands).toBe(HOME_VALUE_SWEEP_LIMIT);
    // a pass with both packs cleared and the connection fresh cancels nothing: the steady state of the 5-minute sweep
    const times: number[] = [];
    await withCmaCleared(() =>
      withAvmCleared(h, async () => {
        for (let i = 0; i < 20; i++) {
          // timed inside the transaction, as the pass runs inside the shared compliance transaction
          const canceled = await sweepTx(async (tx, now) => {
            const s0 = performance.now();
            const r = await cancelIneligibleHomeValueNotesInTx(tx, now);
            times.push(performance.now() - s0);
            return r;
          });
          expect(canceled).toEqual([]);
        }
      }),
    );
    console.info(`[values volume] home-value sweep pass (${QUEUED} queued in-house notes, nothing canceled) p95 ${Math.round(p95(times))} ms over ${times.length} (${times.map((x) => Math.round(x)).join(', ')})`);
    // VERIFY (brief tests §4: p95 < 50 ms, not met at this volume): the read is linear in the queued in-house notes (its
    // ORDER BY sees every one, each paying the RLS probes on messages, valuations and addresses); measured 165-230 ms on
    // the batch 13 machine under load. The bound here only guards against the per-run seq scan coming back.
    expect(p95(times)).toBeLessThan(1_000);
  }, 900_000);
});
