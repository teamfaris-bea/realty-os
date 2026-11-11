// Job handlers of module 22 (registered in worker/handlers/index.ts by one additive line).
//
//   leads.feed_poll   per-tenant reconcile handler (every 60 s): partner lead feeds through LeadFeedProvider (feedPoll.ts)
import type { z } from 'zod';
import { commsRuntime } from '../comms/runtime.js';
import { jobPayload } from '../worker/payload.js';
import type { JobHandler, StandaloneJobHandler } from '../worker/types.js';
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
  return [feedPoll] as unknown as JobHandler<unknown>[];
}

export const channelHandlers: JobHandler<unknown>[] = makeChannelHandlers();
