// The daily fix (module 36; R-COACH-4, R-COACH-5, R-INT-6, E106): one card a day per person,
// `coaching_fix:{user}:{local date}` (the module's key family; the feed scorer leaves it alone, module 18a).
//
// reconcileDailyFixes runs hourly per tenant as the system actor:
//   - pack not cleared or the Owner's switch off ⇒ every open coaching card is closed (the capability is
//     off again) and nothing new is written;
//   - otherwise, for each active member with reviews: if a card for today exists in ANY state (open, done,
//     snoozed or dismissed), nothing happens (one fix a day; a dismissed one is not replaced today). Else
//     core.dailyFixResult over the member's last 10 scored calls (at least 3, E106), never an item they
//     dismissed in the last 7 days and never a disabled one; a fix closes yesterday's card and writes today's.
// The local date is the tenant's zone (members have no zone of their own; the scoreboard days use it too).
// The card holds what the page shows: the tip, why, the item key (for the 7-day dismissal rule) and the
// ids of the two quotes (the page reads them again under the viewer's RLS). No score, grade or rank
// (R-COACH-6). Nothing here feeds routing, ownership or the scoreboard (R-COACH-5).
import { type EvidenceRef } from '@realty/core/assistant';
import { FIX_WINDOW_CALLS, RUBRIC_V1, type DailyFixResult, type ScoredCall, type ScoredItem, coachingFixKey, dailyFixResult } from '@realty/core/coaching';
import type { AssistantClaimId, IdGenerator, Instant, UserId } from '@realty/core/foundation';
import { localDate } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import * as R from './repos/coaching.js';

export const DISMISS_WINDOW_MS = 7 * 24 * 3_600_000;

/** What a coaching card stores in its first reason (extra fields are ignored by the feed's reason reader). */
export interface FixCardData {
  item: string;
  date: string;
  quotes: { callId: string; evidenceId: string }[];
}

export function fixReasons(fix: NonNullable<DailyFixResult['fix']>, quotes: FixCardData['quotes']): unknown[] {
  const data: FixCardData = { item: fix.itemKey, date: fix.localDate, quotes };
  return [
    { code: 'COACHING_FIX', label: fix.tip, fix: data },
    { code: 'COACHING_FIX_WHY', label: `${fix.label}: ${fix.text.charAt(0).toLowerCase()}${fix.text.slice(1)}` },
  ];
}

/** The card data of a stored coaching card, or null when it is not one this module wrote. */
export function cardData(reasons: unknown): FixCardData | null {
  if (!Array.isArray(reasons)) return null;
  const first = reasons[0] as { code?: unknown; fix?: unknown } | undefined;
  if (!first || first.code !== 'COACHING_FIX' || !first.fix || typeof first.fix !== 'object') return null;
  const f = first.fix as { item?: unknown; date?: unknown; quotes?: unknown };
  if (typeof f.item !== 'string' || typeof f.date !== 'string' || !Array.isArray(f.quotes)) return null;
  const quotes: FixCardData['quotes'] = [];
  for (const q of f.quotes) {
    const o = q as { callId?: unknown; evidenceId?: unknown };
    if (o && typeof o.callId === 'string' && typeof o.evidenceId === 'string') quotes.push({ callId: o.callId, evidenceId: o.evidenceId });
  }
  return { item: f.item, date: f.date, quotes };
}

/**
 * Item keys the person dismissed in the 7 days before `now` (R-COACH-4): their own dismissal of a coaching
 * card, on the feed or on the page. A card closed by the system (a new day, scoring turned off) is not one.
 */
export function dismissedKeys(cards: readonly Pick<R.FixCardRow, 'state' | 'resolvedBy' | 'resolvedAt' | 'reasons'>[], now: Instant): Set<string> {
  const out = new Set<string>();
  for (const c of cards) {
    if (c.state !== 'dismissed' || c.resolvedAt === null) continue;
    if (c.resolvedBy === 'condition') continue;
    const at = c.resolvedAt.getTime();
    if (at > now || now - at >= DISMISS_WINDOW_MS) continue;
    const d = cardData(c.reasons);
    if (d) out.add(d.item);
  }
  return out;
}

/**
 * The reviews of these agents as core.dailyFix reads them, with each verified quote's evidence id (a quote
 * is the same object core returns, so `refIds` maps it back). Only reviews and quotes the CALLER may read.
 */
export async function scoredCallsOf(tx: Tx, agentUserIds: readonly string[]): Promise<{ byAgent: Map<string, ScoredCall[]>; refIds: WeakMap<EvidenceRef, string> }> {
  const reviews = await R.latestReviews(tx, agentUserIds, FIX_WINDOW_CALLS);
  const missedClaims = reviews.flatMap((r) => r.items.filter((i) => i.status === 'missed' && i.claimId !== null).map((i) => i.claimId as string));
  const ev = await R.verifiedQuotes(tx, missedClaims);
  const byClaim = new Map<string, R.EvidenceLite[]>();
  for (const e of ev) byClaim.set(e.claimId, [...(byClaim.get(e.claimId) ?? []), e]);
  const refIds = new WeakMap<EvidenceRef, string>();
  const byAgent = new Map<string, ScoredCall[]>();
  for (const r of reviews) {
    const items: ScoredItem[] = r.items.map((i) => {
      const quotes: EvidenceRef[] = [];
      if (i.status === 'missed' && i.claimId) {
        for (const e of byClaim.get(i.claimId) ?? []) {
          if (e.sourceId !== r.callId) continue; // a quote of this call only
          const ref: EvidenceRef = { sourceType: 'call', sourceId: e.sourceId, locator: e.locator, snippet: '' };
          refIds.set(ref, e.id);
          quotes.push(ref);
        }
      }
      return { key: i.key, status: i.status, claimId: i.claimId as AssistantClaimId | null, quotes };
    });
    const call: ScoredCall = { callId: r.callId, occurredAt: r.occurredAt, score: { rubricVersion: r.rubricVersion as `rubric/${number}`, items, metCount: r.metCount, scoredCount: r.scoredCount } };
    byAgent.set(r.agentUserId, [...(byAgent.get(r.agentUserId) ?? []), call]);
  }
  return { byAgent, refIds };
}

export interface ReconcileResult {
  written: number;
  closed: number;
  noFix: Record<string, number>;
  off: boolean;
}

export type MemberOutcome = { kind: 'exists' } | { kind: 'written'; closed: number } | { kind: 'no_fix'; reason: string; closed: number };

/**
 * Today's card for one member, when there is none yet (any state counts). Runs as the system actor in the
 * reconcile, or as the member themself when their page opens before the hourly pass (feed_insert and
 * feed_update RLS: their own rows only); `scored` holds the member's reviews as the CURRENT actor reads them.
 */
export async function reconcileMember(
  tx: Tx,
  ids: IdGenerator,
  o: { userId: string; today: string; disabledKeys: readonly string[]; scored: { byAgent: Map<string, ScoredCall[]>; refIds: WeakMap<EvidenceRef, string> }; now: Instant },
): Promise<MemberOutcome> {
  const key = coachingFixKey(o.userId as UserId, localDate(o.today));
  // one a day, whatever the person did with it; a card the system closed (scoring turned off, then on again
  // the same day) does not count, so today's tip comes back instead of reading as set aside
  if ((await R.fixCards(tx, o.userId, { dates: [o.today] })).some((c) => c.resolvedBy !== 'condition')) return { kind: 'exists' };
  const recent = await R.fixCards(tx, o.userId, { sinceResolved: (o.now - DISMISS_WINDOW_MS) as Instant });
  const res = dailyFixResult(o.scored.byAgent.get(o.userId) ?? [], dismissedKeys(recent, o.now), localDate(o.today), { rubric: RUBRIC_V1, disabledKeys: o.disabledKeys });
  const closed = await R.closeFixCards(tx, { userId: o.userId, keepKey: key, now: o.now });
  if (res.fix === null) return { kind: 'no_fix', reason: res.reason, closed };
  const quotes = res.fix.quotes.flatMap((q) => {
    const id = o.scored.refIds.get(q.ref);
    return id ? [{ callId: q.callId, evidenceId: id }] : [];
  });
  return (await R.insertFixCard(tx, { id: ids.next(), userId: o.userId, key, reasons: fixReasons(res.fix, quotes) })) ? { kind: 'written', closed } : { kind: 'exists' };
}

export async function reconcileDailyFixes(tx: Tx, ids: IdGenerator, now: Instant): Promise<ReconcileResult> {
  const s = await R.coachingSettings(tx);
  if (!s || !s.packCleared || !s.scoringEnabled) {
    // R-INT-6: off (or uncleared again) ⇒ no fix is shown
    return { written: 0, closed: await R.closeFixCards(tx, { now }), noFix: {}, off: true };
  }
  const today = await R.localDateAt(tx, now);
  const members = await R.reviewedMembers(tx);
  const scored = await scoredCallsOf(tx, members);
  // a member who left (or whose reviews are gone) keeps no open tip
  const out: ReconcileResult = { written: 0, closed: await R.closeFixCardsExcept(tx, members, now), noFix: {}, off: false };
  for (const userId of members) {
    const r = await reconcileMember(tx, ids, { userId, today, disabledKeys: s.disabledKeys, scored, now });
    if (r.kind === 'exists') continue;
    out.closed += r.closed;
    if (r.kind === 'written') out.written += 1;
    else out.noFix[r.reason] = (out.noFix[r.reason] ?? 0) + 1;
  }
  return out;
}
