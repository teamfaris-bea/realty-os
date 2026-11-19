// The minute-three backup alert's pure rules (b19 team-queue lane, step 2; DATA_MODEL R-TEAMQ-14, R-TEAMQ-15,
// E846, E850): when it is due (three minutes of STAFFED time after the arrival) and the words of the alert, which
// must fit a notification title (120 characters: what a push and the alert text carry). Names are made up.
import { describe, expect, it } from 'vitest';
import { at, businessCalendar, instant } from '../foundation/index.js';
import { BACKUP_ALERT_AFTER_SECONDS, BACKUP_GRANT_MS, backupAlertDueAt, backupAlertText, shortMemberName } from './backupAlert.js';

const CAL = businessCalendar({ zone: 'America/New_York', open: '08:00', close: '21:00' });

describe('R-TEAMQ-14 backupAlertDueAt: three minutes of staffed time after the arrival', () => {
  it('R-TEAMQ-14: inside staffed hours it is three minutes after the arrival', () => {
    expect(BACKUP_ALERT_AFTER_SECONDS).toBe(180);
    const arrived = at('2026-11-10T10:00:00-05:00');
    expect(backupAlertDueAt(arrived, arrived, CAL)).toBe(at('2026-11-10T10:03:00-05:00'));
  });

  it('R-TEAMQ-14 E846: an off-hours arrival counts from opening: 02:00 is due at 08:03, and 20:59 crosses the night', () => {
    const night = at('2026-11-10T02:00:00-05:00');
    expect(backupAlertDueAt(night, night, CAL)).toBe(at('2026-11-10T08:03:00-05:00'));
    const late = at('2026-11-10T20:59:00-05:00');
    expect(backupAlertDueAt(late, late, CAL)).toBe(at('2026-11-11T08:02:00-05:00'));
  });

  it('R-TEAMQ-14 R-TEAMQ-19 E846 E871: a source that back-dates its arrival still gives people three staffed minutes from when the lead reached the team; one dated AHEAD (a fast clock) does too: a lead cannot arrive after the team has it (review fix M3: this line used to wait for the claimed time, 10:05)', () => {
    const reached = at('2026-11-10T10:00:00-05:00');
    expect(backupAlertDueAt(at('2026-11-09T15:00:00-05:00'), reached, CAL)).toBe(at('2026-11-10T10:03:00-05:00'));
    expect(backupAlertDueAt(at('2026-11-10T10:02:00-05:00'), reached, CAL)).toBe(at('2026-11-10T10:03:00-05:00'));
  });

  it('the access a backup is given lasts 24 hours', () => {
    expect(BACKUP_GRANT_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe('R-TEAMQ-15 backupAlertText: who, from where, how long, who it is with', () => {
  const base = { person: 'Dana R.', sourceName: 'Website form', waitedSeconds: 185, staffedSeconds: 185, recipient: 'backup' as const };

  it('R-TEAMQ-15 E850: the owner\'s example, word for word across the title and the body', () => {
    const t = backupAlertText({ ...base, holder: { kind: 'on_offer', name: 'Jordan Park' } });
    expect(t.title).toBe('New lead waiting 3 min: Dana R. from Website form. With Jordan P. (on offer). You are the backup.');
    expect(t.body).toBe('Nobody has called, texted or emailed. You can open this lead and call or text for the next 24 hours.');
    expect(`${t.title} ${t.body}`).toContain('Nobody has called, texted or emailed.');
  });

  it('R-TEAMQ-15: each place the lead can be is said in words', () => {
    expect(backupAlertText({ ...base, holder: { kind: 'owner', name: 'Jordan Park' } }).title).toBe('New lead waiting 3 min: Dana R. from Website form. With Jordan P. You are the backup.');
    expect(backupAlertText({ ...base, holder: { kind: 'pond', name: 'Main pond' } }).title).toBe('New lead waiting 3 min: Dana R. from Website form. In the pond Main pond. You are the backup.');
    expect(backupAlertText({ ...base, holder: { kind: 'unassigned' } }).title).toBe('New lead waiting 3 min: Dana R. from Website form. Not assigned to anyone. You are the backup.');
    // the person's name is withheld by the team's setting: nobody is named
    expect(backupAlertText({ ...base, person: null, holder: { kind: 'unassigned' } }).title).toBe('New lead waiting 3 min from Website form. Not assigned to anyone. You are the backup.');
  });

  it('R-TEAMQ-15 E846: an off-hours arrival says the real wait and the staffed part apart', () => {
    const t = backupAlertText({ ...base, waitedSeconds: 6 * 3600 + 185, staffedSeconds: 185, holder: { kind: 'owner', name: 'Jordan Park' } });
    expect(t.title).toBe('New lead waiting 6 h 3 min: Dana R. from Website form. With Jordan P. You are the backup.');
    expect(t.body).toBe('It arrived outside staffed hours: 3 min of staffed time have passed. Nobody has called, texted or emailed. You can open this lead and call or text for the next 24 hours.');
  });

  it('R-TEAMQ-15 E849: the fallback says why the team lead is hearing it, and promises no new access', () => {
    const t = backupAlertText({ ...base, recipient: 'team_lead', holder: { kind: 'owner', name: 'Jordan Park' } });
    expect(t.title).toBe("New lead waiting 3 min: Dana R. from Website form. With Jordan P. The source's backup is unavailable.");
    expect(t.body).toBe('Nobody has called, texted or emailed. You are alerted as the team lead of whoever has this lead, because the backup named on its source cannot be reached.');
  });

  it('R-TEAMQ-15 E850: the title always fits 120 characters and the body 240: a long source name, then a long holder name, is cut with an ellipsis, never the meaning', () => {
    const t = backupAlertText({ ...base, person: 'Maximiliana Q.', sourceName: 'The Riverside Collection open house weekend registration form (autumn)', holder: { kind: 'on_offer', name: 'Bartholomew Featherstonehaugh' } });
    expect(t.title.length).toBeLessThanOrEqual(120);
    expect(t.title).toMatch(/^New lead waiting 3 min: Maximiliana Q\. from The Riverside.*… With Bartholomew F\. \(on offer\)\. You are the backup\.$/);
    for (const source of ['', '   ']) expect(backupAlertText({ ...base, sourceName: source, holder: { kind: 'unassigned' } }).title).toBe('New lead waiting 3 min: Dana R. from a source with no name. Not assigned to anyone. You are the backup.');
    const long = backupAlertText({ ...base, person: 'A'.repeat(60), sourceName: 'S'.repeat(80), holder: { kind: 'pond', name: 'P'.repeat(80) }, recipient: 'team_lead' });
    expect(long.title.length).toBeLessThanOrEqual(120);
    expect(long.title.endsWith("The source's backup is unavailable.")).toBe(true);
    expect(long.body.length).toBeLessThanOrEqual(240);
  });

  it('shortMemberName: first name and last initial, like a contact\'s label; one word stays; nothing reads as "a member"', () => {
    expect(shortMemberName('Jordan Park')).toBe('Jordan P.');
    expect(shortMemberName('  Jordan   van der Park ')).toBe('Jordan P.');
    expect(shortMemberName('Jordan')).toBe('Jordan');
    expect(shortMemberName(null)).toBe('a member');
    expect(shortMemberName('')).toBe('a member');
  });

  it('a wait under a minute is said in seconds, never "0 min"', () => {
    expect(backupAlertText({ ...base, waitedSeconds: 59, staffedSeconds: 59, holder: { kind: 'unassigned' } }).title).toMatch(/^New lead waiting 59 s: /);
    expect(instant(0)).toBe(0);
  });
});
