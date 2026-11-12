// Job handlers of api/ads (module 52; registered in worker/handlers/index.ts, one line; R-OWN-27 periodic per tenant).
//
//   ads.reconcile   hourly, standalone (its provider calls run outside any transaction, between short system
//                   transactions): the mirror, the spend sync, the readback of unresolved plans, the monthly-cap
//                   overspend check (mirror.ts). Also queued at once when a cap is lowered below spend or a campaign linked.
//   ads.propose     hourly wake, standalone: on the tenant's local Monday, once per ISO week, the proposal or hold (propose.ts).
// Logs carry ids, codes and counts only (R-TEN-7): never a campaign name, an account id or a token.
import { type z } from 'zod';
import { commsRuntime } from '../comms/runtime.js';
import type { JobHandler, StandaloneJobContext, StandaloneJobHandler } from '../worker/types.js';
import { ADS_JOBS, AdsEmpty } from './jobs.js';
import { runReconcile } from './mirror.js';
import { runWeeklyProposal } from './propose.js';
import type { AdsDeps } from './runtime.js';
import { PROPOSE_EVERY_MS, RECONCILE_EVERY_MS } from './settings.js';

export { ADS_JOBS };

type DepsFor = (ctx: StandaloneJobContext) => AdsDeps;

const defaultDeps: DepsFor = (ctx) => {
  const r = commsRuntime();
  return { db: r.db, envelope: r.envelope, ids: r.ids, ads: ctx.providers.ads, now: () => ctx.now };
};

export function makeAdsHandlers(depsFor: DepsFor = defaultDeps): JobHandler<unknown>[] {
  const reconcile: StandaloneJobHandler<z.infer<typeof AdsEmpty>> = {
    kind: ADS_JOBS.reconcile,
    queue: 'default',
    mode: 'standalone',
    via: 'timer',
    schema: AdsEmpty,
    every: { ms: RECONCILE_EVERY_MS, offsetMs: 23 * 60_000 },
    periodicPayload: {},
    maxAttempts: 3,
    async run(ctx) {
      const r = await runReconcile(depsFor(ctx), ctx.actor.tenantId);
      if (r.connections.length > 0 || r.uncheckedAlerts > 0) {
        ctx.log.info('ads.reconcile pass', {
          jobId: ctx.job.id.toString(),
          cleared: r.cleared,
          connections: r.connections.length,
          outcomes: r.connections.map((c) => c.outcome),
          mirrored: r.connections.reduce((s, c) => s + c.mirrored, 0),
          capReached: r.connections.filter((c) => c.capReached).length,
          paused: r.connections.reduce((s, c) => s + (c.pause?.paused ?? 0), 0),
          plansResolved: r.connections.reduce((s, c) => s + (c.plans ? c.plans.applied + c.plans.failed : 0), 0),
          costsWritten: r.costsWritten,
          uncheckedAlerts: r.uncheckedAlerts,
        });
      }
    },
  };
  const propose: StandaloneJobHandler<z.infer<typeof AdsEmpty>> = {
    kind: ADS_JOBS.propose,
    queue: 'default',
    mode: 'standalone',
    via: 'timer',
    schema: AdsEmpty,
    every: { ms: PROPOSE_EVERY_MS, offsetMs: 41 * 60_000 },
    periodicPayload: {},
    maxAttempts: 3,
    async run(ctx) {
      const r = await runWeeklyProposal(depsFor(ctx), ctx.actor.tenantId);
      if (r.outcome === 'proposed' || r.outcome === 'held') ctx.log.info('ads.propose', { jobId: ctx.job.id.toString(), week: r.week, outcome: r.outcome, superseded: r.superseded });
    },
  };
  return [reconcile, propose] as unknown as JobHandler<unknown>[];
}

/** Everything api/ads registers with the worker (CONVENTIONS §3). */
export const adsHandlers: JobHandler<unknown>[] = makeAdsHandlers();
