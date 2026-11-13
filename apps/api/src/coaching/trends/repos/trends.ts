// SQL of api/coaching-trends (module 54). Trends read scored calls ONLY through app.coaching_trends (0170): the
// aggregate-only definer decides the scope (self; Owner/Admin any member; a Team Lead their team only while the
// Owner's tl_sees_call_scores is on) and the floor (R-COACH-7, R-COACH-8). Nothing here names the scores table, a
// call, a contact or a quote (architecture test). The member list and the week bounds are plain reads.
import { REVIEWED_ROLES } from '@realty/core/coaching';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import type { TrendRow, WindowKind } from '../aggregate.js';

export interface Windows {
  before: { from: string; to: string };
  after: { from: string; to: string };
}

/** app.coaching_trends for these ids; COACHING_TRENDS_SCOPE (insufficient_privilege) refuses the whole call. */
export async function trendRows(tx: Tx, userIds: readonly string[], weeks: number, rubricVersion: string): Promise<TrendRow[]> {
  const r = await sql<{ agent_user_id: string | null; window_kind: WindowKind; item_key: string; scored: number; met: number | null; calls: number }>`
    SELECT agent_user_id, window_kind, item_key, scored, met, calls FROM app.coaching_trends(${[...userIds]}::uuid[], ${weeks}::integer, ${rubricVersion})`.execute(tx);
  return r.rows.map((x) => ({ agentUserId: x.agent_user_id, windowKind: x.window_kind, itemKey: x.item_key, scored: x.scored, met: x.met, calls: x.calls }));
}

/** The two windows at the database's now, in the tenant's zone (whole local weeks, Monday to Sunday). */
export async function windowsOf(tx: Tx, weeks: number): Promise<Windows> {
  const r = await sql<{ window_kind: WindowKind; first_day: string; last_day: string }>`
    SELECT b.window_kind, to_char(b.first_day, 'YYYY-MM-DD') AS first_day, to_char(b.last_day, 'YYYY-MM-DD') AS last_day
      FROM tenant_settings s, app.coaching_trend_bounds(now(), s.default_timezone, ${weeks}::integer) b WHERE s.tenant_id = app.tenant_id()`.execute(tx);
  const of = (k: WindowKind) => {
    const x = r.rows.find((y) => y.window_kind === k);
    if (!x) throw new Error('coaching trends: tenant settings missing');
    return { from: x.first_day, to: x.last_day };
  };
  return { before: of('before'), after: of('after') };
}

/** Active members who take call reviews: everyone ('all') or the caller's team ('team'), the caller included. */
export async function reviewedMembers(tx: Tx, scope: 'team' | 'all', limit: number): Promise<{ userId: string; name: string }[]> {
  const r = await sql<{ user_id: string; name: string }>`
    SELECT m.user_id, COALESCE(NULLIF(btrim(u.display_name), ''), 'Team member') AS name
      FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.tenant_id = app.tenant_id() AND m.status = 'active' AND m.role = ANY (${[...REVIEWED_ROLES]}::text[])
       AND (${scope} = 'all' OR m.user_id = app.user_id() OR m.user_id = ANY ((SELECT app.my_team_member_ids())::uuid[]))
     ORDER BY name, m.user_id LIMIT ${limit}`.execute(tx);
  return r.rows.map((x) => ({ userId: x.user_id, name: x.name }));
}
