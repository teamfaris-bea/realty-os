// Load smoke for the module 9 acceptance criteria, at dev scale on this machine:
//  - realtime queue pickup p95 < 2 s at 50 jobs/s (10 s of steady enqueue across 3 tenants)
//  - sweeper lateness < 30 s with a due-work backlog (2 000 overdue offers)
// Pickup lag = the job transaction's DB clock minus the enqueuing transaction's DB clock.
import { createDatabase, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { OfferTimerPayload } from './contracts.js';
import { createWorker, workerName } from './loop.js';
import { MemoryMetrics, memoryAlerts, memoryLogger } from './observability.js';
import { jobPayload, zInstant } from './payload.js';
import { enqueueTyped } from './registry.js';
import { createSweeper } from './sweeper.js';
import { type Harness, type World, createHarness, createWorld, intakeLead, registryWith, suRows } from './testing/world.js';
import type { TxJobHandler } from './types.js';

let h: Harness;
let tenants: World[];
beforeAll(async () => {
  h = await createHarness();
  tenants = [];
  for (let i = 0; i < 3; i++) tenants.push(await createWorld(h.app, { agents: 1 }));
});
afterAll(async () => {
  await h?.close();
});

const LoadPayload = jobPayload({ enqueuedAt: zInstant, n: z.number().int() });

describe('load smoke (dev hardware)', () => {
  it('realtime pickup p95 < 2 s at 50 jobs/s', async () => {
    const lags: number[] = [];
    const handler: TxJobHandler<z.infer<typeof LoadPayload>> = {
      kind: 'test.load',
      queue: 'realtime',
      schema: LoadPayload,
      async run(ctx, p) {
        lags.push(ctx.now - p.enqueuedAt);
        await sql`SELECT app.tenant_id()`.execute(ctx.tx);
      },
    };
    const workerDb = createDatabase({ url: h.db.appUserUrl, max: 10 });
    const producerDb = createDatabase({ url: h.db.appUserUrl, max: 4 });
    const ac = new AbortController();
    const loop = createWorker({ queues: ['realtime'], concurrency: 8, worker: workerName('load'), db: workerDb, registry: registryWith(handler), log: memoryLogger(), signal: ac.signal })
      .run()
      .catch(() => undefined);
    try {
      const total = 500;
      const started = Date.now();
      const inflight: Promise<unknown>[] = [];
      for (let n = 0; n < total; n++) {
        const due = started + n * 20; // 50 per second
        const wait = due - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        const t = tenants[n % 3]!;
        inflight.push(withTenantTx(t.system(), (tx, now) => enqueueTyped(tx, handler, { enqueuedAt: now, n }), { db: producerDb }));
      }
      await Promise.all(inflight);
      const until = Date.now() + 20_000;
      while (lags.length < total && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
      expect(lags).toHaveLength(total);
      const sorted = [...lags].sort((a, b) => a - b);
      const p95 = sorted[Math.ceil(0.95 * sorted.length) - 1]!;
      const rate = total / ((Date.now() - started) / 1000);
      console.info(`pickup lag ms: p50=${sorted[Math.floor(sorted.length / 2)]} p95=${p95} max=${sorted.at(-1)} (enqueue rate ≈ ${rate.toFixed(0)}/s incl. drain)`);
      expect(p95).toBeLessThan(2_000);
    } finally {
      ac.abort(new Error('stop'));
      await loop;
      await workerDb.close();
      await producerDb.close();
    }
  }, 60_000);

  it('sweeper lateness stays < 30 s with a backlog of 2 000 overdue deadlines', async () => {
    const t = tenants[0]!;
    const { contactId } = await intakeLead(h.app, t);
    // clone the offered lead 2 000 times with past offer expiries (fixture: a backlog, not real leads)
    const cols = (
      await suRows<{ column_name: string }>(
        h.su,
        `SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'contacts' AND is_generated = 'NEVER' ORDER BY ordinal_position`,
      )
    ).map((r) => r.column_name);
    const sel = cols.map((c) => (c === 'id' || c === 'offer_id' ? 'gen_random_uuid()' : c === 'offer_expires_at' ? `now() - interval '1 minute'` : c)).join(', ');
    const client = await h.su.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query(`INSERT INTO contacts (${cols.join(', ')}) SELECT ${sel} FROM contacts, generate_series(1, 2000) WHERE id = $1`, [contactId]);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    const noopTimer: TxJobHandler<z.infer<typeof OfferTimerPayload>> = { kind: 'ownership.offer_expiry', queue: 'realtime', schema: OfferTimerPayload, run: async () => {} };
    const reg = registryWith(noopTimer);
    const db = createDatabase({ url: h.db.appUserUrl, max: 8 });
    const metrics = new MemoryMetrics();
    const alerts = memoryAlerts();
    const ac = new AbortController();
    const loops = [
      createSweeper({ db, registry: reg, log: memoryLogger(), alerts, metrics }).run({ everyMs: 1_000, signal: ac.signal }).catch(() => undefined),
      createWorker({ queues: ['realtime'], concurrency: 4, worker: workerName('load'), db, registry: reg, log: memoryLogger(), signal: ac.signal }).run().catch(() => undefined),
    ];
    try {
      const until = Date.now() + 40_000;
      for (;;) {
        const [r] = await suRows<{ n: string }>(h.su, `SELECT count(*)::text AS n FROM jobs WHERE tenant_id = $1 AND kind = 'ownership.offer_expiry' AND status = 'succeeded'`, [t.tenantId]);
        if (Number(r!.n) >= 2000 || Date.now() > until) break;
        await new Promise((res) => setTimeout(res, 200));
      }
      const passes = metrics.samples.get('sweeper_pass_ms') ?? [];
      const lateness = metrics.samples.get('sweeper_lateness_ms') ?? [];
      console.info(`sweeper passes=${passes.length} pass p95=${metrics.quantile('sweeper_pass_ms', 0.95)?.toFixed(0)} ms, lateness max=${Math.max(...lateness).toFixed(0)} ms`);
      const [done] = await suRows<{ n: string }>(h.su, `SELECT count(*)::text AS n FROM jobs WHERE tenant_id = $1 AND kind = 'ownership.offer_expiry' AND status = 'succeeded'`, [t.tenantId]);
      expect(Number(done!.n)).toBeGreaterThanOrEqual(2000);
      expect(Math.max(...lateness)).toBeLessThan(30_000);
      expect(alerts.alerts.filter((a) => a.code === 'SWEEPER_LATE')).toEqual([]);
    } finally {
      ac.abort(new Error('stop'));
      await Promise.all(loops);
      await db.close();
    }
  }, 60_000);
});
