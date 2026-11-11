// Goals and pace (PHASE2_3_PLAN module 33; DATA_MODEL agent_goals, R-PLAN-2).
//
//   GET    /goals              the caller's goals and those of members they may see (agent_goals RLS: self, the user's
//                              TL, tenant-wide), each with its pace (core goalPace)
//   POST   /goals              create (goal.manage: Owner/Admin any member; a TL the members of a team they lead)
//   PATCH  /goals/:id          change the target
//   DELETE /goals/:id          remove
//
// Pace counts come from the scoreboard definers (R-PLAN-2): app.scoreboard_activity for appointments set / held,
// agreements signed and touches (human calls + human texts/emails, never imported or assistant ones). Closings are
// not a scoreboard column: they are the deals the member owns that entered `closed` in the period, read under the
// caller's RLS (deal.view follows the same self / team / tenant-wide set as goal.view). Each pace says its count in
// words ("3 of 10 closings; 4.5 expected by now; 7 to go in 12 days"): no grade, no score.
//
// Every write is audited (goal.changed). Users have no zone of their own; periods are local dates in the tenant zone.
import { type AgentGoal, type GoalMetric, type GoalPeriodKind, goalPace, periodEnd } from '@realty/core/insights';
import { type IanaZone, type IdGenerator, type Instant, type LocalDate, type UserActor, localDate, toIso } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { audit, redactDiff } from '../audit.js';
import { AppError } from '../errors.js';
import { isoWeekday, midnight, tenantZone } from './common.js';

export const GOAL_METRICS = ['appointments_set', 'appointments_held', 'agreements_signed', 'closings', 'touches'] as const;
export const GOAL_PERIODS = ['week', 'month', 'quarter', 'year'] as const;

interface GoalRow {
  id: string;
  user_id: string;
  period_kind: GoalPeriodKind;
  period_start: string;
  metric: GoalMetric;
  target: number;
}

/** A period must start where its kind starts: a Monday, the 1st, a quarter's or a year's first day. */
export function validPeriodStart(kind: GoalPeriodKind, d: LocalDate): boolean {
  const [, m, day] = d.split('-').map(Number) as [number, number, number];
  switch (kind) {
    case 'week':
      return isoWeekday(d) === 1;
    case 'month':
      return day === 1;
    case 'quarter':
      return day === 1 && (m - 1) % 3 === 0;
    case 'year':
      return day === 1 && m === 1;
  }
}

const toGoal = (r: GoalRow): AgentGoal => ({
  id: r.id as never,
  userId: r.user_id as never,
  periodKind: r.period_kind,
  periodStart: localDate(r.period_start),
  metric: r.metric,
  target: r.target,
});

/** The member's count for a goal's metric over [period start, min(period end, now)) (R-PLAN-2). */
export async function goalActual(tx: Tx, g: AgentGoal, zone: IanaZone, now: Instant): Promise<number> {
  const from = midnight(g.periodStart, zone);
  const endAt = midnight(periodEnd(g.periodKind, g.periodStart), zone);
  const to = Math.min(endAt, now) as Instant;
  if (to <= from) return 0;
  if (g.metric === 'closings') {
    const r = await sql<{ n: number }>`
      SELECT count(DISTINCT h.deal_id)::int AS n FROM deal_stage_history h
        JOIN deals d ON d.tenant_id = h.tenant_id AND d.id = h.deal_id
       WHERE h.tenant_id = app.tenant_id() AND d.owner_user_id = ${g.userId} AND d.stage = 'closed'
         AND h.to_stage = 'closed' AND h.changed_at >= ${toIso(from)}::timestamptz AND h.changed_at < ${toIso(to)}::timestamptz`.execute(tx);
    return r.rows[0]?.n ?? 0;
  }
  const r = await sql<{ calls: string; texts_and_emails: string; appointments_set: string; appointments_held: string; agreements_signed: string }>`
    SELECT calls, texts_and_emails, appointments_set, appointments_held, agreements_signed
      FROM app.scoreboard_activity(${[g.userId]}::uuid[], ${toIso(from)}::timestamptz, ${toIso(to)}::timestamptz)`.execute(tx);
  const x = r.rows[0];
  if (!x) return 0;
  switch (g.metric) {
    case 'touches':
      return Number(x.calls) + Number(x.texts_and_emails);
    case 'appointments_set':
      return Number(x.appointments_set);
    case 'appointments_held':
      return Number(x.appointments_held);
    case 'agreements_signed':
      return Number(x.agreements_signed);
  }
}

/** Goals whose period has not ended more than `pastDays` ago, visible to the caller (RLS), each with its pace. */
export async function goalsWithPace(tx: Tx, now: Instant, o: { userIds?: readonly string[]; pastDays?: number } = {}) {
  const zone = await tenantZone(tx);
  const r = await sql<GoalRow>`
    SELECT id, user_id, period_kind, period_start::text AS period_start, metric, target FROM agent_goals
     WHERE tenant_id = app.tenant_id() AND (${o.userIds ? [...o.userIds] : null}::uuid[] IS NULL OR user_id = ANY (${o.userIds ? [...o.userIds] : null}::uuid[]))
     ORDER BY user_id, period_start DESC, metric`.execute(tx);
  const cutoff = now - (o.pastDays ?? 35) * 86_400_000;
  const out: { goal: AgentGoal; pace: ReturnType<typeof goalPace> }[] = [];
  for (const row of r.rows) {
    const g = toGoal(row);
    if (midnight(periodEnd(g.periodKind, g.periodStart), zone) < cutoff) continue;
    const actual = await goalActual(tx, g, zone, now);
    out.push({ goal: g, pace: goalPace(g, { actual }, now, zone) });
  }
  return { zone, goals: out };
}

/** Members the caller may see goals of (self, team they lead, everyone for Owner/Admin) and which they may manage. */
export async function goalMembers(tx: Tx, actor: UserActor) {
  const r = await sql<{ user_id: string; display_name: string | null; role: string; can_manage: boolean }>`
    SELECT m.user_id, u.display_name, m.role,
           (app.is_tenant_wide() OR m.user_id = ANY (app.my_team_member_ids())) AS can_manage
      FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.tenant_id = app.tenant_id() AND m.status = 'active'
       AND m.user_id IN (SELECT a.user_id FROM app.scoreboard_allowed_users(ARRAY(SELECT user_id FROM memberships WHERE tenant_id = app.tenant_id())) a)
     ORDER BY (m.user_id = ${actor.userId}) DESC, u.display_name NULLS LAST, m.user_id`.execute(tx);
  return r.rows.map((m) => ({ userId: m.user_id, name: m.display_name ?? 'Member', role: m.role, canManage: m.can_manage }));
}

export async function goalRelation(tx: Tx, actor: UserActor, userId: string): Promise<{ own: boolean; team: boolean } | null> {
  const r = await sql<{ ok: boolean; team: boolean }>`
    SELECT EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = app.tenant_id() AND m.user_id = ${userId} AND m.status = 'active') AS ok,
           ${userId}::uuid = ANY (app.my_team_member_ids()) AS team`.execute(tx);
  const x = r.rows[0];
  if (!x?.ok) return null;
  return { own: userId === actor.userId, team: x.team };
}

export async function goalOwner(tx: Tx, id: string): Promise<string | null> {
  const r = await sql<{ user_id: string }>`SELECT user_id FROM agent_goals WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  return r.rows[0]?.user_id ?? null;
}

export async function createGoal(tx: Tx, actor: UserActor, ids: IdGenerator, b: { userId: string; periodKind: GoalPeriodKind; periodStart: string; metric: GoalMetric; target: number }): Promise<string> {
  const start = localDate(b.periodStart);
  if (!validPeriodStart(b.periodKind, start)) throw new AppError('GOAL_PERIOD_START_INVALID', { periodKind: b.periodKind });
  const dup = await sql<{ id: string }>`
    SELECT id FROM agent_goals WHERE tenant_id = app.tenant_id() AND user_id = ${b.userId} AND period_kind = ${b.periodKind}
       AND period_start = ${start}::date AND metric = ${b.metric}`.execute(tx);
  if (dup.rows[0]) throw new AppError('GOAL_EXISTS', { goalId: dup.rows[0].id });
  const id = ids.next<'AgentGoalId'>();
  await sql`
    INSERT INTO agent_goals (tenant_id, id, user_id, period_kind, period_start, metric, target, created_by_user_id)
    VALUES (app.tenant_id(), ${id}, ${b.userId}, ${b.periodKind}, ${start}::date, ${b.metric}, ${b.target}, ${actor.userId})`.execute(tx);
  await audit(tx, actor, {
    action: 'goal.changed',
    entity: { type: 'agent_goal', id },
    changes: redactDiff(null, { user_id: b.userId, period_kind: b.periodKind, period_start: b.periodStart, metric: b.metric, target: b.target }, { entity: 'agent_goal' }),
    reason: 'CREATED',
  });
  return id;
}

export async function updateGoal(tx: Tx, actor: UserActor, id: string, target: number): Promise<void> {
  const r = await sql<{ target: number }>`SELECT target FROM agent_goals WHERE tenant_id = app.tenant_id() AND id = ${id} FOR UPDATE`.execute(tx);
  const before = r.rows[0];
  if (!before) throw new AppError('NOT_FOUND');
  const u = await sql`UPDATE agent_goals SET target = ${target} WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  if (Number(u.numAffectedRows ?? 0) !== 1) throw new AppError('NOT_FOUND');
  await audit(tx, actor, { action: 'goal.changed', entity: { type: 'agent_goal', id }, changes: redactDiff({ target: before.target }, { target }, { entity: 'agent_goal' }), reason: 'TARGET_CHANGED' });
}

export async function deleteGoal(tx: Tx, actor: UserActor, id: string): Promise<void> {
  const d = await sql`DELETE FROM agent_goals WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  if (Number(d.numAffectedRows ?? 0) !== 1) throw new AppError('NOT_FOUND');
  await audit(tx, actor, { action: 'goal.changed', entity: { type: 'agent_goal', id }, reason: 'DELETED' });
}
