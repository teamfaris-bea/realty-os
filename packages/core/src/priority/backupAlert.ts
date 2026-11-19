// The minute-three backup alert: its pure rules (b19 team-queue lane, step 2; DATA_MODEL R-TEAMQ-14, R-TEAMQ-15).
//
// When a covered source's inbound inquiry has had no human attempt after three minutes of STAFFED time, the source's
// backup is alerted (apps/api leads/backupAlert.ts decides and writes; this file holds what is pure):
//   - when it is due: three minutes of staffed time after the ARRIVAL (arrival.ts: the one arrival instant, which a
//     source can neither back-date nor date ahead), counted from opening for an off-hours arrival;
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
  /** the source's named backup, or (when that person is unavailable) the team lead of whoever has the lead */
  recipient: 'backup' | 'team_lead';
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

function holderWords(h: AlertHolder, nameMax: number): string {
  switch (h.kind) {
    case 'owner':
      return stop(`With ${clip(shortMemberName(h.name), nameMax)}`);
    case 'on_offer':
      return `With ${clip(shortMemberName(h.name), nameMax)} (on offer).`;
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
  const tail = f.recipient === 'backup' ? 'You are the backup.' : "The source's backup is unavailable.";
  const source = f.sourceName.trim() === '' ? 'a source with no name' : f.sourceName;
  const build = (sourceMax: number, nameMax: number): string => {
    const who = f.person === null || f.person.trim() === '' ? '' : `: ${clip(f.person, nameMax)}`;
    return `New lead waiting ${waited(f.waitedSeconds)}${who} from ${stop(clip(source, sourceMax))} ${holderWords(f.holder, nameMax)} ${tail}`;
  };
  let title = build(80, 60);
  for (const [sourceMax, nameMax] of [[40, 60], [24, 30], [16, 20], [10, 12], [6, 6]] as const) {
    if (title.length <= ALERT_TITLE_MAX) break;
    title = build(sourceMax, nameMax);
  }
  if (title.length > ALERT_TITLE_MAX) title = `New lead waiting ${waited(f.waitedSeconds)}. ${tail}`;

  const offHours = f.waitedSeconds - f.staffedSeconds >= 60 ? `It arrived outside staffed hours: ${waited(f.staffedSeconds)} of staffed time have passed. ` : '';
  const what =
    f.recipient === 'backup'
      ? 'You can open this lead and call or text for the next 24 hours.'
      : 'You are alerted as the team lead of whoever has this lead, because the backup named on its source cannot be reached.';
  const body = `${offHours}Nobody has called, texted or emailed. ${what}`;
  return { title, body: body.length <= ALERT_BODY_MAX ? body : `Nobody has called, texted or emailed. ${what}` };
}
