// The projected move window (DATA_MODEL R-TCUE-4). Computed from the day the words were WRITTEN, never from today:
// "selling in April" in a June 2025 note is April 2026, and on Nov 21, 2026 that window has passed. (The notes pilot
// first bucketed against today, so a mid-2025 "sell April 2026" still ranked as 0-3 months: that is the bug this
// rule closes.) The words' own time wins ("lease ends March", "PCS next summer", "after the holidays", "maybe next
// year"); only when they name none does the model's timeframe bucket, counted from the day written, give the window.
// Pure: calendar dates as 'YYYY-MM-DD', no clock, no zone (the caller passes the day in the team's zone).
import type { CueTimeframe, MoveWindow } from './types.js';

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'] as const;
const MONTH_LABEL = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const MONTH_WORD = String.raw`(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sept?(?:ember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\.?`;
type Season = 'spring' | 'summer' | 'fall' | 'winter';
/** first month (1-12) of each season; winter runs Dec–Feb */
const SEASON_START: Record<Season, number> = { spring: 3, summer: 6, fall: 9, winter: 12 };
const WORD_NUM: Record<string, number> = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, couple: 2, 'couple of': 2, few: 3 };

export interface Ymd {
  y: number;
  m: number; // 1-12
  d: number;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function parseYmd(s: string): Ymd {
  const m = DATE_RE.exec(s);
  if (!m) throw new RangeError(`not a calendar date: ${s}`);
  const v = { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) };
  if (v.m < 1 || v.m > 12 || v.d < 1 || v.d > daysInMonth(v.y, v.m)) throw new RangeError(`not a calendar date: ${s}`);
  return v;
}

export function fmtYmd(v: Ymd): string {
  return `${String(v.y).padStart(4, '0')}-${String(v.m).padStart(2, '0')}-${String(v.d).padStart(2, '0')}`;
}

export function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

/** `n` calendar months later (or earlier), the day clamped to the month's length. */
export function addMonths(s: string, n: number): string {
  const v = parseYmd(s);
  const idx = v.y * 12 + (v.m - 1) + n;
  const y = Math.floor(idx / 12);
  const m = (idx % 12) + 1;
  return fmtYmd({ y, m, d: Math.min(v.d, daysInMonth(y, m)) });
}

const firstOf = (y: number, m: number): string => fmtYmd({ y, m, d: 1 });
const lastOf = (y: number, m: number): string => fmtYmd({ y, m, d: daysInMonth(y, m) });
/** month index (y*12 + m-1) → [y, m] */
const ym = (idx: number): [number, number] => [Math.floor(idx / 12), (idx % 12) + 1];
const monthLabel = (y: number, m: number): string => `${MONTH_LABEL[m - 1]} ${y}`;

function monthsWindow(startIdx: number, endIdx: number, precision: MoveWindow['precision'], label?: string): MoveWindow {
  const [sy, sm] = ym(startIdx);
  const [ey, em] = ym(endIdx);
  return {
    start: firstOf(sy, sm),
    end: lastOf(ey, em),
    precision,
    basis: 'stated',
    label: label ?? (startIdx === endIdx ? monthLabel(sy, sm) : `${monthLabel(sy, sm)}–${monthLabel(ey, em)}`),
  };
}

function monthNumber(word: string): number {
  return MONTHS.indexOf(word.slice(0, 3).toLowerCase() as (typeof MONTHS)[number]) + 1;
}

function seasonOf(word: string): Season {
  const w = word.toLowerCase();
  return w === 'autumn' ? 'fall' : (w as Season);
}

/** The month index range of `season` in the season-year that STARTS in calendar year `y` (winter y = Dec y – Feb y+1). */
function seasonRange(season: Season, y: number): [number, number] {
  const start = y * 12 + (SEASON_START[season] - 1);
  return [start, start + 2];
}

function seasonWindow(season: Season, y: number): MoveWindow {
  const [s, e] = seasonRange(season, y);
  return monthsWindow(s, e, 'season', `${season} ${season === 'winter' ? `${y}–${String(y + 1).slice(2)}` : y}`);
}

function num(word: string): number {
  const w = word.toLowerCase().replace(/\s+/g, ' ');
  return /^\d+$/.test(w) ? Number(w) : (WORD_NUM[w] ?? NaN);
}

interface Ctx {
  /** the day written as a month index */
  w: number;
  wy: number;
  wm: number;
  written: string;
}

type Rule = (t: string, c: Ctx) => MoveWindow | null;

// Ordered most specific first; the first rule that matches wins.
const RULES: Rule[] = [
  // "March 2027", "Mar. of 2027"
  (t) => {
    const m = new RegExp(String.raw`\b${MONTH_WORD}\s*(?:of\s+|,\s*)?(20\d\d)\b`, 'i').exec(t);
    if (!m) return null;
    const idx = Number(m[2]) * 12 + monthNumber(m[1]!) - 1;
    return monthsWindow(idx, idx, 'month');
  },
  // "summer 2027", "spring of 2026"
  (t) => {
    const m = /\b(spring|summer|fall|autumn|winter)\s*(?:of\s+)?(20\d\d)\b/i.exec(t);
    if (!m) return null;
    const season = seasonOf(m[1]!);
    const y = Number(m[2]);
    // "winter 2027" means the winter that is mostly in 2027 (Dec 2026 – Feb 2027)
    return seasonWindow(season, season === 'winter' ? y - 1 : y);
  },
  // "early 2027", "mid-2026", "late 2026", "end of 2026"
  (t) => {
    const m = /\b(early|mid|late|end\s+of)\s*-?\s*(?:in\s+)?(20\d\d)\b/i.exec(t);
    if (!m) return null;
    const y = Number(m[2]);
    const part = m[1]!.toLowerCase().replace(/\s+/g, ' ');
    const [a, b] = part === 'early' ? [1, 4] : part === 'mid' ? [5, 8] : part === 'late' ? [9, 12] : [11, 12];
    return monthsWindow(y * 12 + a - 1, y * 12 + b - 1, 'range', `${part} ${y}`);
  },
  // "3-6 months", "0-3 months", "1 to 2 years" (a form field or a stated range), counted from the day written
  (t, c) => {
    const m = /\b(\d+)\s*(?:-|–|to)\s*(\d+)\s*(months?|mos?|years?|yrs?)\b/i.exec(t);
    if (!m) return null;
    const k = /^y/i.test(m[3]!) ? 12 : 1;
    const a = Number(m[1]) * k;
    const b = Number(m[2]) * k;
    if (!(b >= a) || b > 60) return null;
    return { start: addMonths(c.written, a), end: addMonths(c.written, b), precision: 'range', basis: 'stated', label: rangeLabel(addMonths(c.written, a), addMonths(c.written, b)) };
  },
  // "within 6 months", "in the next 3 months"
  (t, c) => {
    const m = /\b(?:within|in\s+the\s+next|over\s+the\s+next|next)\s+(\d+|a|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple(?:\s+of)?|few)\s+(months?|years?)\b/i.exec(t);
    if (!m) return null;
    const n = num(m[1]!) * (/^y/i.test(m[2]!) ? 12 : 1);
    if (!Number.isFinite(n) || n <= 0 || n > 60) return null;
    return { start: c.written, end: addMonths(c.written, n), precision: 'range', basis: 'stated', label: rangeLabel(c.written, addMonths(c.written, n)) };
  },
  // "in 6 months", "6 months out", "about a year from now", "in a couple of months"
  (t, c) => {
    const m = /\b(?:in\s+(?:about\s+|around\s+)?)?(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|couple(?:\s+of)?|few)\s+(months?|years?)(\s+(?:from\s+now|out|away))?\b/i.exec(t);
    if (!m) return null;
    // a bare "a year" with no "in" / "from now" is too loose ("bought a year ago")
    if (!/^in\b/i.test(m[0]) && !m[3]) return null;
    const n = num(m[1]!) * (/^y/i.test(m[2]!) ? 12 : 1);
    if (!Number.isFinite(n) || n <= 0 || n > 60) return null;
    const spread = n >= 12 ? 2 : 1;
    const s = addMonths(c.written, n - spread);
    const e = addMonths(c.written, n + spread);
    return { start: s, end: e, precision: 'range', basis: 'stated', label: rangeLabel(s, e) };
  },
  // "this/next/coming summer", "by the spring", "in the fall", "PCS next summer"
  (t, c) => {
    const m = /\b(this|next|coming|by|in|until|til|till|around|before|after)\s+(?:the\s+)?(spring|summer|fall|autumn|winter)\b/i.exec(t);
    if (!m) return null;
    const q = m[1]!.toLowerCase();
    const season = seasonOf(m[2]!);
    // the season-year whose range is current or next after the day written
    let y = c.wy - 1;
    while (seasonRange(season, y)[1] < c.w) y++;
    const [s] = seasonRange(season, y);
    const current = s <= c.w;
    if (q === 'next' && current) y++;
    if (q === 'after') return monthsWindow(seasonRange(season, y)[1] + 1, seasonRange(season, y)[1] + 3, 'range');
    return seasonWindow(season, y);
  },
  // "after the holidays", "after the new year", "first of the year", "after Christmas"
  (t, c) => {
    if (!/\b(?:after|following)\s+(?:the\s+)?(?:holidays?|new\s+year(?:'s)?|christmas|first\s+of\s+the\s+year)\b|\b(?:first|beginning|start)\s+of\s+(?:the\s+)?(?:new\s+)?year\b|\bin\s+the\s+new\s+year\b/i.test(t)) return null;
    // written Jan–Feb: the holidays just passed, the window is now; otherwise the coming Jan–Feb
    const y = c.wm <= 2 ? c.wy : c.wy + 1;
    const w = monthsWindow(y * 12, y * 12 + 1, 'range', `Jan–Feb ${y}`);
    return c.wm <= 2 ? { ...w, start: c.written } : w;
  },
  // "before the holidays", "by Christmas", "by Thanksgiving", "end of the year", "by year end"
  (t, c) => {
    if (!/\b(?:before|by)\s+(?:the\s+)?(?:holidays?|christmas|thanksgiving|year[\s-]?end|end\s+of\s+(?:the\s+)?year)\b|\bend\s+of\s+(?:the|this)\s+year\b|\b(?:later\s+)?this\s+year\b/i.test(t)) return null;
    return { start: c.written, end: lastOf(c.wy, 12), precision: 'range', basis: 'stated', label: rangeLabel(c.written, lastOf(c.wy, 12)) };
  },
  // "next year", "maybe next year"
  (_t, c) => {
    if (!/\bnext\s+year\b/i.test(_t)) return null;
    const y = c.wy + 1;
    return monthsWindow(y * 12, y * 12 + 11, 'year', String(y));
  },
  // "next month", "this month", "end of the month"
  (t, c) => {
    const m = /\b(next|this|end\s+of\s+(?:the|this))\s+month\b/i.exec(t);
    if (!m) return null;
    const idx = m[1]!.toLowerCase() === 'next' ? c.w + 1 : c.w;
    return monthsWindow(idx, idx, 'month');
  },
  // a month name: "lease ends March", "in June", "by Oct", "after August" (bare "may" only after a preposition)
  (t, c) => {
    const re = new RegExp(String.raw`\b(?:(next|after|until|til|till|by|in|ends?|ending|up\s+in|of|around|before|early|mid|late|end\s+of|starting|this)\s+)?${MONTH_WORD}(?![\w'])`, 'gi');
    for (const m of t.matchAll(re)) {
      const word = m[2]!;
      const prep = (m[1] ?? '').toLowerCase().replace(/\s+/g, ' ');
      // without a preposition, words that are also verbs or first names ("may", "march", "Jan", "June", "April") are not a month
      if (prep === '' && /^(?:may|mar|march|jan|june|april|aug|august)$/i.test(word) && !/^March$/.test(word)) continue;
      const mn = monthNumber(word);
      // the next occurrence of that month whose end is on or after the day written (the written month counts)
      let idx = c.wy * 12 + mn - 1;
      if (idx < c.w) idx += 12;
      if (prep === 'next' && idx === c.w) idx += 12;
      if (prep === 'after') return monthsWindow(idx + 1, idx + 2, 'range');
      if (prep === 'before') return { start: c.written, end: lastOf(...ym(Math.max(c.w, idx - 1))), precision: 'range', basis: 'stated', label: rangeLabel(c.written, lastOf(...ym(Math.max(c.w, idx - 1)))) };
      return monthsWindow(idx, idx, 'month');
    }
    return null;
  },
  // a bare future year: "in 2027", "by 2027", "2027"
  (t, c) => {
    for (const m of t.matchAll(/\b(20\d\d)\b/g)) {
      const y = Number(m[1]);
      if (y < c.wy || y > c.wy + 5) continue;
      if (y === c.wy) return { start: c.written, end: lastOf(y, 12), precision: 'year', basis: 'stated', label: String(y) };
      return monthsWindow(y * 12, y * 12 + 11, 'year', String(y));
    }
    return null;
  },
];

function rangeLabel(start: string, end: string): string {
  const a = parseYmd(start);
  const b = parseYmd(end);
  return a.y === b.y && a.m === b.m ? monthLabel(a.y, a.m) : `${monthLabel(a.y, a.m)}–${monthLabel(b.y, b.m)}`;
}

/** Months [from, to] after the day written for each timeframe bucket. */
export const TIMEFRAME_MONTHS: Record<Exclude<CueTimeframe, 'unknown'>, [number, number]> = {
  '0-3mo': [0, 3],
  '3-6mo': [3, 6],
  '6-12mo': [6, 12],
  '12+mo': [12, 24],
};

/**
 * The window the words point at, from the day they were written (`writtenOn`, 'YYYY-MM-DD' in the team's zone).
 * `snippet` is the verified quote; `timeframe` is the model's bucket. Null when neither gives a time.
 */
export function projectWindow(i: { writtenOn: string; snippet: string; timeframe: CueTimeframe }): MoveWindow | null {
  const v = parseYmd(i.writtenOn);
  const c: Ctx = { w: v.y * 12 + v.m - 1, wy: v.y, wm: v.m, written: i.writtenOn };
  const t = i.snippet.replace(/\s+/g, ' ');
  for (const rule of RULES) {
    const w = rule(t, c);
    if (w) return w;
  }
  if (i.timeframe === 'unknown') return null;
  const [a, b] = TIMEFRAME_MONTHS[i.timeframe];
  const start = addMonths(i.writtenOn, a);
  const end = addMonths(i.writtenOn, b);
  return { start, end, precision: 'range', basis: 'timeframe', label: rangeLabel(start, end) };
}
