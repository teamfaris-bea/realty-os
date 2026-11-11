// The System page API (lane ops-observability). Owner and Admin only (core actions system.view /
// system.jobs); support access and every other role get 404 like any other invisible resource.
//
//   GET  /system/overview            failed and dead jobs with plain-language reasons, messages stuck in
//                                    dispatching / dispatch_unknown with their reconcile state, ownership
//                                    timers that fired late (24 h, > 60 s), provider connection health
//   POST /system/jobs/:id/retry      dead → queued again (attempts reset) | retrying → due now   audited
//   POST /system/jobs/:id/cancel     a waiting job → cancelled                                   audited
//
// What it never shows: message bodies, recipient addresses, contact names, payloads. A stuck message is
// an id, a channel, a status, instants and a link to its conversation (which the role may already open).
// Job commands are safe by construction: handlers re-check their fences and dispatch only claims
// scheduled/queued messages, so a retry never re-sends; a cancelled timer whose deadline is still due
// is re-issued by the sweeper from the stored deadline (migration 0019 header).
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { actorOf, platformOf } from '../admin/common.js';
import { audit, redactSnapshot } from '../audit.js';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import type { RouteModule } from '../routes.js';
import { withTenantTx } from '@realty/db';
import type { FastifyRequest } from 'fastify';
import type { Tx } from '@realty/db';
import type { Instant, UserActor } from '@realty/core/foundation';
import { explainJobError, kindLabel, reconcileState } from './explain.js';
import * as repo from './repos/system.js';

const TIMER_WINDOW_HOURS = 24;
const TIMER_LATE_SECONDS = 60;

const JobView = z.object({
  id: z.string(),
  kind: z.string(),
  kindLabel: z.string(),
  queue: z.string(),
  state: z.enum(['dead', 'retrying']),
  attempts: z.number().int(),
  maxAttempts: z.number().int(),
  reason: z.object({ code: z.string(), sentence: z.string(), retryHelps: z.boolean() }),
  /** the scrubbed technical error (codes, SQLSTATE; never PII), for support */
  detail: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  createdAt: z.string(),
  canRetry: z.boolean(),
  canCancel: z.boolean(),
});
type JobView = z.infer<typeof JobView>;

const StuckMessage = z.object({
  id: z.string(),
  contactId: z.string(),
  channel: z.string(),
  status: z.enum(['dispatching', 'dispatch_unknown']),
  dispatchedAt: z.string().nullable(),
  ageSeconds: z.number().int(),
  reconcile: z.object({ state: z.enum(['sending', 'awaiting_recovery', 'checking_provider', 'unresolved']), sentence: z.string(), nextStepAt: z.string().nullable() }),
});

const LateTimer = z.object({
  contactId: z.string(),
  kind: z.enum(['offer_expired', 'first_touch_breached', 'auto_released']),
  label: z.string(),
  dueAt: z.string(),
  firedAt: z.string(),
  lateSeconds: z.number().int(),
});

const Overview = z.object({
  generatedAt: z.string(),
  jobs: z.object({ counts: z.object({ dead: z.number().int(), retrying: z.number().int() }), dead: z.array(JobView), retrying: z.array(JobView) }),
  messages: z.array(StuckMessage),
  timers: z.object({ windowHours: z.number().int(), thresholdSeconds: z.number().int(), fired: z.number().int(), lateCount: z.number().int(), late: z.array(LateTimer) }),
  connections: z.array(z.object({ id: z.string(), kind: z.string(), name: z.string(), status: z.string(), statusReason: z.string().nullable(), lastErrorCode: z.string().nullable(), lastSyncedAt: z.string().nullable() })),
  registrations: z.array(z.object({ id: z.string(), kind: z.string(), status: z.string(), changedAt: z.string() })),
  channels: z.array(z.object({ channel: z.string(), sent: z.number().int(), failed: z.number().int(), inFlight: z.number().int() })),
});

const CommandResponse = z.object({ result: z.enum(['retried', 'cancelled']), job: JobView.nullable() });

const TIMER_LABELS: Record<string, string> = {
  offer_expired: 'Lead offer expired',
  first_touch_breached: 'First-touch deadline missed',
  auto_released: 'Lead auto-released to the pond',
};

const iso = (d: Date | null) => (d ? d.toISOString() : null);

function jobView(j: repo.JobRow): JobView {
  const state = j.status === 'dead' ? 'dead' : 'retrying';
  return {
    id: String(j.id),
    kind: j.kind,
    kindLabel: kindLabel(j.kind),
    queue: j.queue,
    state,
    attempts: j.attempts,
    maxAttempts: j.max_attempts,
    reason: explainJobError(j.last_error),
    detail: j.last_error ? j.last_error.slice(0, 160) : null,
    nextRunAt: state === 'retrying' ? iso(j.run_at) : null,
    finishedAt: iso(j.finished_at),
    createdAt: j.created_at.toISOString(),
    canRetry: true,
    canCancel: state === 'retrying',
  };
}

function tx<T>(req: FastifyRequest, fn: (tx: Tx, now: Instant, actor: UserActor) => Promise<T>): Promise<T> {
  const actor = actorOf(req);
  return withTenantTx(actor, (t, now) => fn(t, now, actor), { db: platformOf(req).db, retries: 2 });
}

async function register(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  const view = { config: { auth: 'system.view' as const }, preHandler: authorize('system.view', () => ({})) };
  const jobs = { config: { auth: 'system.jobs' as const }, preHandler: authorize('system.jobs', () => ({})) };
  const params = z.object({ id: z.string().regex(/^[1-9][0-9]{0,18}$/) });

  r.get('/system/overview', { ...view, schema: { response: { 200: Overview } } }, async (req) =>
    tx(req, async (t) => {
      const [counts, dead, retrying, stuck, timers, conns, regs, channels] = [
        await repo.tenantJobCounts(t),
        await repo.tenantJobs(t, 'dead', 50),
        await repo.tenantJobs(t, 'retrying', 50),
        await repo.stuckMessages(t, 50),
        await repo.lateTimers(t, { windowHours: TIMER_WINDOW_HOURS, thresholdSeconds: TIMER_LATE_SECONDS, limit: 50 }),
        await repo.connections(t),
        await repo.senderRegistrations(t),
        await repo.recentChannelResults(t),
      ];
      return {
        generatedAt: new Date().toISOString(),
        jobs: { counts, dead: dead.map(jobView), retrying: retrying.map(jobView) },
        messages: stuck.map((m) => ({
          id: m.id,
          contactId: m.contact_id,
          channel: m.channel,
          status: m.status,
          dispatchedAt: iso(m.dispatched_at),
          ageSeconds: Math.max(0, Math.round((m.now.getTime() - (m.dispatched_at ?? m.now).getTime()) / 1000)),
          reconcile: reconcileState(m.status, m.dispatched_at, m.now),
        })),
        timers: {
          windowHours: TIMER_WINDOW_HOURS,
          thresholdSeconds: TIMER_LATE_SECONDS,
          fired: timers.fired,
          lateCount: timers.lateCount,
          late: timers.late.map((x) => ({ contactId: x.contact_id, kind: x.type, label: TIMER_LABELS[x.type] ?? x.type, dueAt: x.due_at.toISOString(), firedAt: x.fired_at.toISOString(), lateSeconds: Math.round(x.late_seconds) })),
        },
        connections: conns.map((c) => ({ id: c.id, kind: c.kind, name: c.display_name, status: c.status, statusReason: c.status_reason, lastErrorCode: c.last_error_code, lastSyncedAt: iso(c.last_synced_at) })),
        registrations: regs.map((g) => ({ id: g.id, kind: g.kind, status: g.status, changedAt: g.status_changed_at.toISOString() })),
        channels: channels.map((c) => ({ channel: c.channel, sent: c.sent, failed: c.failed, inFlight: c.in_flight })),
      };
    }),
  );

  r.post('/system/jobs/:id/retry', { ...jobs, schema: { params, response: { 200: CommandResponse } } }, async (req) =>
    tx(req, async (t, _now, actor) => {
      const before = await repo.tenantJob(t, req.params.id);
      const outcome = await repo.retryJob(t, req.params.id);
      if (outcome === 'not_found' || !before) throw new AppError('NOT_FOUND');
      if (outcome === 'duplicate_live') throw new AppError('JOB_ALREADY_QUEUED');
      if (outcome === 'not_retryable') throw new AppError('JOB_NOT_RETRYABLE');
      await audit(t, actor, {
        action: 'job.retried',
        entity: { type: 'job', id: null },
        changes: redactSnapshot({ job_id: before.id, job_kind: before.kind, previous_status: before.status === 'dead' ? 'dead' : 'retrying', attempts_count: before.attempts }),
      });
      const after = await repo.tenantJob(t, req.params.id);
      return { result: 'retried' as const, job: after ? jobView(after) : null };
    }),
  );

  r.post('/system/jobs/:id/cancel', { ...jobs, schema: { params, response: { 200: CommandResponse } } }, async (req) =>
    tx(req, async (t, _now, actor) => {
      const before = await repo.tenantJob(t, req.params.id);
      const outcome = await repo.cancelJob(t, req.params.id);
      if (outcome === 'not_found' || !before) throw new AppError('NOT_FOUND');
      if (outcome === 'not_cancellable') throw new AppError('JOB_NOT_CANCELLABLE');
      await audit(t, actor, {
        action: 'job.cancelled',
        entity: { type: 'job', id: null },
        changes: redactSnapshot({ job_id: before.id, job_kind: before.kind, previous_status: 'retrying', attempts_count: before.attempts }),
      });
      return { result: 'cancelled' as const, job: null };
    }),
  );
}

export const systemRoutes: RouteModule = { name: 'system', register };
