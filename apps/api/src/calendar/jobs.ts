// Job contracts of api/calendar (payloads: ids only, R-TEN-7).
import { jobPayload, zId } from '../worker/payload.js';

export const CalendarPushPayload = jobPayload({ appointmentId: zId });
export type CalendarPushPayload = { appointmentId: string };

/**
 * calendar.push: push one appointment's current state to its person's connected calendar (R-CAL-2). Enqueued by
 * every in-app appointment write with dedupe key `calendar.push:{appointment}:{sync_version}`, so an edit made
 * while an older push is running still gets its own job; pushes of one appointment are serialized by an
 * advisory lock and fenced by sync_version vs external_pushed_version, so two quick edits never land out of order.
 */
export const CALENDAR_PUSH_JOB = { kind: 'calendar.push', queue: 'default', schema: CalendarPushPayload, maxAttempts: 5 } as const;

export const CalendarReconcilePayload = jobPayload({});
export type CalendarReconcilePayload = Record<string, never>;

/** calendar.reconcile (hourly, per tenant): revokes and purges the links of people who are no longer active members (R-INT-5). */
export const CALENDAR_RECONCILE_JOB = { kind: 'calendar.reconcile', queue: 'default', schema: CalendarReconcilePayload, maxAttempts: 3 } as const;
