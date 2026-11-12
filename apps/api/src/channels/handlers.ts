// Job handlers of module 22 (registered in worker/handlers/index.ts by one additive line).
//
//   leads.feed_poll         per-tenant reconcile handler (every 60 s): partner lead feeds through LeadFeedProvider (feedPoll.ts)
//   channels.webchat_purge  per tenant, hourly: contact-less chat sessions past purge_after are deleted (R-INBOX-5)
//                           through app.purge_webchat_sessions (0044_channels_inbox definer owned by app_retention)
import type { z } from 'zod';
import { commsRuntime } from '../comms/runtime.js';
import { jobPayload } from '../worker/payload.js';
import { HOUR_MS, type Instant, toIso } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import type { JobHandler, StandaloneJobHandler, TxJobHandler } from '../worker/types.js';
import { FEED_POLL_EVERY_MS, FEED_POLL_KIND, type FeedPollDeps, pollFeeds } from './feedPoll.js';

const Empty = jobPayload({});
type DepsFor = () => FeedPollDeps;
const defaultDeps: DepsFor = () => {
  const r = commsRuntime();
  return { envelope: r.envelope, ids: r.ids };
};

export function makeChannelHandlers(depsFor: DepsFor = defaultDeps): JobHandler<unknown>[] {
  const feedPoll: StandaloneJobHandler<z.infer<typeof Empty>> = {
    kind: FEED_POLL_KIND,
    queue: 'default',
    mode: 'standalone',
    via: 'provider',
    schema: Empty,
    every: { ms: FEED_POLL_EVERY_MS, offsetMs: 7_000 },
    periodicPayload: {},
    async run(ctx) {
      const s = await pollFeeds(ctx, depsFor());
      if (s.polled + s.markedNeedsPartnerAccess + s.errors > 0) ctx.log.info('leads.feed_poll', { jobId: ctx.job.id.toString(), code: `polled:${s.polled}:leads:${s.leads}:errors:${s.errors}` });
    },
  };
  const purge: TxJobHandler<z.infer<typeof Empty>> = {
    kind: WEBCHAT_PURGE_KIND,
    queue: 'default',
    via: 'worker',
    schema: Empty,
    every: { ms: HOUR_MS, offsetMs: 11 * 60_000 },
    periodicPayload: {},
    async run(ctx) {
      await purgeWebchatSessions(ctx.tx, ctx.now);
    },
  };
  return [feedPoll, purge] as unknown as JobHandler<unknown>[];
}

export const WEBCHAT_PURGE_KIND = 'channels.webchat_purge' as const;

export async function purgeWebchatSessions(tx: Tx, now: Instant): Promise<number> {
  const r = await sql<{ n: number }>`SELECT app.purge_webchat_sessions(${toIso(now)}::timestamptz) AS n`.execute(tx);
  return r.rows[0]?.n ?? 0;
}

export const channelHandlers: JobHandler<unknown>[] = makeChannelHandlers();
