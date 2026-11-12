// findContractDates (deliverable 6; R-DOC-2, E416): pure, deterministic. No model reads contract text (R-DOC-2).
//
// A candidate is a label from the built-in table followed, on the same page and within 80 characters, by an absolute
// date (US month-first: MM/DD/YYYY, M/D/YY read as 20YY, "Month D, YYYY", or YYYY-MM-DD). Invalid calendar dates are
// dropped. A relative deadline ("10 days after acceptance") between the label and the date, or another label in
// between, voids the pairing: the finder never turns a number of days into a date (E416). The snippet is exactly
// page.text.slice(start, end) (at most 160 characters); at most 50 candidates, in page and position order, the first
// of each (milestone, date) pair only.
//
// The label table has NOT been reviewed (contract forms differ by state and board): every candidate is a proposal a
// person confirms one by one, never a date by itself (R-TXN-1). VERIFY WITH COUNSEL before widening it.
import type { MilestoneKind } from '@realty/core/transactions';

export interface LabelEntry {
  kind: Exclude<MilestoneKind, 'custom'>;
  label: string;
  patterns: readonly RegExp[];
}

export const LABELS_V1: readonly LabelEntry[] = [
  { kind: 'closing', label: 'Closing', patterns: [/\bclosing\b/gi, /\bsettlement\b/gi] },
  { kind: 'inspection', label: 'Inspection', patterns: [/\binspections?\b/gi, /\bdue diligence\b/gi] },
  { kind: 'appraisal', label: 'Appraisal', patterns: [/\bappraisal\b/gi] },
  { kind: 'financing', label: 'Financing', patterns: [/\bfinancing\b/gi, /\bloan commitment\b/gi] },
  { kind: 'acceptance', label: 'Acceptance', patterns: [/\beffective\b/gi, /\bacceptance\b/gi, /\bbinding agreement\b/gi] },
  { kind: 'possession', label: 'Possession', patterns: [/\bpossession\b/gi] },
];
export const FINDER_VERSION = 'labels/1';

export const LABEL_WINDOW = 80;
export const SNIPPET_LIMIT = 160;
export const MAX_CANDIDATES = 50;

export interface Candidate {
  kind: LabelEntry['kind'];
  label: string;
  /** YYYY-MM-DD */
  dueOn: string;
  page: number;
  start: number;
  end: number;
  snippet: string;
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DATE_RE = new RegExp(
  [
    String.raw`\b(?<y1>\d{4})-(?<m1>\d{2})-(?<d1>\d{2})\b`,
    String.raw`\b(?<m2>\d{1,2})/(?<d2>\d{1,2})/(?<y2>\d{4}|\d{2})\b`,
    String.raw`\b(?<mn>${MONTHS.join('|')})\s+(?<d3>\d{1,2}),?\s+(?<y3>\d{4})\b`,
  ].join('|'),
  'gi',
);
/** A number of days (or business/calendar days) is a relative deadline (E416). */
const RELATIVE_RE = /\b\d+\s*(?:\(\s*\d+\s*\)\s*)?(?:calendar\s+|business\s+|banking\s+)?days?\b/i;

const pad = (n: number) => String(n).padStart(2, '0');

/** A valid calendar date as YYYY-MM-DD, or null. */
export function isoDate(y: number, m: number, d: number): string | null {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d) || y < 1900 || y > 2199 || m < 1 || m > 12 || d < 1) return null;
  const dt = new Date(Date.UTC(y, m - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null;
  return `${y}-${pad(m)}-${pad(d)}`;
}

export interface DateMatch {
  start: number;
  end: number;
  /** null: the text looks like a date but is no calendar date (dropped) */
  iso: string | null;
}

/** Every absolute date in `text`, in order. */
export function datesIn(text: string): DateMatch[] {
  const out: DateMatch[] = [];
  for (const m of text.matchAll(DATE_RE)) {
    const g = m.groups ?? {};
    let iso: string | null;
    if (g['y1'] !== undefined) iso = isoDate(Number(g['y1']), Number(g['m1']), Number(g['d1']));
    else if (g['y2'] !== undefined) {
      const yRaw = g['y2'];
      iso = isoDate(yRaw.length === 2 ? 2000 + Number(yRaw) : Number(yRaw), Number(g['m2']), Number(g['d2']));
    } else iso = isoDate(Number(g['y3']), MONTHS.indexOf(String(g['mn']).toLowerCase()) + 1, Number(g['d3']));
    out.push({ start: m.index, end: m.index + m[0].length, iso });
  }
  return out;
}

interface LabelHit {
  entry: LabelEntry;
  start: number;
  end: number;
}

function labelsIn(text: string, table: readonly LabelEntry[]): LabelHit[] {
  const hits: LabelHit[] = [];
  for (const entry of table) for (const re of entry.patterns) for (const m of text.matchAll(new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`))) hits.push({ entry, start: m.index, end: m.index + m[0].length });
  hits.sort((a, b) => a.start - b.start || b.end - a.end);
  // overlapping hits (e.g. "inspection" inside a longer phrase): keep the first, longest
  const out: LabelHit[] = [];
  for (const h of hits) if (!out.some((o) => h.start < o.end && o.start < h.end)) out.push(h);
  return out;
}

export function findContractDates(pages: readonly { page: number; text: string }[], table: readonly LabelEntry[] = LABELS_V1): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const ordered = [...pages].sort((a, b) => a.page - b.page);
  for (const p of ordered) {
    const labels = labelsIn(p.text, table);
    const dates = datesIn(p.text);
    for (const [i, l] of labels.entries()) {
      const next = labels[i + 1];
      const d = dates.find((x) => x.start >= l.end && x.start - l.end <= LABEL_WINDOW && (next === undefined || x.start < next.start));
      if (!d || d.iso === null) continue;
      if (RELATIVE_RE.test(p.text.slice(l.end, d.start))) continue;
      if (d.end - l.start > SNIPPET_LIMIT) continue;
      const key = `${l.entry.kind}:${d.iso}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: l.entry.kind, label: l.entry.label, dueOn: d.iso, page: p.page, start: l.start, end: d.end, snippet: p.text.slice(l.start, d.end) });
      if (out.length >= MAX_CANDIDATES) return out;
    }
  }
  return out;
}

/** Whether the page mentions a relative deadline next to a label (the view's honest note, E416). */
export function hasRelativeDeadline(pages: readonly { page: number; text: string }[], table: readonly LabelEntry[] = LABELS_V1): boolean {
  for (const p of pages) for (const l of labelsIn(p.text, table)) if (RELATIVE_RE.test(p.text.slice(l.end, l.end + LABEL_WINDOW))) return true;
  return false;
}
