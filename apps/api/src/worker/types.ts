// Job handler contract (BUILD_PLAN module 9).
//
//   export interface JobHandler<P> { kind; queue; schema: z.ZodType<P>;
//     run(ctx: { actor: SystemActor; tx: Kysely<DB>; now: Instant; providers: Providers }, payload: P): Promise<void | { retryAt: Instant }> }
//
// Two run modes:
// - 'tx' (default, the BUILD_PLAN shape): the worker opens ONE withTenantTx(system actor of the job's
//   tenant), runs the handler in it and marks the job succeeded (app.finish_job) in that SAME
//   transaction, so the handler's writes and the job's completion commit or roll back together.
//   One job = one transaction = one tenant (R-TEN-6).
// - 'standalone' (an addition, reported in the module output): for flows that must commit between
//   steps (dispatch TX1 → provider.send → TX2, ARCHITECTURE §9). The handler gets `withTx(fn)`, which
//   opens transactions in the job's tenant only; it never receives a cross-tenant handle. It must be
//   idempotent across a crash between its transactions (the re-run after a lease expiry).
import type { Instant, SystemActor, SystemVia } from '@realty/core/foundation';
import type { Queue, Tx } from '@realty/db';
import type { z } from 'zod';
import type { Providers } from '../providers/index.js';
import type { AlertSink, Logger } from './observability.js';

/** `area.verb` (jobs.kind CHECK ^[a-z_]+\.[a-z_]+$). */
export type JobKind = `${string}.${string}`;

export interface JobInfo {
  id: bigint;
  kind: string;
  queue: Queue;
  /** this run's attempt number (1 on the first run) */
  attempts: number;
}

export interface JobContext {
  actor: SystemActor;
  tx: Tx;
  /** the DB clock read in this transaction (the single clock passed into core) */
  now: Instant;
  providers: Providers;
  job: JobInfo;
  log: Logger;
  alerts: AlertSink;
}

export interface StandaloneJobContext {
  actor: SystemActor;
  /** the DB clock when the job started */
  now: Instant;
  providers: Providers;
  job: JobInfo;
  log: Logger;
  alerts: AlertSink;
  /** one transaction in THIS job's tenant as its system actor (never another tenant) */
  withTx<T>(fn: (tx: Tx, now: Instant) => Promise<T>): Promise<T>;
}

/**
 * `{ retryAt }` is an early wake, not a failure: the job goes back to pending at that instant with the
 * claim's attempt refunded (app.reschedule_job), so it never exhausts attempts or goes dead.
 */
export type JobResult = void | { retryAt: Instant };

interface HandlerBase<P> {
  kind: JobKind;
  queue: Queue;
  /** Zod schema of the payload: ids, codes, fences and instants only (R-TEN-7). Build it with `jobPayload`. */
  schema: z.ZodType<P>;
  /** why the system acts (audit actor_via); default 'worker' */
  via?: SystemVia;
  /** default for jobs enqueued through `enqueueTyped` (jobs.max_attempts, default 10) */
  maxAttempts?: number;
  /** default priority for `enqueueTyped` (lower runs first, default 100) */
  priority?: number;
  /** retry delay after a failure; default jittered exponential (backoff.ts) */
  retryDelayMs?: (attempts: number, random: () => number) => number;
  /**
   * A periodic per-tenant job: the maintenance pass keeps exactly one live job of this kind per
   * tenant (dedupe `periodic:{kind}`), due at the next `every` boundary (+ offset), with `periodicPayload`.
   */
  every?: { ms: number; offsetMs?: number };
  periodicPayload?: P;
}

export interface TxJobHandler<P> extends HandlerBase<P> {
  mode?: 'tx';
  run(ctx: JobContext, payload: P): Promise<JobResult>;
}

export interface StandaloneJobHandler<P> extends HandlerBase<P> {
  mode: 'standalone';
  run(ctx: StandaloneJobContext, payload: P): Promise<JobResult>;
}

export type JobHandler<P> = TxJobHandler<P> | StandaloneJobHandler<P>;

/**
 * Thrown by a handler for a failure that can never succeed on retry (bad reference, invariant
 * violation): the job goes `dead` at once, which raises the dead-job alert. `code` is stored
 * (scrubbed) in jobs.last_error.
 */
export class PermanentJobError extends Error {
  override readonly name = 'PermanentJobError';
  constructor(
    readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}
