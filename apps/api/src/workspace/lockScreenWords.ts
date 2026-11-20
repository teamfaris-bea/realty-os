// The words a lead alert may show where anyone holding the phone can read them: the push lock screen and the member's
// alert text (lock-screen alerts, DATA_MODEL R-PUSH-1, R-PUSH-2, R-PUSH-10 to R-PUSH-13). A LEAF module: it imports
// nothing, so the push delivery (workspace/notifications.ts), the alert text (comms/dispatch.ts), the lock-screen
// builder (workspace/lockScreen.ts) and the backup alert (leads/backupAlertNotice.ts) can all use it without importing
// each other. Pure: no I/O, no clock, no randomness.
//
// The stored notification title (the in-app list) is never changed here; these functions only pick what a lock
// screen or a text shows instead of it.

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

export function isLeadAlertKind(kind: string): kind is LeadAlertKind {
  return (LEAD_ALERT_KINDS as readonly string[]).includes(kind);
}

/**
 * The lock-screen title of a notification: for a lead kind the fixed generic sentence (plus the already-minimized
 * "First L." label only when `showName` is true and the label is shaped like one); for any other kind the stored title.
 */
export function leadAlertTitle(kind: string, storedTitle: string, opts: { person?: string | null; showName?: boolean } = {}): string {
  if (!isLeadAlertKind(kind)) return storedTitle;
  const generic = LEAD_ALERT_TITLE[kind];
  const label = opts.showName === true && typeof opts.person === 'string' ? opts.person.trim() : '';
  return label !== '' && MINIMIZED_LABEL.test(label) ? `${generic}: ${label}` : generic;
}

/** What every agent alert text ends with. */
export const ALERT_SMS_TAIL = 'Open the app for details. Reply STOP to stop alert texts.';

/** An agent alert text: the title as a sentence (a period added when it has no closing punctuation), then the tail. */
export function alertSmsText(title: string): string {
  const t = title.trim();
  return `${/[.!?]$/.test(t) ? t : `${t}.`} ${ALERT_SMS_TAIL}`;
}

/**
 * The text comms/dispatch.ts sends to a member's alert phone for a notification: a lead kind gets its generic sentence
 * (never the stored title); every other kind gets exactly the text it got before (`<stored title> <tail>`).
 */
export function agentAlertSmsBody(kind: string, storedTitle: string): string {
  return isLeadAlertKind(kind) ? alertSmsText(LEAD_ALERT_TITLE[kind]) : `${storedTitle} ${ALERT_SMS_TAIL}`;
}
