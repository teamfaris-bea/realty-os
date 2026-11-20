// The minute-three backup alert's pure rules (b19 team-queue lane, step 2; DATA_MODEL R-TEAMQ-14, R-TEAMQ-15,
// E946, E950): when it is due (three minutes of STAFFED time after the arrival) and the words of the alert, which
// must fit a notification title (120 characters: what a push and the alert text carry). Names are made up.
import { describe, expect, it } from 'vitest';
import { at, businessCalendar, instant } from '../foundation/index.js';
import { BACKUP_ALERT_AFTER_SECONDS, BACKUP_GRANT_MS, backupAlertDueAt, backupAlertRecipients, backupAlertText, shortMemberName } from './backupAlert.js';

const CAL = businessCalendar({ zone: 'America/New_York', open: '08:00', close: '21:00' });

describe('R-TEAMQ-14 backupAlertDueAt: three minutes of staffed time after the arrival', () => {
  it('R-TEAMQ-14: inside staffed hours it is three minutes after the arrival', () => {
    expect(BACKUP_ALERT_AFTER_SECONDS).toBe(180);
    const arrived = at('2026-11-10T10:00:00-05:00');
    expect(backupAlertDueAt(arrived, arrived, CAL)).toBe(at('2026-11-10T10:03:00-05:00'));
  });

  it('R-TEAMQ-14 E946: an off-hours arrival counts from opening: 02:00 is due at 08:03, and 20:59 crosses the night', () => {
    const night = at('2026-11-10T02:00:00-05:00');
    expect(backupAlertDueAt(night, night, CAL)).toBe(at('2026-11-10T08:03:00-05:00'));
    const late = at('2026-11-10T20:59:00-05:00');
    expect(backupAlertDueAt(late, late, CAL)).toBe(at('2026-11-11T08:02:00-05:00'));
  });

  it('R-TEAMQ-14 R-TEAMQ-19 E946 E971: a source that back-dates its arrival still gives people three staffed minutes from when the lead reached the team; one dated AHEAD (a fast clock) does too: a lead cannot arrive after the team has it (review fix M3: this line used to wait for the claimed time, 10:05)', () => {
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

  it('R-TEAMQ-15 E950: the owner\'s example, word for word across the title and the body', () => {
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

  it('R-TEAMQ-15 E946: an off-hours arrival says the real wait and the staffed part apart', () => {
    const t = backupAlertText({ ...base, waitedSeconds: 6 * 3600 + 185, staffedSeconds: 185, holder: { kind: 'owner', name: 'Jordan Park' } });
    expect(t.title).toBe('New lead waiting 6 h 3 min: Dana R. from Website form. With Jordan P. You are the backup.');
    expect(t.body).toBe('It arrived outside staffed hours: 3 min of staffed time have passed. Nobody has called, texted or emailed. You can open this lead and call or text for the next 24 hours.');
  });

  it('R-TEAMQ-15 E949: the fallback says why the team lead is hearing it, and promises no new access', () => {
    const t = backupAlertText({ ...base, recipient: 'team_lead', holder: { kind: 'owner', name: 'Jordan Park' } });
    expect(t.title).toBe("New lead waiting 3 min: Dana R. from Website form. With Jordan P. The source's backup is unavailable.");
    expect(t.body).toBe('Nobody has called, texted or emailed. You are alerted as the team lead of whoever has this lead, because the backup named on its source cannot be reached.');
  });

  it('R-TEAMQ-21 E979: the backup IS the person holding the lead: their team lead hears who has it and that they are also the backup (the owner\'s example, word for word across the title and the body)', () => {
    const t = backupAlertText({ ...base, recipient: 'team_lead', why: 'backup_is_holder', holder: { kind: 'owner', name: 'Jordan Park' } });
    expect(t.title).toBe('New lead waiting 3 min: Dana R. from Website form. With Jordan P., who is also the backup for this source.');
    expect(`${t.title} ${t.body}`).toMatch(/^New lead waiting 3 min: Dana R\. from Website form\. With Jordan P\., who is also the backup for this source\. Nobody has called, texted or emailed\./);
    expect(t.body).toBe('Nobody has called, texted or emailed. You are alerted as their team lead, because the backup named on this source is the person who has the lead.');
    // still on offer to the backup
    expect(backupAlertText({ ...base, recipient: 'team_lead', why: 'backup_is_holder', holder: { kind: 'on_offer', name: 'Jordan Park' } }).title).toBe(
      'New lead waiting 3 min: Dana R. from Website form. With Jordan P. (on offer), who is also the backup for this source.',
    );
  });

  it('R-TEAMQ-21 E980: nobody on the lead\'s side to alert (no team lead): the Owners and Admins hear it, and why they do', () => {
    const gone = backupAlertText({ ...base, recipient: 'admins', why: 'backup_unavailable', holder: { kind: 'pond', name: 'Main pond' } });
    expect(gone.title).toBe("New lead waiting 3 min: Dana R. from Website form. In the pond Main pond. The source's backup is unavailable.");
    expect(gone.body).toBe('Nobody has called, texted or emailed. You are alerted as an Owner or Admin, because the backup named on its source cannot be reached and whoever has this lead has no team lead.');
    const same = backupAlertText({ ...base, recipient: 'admins', why: 'backup_is_holder', holder: { kind: 'owner', name: 'Jordan Park' } });
    expect(same.title).toBe('New lead waiting 3 min: Dana R. from Website form. With Jordan P., who is also the backup for this source.');
    expect(same.body).toBe('Nobody has called, texted or emailed. You are alerted as an Owner or Admin, because the backup named on this source is the person who has the lead, and they have no team lead.');
    for (const t of [gone, same]) expect([t.title.length <= 120, t.body.length <= 240]).toEqual([true, true]);
    // the longest names still fit, and the reason is never what is cut
    const long = backupAlertText({ ...base, person: 'A'.repeat(60), sourceName: 'S'.repeat(80), holder: { kind: 'on_offer', name: 'Bartholomew Featherstonehaugh' }, recipient: 'team_lead', why: 'backup_is_holder' });
    expect(long.title.length).toBeLessThanOrEqual(120);
    expect(long.title.endsWith('who is also the backup for this source.')).toBe(true);
  });

  it('R-TEAMQ-27 E992 (review fix L6): a text that was tried and failed is said in the alert: the body never claims nobody tried', () => {
    const t = backupAlertText({ ...base, holder: { kind: 'owner', name: 'Jordan Park' }, failedAttempt: 'text' });
    expect(t.title).toBe('New lead waiting 3 min: Dana R. from Website form. With Jordan P. You are the backup.');
    expect(t.body).toBe('A text was tried, but it failed. Nobody else has called, texted or emailed. You can open this lead and call or text for the next 24 hours.');
    expect(backupAlertText({ ...base, holder: { kind: 'unassigned' }, failedAttempt: 'email' }).body).toMatch(/^An email was tried, but it failed\. Nobody else has called, texted or emailed\./);
    expect(t.body.length).toBeLessThanOrEqual(240);
  });

  it('R-TEAMQ-15 E950: the title always fits 120 characters and the body 240: a long source name, then a long holder name, is cut with an ellipsis, never the meaning', () => {
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

describe('R-TEAMQ-21 backupAlertRecipients: a waiting covered lead always tells someone other than the person holding it', () => {
  const B = 'backup';
  const H = 'holder';
  const base = { backupUserId: B, backupActive: true, holderUserId: H, holderTeamLeads: ['lead-1', 'lead-2'], admins: ['owner', 'admin'] };

  it('R-TEAMQ-15: the named backup, when active and not the holder (also for a lead in a pond or unassigned)', () => {
    expect(backupAlertRecipients(base)).toEqual({ recipient: 'backup', userIds: [B], why: null });
    expect(backupAlertRecipients({ ...base, holderUserId: null, holderTeamLeads: [] })).toEqual({ recipient: 'backup', userIds: [B], why: null });
  });

  it('R-TEAMQ-21 E979: the backup IS the holder: their team lead, never themself; with no team lead, the Owners and Admins', () => {
    expect(backupAlertRecipients({ ...base, holderUserId: B })).toEqual({ recipient: 'team_lead', userIds: ['lead-1'], why: 'backup_is_holder' });
    // the holder leads their own team: the next lead, or the Owners and Admins
    expect(backupAlertRecipients({ ...base, holderUserId: B, holderTeamLeads: [B, 'lead-2'] })).toEqual({ recipient: 'team_lead', userIds: ['lead-2'], why: 'backup_is_holder' });
    expect(backupAlertRecipients({ ...base, holderUserId: B, holderTeamLeads: [B] })).toEqual({ recipient: 'admins', userIds: ['admin', 'owner'], why: 'backup_is_holder' });
    expect(backupAlertRecipients({ ...base, holderUserId: B, holderTeamLeads: [] })).toEqual({ recipient: 'admins', userIds: ['admin', 'owner'], why: 'backup_is_holder' });
  });

  it('R-TEAMQ-15 R-TEAMQ-21 E980: the backup is unavailable: the holder\'s team lead; with no team lead (a pond, an agent on no team), the Owners and Admins, never nobody', () => {
    expect(backupAlertRecipients({ ...base, backupActive: false })).toEqual({ recipient: 'team_lead', userIds: ['lead-1'], why: 'backup_unavailable' });
    expect(backupAlertRecipients({ ...base, backupActive: false, holderUserId: null, holderTeamLeads: [] })).toEqual({ recipient: 'admins', userIds: ['admin', 'owner'], why: 'backup_unavailable' });
    expect(backupAlertRecipients({ ...base, backupActive: false, holderTeamLeads: [] })).toEqual({ recipient: 'admins', userIds: ['admin', 'owner'], why: 'backup_unavailable' });
    // a suspended backup who still holds the lead: unavailable is the reason
    expect(backupAlertRecipients({ ...base, backupActive: false, holderUserId: B })).toMatchObject({ recipient: 'team_lead', why: 'backup_unavailable' });
  });

  it('R-TEAMQ-21: the holder is never among the recipients; nobody only when the team has nobody else', () => {
    expect(backupAlertRecipients({ ...base, holderUserId: 'owner', backupUserId: 'owner', holderTeamLeads: [], admins: ['owner', 'admin'] })).toEqual({ recipient: 'admins', userIds: ['admin'], why: 'backup_is_holder' });
    expect(backupAlertRecipients({ ...base, holderUserId: 'owner', backupUserId: 'owner', holderTeamLeads: [], admins: ['owner'] })).toBeNull();
    for (const f of [base, { ...base, holderUserId: B }, { ...base, backupActive: false }, { ...base, holderUserId: 'owner', backupActive: false, holderTeamLeads: [] }]) {
      expect(backupAlertRecipients(f)!.userIds).not.toContain(f.holderUserId);
    }
  });
});
