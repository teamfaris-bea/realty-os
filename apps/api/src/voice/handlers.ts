// Job handler of module 48 (registered in worker/handlers/index.ts by one additive line; R-VOICE-7, R-VOICE-21; E439).
//
//   voice.reconcile   per tenant every 5 minutes, standalone. An AI call with no handback 10 minutes after it ended,
//                     or whose session should long be over (ai_takeover_at + the content's maxCallSeconds + 10 min),
//                     lost its session (a restart, a crash, another instance): it gets a recovery handback (outcome
//                     'error' unless the call already has one, end reason SESSION_LOST, critical) and the platform a
//                     P1 alert (WORKER_ERROR, reason VOICE_HANDBACK_MISSING, count). Idempotent: a handled call is not
//                     selected again, and writeHandback writes nothing for a call that has one.
import type { Instant, SystemActor, UserId } from '@realty/core/foundation';
import type { VoiceHandback, VoiceOutcome } from '@realty/core/voice';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import type { z } from 'zod';
import { commsRuntime } from '../comms/runtime.js';
import { jobPayload } from '../worker/payload.js';
import type { JobHandler, StandaloneJobHandler } from '../worker/types.js';
import { SESSION_LOST, writeHandbackInTx } from './handback.js';

export const VOICE_RECONCILE_KIND = 'voice.reconcile';
export const VOICE_RECONCILE_EVERY_MS = 5 * 60_000;
/** R-VOICE-7: a completed AI call without a handback after 10 minutes is a P1. */
export const HANDBACK_GRACE_S = 600;
const MAX_PER_PASS = 100;

interface LostCall {
  id: string;
  contact_id: string;
  voice_outcome: VoiceOutcome | null;
  transfer_outcome: VoiceHandback['transferOutcome'];
  owner_user_id: string | null;
  voice_playbook_version_id: string | null;
}

export async function lostCalls(tx: Tx): Promise<LostCall[]> {
  return (
    await sql<LostCall>`
      SELECT c.id, c.contact_id, c.voice_outcome, c.transfer_outcome, ct.owner_user_id, c.voice_playbook_version_id
        FROM calls c
        JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id
        LEFT JOIN playbook_versions v ON v.tenant_id = c.tenant_id AND v.id = c.voice_playbook_version_id
       WHERE c.tenant_id = app.tenant_id() AND c.handled_by = 'assistant' AND c.handback_action_id IS NULL
         AND ((c.ended_at IS NOT NULL AND c.ended_at < clock_timestamp() - make_interval(secs => ${HANDBACK_GRACE_S}))
              OR c.ai_takeover_at < clock_timestamp() - make_interval(secs => COALESCE((v.steps #>> '{voice,maxCallSeconds}')::int, 900) + ${HANDBACK_GRACE_S}))
       ORDER BY c.started_at LIMIT ${MAX_PER_PASS}`.execute(tx)
  ).rows;
}

/** One recovery handback per lost call (core never ended these sessions: the handback is built here, codes only). */
export function recoveryHandback(c: LostCall): VoiceHandback {
  return {
    callId: c.id as VoiceHandback['callId'],
    outcome: c.voice_outcome ?? 'error',
    endReason: SESSION_LOST as VoiceHandback['endReason'],
    to: c.owner_user_id ? { kind: 'owner', userId: c.owner_user_id as UserId } : { kind: 'intake_offer' },
    critical: true,
    categories: [],
    messageTopics: [],
    agentNotes: [],
    needsReview: [],
    optOut: null,
    transferOutcome: c.transfer_outcome,
    booked: null,
    promiseTask: null,
    noPhoneCallback: false,
    confirmationChannel: null,
  };
}

export async function reconcileTenant(withTx: <T>(fn: (tx: Tx, now: Instant) => Promise<T>) => Promise<T>, actor: SystemActor, deps: { ids: ReturnType<typeof commsRuntime>['ids']; envelope: ReturnType<typeof commsRuntime>['envelope'] }): Promise<{ recovered: number }> {
  const lost = await withTx((tx) => lostCalls(tx));
  let recovered = 0;
  for (const c of lost) {
    const r = await withTx((tx, now) =>
      writeHandbackInTx(tx, now, actor, deps, { tenantId: actor.tenantId, callId: c.id, contactId: c.contact_id, handback: recoveryHandback(c), appointmentId: null, bookingFailureCode: null, unlogged: [], spokeBeforeProcessing: 0, providerKind: 'unknown', playbookVersionId: c.voice_playbook_version_id, recovered: true, at: now }),
    );
    if (r?.created || r?.merged) recovered += 1;
  }
  return { recovered };
}

const Empty = jobPayload({});

export function makeVoiceHandlers(depsFor: () => { ids: ReturnType<typeof commsRuntime>['ids']; envelope: ReturnType<typeof commsRuntime>['envelope'] } = () => commsRuntime()): JobHandler<unknown>[] {
  const reconcile: StandaloneJobHandler<z.infer<typeof Empty>> = {
    kind: VOICE_RECONCILE_KIND,
    queue: 'default',
    mode: 'standalone',
    via: 'provider',
    schema: Empty,
    every: { ms: VOICE_RECONCILE_EVERY_MS, offsetMs: 41_000 },
    periodicPayload: {},
    maxAttempts: 3,
    async run(ctx) {
      const r = await reconcileTenant((fn) => ctx.withTx(fn), ctx.actor, depsFor());
      if (r.recovered > 0) ctx.alerts.raise({ severity: 'P1', code: 'WORKER_ERROR', tenantId: ctx.actor.tenantId, details: { reason: 'VOICE_HANDBACK_MISSING', count: r.recovered } });
      ctx.log.info('voice.reconcile pass', { jobId: ctx.job.id.toString(), recovered: r.recovered });
    },
  };
  return [reconcile] as unknown as JobHandler<unknown>[];
}

/** Everything module 48 registers with the worker (CONVENTIONS §3). */
export const voiceHandlers: JobHandler<unknown>[] = makeVoiceHandlers();
