// Postgres job queue (ARCHITECTURE §6; R-TEN-6, R-TEN-7).
//
// - enqueue: INSERT in the caller's transaction (transactional outbox by construction). The tenant
//   comes from the transaction's context (app.tenant_id()), never from the job spec. app_user can
//   INSERT jobs but cannot read them; a live job with the same dedupe key makes the insert a no-op
//   (unique violation caught in a savepoint).
// - claim / finish / reap / dueWork: the SECURITY DEFINER functions app.claim_jobs (FOR UPDATE SKIP
//   LOCKED), app.finish_job, app.reap_stuck_jobs and app.due_work, called WITHOUT tenant context.
//   Each claimed job then runs in its own withTenantTx({kind:'system', tenantId: job.tenantId}).
// - cancel: app.cancel_jobs in the current tenant only.
import type { Instant, TenantId } from '@realty/core/foundation';
import { instantFromDate, toIso } from '@realty/core/foundation';
import { sql } from 'kysely';
import { type Database, getDatabase } from './client.js';
import type { JsonValue } from './schema.js';
import { insertUnlessDuplicate } from './savepoint.js';
import { type Tx, withNoContext } from './tenantTx.js';

export const QUEUES = ['realtime', 'default', 'bulk', 'maintenance'] as const;
export type Queue = (typeof QUEUES)[number];

export const JOB_KIND_RE = /^[a-z_]+\.[a-z_]+$/;

export interface JobSpec {
  queue: Queue;
  /** `area.verb` (DB CHECK ^[a-z_]+\.[a-z_]+$) */
  kind: string;
  /** ids, codes, fences and instants only: never names, phones, emails or bodies (R-TEN-7) */
  payload: { [k: string]: JsonValue };
  /** default: now */
  runAt?: Instant;
  /** lower runs first (0..1000, default 100) */
  priority?: number;
  /** unique per tenant while the job is pending or running */
  dedupeKey?: string;
  maxAttempts?: number;
}

export interface ClaimedJob {
  id: bigint;
  /** null only for platform maintenance jobs */
  tenantId: TenantId | null;
  queue: Queue;
  kind: string;
  payload: { [k: string]: JsonValue };
  attempts: number;
}

export type FinishResult = { ok: true } | { ok: false; error: string; retryAt?: Instant };

export class JobPayloadError extends TypeError {
  override readonly name = 'JobPayloadError';
}

const EMAIL_RE = /[^\s@"'<>]+@[^\s@"'<>]+\.[a-z]{2,}/i;
// E.164 ('+15555550100') or a formatted national number ('(555) 555-0100', '555-555-0100'). Bare digit
// runs are allowed: epoch-ms instants inside dedupe keys are digits too.
const PHONE_RE = /\+[1-9][0-9]{6,14}(?![0-9])|\(?\b[0-9]{3}\)?[ .-][0-9]{3}[ .-][0-9]{4}\b/;

/**
 * Defence in depth for R-TEN-7 (the per-kind Zod schemas of api/jobs-worker are the primary
 * control): a payload string that looks like an email address or a phone number is rejected.
 * UUIDs, ISO timestamps, dedupe keys and epoch-ms numbers pass.
 */
export function assertNoPiiInPayload(v: JsonValue, path = 'payload'): void {
  if (typeof v === 'string') {
    if (EMAIL_RE.test(v) || PHONE_RE.test(v)) throw new JobPayloadError(`${path} looks like contact PII (R-TEN-7)`);
    return;
  }
  if (Array.isArray(v)) {
    v.forEach((x, i) => assertNoPiiInPayload(x, `${path}[${i}]`));
    return;
  }
  if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      // keys are payload content too: `{ "jane@example.com": … }` carries the address as much as a value does
      if (EMAIL_RE.test(k) || PHONE_RE.test(k)) throw new JobPayloadError(`${path} has a key that looks like contact PII (R-TEN-7)`);
      assertNoPiiInPayload(x, `${path}.${k}`);
    }
  }
}

/** Masks emails / phone numbers in an error string and caps it at 500 chars (jobs.last_error CHECK). */
export function scrubError(s: string): string {
  return s
    .replace(/[^\s@"'<>]+@[^\s@"'<>]+/g, '[email]')
    .replace(/\+?[0-9][0-9 ().-]{8,}[0-9]/g, '[number]')
    .slice(0, 500);
}

/** Enqueue in the caller's transaction. Returns false when a live job with the dedupe key exists. */
export async function enqueue(tx: Tx, j: JobSpec): Promise<boolean> {
  checkSpec(j);
  const runAt = j.runAt === undefined ? null : toIso(j.runAt);
  const insert = sql`
    INSERT INTO jobs (tenant_id, queue, kind, payload, priority, run_at, dedupe_key, max_attempts)
    VALUES (app.tenant_id(), ${j.queue}, ${j.kind}, ${JSON.stringify(j.payload)}::jsonb, ${j.priority ?? 100},
            COALESCE(${runAt}::timestamptz, clock_timestamp()), ${j.dedupeKey ?? null}, ${j.maxAttempts ?? 10})`;
  if (j.dedupeKey === undefined) {
    await insert.execute(tx);
    return true;
  }
  // app_user has INSERT but no SELECT on jobs, so ON CONFLICT (which needs SELECT on the arbiter
  // columns) is not available: a duplicate live dedupe key is caught inside a savepoint instead.
  return insertUnlessDuplicate(tx, insert, 'jobs_dedupe_uq');
}

function checkSpec(j: JobSpec): void {
  if (!(QUEUES as readonly string[]).includes(j.queue)) throw new TypeError(`unknown queue ${j.queue}`);
  if (!JOB_KIND_RE.test(j.kind)) throw new TypeError(`job kind must match area.verb: ${j.kind}`);
  assertNoPiiInPayload(j.payload);
}

/**
 * Several enqueues in one round trip (lane perf-misses: an accept/claim enqueues four timers). The
 * outcome is exactly that of `enqueue` called for each spec in order: one multi-row INSERT inside a
 * savepoint; when a live dedupe key makes it fail, the savepoint is rolled back and the specs are
 * enqueued one by one (each skipped only if its own key is live). Rows get job ids in spec order.
 */
export async function enqueueAll(tx: Tx, js: readonly JobSpec[]): Promise<void> {
  if (js.length === 0) return;
  if (js.length === 1) {
    await enqueue(tx, js[0]!);
    return;
  }
  for (const j of js) checkSpec(j);
  const rows = js.map(
    (j) => sql`(app.tenant_id(), ${j.queue}, ${j.kind}, ${JSON.stringify(j.payload)}::jsonb, ${j.priority ?? 100},
                COALESCE(${j.runAt === undefined ? null : toIso(j.runAt)}::timestamptz, clock_timestamp()), ${j.dedupeKey ?? null}, ${j.maxAttempts ?? 10})`,
  );
  const insert = sql`INSERT INTO jobs (tenant_id, queue, kind, payload, priority, run_at, dedupe_key, max_attempts) VALUES ${sql.join(rows)}`;
  if (js.every((j) => j.dedupeKey === undefined)) {
    await insert.execute(tx);
    return;
  }
  if (await insertUnlessDuplicate(tx, insert, 'jobs_dedupe_uq')) return;
  for (const j of js) await enqueue(tx, j);
}

/** Cancels pending jobs with these dedupe keys in the current tenant. */
export async function cancel(tx: Tx, keys: readonly string[]): Promise<number> {
  if (keys.length === 0) return 0;
  const r = await sql<{ n: number }>`SELECT app.cancel_jobs(${[...keys]}::text[]) AS n`.execute(tx);
  return r.rows[0]?.n ?? 0;
}

const MAX_LEASE_SECONDS = 15 * 60;

export async function claim(queues: readonly Queue[], worker: string, n: number, opts: { leaseSeconds?: number; db?: Database } = {}): Promise<ClaimedJob[]> {
  const lease = Math.min(Math.max(opts.leaseSeconds ?? 300, 1), MAX_LEASE_SECONDS);
  return withNoContext(opts.db ?? getDatabase(), async (tx) => {
    const r = await sql<{ id: string; tenant_id: string | null; queue: Queue; kind: string; payload: { [k: string]: JsonValue }; attempts: number }>`
      SELECT * FROM app.claim_jobs(${[...queues]}::text[], ${worker}, ${n}, make_interval(secs => ${lease}))`.execute(tx);
    return r.rows.map((x) => ({
      id: BigInt(x.id),
      tenantId: x.tenant_id as TenantId | null,
      queue: x.queue,
      kind: x.kind,
      payload: x.payload,
      attempts: x.attempts,
    }));
  });
}

export async function finish(id: bigint, worker: string, r: FinishResult, opts: { db?: Database } = {}): Promise<void> {
  await withNoContext(opts.db ?? getDatabase(), async (tx) => {
    const error = r.ok ? null : scrubError(r.error);
    const retryAt = !r.ok && r.retryAt !== undefined ? toIso(r.retryAt) : null;
    await sql`SELECT app.finish_job(${id.toString()}::bigint, ${worker}, ${r.ok}, ${error}, ${retryAt}::timestamptz)`.execute(tx);
  });
}

/** Expired leases back to pending (or dead when attempts are exhausted). */
export async function reap(opts: { db?: Database } = {}): Promise<number> {
  return withNoContext(opts.db ?? getDatabase(), async (tx) => {
    const r = await sql<{ n: number }>`SELECT app.reap_stuck_jobs() AS n`.execute(tx);
    return r.rows[0]?.n ?? 0;
  });
}

export interface DueWork {
  tenantId: TenantId;
  workKind: string;
  refId: string;
  dueAt: Instant | null;
}

/** The sweeper's view of overdue deadlines across tenants (identifiers only). */
export async function dueWork(now: Instant, limit: number, opts: { db?: Database } = {}): Promise<DueWork[]> {
  return withNoContext(opts.db ?? getDatabase(), async (tx) => {
    const r = await sql<{ tenant_id: string; work_kind: string; ref_id: string; due_at: Date | null }>`
      SELECT * FROM app.due_work(${toIso(now)}::timestamptz, ${limit})`.execute(tx);
    return r.rows.map((x) => ({
      tenantId: x.tenant_id as TenantId,
      workKind: x.work_kind,
      refId: x.ref_id,
      dueAt: x.due_at ? instantFromDate(x.due_at) : null,
    }));
  });
}

export const jobs = { enqueue, cancel, claim, finish, reap, dueWork };
