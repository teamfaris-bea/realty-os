// The weekly plan (PHASE2_3_PLAN module 33; DATA_MODEL R-PLAN-1…3, R-OWN-27; E110, E111).
//
// Job insights.weekly_plan (hourly, per tenant, as the system actor): on each member's local Monday (the tenant
// zone; users have no zone of their own) the plan for that ISO week is built ONCE per member and week:
//   - inputs are the member's OWN pipeline only: open promises and tasks assigned to them, their appointments that
//     ended in the last 14 days with no outcome, their slow deals (v_pipeline_momentum.is_slow: dwell > 1.5× the
//     team median with n ≥ 5), and their goals whose period covers now with pace from the scoreboard definers;
//   - core planWeek picks 3–5 items, deadline first then the gap to goal pace, each with evidence; with no goals
//     the plan is built from the pipeline only and says so (E110); person-level do-not-contact contacts are never
//     suggested (R-PLAN-3);
//   - the plan is an assistant_actions row (kind weekly_plan, autonomy internal by CHECK, R-PLAN-1) under the key
//     weekly_plan:{user}:{week}; one feed card under the same key (module 18a's foreign family) links to the plan
//     page. The unique dedupe key makes the job idempotent: a rerun, a second worker or a dismissed card never
//     produces a second plan or card for that member and week.
//   - Repair: when Monday's runs were all missed (an outage), Tuesday and Wednesday still build the missing plan;
//     from Thursday on the week gets none (a plan for a week that is mostly over is noise).
// Money: the system actor reads no deal_financials here (and could not: RLS); nothing in the plan is a dollar figure.
//
// Read (GET /me/weekly-plans/:week, self): items whose source the member can no longer see AS THEIRS are dropped at
// render (E111: a deal reassigned since, a task reassigned or closed, an appointment moved to someone else), as are
// items whose contact became person-level do-not-contact since (R-PLAN-3). Read under the member's own RLS. An item
// whose contact was merged away since is shown on the survivor, where the merge moved its task, appointment or deal
// (R-OWN-24, backlog-gaps), when the member sees the survivor live and not do-not-contact; otherwise it is dropped.
//
// Accept (POST /me/weekly-plans/:week/accept, self): one tap adds the chosen items to the member's tasks. Items that
// already are a task (a promise, a task) are not copied; the others (log an outcome, move a deal) become one task
// each. Nothing is created without that tap (R-PLAN-1). A plan is accepted once.
import { type AgentGoal, type PlanItem, type WeeklyPlan, dropInvisible, goalPace, periodEnd, planWeek } from '@realty/core/insights';
import { weeklyPlanFeedKey } from '@realty/core/priority';
import { type IanaZone, type IdGenerator, type Instant, type LocalDate, type SystemActor, type UserActor, type UserId, instantFromDate, localDate, localDateOf, toIso } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { AppError } from '../errors.js';
import { createTask } from '../workspace/tasks.js';
import { addDaysLocal, isoWeekOf, isoWeekday, midnight, mondayOfIsoWeek, tenantZone } from './common.js';
import { goalActual } from './goals.js';

/** Monday = 1. Plans are built on Monday, or on Tuesday/Wednesday when every Monday run was missed. */
export const PLAN_LAST_REPAIR_WEEKDAY = 3;
/** Appointments that ended within this many days without an outcome are plan candidates. */
export const APPT_LOOKBACK_DAYS = 14;
export const PLAN_CARD_SCORE = 40;

export interface StoredPlan extends WeeklyPlan {
  readonly week: string;
  readonly builtAt: string;
}

const lit = (v: unknown) => v as never;

/** The member's own pipeline facts for planWeek (run as the system actor: tenant-wide, filtered to the member). */
/**
 * R-PLAN-3 (b7 ownership-data/F5): whether any record of the person of contact row `alias` carries the person-level
 * do-not-contact: the record, the record it was merged into, and every duplicate merged into either (0043
 * app.contact_person_ids, read under the caller's RLS like comms/repos/gate.ts personDoNotContact). False for no contact.
 */
function personDnc(alias: string) {
  return sql.raw(`(${alias}.id IS NOT NULL AND EXISTS (SELECT 1 FROM contacts pd WHERE pd.tenant_id = ${alias}.tenant_id AND pd.do_not_contact_at IS NOT NULL
                     AND pd.id = ANY (app.contact_person_ids(${alias}.tenant_id, ${alias}.id))))`);
}

export async function planInputs(tx: Tx, userId: string, zone: IanaZone, now: Instant, weekEnd: Instant) {
  const goalsR = await sql<{ id: string; user_id: string; period_kind: AgentGoal['periodKind']; period_start: string; metric: AgentGoal['metric']; target: number }>`
    SELECT id, user_id, period_kind, period_start::text AS period_start, metric, target FROM agent_goals
     WHERE tenant_id = app.tenant_id() AND user_id = ${userId} AND period_start <= ${localDateOf(now, zone)}::date`.execute(tx);
  const goals: AgentGoal[] = [];
  for (const g of goalsR.rows) {
    const goal: AgentGoal = { id: lit(g.id), userId: lit(g.user_id), periodKind: g.period_kind, periodStart: localDate(g.period_start), metric: g.metric, target: g.target };
    if (midnight(periodEnd(goal.periodKind, goal.periodStart), zone) > now) goals.push(goal);
  }
  const pace = [];
  for (const g of goals) pace.push(goalPace(g, { actual: await goalActual(tx, g, zone, now) }, now, zone));

  // b7 ownership-data/F5 (R-PLAN-3, R-OWN-24): a merged-away record is not work (the person lives on the survivor), and
  // the do-not-contact is the whole person's (app.contact_person_ids, as comms/repos/gate.ts personDoNotContact)
  const live = (alias: string) => sql.raw(`(${alias}.id IS NULL OR (${alias}.deleted_at IS NULL AND ${alias}.merged_into_contact_id IS NULL))`);
  const dnc = (alias: string) => personDnc(alias);
  const tasks = await sql<{ id: string; kind: string; contact_id: string | null; deal_id: string | null; title: string; due_at: Date | null; dnc: boolean }>`
    SELECT t.id, t.kind, t.contact_id, t.deal_id, t.title, t.due_at, ${dnc('c')} AS dnc
      FROM tasks t LEFT JOIN contacts c ON c.tenant_id = t.tenant_id AND c.id = t.contact_id
     WHERE t.tenant_id = app.tenant_id() AND t.assignee_user_id = ${userId} AND t.status = 'open' AND NOT t.needs_review
       AND (t.due_at IS NULL OR t.due_at < ${toIso(weekEnd)}::timestamptz) AND ${live('c')}
     ORDER BY t.due_at NULLS LAST, t.id LIMIT 100`.execute(tx);
  const appts = await sql<{ id: string; contact_id: string | null; starts_at: Date; dnc: boolean }>`
    SELECT a.id, a.contact_id, a.starts_at, ${dnc('c')} AS dnc
      FROM appointments a LEFT JOIN contacts c ON c.tenant_id = a.tenant_id AND c.id = a.contact_id
     WHERE a.tenant_id = app.tenant_id() AND a.user_id = ${userId} AND a.outcome IS NULL AND a.status IN ('scheduled','held')
       AND a.ends_at < ${toIso(now)}::timestamptz AND a.ends_at >= ${toIso(now)}::timestamptz - make_interval(days => ${APPT_LOOKBACK_DAYS})
       AND ${live('c')}
     ORDER BY a.starts_at, a.id LIMIT 50`.execute(tx);
  const slow = await sql<{ deal_id: string; name: string; contact_id: string; stage: string; dwell_days: string; team_median_days: string; sample_size: number; dnc: boolean }>`
    SELECT m.deal_id, d.name, d.primary_contact_id AS contact_id, m.stage, m.dwell_days, m.team_median_days, m.sample_size, ${dnc('c')} AS dnc
      FROM v_pipeline_momentum m
      JOIN deals d ON d.tenant_id = m.tenant_id AND d.id = m.deal_id
      LEFT JOIN contacts c ON c.tenant_id = d.tenant_id AND c.id = d.primary_contact_id
     WHERE m.tenant_id = app.tenant_id() AND m.owner_user_id = ${userId} AND m.is_slow AND ${live('c')}
     ORDER BY m.dwell_days DESC, m.deal_id LIMIT 50`.execute(tx);

  return {
    goals,
    pace,
    zone,
    openPromises: tasks.rows
      .filter((t) => t.kind === 'promise')
      .map((t) => ({ taskId: lit(t.id), contactId: lit(t.contact_id), title: t.title, dueAt: t.due_at ? instantFromDate(t.due_at) : null, doNotContact: t.dnc })),
    tasks: tasks.rows
      .filter((t) => t.kind !== 'promise')
      .map((t) => ({ taskId: lit(t.id), kind: t.kind as never, contactId: lit(t.contact_id), dealId: lit(t.deal_id), title: t.title, dueAt: t.due_at ? instantFromDate(t.due_at) : null, doNotContact: t.dnc })),
    apptsWithoutOutcome: appts.rows.map((a) => ({ appointmentId: lit(a.id), contactId: lit(a.contact_id), startsAt: instantFromDate(a.starts_at), doNotContact: a.dnc })),
    slowDeals: slow.rows.map((d) => ({
      dealId: lit(d.deal_id),
      contactId: lit(d.contact_id),
      name: d.name,
      stage: d.stage as never,
      dwellDays: Number(d.dwell_days),
      medianDays: Number(d.team_median_days),
      sampleSize: d.sample_size,
      doNotContact: d.dnc,
    })),
  };
}

function cardReasons(plan: WeeklyPlan): { code: string; text: string }[] {
  return plan.items.map((i) => ({ code: 'PLAN_ITEM', text: i.title.slice(0, 200) }));
}

export type MaterializeOutcome = 'built' | 'exists';

/** Builds and stores the member's plan for `week` unless one exists (any status). Runs as the system actor. */
export async function materializeWeeklyPlan(tx: Tx, ids: IdGenerator, userId: string, week: string, zone: IanaZone, now: Instant): Promise<MaterializeOutcome> {
  const key = weeklyPlanFeedKey(userId as UserId, week);
  const exists = await sql<{ id: string }>`SELECT id FROM assistant_actions WHERE tenant_id = app.tenant_id() AND dedupe_key = ${key}`.execute(tx);
  if (exists.rows[0]) return 'exists';
  const monday = mondayOfIsoWeek(week);
  if (!monday) throw new AppError('VALIDATION_FAILED', { reason: 'WEEK_INVALID' });
  const weekEnd = midnight(addDaysLocal(monday, 7), zone);
  const plan = planWeek(await planInputs(tx, userId, zone, now, weekEnd));
  const stored: StoredPlan = { ...plan, week, builtAt: toIso(now) };
  const ins = await sql<{ id: string }>`
    INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload, trigger_ref, dedupe_key)
    VALUES (app.tenant_id(), ${ids.next<'AssistantActionId'>()}, NULL, 'weekly_plan', 'internal', 'internal', 'proposed', ${userId},
            ${plan.note.slice(0, 300)}, ${JSON.stringify(stored)}::jsonb, ${JSON.stringify({ week })}::jsonb, ${key})
    ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
    RETURNING id`.execute(tx);
  const actionId = ins.rows[0]?.id;
  if (!actionId) return 'exists';
  if (plan.items.length > 0) {
    // one card under module 18a's foreign key family; the scorer never touches it. A plan is inserted once per
    // member and week (above), so the card is too: a dismissed card is never brought back.
    await sql`
      INSERT INTO priority_feed_items (tenant_id, id, user_id, item_type, band, contact_id, subject_type, subject_id, assistant_action_id, score, reasons, dedupe_key)
      VALUES (app.tenant_id(), ${ids.next<'FeedItemId'>()}, ${userId}, 'weekly_plan', 'scored', NULL, 'user', ${userId}, ${actionId},
              ${PLAN_CARD_SCORE}, ${JSON.stringify(cardReasons(plan))}::jsonb, ${key})
      ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE state IN ('open','snoozed') DO NOTHING`.execute(tx);
  }
  return 'built';
}

/** The hourly reconcile of one tenant: every active member whose local weekday is Monday (or a repair day). */
export async function reconcileWeeklyPlans(tx: Tx, _actor: SystemActor, ids: IdGenerator, now: Instant): Promise<{ week: string | null; built: number; existing: number }> {
  const zone = await tenantZone(tx);
  const today = localDateOf(now, zone);
  if (isoWeekday(today) > PLAN_LAST_REPAIR_WEEKDAY) return { week: null, built: 0, existing: 0 };
  const week = isoWeekOf(today);
  const members = await sql<{ user_id: string }>`
    SELECT user_id FROM memberships WHERE tenant_id = app.tenant_id() AND status = 'active' AND role <> 'tc' ORDER BY user_id`.execute(tx);
  let built = 0;
  let existing = 0;
  for (const m of members.rows) {
    const o = await materializeWeeklyPlan(tx, ids, m.user_id, week, zone, now);
    if (o === 'built') built += 1;
    else existing += 1;
  }
  return { week, built, existing };
}

// ---- the member's read and accept (self) ---------------------------------------------------------

interface PlanRow {
  id: string;
  status: string;
  payload: StoredPlan;
  edited_payload: { acceptedIndexes?: number[]; taskIds?: string[] } | null;
  decided_at: Date | null;
}

async function planRow(tx: Tx, actor: UserActor, week: string, lock = false): Promise<PlanRow | null> {
  const key = weeklyPlanFeedKey(actor.userId, week);
  const r = await sql<PlanRow>`
    SELECT id, status, payload, edited_payload, decided_at FROM assistant_actions
     WHERE tenant_id = app.tenant_id() AND dedupe_key = ${key} AND kind = 'weekly_plan' AND owner_user_id = ${actor.userId}
     ${lock ? sql`FOR UPDATE` : sql``}`.execute(tx);
  return r.rows[0] ?? null;
}

/**
 * Ids of the sources the member can still see AS THEIRS, each with its CURRENT contact (a task's or appointment's
 * contact_id, a deal's primary_contact_id), and the person-level do-not-contact contacts (R-PLAN-3).
 */
async function renderFilter(tx: Tx, actor: UserActor, items: readonly PlanItem[]) {
  const ids = (t: string) => items.flatMap((i) => i.evidence.filter((e) => e.sourceType === t).map((e) => e.sourceId));
  const r = await sql<{ id: string; contact_id: string | null }>`
    SELECT t.id, t.contact_id FROM tasks t WHERE t.tenant_id = app.tenant_id() AND t.id = ANY (${ids('task')}::uuid[]) AND t.assignee_user_id = ${actor.userId} AND t.status = 'open'
    UNION ALL
    SELECT a.id, a.contact_id FROM appointments a WHERE a.tenant_id = app.tenant_id() AND a.id = ANY (${ids('appointment')}::uuid[]) AND a.user_id = ${actor.userId}
    UNION ALL
    SELECT d.id, d.primary_contact_id FROM deals d WHERE d.tenant_id = app.tenant_id() AND d.id = ANY (${ids('deal')}::uuid[]) AND d.owner_user_id = ${actor.userId}
       AND d.stage NOT IN ('closed','lost')`.execute(tx);
  const current = new Map(r.rows.map((x) => [x.id, x.contact_id]));
  // the stored contacts and the evidence rows' current ones (a merge moves the work to the survivor, R-OWN-24)
  const stored = items.map((i) => i.contactId).filter((c): c is NonNullable<typeof c> => c !== null);
  const contacts = [...new Set([...stored, ...r.rows.flatMap((x) => (x.contact_id ? [x.contact_id] : []))])];
  // a contact the member can no longer see is dropped too: it is not in the visible set below
  const c = await sql<{ id: string; dnc: boolean }>`
    SELECT c.id, ${personDnc('c')} AS dnc FROM contacts c
     WHERE c.tenant_id = app.tenant_id() AND c.id = ANY (${contacts}::uuid[]) AND c.deleted_at IS NULL
       AND c.merged_into_contact_id IS NULL`.execute(tx);
  const liveContacts = new Set(c.rows.map((x) => x.id));
  const dnc = new Set(c.rows.filter((x) => x.dnc).map((x) => x.id));
  for (const id of contacts) if (!liveContacts.has(id)) dnc.add(id);
  return { visible: new Set(current.keys()), current, liveContacts, dnc };
}

/**
 * R-OWN-24 / R-PLAN-3 (backlog-gaps): the items as they render now. An item whose stored contact is no longer live (a
 * merge moved its work to the survivor) is shown on its evidence's CURRENT contact, but only when every visible
 * evidence row names that one contact and it is visible, live and not do-not-contact under the caller's RLS; otherwise
 * the item is left as stored, so dropInvisible drops it as before. Each copy keeps its stored index (same position).
 */
function rekeyed(items: readonly PlanItem[], f: Awaited<ReturnType<typeof renderFilter>>): PlanItem[] {
  return items.map((i) => {
    if (i.contactId === null || f.liveContacts.has(i.contactId)) return i;
    const now = new Set(i.evidence.filter((e) => f.visible.has(e.sourceId)).map((e) => f.current.get(e.sourceId) ?? null));
    if (now.size !== 1) return i;
    const to = [...now][0]!;
    if (to === null || to === i.contactId || !f.liveContacts.has(to) || f.dnc.has(to)) return i;
    return { ...i, contactId: to as PlanItem['contactId'] };
  });
}

/** The stored items, the view of each at its stored index, and the kept views (dropInvisible, core, unchanged). */
async function renderItems(tx: Tx, actor: UserActor, all: readonly PlanItem[]) {
  const f = await renderFilter(tx, actor, all);
  const view = rekeyed(all, f);
  return { view, kept: new Set(dropInvisible(view, f.visible, f.dnc)) };
}

export async function getPlan(tx: Tx, actor: UserActor, week: string) {
  const row = await planRow(tx, actor, week);
  const zone = (await tenantZone(tx)) as string;
  if (!row) return { week, zone, exists: false as const };
  const all = row.payload.items;
  const { view, kept } = await renderItems(tx, actor, all);
  const accepted = row.status === 'executed' ? (row.edited_payload ?? {}) : null;
  return {
    week,
    zone,
    exists: true as const,
    basis: row.payload.basis,
    note: row.payload.note,
    builtAt: row.payload.builtAt,
    items: view.flatMap((i, index) => (kept.has(i) ? [{ index, item: i, accepted: accepted?.acceptedIndexes?.includes(index) ?? false }] : [])),
    droppedSinceBuilt: all.length - kept.size,
    accepted: accepted ? { at: row.decided_at!.toISOString(), taskIds: accepted.taskIds ?? [] } : null,
  };
}

export async function acceptPlan(tx: Tx, actor: UserActor, ids: IdGenerator, now: Instant, week: string, indexes: readonly number[]) {
  const row = await planRow(tx, actor, week, true);
  if (!row) throw new AppError('NOT_FOUND');
  if (row.status !== 'proposed') throw new AppError('PLAN_ALREADY_ACCEPTED');
  const all = row.payload.items;
  // the items as rendered: a re-keyed item's task is created on its current contact (the merge survivor)
  const { view, kept } = await renderItems(tx, actor, all);
  const chosen = [...new Set(indexes)].sort((a, b) => a - b);
  for (const i of chosen) if (!view[i] || !kept.has(view[i])) throw new AppError('NOT_FOUND');
  const taskIds: string[] = [];
  for (const i of chosen) {
    const item = view[i]!;
    const existingTask = item.evidence.find((e) => e.sourceType === 'task');
    if (existingTask) {
      taskIds.push(existingTask.sourceId);
      continue;
    }
    taskIds.push(
      await createTask(tx, actor, ids, {
        title: item.title.slice(0, 300),
        kind: item.kind === 'move_deal' ? 'follow_up' : 'todo',
        contactId: item.contactId,
        dealId: item.dealId,
        notes: item.evidence.map((e) => e.reason).join('\n').slice(0, 5000),
      }),
    );
  }
  // the member's own decision (assistant_actions_decision_guard: a person, as themselves)
  await sql`
    UPDATE assistant_actions SET status = 'executed', decided_by_user_id = ${actor.userId}, decided_at = ${toIso(now)}::timestamptz,
           edited_payload = ${JSON.stringify({ acceptedIndexes: chosen, taskIds })}::jsonb, updated_at = now()
     WHERE tenant_id = app.tenant_id() AND id = ${row.id}`.execute(tx);
  await sql`
    UPDATE priority_feed_items SET state = 'done', resolved_at = ${toIso(now)}::timestamptz, snoozed_until = NULL, updated_at = now()
     WHERE tenant_id = app.tenant_id() AND assistant_action_id = ${row.id} AND state IN ('open','snoozed')`.execute(tx);
  return getPlan(tx, actor, week);
}

/** This week's ISO label for the caller (tenant zone). */
export async function currentWeek(tx: Tx, now: Instant): Promise<{ week: string; monday: LocalDate }> {
  const zone = await tenantZone(tx);
  const today = localDateOf(now, zone);
  const week = isoWeekOf(today);
  return { week, monday: mondayOfIsoWeek(week)! };
}
