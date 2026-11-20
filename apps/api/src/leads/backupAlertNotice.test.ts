// Lock-screen alerts slice 2 (R-PUSH-10; owner choice (b), 2026-11-20): the minute-three backup alert keeps its
// detailed in-app title (R-TEAMQ-15: who the lead is, the source, the wait, who has it), while the push lock-screen
// title and the member's alert text are the generic first-touch sentence. Pure: no database (the DB-backed
// leads/backupAlert.test.ts proves the stored title over Postgres and was NOT run here). Every name below is invented.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { backupAlertText } from '@realty/core/priority';
import { describe, expect, it } from 'vitest';
import { LEAD_ALERT_TITLE, leadAlertLockScreen } from '../workspace/lockScreen.js';
import { ALERT_SMS_TAIL, alertSmsText, backupAlertNotice } from './backupAlertNotice.js';

const PERSON = 'Test L.';
const SOURCE = 'Example Portal Premium';
const HOLDER = 'Example Holder';
const POND = 'Example Pond';
const NAMES = [PERSON, 'Test', SOURCE, 'Example', 'Portal', HOLDER, 'Holder', POND, 'Pond', 'pond', 'Example H.'];
const GENERIC = 'A new lead is waiting for a call';

type Facts = Parameters<typeof backupAlertText>[0];
const holders: Facts['holder'][] = [
  { kind: 'owner', name: HOLDER },
  { kind: 'on_offer', name: HOLDER },
  { kind: 'pond', name: POND },
  { kind: 'unassigned' },
];
const routes: Pick<Facts, 'recipient' | 'why'>[] = [
  { recipient: 'backup' },
  { recipient: 'team_lead', why: 'backup_unavailable' },
  { recipient: 'team_lead', why: 'backup_is_holder' },
  { recipient: 'admins', why: 'backup_unavailable' },
  { recipient: 'admins', why: 'backup_is_holder' },
];
const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

describe('minute-three backup alert: detailed in-app title, generic push and alert text', () => {
  it('R-PUSH-10 E1235: in-app keeps core\'s detailed title; the push title and the alert text are generic for every holder, recipient and fallback; the body is unchanged', () => {
    for (const holder of holders) {
      for (const r of routes) {
        for (const failedAttempt of [undefined, 'text', 'email'] as const) {
          const text = backupAlertText({ person: PERSON, sourceName: SOURCE, waitedSeconds: 240, staffedSeconds: 240, holder, ...r, ...(failedAttempt ? { failedAttempt } : {}) });
          const n = backupAlertNotice(text);
          // in-app: exactly core's R-TEAMQ-15 sentence (who, from where, how long, who has it)
          expect(n.inAppTitle).toBe(text.title);
          expect(n.inAppTitle).toMatch(/^New lead waiting 4 min: Test L\. from Example/);
          // push lock screen and alert text: the generic sentence, naming nobody
          expect(n.pushTitle).toBe(LEAD_ALERT_TITLE.first_touch_due);
          expect(n.pushTitle).toBe(GENERIC);
          expect(n.smsText).toBe(`${GENERIC}. ${ALERT_SMS_TAIL}`);
          for (const name of NAMES) {
            expect(n.pushTitle).not.toContain(name);
            expect(n.smsText).not.toContain(name);
            expect(n.body).not.toContain(name);
          }
          expect(n.body).toBe(text.body);
          expect(n.inAppTitle.length).toBeLessThanOrEqual(120);
          expect(n.body.length).toBeLessThanOrEqual(240);
        }
      }
    }
  });

  it('R-PUSH-10 E1236: the job stores the detailed in-app title through its one first_touch_due notifyUser call; the push title is what the lock-screen seam builds for that kind', () => {
    const src = read('./backupAlert.ts');
    const calls = [...src.matchAll(/notifyUser\(tx, ids, \{([^}]*)\}/g)].map((m) => m[1] as string);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("kind: 'first_touch_due'");
    expect(calls[0]).toContain('title: notice.inAppTitle');
    expect(calls[0]).toContain('body: notice.body');
    expect(src).toMatch(/const notice = backupAlertNotice\(text\);/);
    // the next seam (notifications.ts push delivery -> leadAlertLockScreen) gives exactly pushTitle for this alert
    const text = backupAlertText({ person: PERSON, sourceName: SOURCE, waitedSeconds: 240, staffedSeconds: 240, holder: { kind: 'on_offer', name: HOLDER }, recipient: 'backup' });
    const n = backupAlertNotice(text);
    const lock = leadAlertLockScreen({ id: '0190f5a0-0000-7000-8000-000000000001', kind: 'first_touch_due', title: n.inAppTitle, subjectType: 'contact', subjectId: '0190f5a0-0000-7000-8000-000000000002', tenant: { id: '0190f5a0-0000-7000-8000-0000000000aa', slug: 'harbor' } });
    expect(lock.title).toBe(n.pushTitle);
  });

  it('R-PUSH-10 E1237: the alert text reads as a sentence: a period is added after a title without one, never doubled, and the tail is the one dispatch sends', () => {
    expect(alertSmsText(GENERIC)).toBe('A new lead is waiting for a call. Open the app for details. Reply STOP to stop alert texts.');
    expect(alertSmsText(`${GENERIC}.`)).toBe('A new lead is waiting for a call. Open the app for details. Reply STOP to stop alert texts.');
    expect(alertSmsText('Call back?')).toBe('Call back? Open the app for details. Reply STOP to stop alert texts.');
    expect(alertSmsText('Hot lead!')).toBe('Hot lead! Open the app for details. Reply STOP to stop alert texts.');
    expect(alertSmsText('  A new lead is waiting for a call  ')).toBe('A new lead is waiting for a call. Open the app for details. Reply STOP to stop alert texts.');
    expect(ALERT_SMS_TAIL).toBe('Open the app for details. Reply STOP to stop alert texts.');
    // the same tail as comms/dispatch.ts's alert text (the next seam), so the two cannot drift apart unnoticed
    expect(read('../comms/dispatch.ts')).toContain(`\${d.title} ${ALERT_SMS_TAIL}`);
  });
});
