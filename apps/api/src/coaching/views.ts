// What the coaching pages read (module 36 for modules 40 and 41; R-COACH-2..6, R-INT-6, E106).
//
//   todayView      the caller's own fix for today: the card the hourly reconcile wrote, its tip and why, and
//                  its two quotes, read again under the caller's RLS (the review must still be readable: the
//                  recording scope and call_review_scope) and decrypted only for a caller who may read that
//                  call's transcript. No card ⇒ the honest reason: the pack is not cleared, scoring is off,
//                  "Not enough calls yet" (E106), nothing missed, or the fix was dismissed today.
//   teamView       Owner/Admin: every member; a Team Lead: their team, and only while the Owner's
//                  tl_sees_call_scores is on. What a Team Lead reads comes from call_scores under THEIR RLS, so
//                  the database decides (with the setting off they read no review at all).
//   dismissToday   the caller dismisses today's fix; it is not suggested again for 7 days (R-COACH-4).
// Views carry counts of calls only ("missed in 4 of the last 10 calls"), never a score, grade or rank.
import { type EvidenceRef } from '@realty/core/assistant';
import { FIX_MAX_QUOTES, NO_FIX_TEXT, RUBRIC_V1, type DailyFixResult, type NoFixReason, coachingFixKey, dailyFixResult } from '@realty/core/coaching';
import { type IdGenerator, type Instant, type TenantId, type UserActor, type UserId, can, localDate } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { snippetAad } from '../assistant/repos/actions.js';
import { recordingFacts } from '../comms/recordings.js';
import type { EnvelopeService } from '../crypto/envelope.js';
import { AppError } from '../errors.js';
import { cardData, reconcileMember, scoredCallsOf } from './fix.js';
import * as R from './repos/coaching.js';

export interface QuoteView {
  callId: string;
  /** the recording to play (null when the caller may not play it any more) */
  recordingId: string | null;
  startMs: number;
  endMs: number;
  /** the exact words, or null when the caller may not read this call's transcript */
  snippet: string | null;
  /** "Call with Lena, Nov 9" (first name only when the caller sees the contact) */
  callLabel: string;
}

export interface FixView {
  date: string;
  itemKey: string;
  label: string;
  tip: string;
  why: string;
  quotes: QuoteView[];
}

export type CoachingState = 'not_cleared' | 'scoring_off' | 'ready';

export interface TodayView {
  state: CoachingState;
  date: string;
  fix: FixView | null;
  /** why there is no fix today (null when there is one, or coaching is off: `state` says that) */
  noFix: { reason: NoFixReason | 'dismissed_today'; text: string } | null;
  /** the card id, for Dismiss (null when there is no open card) */
  cardId: string | null;
}

const dateFmt = (d: Date, zone: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: zone }).format(d);

function stateOf(s: R.CoachingSettingsRow): CoachingState {
  if (!s.packCleared) return 'not_cleared';
  if (!s.scoringEnabled) return 'scoring_off';
  return 'ready';
}

async function transcriptReadable(tx: Tx, actor: UserActor, callId: string, cache: Map<string, boolean>, recordingId: string | null): Promise<boolean> {
  const hit = cache.get(callId);
  if (hit !== undefined) return hit;
  let ok = false;
  if (recordingId) {
    const facts = await recordingFacts(tx, recordingId);
    ok = facts !== null && can(actor, 'transcript.view', facts).ok;
  }
  cache.set(callId, ok);
  return ok;
}

/** The quotes, in the given order, that the caller may still read (absent ones are dropped). */
async function quoteViews(tx: Tx, actor: UserActor, envelope: EnvelopeService, zone: string, quotes: readonly { evidenceId: string }[]): Promise<QuoteView[]> {
  const rows = await R.quoteSources(tx, quotes.map((q) => q.evidenceId));
  const byId = new Map(rows.map((r) => [r.evidenceId, r]));
  const cache = new Map<string, boolean>();
  const out: QuoteView[] = [];
  for (const q of quotes) {
    const r = byId.get(q.evidenceId);
    if (!r || !Number.isFinite(r.startMs) || !Number.isFinite(r.endMs)) continue;
    let snippet: string | null = r.snippet;
    if (r.snippetEnc) {
      snippet = (await transcriptReadable(tx, actor, r.callId, cache, r.recordingId))
        ? Buffer.from(await envelope.inTx(tx, actor.tenantId as TenantId).decrypt(actor.tenantId as TenantId, snippetAad(r.evidenceId), new Uint8Array(r.snippetEnc))).toString('utf8')
        : null;
    }
    const who = r.contactFirstName ? `Call with ${r.contactFirstName}` : 'A call';
    out.push({ callId: r.callId, recordingId: r.recordingId, startMs: r.startMs, endMs: r.endMs, snippet, callLabel: r.callStartedAt ? `${who}, ${dateFmt(r.callStartedAt, zone)}` : who });
  }
  return out;
}

function fixFromCard(reasons: unknown): { tip: string; why: string } {
  const list = Array.isArray(reasons) ? (reasons as { code?: unknown; label?: unknown }[]) : [];
  const tip = list.find((x) => x.code === 'COACHING_FIX')?.label;
  const why = list.find((x) => x.code === 'COACHING_FIX_WHY')?.label;
  return { tip: typeof tip === 'string' ? tip : '', why: typeof why === 'string' ? why : '' };
}

export async function todayView(tx: Tx, actor: UserActor, deps: { envelope: EnvelopeService; ids: IdGenerator }, now: Instant): Promise<TodayView> {
  const s = await R.coachingSettings(tx);
  if (!s) throw new AppError('NOT_FOUND');
  const date = await R.localDateAt(tx, now);
  const state = stateOf(s);
  if (state !== 'ready') return { state, date, fix: null, noFix: null, cardId: null };
  // the page may open before the hourly pass: today's card is written now, by the same rules, as the caller
  const scored = await scoredCallsOf(tx, [actor.userId]);
  const made = await reconcileMember(tx, deps.ids, { userId: actor.userId, today: date, disabledKeys: s.disabledKeys, scored, now });
  if (made.kind === 'no_fix') {
    const reason = made.reason as NoFixReason;
    return { state, date, fix: null, noFix: { reason, text: NO_FIX_TEXT[reason] }, cardId: null };
  }
  const card = (await R.fixCards(tx, actor.userId, { dates: [date] }))[0];
  const data = card ? cardData(card.reasons) : null;
  if (!card || !data) return { state, date, fix: null, noFix: { reason: 'not_enough_calls', text: NO_FIX_TEXT.not_enough_calls }, cardId: null };
  if (card.state === 'dismissed' || card.state === 'done') return { state, date, fix: null, noFix: { reason: 'dismissed_today', text: 'You set today’s tip aside. A new one comes tomorrow.' }, cardId: null };
  const item = RUBRIC_V1.items.find((i) => i.key === data.item);
  const { tip, why } = fixFromCard(card.reasons);
  return {
    state,
    date,
    fix: { date, itemKey: data.item, label: item?.label ?? data.item, tip: tip || item?.tip || '', why, quotes: await quoteViews(tx, actor, deps.envelope, s.zone, data.quotes) },
    noFix: null,
    cardId: card.id,
  };
}

export async function dismissToday(tx: Tx, actor: UserActor, now: Instant): Promise<void> {
  const date = await R.localDateAt(tx, now);
  const key = coachingFixKey(actor.userId as UserId, localDate(date));
  const card = (await R.fixCards(tx, actor.userId, { dates: [date] })).find((c) => c.key === key);
  if (!card || !(await R.dismissFixCard(tx, card.id, now))) throw new AppError('NOT_FOUND');
}

export interface TeamMemberFix {
  userId: string;
  name: string;
  /** the item missed most often in their recent reviewed calls (dismissals are the member's own and not applied) */
  fix: Omit<FixView, 'date'> | null;
  noFix: { reason: NoFixReason; text: string } | null;
}

export interface TeamView {
  state: CoachingState;
  /** false: a Team Lead while the Owner's setting is off (nothing is read) */
  visible: boolean;
  sentence: string;
  members: TeamMemberFix[];
}

export async function teamView(tx: Tx, actor: UserActor, envelope: EnvelopeService, now: Instant): Promise<TeamView> {
  const s = await R.coachingSettings(tx);
  if (!s) throw new AppError('NOT_FOUND');
  const state = stateOf(s);
  const tenantWide = actor.role === 'owner' || actor.role === 'admin';
  if (!tenantWide && !s.tlSeesCallScores) {
    return { state, visible: false, sentence: 'The Owner has not turned on Team Lead access to call reviews, so your team’s tips are private to each person.', members: [] };
  }
  const members = await R.teamMembers(tx, tenantWide ? 'all' : 'team');
  const { byAgent, refIds } = await scoredCallsOf(tx, members.map((m) => m.userId));
  const date = localDate(await R.localDateAt(tx, now));
  const out: TeamMemberFix[] = [];
  for (const m of members) {
    const res: DailyFixResult = dailyFixResult(byAgent.get(m.userId) ?? [], [], date, { disabledKeys: s.disabledKeys });
    if (res.fix === null) {
      out.push({ userId: m.userId, name: m.name, fix: null, noFix: { reason: res.reason, text: NO_FIX_TEXT[res.reason] } });
      continue;
    }
    const quotes = res.fix.quotes.slice(0, FIX_MAX_QUOTES).flatMap((q: { ref: EvidenceRef }) => {
      const id = refIds.get(q.ref);
      return id ? [{ evidenceId: id }] : [];
    });
    out.push({
      userId: m.userId,
      name: m.name,
      fix: { itemKey: res.fix.itemKey, label: res.fix.label, tip: res.fix.tip, why: res.fix.text, quotes: await quoteViews(tx, actor, envelope, s.zone, quotes) },
      noFix: null,
    });
  }
  const sentence = state === 'ready' ? 'From each person’s recent reviewed calls. Each person sees their own tip; only you and the Owner’s chosen roles see this list.' : state === 'not_cleared' ? 'Call reviews are off until counsel reviews them.' : 'Call scoring is off.';
  return { state, visible: true, sentence, members: out };
}
