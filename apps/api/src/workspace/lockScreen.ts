// Lock-screen alerts for leads (push-step1, R-PUSH-1 to R-PUSH-5): a pure, thin wrapper over the notification
// module's `lockScreenPayload`, which keeps the body (a fixed sentence per kind), the `?team=` url and the
// tenant-prefixed tag. What this adds, for the three kinds that announce a lead (a new lead offer, the
// first-touch / minute-three backup alert, a lead arriving in the pond), is the title:
//   - by default a fixed generic sentence per kind, so nothing the creator put in the stored title (a name,
//     the source, an address, a quoted message) can reach a lock screen; `lockScreenPayload` alone masks only
//     phone numbers and email addresses;
//   - the person's name only when the caller opts in (`showName`) AND passes the label the existing
//     minimization already produced (comms/repos/notify.ts `contactLabel`: first name and last initial, or null
//     when the tenant's notification_detail is 'none'). A label that is not shaped like that is dropped, never
//     masked into the title.
// No I/O, no clock, no randomness. Every other kind gets its allowlisted generic title (lockScreenWords.ts, slice 2e);
// body, url and tag are exactly what `lockScreenPayload` builds.
import { LEAD_ALERT_KINDS, LEAD_ALERT_TITLE, type LeadAlertKind, leadAlertTitle } from './lockScreenWords.js';
import { lockScreenPayload } from './notifications.js';

// the words live in the leaf module (no imports), so notifications.ts and comms/dispatch.ts can use them too
export { LEAD_ALERT_KINDS, LEAD_ALERT_TITLE, type LeadAlertKind };

export type LockScreenPayload = ReturnType<typeof lockScreenPayload>;
export type LockScreenInput = Parameters<typeof lockScreenPayload>[0];

/**
 * The lock-screen payload for a notification. `person` is `contactLabel(...)`'s output for the subject (may be
 * null); it is used only for lead kinds and only with `showName: true`.
 */
export function leadAlertLockScreen(n: LockScreenInput & { person?: string | null }, opts: { showName?: boolean } = {}): LockScreenPayload {
  const { person, ...rest } = n;
  // slice 2e (R-PUSH-14): every kind fails closed to its allowlisted generic words; the name opt-in is for lead kinds only
  return lockScreenPayload({ ...rest, title: leadAlertTitle(rest.kind, rest.title, { person: person ?? null, showName: opts.showName === true }) });
}
