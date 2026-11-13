// Times on AI care surfaces (R-ISA-29, E511): always in the viewer's zone with its Intl short name, built from the
// API's ISO fields (never from its UTC sentences, V6). "Their time" is said only when the person's zone is explicit
// (zones.source 'explicit'), next to the viewer's; for a union of zones the line says what the time means instead
// (Q7). Deadlines say "by {time}", never business minutes (V15, Q-ISA-20 VERIFY).

export function viewerZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

function parts(iso: string | number, tz: string) {
  const d = new Date(iso);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  const key = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
  return { time, day, key };
}

/** "10:00 AM EST", or "Tue, Nov 17, 10:00 AM EST" when not today in that zone. */
export function localTime(iso: string | number, tz: string = viewerZone(), now: number = Date.now()): string {
  const p = parts(iso, tz);
  const today = parts(now, tz).key;
  return p.key === today ? p.time : `${p.day}, ${p.time}`;
}

/** "Nov 17" in the viewer's zone (release dates). */
export function localDate(iso: string, tz: string = viewerZone()): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(iso));
}

/** Seconds precision for in-flight lines: "10:02:13 AM EST". */
export function localSeconds(iso: string, tz: string = viewerZone()): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', second: '2-digit', timeZoneName: 'short' }).format(new Date(iso));
}

export interface Zones {
  zones: string[];
  source: 'explicit' | 'union';
}

/**
 * "Next AI message planned for 10:00 AM EST (9:00 AM CST, their time)" for an explicit zone; for a union "Next AI
 * message planned for 12:00 PM EST, the earliest time outside quiet hours in every time zone they may be in". Under
 * a hold it adds ", if sending is allowed then".
 */
export function scheduledWords(iso: string, zones: Zones, o: { hold?: boolean; tz?: string; now?: number } = {}): string {
  const tz = o.tz ?? viewerZone();
  const mine = localTime(iso, tz, o.now);
  const theirs = zones.source === 'explicit' && zones.zones.length === 1 ? zones.zones[0]! : null;
  const base = theirs ? `Next AI message planned for ${mine} (${localTime(iso, theirs, o.now)}, their time)` : `Next AI message planned for ${mine}, the earliest time outside quiet hours in every time zone they may be in`;
  return `${base}${o.hold ? ', if sending is allowed then' : ''}.`;
}

/** "by 3:15 PM EST" */
export const byTime = (iso: string, tz?: string, now?: number) => `by ${localTime(iso, tz ?? viewerZone(), now)}`;

/** The API's "N of M today" counts a rolling 24 h (V6): said as what it is; anything else passes through. */
export function capsWords(s: string): string {
  const m = /^(\d+) of (\d+) today$/.exec(s.trim());
  return m ? `${m[1]} of ${m[2]} AI messages in the last 24 hours` : s;
}

/** Quiet hours in words, without the API's fixed window (routes.ts:81). */
export function zonesWords(z: Zones): string {
  if (z.zones.length === 0) return 'No time zone is known for them yet.';
  if (z.source === 'explicit') return `Their time zone was set on the person: ${z.zones[0]}. Messages go only outside quiet hours there.`;
  return `Their time zone is not set, so messages go only outside quiet hours in every time zone they may be in: ${z.zones.join(', ')}.`;
}

export const PAUSE_EXPIRY_MS = 72 * 3_600_000;
