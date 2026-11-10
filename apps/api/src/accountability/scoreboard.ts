// Scoreboard and momentum (BUILD_PLAN module 15; A5/A7e; R-ACC-4, R-ACC-5, R-AST-15, R-IMPORT-6).
//
//   GET /scoreboard?userId=&range=   one member's numbers (agent/ISA: self; TL: team; Owner/Admin: anyone)
//   GET /team/scoreboard?range=      every member the caller may see the numbers of, one row each
//   GET /team/momentum               open deals by agent and stage, dwell vs the tenant median, slow flags
//
// Every number carries its denominator (R-ACC-4, A2 genuineness): speed-to-lead is "withinSla of total"
// with the median over `responded`; activity counts say how many days they cover; appointments held say
// how many were due. Assistant and imported messages never count as touches (R-AST-15, R-IMPORT-6): the
// 0012 functions count human outbound only. Numbers are summarised by core (speedToLeadSummary, momentum)
// so every surface computes them the same way.
import type { Instant, UserActor } from '@realty/core/foundation';
import { MOMENTUM_FACTOR, MOMENTUM_MIN_SAMPLE, type SpeedToLeadSummary, momentum, speedToLeadSummary } from '@realty/core/priority';
import type { Tx } from '@realty/db';
import { iso } from './common.js';
import * as repo from './repos/scoreboard.js';

export type RangeKey = repo.RangeKey;
export const RANGE_KEYS: readonly RangeKey[] = ['today', '7d', '30d', '90d'];

export interface Scoreboard {
  userId: string;
  name: string | null;
  speedToLead: SpeedToLeadSummary;
  touches: { count: number; calls: number; textsAndEmails: number; days: number };
  appointmentsSet: { count: number; days: number };
  /** held of the appointments that were due (started) in the range, canceled and rescheduled ones excluded */
  appointmentsHeld: { count: number; of: number };
  agreementsSigned: { count: number; days: number };
}

export interface RangeView {
  key: RangeKey;
  from: string;
  to: string;
  days: number;
  zone: string;
}

async function boards(tx: Tx, userIds: readonly string[], names: Map<string, string | null>, key: RangeKey, now: Instant): Promise<{ range: RangeView; boards: Scoreboard[] }> {
  const b = await repo.rangeBounds(tx, key, now);
  const days = repo.RANGE_DAYS[key];
  const [speed, activity] = await Promise.all([repo.speedRows(tx, userIds, b.from, b.to), repo.activityRows(tx, userIds, b.from, b.to)]);
  const out: Scoreboard[] = [];
  for (const id of userIds) {
    // The functions drop ids the caller may not see: no row means no access, so no board at all.
    const act = activity.get(id);
    if (!act) continue;
    const s = speedToLeadSummary(speed.filter((r) => r.userId === id), { now });
    out.push({
      userId: id,
      name: names.get(id) ?? null,
      speedToLead: s,
      touches: { count: act.calls + act.texts_and_emails, calls: act.calls, textsAndEmails: act.texts_and_emails, days },
      appointmentsSet: { count: act.appointments_set, days },
      appointmentsHeld: { count: act.appointments_held, of: act.appointments_due },
      agreementsSigned: { count: act.agreements_signed, days },
    });
  }
  return { range: { key, from: iso(b.from), to: iso(b.to), days, zone: b.zone }, boards: out };
}

/** One member's scoreboard. The route authorizes scoreboard.view first; the DB function re-checks. */
export async function scoreboardFor(tx: Tx, userId: string, key: RangeKey, now: Instant): Promise<{ range: RangeView; scoreboard: Scoreboard | null }> {
  const m = await repo.members(tx, [userId]);
  const r = await boards(tx, [userId], new Map(m.map((x) => [x.user_id, x.display_name])), key, now);
  return { range: r.range, scoreboard: r.boards[0] ?? null };
}

/** Members whose numbers the caller may see: Owner/Admin everyone who can hold leads; TL their team; others themselves. */
export async function teamScoreboard(tx: Tx, actor: UserActor, key: RangeKey, now: Instant): Promise<{ range: RangeView; members: Scoreboard[] }> {
  const all = await repo.members(tx, null);
  const tenantWide = actor.role === 'owner' || actor.role === 'admin';
  const visible = all.filter(
    (m) =>
      m.status === 'active' &&
      m.role !== 'tc' &&
      (tenantWide || m.user_id === actor.userId || (actor.role === 'team_lead' && m.in_my_team)),
  );
  const r = await boards(tx, visible.map((m) => m.user_id), new Map(visible.map((m) => [m.user_id, m.display_name])), key, now);
  return { range: r.range, members: r.boards };
}

// ---- momentum (R-ACC-5) --------------------------------------------------------------------------------

export interface MomentumDeal {
  dealId: string;
  name: string;
  stageEnteredAt: string;
  dwellDays: number;
  slow: boolean;
}

export interface MomentumStage {
  stage: string;
  deals: MomentumDeal[];
  slow: number;
  /** the tenant norm for the stage: median dwell over `sample` transitions in 180 days (null: none yet) */
  norm: { medianDays: number; sample: number; enough: boolean } | null;
}

export interface MomentumAgent {
  userId: string;
  name: string | null;
  openDeals: number;
  slowDeals: number;
  stages: MomentumStage[];
}

export interface MomentumView {
  /** slow = dwell > factor × tenant median, only when the median rests on ≥ minSample transitions */
  rule: { factor: number; minSample: number; windowDays: number };
  norms: { stage: string; medianDays: number; sample: number; enough: boolean }[];
  agents: MomentumAgent[];
  generatedAt: string;
}

/** Open pipeline stages in order (closed and lost deals have no momentum). */
const STAGE_ORDER = ['prospect', 'agreement_signed', 'active', 'under_contract'];

export async function teamMomentum(tx: Tx, now: Instant): Promise<MomentumView> {
  const [rows, normRows] = await Promise.all([repo.momentumRows(tx), repo.stageNorms(tx)]);
  const norms = normRows.map((n) => ({ stage: n.stage, medianDays: Number(n.median_days), sample: n.sample_size, enough: n.sample_size >= MOMENTUM_MIN_SAMPLE }));
  const normOf = new Map(norms.map((n) => [n.stage, n] as const));
  const agents = new Map<string, MomentumAgent>();
  for (const r of rows) {
    let a = agents.get(r.owner_user_id);
    if (!a) {
      a = { userId: r.owner_user_id, name: r.owner_name, openDeals: 0, slowDeals: 0, stages: [] };
      agents.set(r.owner_user_id, a);
    }
    const norm = normOf.get(r.stage) ?? null;
    const dwellDays = Number(r.dwell_days);
    const slow = norm !== null && momentum(dwellDays, { medianDays: norm.medianDays, sample: norm.sample }).slow;
    let st = a.stages.find((s) => s.stage === r.stage);
    if (!st) {
      st = { stage: r.stage, deals: [], slow: 0, norm };
      a.stages.push(st);
    }
    st.deals.push({ dealId: r.deal_id, name: r.deal_name, stageEnteredAt: iso(r.stage_entered_at), dwellDays, slow });
    a.openDeals += 1;
    if (slow) {
      st.slow += 1;
      a.slowDeals += 1;
    }
  }
  const order = (stage: string) => STAGE_ORDER.indexOf(stage) === -1 ? STAGE_ORDER.length : STAGE_ORDER.indexOf(stage);
  for (const a of agents.values()) a.stages.sort((x, y) => order(x.stage) - order(y.stage));
  return { rule: { factor: MOMENTUM_FACTOR, minSample: MOMENTUM_MIN_SAMPLE, windowDays: 180 }, norms, agents: [...agents.values()], generatedAt: iso(now) };
}
