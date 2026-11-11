// The System page's reads and job commands, in the request transaction of an Owner/Admin (RLS + the
// tenant-scoped definer functions of migration 0019). Columns are ids, codes, statuses and instants:
// never message bodies, addresses, payloads or names.
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

export interface JobRow {
  id: string;
  queue: string;
  kind: string;
  status: string;
  attempts: number;
  max_attempts: number;
  last_error: string | null;
  run_at: Date;
  created_at: Date;
  finished_at: Date | null;
}

export async function tenantJobs(tx: Tx, view: 'dead' | 'retrying', limit: number): Promise<JobRow[]> {
  return (await sql<JobRow>`SELECT * FROM app.ops_tenant_jobs(${view}, ${limit})`.execute(tx)).rows;
}

export async function tenantJobCounts(tx: Tx): Promise<{ dead: number; retrying: number }> {
  const r = (await sql<{ dead_7d: string; retrying: string }>`SELECT * FROM app.ops_tenant_job_counts()`.execute(tx)).rows[0];
  return { dead: Number(r?.dead_7d ?? 0), retrying: Number(r?.retrying ?? 0) };
}

export type RetryOutcome = 'retried' | 'not_found' | 'not_retryable' | 'duplicate_live';
export type CancelOutcome = 'cancelled' | 'not_found' | 'not_cancellable';

export async function retryJob(tx: Tx, id: string): Promise<RetryOutcome> {
  return (await sql<{ r: RetryOutcome }>`SELECT app.ops_retry_job(${id}::bigint) AS r`.execute(tx)).rows[0]!.r;
}

export async function cancelJob(tx: Tx, id: string): Promise<CancelOutcome> {
  return (await sql<{ r: CancelOutcome }>`SELECT app.ops_cancel_job(${id}::bigint) AS r`.execute(tx)).rows[0]!.r;
}

/** One job of the tenant as the System page shows it (after a command), from the definer views. */
export async function tenantJob(tx: Tx, id: string): Promise<JobRow | null> {
  for (const view of ['dead', 'retrying'] as const) {
    const r = (await sql<JobRow>`SELECT * FROM app.ops_tenant_jobs(${view}, 200) WHERE id = ${id}::bigint`.execute(tx)).rows[0];
    if (r) return r;
  }
  return null;
}

export interface StuckMessageRow {
  id: string;
  contact_id: string;
  channel: string;
  status: 'dispatching' | 'dispatch_unknown';
  status_reason: string | null;
  dispatched_at: Date | null;
  now: Date;
}

export async function stuckMessages(tx: Tx, limit: number): Promise<StuckMessageRow[]> {
  return (
    await sql<StuckMessageRow>`
      SELECT m.id, m.contact_id, m.channel, m.status, m.status_reason, m.dispatched_at, now() AS now
        FROM messages m
       WHERE m.tenant_id = app.tenant_id() AND m.direction = 'outbound' AND m.status IN ('dispatching','dispatch_unknown')
       ORDER BY m.dispatched_at NULLS FIRST, m.id
       LIMIT ${limit}`.execute(tx)
  ).rows;
}

export interface LateTimerRow {
  contact_id: string;
  type: 'offer_expired' | 'first_touch_breached' | 'auto_released';
  due_at: Date;
  fired_at: Date;
  late_seconds: number;
}

export async function lateTimers(tx: Tx, o: { windowHours: number; thresholdSeconds: number; limit: number }): Promise<{ fired: number; late: LateTimerRow[]; lateCount: number }> {
  const all = await sql<{ fired: string; late: string }>`
    SELECT count(*) AS fired, count(*) FILTER (WHERE f.fired_at - f.due_at > make_interval(secs => ${o.thresholdSeconds})) AS late
      FROM app.ops_fired_timers(now() - make_interval(hours => ${o.windowHours})) f
     WHERE f.tenant_id = app.tenant_id() AND f.due_at IS NOT NULL`.execute(tx);
  const late = await sql<LateTimerRow>`
    SELECT f.contact_id, f.type, f.due_at, f.fired_at, EXTRACT(EPOCH FROM f.fired_at - f.due_at)::float8 AS late_seconds
      FROM app.ops_fired_timers(now() - make_interval(hours => ${o.windowHours})) f
     WHERE f.tenant_id = app.tenant_id() AND f.due_at IS NOT NULL
       AND f.fired_at - f.due_at > make_interval(secs => ${o.thresholdSeconds})
     ORDER BY f.fired_at - f.due_at DESC
     LIMIT ${o.limit}`.execute(tx);
  return { fired: Number(all.rows[0]?.fired ?? 0), lateCount: Number(all.rows[0]?.late ?? 0), late: late.rows };
}

export interface ConnectionRow {
  id: string;
  kind: string;
  display_name: string;
  status: string;
  status_reason: string | null;
  last_error_code: string | null;
  last_synced_at: Date | null;
}

export async function connections(tx: Tx): Promise<ConnectionRow[]> {
  return (
    await sql<ConnectionRow>`
      SELECT c.id, c.kind, c.display_name, c.status, c.status_reason, c.last_error_code, c.last_synced_at
        FROM integration_connections c
       WHERE c.tenant_id = app.tenant_id() AND c.status <> 'not_configured'
       ORDER BY c.kind, c.display_name, c.id`.execute(tx)
  ).rows;
}

export interface RegistrationRow {
  id: string;
  kind: string;
  status: string;
  status_changed_at: Date;
}

export async function senderRegistrations(tx: Tx): Promise<RegistrationRow[]> {
  return (await sql<RegistrationRow>`SELECT r.id, r.kind, r.status, r.status_changed_at FROM sender_registrations r WHERE r.tenant_id = app.tenant_id() ORDER BY r.status_changed_at DESC, r.id`.execute(tx)).rows;
}

export interface ChannelResultRow {
  channel: string;
  sent: number;
  failed: number;
  in_flight: number;
}

/** Outbound results of the tenant's messages dispatched in the last hour, by channel (provider health). */
export async function recentChannelResults(tx: Tx): Promise<ChannelResultRow[]> {
  return (
    await sql<ChannelResultRow>`
      SELECT m.channel,
             count(*) FILTER (WHERE m.status IN ('sent','delivered'))::int AS sent,
             count(*) FILTER (WHERE m.status IN ('failed','undelivered','bounced'))::int AS failed,
             count(*) FILTER (WHERE m.status IN ('dispatching','dispatch_unknown'))::int AS in_flight
        FROM messages m
       WHERE m.tenant_id = app.tenant_id() AND m.direction = 'outbound'
         AND m.dispatched_at >= now() - interval '1 hour'
       GROUP BY m.channel ORDER BY m.channel`.execute(tx)
  ).rows;
}
