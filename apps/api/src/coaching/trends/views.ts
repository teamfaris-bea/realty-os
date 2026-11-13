// What the trends pages read (module 54; R-COACH-7, R-COACH-8; E472, E473).
//
//   ownTrends    the caller's own weekly improving/slipping per checklist item (coaching.view)
//   teamTrends   Owner/Admin: every member who takes reviews; a Team Lead: their team, and only while the Owner's
//                tl_sees_call_scores is on (tl_not_allowed otherwise, and nothing is read). One definer call: one row per
//                member plus the group. At most MAX_MEMBERS members ("Showing the first 200 members").
// Counts only: every number shows its n; met is withheld below 5 and, in anyone else's trend, for any small week
// (the definer's floor). No call, contact, quote, score, grade, rank or percentage (R-COACH-6, snapshot test).
import { RUBRIC_V1 } from '@realty/core/coaching';
import type { UserActor } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { AppError } from '../../errors.js';
import * as C from '../repos/coaching.js';
import { type TrendItemView, trendItems } from './aggregate.js';
import * as R from './repos/trends.js';

export const MAX_MEMBERS = 200;
/** owner question 5's default lives with the query schema that applies it */
export { DEFAULT_WEEKS } from './schemas.js';

export type TrendState = 'not_cleared' | 'scoring_off' | 'tl_not_allowed' | 'ready';

export interface TrendsView {
  state: TrendState;
  sentence: string;
  windows: R.Windows;
  items: TrendItemView[];
}

export interface TeamTrendsView extends Omit<TrendsView, 'items'> {
  team: TrendItemView[];
  members: { userId: string; name: string; items: TrendItemView[] }[];
}

const OFF: Record<'not_cleared' | 'scoring_off', string> = {
  not_cleared: 'Call reviews are off until counsel reviews them.',
  scoring_off: 'Call scoring is off.',
};

function stateOf(s: C.CoachingSettingsRow): 'not_cleared' | 'scoring_off' | 'ready' {
  if (!s.packCleared) return 'not_cleared';
  if (!s.scoringEnabled) return 'scoring_off';
  return 'ready';
}

/** The definer's refusal → a stable code (never the raw error). */
async function rows(tx: Tx, ids: readonly string[], weeks: number) {
  try {
    return await R.trendRows(tx, ids, weeks, RUBRIC_V1.version);
  } catch (e) {
    const msg = e && typeof e === 'object' && 'message' in e ? String((e as { message?: unknown }).message) : '';
    if (msg.startsWith('COACHING_TRENDS_SCOPE')) throw new AppError('COACHING_TRENDS_SCOPE');
    throw e;
  }
}

export async function ownTrends(tx: Tx, actor: UserActor, weeks: number): Promise<TrendsView> {
  const s = await C.coachingSettings(tx);
  if (!s) throw new AppError('NOT_FOUND');
  const windows = await R.windowsOf(tx, weeks);
  const state = stateOf(s);
  if (state !== 'ready') return { state, sentence: OFF[state], windows, items: [] };
  const r = await rows(tx, [actor.userId], weeks);
  return { state, sentence: weeks === 1 ? 'Your reviewed calls last week, against the week before.' : `Your reviewed calls in the last ${weeks} weeks, against the ${weeks} weeks before.`, windows, items: trendItems(r, actor.userId, weeks, { disabledKeys: s.disabledKeys }) };
}

export async function teamTrends(tx: Tx, actor: UserActor, weeks: number): Promise<TeamTrendsView> {
  const s = await C.coachingSettings(tx);
  if (!s) throw new AppError('NOT_FOUND');
  const windows = await R.windowsOf(tx, weeks);
  const tenantWide = actor.role === 'owner' || actor.role === 'admin';
  if (!tenantWide && !s.tlSeesCallScores) {
    return { state: 'tl_not_allowed', sentence: 'The Owner has not turned on Team Lead access to call reviews, so trends are private to each person.', windows, team: [], members: [] };
  }
  const state = stateOf(s);
  if (state !== 'ready') return { state, sentence: OFF[state], windows, team: [], members: [] };
  const members = await R.reviewedMembers(tx, tenantWide ? 'all' : 'team', MAX_MEMBERS + 1);
  const shown = members.slice(0, MAX_MEMBERS);
  if (shown.length === 0) return { state, sentence: 'Nobody on the team takes call reviews yet.', windows, team: [], members: [] };
  const r = await rows(tx, shown.map((m) => m.userId), weeks);
  const opts = { disabledKeys: s.disabledKeys };
  // one member: the definer returns no group rows; the group is that member (already under the cell floor unless it is the caller)
  const team = trendItems(r, shown.length > 1 ? null : shown[0]!.userId, weeks, opts);
  const sentence = `${members.length > MAX_MEMBERS ? `Showing the first ${MAX_MEMBERS} members. ` : ''}Counts of reviewed calls per checklist item, ${weeks === 1 ? 'last week against the week before' : `the last ${weeks} weeks against the ${weeks} before`}. Weeks with only a few reviewed calls are not shown.`;
  return { state, sentence, windows, team, members: shown.map((m) => ({ userId: m.userId, name: m.name, items: trendItems(r, m.userId, weeks, opts) })) };
}
