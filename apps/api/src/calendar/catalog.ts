// Calendar providers, scopes and the plain-words sentences of module 34 (R-CAL-1..4, R-INT-5).
//
// Minimal scopes (VERIFY every name against the vendor's current docs before an app is registered):
//   Google     calendar.events (write the events Realty OS pushes; VERIFY whether calendar.events.owned is
//              enough) and calendar.freebusy (busy times only, never event titles). Never the full
//              `auth/calendar` scope, never Gmail (module 68 has its own OAuth client).
//   Microsoft  Calendars.ReadWrite (create/update the pushed events, getSchedule for free/busy) and
//              offline_access (a refresh token). Never Calendars.ReadWrite.Shared, never Mail.*.
// The real client ids and secrets are deployment settings (GOOGLE_CLIENT_ID ... in providers/integrations/
// real.ts); none is in the repository and none is wired yet (N10: Google app verification and Microsoft
// publisher verification).
export const CALENDAR_PROVIDER_KEYS = ['google_calendar', 'microsoft_calendar'] as const;
export type CalendarProviderKey = (typeof CALENDAR_PROVIDER_KEYS)[number];

export interface CalendarService {
  key: CalendarProviderKey;
  name: string;
  /** the short name used in sentences ("Edited in Google Calendar") */
  short: string;
  oauth: 'google' | 'microsoft';
  calendar: 'google' | 'microsoft';
  scopes: readonly string[];
  /** the calendar the events go to (the person's main calendar). VERIFY: Google's 'primary' alias, Graph's default calendar. */
  calendarRef: string;
}

export const GOOGLE_CALENDAR_SCOPES = ['https://www.googleapis.com/auth/calendar.events', 'https://www.googleapis.com/auth/calendar.freebusy'] as const;
export const MICROSOFT_CALENDAR_SCOPES = ['offline_access', 'Calendars.ReadWrite'] as const;

/** Scopes a calendar connect must never request or accept (wider than needed, or another product). */
export const FORBIDDEN_CALENDAR_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/calendar.readonly',
  'https://mail.google.com/',
  'https://www.googleapis.com/auth/gmail.readonly',
  'Calendars.ReadWrite.Shared',
  'Mail.Read',
  'Mail.ReadWrite',
  'Mail.Send',
] as const;

export const CALENDAR_SERVICES: Record<CalendarProviderKey, CalendarService> = {
  google_calendar: { key: 'google_calendar', name: 'Google Calendar', short: 'Google Calendar', oauth: 'google', calendar: 'google', scopes: GOOGLE_CALENDAR_SCOPES, calendarRef: 'primary' },
  microsoft_calendar: { key: 'microsoft_calendar', name: 'Microsoft Outlook calendar', short: 'Outlook', oauth: 'microsoft', calendar: 'microsoft', scopes: MICROSOFT_CALENDAR_SCOPES, calendarRef: 'default' },
};

export function calendarService(key: string): CalendarService | null {
  return (CALENDAR_PROVIDER_KEYS as readonly string[]).includes(key) ? CALENDAR_SERVICES[key as CalendarProviderKey] : null;
}

/** What syncs, in one sentence the page shows as is (R-CAL-2, R-CAL-3). */
export const SYNC_SENTENCE =
  'One way: appointments you make or change in Realty OS are added to your calendar. Changes you make in your calendar are not copied back. Realty OS checks only when you are busy, never what your events say, and keeps no copy.';

export const PRIVACY_SENTENCE = 'Only you see this connection. Owners and Admins cannot see your calendar, your busy times or this link.';

/** The connection's state as the page names it. */
export type LinkState = 'connected' | 'pending' | 'degraded' | 'needs_reconnect' | 'not_connected' | 'not_configured';

/**
 * Batch 7 review ui/F3: with the fake adapters (dev, test, the staging demo) nothing reaches a real calendar, so a
 * connected link says so instead of "added to your Google Calendar"; `pending` is a link in pending_review.
 */
export function linkSentence(s: CalendarService, state: LinkState, mode: 'fake' | 'unconfigured' | 'real' = 'real'): string {
  switch (state) {
    case 'connected':
      if (mode === 'fake') return `Connected to a test calendar: nothing reaches your real ${s.short}.`;
      return `Connected. New and changed appointments are added to your ${s.short}.`;
    case 'pending':
      return `Waiting for ${s.short} to finish approving the connection. Nothing is sent to your calendar yet.`;
    case 'degraded':
      return `Connected, but the last update to your ${s.short} did not go through. Realty OS will try again. Your appointments in Realty OS are unchanged.`;
    case 'needs_reconnect':
      return `Needs reconnect: ${s.short} stopped accepting Realty OS (the access was removed). Nothing is sent to your calendar until you reconnect. Your appointments in Realty OS are unchanged.`;
    case 'not_connected':
      return `Not connected. Nothing is sent to your ${s.short}.`;
    case 'not_configured':
      return `Not set up on this platform yet: ${s.name} cannot be connected here until the platform's app is approved.`;
  }
}

/** E103: an appointment whose event the person changed or removed in their calendar. */
export function detachedSentence(short: string): string {
  return `Edited in ${short}; times may differ. Realty OS stopped updating this event so your change is kept.`;
}

/** The provider a pushed event belongs to: external_event_ref is stored as `<provider>:<event id>`. */
export function refProvider(ref: string | null): 'google' | 'microsoft' | null {
  if (!ref) return null;
  const p = ref.slice(0, ref.indexOf(':'));
  return p === 'google' || p === 'microsoft' ? p : null;
}

export function shortOfRef(ref: string | null): string {
  const p = refProvider(ref);
  return p === 'microsoft' ? CALENDAR_SERVICES.microsoft_calendar.short : CALENDAR_SERVICES.google_calendar.short;
}
