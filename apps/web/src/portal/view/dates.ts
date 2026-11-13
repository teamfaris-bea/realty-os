// module 46 (R-PORTALWEB-5, E690): dates as the client reads them. A LocalDate (YYYY-MM-DD) is its calendar date in
// every zone: built with Date.UTC and formatted in UTC, never `new Date('YYYY-MM-DD')`, exactly as the staff formatter
// (surfaces/feed/lib/format.ts formatLocalDate). An instant ("Shared …") is shown in the viewer's own zone. Pure.

/** "Dec 18, 2026" for "2026-12-18" in every zone; the input unchanged when it is not a date. */
export function formatLocalDate(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(d);
}

/** "Nov 13, 2026" for an ISO instant in the viewer's zone (or `zone`, for tests). */
export function formatShared(iso: string, zone?: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', ...(zone ? { timeZone: zone } : {}) }).format(new Date(t));
}
