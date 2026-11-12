// Job handlers of module 68 (registered in worker/handlers/index.ts by one additive line; R-OWN-27).
//
//   mail.sync   per-tenant reconcile, every 60 s, standalone (provider calls outside any transaction): revokes what
//               may no longer be live, deletes what may no longer be kept, then syncs every live link whose stored
//               next_sync_at is due (sync.ts). Revoked links that still have copies are handled in every pass.
import type { z } from 'zod';
import { commsRuntime } from '../comms/runtime.js';
import { jobPayload } from '../worker/payload.js';
import type { JobHandler, StandaloneJobHandler } from '../worker/types.js';
import { MAIL_SYNC_EVERY_MS, MAIL_SYNC_KIND, type MailSyncDeps, syncTenant } from './sync.js';

const Empty = jobPayload({});
type DepsFor = () => MailSyncDeps;
const defaultDeps: DepsFor = () => {
  const r = commsRuntime();
  return { envelope: r.envelope, ids: r.ids };
};

export function makeMailSyncHandlers(depsFor: DepsFor = defaultDeps): JobHandler<unknown>[] {
  const sync: StandaloneJobHandler<z.infer<typeof Empty>> = {
    kind: MAIL_SYNC_KIND,
    queue: 'default',
    mode: 'standalone',
    via: 'provider',
    schema: Empty,
    every: { ms: MAIL_SYNC_EVERY_MS, offsetMs: 13_000 },
    periodicPayload: {},
    maxAttempts: 3,
    async run(ctx) {
      const s = await syncTenant(ctx, depsFor());
      // counts only: never an address, a subject, a body or a token (R-GMAIL-4, -14)
      if (s.revoked + s.purged + s.synced + s.errors > 0) ctx.log.info('mail.sync', { jobId: ctx.job.id.toString(), code: `revoked:${s.revoked}:purged:${s.purged}:synced:${s.synced}:stored:${s.stored}:optouts:${s.optOuts}:handbacks:${s.handbacks}:errors:${s.errors}` });
    },
  };
  return [sync] as unknown as JobHandler<unknown>[];
}

export const mailSyncHandlers: JobHandler<unknown>[] = makeMailSyncHandlers();
