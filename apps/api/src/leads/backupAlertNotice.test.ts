// Lock-screen alerts slice 2 (R-PUSH-10): the minute-three backup alert's notification title is generic. The title is
// what the push and the alert text carry (comms/dispatch.ts dispatchAgentAlertSms sends the title), so it must not
// name the contact, the source, the person holding the lead or the pond. Pure: no database (the DB-backed
// leads/backupAlert.test.ts proves the wiring over Postgres and was NOT run here). Every name below is invented.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { backupAlertText } from '@realty/core/priority';
import { describe, expect, it } from 'vitest';
import { LEAD_ALERT_TITLE } from '../workspace/lockScreen.js';
import { backupAlertNotice } from './backupAlertNotice.js';

const PERSON = 'Test L.';
const SOURCE = 'Example Portal Premium';
const HOLDER = 'Example Holder';
const POND = 'Example Pond';
const NAMES = [PERSON, 'Test', SOURCE, 'Example', 'Portal', HOLDER, 'Holder', POND, 'Pond', 'pond', 'Example H.'];

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

describe('minute-three backup alert: generic notification title', () => {
  it('R-PUSH-10 E1235: every holder, recipient and fallback gets the fixed generic title, with no contact label, source, holder or pond name; the body is unchanged', () => {
    for (const holder of holders) {
      for (const r of routes) {
        for (const failedAttempt of [undefined, 'text', 'email'] as const) {
          const text = backupAlertText({ person: PERSON, sourceName: SOURCE, waitedSeconds: 240, staffedSeconds: 240, holder, ...r, ...(failedAttempt ? { failedAttempt } : {}) });
          // the rich sentence really does carry the details: this is what used to be the title
          expect(text.title).toContain('Example');
          const n = backupAlertNotice(text);
          expect(n.title).toBe(LEAD_ALERT_TITLE.first_touch_due);
          expect(n.title).toBe('A new lead is waiting for a call');
          for (const name of NAMES) expect(n.title).not.toContain(name);
          expect(n.title.length).toBeLessThanOrEqual(120);
          // the body is exactly what it was (it names nobody), and still fits the notifications.body limit
          expect(n.body).toBe(text.body);
          for (const name of NAMES) expect(n.body).not.toContain(name);
          expect(n.body.length).toBeLessThanOrEqual(240);
        }
      }
    }
  });

  it('R-PUSH-10 E1236: the job stores the generic title through the one first_touch_due notifyUser call and never the rich title', () => {
    const src = readFileSync(fileURLToPath(new URL('./backupAlert.ts', import.meta.url)), 'utf8');
    const calls = [...src.matchAll(/notifyUser\(tx, ids, \{([^}]*)\}/g)].map((m) => m[1] as string);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("kind: 'first_touch_due'");
    expect(calls[0]).toContain('title: notice.title');
    expect(calls[0]).toContain('body: notice.body');
    expect(src).not.toMatch(/title: text\.title/);
    expect(src).toMatch(/const notice = backupAlertNotice\(text\);/);
  });
});
