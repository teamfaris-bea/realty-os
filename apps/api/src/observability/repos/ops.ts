// Platform-wide operational aggregates for the metrics exporter (migration 0019 definer functions).
// Run with NO tenant and NO user context (withPreTenant), the only context those functions answer in.
// Rows are aggregates with bounded labels: no ids, no tenant ids, no addresses, no bodies.
import { type Database, withPreTenant } from '@realty/db';
import { sql } from 'kysely';

export interface QueueStat {
  queue: string;
  kind: string;
  ready: number;
  scheduled: number;
  running: number;
  retrying: number;
  dead24h: number;
  oldestReadySeconds: number;
}
export interface MessageStat {
  channel: string;
  status: string;
  count: number;
  oldestSeconds: number;
}
export interface DispatchStat {
  channel: string;
  result: string;
  reason: string;
  count: number;
}
export interface TimerStat {
  kind: string;
  fired: number;
  late60s: number;
  p50Seconds: number;
  p95Seconds: number;
  maxSeconds: number;
}
export interface FirstResponseStat {
  result: 'within_60s' | 'over_60s' | 'blocked' | 'none';
  count: number;
  p50Seconds: number;
  p95Seconds: number;
}
export interface OpsSnapshot {
  queues: QueueStat[];
  messages: MessageStat[];
  dispatch: DispatchStat[];
  timers: TimerStat[];
  firstResponse: FirstResponseStat[];
  tenantCount: number;
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

export function readOpsSnapshot(db: Database, o: { dispatchSinceMs: number; timerSinceMs: number; firstResponseSinceMs?: number }): Promise<OpsSnapshot> {
  return withPreTenant(
    async (tx) => {
      const q = await sql<Record<string, unknown>>`SELECT * FROM app.ops_queue_stats()`.execute(tx);
      const m = await sql<Record<string, unknown>>`SELECT * FROM app.ops_message_stats()`.execute(tx);
      const d = await sql<Record<string, unknown>>`SELECT * FROM app.ops_dispatch_results(now() - make_interval(secs => ${o.dispatchSinceMs / 1000}))`.execute(tx);
      const t = await sql<Record<string, unknown>>`SELECT * FROM app.ops_timer_lateness(now() - make_interval(secs => ${o.timerSinceMs / 1000}))`.execute(tx);
      const fr = await sql<Record<string, unknown>>`SELECT * FROM app.ops_first_response(now() - make_interval(secs => ${(o.firstResponseSinceMs ?? o.timerSinceMs) / 1000}))`.execute(tx);
      const n = await sql<{ n: number }>`SELECT app.ops_tenant_count() AS n`.execute(tx);
      return {
        queues: q.rows.map((r) => ({
          queue: String(r.queue),
          kind: String(r.kind),
          ready: num(r.ready),
          scheduled: num(r.scheduled),
          running: num(r.running),
          retrying: num(r.retrying),
          dead24h: num(r.dead_24h),
          oldestReadySeconds: num(r.oldest_ready_seconds),
        })),
        messages: m.rows.map((r) => ({ channel: String(r.channel), status: String(r.status), count: num(r.n), oldestSeconds: num(r.oldest_seconds) })),
        dispatch: d.rows.map((r) => ({ channel: String(r.channel), result: String(r.result), reason: String(r.reason), count: num(r.n) })),
        timers: t.rows.map((r) => ({
          kind: String(r.kind),
          fired: num(r.fired),
          late60s: num(r.late_60s),
          p50Seconds: num(r.p50_seconds),
          p95Seconds: num(r.p95_seconds),
          maxSeconds: num(r.max_seconds),
        })),
        firstResponse: fr.rows.map((r) => ({ result: String(r.result) as FirstResponseStat['result'], count: num(r.n), p50Seconds: num(r.p50_seconds), p95Seconds: num(r.p95_seconds) })),
        tenantCount: num(n.rows[0]?.n),
      };
    },
    { db },
  );
}
