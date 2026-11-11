// Job handlers of api/imports (registered through worker/handlers/index.ts), all on the `bulk` queue:
//   imports.snapshot  read FUB once (or take the uploaded file) into an encrypted, hashed snapshot
//   imports.dry_run   one stage's dry run, in one transaction
//   imports.commit    ≤ 1,000 records per transaction, resumable; yields after CHUNKS_PER_RUN chunks
//   imports.revert    reverting stages, latest first, in chunks
// Standalone mode: each step manages its own transactions (the commit must commit between chunks).
// Payloads carry ids only (R-TEN-7). The verification recount is computed on request (GET …/verification
// and POST …/verify) from the stored records, so it needs no job.
import { getDatabase, defaultIds } from '@realty/db';
import { type Config, loadConfig } from '../config.js';
import { EnvelopeService } from '../crypto/envelope.js';
import { localKek } from '../crypto/kek.js';
import type { Providers } from '../providers/index.js';
import { jobPayload, zId } from '../worker/payload.js';
import type { JobHandler, StandaloneJobHandler } from '../worker/types.js';
import { SNAPSHOT_JOB, takeSnapshot } from './batches.js';
import { COMMIT_JOB, runCommit } from './commit.js';
import { FakeFub, type FubConnector, httpFubConnector } from './fub.js';
import { REVERT_JOB, runRevert } from './revert.js';
import { DRY_RUN_JOB, runDryRun } from './stages.js';
import type { ImportDeps } from './types.js';

export const BatchPayload = jobPayload({ batchId: zId });
export const StagePayload = jobPayload({ stageId: zId });
export type BatchPayload = { batchId: string };
export type StagePayload = { stageId: string };

/**
 * FUB_PROVIDER=real uses the HTTP adapter (VERIFY against a live account, incl. the tasks and appointments count
 * endpoints, FUB_TASKS_PATH / FUB_APPOINTMENTS_PATH); anything else the fake.
 * The settings come from the process Config only (config.ts `fub`, never tenant input or process.env here):
 * FUB_BASE_URL must name a host in FUB_ALLOWED_HOSTS (default api.followupboss.com). loadConfig checks that
 * at startup and the adapter re-checks it when built (FubConfigError).
 */
export function defaultFubConnector(fub: Config['fub']): FubConnector {
  if (fub.provider === 'real') {
    return httpFubConnector({ baseUrl: fub.baseUrl, allowedHosts: fub.allowedHosts, ...(fub.system ? { system: fub.system } : {}), ...(fub.countOnlyPaths ? { countOnlyPaths: fub.countOnlyPaths } : {}) });
  }
  return new FakeFub().connector;
}

type DepsFor = (providers: Providers) => ImportDeps;

let runtime: Omit<ImportDeps, 'storage'> | null = null;
const defaultDeps: DepsFor = (providers) => {
  if (!runtime) {
    const cfg = loadConfig();
    runtime = { db: getDatabase(), envelope: new EnvelopeService(localKek(cfg.kek, cfg.kekRef)), ids: defaultIds(), fub: defaultFubConnector(cfg.fub) };
  }
  return { ...runtime, storage: providers.storage };
};

export function makeImportHandlers(depsFor: DepsFor = defaultDeps): JobHandler<unknown>[] {
  const snapshot: StandaloneJobHandler<BatchPayload> = {
    kind: SNAPSHOT_JOB.kind,
    queue: SNAPSHOT_JOB.queue,
    mode: 'standalone',
    via: 'import',
    maxAttempts: 3,
    schema: BatchPayload,
    async run(ctx, p) {
      const r = await takeSnapshot(depsFor(ctx.providers), ctx.actor.tenantId, p.batchId);
      ctx.log.info('import snapshot', { kind: SNAPSHOT_JOB.kind, jobId: ctx.job.id.toString(), code: r });
    },
  };
  const dry: StandaloneJobHandler<StagePayload> = {
    kind: DRY_RUN_JOB.kind,
    queue: DRY_RUN_JOB.queue,
    mode: 'standalone',
    via: 'import',
    maxAttempts: 3,
    schema: StagePayload,
    async run(ctx, p) {
      const r = await runDryRun(depsFor(ctx.providers), ctx.actor.tenantId, p.stageId);
      ctx.log.info('import dry run', { kind: DRY_RUN_JOB.kind, jobId: ctx.job.id.toString(), code: r });
    },
  };
  const commit: StandaloneJobHandler<StagePayload> = {
    kind: COMMIT_JOB.kind,
    queue: COMMIT_JOB.queue,
    mode: 'standalone',
    via: 'import',
    schema: StagePayload,
    async run(ctx, p) {
      const r = await runCommit(depsFor(ctx.providers), ctx.actor.tenantId, p.stageId);
      ctx.log.info('import commit', { kind: COMMIT_JOB.kind, jobId: ctx.job.id.toString(), code: r });
      if (r === 'more') return { retryAt: ctx.now };
    },
  };
  const revert: StandaloneJobHandler<BatchPayload> = {
    kind: REVERT_JOB.kind,
    queue: REVERT_JOB.queue,
    mode: 'standalone',
    via: 'worker',
    schema: BatchPayload,
    async run(ctx, p) {
      const r = await runRevert(depsFor(ctx.providers), ctx.actor.tenantId, p.batchId);
      ctx.log.info('import revert', { kind: REVERT_JOB.kind, jobId: ctx.job.id.toString(), code: r });
      if (r === 'more') return { retryAt: ctx.now };
    },
  };
  return [snapshot, dry, commit, revert] as JobHandler<unknown>[];
}

export const importHandlers: JobHandler<unknown>[] = makeImportHandlers();
