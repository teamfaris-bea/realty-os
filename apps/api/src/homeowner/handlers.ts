// Job handler of module 78 api/homeowner (registered in worker/handlers/index.ts, one line; R-OWN-27 pattern).
//
//   homeowner.refresh   per-tenant reconcile, woken hourly, standalone (its county lookups run outside any
//                       transaction, between bounded system transactions; refresh.ts). It acts only in the tenant's
//                       local night [02:00, 05:00) and budgets lookups per local date, so a later wake on the same date
//                       looks up only what is still due.
// Production gets providers.publicRecords: the unconfigured stand-in unless ALLOW_FAKE_PROVIDERS, or the Beaufort
// connector with PUBLIC_RECORDS_PROVIDER=county (live calls off unless PUBLIC_RECORDS_LIVE_CALLS=true). Tests inject
// a provider through `depsFor`. Logs carry counts and codes only (R-TEN-7).
import { type z } from 'zod';
import type { Providers } from '../providers/index.js';
import { jobPayload } from '../worker/payload.js';
import type { JobHandler, StandaloneJobHandler } from '../worker/types.js';
import { type HomeownerDeps, runHomeownerRefresh } from './refresh.js';
import { HOMEOWNER_REFRESH_EVERY_MS } from './settings.js';

export const HOMEOWNER_JOBS = { refresh: 'homeowner.refresh' } as const;

type DepsFor = (providers: Providers) => HomeownerDeps;
const defaultDeps: DepsFor = (providers) => ({ publicRecords: providers.publicRecords });
const Empty = jobPayload({});

export function makeHomeownerHandlers(depsFor: DepsFor = defaultDeps): JobHandler<unknown>[] {
  const refresh: StandaloneJobHandler<z.infer<typeof Empty>> = {
    kind: HOMEOWNER_JOBS.refresh,
    queue: 'default',
    mode: 'standalone',
    via: 'worker',
    schema: Empty,
    every: { ms: HOMEOWNER_REFRESH_EVERY_MS, offsetMs: 41 * 60_000 },
    periodicPayload: {},
    maxAttempts: 3,
    async run(ctx) {
      const r = await runHomeownerRefresh((fn) => ctx.withTx(fn), depsFor(ctx.providers), { tenantId: ctx.actor.tenantId, alerts: ctx.alerts, nightOnly: true });
      if (r.outcome !== 'not_night') {
        ctx.log.info('homeowner.refresh pass', {
          jobId: ctx.job.id.toString(),
          outcome: r.outcome,
          localDate: r.localDate,
          purgedExpired: r.purged.expired,
          purgedIneligible: r.purged.ineligible,
          purgedNonSubjects: r.purged.nonSubjects,
          lookups: r.lookups.made,
          matched: r.lookups.matched,
          notMatched: r.lookups.notMatched,
          notAvailable: r.lookups.notAvailable,
          ambiguous: r.lookups.ambiguous,
          failed: r.lookups.failed,
          fenced: r.lookups.fenced,
          pages: r.pages,
        });
      }
    },
  };
  return [refresh] as unknown as JobHandler<unknown>[];
}

/** Everything api/homeowner registers with the worker (CONVENTIONS §3). */
export const homeownerHandlers: JobHandler<unknown>[] = makeHomeownerHandlers();
