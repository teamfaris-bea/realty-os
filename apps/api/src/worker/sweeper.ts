// The deadline sweeper (BUILD_PLAN module 9: `runSweeper(opts: { everyMs: 15_000 }): Promise<never>`).
//
// Deadlines live in data; jobs only wake the system (ARCHITECTURE §5 "Timers", §6). Every 15 s:
//   app.due_work(now, limit)                       ← cross-tenant, identifiers only
//   group by tenant; per tenant ONE withTenantTx(system actor 'timer') (R-TEN-6):
//     re-read the STORED deadline / fence of each contact (never live settings: R-OWN-15, E10, E67)
//     enqueue the job the transition would have enqueued: same kind, same fence, same dedupe key
//
// A live job with that dedupe key makes the insert a no-op (duplicates are free), so a lost job row is
// re-created and a pending one is left alone (E6). The handler re-checks its fence under lock, so a
// stale or duplicate wake is a no-op and an early one reschedules. Correctness therefore never
// depends on job delivery: every overdue deadline is processed within one sweep interval plus queue
// latency even if its job row is missing.
//
// Branches → jobs:
//   offer_expiry / first_touch_breach / auto_release / inactivity → ownership.* timers (core fences)
//   route              → ownership.followup {route} with the contact's last command id (= the decline's,
//                        so its dedupe key is the original follow-up's) — the lost-followup backstop (E5)
//   message_dispatch   → comms.dispatch          dispatch_stale → comms.dispatch_stale (worker handler)
//   dispatch_reconcile → comms.reconcile         playbook_step  → playbook.step
//   notification_delivery → notify.deliver
// Kinds with no registered handler in this build are skipped (counted, logged): enqueueing them would
// only produce dead jobs; the deadline stays in data and is picked up once the handler ships.
import type { Instant, TenantId } from '@realty/core/foundation';
import { type Database, type DueWork, type JobSpec, type Tx, dueWork, enqueueJob, followupDedupeKey, getDatabase, withTenantTx } from '@realty/db';
import {
  COMMS_DISPATCH,
  COMMS_DISPATCH_STALE,
  COMMS_RECONCILE,
  type EntityJobContract,
  NOTIFY_DELIVER,
  PLAYBOOK_STEP,
  TIMER_KIND_OF,
  TimerPayload,
  timerDedupeKey,
} from './contracts.js';
import { FollowupPayloadSchema } from './handlers/followup.js';
import { errorCode } from './loop.js';
import { type AlertSink, type Logger, type Metrics, MemoryMetrics, jsonLogger, logAlertSink } from './observability.js';
import { type HandlerRegistry, registry as defaultRegistry } from './registry.js';
import { dbClock } from './repos/jobs.js';
import { type ContactTimerRow, contactTimerRows } from './repos/sweep.js';
import { systemActor } from './systemActor.js';
import { abortableSleep } from './sleep.js';

export interface SweeperOptions {
  db?: Database;
  registry?: HandlerRegistry;
  log?: Logger;
  alerts?: AlertSink;
  metrics?: Metrics;
  /** rows per due_work branch per pass (default 500) */
  limit?: number;
  /** skip kinds without a registered handler (default true) */
  onlyRegistered?: boolean;
  /** raise SWEEPER_LATE when a pass starts this late or no pass succeeded for this long (default 60 s) */
  lateAlertMs?: number;
}

export interface SweepResult {
  at: Instant;
  due: number;
  enqueued: number;
  /** a live job already held the dedupe key */
  deduped: number;
  /** due rows whose state moved on before the re-read (nothing to wake) */
  stale: number;
  unhandled: number;
  /** due rows that could not be planned or enqueued (malformed stored data); the rest of the tenant proceeds */
  failed: number;
  tenants: number;
  failedTenants: number;
  byKind: Record<string, number>;
}

type Planned = { spec: JobSpec } | { stale: true } | { unhandled: string };


function contract<P>(c: EntityJobContract<P>, payload: P, runAt?: Instant): JobSpec {
  const parsed = c.schema.parse(payload) as JobSpec['payload'];
  return { queue: c.queue, kind: c.kind, priority: c.priority, payload: parsed, dedupeKey: c.dedupeKey(payload), ...(runAt ? { runAt } : {}) };
}

function timer(p: TimerPayload): JobSpec {
  const parsed = TimerPayload.parse(p) as JobSpec['payload'];
  return { queue: 'realtime', kind: TIMER_KIND_OF[p.deadline], priority: 20, payload: parsed, dedupeKey: timerDedupeKey(p) };
}

/** The job(s) one due row stands for, from the stored state re-read in the tenant transaction. */
export function planDue(w: DueWork, c: ContactTimerRow | undefined, now: Instant): Planned[] {
  switch (w.workKind) {
    case 'offer_expiry':
      if (!c || c.state !== 'offered' || c.offerId === null) return [{ stale: true }];
      return [{ spec: timer({ contactId: c.id, deadline: 'offer_expiry', offerId: c.offerId }) }];
    case 'first_touch_breach':
      if (!c || c.state !== 'owned' || c.periodSeq === null || c.firstTouchDueAt === null || c.firstTouchAt !== null || c.firstTouchBreachedAt !== null) return [{ stale: true }];
      return [{ spec: timer({ contactId: c.id, deadline: 'first_touch_breach', periodSeq: c.periodSeq, dueAt: c.firstTouchDueAt }) }];
    case 'auto_release':
      if (!c || c.state !== 'owned' || c.periodSeq === null || c.releaseDueAt === null || c.firstTouchAt !== null) return [{ stale: true }];
      return [{ spec: timer({ contactId: c.id, deadline: 'auto_release', periodSeq: c.periodSeq, dueAt: c.releaseDueAt }) }];
    case 'inactivity': {
      if (!c || c.state !== 'owned' || c.periodSeq === null) return [{ stale: true }];
      const out: Planned[] = [];
      if (c.inactivityWarnAt !== null && c.inactivityWarnAt <= now) {
        out.push({ spec: timer({ contactId: c.id, deadline: 'inactivity_warn', periodSeq: c.periodSeq, dueAt: c.inactivityWarnAt }) });
      }
      if (c.inactivityReleaseAt !== null && c.inactivityReleaseAt <= now) {
        out.push({ spec: timer({ contactId: c.id, deadline: 'inactivity_release', periodSeq: c.periodSeq, dueAt: c.inactivityReleaseAt }) });
      }
      return out.length > 0 ? out : [{ stale: true }];
    }
    case 'route': {
      if (!c || c.state !== 'unassigned' || c.routeDueAt === null) return [{ stale: true }];
      const payload = FollowupPayloadSchema.parse({ commandId: c.commandId, contactId: c.id, effects: [{ kind: 'route' }], fanoutNotificationIds: [] });
      return [{ spec: { queue: 'realtime', kind: 'ownership.followup', priority: 10, payload: payload as JobSpec['payload'], dedupeKey: followupDedupeKey(c.commandId) } }];
    }
    case 'message_dispatch':
      return [{ spec: contract(COMMS_DISPATCH, { messageId: w.refId }) }];
    case 'dispatch_stale':
      return [{ spec: contract(COMMS_DISPATCH_STALE, { messageId: w.refId }) }];
    case 'dispatch_reconcile':
      return [{ spec: contract(COMMS_RECONCILE, { messageId: w.refId }) }];
    case 'playbook_step':
      if (w.dueAt === null) return [{ stale: true }];
      return [{ spec: contract(PLAYBOOK_STEP, { enrollmentId: w.refId, dueAt: w.dueAt }) }];
    case 'notification_delivery':
      return [{ spec: contract(NOTIFY_DELIVER, { deliveryId: w.refId }) }];
    default:
      return [{ unhandled: w.workKind }];
  }
}

const CONTACT_BRANCHES = new Set(['offer_expiry', 'first_touch_breach', 'auto_release', 'inactivity', 'route']);

export interface Sweeper {
  /** One pass at `at` (default: the DB clock). */
  sweepOnce(at?: Instant): Promise<SweepResult>;
  /** Fixed-cadence loop; rejects with the abort reason once `signal` aborts. */
  run(opts: { everyMs: number; signal?: AbortSignal }): Promise<never>;
}

export function createSweeper(o: SweeperOptions = {}): Sweeper {
  const db = o.db ?? getDatabase();
  const reg = o.registry ?? defaultRegistry;
  const log = o.log ?? jsonLogger();
  const alerts = o.alerts ?? logAlertSink(log);
  const metrics = o.metrics ?? new MemoryMetrics();
  const limit = o.limit ?? 500;
  const onlyRegistered = o.onlyRegistered ?? true;
  const lateAlertMs = o.lateAlertMs ?? 60_000;

  async function sweepTenant(tenantId: TenantId, rows: DueWork[], now: Instant, res: SweepResult): Promise<void> {
    const actor = systemActor(tenantId, 'timer');
    const counts = await withTenantTx(
      actor,
      async (tx: Tx) => {
        const local = { enqueued: 0, deduped: 0, stale: 0, unhandled: 0, failed: 0, byKind: {} as Record<string, number> };
        const contactIds = [...new Set(rows.filter((r) => CONTACT_BRANCHES.has(r.workKind)).map((r) => r.refId))];
        const contacts = await contactTimerRows(tx, contactIds);
        for (const w of rows) {
          // one row at a time: a malformed stored value (a payload-schema failure) or a failed insert
          // (rolled back to its savepoint by enqueueJob) never blocks the tenant's other deadlines (R-OWN-15)
          let planned: Planned[];
          try {
            planned = planDue(w, contacts.get(w.refId), now);
          } catch (e) {
            local.failed++;
            metrics.inc('sweeper_failed', { workKind: w.workKind });
            log.error('due row could not be planned', { tenantId, workKind: w.workKind, refId: w.refId, error: errorCode(e) });
            continue;
          }
          for (const p of planned) {
            if ('stale' in p) {
              local.stale++;
              continue;
            }
            if ('unhandled' in p || (onlyRegistered && !reg.has(p.spec.kind))) {
              local.unhandled++;
              metrics.inc('sweeper_unhandled', { workKind: w.workKind });
              continue;
            }
            let inserted: boolean;
            try {
              inserted = await enqueueJob(tx, p.spec);
            } catch (e) {
              local.failed++;
              metrics.inc('sweeper_failed', { workKind: w.workKind });
              log.error('due row could not be enqueued', { tenantId, workKind: w.workKind, refId: w.refId, error: errorCode(e) });
              continue;
            }
            if (inserted) {
              local.enqueued++;
              local.byKind[p.spec.kind] = (local.byKind[p.spec.kind] ?? 0) + 1;
            } else local.deduped++;
          }
        }
        return local;
      },
      { db, retries: 2 },
    );
    res.enqueued += counts.enqueued;
    res.deduped += counts.deduped;
    res.stale += counts.stale;
    res.unhandled += counts.unhandled;
    res.failed += counts.failed;
    for (const [k, v] of Object.entries(counts.byKind)) res.byKind[k] = (res.byKind[k] ?? 0) + v;
  }

  async function sweepOnce(at?: Instant): Promise<SweepResult> {
    const started = performance.now();
    const now = at ?? (await dbClock(db));
    const due = await dueWork(now, limit, { db });
    const res: SweepResult = { at: now, due: due.length, enqueued: 0, deduped: 0, stale: 0, unhandled: 0, failed: 0, tenants: 0, failedTenants: 0, byKind: {} };
    const byTenant = new Map<TenantId, DueWork[]>();
    for (const w of due) {
      const list = byTenant.get(w.tenantId);
      if (list) list.push(w);
      else byTenant.set(w.tenantId, [w]);
    }
    res.tenants = byTenant.size;
    for (const [tenantId, rows] of byTenant) {
      try {
        await sweepTenant(tenantId, rows, now, res);
      } catch (e) {
        // one tenant's failure never blocks the others; its rows are still due on the next pass
        res.failedTenants++;
        const err = e as { name?: string; code?: string };
        log.error('sweep failed for a tenant', { tenantId, error: `${err.name ?? 'Error'}${err.code ? `:${err.code}` : ''}` });
      }
    }
    metrics.observe('sweeper_pass_ms', performance.now() - started);
    metrics.gauge('sweeper_due', res.due);
    metrics.inc('sweeper_enqueued', undefined, res.enqueued);
    if (res.due > 0) log.debug('sweep', { due: res.due, enqueued: res.enqueued, tenants: res.tenants, skipped: res.unhandled });
    return res;
  }

  async function run(r: { everyMs: number; signal?: AbortSignal }): Promise<never> {
    if (!Number.isFinite(r.everyMs) || r.everyMs < 100) throw new RangeError('everyMs must be ≥ 100');
    let prevStart: number | null = null;
    let lastOk = performance.now();
    let lateAlerted = false;
    const sleep = (ms: number) => abortableSleep(ms, r.signal);
    while (!r.signal?.aborted) {
      const start = performance.now();
      // lateness: how far past its scheduled start (previous start + interval) this pass begins; a
      // pass that overruns the interval makes the next one late by the overrun
      const lateness = prevStart === null ? 0 : Math.max(0, start - (prevStart + r.everyMs));
      prevStart = start;
      metrics.observe('sweeper_lateness_ms', lateness);
      try {
        await sweepOnce();
        lastOk = performance.now();
        lateAlerted = false;
      } catch (e) {
        const err = e as { name?: string; code?: string };
        log.error('sweep failed', { error: `${err.name ?? 'Error'}${err.code ? `:${err.code}` : ''}` });
      }
      const sinceOk = performance.now() - lastOk;
      if ((lateness > lateAlertMs || sinceOk > lateAlertMs) && !lateAlerted) {
        lateAlerted = true;
        alerts.raise({ severity: 'P1', code: 'SWEEPER_LATE', details: { latenessMs: Math.round(lateness), sinceLastPassMs: Math.round(sinceOk) } });
      }
      // never burst to catch up: one pass covers everything overdue
      await sleep(prevStart + r.everyMs - performance.now());
    }
    r.signal?.throwIfAborted();
    throw new Error('sweeper loop ended');
  }

  return { sweepOnce, run };
}

/** BUILD_PLAN signature: app.due_work → enqueue timer commands with fences (dedupe), every `everyMs`. */
export function runSweeper(opts: { everyMs: number; signal?: AbortSignal } & SweeperOptions): Promise<never> {
  return createSweeper(opts).run(opts);
}

