// Scoreboard and momentum queries of api/accountability (BUILD_PLAN module 15; R-ACC-4, R-ACC-5).
//
// Scoreboard numbers come from the 0012 aggregate functions (app.scoreboard_speed / _activity), which
// return the caller's own numbers (or their team's, for a Team Lead) whatever happened to the contacts
// since: timings and counts only, never a contact. Momentum reads v_pipeline_momentum under the caller's
// RLS (deals: own, team, deal member, tenant-wide) with app.stage_dwell_norms(), so only the tenant-wide
// aggregate crosses the visibility boundary (R-ACC-5).
import type { Instant, UserId } from '@realty/core/foundation';
import type { SpeedRow } from '@realty/core/priority';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { iso, ms, msOrNull } from '../common.js';

export type RangeKey = 'today' | '7d' | '30d' | '90d';
export const RANGE_DAYS: Record<RangeKey, number> = { today: 1, '7d': 7, '30d': 30, '90d': 90 };

/** [start of the tenant-local day (days-1) days ago, now) */
export async function rangeBounds(tx: Tx, key: RangeKey, now: Instant): Promise<{ from: Instant; to: Instant; zone: string }> {
  const days = RANGE_DAYS[key];
  const r = await sql<{ from_ts: Date; zone: string }>`
    SELECT ((date_trunc('day', ${iso(now)}::timestamptz AT TIME ZONE s.default_timezone) - make_interval(days => ${days - 1}))
             AT TIME ZONE s.default_timezone) AS from_ts, s.default_timezone AS zone
      FROM tenant_settings s WHERE s.tenant_id = app.tenant_id()`.execute(tx);
  const row = r.rows[0];
  if (!row) throw new Error('tenant settings missing');
  return { from: ms(row.from_ts), to: now, zone: row.zone };
}

export async function speedRows(tx: Tx, userIds: readonly string[], from: Instant, to: Instant): Promise<(SpeedRow & { userId: UserId })[]> {
  if (userIds.length === 0) return [];
  const r = await sql<{ user_id: string; owned_at: Date; first_touch_due_at: Date; first_touch_at: Date | null }>`
    SELECT user_id, owned_at, first_touch_due_at, first_touch_at
      FROM app.scoreboard_speed(${[...userIds]}::uuid[], ${iso(from)}::timestamptz, ${iso(to)}::timestamptz)`.execute(tx);
  return r.rows.map((x, i) => ({
    userId: x.user_id as UserId,
    contactId: '' as never, // not returned across the boundary: the summary needs timings only
    ownedSeq: i + 1,
    ownedAt: ms(x.owned_at),
    firstTouchDueAt: ms(x.first_touch_due_at),
    firstTouchAt: msOrNull(x.first_touch_at),
  }));
}

export interface ActivityRow {
  user_id: string;
  calls: number;
  texts_and_emails: number;
  appointments_set: number;
  appointments_held: number;
  appointments_due: number;
  agreements_signed: number;
}

export async function activityRows(tx: Tx, userIds: readonly string[], from: Instant, to: Instant): Promise<Map<string, ActivityRow>> {
  const out = new Map<string, ActivityRow>();
  if (userIds.length === 0) return out;
  const r = await sql<Record<keyof ActivityRow, string>>`
    SELECT user_id, calls, texts_and_emails, appointments_set, appointments_held, appointments_due, agreements_signed
      FROM app.scoreboard_activity(${[...userIds]}::uuid[], ${iso(from)}::timestamptz, ${iso(to)}::timestamptz)`.execute(tx);
  for (const x of r.rows) {
    out.set(x.user_id, {
      user_id: x.user_id,
      calls: Number(x.calls),
      texts_and_emails: Number(x.texts_and_emails),
      appointments_set: Number(x.appointments_set),
      appointments_held: Number(x.appointments_held),
      appointments_due: Number(x.appointments_due),
      agreements_signed: Number(x.agreements_signed),
    });
  }
  return out;
}

export interface MemberRow {
  user_id: string;
  role: string;
  status: string;
  display_name: string | null;
  in_my_team: boolean;
}

/** Memberships the caller can read (every member reads the roster) with names and the team relation. */
export async function members(tx: Tx, userIds: readonly string[] | null): Promise<MemberRow[]> {
  const r = await sql<MemberRow>`
    SELECT m.user_id, m.role, m.status, u.display_name,
           COALESCE(m.user_id = ANY (app.my_team_member_ids()), false) AS in_my_team
      FROM memberships m LEFT JOIN users u ON u.id = m.user_id
     WHERE m.tenant_id = app.tenant_id()
       AND (${userIds === null} OR m.user_id = ANY (${userIds === null ? [] : [...userIds]}::uuid[]))
     ORDER BY u.display_name NULLS LAST, m.user_id`.execute(tx);
  return r.rows;
}

export interface MomentumRow {
  deal_id: string;
  deal_name: string;
  owner_user_id: string;
  owner_name: string | null;
  stage: string;
  stage_entered_at: Date;
  dwell_days: string;
  team_median_days: string | null;
  sample_size: number | null;
}

/** Open deals the caller may see, with their current stage dwell and the tenant norm for that stage. */
export async function momentumRows(tx: Tx): Promise<MomentumRow[]> {
  const r = await sql<MomentumRow>`
    SELECT v.deal_id, d.name AS deal_name, v.owner_user_id, u.display_name AS owner_name, v.stage, v.stage_entered_at,
           v.dwell_days::text AS dwell_days, v.team_median_days::text AS team_median_days, v.sample_size
      FROM v_pipeline_momentum v
      JOIN deals d ON d.tenant_id = v.tenant_id AND d.id = v.deal_id
      LEFT JOIN users u ON u.id = v.owner_user_id
     WHERE v.tenant_id = app.tenant_id()
     ORDER BY u.display_name NULLS LAST, v.owner_user_id, v.stage, v.stage_entered_at`.execute(tx);
  return r.rows;
}

export async function stageNorms(tx: Tx): Promise<{ stage: string; median_days: string; sample_size: number }[]> {
  const r = await sql<{ stage: string; median_days: string; sample_size: number }>`
    SELECT stage, median_days::text AS median_days, sample_size FROM app.stage_dwell_norms() ORDER BY stage`.execute(tx);
  return r.rows;
}
