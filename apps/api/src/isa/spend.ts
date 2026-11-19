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
import type { Instant } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { systemActor } from '../worker/systemActor.js';
import { AI_ISA_PROMPT_VERSION, ISA_TURN_LIMITS } from './coreSeam.js';
import type { IsaDeps } from './effects.js';
import type { AssignmentRow } from './repo.js';

export type ModelBudgetCode = 'ISA_MODEL_PERSON_DAILY_LIMIT' | 'ISA_MODEL_TENANT_DAILY_LIMIT';
export type Reservation = { runId: string } | { kind: 'retry'; retryAt: Instant } | { kind: 'done'; code: string };
interface Refused { code: ModelBudgetCode; reset: Date }

export async function lockModelBudget(tx: Tx): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('realty.isa.model-budget:' || app.tenant_id()::text, 0))`.execute(tx);
}

/**
 * Caller holds the team model-budget lock. Counts today's reservations (team-local day) and, inside both budgets,
 * inserts one. Reads tenant_settings, ai_runs and ai_isa_assignments and writes one new ai_runs row; no other row.
 */
async function countAndReserve(tx: Tx, deps: Pick<IsaDeps, 'ids'>, a: AssignmentRow, turnId: string): Promise<{ runId: string } | Refused> {
  const usage = (await sql<{ person: number; team: number; reset: Date }>`
    WITH bounds AS (
      SELECT ((now() AT TIME ZONE default_timezone)::date::timestamp AT TIME ZONE default_timezone) AS start,
             (((now() AT TIME ZONE default_timezone)::date + 1)::timestamp AT TIME ZONE default_timezone) AS reset
        FROM tenant_settings WHERE tenant_id = app.tenant_id()
    )
    SELECT count(r.id)::int AS team,
           count(r.id) FILTER (WHERE ass.contact_id = ANY(app.contact_person_ids(app.tenant_id(), ${a.contactId}::uuid)))::int AS person,
           b.reset
      FROM bounds b LEFT JOIN ai_runs r ON r.tenant_id = app.tenant_id() AND r.purpose = 'ai_isa_turn'
        AND r.created_at >= b.start AND r.created_at < b.reset
      LEFT JOIN ai_isa_assignments ass ON ass.tenant_id = r.tenant_id AND ass.id::text = r.input_refs->>'assignmentId'
     GROUP BY b.reset`.execute(tx)).rows[0]!;
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

/** The hold of a refused call: the turn waits, `deferred`, for the next team-local day. A turn that is no longer open is left as it is. */
async function holdTurn(tx: Tx, turnId: string, refused: Refused, repair: boolean): Promise<{ kind: 'retry'; retryAt: Instant } | { kind: 'done'; code: string }> {
  const held = await sql<{ id: string }>`UPDATE ai_isa_turns SET status = 'deferred', not_before = ${refused.reset}, decision = ${JSON.stringify({ code: refused.code, budgetRepair: repair })}::jsonb
    WHERE tenant_id = app.tenant_id() AND id = ${turnId}
      AND (status = 'deciding' OR (status = 'deferred' AND decision->>'code' IN ('ISA_MODEL_PERSON_DAILY_LIMIT','ISA_MODEL_TENANT_DAILY_LIMIT')))
    RETURNING id`.execute(tx);
  if (held.rows.length === 0) return { kind: 'done', code: 'DISCARDED' };
  return { kind: 'retry', retryAt: refused.reset.getTime() as Instant };
}

/** Only a budget hold reopens. Terminal and other deferred turns keep the TX-B replay fence. */
export async function reopenHeldTurn(tx: Tx, turnId: string): Promise<void> {
  await sql`UPDATE ai_isa_turns SET status = 'deciding', not_before = NULL, decision = '{}'::jsonb
    WHERE tenant_id = app.tenant_id() AND id = ${turnId} AND status = 'deferred'
      AND decision->>'code' IN ('ISA_MODEL_PERSON_DAILY_LIMIT','ISA_MODEL_TENANT_DAILY_LIMIT')`.execute(tx);
}

/** The count, the reservation or the hold, and the reopening in ONE transaction whose caller holds the team lock. */
export async function reserveModelCall(tx: Tx, deps: Pick<IsaDeps, 'ids'>, a: AssignmentRow, turnId: string, repair: boolean): Promise<Reservation> {
  const r = await countAndReserve(tx, deps, a, turnId);
  if ('code' in r) return holdTurn(tx, turnId, r, repair);
  await reopenHeldTurn(tx, turnId);
  return r;
}

/**
 * What a turn does before each provider call (the original and the repair), with no other lock held: one short
 * transaction takes the team lock, counts and reserves, and commits. A refused call is then held in a second
 * transaction, after the lock is gone (one UPDATE of the turn's own row, guarded by its status).
 */
export async function reserveForTurn(deps: Pick<IsaDeps, 'ids' | 'db'>, tenantId: string, a: AssignmentRow, turnId: string, repair: boolean): Promise<Reservation> {
  const actor = systemActor(tenantId as never, 'assistant');
  const r = await withTenantTx(actor, async (tx) => {
    await lockModelBudget(tx);
    return countAndReserve(tx, deps, a, turnId);
  }, { db: deps.db, retries: 2 });
  if ('runId' in r) return r;
  return withTenantTx(actor, (tx) => holdTurn(tx, turnId, r, repair), { db: deps.db, retries: 2 });
}
