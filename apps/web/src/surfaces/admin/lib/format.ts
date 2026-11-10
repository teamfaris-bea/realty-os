// Pure display helpers for the lead-admin surfaces. No clock is read here; callers pass `now`.

/** 45 → "45 sec", 300 → "5 min", 5400 → "1 h 30 min", 172800 → "2 days". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds)) return '—';
  const s = Math.max(0, Math.round(seconds));
  if (s < 60) return `${s} sec`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86_400) {
    const h = Math.floor(s / 3600);
    const m = Math.round((s % 3600) / 60);
    return m === 0 ? `${h} h` : `${h} h ${m} min`;
  }
  const d = Math.round((s / 86_400) * 10) / 10;
  return `${d} ${d === 1 ? 'day' : 'days'}`;
}

/** "1 day", "3 days", "0.5 days". */
export function formatDays(days: number): string {
  const d = Math.round(days * 10) / 10;
  return `${d} ${d === 1 ? 'day' : 'days'}`;
}

/** "Nov 12, 2026" */
export function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' }).format(d);
}

/** "Nov 12, 4:05 PM" */
export function formatStamp(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d);
}

/** Age of something detected `seconds` ago: "4 min", "3 h", "2 days". */
export function formatAge(seconds: number): string {
  if (seconds < 60) return 'under a minute';
  return formatDuration(seconds);
}

/** "1 lead" / "3 leads". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Dollars typed by a person → cents (null for empty; NaN-safe). "650,000" → 65000000. */
export function dollarsToCents(text: string): number | null {
  const t = text.replace(/[$,\s]/g, '');
  if (t === '') return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
}

export function centsToDollars(cents: unknown): string {
  return typeof cents === 'number' && Number.isFinite(cents) ? String(Math.round(cents / 100)) : '';
}

/** "94110, 94112 94114" → ["94110","94112","94114"] (dedupe, order kept). */
export function parseZips(text: string): string[] {
  return [...new Set(text.split(/[\s,;]+/).map((z) => z.trim()).filter(Boolean))];
}

export const ROLE_OPTIONS = [
  { value: 'owner', label: 'Owner' },
  { value: 'admin', label: 'Admin' },
  { value: 'team_lead', label: 'Team Lead' },
  { value: 'agent', label: 'Agent' },
  { value: 'isa', label: 'ISA' },
  { value: 'tc', label: 'Transaction Coordinator' },
] as const;

export type RoleValue = (typeof ROLE_OPTIONS)[number]['value'];

export function roleLabel(role: string): string {
  return ROLE_OPTIONS.find((r) => r.value === role)?.label ?? role;
}
