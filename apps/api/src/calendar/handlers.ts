// Job handlers of api/calendar (registered in worker/handlers/index.ts).
//
//   calendar.push        one appointment to its person's connected calendar (push.ts); via 'provider'
//   calendar.reconcile   hourly per tenant: links of removed members are revoked and purged (R-INT-5); the
//                        pushes an active member's connected calendar is missing are enqueued (R-CAL-2)
import { loadConfig } from '../config.js';
import { EnvelopeService } from '../crypto/envelope.js';
import { localKek } from '../crypto/kek.js';
import type { JobHandler, TxJobHandler } from '../worker/types.js';
import { CALENDAR_PUSH_JOB, CALENDAR_RECONCILE_JOB, type CalendarPushPayload, type CalendarReconcilePayload } from './jobs.js';
import { pushAppointment, reconcileLinks } from './push.js';

let envelopeRuntime: EnvelopeService | null = null;
const defaultEnvelope = (): EnvelopeService => {
  if (!envelopeRuntime) {
    const cfg = loadConfig();
    envelopeRuntime = new EnvelopeService(localKek(cfg.kek, cfg.kekRef));
  }
  return envelopeRuntime;
};

export function makeCalendarHandlers(envelopeFor: () => EnvelopeService = defaultEnvelope): JobHandler<unknown>[] {
  const push: TxJobHandler<CalendarPushPayload> = {
    ...CALENDAR_PUSH_JOB,
    via: 'provider',
    async run(ctx, p) {
      const outcome = await pushAppointment({ envelope: envelopeFor(), adapters: ctx.providers.integrations, now: () => ctx.now }, ctx.tx, ctx.actor, p.appointmentId, {
        lastAttempt: ctx.job.attempts >= CALENDAR_PUSH_JOB.maxAttempts,
      });
      ctx.log.info('calendar push', { kind: CALENDAR_PUSH_JOB.kind, outcome });
    },
  };
  const reconcile: TxJobHandler<CalendarReconcilePayload> = {
    ...CALENDAR_RECONCILE_JOB,
    via: 'provider',
    every: { ms: 3_600_000, offsetMs: 17 * 60_000 },
    periodicPayload: {},
    async run(ctx) {
      const n = await reconcileLinks({ envelope: envelopeFor(), adapters: ctx.providers.integrations, now: () => ctx.now }, ctx.tx, ctx.actor);
      if (n > 0) ctx.log.info('calendar links revoked for removed members', { kind: CALENDAR_RECONCILE_JOB.kind, count: n });
    },
  };
  return [push, reconcile] as JobHandler<unknown>[];
}

export const calendarHandlers: JobHandler<unknown>[] = makeCalendarHandlers();
