// Relative-date resolution for date-bearing claims (R-AST-2; E34).
//
// "Call me tomorrow" means tomorrow where the CLIENT is, counted from when they SAID it. The phrase
// is resolved deterministically by core (the model's own date arithmetic is never trusted):
//   - against the source timestamp (message time, or call start + the quoted segment's offset);
//   - in the contact's zone (a client in Los Angeles saying "tomorrow" at 8:50 PM PT, which is
//     11:50 PM ET, means the next Pacific calendar day).
// Anything that is genuinely ambiguous ("next Thursday", "at 8", "next week", "in a couple of
// days", a weekday named on that same weekday, a time already past, anything backward-looking or
// negated such as "last Thursday" or "not tomorrow") is AMBIGUOUS, so the claim is
// needs_review and the promise task gets no due date until the agent pins it (R-AST-5).
//
// Hour without am/pm: 9–11 ⇒ morning, 12 ⇒ noon, 1–7 ⇒ afternoon/evening (contact-window
// heuristic); 8 is ambiguous unless qualified ("8 in the morning", "tonight at 8").
import {
  type IanaZone,
  type Instant,
  type LocalDate,
  HOUR_MS,
  MINUTE_MS,
  instant,
  isoWeekdayOfWall,
  localDateOf,
  localTimeFromSeconds,
  resolveLocal,
  wallMs,
} from '../foundation/index.js';

export type DateResolution =
  | { ok: true; at: Instant; allDay: boolean }
  | { ok: false; reason: 'UNRECOGNIZED' | 'AMBIGUOUS' };

const NUMBER_WORDS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};

const WEEKDAYS: [RegExp, number][] = [
  [/^mon(day)?$/, 1],
  [/^tue(s(day)?)?$/, 2],
  [/^wed(nesday)?$/, 3],
  [/^thu(r(s(day)?)?)?$/, 4],
  [/^fri(day)?$/, 5],
  [/^sat(urday)?$/, 6],
  [/^sun(day)?$/, 7],
];
const WEEKDAY_ALT = 'monday|mon|tuesday|tues|tue|wednesday|wed|thursday|thurs|thur|thu|friday|fri|saturday|sat|sunday|sun';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const MONTH_ALT = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec';

const HOUR_WORD = '\\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve';

/** A digit string or a number word the calling regex already restricted to NUMBER_WORDS. */
function num(s: string): number {
  return /^\d+$/.test(s) ? Number(s) : (NUMBER_WORDS[s] as number);
}

function dateParts(d: LocalDate): [number, number, number] {
  const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
  return [y, m, dd];
}

function ymd(y: number, m: number, d: number): LocalDate {
  const w = new Date(Date.UTC(y, m - 1, d));
  return w.toISOString().slice(0, 10) as LocalDate;
}

function addDays(d: LocalDate, n: number): LocalDate {
  const [y, m, dd] = dateParts(d);
  return ymd(y, m, dd + n);
}

function weekdayOfDate(d: LocalDate): number {
  const [y, m, dd] = dateParts(d);
  return isoWeekdayOfWall(Date.UTC(y, m - 1, dd));
}

function validDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  return new Date(Date.UTC(y, m - 1, d)).getUTCDate() === d;
}

type DatePart = { kind: 'date'; date: LocalDate; evening?: boolean } | { kind: 'duration'; ms: number } | { kind: 'ambiguous' } | null;

function parseDate(p: string, today: LocalDate): DatePart {
  // Backward-looking or negated phrases are never a due date ("last Thursday", "yesterday at 4",
  // "not tomorrow", "can't do Friday"): the agent pins those.
  // ("half past three" is a time, not the past.)
  if (/\b(yesterday|last|ago|previous|earlier|not|no|never|can'?t|cannot|won'?t|isn'?t|don'?t|doesn'?t)\b/.test(p)) return { kind: 'ambiguous' };
  if (new RegExp(`\\b(this past|past (week|month|weekend|${WEEKDAY_ALT}))\\b`).test(p)) return { kind: 'ambiguous' };
  if (/\b(next week|this weekend|the weekend|end of (the )?(week|month)|next month|sometime|later|soon|a couple|a few|few days|couple (of )?(days|weeks)|or (two|three|so))\b/.test(p)) {
    return { kind: 'ambiguous' };
  }
  if (/\bmidnight\b/.test(p)) return { kind: 'ambiguous' };
  const dur = new RegExp(`\\bin\\s+(\\d+|${Object.keys(NUMBER_WORDS).join('|')})\\s+(minute|min|hour|hr|day|week)s?\\b`).exec(p);
  if (dur) {
    const n = num(dur[1] as string);
    if (n === 0) return { kind: 'ambiguous' }; // "in 0 days" is not a date anyone means
    const unit = dur[2] as string;
    if (unit === 'minute' || unit === 'min') return { kind: 'duration', ms: n * MINUTE_MS };
    if (unit === 'hour' || unit === 'hr') return { kind: 'duration', ms: n * HOUR_MS };
    return { kind: 'date', date: addDays(today, unit === 'week' ? 7 * n : n) };
  }
  if (/\bday after tomorrow\b/.test(p)) return { kind: 'date', date: addDays(today, 2) };
  if (/\b(tomorrow|tmrw|tmr)\b/.test(p)) {
    return { kind: 'date', date: addDays(today, 1), evening: /\b(tomorrow (evening|night)|tomorrow at night)\b/.test(p) };
  }
  if (/\b(tonight|this evening)\b/.test(p)) return { kind: 'date', date: today, evening: true };
  if (/\b(today|this (morning|afternoon))\b/.test(p)) return { kind: 'date', date: today };

  const wd = new RegExp(`\\b(?:(this|next|coming|on)\\s+)?(${WEEKDAY_ALT})\\b`).exec(p);
  if (wd) {
    const qual = wd[1];
    const name = wd[2] as string;
    const target = (WEEKDAYS.find(([re]) => re.test(name)) as [RegExp, number])[1];
    if (qual === 'next') return { kind: 'ambiguous' };
    const cur = weekdayOfDate(today);
    let delta = (target - cur + 7) % 7;
    if (delta === 0) {
      // Said on that same weekday: "this Thursday" is today, "the coming Thursday" is next week,
      // a bare "Thursday" could be either.
      if (qual === 'coming') delta = 7;
      else if (qual !== 'this') return { kind: 'ambiguous' };
    }
    return { kind: 'date', date: addDays(today, delta) };
  }

  const [ty, tm, td] = dateParts(today);
  const md = new RegExp(`\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`).exec(p);
  const slash = /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/.exec(p);
  if (md || slash) {
    let m: number;
    let d: number;
    let y: number | null = null;
    if (md) {
      m = MONTHS.indexOf((md[1] as string).slice(0, 3)) + 1;
      d = Number(md[2]);
    } else {
      const s = slash as RegExpExecArray;
      m = Number(s[1]);
      d = Number(s[2]);
      if (s[3] !== undefined) y = s[3].length === 2 ? 2000 + Number(s[3]) : Number(s[3]);
    }
    if (y !== null) {
      if (!validDate(y, m, d)) return null;
      const date = ymd(y, m, d);
      return date < today ? { kind: 'ambiguous' } : { kind: 'date', date };
    }
    if (!validDate(ty, m, d) && !validDate(ty + 1, m, d)) return null;
    let date = validDate(ty, m, d) ? ymd(ty, m, d) : ymd(ty + 1, m, d);
    if (date < today) {
      if (!validDate(ty + 1, m, d)) return { kind: 'ambiguous' };
      date = ymd(ty + 1, m, d);
    }
    return { kind: 'date', date };
  }
  const nth = /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/.exec(p);
  if (nth) {
    const d = Number(nth[1]);
    for (let k = 0; k < 3; k++) {
      const y = ty + Math.floor((tm - 1 + k) / 12);
      const m = ((tm - 1 + k) % 12) + 1;
      if (validDate(y, m, d) && (k > 0 || d >= td)) return { kind: 'date', date: ymd(y, m, d) };
    }
    return null;
  }
  return null;
}

type TimePart = { kind: 'time'; seconds: number } | { kind: 'ambiguous' } | null;

function parseTime(p: string, evening: boolean): TimePart {
  if (/\bnoon\b/.test(p)) return { kind: 'time', seconds: 12 * 3600 };
  const explicit = /\b(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)(?![a-z])/.exec(p);
  if (explicit) {
    const h = Number(explicit[1]);
    const mi = explicit[2] === undefined ? 0 : Number(explicit[2]);
    if (h < 1 || h > 12 || mi > 59) return null;
    const pm = (explicit[3] as string).startsWith('p');
    const h24 = (h % 12) + (pm ? 12 : 0);
    return { kind: 'time', seconds: h24 * 3600 + mi * 60 };
  }
  const half = new RegExp(`\\bhalf past (${HOUR_WORD})\\b`).exec(p);
  const loose =
    half ??
    new RegExp(`\\b(?:at|around|about|by|after|before|say|like)\\s+(${HOUR_WORD})(?::(\\d{2})|\\s+(thirty|fifteen|forty[- ]five|o'?clock))?(?![\\d:])\\b`).exec(p) ??
    new RegExp(`\\b(${HOUR_WORD})\\s+o'?clock\\b`).exec(p);
  if (!loose) return null;
  const h = num(loose[1] as string);
  let mi = 0;
  if (half) mi = 30;
  else if (loose[2] !== undefined) mi = Number(loose[2]);
  else if (loose[3] === 'thirty') mi = 30;
  else if (loose[3] === 'fifteen') mi = 15;
  else if (loose[3] !== undefined && loose[3].startsWith('forty')) mi = 45;
  if (mi > 59) return null;
  if (h >= 13 && h <= 23) return { kind: 'time', seconds: h * 3600 + mi * 60 };
  if (h < 1 || h > 12) return null;
  const morning = /\b(in the morning|this morning|tomorrow morning)\b/.test(p);
  const later = evening || /\b(in the afternoon|in the evening|at night|this afternoon|tonight|this evening|tomorrow (afternoon|evening|night))\b/.test(p);
  if (morning && later) return { kind: 'ambiguous' };
  let h24: number;
  if (morning) h24 = h % 12;
  else if (later) {
    if (h === 12) return { kind: 'ambiguous' }; // "tonight at 12": noon or midnight?
    h24 = h + 12;
  }
  else if (h === 12) h24 = 12;
  else if (h >= 1 && h <= 7) h24 = h + 12;
  else if (h >= 9 && h <= 11) h24 = h;
  else return { kind: 'ambiguous' }; // 8 with no qualifier
  return { kind: 'time', seconds: h24 * 3600 + mi * 60 };
}

/**
 * Resolves a spoken/written date phrase against when it was said, in the contact's zone.
 * Deterministic and pure.
 */
export function resolveRelativeDate(phrase: string, saidAt: Instant, zone: IanaZone): DateResolution {
  const p = phrase
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[^a-z0-9:/.' -]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (p === '') return { ok: false, reason: 'UNRECOGNIZED' };
  const today = localDateOf(saidAt, zone);
  const date = parseDate(p, today);
  const evening = date !== null && date.kind === 'date' && date.evening === true;
  const time = parseTime(p, evening);
  if ((date !== null && date.kind === 'ambiguous') || (time !== null && time.kind === 'ambiguous')) return { ok: false, reason: 'AMBIGUOUS' };
  if (date !== null && date.kind === 'duration') return { ok: true, at: instant(saidAt + date.ms), allDay: false };
  if (date === null && time === null) return { ok: false, reason: 'UNRECOGNIZED' };
  if (date === null) {
    const t = time as { kind: 'time'; seconds: number };
    const at = resolveLocal(today, localTimeFromSeconds(t.seconds), zone, 'earlier');
    return at > saidAt ? { ok: true, at, allDay: false } : { ok: false, reason: 'AMBIGUOUS' };
  }
  if (time === null) return { ok: true, at: resolveLocal(date.date, localTimeFromSeconds(0), zone, 'earlier'), allDay: true };
  const at = resolveLocal(date.date, localTimeFromSeconds(time.seconds), zone, 'earlier');
  return at > saidAt ? { ok: true, at, allDay: false } : { ok: false, reason: 'AMBIGUOUS' };
}

const DOW = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Thu Nov 12, 4 PM" / "Thu Nov 12, 4:30 PM" / "Thu Nov 12" (all-day), in `zone`. */
export function formatDue(at: Instant, allDay: boolean, zone: IanaZone): string {
  const w = new Date(wallMs(at, zone));
  const dow = DOW[isoWeekdayOfWall(Date.UTC(w.getUTCFullYear(), w.getUTCMonth(), w.getUTCDate())) - 1];
  const day = `${dow} ${MON[w.getUTCMonth()]} ${w.getUTCDate()}`;
  if (allDay) return day;
  const h = w.getUTCHours();
  const m = w.getUTCMinutes();
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${day}, ${h12}${m === 0 ? '' : `:${String(m).padStart(2, '0')}`} ${h < 12 ? 'AM' : 'PM'}`;
}
