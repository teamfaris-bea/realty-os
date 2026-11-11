// Plain-language wording for the insights pages (module 40 review fix): the server's evidence and method sentences
// carry stage codes ("under_contract"), ISO local dates ("due 2026-11-10") and sample notation ("(n=5)"). The
// numbers are kept exactly; only their wording changes. Dates here are LOCAL dates already in the team's zone, so they
// are formatted as calendar days (UTC arithmetic), never shifted by the browser's zone.
import { STAGE_LABEL } from '../owner/types.js';

/** "2026-11-10" → "Tue, Nov 10" (a calendar day, no time-zone shift). */
export function localDayWords(d: string, o: { year?: boolean } = {}): string {
  const [y, m, dd] = d.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, dd)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', ...(o.year ? { year: 'numeric' } : {}), timeZone: 'UTC' });
}

/** An instant as a day in `zone`: "Tue, Nov 10". */
export function instantDayWords(iso: string, zone: string): string {
  return new Date(iso).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: zone });
}

const STAGE_RE = new RegExp(`\\b(${Object.keys(STAGE_LABEL).join('|')})\\b`, 'g');

/** Stage codes → words, ISO days → "Tue, Nov 10", "median 2 (n=5)" → "the team's median is 2 days (from 5 deals)". */
export function humanize(text: string): string {
  return text
    .replace(/median (\d+(?:\.\d+)?) \(n=(\d+)\)/g, (_, d: string, n: string) => `the team’s median is ${d} ${d === '1' ? 'day' : 'days'} (from ${n} ${n === '1' ? 'deal' : 'deals'})`)
    .replace(/\b(\d{4}-\d{2}-\d{2})\b/g, (_, d: string) => localDayWords(d))
    .replace(STAGE_RE, (s: string) => (STAGE_LABEL[s] ?? s).toLowerCase());
}

/** "Week of Mon, Nov 9 to Sun, Nov 15" for an ISO week label. */
export function weekWords(week: string): string {
  const year = Number(week.slice(0, 4));
  const n = Number(week.slice(6));
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7) + (n - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  const f = (d: Date) => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `Week of ${f(monday)} to ${f(sunday)}`;
}

/** A goal period in words: "Week of Nov 9", "November 2026", "Q4 2026", "2026". */
export function periodWords(kind: 'week' | 'month' | 'quarter' | 'year', start: string): string {
  const [y, m, d] = start.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  if (kind === 'week') return `Week of ${date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' })}`;
  if (kind === 'month') return date.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
  if (kind === 'quarter') return `Q${Math.floor((m - 1) / 3) + 1} ${y}`;
  return String(y);
}
