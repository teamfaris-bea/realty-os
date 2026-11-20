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
// No I/O, no clock, no randomness. Every other kind is returned exactly as `lockScreenPayload` builds it.
import { lockScreenPayload } from './notifications.js';

export type LockScreenPayload = ReturnType<typeof lockScreenPayload>;
export type LockScreenInput = Parameters<typeof lockScreenPayload>[0];

/** The notification kinds that announce a lead: new lead offer, first touch due (incl. the backup alert), pond arrival. */
export const LEAD_ALERT_KINDS = ['lead_offer', 'first_touch_due', 'pond_new'] as const;
export type LeadAlertKind = (typeof LEAD_ALERT_KINDS)[number];

/** Fixed lock-screen titles for the lead kinds (no name, source or detail). */
export const LEAD_ALERT_TITLE: Readonly<Record<LeadAlertKind, string>> = Object.freeze({
  lead_offer: 'New lead',
  first_touch_due: 'A new lead is waiting for a call',
  pond_new: 'New lead in the pond',
});

// A first name (letters, combining marks, apostrophe, hyphen; at most 30) and an optional last initial "X.".
// Anything else (a full last name, digits, '@', a url, control or bidi characters, markup) is not a minimized label.
const MINIMIZED_LABEL = /^\p{L}[\p{L}\p{M}'’-]{0,29}(?: \p{L}\.)?$/u;

function isLeadAlertKind(kind: string): kind is LeadAlertKind {
  return (LEAD_ALERT_KINDS as readonly string[]).includes(kind);
}

/**
 * The lock-screen payload for a notification. `person` is `contactLabel(...)`'s output for the subject (may be
 * null); it is used only for lead kinds and only with `showName: true`.
 */
export function leadAlertLockScreen(n: LockScreenInput & { person?: string | null }, opts: { showName?: boolean } = {}): LockScreenPayload {
  const { person, ...rest } = n;
  if (!isLeadAlertKind(rest.kind)) return lockScreenPayload(rest);
  const generic = LEAD_ALERT_TITLE[rest.kind];
  const label = opts.showName === true && typeof person === 'string' ? person.trim() : '';
  const title = label !== '' && MINIMIZED_LABEL.test(label) ? `${generic}: ${label}` : generic;
  return lockScreenPayload({ ...rest, title });
}
