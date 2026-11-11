// Worker queries against the queue and the cross-tenant maintenance definers. Calls marked
// "no context" run in a transaction with NO tenant and NO user (withPreTenant without a user), which
// is the only context in which the worker definers answer (migration 0004).
import type { Instant, TenantId } from '@realty/core/foundation';
import { instantFromDate, toIso } from '@realty/core/foundation';
import { type Database, type Queue, type Tx, scrubError, withPreTenant } from '@realty/db';
import { sql } from 'kysely';

/**
 * app.finish_job_leased inside the caller's (job) transaction: the job completes iff the transaction
 * commits. Returns false when this worker no longer holds the lease (reaped, maybe re-claimed): the
 * caller must then roll its transaction back, or its writes would commit next to the re-run (0005).
 */
export async function finishInTx(tx: Tx, id: bigint, worker: string, r: { ok: true } | { ok: false; error: string; retryAt: Instant | null }): Promise<boolean> {
  const error = r.ok ? null : scrubError(r.error);
  const retryAt = r.ok || r.retryAt === null ? null : toIso(r.retryAt);
  const q = await sql<{ ok: boolean }>`SELECT app.finish_job_leased(${id.toString()}::bigint, ${worker}, ${r.ok}, ${error}, ${retryAt}::timestamptz) AS ok`.execute(tx);
  return q.rows[0]?.ok === true;
}

/**
 * An early wake (handler result `{ retryAt }`): back to pending at `runAt` with the attempt refunded
 * (app.reschedule_job, 0005). Not a failure. Returns false when the lease is gone.
 */
export async function rescheduleInTx(tx: Tx, id: bigint, worker: string, runAt: Instant): Promise<boolean> {
  const q = await sql<{ ok: boolean }>`SELECT app.reschedule_job(${id.toString()}::bigint, ${worker}, ${toIso(runAt)}::timestamptz) AS ok`.execute(tx);
  return q.rows[0]?.ok === true;
}

/** app.finish_job_leased after a failure, in its own context-free transaction; retry at DB now + delay (null: dead). */
export async function finishFailed(db: Database, id: bigint, worker: string, error: string, delayMs: number | null): Promise<boolean> {
  return withPreTenant(async (tx) => {
    const q = await sql<{ ok: boolean }>`SELECT app.finish_job_leased(${id.toString()}::bigint, ${worker}, false, ${scrubError(error)},
              CASE WHEN ${delayMs}::bigint IS NULL THEN NULL
                   ELSE clock_timestamp() + make_interval(secs => ${delayMs ?? 0}::double precision / 1000) END) AS ok`.execute(tx);
    return q.rows[0]?.ok === true;
  }, { db });
}

/** Completes a standalone handler's job (success or reschedule) in its own context-free transaction. */
export async function finishOk(db: Database, id: bigint, worker: string, result: void | { retryAt: Instant }): Promise<boolean> {
  return withPreTenant(async (tx) => {
    if (result && 'retryAt' in result) return rescheduleInTx(tx, id, worker, result.retryAt);
    return finishInTx(tx, id, worker, { ok: true });
  }, { db });
}

/** The lease heartbeat (app.extend_job_lease, 0005): false once the lease is gone. */
export async function extendLease(db: Database, id: bigint, worker: string, leaseSeconds: number): Promise<boolean> {
  return withPreTenant(async (tx) => {
    const q = await sql<{ ok: boolean }>`SELECT app.extend_job_lease(${id.toString()}::bigint, ${worker}, make_interval(secs => ${leaseSeconds})) AS ok`.execute(tx);
    return q.rows[0]?.ok === true;
  }, { db });
}

/** The DB clock, read in a context-free transaction. */
export function dbClock(db: Database): Promise<Instant> {
  return withPreTenant(async (_tx, now) => now, { db });
}

export interface TenantRow {
  tenantId: TenantId;
  status: 'active' | 'suspended' | 'pending_deletion';
}

/** Every tenant id (no context; app.worker_tenant_ids). */
export function tenantIds(db: Database): Promise<TenantRow[]> {
  return withPreTenant(async (tx) => {
    const r = await sql<{ tenant_id: string; status: TenantRow['status'] }>`SELECT * FROM app.worker_tenant_ids()`.execute(tx);
    return r.rows.map((x) => ({ tenantId: x.tenant_id as TenantId, status: x.status }));
  }, { db });
}

export interface DeadJob {
  id: bigint;
  tenantId: TenantId | null;
  queue: Queue;
  kind: string;
  attempts: number;
  lastError: string | null;
  finishedAt: Instant;
}

/** Keyset cursor over dead jobs: finished_at in exact epoch MICROseconds (as text) and the job id. */
export interface DeadCursor {
  finishedUs: string;
  id: string;
}

export function deadCursorAt(at: Instant): DeadCursor {
  return { finishedUs: (BigInt(at) * 1000n).toString(), id: '0' };
}

/** Dead jobs strictly after `cursor` in (finished_at, id) order (no context; app.dead_jobs_after). */
export function deadJobs(db: Database, cursor: DeadCursor, limit: number): Promise<{ rows: DeadJob[]; next: DeadCursor }> {
  return withPreTenant(async (tx) => {
    const r = await sql<{ id: string; tenant_id: string | null; queue: Queue; kind: string; attempts: number; last_error: string | null; finished_at: Date; finished_us: string }>`
      SELECT d.*, (extract(epoch FROM d.finished_at) * 1000000)::bigint::text AS finished_us
        FROM app.dead_jobs_after('epoch'::timestamptz + ${cursor.finishedUs}::bigint * interval '1 microsecond', ${cursor.id}::bigint, ${limit}) d`.execute(tx);
    const last = r.rows[r.rows.length - 1];
    return {
      rows: r.rows.map((x) => ({
        id: BigInt(x.id),
        tenantId: x.tenant_id as TenantId | null,
        queue: x.queue,
        kind: x.kind,
        attempts: x.attempts,
        lastError: x.last_error,
        finishedAt: instantFromDate(x.finished_at),
      })),
      next: last ? { finishedUs: last.finished_us, id: last.id } : cursor,
    };
  }, { db });
}

export interface AuditSeqStats {
  minSeq: number | null;
  maxSeq: number | null;
  rows: number;
  /** seq values inside [min, max] with no row: rolled-back transactions (or deletions), R-AUDIT-8 */
  missing: number;
}

/** Global audit_log.seq statistics (no context; app.audit_seq_stats). */
export function auditSeqStats(db: Database): Promise<AuditSeqStats> {
  return withPreTenant(async (tx) => {
    const r = await sql<{ min_seq: string | null; max_seq: string | null; row_count: string }>`SELECT * FROM app.audit_seq_stats()`.execute(tx);
    const x = r.rows[0]!;
    const min = x.min_seq === null ? null : Number(x.min_seq);
    const max = x.max_seq === null ? null : Number(x.max_seq);
    const rows = Number(x.row_count);
    return { minSeq: min, maxSeq: max, rows, missing: min === null || max === null ? 0 : max - min + 1 - rows };
  }, { db });
}

/** app.retention_sweep(now): the retention defaults of R-DATA-3 (owned by app_retention; no context). */
export function retentionSweep(db: Database, now: Instant): Promise<Record<string, number>> {
  return withPreTenant(async (tx) => {
    const r = await sql<{ r: Record<string, number> }>`SELECT app.retention_sweep(${toIso(now)}::timestamptz) AS r`.execute(tx);
    return r.rows[0]!.r;
  }, { db });
}

/**
 * Deletes webhook ids past their replay window (app.purge_webhook_events, migration 0018). The windows
 * live in SQL and use the database's real clock: nothing here can shorten them.
 */
export function purgeWebhookEvents(db: Database): Promise<Record<string, number>> {
  return withPreTenant(async (tx) => {
    const r = await sql<{ r: Record<string, number> }>`SELECT app.purge_webhook_events() AS r`.execute(tx);
    return r.rows[0]!.r;
  }, { db });
}
