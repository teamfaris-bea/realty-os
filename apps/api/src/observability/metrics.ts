// The Realty OS metric families (docs/OPERATIONS.md "Metrics"): HTTP, process, database pool, worker
// jobs and sweeper, and the database-derived operational view (queues, stuck messages, dispatch
// results, ownership timer lateness, tenant count bucket).
//
//   const registry = new Registry();
//   instrumentHttp(app, registry)          // API: requests, latency, errors by route TEMPLATE
//   instrumentPool(registry, db, 'api')    // pool usage at scrape time
//   new PrometheusWorkerMetrics(registry)  // worker: implements the worker's Metrics interface
//   collectOperational(registry, db)       // worker: database aggregates (definer functions, 0019)
//
// Labels never carry ids, tenant names or PII (prometheus.ts enforces the allowlist and bounds values).
import type { Database } from '@realty/db';
import type { FastifyInstance } from 'fastify';
import type { Metrics } from '../worker/observability.js';
import type { Gauge, Histogram, Registry } from './prometheus.js';
import { type OpsSnapshot, readOpsSnapshot } from './repos/ops.js';

// ---- process -----------------------------------------------------------------------------------------

export function instrumentProcess(registry: Registry, o: { process: 'api' | 'worker'; release: string }): void {
  const info = registry.gauge('realty_build_info', 'Build and process information (value is always 1).');
  info.set(1, { release: o.release, process: o.process });
  const up = registry.gauge('realty_process_uptime_seconds', 'Seconds since this process started.');
  const rss = registry.gauge('realty_process_resident_memory_bytes', 'Resident memory of this process.');
  const heap = registry.gauge('realty_process_heap_used_bytes', 'V8 heap in use.');
  const started = performance.now();
  registry.onCollect(() => {
    up.set((performance.now() - started) / 1000, { process: o.process });
    const m = process.memoryUsage();
    rss.set(m.rss, { process: o.process });
    heap.set(m.heapUsed, { process: o.process });
  });
}

// ---- HTTP (API) ------------------------------------------------------------------------------------------

declare module 'fastify' {
  interface FastifyRequest {
    /** the error code the error handler answered with (server.ts sendError), for metrics */
    errorCode?: string;
  }
}

const statusClass = (s: number) => `${Math.floor(s / 100)}xx`;

/**
 * Request count, latency and errors by method and route TEMPLATE (`/api/contacts/:contactId`, never the
 * raw URL). Unmatched paths are one series ("unmatched"), so probing random URLs cannot add series.
 */
export function instrumentHttp(app: FastifyInstance, registry: Registry): void {
  const requests = registry.counter('realty_http_requests_total', 'HTTP requests by method, route template and status class.');
  const duration = registry.histogram('realty_http_request_duration_seconds', 'HTTP request latency by method and route template.');
  const errors = registry.counter('realty_http_errors_total', 'HTTP error responses (4xx/5xx) by route template and error code.');
  app.addHook('onResponse', async (req, reply) => {
    const route = req.routeOptions?.url ?? 'unmatched';
    const method = req.method;
    const status = reply.statusCode;
    requests.inc({ method, route, status_class: statusClass(status) });
    duration.observe(reply.elapsedTime / 1000, { method, route });
    if (status >= 400) errors.inc({ route, status_class: statusClass(status), code: req.errorCode ?? 'UNKNOWN' });
  });
}

// ---- database pool -------------------------------------------------------------------------------------

export function instrumentPool(registry: Registry, db: Database, proc: 'api' | 'worker'): void {
  const g = registry.gauge('realty_db_pool_connections', 'Database pool connections by state (total, idle, waiting clients).');
  const max = registry.gauge('realty_db_pool_max', 'Configured maximum pool size.');
  registry.onCollect(() => {
    const p = db.pool;
    g.set(p.totalCount, { state: 'total', process: proc });
    g.set(p.idleCount, { state: 'idle', process: proc });
    g.set(p.totalCount - p.idleCount, { state: 'in_use', process: proc });
    g.set(p.waitingCount, { state: 'waiting', process: proc });
    max.set((p as unknown as { options?: { max?: number } }).options?.max ?? 0, { process: proc });
  });
}

// ---- worker (adapts the worker's Metrics interface) --------------------------------------------------------

const LATENCY_BUCKETS = [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];

/** Known worker metric names → exported family (and whether the value is milliseconds). */
const WORKER_FAMILIES: Record<string, { name: string; help: string; type: 'counter' | 'gauge' | 'histogram'; ms?: boolean; labels?: Record<string, string> }> = {
  job_outcome: { name: 'realty_jobs_total', help: 'Jobs run by kind and outcome (succeeded, rescheduled, retry, dead, no_handler, finish_failed, lease_lost).', type: 'counter' },
  job_run_ms: { name: 'realty_job_duration_seconds', help: 'Job handler run time by kind.', type: 'histogram', ms: true },
  jobs_dead: { name: 'realty_jobs_dead_total', help: 'Jobs that went dead (alerted), by kind and queue.', type: 'counter' },
  jobs_reaped: { name: 'realty_jobs_reaped_total', help: 'Expired job leases returned to the queue by the reaper (crashed or stalled workers).', type: 'counter' },
  sweeper_pass_ms: { name: 'realty_sweeper_pass_duration_seconds', help: 'Time one deadline sweep takes.', type: 'histogram', ms: true },
  sweeper_lateness_ms: { name: 'realty_sweeper_lateness_seconds', help: 'How late a sweep pass started compared with its schedule.', type: 'histogram', ms: true },
  sweeper_due: { name: 'realty_sweeper_due', help: 'Due deadlines found by the last sweep.', type: 'gauge' },
  sweeper_enqueued: { name: 'realty_sweeper_enqueued_total', help: 'Jobs enqueued by the sweeper for overdue deadlines.', type: 'counter' },
  sweeper_failed: { name: 'realty_sweeper_failed_total', help: 'Due rows the sweeper could not plan or enqueue, by work kind.', type: 'counter' },
  sweeper_unhandled: { name: 'realty_sweeper_unhandled_total', help: 'Due rows whose job kind has no handler in this build, by work kind.', type: 'counter' },
  audit_seq_missing: { name: 'realty_audit_seq_missing', help: 'Gaps in the global audit sequence (rolled-back transactions; tracked, growth logged).', type: 'gauge' },
  audit_seq_rows: { name: 'realty_audit_seq_rows', help: 'Rows checked by the audit sequence check.', type: 'gauge' },
  retention_last: { name: 'realty_retention_last_items', help: 'Items removed by the last retention sweep, by item.', type: 'gauge' },
};

const LABEL_RENAME: Record<string, string> = { workKind: 'work_kind' };

function renameLabels(labels?: Record<string, string>): Record<string, string> | undefined {
  if (!labels) return undefined;
  return Object.fromEntries(Object.entries(labels).map(([k, v]) => [LABEL_RENAME[k] ?? k, v]));
}

/** The worker's Metrics interface on a Prometheus registry. Unknown names export as realty_worker_<name>. */
export class PrometheusWorkerMetrics implements Metrics {
  constructor(readonly registry: Registry) {}
  private family(name: string, type: 'counter' | 'gauge' | 'histogram') {
    const known = WORKER_FAMILIES[name];
    const ms = known?.ms ?? name.endsWith('_ms');
    const exported = known?.name ?? `realty_worker_${name.replace(/_ms$/, '_seconds')}${type === 'counter' ? '_total' : ''}`;
    const help = known?.help ?? `Worker metric ${name}.`;
    if (type === 'counter') return { f: this.registry.counter(exported, help), ms };
    if (type === 'gauge') return { f: this.registry.gauge(exported, help), ms };
    return { f: this.registry.histogram(exported, help, LATENCY_BUCKETS), ms };
  }
  inc(name: string, labels?: Record<string, string>, by = 1): void {
    (this.family(name, 'counter').f as ReturnType<Registry['counter']>).inc(renameLabels(labels), by);
  }
  gauge(name: string, value: number, labels?: Record<string, string>): void {
    const { f, ms } = this.family(name, 'gauge');
    (f as Gauge).set(ms ? value / 1000 : value, renameLabels(labels));
  }
  observe(name: string, value: number, labels?: Record<string, string>): void {
    const { f, ms } = this.family(name, 'histogram');
    (f as Histogram).observe(ms ? value / 1000 : value, renameLabels(labels));
  }
}

/** Fan-out: the worker keeps its in-memory metrics (tests, maintenance reports) and exports them too. */
export function teeMetrics(...sinks: Metrics[]): Metrics {
  return {
    inc: (n, l, by) => sinks.forEach((s) => s.inc(n, l, by)),
    gauge: (n, v, l) => sinks.forEach((s) => s.gauge(n, v, l)),
    observe: (n, v, l) => sinks.forEach((s) => s.observe(n, v, l)),
  };
}

// ---- operational view from the database (definer aggregates, migration 0019) ----------------------------

/** Tenant count as a coarse bucket (the only tenant information a metric may carry). */
export function tenantBucket(n: number): string {
  if (n <= 0) return '0';
  if (n <= 10) return '1-10';
  if (n <= 100) return '11-100';
  if (n <= 1000) return '101-1000';
  return '1000+';
}

export interface OperationalOptions {
  /** minimum time between database reads; scrapes in between reuse the last snapshot (default 15 s) */
  minIntervalMs?: number;
  /** dispatch results window (default 15 min) */
  dispatchWindowMs?: number;
  /** timer lateness window (default 1 h) */
  timerWindowMs?: number;
  now?: () => number;
}

/**
 * Registers the database-derived gauges and refreshes them at scrape time (at most every
 * `minIntervalMs`). A failed read keeps the previous values and sets realty_ops_collect_ok to 0.
 */
export function collectOperational(registry: Registry, db: Database, o: OperationalOptions = {}): { refresh(): Promise<OpsSnapshot | null> } {
  const minInterval = o.minIntervalMs ?? 15_000;
  const dispatchWindow = o.dispatchWindowMs ?? 15 * 60_000;
  const timerWindow = o.timerWindowMs ?? 60 * 60_000;
  const now = o.now ?? (() => Date.now());

  const jobs = registry.gauge('realty_queue_jobs', 'Jobs in the queue by queue, kind and state (ready = due and waiting, scheduled, running, retrying = waiting after a failure).');
  const dead = registry.gauge('realty_queue_dead_jobs_24h', 'Jobs that went dead in the last 24 hours, by queue and kind.');
  const lag = registry.gauge('realty_queue_lag_seconds', 'Age of the oldest due job still waiting, by queue (pickup lag).');
  const lagKind = registry.gauge('realty_queue_oldest_ready_seconds', 'Age of the oldest due job still waiting, by queue and kind.');
  const stuck = registry.gauge('realty_messages_stuck', 'Outbound messages in dispatching / dispatch_unknown, or scheduled/queued and overdue by over a minute, by channel and status.');
  const stuckAge = registry.gauge('realty_messages_stuck_oldest_seconds', 'Age of the oldest such message, by channel and status.');
  const dispatch = registry.gauge('realty_dispatch_results_window', 'Outbound results in the last dispatch window by channel, result (sent, failed, blocked, in_flight) and reason (provider error code or block reason).');
  const dispatchWin = registry.gauge('realty_dispatch_window_seconds', 'Length of the dispatch results window.');
  const fired = registry.gauge('realty_timer_fired_window', 'Ownership timers (offer expiry, first-touch SLA, auto-release) that fired in the timer window, by kind.');
  const late = registry.gauge('realty_timer_late_window', 'Of those, the ones that fired more than 60 s after they were due, by kind.');
  const lateness = registry.gauge('realty_timer_lateness_seconds', 'Timer lateness over the timer window by kind and quantile (0.5, 0.95, 1 = max).');
  const timerWin = registry.gauge('realty_timer_window_seconds', 'Length of the timer lateness window.');
  const tenants = registry.gauge('realty_tenants', 'Active tenants as a coarse bucket (value 1 on the current bucket).');
  const ok = registry.gauge('realty_ops_collect_ok', '1 when the last database read of the operational view succeeded, else 0.');
  const age = registry.gauge('realty_ops_collect_age_seconds', 'Age of the operational snapshot being exported.');
  const failures = registry.counter('realty_ops_collect_failures_total', 'Failed database reads of the operational view.');

  let last: { at: number; snap: OpsSnapshot } | null = null;
  let inflight: Promise<OpsSnapshot | null> | null = null;

  function apply(s: OpsSnapshot): void {
    for (const g of [jobs, dead, lag, lagKind, stuck, stuckAge, dispatch, fired, late, lateness, tenants]) g.reset();
    const byQueue = new Map<string, number>();
    for (const q of s.queues) {
      jobs.set(q.ready, { queue: q.queue, kind: q.kind, state: 'ready' });
      jobs.set(q.scheduled, { queue: q.queue, kind: q.kind, state: 'scheduled' });
      jobs.set(q.running, { queue: q.queue, kind: q.kind, state: 'running' });
      jobs.set(q.retrying, { queue: q.queue, kind: q.kind, state: 'retrying' });
      dead.set(q.dead24h, { queue: q.queue, kind: q.kind });
      lagKind.set(q.oldestReadySeconds, { queue: q.queue, kind: q.kind });
      byQueue.set(q.queue, Math.max(byQueue.get(q.queue) ?? 0, q.oldestReadySeconds));
    }
    for (const queue of ['realtime', 'default', 'bulk', 'maintenance']) lag.set(byQueue.get(queue) ?? 0, { queue });
    for (const m of s.messages) {
      stuck.set(m.count, { channel: m.channel, status: m.status });
      stuckAge.set(m.oldestSeconds, { channel: m.channel, status: m.status });
    }
    for (const d of s.dispatch) dispatch.set(d.count, { channel: d.channel, result: d.result, reason: d.reason });
    dispatchWin.set(dispatchWindow / 1000);
    for (const kind of ['offer_expired', 'first_touch_breached', 'auto_released']) {
      const t = s.timers.find((x) => x.kind === kind);
      fired.set(t?.fired ?? 0, { kind });
      late.set(t?.late60s ?? 0, { kind });
      lateness.set(t?.p50Seconds ?? 0, { kind, quantile: '0.5' });
      lateness.set(t?.p95Seconds ?? 0, { kind, quantile: '0.95' });
      lateness.set(t?.maxSeconds ?? 0, { kind, quantile: '1' });
    }
    timerWin.set(timerWindow / 1000);
    tenants.set(1, { bucket: tenantBucket(s.tenantCount) });
  }

  async function refresh(): Promise<OpsSnapshot | null> {
    if (inflight) return inflight;
    inflight = (async () => {
      try {
        const snap = await readOpsSnapshot(db, { dispatchSinceMs: dispatchWindow, timerSinceMs: timerWindow });
        last = { at: now(), snap };
        apply(snap);
        ok.set(1);
        return snap;
      } catch {
        failures.inc();
        ok.set(0);
        return null;
      } finally {
        inflight = null;
      }
    })();
    return inflight;
  }

  registry.onCollect(async () => {
    if (!last || now() - last.at >= minInterval) await refresh();
    age.set(last ? Math.max(0, (now() - last.at) / 1000) : 0);
  });
  return { refresh };
}

