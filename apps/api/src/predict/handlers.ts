// Job handler of api/predict (registered in worker/handlers/index.ts, one line; R-OWN-27: prediction refresh is
// module 50, nightly per tenant and date).
//
//   predict.nightly   per-tenant reconcile, woken hourly, standalone (its public-record lookups run outside any
//                     transaction, between bounded system transactions; pass.ts). It acts only in the tenant's local
//                     night window and keys every write by the local date, so a later wake on the same date writes
//                     nothing and makes no lookup.
// Production gets MODEL_DEFINITIONS (empty until a counsel-reviewed model exists) and providers.publicRecords (the
// unconfigured stand-in unless ALLOW_FAKE_PROVIDERS). Tests inject a registry and a provider through `depsFor`.
import { type z } from 'zod';
import type { Providers } from '../providers/index.js';
import { jobPayload } from '../worker/payload.js';
import type { JobHandler, StandaloneJobHandler } from '../worker/types.js';
import { MODEL_DEFINITIONS } from './models.js';
import { type PredictDeps, runPredictionPass } from './pass.js';
import { PREDICT_PASS_EVERY_MS } from './settings.js';

export const PREDICT_JOBS = { nightly: 'predict.nightly' } as const;

type DepsFor = (providers: Providers) => PredictDeps;
const defaultDeps: DepsFor = (providers) => ({ publicRecords: providers.publicRecords, registry: MODEL_DEFINITIONS });
const Empty = jobPayload({});

export function makePredictHandlers(depsFor: DepsFor = defaultDeps): JobHandler<unknown>[] {
  const nightly: StandaloneJobHandler<z.infer<typeof Empty>> = {
    kind: PREDICT_JOBS.nightly,
    queue: 'default',
    mode: 'standalone',
    via: 'worker',
    schema: Empty,
    every: { ms: PREDICT_PASS_EVERY_MS, offsetMs: 17 * 60_000 },
    periodicPayload: {},
    maxAttempts: 3,
    async run(ctx) {
      const r = await runPredictionPass((fn) => ctx.withTx(fn), depsFor(ctx.providers), { tenantId: ctx.actor.tenantId, alerts: ctx.alerts, nightOnly: true });
      if (r.outcome === 'done') {
        // counts and ids only (R-TEN-7)
        ctx.log.info('predict.nightly pass', {
          jobId: ctx.job.id.toString(),
          localDate: r.localDate,
          models: r.scoringModels.length,
          invalidModels: r.invalidModels.length,
          lookups: r.lookups.made,
          attached: r.lookups.attached,
          needsReview: r.lookups.needsReview,
          notAvailable: r.lookups.notAvailable,
          lookupFailures: r.lookups.failed,
          evaluated: r.predictions.evaluated,
          written: r.predictions.written,
          cardsInserted: r.cards.inserted,
          cardsUpdated: r.cards.updated,
          cardsReopened: r.cards.reopened,
          cardsClosed: r.cards.closed,
          recordsPurged: r.purged.records,
          predictionsPurged: r.purged.predictions,
        });
      }
    },
  };
  return [nightly] as unknown as JobHandler<unknown>[];
}

/** Everything api/predict registers with the worker (CONVENTIONS §3). */
export const predictHandlers: JobHandler<unknown>[] = makePredictHandlers();
