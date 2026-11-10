// The worker loop (BUILD_PLAN module 9: `runWorker(opts: { queues; concurrency; worker }): Promise<never>`).
//
//   app.claim_jobs(queues, worker, free slots, lease)          ← cross-tenant, FOR UPDATE SKIP LOCKED
//   per job:  handler = registry[kind]; payload = handler.schema.parse(job.payload)   (R-TEN-7)
//             withTenantTx(systemActor(job.tenant_id, via, job.id)):                   (R-TEN-6)
//               handler.run(ctx, payload); app.finish_job(ok) IN THE SAME TRANSACTION
//             on error: rollback, then app.finish_job(failed, scrubbed code, retry at DB now + backoff)
//
// - One job = one transaction = one tenant. The handler only ever holds the job tenant's transaction;
//   it cannot reach another tenant (the actor is built from the job row, never from the payload).
// - A crash before COMMIT leaves nothing behind but the lease; app.reap_stuck_jobs (maintenance) puts
//   the job back to pending and it re-runs. Handlers are idempotent (fences, unique keys, status lattices).
// - Unknown kind ⇒ retry with backoff (a newer build may own it) until dead. Invalid payload or a
//   PermanentJobError ⇒ dead at once. Dead jobs raise the platform alert (maintenance dead-job scan).
// - Leases (0005): a heartbeat extends the lease while the handler runs; completion is lease-checked
//   (app.finish_job_leased / app.reschedule_job) in the job's own transaction, and a lost lease rolls
//   the handler's writes back (LeaseLostError) instead of committing them next to the re-run.
// - `{ retryAt }` (an early wake) is a reschedule, not a failure: the attempt is refunded, never dead.
// - Errors are stored as codes (errorCode: SQLSTATE for Postgres errors, quoted segments removed and
//   emails/phone numbers masked otherwise), ≤ 500 chars; logs carry ids, codes and timings only.
import { randomBytes } from 'node:crypto';
import { type ClaimedJob, type Database, type Queue, claimJobs, getDatabase, withTenantTx } from '@realty/db';
import { maskPii } from '../audit.js';
import { type Providers, createFakeProviders } from '../providers/index.js';
import { retryDelayMs } from './backoff.js';
import { type AlertSink, type Logger, type Metrics, MemoryMetrics, logAlertSink, jsonLogger } from './observability.js';
import { type HandlerRegistry, registry as defaultRegistry } from './registry.js';
import { dbClock, extendLease, finishFailed, finishInTx, finishOk, rescheduleInTx } from './repos/jobs.js';
import { systemActor } from './systemActor.js';
import { type JobInfo, type JobResult, PermanentJobError } from './types.js';
import { abortableSleep } from './sleep.js';

export interface WorkerDeps {
  db?: Database;
  registry?: HandlerRegistry;
  providers?: Providers;
  log?: Logger;
  alerts?: AlertSink;
  metrics?: Metrics;
  /** randomness for backoff jitter (default Math.random) */
  random?: () => number;
}

export interface WorkerOptions extends WorkerDeps {
  queues: Queue[];
  concurrency: number;
  /** unique per process: the lease owner name (jobs.locked_by) */
  worker: string;
  /** lease per claimed job, seconds (default 300, max 900 enforced by the DB) */
  leaseSeconds?: number;
  /** poll interval when the queues are empty, ms (default 200) */
  idleMs?: number;
  signal?: AbortSignal;
}

export type JobOutcome = 'succeeded' | 'rescheduled' | 'retry' | 'dead' | 'no_handler' | 'finish_failed' | 'lease_lost';

/**
 * This worker no longer holds the job's lease (it was reaped after expiring, and maybe re-claimed by
 * another worker). Thrown inside a tx-mode job's transaction, it rolls the handler's writes back so
 * they never commit next to the re-run.
 */
export class LeaseLostError extends Error {
  override readonly name = 'LeaseLostError';
  readonly code = 'LEASE_LOST';
}

export interface Worker {
  /** Claims up to `concurrency` due jobs, runs them in parallel and waits for all; returns how many ran. */
  tick(): Promise<number>;
  /** Ticks until a tick finds nothing (bounded); returns the total. */
  drain(maxTicks?: number): Promise<number>;
  /** The continuous loop (never resolves; rejects with the abort reason once `signal` aborts and in-flight jobs finished). */
  run(): Promise<never>;
  execute(job: ClaimedJob): Promise<JobOutcome>;
}

/** A unique worker name: host:pid:random. */
export function workerName(prefix = 'worker'): string {
  return `${prefix}:${process.pid}:${randomBytes(4).toString('hex')}`;
}

/**
 * The stored / logged form of a handler error (R-TEN-7: ids and codes, never names, phones, emails or
 * bodies). A Postgres error keeps only its SQLSTATE and the constraint / table / column it names: its
 * message quotes the offending VALUE (`invalid input syntax for type uuid: "Pat Lead"`). Any other
 * error keeps its message with every quoted segment removed and emails / phone numbers masked.
 */
export function errorCode(err: unknown): string {
  const e = err as { name?: unknown; code?: unknown; message?: unknown; severity?: unknown; constraint?: unknown; table?: unknown; column?: unknown } | null;
  const name = typeof e?.name === 'string' ? e.name : 'Error';
  const code = typeof e?.code === 'string' ? e.code : '';
  const ident = (v: unknown) => (typeof v === 'string' && /^[a-z_][a-z0-9_]{0,62}$/.test(v) ? v : null);
  if (typeof e?.severity === 'string' && /^[0-9A-Z]{5}$/.test(code)) {
    const parts = [`${name}:${code}`];
    for (const [k, v] of [['constraint', e.constraint], ['table', e.table], ['column', e.column]] as const) {
      const id = ident(v);
      if (id) parts.push(`${k}=${id}`);
    }
    return parts.join(' ').slice(0, 500);
  }
  const raw = typeof e?.message === 'string' ? e.message : typeof err === 'string' ? err : '';
  const msg = raw.replace(/"[^"]*"|'[^']*'|`[^`]*`|\u201c[^\u201d]*\u201d/g, '[quoted]');
  const text = code && raw === code ? `${name}:${code}` : `${name}${code ? `:${code}` : ''}: ${msg}`;
  return maskPii(text).slice(0, 500);
}

export function createWorker(opts: WorkerOptions): Worker {
  if (!Number.isInteger(opts.concurrency) || opts.concurrency < 1 || opts.concurrency > 100) throw new RangeError('concurrency must be 1..100');
  if (opts.queues.length === 0) throw new RangeError('at least one queue');
  const db = opts.db ?? getDatabase();
  const reg = opts.registry ?? defaultRegistry;
  const providers = opts.providers ?? createFakeProviders();
  const log = opts.log ?? jsonLogger();
  const alerts = opts.alerts ?? logAlertSink(log);
  const metrics = opts.metrics ?? new MemoryMetrics();
  const random = opts.random ?? Math.random;
  const lease = opts.leaseSeconds ?? 300;
  const idleMs = opts.idleMs ?? 200;
  const worker = opts.worker;

  async function execute(job: ClaimedJob): Promise<JobOutcome> {
    const started = performance.now();
    const labels = { kind: job.kind };
    const info: JobInfo = { id: job.id, kind: job.kind, queue: job.queue, attempts: job.attempts };
    const done = (o: JobOutcome): JobOutcome => {
      metrics.inc('job_outcome', { kind: job.kind, outcome: o });
      metrics.observe('job_run_ms', performance.now() - started, labels);
      return o;
    };
    const fail = async (error: string, delayMs: number | null, outcome: JobOutcome): Promise<JobOutcome> => {
      try {
        if (!(await finishFailed(db, job.id, worker, error, delayMs))) {
          log.warn('job lease lost before its failure was recorded', { jobId: job.id.toString(), kind: job.kind, attempts: job.attempts });
          return done('lease_lost');
        }
      } catch (e) {
        log.error('finish_job failed; the lease will expire and the reaper retries', { jobId: job.id.toString(), kind: job.kind, error: errorCode(e) });
        return done('finish_failed');
      }
      return done(outcome);
    };

    const h = reg.get(job.kind);
    if (!h) {
      log.warn('no handler for job kind', { jobId: job.id.toString(), kind: job.kind, attempts: job.attempts });
      return fail('NO_HANDLER', retryDelayMs(job.attempts, random), 'no_handler');
    }
    if (job.tenantId === null) return fail('NO_TENANT: platform jobs have no tenant transaction', null, 'dead');
    let parsed: ReturnType<typeof h.schema.safeParse>;
    try {
      parsed = h.schema.safeParse(job.payload);
    } catch {
      // a schema that throws (a transform / refine bug) is a rejected payload, never a crashed loop
      parsed = { success: false } as ReturnType<typeof h.schema.safeParse>;
    }
    // never echo the payload: it is exactly what failed the PII / shape check
    if (!parsed.success) {
      log.error('job payload rejected by its schema', { jobId: job.id.toString(), kind: job.kind });
      return fail('PAYLOAD_INVALID: payload rejected by the handler schema (R-TEN-7)', null, 'dead');
    }
    const actor = systemActor(job.tenantId, h.via ?? 'worker', job.id);
    // Heartbeat: while the handler runs, keep the lease (a job longer than its lease is not reaped and
    // handed to a second worker while this one is alive). A crashed process stops beating, so its lease
    // still expires and the reaper re-queues the job.
    let leaseLost = false;
    const beat = setInterval(() => {
      extendLease(db, job.id, worker, lease)
        .then((ok) => {
          if (!ok) leaseLost = true;
        })
        .catch((e: unknown) => log.warn('lease heartbeat failed', { jobId: job.id.toString(), kind: job.kind, error: errorCode(e) }));
    }, Math.max(100, Math.floor((lease * 1000) / 3)));
    try {
      let result: JobResult;
      if (h.mode === 'standalone') {
        const now = await dbClock(db);
        result = await h.run(
          { actor, now, providers, job: info, log, alerts, withTx: (fn) => withTenantTx(actor, fn, { db, retries: 2 }) },
          parsed.data,
        );
        if (!(await finishOk(db, job.id, worker, result))) throw new LeaseLostError('lease lost before the job finished');
      } else {
        result = await withTenantTx(
          actor,
          async (tx, now) => {
            const r = await h.run({ actor, tx, now, providers, job: info, log, alerts }, parsed.data);
            if (leaseLost) throw new LeaseLostError('lease lost while the handler ran');
            // same transaction: the handler's writes commit iff this worker still held the lease
            const held = r && 'retryAt' in r ? await rescheduleInTx(tx, job.id, worker, r.retryAt) : await finishInTx(tx, job.id, worker, { ok: true });
            if (!held) throw new LeaseLostError('lease lost before the job finished');
            return r;
          },
          { db, retries: 2 },
        );
      }
      return done(result && 'retryAt' in result ? 'rescheduled' : 'succeeded');
    } catch (err) {
      if (err instanceof LeaseLostError) {
        // the job is the reaper's / another worker's now: nothing of this run committed (tx mode), and
        // finishing it from here would be wrong
        log.warn('job lease lost; this run was rolled back', { jobId: job.id.toString(), kind: job.kind, attempts: job.attempts, errorCode: err.code });
        return done('lease_lost');
      }
      const code = errorCode(err);
      if (err instanceof PermanentJobError) {
        log.error('job failed permanently', { jobId: job.id.toString(), kind: job.kind, attempts: job.attempts, error: code });
        return fail(code, null, 'dead');
      }
      const delay = h.retryDelayMs ? h.retryDelayMs(job.attempts, random) : retryDelayMs(job.attempts, random);
      log.warn('job failed; will retry', { jobId: job.id.toString(), kind: job.kind, attempts: job.attempts, error: code, durationMs: Math.round(performance.now() - started) });
      return fail(code, delay, 'retry');
    } finally {
      clearInterval(beat);
    }
  }

  async function claim(n: number): Promise<ClaimedJob[]> {
    return claimJobs(opts.queues, worker, n, { leaseSeconds: lease, db });
  }

  async function tick(): Promise<number> {
    const jobs = await claim(opts.concurrency);
    await Promise.all(
      jobs.map((j) => execute(j).catch((e: unknown) => log.error('job execution escaped its handler guard', { jobId: j.id.toString(), kind: j.kind, error: errorCode(e) }))),
    );
    return jobs.length;
  }

  async function drain(maxTicks = 100): Promise<number> {
    let total = 0;
    for (let i = 0; i < maxTicks; i++) {
      const n = await tick();
      total += n;
      if (n === 0) break;
    }
    return total;
  }

  async function run(): Promise<never> {
    const inflight = new Set<Promise<unknown>>();
    let claimErrors = 0;
    const sleep = (ms: number) => abortableSleep(ms, opts.signal);
    while (!opts.signal?.aborted) {
      const free = opts.concurrency - inflight.size;
      let claimed = 0;
      if (free > 0) {
        try {
          const jobs = await claim(free);
          claimErrors = 0;
          claimed = jobs.length;
          for (const j of jobs) {
            // execute() records every handler outcome itself; anything escaping it is a worker bug that
            // must cost this one job (its lease expires, the reaper re-queues it), never the loop
            const p: Promise<unknown> = execute(j)
              .catch((e: unknown) => log.error('job execution escaped its handler guard', { jobId: j.id.toString(), kind: j.kind, error: errorCode(e) }))
              .finally(() => inflight.delete(p));
            inflight.add(p);
          }
        } catch (e) {
          claimErrors++;
          log.error('claim_jobs failed', { error: errorCode(e), attempts: claimErrors });
          await sleep(Math.min(30_000, idleMs * 2 ** Math.min(claimErrors, 8)));
          continue;
        }
      }
      if (claimed === 0 || inflight.size >= opts.concurrency) {
        // wait for a free slot or the idle poll, whichever comes first
        await Promise.race([sleep(idleMs), ...(inflight.size >= opts.concurrency ? [...inflight] : [])]);
      }
    }
    await Promise.allSettled([...inflight]);
    opts.signal?.throwIfAborted();
    throw new Error('worker loop ended');
  }

  return { tick, drain, run, execute };
}

/** BUILD_PLAN signature: claim_jobs → withTenantTx(system) per job, forever. */
export function runWorker(opts: WorkerOptions): Promise<never> {
  return createWorker(opts).run();
}
