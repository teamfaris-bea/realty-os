// Lock-screen alerts slice 2d (R-PUSH-11 to R-PUSH-13): the delivery wiring. The push delivery and the member's alert
// text now take their words from the pure leaf module lockScreenWords.ts, so a lead alert (a new lead offer, the
// first-touch / minute-three backup alert, a pond arrival) shows the generic sentence on a lock screen and in a text,
// while the stored in-app title keeps its detail. Pure: the delivery paths themselves are DB-backed
// (workspace/notifications.test.ts, leads/backupAlert.test.ts) and were NOT run here. Every value below is invented.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { backupAlertText } from '@realty/core/priority';
import { backupAlertNotice } from '../leads/backupAlertNotice.js';
import { LEAD_ALERT_KINDS, LEAD_ALERT_TITLE, leadAlertLockScreen } from './lockScreen.js';
import { ALERT_SMS_TAIL, GENERIC_FALLBACK_TITLE, LOCK_SCREEN_TITLE, agentAlertSmsBody, leadAlertTitle, lockScreenTitle } from './lockScreenWords.js';
import { lockScreenPayload } from './notifications.js';
import { NOTIFICATION_KINDS } from './schemas.js';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const TENANT = { id: '0190f5a0-0000-7000-8000-0000000000aa', slug: 'harbor' };
const RICH = 'New lead waiting 4 min: Test L. from Example Portal Premium. With Example H. (on offer). You are the backup.';
const OTHER_TITLES = ['Test L. replied', 'A task is due', 'Missed call from Test L', 'Ends with a question?', ''];
const leadKinds = LEAD_ALERT_KINDS as readonly string[];
const otherKinds = NOTIFICATION_KINDS.filter((k) => !leadKinds.includes(k));
const n = (kind: string, title = RICH) => ({ id: '0190f5a0-0000-7000-8000-000000000001', kind, title, subjectType: 'contact' as const, subjectId: '0190f5a0-0000-7000-8000-000000000002', tenant: TENANT });

describe('lock-screen delivery wiring (pure parts)', () => {
  it('R-PUSH-11 R-PUSH-14 E1238: the push title is the generic sentence for the three lead kinds and the allowlisted generic words for every other kind (slice 2e; it was the stored title), and the push payload equals the lock-screen builder with the name opt-in off', () => {
    expect(otherKinds.length).toBeGreaterThan(0);
    for (const kind of LEAD_ALERT_KINDS) {
      expect(leadAlertTitle(kind, RICH)).toBe(LEAD_ALERT_TITLE[kind]);
      for (const leak of ['Test', 'Example', 'Portal']) expect(leadAlertTitle(kind, RICH)).not.toContain(leak);
    }
    for (const kind of otherKinds) for (const t of [...OTHER_TITLES, RICH]) expect(leadAlertTitle(kind, t)).toBe(LOCK_SCREEN_TITLE[kind]);
    // what notifications.ts now pushes is exactly leadAlertLockScreen(n) (showName off), for every kind
    for (const kind of NOTIFICATION_KINDS) {
      expect(lockScreenPayload({ ...n(kind), title: leadAlertTitle(kind, RICH) })).toEqual(leadAlertLockScreen(n(kind)));
      // and a non-lead kind keeps lockScreenPayload's body, url and tag, with its allowlisted title (slice 2e)
      if (!leadKinds.includes(kind)) expect(lockScreenPayload({ ...n(kind), title: leadAlertTitle(kind, RICH) })).toEqual({ ...lockScreenPayload(n(kind)), title: LOCK_SCREEN_TITLE[kind] });
    }
    // the minute-three backup alert: the push title is the notice's pushTitle
    const text = backupAlertText({ person: 'Test L.', sourceName: 'Example Portal Premium', waitedSeconds: 240, staffedSeconds: 240, holder: { kind: 'on_offer', name: 'Example Holder' }, recipient: 'backup' });
    const notice = backupAlertNotice(text);
    expect(leadAlertTitle('first_touch_due', notice.inAppTitle)).toBe(notice.pushTitle);
  });

  it('R-PUSH-11 E1239: the push delivery in notifications.ts sends the lock-screen title, not the stored title; the stored (in-app) title is what notifyUser writes, unchanged', () => {
    const src = read('./notifications.ts');
    const deliver = src.slice(src.indexOf('deps.providers.push.deliverPush('));
    const call = deliver.slice(0, deliver.indexOf('\n'));
    expect(call).toContain('lockScreenPayload({');
    expect(call).toContain('title: leadAlertTitle(d.kind, d.title)');
    expect(call).not.toMatch(/[{,]\s*title: d\.title[,}]/);
    expect(src.match(/deps\.providers\.push\.deliverPush\(/g)).toHaveLength(1);
    // the in-app list still reads the stored title: notifyUser stores n.title as given
    expect(read('../comms/repos/notify.ts')).toContain('${n.title.slice(0, 120)}');
  });

  it('R-PUSH-12 R-PUSH-15 E1240: the alert text of a lead kind is the generic sentence with a period and the tail; every other kind is its allowlisted generic words with a period and the tail (slice 2e; it was the old text)', () => {
    expect(ALERT_SMS_TAIL).toBe('Open the app for details. Reply STOP to stop alert texts.');
    expect(agentAlertSmsBody('lead_offer', RICH)).toBe('New lead. Open the app for details. Reply STOP to stop alert texts.');
    expect(agentAlertSmsBody('first_touch_due', RICH)).toBe('A new lead is waiting for a call. Open the app for details. Reply STOP to stop alert texts.');
    expect(agentAlertSmsBody('pond_new', RICH)).toBe('New lead in the pond. Open the app for details. Reply STOP to stop alert texts.');
    for (const kind of LEAD_ALERT_KINDS) for (const leak of ['Test', 'Example', 'Portal']) expect(agentAlertSmsBody(kind, RICH)).not.toContain(leak);
    // slice 2e: every other kind fails closed to its generic words, whatever the stored title says
    for (const kind of otherKinds) for (const t of [...OTHER_TITLES, RICH]) expect(agentAlertSmsBody(kind, t)).toBe(`${LOCK_SCREEN_TITLE[kind]}. Open the app for details. Reply STOP to stop alert texts.`);
    // the minute-three backup alert: the text is the notice's smsText
    const text = backupAlertText({ person: 'Test L.', sourceName: 'Example Portal Premium', waitedSeconds: 240, staffedSeconds: 240, holder: { kind: 'pond', name: 'Example Pond' }, recipient: 'admins', why: 'backup_unavailable' });
    const notice = backupAlertNotice(text);
    expect(agentAlertSmsBody('first_touch_due', notice.inAppTitle)).toBe(notice.smsText);
  });

  it('R-PUSH-12 E1241: dispatch.ts builds the alert text from the notification kind and the leaf builder; the old template is gone', () => {
    const src = read('../comms/dispatch.ts');
    expect(src).toContain('const body = agentAlertSmsBody(d.kind, d.title);');
    expect(src).toMatch(/SELECT d\.id, d\.status, d\.channel, n\.user_id, n\.kind, n\.title,/);
    expect(src).not.toContain('${d.title} Open the app for details.');
  });

  it('R-PUSH-13 E1242: the words live in a leaf module with no imports, so the SMS code and the lock-screen module never import each other', () => {
    const leaf = read('./lockScreenWords.ts');
    expect(leaf).not.toMatch(/^\s*import\b/m);
    expect(leaf).not.toMatch(/\brequire\(|\bimport\(/);
    const dispatch = read('../comms/dispatch.ts');
    const notifications = read('./notifications.ts');
    expect(dispatch).toContain("from '../workspace/lockScreenWords.js'");
    expect(notifications).toContain("from './lockScreenWords.js'");
    for (const src of [dispatch, notifications]) {
      expect(src).not.toMatch(/from '(\.\.\/workspace\/|\.\/)lockScreen\.js'/);
      expect(src).not.toMatch(/backupAlertNotice/);
      expect(src).not.toMatch(/\bimport\(/);
    }
  });
});

// slice 2e (owner decisions of 2026-11-20, relayed by Sam): every kind fails closed to generic words
const MIGRATIONS = fileURLToPath(new URL('../../../../packages/db/migrations/', import.meta.url));
function kindsTheDatabaseAllows(): string[] {
  const files = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort();
  let last = '';
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8');
    const at = sql.lastIndexOf('ADD CONSTRAINT notifications_kind_check');
    if (at >= 0) last = sql.slice(at, sql.indexOf('));', at));
  }
  return [...last.matchAll(/'([a-z_]+)'/g)].map((m) => m[1] as string).sort();
}
const PII = /\d|@|https?:|www\.|:|\(|\)|"|Test|Example|Lead A|Portal/;
const UNKNOWN = ['', ' ', 'LEAD_OFFER', 'lead_offer ', 'future_kind', 'seller_update', '__proto__', 'constructor', 'toString', 'hasOwnProperty', 'valueOf'];

describe('fail-closed lock-screen and alert-text words (slice 2e)', () => {
  it('R-PUSH-14 E1243: the allowlist names exactly the kinds the database allows, each with short generic words that carry no name, number or detail', () => {
    const allowed = kindsTheDatabaseAllows();
    expect(allowed.length).toBeGreaterThanOrEqual(NOTIFICATION_KINDS.length);
    expect(Object.keys(LOCK_SCREEN_TITLE).sort()).toEqual(allowed);
    for (const k of NOTIFICATION_KINDS) expect(allowed).toContain(k);
    expect(Object.isFrozen(LOCK_SCREEN_TITLE)).toBe(true);
    for (const [kind, title] of Object.entries(LOCK_SCREEN_TITLE)) {
      expect(title.trim()).toBe(title);
      expect(title.length).toBeGreaterThan(0);
      expect(title.length).toBeLessThanOrEqual(60);
      expect(title).not.toMatch(PII);
      expect(title).not.toMatch(/[.!?]$/);
      expect(lockScreenTitle(kind)).toBe(title);
    }
    for (const kind of LEAD_ALERT_KINDS) expect(LOCK_SCREEN_TITLE[kind]).toBe(LEAD_ALERT_TITLE[kind]);
  });

  it('R-PUSH-14 E1244: an unknown or future kind, including prototype names and near-misses, gets the fixed generic fallback, never the stored title', () => {
    expect(GENERIC_FALLBACK_TITLE).toBe('New notification');
    for (const kind of UNKNOWN) {
      expect(lockScreenTitle(kind)).toBe('New notification');
      expect(leadAlertTitle(kind, RICH)).toBe('New notification');
      expect(leadAlertTitle(kind, RICH, { person: 'Test L.', showName: true })).toBe('New notification');
      const p = lockScreenPayload({ ...n(kind), title: leadAlertTitle(kind, RICH) });
      expect(p.title).toBe('New notification');
      expect(JSON.stringify(p)).not.toMatch(/Test|Example|Portal/);
    }
  });

  it('R-PUSH-15 E1245: the alert text of every kind is its generic words with a period and the tail; an unknown kind gets the generic fallback text', () => {
    for (const [kind, title] of Object.entries(LOCK_SCREEN_TITLE)) {
      const body = agentAlertSmsBody(kind, RICH);
      expect(body).toBe(`${title}. ${ALERT_SMS_TAIL}`);
      expect(body).not.toMatch(/Test|Example|Portal|\d/);
    }
    for (const kind of UNKNOWN) expect(agentAlertSmsBody(kind, RICH)).toBe('New notification. Open the app for details. Reply STOP to stop alert texts.');
  });

  it('R-PUSH-16 E1246: a new lead offer and a pond arrival stay generic on the lock screen and in the text, with no name, even when the stored title names the lead', () => {
    const named = 'Test Lead A (843) 555-0142 from Example Portal Premium at 12 Example Lane';
    expect(lockScreenPayload({ ...n('lead_offer', named), title: leadAlertTitle('lead_offer', named) }).title).toBe('New lead');
    expect(lockScreenPayload({ ...n('pond_new', named), title: leadAlertTitle('pond_new', named) }).title).toBe('New lead in the pond');
    expect(agentAlertSmsBody('lead_offer', named)).toBe('New lead. Open the app for details. Reply STOP to stop alert texts.');
    expect(agentAlertSmsBody('pond_new', named)).toBe('New lead in the pond. Open the app for details. Reply STOP to stop alert texts.');
    for (const kind of ['lead_offer', 'pond_new'] as const) {
      expect(leadAlertLockScreen(n(kind, named))).toEqual({ ...lockScreenPayload(n(kind, named)), title: LEAD_ALERT_TITLE[kind] });
      expect(JSON.stringify(leadAlertLockScreen(n(kind, named)))).not.toMatch(/Test|Lead A|555|Example|Portal|Lane/);
    }
  });
});

