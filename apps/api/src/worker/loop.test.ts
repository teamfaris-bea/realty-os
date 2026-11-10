// Worker loop against real Postgres (per-test database, app_user): R-TEN-6, R-TEN-7, retries, dead
// jobs and their alert, standalone handlers, the concurrency limit.
import { instant } from '@realty/core/foundation';
import { type Database, enqueueJob, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createWorker, workerName } from './loop.js';
import { createMaintenance } from './maintenance.js';
import { MemoryMetrics, memoryAlerts, memoryLogger } from './observability.js';
import { jobPayload, zId } from './payload.js';
import { enqueueTyped } from './registry.js';
import { type Harness, type World, createHarness, createWorld, jobsFor, registryWith, suRows, uuid } from './testing/world.js';
import { PermanentJobError, type StandaloneJobHandler, type TxJobHandler } from './types.js';

let h: Harness;
let A: World;
let B: World;
beforeAll(async () => {
  h = await createHarness();
  A = await createWorld(h.app, { agents: 1, rule: false });
  B = await createWorld(h.app, { agents: 1, rule: false });
});
afterAll(async () => {
  await h?.close();
});

const Probe = jobPayload({ tag: z.string().regex(/^[a-z0-9-]{1,40}$/), mode: z.enum(['ok', 'fail', 'permanent', 'reschedule']) });
type Probe = z.infer<typeof Probe>;

interface Seen {
  tag: string;
  jobTenant: string;
  gucTenant: string;
  actorKind: string;
  txid: string;
  actorJobId: string | undefined;
  otherTenantRows: number;
}

function probeHandler(seen: Seen[], kind = 'test.probe'): TxJobHandler<Probe> {
  return {
    kind: kind as 'test.probe',
    queue: 'default',
    schema: Probe,
    async run(ctx, p) {
      const r = await sql<{ t: string; k: string; x: string; other: string }>`
        SELECT app.tenant_id()::text AS t, app.actor_kind() AS k, txid_current()::text AS x,
               (SELECT count(*) FROM lead_sources WHERE tenant_id <> ${ctx.actor.tenantId}::uuid)::text AS other`.execute(ctx.tx);
      const row = r.rows[0]!;
      seen.push({ tag: p.tag, jobTenant: ctx.actor.tenantId, gucTenant: row.t, actorKind: row.k, txid: row.x, actorJobId: ctx.actor.jobId, otherTenantRows: Number(row.other) });
      // a write in the job's transaction: committed iff the job succeeds
      await sql`INSERT INTO lead_sources (tenant_id, id, name, kind) VALUES (app.tenant_id(), ${uuid()}, ${'probe-' + p.tag}, 'other')`.execute(ctx.tx);
      if (p.mode === 'fail') throw new Error('provider said: call +15555550100 or jane@example.com');
      if (p.mode === 'permanent') throw new PermanentJobError('BAD_REFERENCE');
      if (p.mode === 'reschedule') return { retryAt: instant(ctx.now + 3_600_000) };
    },
  };
}

async function enqueueProbe(db: Database, w: World, p: Probe, kind = 'test.probe', maxAttempts?: number): Promise<void> {
  await withTenantTx(w.system(), (tx) => enqueueTyped(tx, { kind: kind as 'test.probe', queue: 'default', schema: Probe }, p, maxAttempts ? { maxAttempts } : {}), { db });
}

async function probeRows(tag: string): Promise<number> {
  return (await suRows(h.su, `SELECT 1 FROM lead_sources WHERE name = $1`, ['probe-' + tag])).length;
}

describe('one job = one transaction = one tenant', () => {
  it('R-TEN-6: jobs of two tenants claimed in one batch each run in their own transaction, in their own tenant, as its system actor', async () => {
    const seen: Seen[] = [];
    const w = createWorker({ queues: ['default'], concurrency: 10, worker: workerName('t'), db: h.app, registry: registryWith(probeHandler(seen)), log: memoryLogger() });
    await enqueueProbe(h.app, A, { tag: 'iso-a1', mode: 'ok' });
    await enqueueProbe(h.app, B, { tag: 'iso-b1', mode: 'ok' });
    await enqueueProbe(h.app, A, { tag: 'iso-a2', mode: 'ok' });
    expect(await w.tick()).toBe(3);
    expect(seen.map((s) => s.tag).sort()).toEqual(['iso-a1', 'iso-a2', 'iso-b1']);
    for (const s of seen) {
      expect(s.gucTenant).toBe(s.jobTenant);
      expect(s.actorKind).toBe('system');
      expect(s.otherTenantRows).toBe(0); // RLS: the other tenant's rows are invisible inside this job
      expect(s.actorJobId).toMatch(/^[0-9]+$/);
    }
    expect(new Set(seen.map((s) => s.txid)).size).toBe(3);
    expect(seen.find((s) => s.tag === 'iso-b1')!.jobTenant).toBe(B.tenantId);
    const jobs = [...(await jobsFor(h.su, A.tenantId, 'test.probe')), ...(await jobsFor(h.su, B.tenantId, 'test.probe'))];
    expect(jobs.filter((j) => j.payload.tag?.toString().startsWith('iso-')).every((j) => j.status === 'succeeded')).toBe(true);
    expect(await probeRows('iso-a1')).toBe(1);
  });

  it('R-TEN-6: a failing handler’s writes roll back with its transaction; the job retries later with a scrubbed error (R-TEN-7)', async () => {
    const seen: Seen[] = [];
    const log = memoryLogger();
    const w = createWorker({ queues: ['default'], concurrency: 4, worker: workerName('t'), db: h.app, registry: registryWith(probeHandler(seen)), log, random: () => 0 });
    await enqueueProbe(h.app, A, { tag: 'fail-1', mode: 'fail' });
    expect(await w.tick()).toBe(1);
    expect(await probeRows('fail-1')).toBe(0);
    const [j] = (await jobsFor(h.su, A.tenantId, 'test.probe')).filter((x) => x.payload.tag === 'fail-1');
    expect(j!.status).toBe('pending');
    expect(j!.attempts).toBe(1);
    expect(j!.run_at.getTime()).toBeGreaterThan(Date.now() + 1000); // backoff ≥ 2.5 s
    expect(j!.last_error).toMatch(/^Error: provider said/);
    expect(j!.last_error).not.toMatch(/5555550100|jane@example\.com/);
    const logged = JSON.stringify(log.lines);
    expect(logged).toContain('job failed; will retry');
    expect(logged).not.toMatch(/5555550100|jane@example\.com/);
  });

  it('a handler result { retryAt } commits its writes and puts the job back to pending at that instant', async () => {
    const w = createWorker({ queues: ['default'], concurrency: 4, worker: workerName('t'), db: h.app, registry: registryWith(probeHandler([])), log: memoryLogger() });
    await enqueueProbe(h.app, A, { tag: 'resched-1', mode: 'reschedule' });
    expect(await w.tick()).toBe(1);
    expect(await probeRows('resched-1')).toBe(1);
    const [j] = (await jobsFor(h.su, A.tenantId, 'test.probe')).filter((x) => x.payload.tag === 'resched-1');
    expect(j!.status).toBe('pending');
    expect(j!.last_error).toBe('RESCHEDULED');
    expect(j!.run_at.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
  });

  it('standalone handlers get transactions bound to the job tenant only, then the job is finished', async () => {
    const txids: string[] = [];
    const tenants: string[] = [];
    const handler: StandaloneJobHandler<{ id: string }> = {
      kind: 'test.standalone',
      queue: 'default',
      mode: 'standalone',
      schema: jobPayload({ id: zId }),
      async run(ctx) {
        for (let i = 0; i < 2; i++) {
          await ctx.withTx(async (tx) => {
            const r = await sql<{ x: string; t: string }>`SELECT txid_current()::text AS x, app.tenant_id()::text AS t`.execute(tx);
            txids.push(r.rows[0]!.x);
            tenants.push(r.rows[0]!.t);
          });
        }
      },
    };
    const w = createWorker({ queues: ['default'], concurrency: 2, worker: workerName('t'), db: h.app, registry: registryWith(handler), log: memoryLogger() });
    await withTenantTx(B.system(), (tx) => enqueueTyped(tx, handler, { id: uuid() }), { db: h.app });
    expect(await w.tick()).toBe(1);
    expect(new Set(txids).size).toBe(2);
    expect(tenants).toEqual([B.tenantId, B.tenantId]);
    expect((await jobsFor(h.su, B.tenantId, 'test.standalone'))[0]!.status).toBe('succeeded');
  });

  it('the continuous loop never runs more jobs at once than its concurrency and stops on abort', async () => {
    let running = 0;
    let peak = 0;
    let done = 0;
    const handler: TxJobHandler<{ id: string }> = {
      kind: 'test.slow',
      queue: 'bulk',
      schema: jobPayload({ id: zId }),
      async run() {
        running++;
        peak = Math.max(peak, running);
        await new Promise((r) => setTimeout(r, 60));
        running--;
        done++;
      },
    };
    for (let i = 0; i < 6; i++) await withTenantTx(A.system(), (tx) => enqueueTyped(tx, handler, { id: uuid() }), { db: h.app });
    const ac = new AbortController();
    const w = createWorker({ queues: ['bulk'], concurrency: 2, worker: workerName('t'), db: h.app, registry: registryWith(handler), log: memoryLogger(), idleMs: 20, signal: ac.signal });
    const loop = w.run().catch((e: unknown) => e);
    const until = Date.now() + 10_000;
    while (done < 6 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    ac.abort(new Error('stop'));
    expect(String(await loop)).toContain('stop');
    expect(done).toBe(6);
    expect(peak).toBe(2);
  });
});

describe('dead jobs', () => {
  it('a dead job raises an alert: a permanent failure, an invalid (PII) payload and an unknown kind out of attempts all go dead and alert once', async () => {
    const seen: Seen[] = [];
    const alerts = memoryAlerts();
    const metrics = new MemoryMetrics();
    const reg = registryWith(probeHandler(seen));
    const w = createWorker({ queues: ['default', 'realtime'], concurrency: 10, worker: workerName('t'), db: h.app, registry: reg, log: memoryLogger(), metrics });
    const m = createMaintenance({ db: h.app, registry: reg, log: memoryLogger(), alerts, deadLookbackMs: 60_000 });
    await m.runOnce(); // establishes the dead-job watermark

    await enqueueProbe(h.app, A, { tag: 'perm-1', mode: 'permanent' });
    // R-TEN-7: a payload smuggling a phone number in an extra field: written by the superuser (no
    // application path accepts it), it must never reach the handler
    await h.su.query(`INSERT INTO jobs (tenant_id, queue, kind, payload, run_at) VALUES ($1, 'default', 'test.probe', $2::jsonb, now())`, [
      B.tenantId,
      JSON.stringify({ tag: 'pii-1', mode: 'ok', phone: '+15555550100' }),
    ]);
    await withTenantTx(A.system(), (tx) => enqueueJob(tx, { queue: 'realtime', kind: 'test.unknown', payload: { id: uuid() }, maxAttempts: 1 }), { db: h.app });

    expect(await w.tick()).toBe(3);
    expect(seen.map((s) => s.tag)).toEqual(['perm-1']); // the PII payload never ran
    const deadA = (await jobsFor(h.su, A.tenantId)).filter((j) => j.status === 'dead');
    const deadB = (await jobsFor(h.su, B.tenantId)).filter((j) => j.status === 'dead');
    expect(deadA.map((j) => j.last_error).sort()).toEqual(['NO_HANDLER', 'PermanentJobError:BAD_REFERENCE']);
    expect(deadB.map((j) => j.last_error)).toEqual(['PAYLOAD_INVALID: payload rejected by the handler schema (R-TEN-7)']);
    expect(await probeRows('perm-1')).toBe(0);

    const r = await m.runOnce();
    expect(r.deadAlerted).toBe(3);
    const dead = alerts.alerts.filter((a) => a.code === 'JOB_DEAD');
    expect(dead.map((a) => a.details.kind).sort()).toEqual(['test.probe', 'test.probe', 'test.unknown']);
    expect(dead.find((a) => a.details.kind === 'test.unknown')!.severity).toBe('P1'); // realtime queue
    expect(JSON.stringify(alerts.alerts)).not.toContain('5555550100');
    // alerted once: the next pass raises nothing new
    expect((await m.runOnce()).deadAlerted).toBe(0);
    expect(metrics.counter('job_outcome', { kind: 'test.unknown', outcome: 'no_handler' })).toBe(1);
  });
});
