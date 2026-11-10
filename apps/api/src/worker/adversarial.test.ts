// Adversarial verification of api/jobs-worker against real Postgres (per-test database, app_user).
// Each test pins a defect found while trying to break the module:
//   - a job whose lease was lost mid-run must not commit its writes next to the re-run (exactly-once)
//   - a long job keeps its lease while its worker is alive (heartbeat), so no second worker runs it
//   - an early-wake reschedule is not a failure: it never consumes an attempt or kills the job
//   - error text stored in jobs.last_error and the logs never carries quoted values (names) (R-TEN-7)
//   - one failing blob delete does not block the tenant's other blob deletes (R-DATA-5)
//   - one malformed due row does not block the tenant's other overdue deadlines (R-OWN-15)
//   - the dead-job alert covers every dead job, even > one page sharing a finished_at
//   - ownership.followup effects carry machine tokens only, never free text (R-TEN-7)
//   - a handler schema that throws costs its own job only, never the worker loop
//   - regression: two racing sweepers create one live timer job per deadline (E6)
import { instant } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createFakeProviders } from '../providers/index.js';
import { blobDeleteHandler } from './handlers/blobDelete.js';
import { createWorker, workerName } from './loop.js';
import { createMaintenance } from './maintenance.js';
import { memoryAlerts, memoryLogger } from './observability.js';
import { jobPayload } from './payload.js';
import { enqueueTyped } from './registry.js';
import { createSweeper } from './sweeper.js';
import {
  type Harness,
  type World,
  contactRow,
  createHarness,
  createWorld,
  intakeLead,
  jobsFor,
  makeJobsDue,
  registryWith,
  suFixture,
  suRows,
  testTimerHandlers,
  uuid,
} from './testing/world.js';
import type { TxJobHandler } from './types.js';

let h: Harness;
let A: World;
let B: World;
beforeAll(async () => {
  h = await createHarness(6);
  A = await createWorld(h.app, { agents: 1, rule: false });
  B = await createWorld(h.app, { agents: 1, rule: false });
});
afterAll(async () => {
  await h?.close();
});

const Tag = jobPayload({ tag: z.string().regex(/^[a-z0-9-]{1,40}$/) });
type Tag = z.infer<typeof Tag>;
const quiet = () => memoryLogger();

async function probeRows(tag: string): Promise<number> {
  return (await suRows(h.su, `SELECT 1 FROM lead_sources WHERE name LIKE $1`, [`probe-${tag}:%`])).length;
}
async function jobByTag(w: World, kind: string, tag: string) {
  return (await jobsFor(h.su, w.tenantId, kind)).find((j) => j.payload.tag === tag)!;
}
async function reap(): Promise<void> {
  await h.su.query(`SELECT app.reap_stuck_jobs()`);
}

describe('leases', () => {
  it('R-TEN-6: a job whose lease was reaped while it ran rolls back its writes; only the re-run’s effect commits', async () => {
    let runs = 0;
    const handler: TxJobHandler<Tag> = {
      kind: 'test.lease_lost' as const,
      queue: 'default',
      schema: Tag,
      async run(ctx, p) {
        runs++;
        await sql`INSERT INTO lead_sources (tenant_id, id, name, kind) VALUES (app.tenant_id(), ${uuid()}, ${`probe-${p.tag}:${runs}`}, 'other')`.execute(ctx.tx);
        if (runs === 1) {
          // the worker stalled past its lease: the reaper hands the job back to the queue meanwhile
          await h.su.query(`UPDATE jobs SET locked_until = now() - interval '1 second' WHERE id = $1`, [ctx.job.id.toString()]);
          await reap();
        }
      },
    };
    await withTenantTx(A.system(), (tx) => enqueueTyped(tx, handler, { tag: 'lost-1' }), { db: h.app });
    const reg = registryWith(handler);
    const w1 = createWorker({ queues: ['default'], concurrency: 1, worker: workerName('w1'), db: h.app, registry: reg, log: quiet() });
    const w2 = createWorker({ queues: ['default'], concurrency: 1, worker: workerName('w2'), db: h.app, registry: reg, log: quiet() });
    expect(await w1.tick()).toBe(1);
    await w2.drain();
    expect(runs).toBe(2);
    expect(await probeRows('lost-1')).toBe(1); // exactly one committed effect
    const j = await jobByTag(A, 'test.lease_lost', 'lost-1');
    expect(j.status).toBe('succeeded');
  });

  it('a job running longer than its lease keeps it while its worker is alive: the reaper and a second worker never run it twice', async () => {
    let runs = 0;
    const handler: TxJobHandler<Tag> = {
      kind: 'test.long_job' as const,
      queue: 'bulk',
      schema: Tag,
      async run(ctx, p) {
        runs++;
        await new Promise((r) => setTimeout(r, 2_600));
        await sql`INSERT INTO lead_sources (tenant_id, id, name, kind) VALUES (app.tenant_id(), ${uuid()}, ${`probe-${p.tag}:${runs}`}, 'other')`.execute(ctx.tx);
      },
    };
    await withTenantTx(A.system(), (tx) => enqueueTyped(tx, handler, { tag: 'long-1' }), { db: h.app });
    const reg = registryWith(handler);
    const w1 = createWorker({ queues: ['bulk'], concurrency: 1, worker: workerName('w1'), db: h.app, registry: reg, log: quiet(), leaseSeconds: 1 });
    const w2 = createWorker({ queues: ['bulk'], concurrency: 1, worker: workerName('w2'), db: h.app, registry: reg, log: quiet(), leaseSeconds: 1 });
    const running = w1.tick();
    let stop = false;
    const contender = (async () => {
      while (!stop) {
        await reap();
        await w2.tick();
        await new Promise((r) => setTimeout(r, 250));
      }
    })();
    expect(await running).toBe(1);
    stop = true;
    await contender;
    expect(runs).toBe(1);
    expect(await probeRows('long-1')).toBe(1);
    expect((await jobByTag(A, 'test.long_job', 'long-1')).status).toBe('succeeded');
  });

  it('a lease-checked finish inside one tenant’s transaction cannot complete another tenant’s job', async () => {
    const handler: TxJobHandler<Tag> = { kind: 'test.cross_finish' as const, queue: 'bulk', schema: Tag, async run() {} };
    await withTenantTx(B.system(), (tx) => enqueueTyped(tx, handler, { tag: 'cross-1' }), { db: h.app });
    const worker = workerName('x');
    const { claimJobs } = await import('@realty/db');
    const claimed = await claimJobs(['bulk'], worker, 10, { db: h.app });
    const jb = claimed.find((c) => c.tenantId === B.tenantId && c.kind === 'test.cross_finish')!;
    expect(jb).toBeDefined();
    const ok = await withTenantTx(A.system(), async (tx) => {
      const r = await sql<{ ok: boolean }>`SELECT app.finish_job_leased(${jb.id.toString()}::bigint, ${worker}, true, NULL, NULL) AS ok`.execute(tx);
      return r.rows[0]!.ok;
    }, { db: h.app });
    expect(ok).toBe(false);
    expect((await jobByTag(B, 'test.cross_finish', 'cross-1')).status).toBe('running');
    await h.su.query(`UPDATE jobs SET status = 'cancelled', locked_by = NULL, locked_until = NULL, finished_at = now() WHERE status = 'running' AND kind = 'test.cross_finish'`);
  });
});

describe('reschedule', () => {
  it('R-OWN-15: an early wake ({ retryAt }) is not a failed attempt: it never exhausts attempts, kills the job or raises JOB_DEAD', async () => {
    let runs = 0;
    const handler: TxJobHandler<Tag> = {
      kind: 'test.early_wake' as const,
      queue: 'realtime',
      schema: Tag,
      async run(ctx) {
        runs++;
        if (runs <= 2) return { retryAt: instant(ctx.now + 3_600_000) };
      },
    };
    await withTenantTx(A.system(), (tx) => enqueueTyped(tx, handler, { tag: 'wake-1' }, { maxAttempts: 2 }), { db: h.app });
    const alerts = memoryAlerts();
    const reg = registryWith(handler);
    const m = createMaintenance({ db: h.app, registry: reg, log: quiet(), alerts });
    await m.runOnce();
    const w = createWorker({ queues: ['realtime'], concurrency: 1, worker: workerName('t'), db: h.app, registry: reg, log: quiet() });
    for (let i = 0; i < 2; i++) {
      expect(await w.tick()).toBeGreaterThanOrEqual(1);
      const j = await jobByTag(A, 'test.early_wake', 'wake-1');
      expect(j.status).toBe('pending');
      expect(j.attempts).toBe(0);
      expect(j.run_at.getTime()).toBeGreaterThan(Date.now() + 3_000_000);
      await h.su.query(`UPDATE jobs SET run_at = now() - interval '1 second' WHERE id = $1`, [j.id]);
    }
    await w.drain();
    expect(runs).toBe(3);
    expect((await jobByTag(A, 'test.early_wake', 'wake-1')).status).toBe('succeeded');
    await m.runOnce();
    expect(alerts.alerts.filter((a) => a.code === 'JOB_DEAD' && a.details.kind === 'test.early_wake')).toEqual([]);
  });
});

describe('R-TEN-7 error text', () => {
  it('R-TEN-7: a database error quoting a value (a name) is stored and logged as codes only, never the quoted value', async () => {
    const handler: TxJobHandler<Tag> = {
      kind: 'test.pg_error' as const,
      queue: 'default',
      schema: Tag,
      async run(ctx) {
        // a handler bug that passes a display name where an id belongs
        await sql`SELECT ${'Pat Leadbetter'}::uuid`.execute(ctx.tx);
      },
    };
    await withTenantTx(A.system(), (tx) => enqueueTyped(tx, handler, { tag: 'pg-1' }), { db: h.app });
    const log = quiet();
    const w = createWorker({ queues: ['default'], concurrency: 1, worker: workerName('t'), db: h.app, registry: registryWith(handler), log, random: () => 0 });
    expect(await w.tick()).toBeGreaterThanOrEqual(1);
    const j = await jobByTag(A, 'test.pg_error', 'pg-1');
    expect(j.status).toBe('pending');
    expect(j.last_error).toContain('22P02'); // the SQLSTATE survives
    expect(j.last_error).not.toContain('Leadbetter');
    expect(JSON.stringify(log.lines)).not.toContain('Leadbetter');
    expect(JSON.stringify(log.lines)).toContain('22P02');
  });
});

describe('media job', () => {
  // R-DATA-5 (partial: the media-job half, "the media job deletes the blobs")
  it('one blob the storage refuses to delete does not block the tenant’s other blob deletes; it is retried later and alerted', async () => {
    const t = await createWorld(h.app, { agents: 1, rule: false });
    const keys = [0, 1, 2].map((i) => `tenants/${t.tenantId}/mms/obj-${i}`);
    for (const [i, key] of keys.entries()) {
      await suFixture(
        h.su,
        `INSERT INTO stored_objects (tenant_id, id, purpose, storage_key, content_type, byte_size, sha256, dek_wrapped, key_version, deleted_at)
           VALUES ($1, $2, 'mms', $3, 'image/png', 3, decode(repeat('00', 32), 'hex'), NULL, 1, now() - make_interval(mins => $4))`,
        [t.tenantId, uuid(), key, 10 - i],
      );
    }
    const fake = createFakeProviders();
    for (const k of keys) await fake.storage.put(k, new Uint8Array([1, 2, 3]), { contentType: 'image/png' });
    const refused = keys[0]!; // the oldest: first in delete order
    const storage = Object.create(fake.storage) as typeof fake.storage;
    storage.delete = async (k: string) => {
      if (k === refused) throw Object.assign(new Error('AccessDenied'), { code: 'STORAGE_DENIED' });
      return fake.storage.delete(k);
    };
    const providers = { ...fake, storage };
    const alerts = memoryAlerts();
    const reg = registryWith(blobDeleteHandler());
    await createMaintenance({ db: h.app, registry: reg, log: quiet(), periodicEveryMs: 0 }).runOnce();
    await makeJobsDue(h.su, t.tenantId);
    await createWorker({ queues: ['maintenance'], concurrency: 1, worker: workerName('t'), db: h.app, registry: reg, providers, log: quiet(), alerts }).tick();
    const rows = await suRows<{ storage_key: string; b: boolean }>(
      h.su,
      `SELECT storage_key, blob_deleted_at IS NOT NULL AS b FROM stored_objects WHERE tenant_id = $1 ORDER BY storage_key`,
      [t.tenantId],
    );
    expect(rows).toEqual([
      { storage_key: keys[0], b: false },
      { storage_key: keys[1], b: true },
      { storage_key: keys[2], b: true },
    ]);
    expect(await fake.storage.exists(keys[1]!)).toBe(false);
    expect(await fake.storage.exists(refused)).toBe(true);
    expect(alerts.alerts.some((a) => a.code === 'WORKER_ERROR' && a.tenantId === t.tenantId && a.details.failed === 1)).toBe(true);
  });
});

describe('sweeper poison rows', () => {
  it('R-OWN-15 E6: one malformed due row does not stop the sweeper from re-creating the tenant’s other lost timer jobs', async () => {
    const t = await createWorld(h.app, { agents: 2 });
    const good = await intakeLead(h.app, t);
    const bad = await intakeLead(h.app, t);
    for (const c of [good.contactId, bad.contactId]) {
      await suFixture(h.su, `UPDATE contacts SET offer_expires_at = now() - interval '1 second' WHERE id = $1`, [c]);
    }
    // the bad row: an offer id that is a valid Postgres uuid but not an RFC 9562 one (fails the payload schema)
    await suFixture(h.su, `UPDATE contacts SET offer_id = '11111111-1111-1111-1111-111111111111' WHERE id = $1`, [bad.contactId]);
    await h.su.query(`DELETE FROM jobs WHERE tenant_id = $1 AND kind = 'ownership.offer_expiry'`, [t.tenantId]);
    const log = quiet();
    const r = await createSweeper({ db: h.app, registry: registryWith(...testTimerHandlers()), log }).sweepOnce();
    const jobs = await jobsFor(h.su, t.tenantId, 'ownership.offer_expiry');
    expect(jobs.map((j) => j.payload.contactId)).toEqual([good.contactId]);
    expect(r.failedTenants).toBe(0);
    expect(r.failed).toBe(1);
    expect(JSON.stringify(log.lines)).toContain('due row could not be planned');
    expect((await contactRow(h.su, good.contactId)).ownership_state).toBe('offered');
  });
});

describe('dead-job alert', () => {
  it('a dead job raises an alert: every one of 600 jobs that died in one reap (one finished_at) is alerted, across pages', async () => {
    const alerts = memoryAlerts();
    const m = createMaintenance({ db: h.app, registry: registryWith(), log: quiet(), alerts });
    await m.runOnce(); // watermark
    await h.su.query(
      `INSERT INTO jobs (tenant_id, queue, kind, payload, run_at, status, attempts, max_attempts, finished_at, last_error)
       SELECT $1, 'bulk', 'test.mass_dead', jsonb_build_object('n', g), now(), 'dead', 1, 1, now(), 'LEASE_EXPIRED'
         FROM generate_series(1, 600) g`,
      [B.tenantId],
    );
    await m.runOnce();
    await m.runOnce();
    const ids = new Set(alerts.alerts.filter((a) => a.code === 'JOB_DEAD' && a.details.kind === 'test.mass_dead').map((a) => a.details.jobId));
    expect(ids.size).toBe(600);
  });
});

describe('R-TEN-7 payload schemas', () => {
  it('R-TEN-7: ownership.followup effects accept ids, codes and dedupe keys but reject free text (a name in a sentence)', async () => {
    const { FollowupPayloadSchema } = await import('./handlers/followup.js');
    const base = { commandId: uuid(), contactId: uuid(), fanoutNotificationIds: [] };
    const ok = {
      ...base,
      effects: [
        { kind: 'route' },
        { kind: 'notify', userId: uuid(), notification: { kind: 'lead_offer', priority: 'critical', subjectType: 'contact', subjectId: uuid(), dedupeKey: `offer:${uuid()}:${uuid()}`, reasonCode: 'LEAD_OFFER' } },
        { kind: 'upsertFeed', item: { userId: uuid(), itemType: 'lead_offer', band: 'pinned', contactId: uuid(), subjectType: 'contact', subjectId: uuid(), dueAt: 1_800_000_000_000, dedupeKey: 'k', reasons: ['LEAD_OFFER'] } },
        { kind: 'audit', action: 'ownership.drift_detected', reason: 'PROJECTION_DRIFT' },
      ],
    };
    expect(FollowupPayloadSchema.safeParse(ok).success).toBe(true);
    for (const leak of [
      { kind: 'notify', userId: uuid(), notification: { title: 'New lead: Pat Leadbetter' } },
      { kind: 'audit', action: 'ownership.x', reason: 'agent said Pat Leadbetter is a buyer' },
      { kind: 'upsertFeed', item: { reasons: ['Pat Leadbetter wants a call'] } },
      { kind: 'route', 'display name': 'x' },
    ]) {
      expect(FollowupPayloadSchema.safeParse({ ...base, effects: [leak] }).success).toBe(false);
    }
  });
});

describe('fault isolation in the loop', () => {
  it('a handler whose payload schema throws kills only its own job (dead), never the worker loop serving every tenant', async () => {
    const Throwing = jobPayload({ tag: z.string() }).transform((): Tag => {
      throw new TypeError('schema bug');
    });
    const bad: TxJobHandler<Tag> = { kind: 'test.bad_schema' as const, queue: 'default', schema: Throwing as unknown as z.ZodType<Tag>, async run() {} };
    let goodRuns = 0;
    const good: TxJobHandler<Tag> = {
      kind: 'test.good_job' as const,
      queue: 'default',
      schema: Tag,
      async run() {
        goodRuns++;
      },
    };
    await withTenantTx(A.system(), (tx) => enqueueTyped(tx, { kind: 'test.bad_schema', queue: 'default', schema: Tag }, { tag: 'bad-1' }), { db: h.app });
    const ac = new AbortController();
    const w = createWorker({ queues: ['default'], concurrency: 2, worker: workerName('t'), db: h.app, registry: registryWith(bad, good), log: quiet(), idleMs: 20, signal: ac.signal });
    let loopError: unknown = null;
    const loop = w.run().catch((e: unknown) => (loopError = e));
    await new Promise((r) => setTimeout(r, 300));
    await withTenantTx(B.system(), (tx) => enqueueTyped(tx, good, { tag: 'good-1' }), { db: h.app });
    const until = Date.now() + 5_000;
    while (goodRuns === 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 20));
    ac.abort(new Error('stop'));
    await loop;
    expect(String(loopError)).toContain('stop'); // ended by the abort, not by the schema bug
    expect(goodRuns).toBe(1);
    const j = await jobByTag(A, 'test.bad_schema', 'bad-1');
    expect(j.status).toBe('dead');
    expect(j.last_error).toMatch(/^PAYLOAD_INVALID/);
  });
});

describe('concurrent sweepers', () => {
  it('R-OWN-15 E6: two sweeper processes racing on the same lost deadlines create exactly one live timer job each', async () => {
    const t = await createWorld(h.app, { agents: 2 });
    const leads = [await intakeLead(h.app, t), await intakeLead(h.app, t), await intakeLead(h.app, t)];
    for (const l of leads) await suFixture(h.su, `UPDATE contacts SET offer_expires_at = now() - interval '1 second' WHERE id = $1`, [l.contactId]);
    await h.su.query(`DELETE FROM jobs WHERE tenant_id = $1 AND kind = 'ownership.offer_expiry'`, [t.tenantId]);
    const reg = registryWith(...testTimerHandlers());
    const s1 = createSweeper({ db: h.app, registry: reg, log: quiet() });
    const s2 = createSweeper({ db: h.app, registry: reg, log: quiet() });
    const [r1, r2] = await Promise.all([s1.sweepOnce(), s2.sweepOnce()]);
    expect(r1.failedTenants + r2.failedTenants).toBe(0);
    const live = (await jobsFor(h.su, t.tenantId, 'ownership.offer_expiry')).filter((j) => j.status === 'pending');
    expect(live.map((j) => j.payload.contactId).sort()).toEqual(leads.map((l) => l.contactId).sort());
  });
});
