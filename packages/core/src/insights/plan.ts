// Weekly plan (R-PLAN-1, R-PLAN-3; E110, E111).
//
// planWeek picks 3–5 items from the agent's own pipeline facts (open promises, tasks, slow deals,
// appointments without an outcome), each with evidence (source type, id and a short reason).
// Ranking (R-PLAN-1): items with a deadline first, soonest first; then by the gap to the goal
// (larger first); ties by source id, then source type, so the order is deterministic.
// - Fewer than 3 candidates: the plan returns what exists. It never invents filler items.
// - No goals (E110): built from the pipeline only (every gap is 0) and the note says so.
// - Person-level do-not-contact contacts are never suggested (R-PLAN-3): such candidates are dropped.
// - dropInvisible (R-PLAN-3, E111) runs at render time: an item citing a source the agent can no
//   longer see (e.g. a deal reassigned since) is dropped.
//
// Decisions (the docs name the inputs but not how they map to goal metrics):
// - "gap to the goal" = Pace.behindBy (whole units behind linear pace) of the agent's goals on the
//   metric the item moves, the largest if several; 0 with no such goal.
// - metric per item: appointment without outcome → appointments_held; slow prospect deal →
//   agreements_signed; other slow deals → closings; open promise and callback/follow-up/promise
//   tasks → touches; todo/document tasks → none.
// - A promise that also appears in `tasks` (same task id) is one item, the promise.
// - Appointments and slow deals carry no deadline (the deadline key is a task's due_at only).
import { type IanaZone, type Instant, localDateOf } from '../foundation/index.js';
import { metricWords } from './pace.js';
import type {
  AgentGoal,
  ApptFacts,
  GoalMetric,
  OpenStage,
  Pace,
  PlanItem,
  PlanTaskFacts,
  PlanTaskKind,
  PromiseFacts,
  SlowDealFacts,
  WeeklyPlan,
} from './types.js';

export const PLAN_MAX_ITEMS = 5;
export const PLAN_MIN_ITEMS = 3;

export interface PlanWeekInput {
  readonly goals: readonly AgentGoal[];
  readonly pace: readonly Pace[];
  readonly slowDeals: readonly SlowDealFacts[];
  readonly openPromises: readonly PromiseFacts[];
  readonly apptsWithoutOutcome: readonly ApptFacts[];
  readonly tasks: readonly PlanTaskFacts[];
  /** The agent's zone, for the dates written in evidence reasons. */
  readonly zone: IanaZone;
}

const TASK_METRIC: Record<PlanTaskKind, GoalMetric | null> = {
  todo: null,
  document: null,
  callback: 'touches',
  follow_up: 'touches',
  promise: 'touches',
};

const slowDealMetric = (stage: OpenStage): GoalMetric => (stage === 'prospect' ? 'agreements_signed' : 'closings');

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** R-PLAN-1 ranking: deadline first (soonest first), then gap (larger first), then source id/type. */
export function comparePlanItems(a: PlanItem, b: PlanItem): number {
  if (a.deadline !== null && b.deadline === null) return -1;
  if (a.deadline === null && b.deadline !== null) return 1;
  if (a.deadline !== null && b.deadline !== null && a.deadline !== b.deadline) return a.deadline - b.deadline;
  if (a.gap !== b.gap) return b.gap - a.gap;
  const ea = a.evidence[0];
  const eb = b.evidence[0];
  return cmpStr(ea?.sourceId ?? '', eb?.sourceId ?? '') || cmpStr(ea?.sourceType ?? '', eb?.sourceType ?? '') || cmpStr(a.kind, b.kind);
}

function dueWords(dueAt: Instant | null, zone: IanaZone): string {
  return dueAt === null ? 'no due date' : `due ${localDateOf(dueAt, zone)}`;
}

export function planWeek(i: PlanWeekInput): WeeklyPlan {
  const hasGoals = i.goals.length > 0;
  const goalIds = new Set(i.goals.map((g) => g.id));
  const gapByMetric = new Map<GoalMetric, number>();
  if (hasGoals) {
    for (const p of i.pace) {
      if (!goalIds.has(p.goalId)) continue;
      gapByMetric.set(p.metric, Math.max(gapByMetric.get(p.metric) ?? 0, p.behindBy));
    }
  }
  const gapOf = (m: GoalMetric | null): number => (m === null ? 0 : (gapByMetric.get(m) ?? 0));
  const behindNote = (m: GoalMetric | null): string => {
    const g = gapOf(m);
    return m !== null && g > 0 ? `; ${metricWords(m, g)} behind goal pace` : '';
  };

  const candidates: PlanItem[] = [];
  let droppedDoNotContact = 0;
  const promiseIds = new Set<string>();

  for (const p of i.openPromises) {
    if (p.doNotContact) {
      droppedDoNotContact += 1;
      continue;
    }
    if (promiseIds.has(p.taskId)) continue;
    promiseIds.add(p.taskId);
    const metric: GoalMetric = 'touches';
    candidates.push({
      kind: 'keep_promise',
      title: `Keep your promise: ${p.title}`,
      contactId: p.contactId,
      dealId: null,
      deadline: p.dueAt,
      metric,
      gap: gapOf(metric),
      evidence: [{ sourceType: 'task', sourceId: p.taskId, reason: `Open promise, ${dueWords(p.dueAt, i.zone)}${behindNote(metric)}` }],
    });
  }

  const taskIds = new Set<string>();
  for (const t of i.tasks) {
    if (t.doNotContact) {
      droppedDoNotContact += 1;
      continue;
    }
    if (promiseIds.has(t.taskId) || taskIds.has(t.taskId)) continue;
    taskIds.add(t.taskId);
    const metric = TASK_METRIC[t.kind];
    candidates.push({
      kind: 'do_task',
      title: t.title,
      contactId: t.contactId,
      dealId: t.dealId,
      deadline: t.dueAt,
      metric,
      gap: gapOf(metric),
      evidence: [{ sourceType: 'task', sourceId: t.taskId, reason: `Open ${t.kind.replace('_', '-')} task, ${dueWords(t.dueAt, i.zone)}${behindNote(metric)}` }],
    });
  }

  const apptIds = new Set<string>();
  for (const a of i.apptsWithoutOutcome) {
    if (a.doNotContact) {
      droppedDoNotContact += 1;
      continue;
    }
    if (apptIds.has(a.appointmentId)) continue;
    apptIds.add(a.appointmentId);
    const metric: GoalMetric = 'appointments_held';
    candidates.push({
      kind: 'log_outcome',
      title: 'Log the outcome of this appointment',
      contactId: a.contactId,
      dealId: null,
      deadline: null,
      metric,
      gap: gapOf(metric),
      evidence: [
        {
          sourceType: 'appointment',
          sourceId: a.appointmentId,
          reason: `Appointment on ${localDateOf(a.startsAt, i.zone)} has no outcome logged${behindNote(metric)}`,
        },
      ],
    });
  }

  const dealIds = new Set<string>();
  for (const d of i.slowDeals) {
    if (d.doNotContact) {
      droppedDoNotContact += 1;
      continue;
    }
    if (dealIds.has(d.dealId)) continue;
    dealIds.add(d.dealId);
    const metric = slowDealMetric(d.stage);
    candidates.push({
      kind: 'move_deal',
      title: `Move ${d.name} forward`,
      contactId: d.contactId,
      dealId: d.dealId,
      deadline: null,
      metric,
      gap: gapOf(metric),
      evidence: [
        {
          sourceType: 'deal',
          sourceId: d.dealId,
          reason: `Deal in ${d.stage} for ${Math.round(d.dwellDays)} days; median ${d.medianDays} (n=${d.sampleSize})${behindNote(metric)}`,
        },
      ],
    });
  }

  candidates.sort(comparePlanItems);
  const items = candidates.slice(0, PLAN_MAX_ITEMS);
  const basis = hasGoals ? 'goals_and_pipeline' : 'pipeline_only';
  let note = hasGoals
    ? 'Ranked by deadline first, then by how far each item is behind your goal pace.'
    : 'You have no goals set, so this plan is built from your pipeline only (ranked by deadline).';
  if (items.length < PLAN_MIN_ITEMS) {
    note += ` Only ${items.length === 1 ? '1 item' : `${items.length} items`} came up from your pipeline this week.`;
  }
  return { items, basis, note, candidates: candidates.length, droppedDoNotContact };
}

/**
 * Render-time filter (R-PLAN-3, E111): keeps only items whose every evidence source is in
 * `visibleSourceIds` (ids of tasks, appointments and deals the agent can see now, as returned by
 * an RLS-scoped read) and whose contact is not in `doNotContactIds` (a person-level do-not-contact
 * set since the plan was made).
 */
export function dropInvisible<T extends Pick<PlanItem, 'evidence' | 'contactId'>>(
  items: readonly T[],
  visibleSourceIds: ReadonlySet<string>,
  doNotContactIds: ReadonlySet<string> = new Set(),
): T[] {
  return items.filter(
    (it) => it.evidence.every((e) => visibleSourceIds.has(e.sourceId)) && (it.contactId === null || !doNotContactIds.has(it.contactId)),
  );
}
