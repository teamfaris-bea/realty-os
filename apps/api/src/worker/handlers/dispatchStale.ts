// comms.dispatch_stale (sweeper only; ARCHITECTURE §6, §9; R-GATE-8; E7; Design Review F2).
//
// A message still `dispatching` 20 minutes after TX1 stamped dispatched_at (maximum job lease 15 min
// + 5 min margin) means the dispatching worker died between TX1 and TX2, before or after
// provider.send. Nobody knows whether the provider accepted it, so it is NEVER re-sent: it moves to
// `dispatch_unknown` and a `comms.reconcile` job (api/comms) looks the submit up by its idempotency
// key; the sweeper's `dispatch_reconcile` branch backstops a lost reconcile job.
// Lock order (ARCHITECTURE §10): app.lock_contact first, like dispatch TX1/TX2.
import { plusMs } from '@realty/core/foundation';
import { lockContact } from '@realty/db';
import { COMMS_DISPATCH_STALE, COMMS_RECONCILE, type MessagePayload } from '../contracts.js';
import { enqueueTyped } from '../registry.js';
import { DISPATCH_STALE_AFTER_MS, markDispatchUnknown, messageDispatchState } from '../repos/messages.js';
import type { TxJobHandler } from '../types.js';

export function dispatchStaleHandler(): TxJobHandler<MessagePayload> {
  return {
    kind: COMMS_DISPATCH_STALE.kind as 'comms.dispatch_stale',
    queue: COMMS_DISPATCH_STALE.queue,
    priority: COMMS_DISPATCH_STALE.priority,
    via: 'worker',
    schema: COMMS_DISPATCH_STALE.schema,
    async run(ctx, p) {
      const m = await messageDispatchState(ctx.tx, p.messageId);
      if (!m || m.status !== 'dispatching' || m.dispatchedAt === null) return; // TX2 (or a reconcile) got there first
      await lockContact(ctx.tx, m.contactId);
      const due = plusMs(m.dispatchedAt, DISPATCH_STALE_AFTER_MS);
      if (ctx.now < due) return { retryAt: due }; // early wake: not provably stale yet
      if (!(await markDispatchUnknown(ctx.tx, p.messageId))) return;
      await enqueueTyped(ctx.tx, COMMS_RECONCILE, { messageId: p.messageId }, { dedupeKey: COMMS_RECONCILE.dedupeKey(p), priority: COMMS_RECONCILE.priority });
      ctx.log.info('dispatching message marked dispatch_unknown', { jobId: ctx.job.id.toString(), kind: COMMS_DISPATCH_STALE.kind });
    },
  };
}
