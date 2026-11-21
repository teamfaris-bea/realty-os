// The words a lead alert may show where anyone holding the phone can read them: the push lock screen and the member's
// alert text (lock-screen alerts, DATA_MODEL R-PUSH-1, R-PUSH-2, R-PUSH-10 to R-PUSH-13). A LEAF module: it imports
// nothing, so the push delivery (workspace/notifications.ts), the alert text (comms/dispatch.ts), the lock-screen
// builder (workspace/lockScreen.ts) and the backup alert (leads/backupAlertNotice.ts) can all use it without importing
// each other. Pure: no I/O, no clock, no randomness.
//
// The stored notification title (the in-app list) is never changed here; these functions only pick what a lock
// screen or a text shows instead of it.
//
// FAIL CLOSED (slice 2e, R-PUSH-14 to R-PUSH-16; owner decisions of 2026-11-20): what a lock screen or an alert text
// shows comes ONLY from the explicit allowlist LOCK_SCREEN_TITLE below, one fixed generic sentence per known kind. The
// stored title is never shown there, for any kind. A kind that is not in the allowlist (unknown, misspelt, or added
// later without words here) gets GENERIC_FALLBACK_TITLE.

/** The notification kinds that announce a lead: new lead offer, first touch due (incl. the backup alert), pond arrival. */
export const LEAD_ALERT_KINDS = ['lead_offer', 'first_touch_due', 'pond_new'] as const;
export type LeadAlertKind = (typeof LEAD_ALERT_KINDS)[number];

/** Fixed lock-screen titles for the lead kinds (no name, source or detail). */
export const LEAD_ALERT_TITLE: Readonly<Record<LeadAlertKind, string>> = Object.freeze({
  lead_offer: 'New lead',
  first_touch_due: 'A new lead is waiting for a call',
  pond_new: 'New lead in the pond',
});

/**
 * The explicit allowlist: every notification kind the database allows (packages/db migrations,
 * notifications_kind_check), each with generic words that name no person, number, address, source or amount.
 */
export const LOCK_SCREEN_TITLE: Readonly<Record<string, string>> = Object.freeze({
  lead_offer: LEAD_ALERT_TITLE.lead_offer,
  first_touch_due: LEAD_ALERT_TITLE.first_touch_due,
  pond_new: LEAD_ALERT_TITLE.pond_new,
  first_touch_escalation: 'A new lead still needs first contact',
  handback: 'A lead needs your reply',
  handback_hot: 'A lead needs your reply now',
  inbound_message: 'New message',
  missed_call: 'Missed call',
  task_due: 'A task is due',
  promise_due: 'Something you promised is due',
  exception: 'Something needs a look',
  reassigned_to_you: 'A lead is now yours',
  reassigned_away: 'A lead moved to someone else',
  inactivity_warning: 'A lead needs contact soon',
  opt_out: 'A contact opted out',
  import_ready: 'Your import is ready to review',
  system: 'New notification',
  seller_update_ready: 'A seller update is ready',
  weekly_plan: 'Your weekly plan is ready',
  integration_status: 'An integration needs a look',
  ad_overspend: 'An ad budget needs a look',
  mention: 'You were mentioned',
  bulk_finished: 'A bulk action finished',
  ai_isa_handoff: 'The assistant handed you a lead',
  ai_isa_handoff_hot: 'The assistant handed you a hot lead',
  ai_isa_escalation: 'The assistant needs you',
  ai_isa_ended: 'An assistant conversation ended',
  ai_isa_paused: 'An assistant conversation was paused',
  ai_isa_handoff_overdue: 'An assistant handoff is waiting',
});

/** What a lock screen and an alert text show for a kind that is not in the allowlist. */
export const GENERIC_FALLBACK_TITLE = 'New notification';

/** The allowlisted generic words of a kind, or the fallback (own keys only: never a prototype name). */
export function lockScreenTitle(kind: string): string {
  return Object.prototype.hasOwnProperty.call(LOCK_SCREEN_TITLE, kind) ? (LOCK_SCREEN_TITLE[kind] as string) : GENERIC_FALLBACK_TITLE;
}

// A first name (letters, combining marks, apostrophe, hyphen; at most 30) and an optional last initial "X.".
// Anything else (a full last name, digits, '@', a url, control or bidi characters, markup) is not a minimized label.
const MINIMIZED_LABEL = /^\p{L}[\p{L}\p{M}'’-]{0,29}(?: \p{L}\.)?$/u;

export function isLeadAlertKind(kind: string): kind is LeadAlertKind {
  return (LEAD_ALERT_KINDS as readonly string[]).includes(kind);
}

/**
 * The lock-screen title of a notification: for a lead kind the fixed generic sentence (plus the already-minimized
 * "First L." label only when `showName` is true and the label is shaped like one); for any other kind its allowlisted
 * generic words, or the fallback. The stored title is never returned (it is kept in the signature for the call sites).
 */
export function leadAlertTitle(kind: string, _storedTitle: string, opts: { person?: string | null; showName?: boolean } = {}): string {
  if (!isLeadAlertKind(kind)) return lockScreenTitle(kind);
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
 * The text comms/dispatch.ts sends to a member's alert phone for a notification: the kind's allowlisted generic words
 * (or the fallback) as a sentence, then the tail. Never the stored title, for any kind.
 */
export function agentAlertSmsBody(kind: string, _storedTitle: string): string {
  return alertSmsText(lockScreenTitle(kind));
}
