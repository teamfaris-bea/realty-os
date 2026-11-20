// The words of the minute-three backup alert, per surface (lock-screen alerts slice 2, DATA_MODEL R-PUSH-10; owner
// choice (b) of 2026-11-20). Pure.
//
//   inAppTitle  core backupAlertText's detailed sentence, exactly as R-TEAMQ-15 says (who the lead is, the source,
//               the wait, who has it). This is the title the job stores and the in-app list shows.
//   pushTitle   the generic first-touch lock-screen title (workspace/lockScreen.ts LEAD_ALERT_TITLE.first_touch_due),
//               which is exactly what leadAlertLockScreen builds for this kind.
//   smsText     the member's alert text with the generic title: "A new lead is waiting for a call. Open the app ...".
//   body        core's body unchanged (it names nobody).
//
// NOT WIRED YET (the next seams): the push delivery (workspace/notifications.ts, the deliverPush call) and the alert
// text (comms/dispatch.ts dispatchAgentAlertSms) both still read the STORED title, so until those two read pushTitle /
// smsText (or call leadAlertLockScreen / alertSmsText) the detailed title still reaches the push and the text.
import { LEAD_ALERT_TITLE } from '../workspace/lockScreen.js';

/** What comms/dispatch.ts appends to every agent alert text. */
export const ALERT_SMS_TAIL = 'Open the app for details. Reply STOP to stop alert texts.';

/** An agent alert text: the title as a sentence (a period added when it has no closing punctuation), then the tail. */
export function alertSmsText(title: string): string {
  const t = title.trim();
  return `${/[.!?]$/.test(t) ? t : `${t}.`} ${ALERT_SMS_TAIL}`;
}

export interface BackupAlertNotice {
  inAppTitle: string;
  pushTitle: string;
  smsText: string;
  body: string;
}

export function backupAlertNotice(text: { title: string; body: string }): BackupAlertNotice {
  const generic = LEAD_ALERT_TITLE.first_touch_due;
  return { inAppTitle: text.title, pushTitle: generic, smsText: alertSmsText(generic), body: text.body };
}
