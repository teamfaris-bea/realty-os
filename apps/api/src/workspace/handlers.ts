// Job handlers of api/workspace (registered through worker/handlers/index.ts, CONVENTIONS §3).
//
//   notify.deliver   realtime  standalone  one channel delivery of a notification (sweeper contract NOTIFY_DELIVER)
//
// Standalone because a push or alert SMS goes to a provider between two transactions (claim the row,
// send, record the result); a run that dies in between leaves the row `sending`, which the next run
// treats as due after SENDING_LEASE_MS (at least once). A retry is an early wake of the same job
// ({ retryAt }), so the delivery's own backoff (1 m … 1 h, then dead) decides, not the job's.
import type { Instant } from '@realty/core/foundation';
import { commsRuntime } from '../comms/runtime.js';
import type { Providers } from '../providers/index.js';
import { type DeliveryPayload, NOTIFY_DELIVER } from '../worker/contracts.js';
import type { JobHandler, StandaloneJobHandler } from '../worker/types.js';
import { type DeliveryDeps, deliverNotification } from './notifications.js';

type DepsFor = (providers: Providers) => Omit<DeliveryDeps, 'alerts'>;
const defaultDeps: DepsFor = (providers) => ({ ...commsRuntime(), providers });

export function makeNotificationHandlers(depsFor: DepsFor = defaultDeps): JobHandler<DeliveryPayload>[] {
  const deliver: StandaloneJobHandler<DeliveryPayload> = {
    kind: NOTIFY_DELIVER.kind,
    queue: NOTIFY_DELIVER.queue,
    priority: NOTIFY_DELIVER.priority,
    mode: 'standalone',
    via: 'worker',
    schema: NOTIFY_DELIVER.schema,
    async run(ctx, p) {
      const out = await deliverNotification(p.deliveryId, { ...depsFor(ctx.providers), alerts: ctx.alerts }, ctx.actor.tenantId);
      ctx.log.debug('notify.deliver', { jobId: ctx.job.id.toString(), code: out.kind === 'retry' || out.kind === 'suppressed' || out.kind === 'dead' || out.kind === 'failed' ? out.reason : out.kind });
      if (out.kind === 'retry') return { retryAt: out.at as Instant };
    },
  };
  return [deliver];
}

/** BUILD_PLAN interface: push / SMS-to-agent (gated) / email delivery handlers. */
export const notificationHandlers: JobHandler<DeliveryPayload>[] = makeNotificationHandlers();
/** What api/workspace registers with the worker (CONVENTIONS §3). */
export const workspaceHandlers: JobHandler<unknown>[] = notificationHandlers as unknown as JobHandler<unknown>[];
