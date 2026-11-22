// Durable reservations in the existing RLS-protected ai_runs ledger (R-ISA-20; docs/AI_ISA.md §3.7, §4.2).
//
// What is counted: RESERVED calls. One ai_runs row (purpose ai_isa_turn) is inserted, and committed, before each
// provider call; the day's rows are the count. A reservation is never refunded: a provider failure keeps its row
// (status failed, internal_signals.error PROVIDER, null tokens), and a crash can leave an unknown provider outcome
// (CALL_OUTCOME_UNKNOWN), so counting it is deliberately fail closed.
//
// The team lock: reserveForTurn takes it in a transaction of its own that does nothing but count and insert, so it
// is held for that moment only: never across a provider call, never together with a contact, turn or assignment
// lock (§3.7 locks 1–6), and never by a turn that makes no model call. The hold of a refused turn is written after
// that transaction has committed, without the lock.
//
// The day (documented, not built for; docs/AI_ISA.md §3.7): a call is counted in the team-local day its reservation
// transaction STARTED in (now() is the transaction's start, and created_at defaults to it), so a reservation that
// starts just before midnight and waits for the team lock past it is counted in the day that ended. The day's bounds
// are read from the team's time zone each time: changing the zone moves the window from the next reservation on
// (a day can be shorter or longer once, and calls already counted are counted by their instants in the new window).
import { createHash } from 'node:crypto';
import type { Instant } from '@realty/core/foundation';
import { type Tx, enqueueJob, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { systemActor } from '../worker/systemActor.js';
import { backstopInTx } from './backstop.js';
import { AI_ISA_PROMPT_VERSION, ISA_TURN_LIMITS } from './coreSeam.js';
import { activityCardInTx, budgetHoldNoticeInTx, type IsaDeps } from './effects.js';
import { lockForTurn, type AssignmentRow } from './repo.js';
import { BUDGET_HOLD_REPLY } from './sentences.js';

export type ModelBudgetCode = 'ISA_MODEL_PERSON_DAILY_LIMIT' | 'ISA_MODEL_TENANT_DAILY_LIMIT';
export type Reservation = { runId: string } | { kind: 'retry'; retryAt: Instant } | { kind: 'done'; code: string };
interface Refused { code: ModelBudgetCode; reset: Date }

/** The turn a call is reserved for, as the run that prepared it knows it. */
export interface TurnCall {
  id: string;
  /** the conversation's inbound sequence the run pinned in TX-A (a newer inbound makes the turn stale, as in TX-B) */
  pinnedSeq: number;
  /** the repair call of the turn (the second call after a schema failure) */
  repair: boolean;
  /** who resumes the turn if it is held: the worker job that runs it (its id), or RESUME_OWNER; null for a run outside a job (tests) */
  owner: string | null;
  /** true: the job that runs the turn is parked until the rollover; false (E908, a sweep-triggered turn): it finishes and a resume job is queued */
  park: boolean;
  /** the person's reply waits for this call (the machine's inboundUnanswered); false for a start or a follow-up */
  inboundUnanswered: boolean;
}

/** E908: the owner written on a held turn that the resume job resumes (never a job id: those are digits). */
export const RESUME_OWNER = 'resume';

/**
 * E904: every held turn of a team would otherwise resume at the same instant (the rollover). Each assignment's resume
 * waits a fixed part of the first ten minutes after it, derived from the assignment id (no randomness: a replay parks
 * the job at the same instant).
 */
export const BUDGET_RESUME_SPREAD_MS = 10 * 60_000;
export function budgetResumeSpreadMs(assignmentId: string): number {
  return createHash('sha256').update(assignmentId, 'utf8').digest().readUInt32BE(0) % BUDGET_RESUME_SPREAD_MS;
}

export async function lockModelBudget(tx: Tx): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('realty.isa.model-budget:' || app.tenant_id()::text, 0))`.execute(tx);
}

/** The team-local day a call is counted in: [start, reset), from the team's time zone and the transaction's now(). */
export async function modelBudgetDay(tx: Tx): Promise<{ start: Date; reset: Date }> {
  return (await sql<{ start: Date; reset: Date }>`
    SELECT ((now() AT TIME ZONE default_timezone)::date::timestamp AT TIME ZONE default_timezone) AS start,
           (((now() AT TIME ZONE default_timezone)::date + 1)::timestamp AT TIME ZONE default_timezone) AS reset
      FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx)).rows[0]!;
}

/**
 * The count of the day's reserved calls: the team's, and those of the person `contactId` belongs to. It runs under the
 * team model-budget lock, so it must stay short at any ledger size: the day's bounds are parameters (modelBudgetDay,
 * read first in the same transaction), so ai_runs is read through ai_runs_purpose_created_idx (tenant_id, purpose,
 * created_at; migration 0160) for the day's `ai_isa_turn` rows only, never the tenant's whole ledger
 * (spend.index.test.ts holds the plan to that).
 */
export function modelBudgetUsageSql(contactId: string, day: { start: Date; reset: Date }) {
  return sql<{ person: number; team: number }>`
    SELECT count(r.id)::int AS team,
           count(r.id) FILTER (WHERE ass.contact_id = ANY(app.contact_person_ids(app.tenant_id(), ${contactId}::uuid)))::int AS person
      FROM ai_runs r
      LEFT JOIN ai_isa_assignments ass ON ass.tenant_id = r.tenant_id AND ass.id::text = r.input_refs->>'assignmentId'
     WHERE r.tenant_id = app.tenant_id() AND r.purpose = 'ai_isa_turn'
       AND r.created_at >= ${day.start} AND r.created_at < ${day.reset}`;
}

/**
 * Caller holds the team model-budget lock. Counts today's reservations (team-local day) and, inside both budgets,
 * inserts one. Reads tenant_settings, ai_runs and ai_isa_assignments and writes one new ai_runs row; no other row.
 */
async function countAndReserve(tx: Tx, deps: Pick<IsaDeps, 'ids'>, a: AssignmentRow, turnId: string): Promise<{ runId: string } | Refused> {
  const day = await modelBudgetDay(tx);
  const usage = { ...(await modelBudgetUsageSql(a.contactId, day).execute(tx)).rows[0]!, reset: day.reset };
  const code = usage.person >= ISA_TURN_LIMITS.modelCallsPerPersonPerDay ? 'ISA_MODEL_PERSON_DAILY_LIMIT'
    : usage.team >= ISA_TURN_LIMITS.modelCallsPerTenantPerDay ? 'ISA_MODEL_TENANT_DAILY_LIMIT' : null;
  if (code !== null) return { code, reset: usage.reset };
  const runId = deps.ids.next<'AiRunId'>() as string;
  await sql`INSERT INTO ai_runs (tenant_id,id,purpose,model,prompt_template_key,prompt_version,input_refs,
      internal_signals,status,requested_for_user_id)
    VALUES (app.tenant_id(),${runId},'ai_isa_turn','unknown','ai_isa_turn',${AI_ISA_PROMPT_VERSION},
      ${JSON.stringify({ assignmentId: a.id, turnId })}::jsonb,'{"error":"CALL_OUTCOME_UNKNOWN"}'::jsonb,'failed',${a.ownerUserId})`.execute(tx);
  return { runId };
}

/**
 * The hold of a refused call: the turn waits, `deferred`, for the next team-local day (`not_before`), and the job that
 * owns it is parked until then plus the assignment's spread. A turn that is no longer open is left as it is. A turn an
 * inbound has overtaken since TX-A pinned its sequence is not held: it is `stale` (E493, as TX-B does it) and a new
 * turn reads both messages, so a person never has two held turns (E904).
 */
async function holdTurn(tx: Tx, deps: Pick<IsaDeps, 'ids'>, a: AssignmentRow, t: TurnCall, refused: Refused, now: Instant): Promise<{ kind: 'retry'; retryAt: Instant } | { kind: 'done'; code: string }> {
  // The turn lock, then the sequence again. A newer inbound commits under this same lock (TX-A). Without it, holdTurn
  // can read the old sequence, the newer inbound can commit (supersedeHeldTurns only retires rows already deferred),
  // and this update then leaves both turns open, each able to text the next day.
  await lockForTurn(tx, a.contactId, a.id);
  const open = sql`(status = 'deciding' OR (status = 'deferred' AND decision->>'code' IN ('ISA_MODEL_PERSON_DAILY_LIMIT','ISA_MODEL_TENANT_DAILY_LIMIT')))`;
  const conv = await sql<{ seq: string | null }>`SELECT inbound_seq AS seq FROM conversations WHERE tenant_id = app.tenant_id() AND contact_id = ${a.contactId}`.execute(tx);
  const seq = Number(conv.rows[0]?.seq ?? 0);
  if (seq > t.pinnedSeq) {
    const stale = await sql<{ id: string }>`UPDATE ai_isa_turns SET status = 'stale', not_before = NULL, decision = '{"code":"ISA_STALE_REPLY"}'::jsonb
      WHERE tenant_id = app.tenant_id() AND id = ${t.id} AND ${open} RETURNING id`.execute(tx);
    if (stale.rows.length === 0) return { kind: 'done', code: 'DISCARDED' };
    await enqueueJob(tx, { queue: 'realtime', kind: 'ai_isa.turn', payload: { assignmentId: a.id, trigger: 'inbound', epoch: a.epoch }, dedupeKey: `ai_isa.turn:${a.id}:${a.epoch}:${seq}` });
    return { kind: 'done', code: 'ISA_STALE_REPLY' };
  }
  const decision = { code: refused.code, budgetRepair: t.repair, ...(t.owner !== null ? { job: t.owner } : {}) };
  // inbound_seq <= pinned is part of the update, re-read in the statement, so a sequence that moved after the read above
  // still cannot defer the turn.
  const held = await sql<{ id: string }>`UPDATE ai_isa_turns SET status = 'deferred', not_before = ${refused.reset}, decision = ${JSON.stringify(decision)}::jsonb
    WHERE tenant_id = app.tenant_id() AND id = ${t.id} AND ${open}
      AND COALESCE((SELECT c.inbound_seq FROM conversations c WHERE c.tenant_id = app.tenant_id() AND c.contact_id = ${a.contactId}), 0) <= ${t.pinnedSeq}
    RETURNING id`.execute(tx);
  if (held.rows.length === 0) return { kind: 'done', code: 'DISCARDED' };
  // E905: the hold is visible to a human in this same transaction, and nothing about it goes to the person. A reply
  // that now waits until tomorrow gets the existing unanswered-inbound backstop at once (pinned card, handback,
  // notification; not after 10 minutes) and an activity card that says it waits. A start or a follow-up (nobody wrote)
  // gets the owner's notification. Every write has its dedupe key: a job re-run while still held writes nothing twice.
  if (t.inboundUnanswered) {
    await backstopInTx(tx, deps, a, null, now, { immediate: true, explanation: `They replied. ${BUDGET_HOLD_REPLY}` });
    await activityCardInTx(tx, deps, a, true);
  } else {
    await budgetHoldNoticeInTx(tx, deps, a, refused.reset, now);
  }
  const resumeAt = (refused.reset.getTime() + budgetResumeSpreadMs(a.id)) as Instant;
  if (!t.park) {
    // E908: the sweep's job is not parked. One resume job per care and epoch (a live one makes this a no-op, and it
    // resumes this turn: the owner written above is RESUME_OWNER); a resume job refused again parks itself (park).
    await enqueueJob(tx, { queue: 'realtime', kind: 'ai_isa.turn', payload: { assignmentId: a.id, trigger: 'sweep', epoch: a.epoch, resume: true },
      dedupeKey: `ai_isa.turn:${a.id}:${a.epoch}:budget`, runAt: resumeAt });
    return { kind: 'done', code: 'HELD_FOR_RESUME' };
  }
  return { kind: 'retry', retryAt: resumeAt };
}

/**
 * E904: one open model turn per assignment. When a newer turn of the assignment awaits the model (a newer inbound was
 * consumed), every other turn of it still held at a budget is superseded (`stale`), in the transaction that consumed
 * the inbound (TX-A, under the turn lock). The newer turn's prompt reads every message, so one call answers them all.
 */
export async function supersedeHeldTurns(tx: Tx, assignmentId: string, exceptTurnId: string): Promise<number> {
  const r = await sql<{ id: string }>`UPDATE ai_isa_turns SET status = 'stale', not_before = NULL,
      decision = jsonb_strip_nulls(jsonb_build_object('code', 'ISA_SUPERSEDED_BY_NEWER_TURN', 'held', decision->>'code', 'job', decision->>'job'))
    WHERE tenant_id = app.tenant_id() AND assignment_id = ${assignmentId} AND id <> ${exceptTurnId} AND status = 'deferred'
      AND decision->>'code' IN ('ISA_MODEL_PERSON_DAILY_LIMIT','ISA_MODEL_TENANT_DAILY_LIMIT') RETURNING id`.execute(tx);
  return r.rows.length;
}

/**
 * What a turn does before each provider call (the original and the repair), with no other lock held: one short
 * transaction takes the team lock, counts and reserves, and commits. A refused call is then held in a second
 * transaction, after the budget lock is gone. holdTurn takes the turn lock, re-reads the inbound sequence, and the
 * deferred update requires that sequence still be the one TX-A pinned. With that it writes what tells the owner
 * (E905) and, for a sweep-triggered turn, the resume job (E908). This is the only reservation path:
 * turn.spend.test.ts and turn.budgetLock.test.ts exercise it, as runTurn does.
 */
export async function reserveForTurn(deps: Pick<IsaDeps, 'ids' | 'db'>, tenantId: string, a: AssignmentRow, t: TurnCall): Promise<Reservation> {
  const actor = systemActor(tenantId as never, 'assistant');
  const r = await withTenantTx(actor, async (tx) => {
    await lockModelBudget(tx);
    return countAndReserve(tx, deps, a, t.id);
  }, { db: deps.db, retries: 2 });
  if ('runId' in r) return r;
  return withTenantTx(actor, (tx, now) => holdTurn(tx, deps, a, t, r, now), { db: deps.db, retries: 2 });
}
