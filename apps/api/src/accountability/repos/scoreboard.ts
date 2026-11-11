// Scoreboard and momentum queries of api/accountability (BUILD_PLAN module 15; R-ACC-4, R-ACC-5).
//
// Scoreboard numbers come from the 0012 aggregate functions (app.scoreboard_speed / _activity), which
// return the caller's own numbers (or their team's, for a Team Lead) whatever happened to the contacts
// since: timings and counts only, never a contact. Whole past days come from the 0027 daily rollup of
// those same functions (see speedRows / activityRows). Momentum reads v_pipeline_momentum under the caller's
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

// ---- speed and activity: the rollup for whole rolled days, live counts for the rest ------------------
//
// The 0027 rollup holds, per member and closed day, exactly what app.scoreboard_speed / _activity return
// for that day. One statement (one snapshot) per metric: the tenant's days covering [from, to); a day is
// read from the rollup when it lies wholly inside [from, to), was rolled in the current zone and has no
// dirty mark; every other run of days (always including today) is counted live by the 0012 functions
// over its part of [from, to). The live calls also decide WHICH members the caller may see
// (app.scoreboard_allowed_users) and rollup rows are taken only for those members, so every viewer gets
// the rows and boards of the all-live computation (liveSpeedRows / liveActivityRows).
const plan = (from: Instant, to: Instant) => sql`
  z AS (SELECT s.default_timezone AS zone FROM tenant_settings s WHERE s.tenant_id = app.tenant_id()),
  span AS (SELECT app.scoreboard_day_of(${iso(from)}::timestamptz, z.zone) AS d0, app.scoreboard_day_of(${iso(to)}::timestamptz, z.zone) AS d1 FROM z),
  d AS (
    SELECT span.d0 + i AS day,
           ((span.d0 + i)::timestamp AT TIME ZONE z.zone) AS lo,
           ((span.d0 + i + 1)::timestamp AT TIME ZONE z.zone) AS hi
      FROM z, span, generate_series(0, span.d1 - span.d0) AS i),
  u AS (
    SELECT d.day, d.lo, d.hi,
           (d.lo >= ${iso(from)}::timestamptz AND d.hi <= ${iso(to)}::timestamptz
            AND EXISTS (SELECT 1 FROM scoreboard_rollup_days r, z
                         WHERE r.tenant_id = app.tenant_id() AND r.day = d.day AND r.zone = z.zone)
            AND NOT EXISTS (SELECT 1 FROM scoreboard_rollup_dirty m WHERE m.tenant_id = app.tenant_id() AND m.day = d.day)) AS rolled
      FROM d),
  seg AS (
    SELECT GREATEST(min(x.lo), ${iso(from)}::timestamptz) AS lo, LEAST(max(x.hi), ${iso(to)}::timestamptz) AS hi
      FROM (SELECT u.*, u.day - (row_number() OVER (PARTITION BY u.rolled ORDER BY u.day))::int AS grp FROM u) x
     WHERE NOT x.rolled GROUP BY x.grp)`;

type SpeedOut = SpeedRow & { userId: UserId };
type SpeedDb = { user_id: string; owned_at: Date; first_touch_due_at: Date; first_touch_at: Date | null };

function speedOut(rows: readonly SpeedDb[]): SpeedOut[] {
  return rows.map((x, i) => ({
    userId: x.user_id as UserId,
    contactId: '' as never, // not returned across the boundary: the summary needs timings only
    ownedSeq: i + 1,
    ownedAt: ms(x.owned_at),
    firstTouchDueAt: ms(x.first_touch_due_at),
    firstTouchAt: msOrNull(x.first_touch_at),
  }));
}

// Timings travel as epoch milliseconds (float8, exact below 2^53) rather than timestamptz text: for a
// tenant-wide caller that is tens of thousands of periods, and parsing them into Dates was the largest
// cost left. floor(µs / 1000) is exactly what node-pg's timestamptz parser yields (Date.getTime()),
// checked for every microsecond fraction in scoreboard_rollup.test.ts, so the numbers are the same.
type SpeedMs = { user_id: string; owned_ms: number; due_ms: number; ft_ms: number | null };

export async function speedRows(tx: Tx, userIds: readonly string[], from: Instant, to: Instant): Promise<SpeedOut[]> {
  if (userIds.length === 0) return [];
  const ids = [...userIds];
  const r = await sql<SpeedMs>`
    WITH ${plan(from, to)},
    allowed AS (SELECT a.user_id FROM app.scoreboard_allowed_users(${ids}::uuid[]) a),
    periods AS (
      SELECT s.user_id, s.owned_at, s.first_touch_due_at, s.first_touch_at
        FROM seg, LATERAL app.scoreboard_speed(${ids}::uuid[], seg.lo, seg.hi) s
      UNION ALL
      SELECT r.user_id, r.owned_at, r.first_touch_due_at, r.first_touch_at
        FROM scoreboard_speed_daily r
       WHERE r.tenant_id = app.tenant_id() AND r.user_id = ANY (ARRAY(SELECT allowed.user_id FROM allowed))
         AND r.day = ANY (ARRAY(SELECT u.day FROM u WHERE u.rolled)))
    SELECT p.user_id, floor(extract(epoch FROM p.owned_at) * 1000)::float8 AS owned_ms,
           floor(extract(epoch FROM p.first_touch_due_at) * 1000)::float8 AS due_ms,
           floor(extract(epoch FROM p.first_touch_at) * 1000)::float8 AS ft_ms
      FROM periods p`.execute(tx);
  return r.rows.map((x, i) => ({
    userId: x.user_id as UserId,
    contactId: '' as never, // not returned across the boundary: the summary needs timings only
    ownedSeq: i + 1,
    ownedAt: x.owned_ms as Instant,
    firstTouchDueAt: x.due_ms as Instant,
    firstTouchAt: x.ft_ms === null ? null : (x.ft_ms as Instant),
  }));
}

/** The all-live computation (the 0012 function over the whole range): what speedRows must equal. */
export async function liveSpeedRows(tx: Tx, userIds: readonly string[], from: Instant, to: Instant): Promise<SpeedOut[]> {
  if (userIds.length === 0) return [];
  const r = await sql<SpeedDb>`
    SELECT user_id, owned_at, first_touch_due_at, first_touch_at
      FROM app.scoreboard_speed(${[...userIds]}::uuid[], ${iso(from)}::timestamptz, ${iso(to)}::timestamptz)`.execute(tx);
  return speedOut(r.rows);
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

function activityMap(rows: readonly Record<keyof ActivityRow, string>[]): Map<string, ActivityRow> {
  const out = new Map<string, ActivityRow>();
  for (const x of rows) {
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

export async function activityRows(tx: Tx, userIds: readonly string[], from: Instant, to: Instant): Promise<Map<string, ActivityRow>> {
  if (userIds.length === 0) return new Map();
  const ids = [...userIds];
  const r = await sql<Record<keyof ActivityRow, string>>`
    WITH ${plan(from, to)},
    live AS (SELECT a.* FROM seg, LATERAL app.scoreboard_activity(${ids}::uuid[], seg.lo, seg.hi) a)
    SELECT x.user_id, sum(x.calls) AS calls, sum(x.texts_and_emails) AS texts_and_emails, sum(x.appointments_set) AS appointments_set,
           sum(x.appointments_held) AS appointments_held, sum(x.appointments_due) AS appointments_due,
           sum(x.agreements_signed) AS agreements_signed
      FROM (
        SELECT l.user_id, l.calls, l.texts_and_emails, l.appointments_set, l.appointments_held, l.appointments_due, l.agreements_signed
          FROM live l
        UNION ALL
        SELECT r.user_id, r.calls, r.texts_and_emails, r.appointments_set, r.appointments_held, r.appointments_due, r.agreements_signed
          FROM scoreboard_activity_daily r
         WHERE r.tenant_id = app.tenant_id() AND r.user_id = ANY (ARRAY(SELECT l.user_id FROM live l))
           AND r.day = ANY (ARRAY(SELECT u.day FROM u WHERE u.rolled))) x
     GROUP BY x.user_id`.execute(tx);
  return activityMap(r.rows);
}

/** The all-live computation (the 0012 function over the whole range): what activityRows must equal. */
export async function liveActivityRows(tx: Tx, userIds: readonly string[], from: Instant, to: Instant): Promise<Map<string, ActivityRow>> {
  if (userIds.length === 0) return new Map();
  const r = await sql<Record<keyof ActivityRow, string>>`
    SELECT user_id, calls, texts_and_emails, appointments_set, appointments_held, appointments_due, agreements_signed
      FROM app.scoreboard_activity(${[...userIds]}::uuid[], ${iso(from)}::timestamptz, ${iso(to)}::timestamptz)`.execute(tx);
  return activityMap(r.rows);
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
