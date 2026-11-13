// Coaching trends, pure (module 54; DATA_MODEL R-COACH-7, R-COACH-8). No I/O, no clock.
//
//   mirror(scores, members, caller)   what app.coaching_trends returns for these scored calls: counts per (member, window,
//                                     item) and, for more than one member, per (all of them, window, item), with the same
//                                     floor (met only when scored >= TREND_FLOOR and, unless the caller asked for exactly
//                                     themselves, every (member, week, item) cell inside has 0 or >= TREND_FLOOR scored).
//                                     The equivalence test runs it against the definer on the same fixtures.
//   toTrendScores(rows)               per window, a CallScore list core's trend() reads: met calls and missed calls per
//                                     item; an item whose met is withheld gets no entry (core sees n = 0 and answers
//                                     not_enough_data). So core/coaching decides the direction, unedited: one rule.
//   trendItems(rows, …)               the response items: the definer's counts (never core's metRate) and core's direction.
// Aggregates only: no call id, contact id, quote, score, grade, rank or percentage leaves this file.
import { type CallScore, RUBRIC_V1, type Rubric, TREND_MIN_SCORED, type TrendDirection, trend } from '@realty/core/coaching';

/** The definer's floor (0079: 5). The equivalence test proves it equals core's TREND_MIN_SCORED. */
export const TREND_FLOOR = 5;
void TREND_MIN_SCORED;

export type WindowKind = 'before' | 'after';

/** One row of app.coaching_trends. agentUserId null: all named members together. */
export interface TrendRow {
  agentUserId: string | null;
  windowKind: WindowKind;
  itemKey: string;
  scored: number;
  met: number | null;
  calls: number;
}

/** One scored call as the definer sees it: its agent, which window and ISO week it fell in, and its items. */
export interface WindowedScore {
  agentUserId: string;
  callId: string;
  windowKind: WindowKind;
  /** the local ISO week (its Monday, YYYY-MM-DD) */
  week: string;
  items: readonly { key: string; status: string }[];
}

/** The first entry per item key, as core's trend() reads it (Array.find). */
function firstEntries(items: WindowedScore['items']): Map<string, string> {
  const m = new Map<string, string>();
  for (const it of items) if (typeof it.key === 'string' && !m.has(it.key)) m.set(it.key, it.status);
  return m;
}

const scoredStatus = (s: string) => s === 'met' || s === 'missed';

export function mirror(scores: readonly WindowedScore[], members: readonly string[], caller: string): TrendRow[] {
  const ids = new Set(members);
  const mine = scores.filter((s) => ids.has(s.agentUserId));
  const self = members.length === 1 && members[0] === caller;
  // cells: (member, window, week, item) → scored
  const cell = new Map<string, number>();
  type Acc = { scored: number; met: number; whole: boolean; keys: Set<string> };
  const rows = new Map<string, Acc & { who: string | null; kind: WindowKind; item: string }>();
  const calls = new Map<string, Set<string>>();
  const cellKey = (u: string, k: WindowKind, w: string, i: string) => `${u}|${k}|${w}|${i}`;
  for (const s of mine) {
    for (const who of members.length > 1 ? [s.agentUserId, null] : [s.agentUserId]) {
      const ck = `${who}|${s.windowKind}`;
      if (!calls.has(ck)) calls.set(ck, new Set());
      calls.get(ck)!.add(s.callId);
    }
    for (const [item, st] of firstEntries(s.items)) {
      const c = cellKey(s.agentUserId, s.windowKind, s.week, item);
      cell.set(c, (cell.get(c) ?? 0) + (scoredStatus(st) ? 1 : 0));
      for (const who of members.length > 1 ? [s.agentUserId, null] : [s.agentUserId]) {
        const rk = `${who}|${s.windowKind}|${item}`;
        const r = rows.get(rk) ?? { who, kind: s.windowKind, item, scored: 0, met: 0, whole: true, keys: new Set<string>() };
        if (scoredStatus(st)) r.scored += 1;
        if (st === 'met') r.met += 1;
        r.keys.add(c);
        rows.set(rk, r);
      }
    }
  }
  const out: TrendRow[] = [];
  for (const r of rows.values()) {
    const whole = [...r.keys].every((k) => {
      const n = cell.get(k) ?? 0;
      return n === 0 || n >= TREND_FLOOR;
    });
    const shown = r.scored >= TREND_FLOOR && ((self && r.who !== null) || whole);
    out.push({ agentUserId: r.who, windowKind: r.kind, itemKey: r.item, scored: r.scored, met: shown ? r.met : null, calls: calls.get(`${r.who}|${r.kind}`)!.size });
  }
  return out.sort(compareRows);
}

export function compareRows(a: TrendRow, b: TrendRow): number {
  const w = (x: string | null) => x ?? '￿';
  return w(a.agentUserId).localeCompare(w(b.agentUserId)) || a.windowKind.localeCompare(b.windowKind) || a.itemKey.localeCompare(b.itemKey);
}

/** Rows of one member (or of the group: null) → the two CallScore lists core's trend() reads. */
export function toTrendScores(rows: readonly TrendRow[], who: string | null, rubric: Rubric = RUBRIC_V1): { before: CallScore[]; after: CallScore[] } {
  const out: { before: CallScore[]; after: CallScore[] } = { before: [], after: [] };
  for (const r of rows) {
    if (r.agentUserId !== who || r.met === null) continue;
    for (let i = 0; i < r.scored; i++) {
      const met = i < r.met;
      out[r.windowKind].push({ rubricVersion: rubric.version, items: [{ key: r.itemKey, status: met ? 'met' : 'missed', claimId: null, quotes: [] }], metCount: met ? 1 : 0, scoredCount: 1 });
    }
  }
  return out;
}

export interface WindowCounts {
  calls: number;
  scored: number;
  /** null: withheld (fewer than 5 scored, or a small week inside: R-COACH-8) */
  met: number | null;
}

export interface TrendItemView {
  key: string;
  label: string;
  before: WindowCounts;
  after: WindowCounts;
  direction: TrendDirection;
  sentence: string;
}

/** The items for one member (or the group), in rubric order, without the disabled ones. */
export function trendItems(rows: readonly TrendRow[], who: string | null, weeks: number, o: { rubric?: Rubric; disabledKeys?: readonly string[] } = {}): TrendItemView[] {
  const rubric = o.rubric ?? RUBRIC_V1;
  const { before, after } = toTrendScores(rows, who, rubric);
  const core = trend(before, after, { rubric, disabledKeys: o.disabledKeys ?? [] });
  const callsOf = (k: WindowKind) => rows.find((r) => r.agentUserId === who && r.windowKind === k)?.calls ?? 0;
  const counts = (k: WindowKind, key: string): WindowCounts => {
    const r = rows.find((x) => x.agentUserId === who && x.windowKind === k && x.itemKey === key);
    return { calls: callsOf(k), scored: r?.scored ?? 0, met: r?.met ?? null };
  };
  return core.map((t) => {
    const b = counts('before', t.key);
    const a = counts('after', t.key);
    return { key: t.key, label: t.label, before: b, after: a, direction: t.direction, sentence: itemSentence(t.direction, b, a, weeks) };
  });
}

// the later window is the last complete week(s): the current week is never counted
const period = (weeks: number) => (weeks === 1 ? 'last week' : `in the last ${weeks} weeks`);
const WORD: Record<Exclude<TrendDirection, 'not_enough_data'>, string> = { improving: 'Improving', slipping: 'Slipping', steady: 'Steady' };

/** "Improving: met in 6 of 8, then 9 of 10" or why there is nothing to compare yet (the later window's n). */
export function itemSentence(d: TrendDirection, b: WindowCounts, a: WindowCounts, weeks: number): string {
  if (d !== 'not_enough_data' && b.met !== null && a.met !== null) return `${WORD[d]}: met in ${b.met} of ${b.scored}, then ${a.met} of ${a.scored}`;
  // E473: below the floor, or withheld for a small week inside (the n is still shown)
  return `Not enough reviewed calls yet (${a.scored} ${period(weeks)})`;
}
