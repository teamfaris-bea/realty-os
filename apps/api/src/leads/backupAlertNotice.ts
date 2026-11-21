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
// WIRED (slice 2d): the push delivery (workspace/notifications.ts) sends leadAlertTitle(kind, stored title) and the alert
// text (comms/dispatch.ts) agentAlertSmsBody(kind, stored title), from the leaf workspace/lockScreenWords.ts; for this
// alert's kind those are exactly pushTitle and smsText. The in-app list shows the stored title, inAppTitle.
import { ALERT_SMS_TAIL, LEAD_ALERT_TITLE, alertSmsText } from '../workspace/lockScreenWords.js';

export { ALERT_SMS_TAIL, alertSmsText };

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
