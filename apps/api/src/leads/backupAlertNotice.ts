// The notification the minute-three backup alert stores (lock-screen alerts slice 2, DATA_MODEL R-PUSH-10). Pure.
//
// The stored title is what reaches a lock screen (the push payload) and the member's alert text (comms/dispatch.ts
// sends the title), so it is the fixed generic sentence of the first-touch kind (workspace/lockScreen.ts
// LEAD_ALERT_TITLE.first_touch_due) and never core backupAlertText's rich sentence, which names the contact label, the
// lead source and the person or pond holding the lead. The body is core's body unchanged (it names nobody). Only this
// alert's title changes; every other notification kind keeps its own title.
import { LEAD_ALERT_TITLE } from '../workspace/lockScreen.js';

export function backupAlertNotice(text: { title: string; body: string }): { title: string; body: string } {
  return { title: LEAD_ALERT_TITLE.first_touch_due, body: text.body };
}
