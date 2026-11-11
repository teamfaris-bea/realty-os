// feed.materialize (lane perf-misses): keeps every member's materialized Priority Feed current in the
// background, so GET /feed usually finds nothing to re-score (workspace/feed.ts header).
//
//   feed.materialize   default   standalone   { scope: 'tenant' }   periodic per tenant (registered every 60 s; each run wakes the next 15 s later)
//
// One run finds the members of its tenant with work (dirty marks, a group whose next change instant has come,
// a reconcile that is due, or no materialized state yet) and, for each, runs materializeFeed in a transaction
// of its own AS THAT MEMBER (their RLS, like GET /feed; the job never reads with the system's tenant-wide
// view). The full reconcile (at most once per RECONCILE_EVERY_MS per member) repairs any drift a missed mark
// could leave. A run stops starting new members after RUN_BUDGET_MS and continues in the next run.
import type { Instant, Role, UserActor } from '@realty/core/foundation';
import { instant, isRole } from '@realty/core/foundation';
import { type Database, type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { z } from 'zod';
import { commsRuntime } from '../comms/runtime.js';
import type { EnvelopeService } from '../crypto/envelope.js';
import { jobPayload } from '../worker/payload.js';
import type { JobHandler, StandaloneJobHandler } from '../worker/types.js';
import { type FeedDeps, type MaterializeResult, RECONCILE_KEY, materializeFeed } from './feed.js';

export const FEED_MATERIALIZE_KIND = 'feed.materialize' as const;
/** The registered period (the registry's minimum); each run wakes the next one sooner (RERUN_MS). */
export const FEED_MATERIALIZE_EVERY_MS = 60_000;
/** Each run reschedules itself this soon, so marks are picked up within about 15 s. */
export const RERUN_MS = 15_000;
/** A run starts no new member after this long (the rest wait for the next run). */
export const RUN_BUDGET_MS = 10_000;

export const MaterializePayload = jobPayload({ scope: z.literal('tenant') });
export type MaterializePayload = { scope: 'tenant' };

export interface FeedJobDeps extends FeedDeps {
  db: Database;
}

/** Members of the actor's tenant with feed work at `now` (read as the system). */
export async function membersWithFeedWork(tx: Tx, now: Instant): Promise<{ userId: string; role: string }[]> {
  const r = await sql<{ user_id: string; role: string }>`
    SELECT m.user_id, m.role FROM memberships m
     WHERE m.tenant_id = app.tenant_id() AND m.status = 'active'
       AND (EXISTS (SELECT 1 FROM feed_dirty d WHERE d.tenant_id = m.tenant_id AND d.user_id = m.user_id)
            OR EXISTS (SELECT 1 FROM feed_groups g WHERE g.tenant_id = m.tenant_id AND g.user_id = m.user_id AND g.check_at <= ${new Date(now).toISOString()}::timestamptz)
            OR NOT EXISTS (SELECT 1 FROM feed_groups g WHERE g.tenant_id = m.tenant_id AND g.user_id = m.user_id AND g.group_key = ${RECONCILE_KEY}))
     ORDER BY m.user_id`.execute(tx);
  return r.rows.map((x) => ({ userId: x.user_id, role: x.role }));
}

/** Materializes the feed of each member with work, each as that member; returns what each run did. */
export async function materializeTenant(
  tenantId: string,
  members: readonly { userId: string; role: string }[],
  deps: FeedJobDeps,
  budgetMs = RUN_BUDGET_MS,
): Promise<{ userId: string; result: MaterializeResult }[]> {
  const t0 = performance.now();
  const out: { userId: string; result: MaterializeResult }[] = [];
  for (const m of members) {
    if (performance.now() - t0 > budgetMs) break;
    if (!isRole(m.role)) continue;
    const actor: UserActor = { kind: 'user', userId: m.userId as UserActor['userId'], tenantId: tenantId as UserActor['tenantId'], role: m.role as Role, sessionId: 'feed.materialize' };
    const result = await withTenantTx(actor, (tx, now) => materializeFeed(tx, actor, deps, now, { reconcile: true }), { db: deps.db, retries: 2 });
    out.push({ userId: m.userId, result });
  }
  return out;
}

export function makeFeedHandlers(depsFor: () => FeedJobDeps = () => {
  const c = commsRuntime();
  return { db: c.db, envelope: c.envelope as EnvelopeService, ids: c.ids };
}): JobHandler<unknown>[] {
  const materialize: StandaloneJobHandler<MaterializePayload> = {
    kind: FEED_MATERIALIZE_KIND,
    queue: 'default',
    mode: 'standalone',
    via: 'worker',
    priority: 70,
    schema: MaterializePayload as unknown as z.ZodType<MaterializePayload>,
    every: { ms: FEED_MATERIALIZE_EVERY_MS },
    periodicPayload: { scope: 'tenant' },
    async run(ctx) {
      const members = await ctx.withTx((tx, now) => membersWithFeedWork(tx, now));
      const done = await materializeTenant(ctx.actor.tenantId, members, depsFor());
      ctx.log.debug('feed.materialize', { jobId: ctx.job.id.toString(), code: `${done.length}/${members.length}` });
      // keeps itself alive every 15 s (the periodic dedupe key stays with this job); sooner if work was left
      return { retryAt: instant(ctx.now + (done.length < members.length ? 1_000 : RERUN_MS)) as Instant };
    },
  };
  return [materialize as unknown as JobHandler<unknown>];
}

/** What the incremental feed registers with the worker (through workspaceHandlers). */
export const feedHandlers: JobHandler<unknown>[] = makeFeedHandlers();
