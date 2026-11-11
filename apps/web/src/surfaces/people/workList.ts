// "Next person" when working a list (PARITY_PLAN §5: Next = 1 tap; J / → on desktop). The People page
// records the list it opened a person from (its source and the ids loaded so far, in list order) in
// sessionStorage, so the work page can step through it and fetch the next page when it runs out.
// Only ids are stored (no names or other PII), and only for this browser tab's session.
import type { Source } from './api.js';

const KEY = 'realty.people.work';

export interface WorkList {
  source: Source;
  ids: string[];
  nextCursor: string | null;
}

function store(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function startWork(source: Source, ids: string[], nextCursor: string | null = null): void {
  store()?.setItem(KEY, JSON.stringify({ source, ids, nextCursor } satisfies WorkList));
}

export function readWork(): WorkList | null {
  const raw = store()?.getItem(KEY);
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as WorkList;
    return Array.isArray(v.ids) && v.source ? v : null;
  } catch {
    return null;
  }
}

export function extendWork(ids: string[], nextCursor: string | null): WorkList | null {
  const w = readWork();
  if (!w) return null;
  const seen = new Set(w.ids);
  const next = { ...w, ids: [...w.ids, ...ids.filter((x) => !seen.has(x))], nextCursor };
  store()?.setItem(KEY, JSON.stringify(next));
  return next;
}

/** Where `id` sits in the work list and who comes next / before (pure; unit-tested). */
export function stepOf(w: WorkList | null, id: string): { index: number; next: string | null; prev: string | null } {
  if (!w) return { index: -1, next: null, prev: null };
  const i = w.ids.indexOf(id);
  return { index: i, next: i >= 0 ? (w.ids[i + 1] ?? null) : null, prev: i > 0 ? (w.ids[i - 1] ?? null) : null };
}
