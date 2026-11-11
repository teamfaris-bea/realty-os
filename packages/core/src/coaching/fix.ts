// The daily fix: one thing to work on today (R-COACH-4, E106).
//
//   - Window: the agent's last 10 scored calls, most recent first (occurredAt desc, then callId asc
//     for equal times). A call counts as scored only when its review has at least one met/missed
//     item (scoredCount >= 1); reviews of any rubric version count, and their items are matched by
//     key to the given rubric (keys not in it, or disabled, are ignored).
//   - Fewer than 3 scored calls ⇒ no fix ("Not enough calls yet", E106). No data ⇒ no card.
//   - The item missed most often in the window, never one dismissed in the last 7 days (the API
//     computes that set) and never a disabled one. Ties: the item missed most recently, then
//     rubric order.
//   - Up to two quotes from the most recent misses, preferring one per call, for tap-to-play.
//   - One fix per agent per local day: the card key is coachingFixKey(userId, localDate).
// The fix never feeds routing, ownership, prediction or the scoreboard (R-COACH-5).
import type { LocalDate, UserId } from '../foundation/index.js';
import { RUBRIC_V1 } from './rubric.js';
import type { DailyFixOptions, DailyFixResult, Fix, FixQuote, NoFixReason, ScoredCall } from './types.js';

export const FIX_WINDOW_CALLS = 10;
export const FIX_MIN_CALLS = 3;
export const FIX_MAX_QUOTES = 2;

/** What the UI may say when there is no fix (only not_enough_calls is normally shown). */
export const NO_FIX_TEXT: Readonly<Record<NoFixReason, string>> = {
  not_enough_calls: 'Not enough calls yet',
  nothing_missed: 'Nothing to fix from your recent calls',
  all_dismissed: 'Nothing new to fix today',
};

/** The feed card key: one coaching fix per agent per local day. */
export function coachingFixKey(userId: UserId, localDate: LocalDate): string {
  return `coaching_fix:${userId}:${localDate}`;
}

function byRecency(a: ScoredCall, b: ScoredCall): number {
  if (a.occurredAt !== b.occurredAt) return b.occurredAt - a.occurredAt;
  return a.callId < b.callId ? -1 : a.callId > b.callId ? 1 : 0;
}

/** The scored calls the fix looks at: most recent first, at most 10. */
export function fixWindow(scores: readonly ScoredCall[]): ScoredCall[] {
  return scores.filter((s) => s.score.scoredCount > 0).sort(byRecency).slice(0, FIX_WINDOW_CALLS);
}

export function dailyFixResult(
  scores: readonly ScoredCall[],
  dismissed7d: ReadonlySet<string> | readonly string[],
  localDate: LocalDate,
  opts: DailyFixOptions = {},
): DailyFixResult {
  const window = fixWindow(scores);
  if (window.length < FIX_MIN_CALLS) return { fix: null, reason: 'not_enough_calls' };
  const rubric = opts.rubric ?? RUBRIC_V1;
  const dismissed = new Set(dismissed7d);
  const disabled = new Set(opts.disabledKeys ?? []);

  // per key: miss count and the window indexes of its misses (ascending = most recent first)
  const misses = new Map<string, number[]>();
  window.forEach((call, idx) => {
    for (const it of call.score.items) {
      if (it.status !== 'missed') continue;
      const list = misses.get(it.key);
      if (list) {
        if (list[list.length - 1] !== idx) list.push(idx); // a key counts once per call
      } else misses.set(it.key, [idx]);
    }
  });

  let anyMissed = false;
  let best: { order: number; idxs: number[] } | null = null;
  for (const [order, item] of rubric.items.entries()) {
    if (disabled.has(item.key)) continue;
    const idxs = misses.get(item.key);
    if (idxs === undefined) continue;
    anyMissed = true;
    if (dismissed.has(item.key)) continue;
    // equal count and equal most-recent miss: the earlier rubric item (already in `best`) wins
    if (best === null || idxs.length > best.idxs.length || (idxs.length === best.idxs.length && (idxs[0] as number) < (best.idxs[0] as number))) {
      best = { order, idxs };
    }
  }
  if (best === null) return { fix: null, reason: anyMissed ? 'all_dismissed' : 'nothing_missed' };
  const chosen = best;
  const item = rubric.items[chosen.order] as (typeof rubric.items)[number];

  // quotes: first pass one per call (most recent miss first), second pass fills up to the max
  const quotes: FixQuote[] = [];
  const perCall = chosen.idxs.map((idx) => {
    const call = window[idx] as ScoredCall;
    const scored = call.score.items.find((it) => it.key === item.key && it.status === 'missed');
    return { callId: call.callId, refs: scored?.quotes ?? [] };
  });
  for (const pass of [0, 1]) {
    for (const c of perCall) {
      const refs = pass === 0 ? c.refs.slice(0, 1) : c.refs.slice(1);
      for (const ref of refs) if (quotes.length < FIX_MAX_QUOTES) quotes.push({ callId: c.callId, ref });
    }
  }

  const missedIn = chosen.idxs.length;
  const fix: Fix = {
    localDate,
    itemKey: item.key,
    label: item.label,
    tip: item.tip,
    missedIn,
    callsConsidered: window.length,
    text: `Missed in ${missedIn} of the last ${window.length} calls`,
    quotes,
  };
  return { fix };
}

/** The plan's signature (PHASE2_3_PLAN module 35): the fix, or null when there is none. */
export function dailyFix(
  scores: readonly ScoredCall[],
  dismissed7d: ReadonlySet<string> | readonly string[],
  localDate: LocalDate,
  opts: DailyFixOptions = {},
): Fix | null {
  return dailyFixResult(scores, dismissed7d, localDate, opts).fix;
}
