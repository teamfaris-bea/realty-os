// ownership.followup (ARCHITECTURE §5 step 7; Design Review F1/F4): the cross-user effects of a
// user-actor ownership command, applied as the SYSTEM actor under the contact lock by db/client's
// `applyOwnershipFollowupInTx` (routing after a decline with full eligibility data, other users' feed
// items, re-homed handbacks, invalidated drafts, paused enrollments, collaborator rows, fan-out
// deliveries). Idempotent: guarded writes, and routing uses a command id derived from the original.
// The sweeper's `route` branch re-issues this job (same command id, same dedupe key) for an
// `unassigned` lead whose route_due_at is more than 15 s old (a lost follow-up, E5).
import type { ContactId, IdGenerator } from '@realty/core/foundation';
import { FOLLOWUP_JOB_KIND, applyOwnershipFollowupInTx } from '@realty/db';
import { z } from 'zod';
import { jobPayload, zId, zSafeJson } from '../payload.js';
import type { TxJobHandler } from '../types.js';

/** Effect kinds db/client may carry into a follow-up (core Effect kinds + db's mergeCommunication). */
export const FOLLOWUP_EFFECT_KINDS = [
  'enqueueTimer',
  'cancelTimers',
  'notify',
  'upsertFeed',
  'resolveFeed',
  'invalidateDrafts',
  'pauseAgentEnrollments',
  'routingCursor',
  'membershipAutoPause',
  'missedOfferCounter',
  'addCollaborator',
  'rehomeHandbacks',
  'route',
  'setInactivityDeadlines',
  'recordHumanTouch',
  'markDeleted',
  'clearDeleted',
  'markMergedInto',
  'audit',
  'mergeCommunication',
] as const;

const FollowupEffect = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,79}$/), zSafeJson).refine((e) => typeof e.kind === 'string' && (FOLLOWUP_EFFECT_KINDS as readonly string[]).includes(e.kind), {
  message: 'unknown follow-up effect kind',
});

export const FollowupPayloadSchema = jobPayload({
  commandId: zId,
  contactId: zId,
  effects: z.array(FollowupEffect).max(50),
  fanoutNotificationIds: z.array(zId).max(100),
});
export type FollowupJobPayload = z.infer<typeof FollowupPayloadSchema>;

export function ownershipFollowupHandler(opts: { ids?: IdGenerator } = {}): TxJobHandler<FollowupJobPayload> {
  return {
    kind: FOLLOWUP_JOB_KIND as 'ownership.followup',
    queue: 'realtime',
    priority: 10,
    via: 'worker',
    schema: FollowupPayloadSchema,
    async run(ctx, p) {
      const r = await applyOwnershipFollowupInTx(ctx.tx, ctx.actor, { ...p, contactId: p.contactId as ContactId }, opts.ids ? { ids: opts.ids } : {});
      ctx.log.debug('ownership.followup applied', { jobId: ctx.job.id.toString(), count: r.applied });
    },
  };
}
