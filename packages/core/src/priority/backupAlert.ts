// The minute-three backup alert: its pure rules (b19 team-queue lane, step 2; DATA_MODEL R-TEAMQ-14, R-TEAMQ-15).
//
// When a covered source's inbound inquiry has had no human attempt after three minutes of STAFFED time, the source's
// backup is alerted (apps/api leads/backupAlert.ts decides and writes; this file holds what is pure):
//   - when it is due: three minutes of staffed time after the ARRIVAL (arrival.ts: the one arrival instant, which a
//     source can neither back-date nor date ahead), counted from opening for an off-hours arrival;
//   - who hears it (backupAlertRecipients): the backup, else the holder's team lead, else the Owners and Admins;
//     never the person who already holds the lead (R-TEAMQ-21);
//   - the words: who, from which source, how long, who it is with. The TITLE is what a push notification and the
//     alert text to the member's phone carry, so it holds the whole alert in at most 120 characters (the column's
//     limit); the body (in-app) adds that nobody has called, texted or emailed and what the recipient can do.
// An alert is to a member of the team. It is never a message to the client, and it changes no owner.
import { type BusinessCalendar, DAY_MS, HOUR_MS, type Instant, MINUTE_MS, SECOND_MS, addBusinessDuration } from '../foundation/index.js';
import { arrivalInstant } from './arrival.js';
import { clip } from './format.js';

/** Three minutes of staffed time. */
export const BACKUP_ALERT_AFTER_SECONDS = 180;
/** How long the alerted backup may open the lead and call or text: 24 hours, or until the owner's own attempt. */
export const BACKUP_GRANT_MS = 24 * HOUR_MS;
/** notifications.title and notifications.body limits (0001). */
export const ALERT_TITLE_MAX = 120;
export const ALERT_BODY_MAX = 240;

/**
 * When the backup alert of an inquiry is due: BACKUP_ALERT_AFTER_SECONDS of staffed time after its arrival
 * (arrivalInstant of the time the source claims, `claimedAt`, and the moment the lead reached the team, `reachedAt`).
 */
export function backupAlertDueAt(claimedAt: Instant, reachedAt: Instant, calendar: BusinessCalendar): Instant {
  return addBusinessDuration(arrivalInstant(claimedAt, reachedAt), BACKUP_ALERT_AFTER_SECONDS, calendar);
}

/** Who has the lead when the alert is raised. Names are members' or ponds' names, never the client's. */
export type AlertHolder = { kind: 'owner'; name: string | null } | { kind: 'on_offer'; name: string | null } | { kind: 'pond'; name: string | null } | { kind: 'unassigned' };

export interface BackupAlertFacts {
  /** the client's PII-minimized label ("Dana R."), or null when the team's setting withholds names */
  person: string | null;
  sourceName: string;
  /** wall-clock seconds since the arrival */
  waitedSeconds: number;
  /** staffed seconds since the arrival */
  staffedSeconds: number;
  holder: AlertHolder;
  /**
   * Who is hearing it (R-TEAMQ-15, R-TEAMQ-21): the source's named `backup`; or, when that person is unavailable or
   * IS the person holding the lead, the `team_lead` of whoever has the lead; or, when there is no team lead to tell,
   * the team's Owners and Admins (`admins`). Never the person who already has the lead.
   */
  recipient: AlertRecipient;
  /** why it is not the backup who hears it (absent for `backup`; default `backup_unavailable`) */
  why?: AlertFallbackReason;
  /**
   * R-TEAMQ-27 (review fix L6): a person's text, email or chat reply since the arrival that the provider reported as
   * failed. It reached nobody, so the alert still fires, and the body says it was tried.
   */
  failedAttempt?: 'text' | 'email' | 'chat';
}

/** lead_backup_alerts.recipient */
export type AlertRecipient = 'backup' | 'team_lead' | 'admins';
/** lead_backup_alerts.fallback_reason: why someone other than the named backup was alerted */
export type AlertFallbackReason = 'backup_unavailable' | 'backup_is_holder';

/**
 * Who the minute-three alert goes to (R-TEAMQ-15, owner decision 2; R-TEAMQ-21, review fix M2). A waiting lead from a
 * covered source always tells someone OTHER than the person already holding it:
 *   1. the source's named backup, when they are an active member and are not the person holding the lead;
 *   2. else the first active team lead of whoever holds the lead (never the holder themself);
 *   3. else the team's active Owners and Admins, except the holder (a lead in a pond or unassigned has no team lead);
 *   4. nobody only when the team has nobody else at all.
 */
export function backupAlertRecipients(f: {
  backupUserId: string | null;
  backupActive: boolean;
  /** the owner or the offeree; null in a pond or unassigned */
  holderUserId: string | null;
  /** the active leads of the holder's teams, in escalation order */
  holderTeamLeads: readonly string[];
  /** the team's active Owners and Admins */
  admins: readonly string[];
}): { recipient: AlertRecipient; userIds: string[]; why: AlertFallbackReason | null } | null {
  const isHolder = f.backupUserId !== null && f.backupUserId === f.holderUserId;
  if (f.backupUserId !== null && f.backupActive && !isHolder) return { recipient: 'backup', userIds: [f.backupUserId], why: null };
  const why: AlertFallbackReason = isHolder && f.backupActive ? 'backup_is_holder' : 'backup_unavailable';
  const lead = f.holderTeamLeads.find((u) => u !== f.holderUserId);
  if (lead !== undefined) return { recipient: 'team_lead', userIds: [lead], why };
  const admins = [...new Set(f.admins)].filter((u) => u !== f.holderUserId).sort();
  return admins.length > 0 ? { recipient: 'admins', userIds: admins, why } : null;
}

/** A member's first name and last initial ("Jordan P."), as a contact's label is written. */
export function shortMemberName(displayName: string | null): string {
  const parts = (displayName ?? '').trim().split(/\s+/).filter((p) => p !== '');
  if (parts.length === 0) return 'a member';
  if (parts.length === 1) return parts[0] as string;
  return `${parts[0]} ${(parts[parts.length - 1] as string).slice(0, 1).toUpperCase()}.`;
}

/** "59 s", "3 min", "6 h 3 min", "2 d": a wait, in the largest honest units. */
function waited(seconds: number): string {
  const ms = Math.max(0, seconds) * SECOND_MS;
  if (ms < MINUTE_MS) return `${Math.floor(ms / SECOND_MS)} s`;
  if (ms < HOUR_MS) return `${Math.floor(ms / MINUTE_MS)} min`;
  if (ms >= 2 * DAY_MS) return `${Math.floor(ms / DAY_MS)} d`;
  const h = Math.floor(ms / HOUR_MS);
  const m = Math.floor((ms - h * HOUR_MS) / MINUTE_MS);
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

/** Ends a phrase with one full stop (a short name already ends with its initial's). */
const stop = (s: string): string => (/[.…]$/.test(s) ? s : `${s}.`);

function holderWords(h: AlertHolder, nameMax: number, alsoBackup: boolean): string {
  // R-TEAMQ-21: the person holding the lead is the source's backup: said with who has it
  const also = alsoBackup ? ', who is also the backup for this source.' : '';
  switch (h.kind) {
    case 'owner':
      return alsoBackup ? `With ${clip(shortMemberName(h.name), nameMax)}${also}` : stop(`With ${clip(shortMemberName(h.name), nameMax)}`);
    case 'on_offer':
      return alsoBackup ? `With ${clip(shortMemberName(h.name), nameMax)} (on offer)${also}` : `With ${clip(shortMemberName(h.name), nameMax)} (on offer).`;
    case 'pond':
      return h.name !== null && h.name.trim() !== '' ? stop(`In the pond ${clip(h.name, nameMax)}`) : 'In a pond.';
    case 'unassigned':
      return 'Not assigned to anyone.';
  }
}

/**
 * The alert's title and body. The title always ends with why this person is hearing it; a long source name, then a
 * long holder or person name, is cut with an ellipsis so the whole title fits ALERT_TITLE_MAX.
 */
export function backupAlertText(f: BackupAlertFacts): { title: string; body: string } {
  const isHolder = f.recipient !== 'backup' && f.why === 'backup_is_holder' && (f.holder.kind === 'owner' || f.holder.kind === 'on_offer');
  // why this person hears it: the holder words say it when the backup is the holder
  const tail = f.recipient === 'backup' ? ' You are the backup.' : isHolder ? '' : " The source's backup is unavailable.";
  const source = f.sourceName.trim() === '' ? 'a source with no name' : f.sourceName;
  const build = (sourceMax: number, nameMax: number): string => {
    const who = f.person === null || f.person.trim() === '' ? '' : `: ${clip(f.person, nameMax)}`;
    return `New lead waiting ${waited(f.waitedSeconds)}${who} from ${stop(clip(source, sourceMax))} ${holderWords(f.holder, nameMax, isHolder)}${tail}`;
  };
  let title = build(80, 60);
  for (const [sourceMax, nameMax] of [[40, 60], [24, 30], [16, 20], [10, 12], [6, 6]] as const) {
    if (title.length <= ALERT_TITLE_MAX) break;
    title = build(sourceMax, nameMax);
  }
  if (title.length > ALERT_TITLE_MAX) title = `New lead waiting ${waited(f.waitedSeconds)}.${isHolder ? ' It is with someone who is also the backup for this source.' : tail}`;

  const offHours = f.waitedSeconds - f.staffedSeconds >= 60 ? `It arrived outside staffed hours: ${waited(f.staffedSeconds)} of staffed time have passed. ` : '';
  const what =
    f.recipient === 'backup'
      ? 'You can open this lead and call or text for the next 24 hours.'
      : f.recipient === 'team_lead'
        ? isHolder
          ? 'You are alerted as their team lead, because the backup named on this source is the person who has the lead.'
          : 'You are alerted as the team lead of whoever has this lead, because the backup named on its source cannot be reached.'
        : isHolder
          ? 'You are alerted as an Owner or Admin, because the backup named on this source is the person who has the lead, and they have no team lead.'
          : 'You are alerted as an Owner or Admin, because the backup named on its source cannot be reached and whoever has this lead has no team lead.';
  const nobody =
    f.failedAttempt === undefined
      ? 'Nobody has called, texted or emailed.'
      : `${f.failedAttempt === 'email' ? 'An email' : f.failedAttempt === 'chat' ? 'A chat reply' : 'A text'} was tried, but it failed. Nobody else has called, texted or emailed.`;
  const body = `${offHours}${nobody} ${what}`;
  if (body.length <= ALERT_BODY_MAX) return { title, body };
  const short = `${nobody} ${what}`;
  return { title, body: short.length <= ALERT_BODY_MAX ? short : `Nobody else has called, texted or emailed. ${what}` };
}
