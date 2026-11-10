// Maintenance pass (BUILD_PLAN module 9: `runMaintenance(): Promise<void>` — reap_stuck_jobs,
// retention_sweep, drift checks, blob deletes). The worker runs one pass every 60 s; each step has its
// own cadence and is isolated (a failing step is logged and alerted, the others still run).
//
//   1. app.reap_stuck_jobs()            expired leases → pending (or dead when attempts are exhausted)
//   2. dead-job scan (app.dead_jobs_after) every newly dead job raises a platform alert (P1 on realtime)
//   3. app.retention_sweep(now)         hourly; R-DATA-3 defaults (VERIFY WITH COUNSEL), counts tracked
//   4. audit seq gap check              daily; global audit_log.seq gaps counted and tracked (R-AUDIT-8)
//   5. periodic per-tenant jobs         every 5 min: keep one live job per tenant per periodic kind
//                                       (ownership.drift_check, consent.drift_check, storage.blob_delete),
//                                       due at its next boundary, enqueued in the tenant's own
//                                       transaction (R-TEN-6); dedupe `periodic:{kind}`
import type { Instant, TenantId } from '@realty/core/foundation';
import { DAY_MS, HOUR_MS, MINUTE_MS, instant } from '@realty/core/foundation';
import { type Database, getDatabase, reapJobs, withTenantTx } from '@realty/db';
import { type AlertSink, type Logger, type Metrics, MemoryMetrics, jsonLogger, logAlertSink } from './observability.js';
import { type HandlerRegistry, enqueueTyped, registry as defaultRegistry } from './registry.js';
import { type AuditSeqStats, type DeadCursor, auditSeqStats, dbClock, deadCursorAt, deadJobs, retentionSweep, tenantIds } from './repos/jobs.js';
import { systemActor } from './systemActor.js';
import type { JobHandler } from './types.js';
import { abortableSleep } from './sleep.js';

export interface MaintenanceOptions {
  db?: Database;
  registry?: HandlerRegistry;
  log?: Logger;
  alerts?: AlertSink;
  metrics?: Metrics;
  /** default 1 h */
  retentionEveryMs?: number;
  /** default 24 h */
  auditCheckEveryMs?: number;
  /** default 5 min */
  periodicEveryMs?: number;
  /** how far back the first dead-job scan looks (default 1 h) */
  deadLookbackMs?: number;
}

export interface MaintenanceReport {
  at: Instant;
  reaped: number | null;
  deadAlerted: number | null;
  retention: Record<string, number> | null;
  audit: AuditSeqStats | null;
  periodicEnqueued: number | null;
  failedSteps: string[];
}

export const periodicDedupeKey = (kind: string) => `periodic:${kind}`;

const DEAD_PAGE = 500;
/** pages per pass (a larger backlog continues on the next pass, from the cursor) */
const DEAD_PAGES_PER_PASS = 20;

/** The first `every` boundary (shifted by `offset`) strictly after `now`. */
export function nextBoundary(now: Instant, every: number, offset = 0): Instant {
  const k = Math.floor((now - offset) / every) + 1;
  return instant(offset + k * every);
}

export interface Maintenance {
  runOnce(at?: Instant): Promise<MaintenanceReport>;
  run(opts: { everyMs: number; signal?: AbortSignal }): Promise<never>;
}

export function createMaintenance(o: MaintenanceOptions = {}): Maintenance {
  const db = o.db ?? getDatabase();
  const reg = o.registry ?? defaultRegistry;
  const log = o.log ?? jsonLogger();
  const alerts = o.alerts ?? logAlertSink(log);
  const metrics = o.metrics ?? new MemoryMetrics();
  const retentionEvery = o.retentionEveryMs ?? HOUR_MS;
  const auditEvery = o.auditCheckEveryMs ?? DAY_MS;
  const periodicEvery = o.periodicEveryMs ?? 5 * MINUTE_MS;
  let lastRetention = Number.NEGATIVE_INFINITY;
  let lastAudit = Number.NEGATIVE_INFINITY;
  let lastPeriodic = Number.NEGATIVE_INFINITY;
  let lastMissing: number | null = null;
  let deadCursor: DeadCursor | null = null;
  const alerted = new Set<string>();

  async function step<T>(name: string, report: MaintenanceReport, fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (e) {
      const err = e as { name?: string; code?: string };
      const error = `${err.name ?? 'Error'}${err.code ? `:${err.code}` : ''}`;
      report.failedSteps.push(name);
      log.error('maintenance step failed', { step: name, error });
      alerts.raise({ severity: 'P2', code: 'WORKER_ERROR', details: { step: name, error } });
      return null;
    }
  }

  /**
   * Alerts every job that died since the last scan, paging by the keyset (finished_at, id) so that any
   * number of jobs dying in ONE statement (one reap: one finished_at) is covered (app.dead_jobs_after).
   */
  async function scanDead(now: Instant): Promise<number> {
    let cursor = deadCursor ?? deadCursorAt(instant(now - (o.deadLookbackMs ?? HOUR_MS)));
    let n = 0;
    for (let page = 0; page < DEAD_PAGES_PER_PASS; page++) {
      const { rows, next } = await deadJobs(db, cursor, DEAD_PAGE);
      cursor = next;
      for (const j of rows) {
        const id = j.id.toString();
        if (alerted.has(id)) continue;
        alerted.add(id);
        n++;
        alerts.raise({
          severity: j.queue === 'realtime' ? 'P1' : 'P2',
          code: 'JOB_DEAD',
          tenantId: j.tenantId,
          details: { jobId: id, kind: j.kind, queue: j.queue, attempts: j.attempts, lastError: (j.lastError ?? '').slice(0, 160) },
        });
        metrics.inc('jobs_dead', { kind: j.kind, queue: j.queue });
      }
      if (rows.length < DEAD_PAGE) break;
    }
    deadCursor = cursor;
    if (alerted.size > 50_000) alerted.clear();
    return n;
  }

  async function schedulePeriodic(now: Instant): Promise<number> {
    const periodic = reg.periodic();
    if (periodic.length === 0) return 0;
    const tenants = (await tenantIds(db)).filter((t) => t.status !== 'pending_deletion');
    let n = 0;
    for (const t of tenants) n += await schedulePeriodicForTenant(t.tenantId, periodic, now);
    return n;
  }

  async function schedulePeriodicForTenant(tenantId: TenantId, periodic: JobHandler<unknown>[], now: Instant): Promise<number> {
    return withTenantTx(
      systemActor(tenantId, 'worker'),
      async (tx) => {
        let n = 0;
        for (const h of periodic) {
          const every = h.every!;
          const ok = await enqueueTyped(tx, h, h.periodicPayload ?? {}, {
            runAt: nextBoundary(now, every.ms, every.offsetMs ?? 0),
            dedupeKey: periodicDedupeKey(h.kind),
          });
          if (ok) n++;
        }
        return n;
      },
      { db },
    );
  }

  async function runOnce(at?: Instant): Promise<MaintenanceReport> {
    const now = at ?? (await dbClock(db));
    const report: MaintenanceReport = { at: now, reaped: null, deadAlerted: null, retention: null, audit: null, periodicEnqueued: null, failedSteps: [] };

    report.reaped = await step('reap', report, async () => {
      const n = await reapJobs({ db });
      metrics.inc('jobs_reaped', undefined, n);
      if (n > 0) log.warn('expired job leases reaped', { count: n });
      return n;
    });

    report.deadAlerted = await step('dead_scan', report, () => scanDead(now));

    if (now - lastRetention >= retentionEvery) {
      report.retention = await step('retention', report, async () => {
        const r = await retentionSweep(db, now);
        for (const [k, v] of Object.entries(r)) metrics.gauge('retention_last', v, { item: k });
        log.info('retention sweep', { result: r });
        return r;
      });
      if (report.retention) lastRetention = now;
    }

    if (now - lastAudit >= auditEvery) {
      report.audit = await step('audit_seq', report, async () => {
        const s = await auditSeqStats(db);
        metrics.gauge('audit_seq_missing', s.missing);
        metrics.gauge('audit_seq_rows', s.rows);
        // gaps come from rolled-back transactions (expected); the count is tracked, its growth logged
        if (lastMissing !== null && s.missing > lastMissing) log.warn('audit_log seq gaps grew', { count: s.missing - lastMissing, result: s });
        else log.info('audit_log seq check', { result: s });
        lastMissing = s.missing;
        return s;
      });
      if (report.audit) lastAudit = now;
    }

    if (now - lastPeriodic >= periodicEvery) {
      report.periodicEnqueued = await step('periodic', report, () => schedulePeriodic(now));
      if (report.periodicEnqueued !== null) lastPeriodic = now;
    }
    return report;
  }

  async function run(r: { everyMs: number; signal?: AbortSignal }): Promise<never> {
    while (!r.signal?.aborted) {
      try {
        await runOnce();
      } catch (e) {
        log.error('maintenance pass failed', { error: (e as Error).name });
      }
      await abortableSleep(r.everyMs, r.signal);
    }
    r.signal?.throwIfAborted();
    throw new Error('maintenance loop ended');
  }

  return { runOnce, run };
}

let defaultMaintenance: Maintenance | null = null;

/**
 * BUILD_PLAN signature: one maintenance pass. Without options it reuses the process-wide instance
 * (its cadences and dead-job watermark persist between calls).
 */
export async function runMaintenance(o?: MaintenanceOptions): Promise<void> {
  const m = o ? createMaintenance(o) : (defaultMaintenance ??= createMaintenance());
  await m.runOnce();
}
