// Durable reservations in the existing RLS-protected ai_runs ledger. A reservation is never refunded:
// a crash can leave an unknown provider outcome, so counting it is deliberately fail closed.
import type { Instant } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { AI_ISA_PROMPT_VERSION, ISA_TURN_LIMITS } from './coreSeam.js';
import type { IsaDeps } from './effects.js';
import type { AssignmentRow } from './repo.js';

export async function lockModelBudget(tx: Tx): Promise<void> {
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('realty.isa.model-budget:' || app.tenant_id()::text, 0))`.execute(tx);
}

/** Caller holds the tenant model-budget lock before taking contact/assignment locks. */
export async function reserveModelCall(tx: Tx, deps: Pick<IsaDeps, 'ids'>, a: AssignmentRow, turnId: string, repair: boolean): Promise<{ runId: string } | { kind: 'retry'; retryAt: Instant } | { kind: 'done'; code: string }> {
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
  if (code !== null) {
    const held = await sql<{ id: string }>`UPDATE ai_isa_turns SET status = 'deferred', not_before = ${usage.reset}, decision = ${JSON.stringify({ code, budgetRepair: repair })}::jsonb
      WHERE tenant_id = app.tenant_id() AND id = ${turnId}
        AND (status = 'deciding' OR (status = 'deferred' AND decision->>'code' IN ('ISA_MODEL_PERSON_DAILY_LIMIT','ISA_MODEL_TENANT_DAILY_LIMIT')))
      RETURNING id`.execute(tx);
    if (held.rows.length === 0) return { kind: 'done', code: 'DISCARDED' };
    return { kind: 'retry', retryAt: usage.reset.getTime() as Instant };
  }
  const runId = deps.ids.next<'AiRunId'>() as string;
  await sql`INSERT INTO ai_runs (tenant_id,id,purpose,model,prompt_template_key,prompt_version,input_refs,
      internal_signals,status,requested_for_user_id)
    VALUES (app.tenant_id(),${runId},'ai_isa_turn','unknown','ai_isa_turn',${AI_ISA_PROMPT_VERSION},
      ${JSON.stringify({ assignmentId: a.id, turnId })}::jsonb,'{"error":"CALL_OUTCOME_UNKNOWN"}'::jsonb,'failed',${a.ownerUserId})`.execute(tx);
  // Only a budget hold can reopen here. Terminal/other deferred turns retain the TX-B replay fence.
  await sql`UPDATE ai_isa_turns SET status = 'deciding', not_before = NULL, decision = '{}'::jsonb
    WHERE tenant_id = app.tenant_id() AND id = ${turnId} AND status = 'deferred'
      AND decision->>'code' IN ('ISA_MODEL_PERSON_DAILY_LIMIT','ISA_MODEL_TENANT_DAILY_LIMIT')`.execute(tx);
  return { runId };
}
