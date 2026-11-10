// Staged member deactivation (BUILD_PLAN module 11; R-OWN-22, E12, E13, E58).
//
//   POST /members/:userId/deactivate { mode: 'preview' | 'run', destination }   member.remove (Owner/Admin 🔒)
//
// preview: what the member holds (owned, offered, owned with an open deal) and where it goes
//          (destination; open-deal contacts and leaderless leads go to a USER: the member's Team
//          Lead, else the Owner/Admin who runs it).
// run, stage 1 (this request, ONE transaction): the membership row is locked FOR UPDATE (so it
//          waits for routing that holds it FOR SHARE and for any transaction that already wrote a
//          contact referencing it: E13), set `deactivating` + not accepting leads, its sessions
//          and push subscriptions revoked (ineligible from now on: R-OWN-11 #1/#4); audited.
// job `leads.deactivate` (system worker actor, resumable, idempotent), stages 2–4:
//          every pending offer is rescinded and re-routed, every owned contact moved, ONE
//          transaction per contact, each a `deactivate_owner` ownership command with
//          command_id = hash(deactivation_id, contact_id) (core deactivationCommandId), so a re-run
//          replays instead of acting twice; then a final transaction locks the membership FOR
//          UPDATE, re-checks that nothing is held (including anything handed to the member while
//          stage 1 committed), and marks it `removed` (+ removed_at), audited as member.removed.
import type { Role, UserId } from '@realty/core/foundation';
import { can } from '@realty/core/foundation';
import { deactivationCommandId } from '@realty/core/ownership';
import { applyOwnershipCommandInTx, derivedCommandId, enqueueJob } from '@realty/db';
import type { ContactId } from '@realty/core/foundation';
import type { FastifyInstance } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { audit, redactDiff } from '../audit.js';
import { AppError } from '../errors.js';
import { authorize } from '../rbac.js';
import { jobPayload, zId } from '../worker/payload.js';
import type { StandaloneJobHandler } from '../worker/types.js';
import { leadsTx, platformOf } from './common.js';
import * as repo from './repos/members.js';
import { DeactivateBody, DeactivationResponse } from './schemas.js';

export const DEACTIVATE_JOB_KIND = 'leads.deactivate';
export const deactivateDedupeKey = (userId: string) => `leads.deactivate:${userId}`;

export const DeactivatePayload = jobPayload({
  deactivationId: zId,
  userId: zId,
  destination: z.enum(['team_lead', 'default_pond', 'reroute']),
  fallbackUserId: zId,
});
export type DeactivatePayload = z.infer<typeof DeactivatePayload>;

/** Passes over the member's contacts before the job gives up and retries later (backoff). */
const MAX_PASSES = 5;
const BATCH = 500;

export class DeactivationNotConvergedError extends Error {
  override readonly name = 'DeactivationNotConvergedError';
  readonly code = 'DEACTIVATION_NOT_CONVERGED';
}

export function deactivationHandler(): StandaloneJobHandler<DeactivatePayload> {
  return {
    kind: DEACTIVATE_JOB_KIND,
    queue: 'default',
    mode: 'standalone',
    via: 'worker',
    priority: 50,
    schema: DeactivatePayload,
    async run(ctx, p) {
      const userId = p.userId as UserId;
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        const held = await ctx.withTx((tx) => repo.heldContactIds(tx, userId, BATCH));
        // stages 2 + 3: one transaction per contact (offers rescinded + re-routed, owned contacts moved)
        for (const id of held) {
          await ctx.withTx(async (tx) => {
            const tl = await repo.teamLeadOf(tx, userId);
            // a contact handed to the member AFTER its first command ran needs a fresh command id
            const commandId = pass === 0 ? deactivationCommandId(p.deactivationId, id as ContactId) : derivedCommandId('ownership.deactivate_owner.retry', p.deactivationId, id, String(pass));
            await applyOwnershipCommandInTx(tx, ctx.actor, id as ContactId, { kind: 'deactivate_owner', destination: p.destination, deactivationId: p.deactivationId }, {
              commandId,
              deactivation: { userId, teamLeadUserId: (tl?.user_id ?? null) as UserId | null, fallbackUserId: p.fallbackUserId as UserId },
            });
          });
        }
        if (held.length === BATCH) continue;
        // stage 4: final re-check under the membership row lock, then removed
        const done = await ctx.withTx(async (tx, now) => {
          const m = await repo.memberRow(tx, userId, true);
          if (!m || m.status !== 'deactivating') return true; // already finished (re-run) or reactivated by an admin
          if ((await repo.heldContactIds(tx, userId, 1)).length > 0) return false;
          await repo.finishDeactivation(tx, userId, new Date(now).toISOString());
          await audit(tx, ctx.actor, {
            action: 'member.removed',
            entity: { type: 'membership', id: userId },
            changes: redactDiff({ status: 'deactivating' }, { status: 'removed' }, { entity: 'membership' }),
            reason: 'DEACTIVATED',
          });
          return true;
        });
        if (done) return;
      }
      throw new DeactivationNotConvergedError('member still holds leads after the deactivation passes');
    },
  };
}

export async function registerDeactivationRoutes(app: FastifyInstance): Promise<void> {
  const r = app.withTypeProvider<ZodTypeProvider>();
  r.post(
    '/members/:userId/deactivate',
    {
      config: { auth: 'member.remove' },
      preHandler: authorize('member.remove', (req) =>
        leadsTx(req, async (tx) => {
          const m = await repo.memberRole(tx, (req.params as { userId: string }).userId);
          return m ? { target: { role: m.role as Role } } : null;
        }),
      ),
      schema: { params: z.object({ userId: z.uuid() }), body: DeactivateBody, response: { 200: DeactivationResponse, 202: DeactivationResponse } },
    },
    async (req, reply) => {
      const p = platformOf(req);
      const userId = req.params.userId;
      const { mode, destination } = req.body;
      const out = await leadsTx(req, async (tx, now, actor) => {
        const m = await repo.memberRow(tx, userId, mode === 'run');
        if (!m) throw new AppError('NOT_FOUND');
        // re-check the matrix on the locked row (the role may have changed since authorize read it)
        const state = req.authState!;
        const c = can(actor, 'member.remove', { target: { role: m.role as Role }, reauth: { reauthenticatedAt: state.reauthenticatedAt, now: state.now } });
        if (!c.ok) throw new AppError(c.code === 'NOT_FOUND' ? 'NOT_FOUND' : c.code);
        if (m.user_id === actor.userId || m.status === 'invited' || m.status === 'removed') throw new AppError('DEACTIVATION_NOT_ALLOWED', { status: m.status });
        let deactivationId: string | null = null;
        let status = m.status;
        if (mode === 'run') {
          if (m.status !== 'deactivating') {
            await repo.startDeactivation(tx, userId, new Date(now).toISOString());
            await audit(tx, actor, {
              action: 'member.deactivation_started',
              entity: { type: 'membership', id: userId },
              changes: redactDiff({ status: m.status, accepting_leads: null }, { status: 'deactivating', accepting_leads: false }, { entity: 'membership' }),
              reason: `DESTINATION_${destination.toUpperCase()}`,
            });
          }
          status = 'deactivating';
          const id = p.ids.next<'DeactivationId'>();
          const queued = await enqueueJob(tx, {
            queue: 'default',
            kind: DEACTIVATE_JOB_KIND,
            priority: 50,
            dedupeKey: deactivateDedupeKey(userId),
            payload: DeactivatePayload.parse({ deactivationId: id, userId, destination, fallbackUserId: actor.userId }),
          });
          deactivationId = queued ? id : null; // a live job already carries the deactivation on
        }
        const held = await repo.heldCounts(tx, userId);
        const tl = await repo.teamLeadOf(tx, userId);
        return {
          userId,
          mode,
          status,
          destination,
          owned: held.owned,
          offered: held.offered,
          ownedWithOpenDeal: held.ownedWithOpenDeal,
          teamLead: tl ? { userId: tl.user_id, displayName: tl.display_name } : null,
          fallbackUserId: actor.userId,
          deactivationId,
        };
      });
      reply.status(mode === 'run' ? 202 : 200);
      return { deactivation: out };
    },
  );
}
