// The call pipeline (ARCHITECTURE §11; A2, A4, A5; R-AST-1, R-AST-2, R-AST-5, R-ACC-2; E33, E34):
//   transcript (ready, decrypted only inside the run) → call_summary claims (commitments, preferences,
//   dates, next steps) with transcript-offset evidence → promise TASKS for commitments (due date only when
//   the date claim is verified and unambiguous; otherwise the task is needs_review with no due date) →
//   a saved-search proposal from the client's stated criteria (search_proposal run; unchecked criteria
//   for needs-review claims).
// Each step is idempotent per call (dedupe keys), so a re-run (job retry, scan) never duplicates.
// R-AST-18: AI off ⇒ no provider call and nothing produced.
import { type Claim, taskDueFromClaim } from '@realty/core/assistant';
import type { Instant, SystemActor } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import * as A from './repos/actions.js';
import { runModel } from './runs.js';
import { proposeSavedSearchInTx } from './searches.js';
import { ASSISTANT_JOBS, type AssistantDeps } from './types.js';

const PROMISE_KINDS = new Set(['commitment']);

async function callFacts(tx: Tx, callId: string): Promise<{ contactId: string; agentUserId: string | null; ready: boolean } | null> {
  const r = await sql<{ contact_id: string; agent_user_id: string | null; ready: boolean }>`
    SELECT c.contact_id, c.agent_user_id,
           EXISTS (SELECT 1 FROM recordings r JOIN transcripts t ON t.tenant_id = r.tenant_id AND t.recording_id = r.id
                    WHERE r.tenant_id = c.tenant_id AND r.call_id = c.id AND t.status = 'ready') AS ready
      FROM calls c WHERE c.tenant_id = app.tenant_id() AND c.id = ${callId}`.execute(tx);
  const c = r.rows[0];
  return c ? { contactId: c.contact_id, agentUserId: c.agent_user_id, ready: c.ready } : null;
}

async function insertPromiseTasks(tx: Tx, deps: AssistantDeps, actionId: string, contactId: string, assignee: string, claims: readonly Claim[]): Promise<number> {
  let n = 0;
  for (const c of claims) {
    if (!PROMISE_KINDS.has(c.kind)) continue;
    const due = taskDueFromClaim(c);
    // R-AST-5 (DB CHECK): an open promise with an unpinned date carries no due date
    await sql`
      INSERT INTO tasks (tenant_id, id, assignee_user_id, contact_id, kind, title, due_at, due_all_day, due_tz, status, created_by_kind,
        source_action_id, source_claim_id, needs_review)
      VALUES (app.tenant_id(), ${deps.ids.next<'TaskId'>()}, ${assignee}, ${contactId}, 'promise', ${c.text.slice(0, 300)},
        ${due.dueAt === null ? null : new Date(due.dueAt).toISOString()}::timestamptz, ${due.dueAllDay}, ${due.dueTz}, 'open', 'assistant',
        ${actionId}, ${c.id}, ${due.needsReview})`.execute(tx);
    n += 1;
  }
  return n;
}

export type CallPipelineResult = { kind: 'done'; summaryActionId: string | null; promises: number; searchId: string | null } | { kind: 'skipped'; reason: string };

/** Summarizes one call with a ready transcript. */
export async function summarizeCall(actor: SystemActor, callId: string, deps: AssistantDeps): Promise<CallPipelineResult> {
  const pre = await withTenantTx(actor, async (tx) => {
    const c = await callFacts(tx, callId);
    if (!c) return null;
    const existing = await A.actionByDedupeKey(tx, `call_summary:${callId}`);
    const r = await sql<{ owner_user_id: string | null }>`SELECT owner_user_id FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${c.contactId}`.execute(tx);
    return { ...c, done: existing !== null, ownerUserId: r.rows[0]?.owner_user_id ?? null };
  }, { db: deps.db });
  if (!pre) return { kind: 'skipped', reason: 'CALL_MISSING' };
  if (!pre.ready) return { kind: 'skipped', reason: 'TRANSCRIPT_NOT_READY' };
  const forUser = pre.agentUserId ?? pre.ownerUserId;
  if (!forUser) return { kind: 'skipped', reason: 'NO_AGENT' };
  const trigger = { kind: 'call_ready' as const, callId };

  let summaryActionId: string | null = null;
  let promises = 0;
  if (!pre.done) {
    const s = await runModel(actor, deps, { purpose: 'call_summary', contactId: pre.contactId, forUserId: forUser, callIds: [callId], trigger }, async (tx, run, now: Instant) => {
      if (run.status !== 'succeeded' || run.claims.length === 0) return null;
      const id = deps.ids.next<'AssistantActionId'>();
      const ok = await A.insertAction(tx, { envelope: deps.envelope, tenantId: actor.tenantId, ids: deps.ids }, {
        id,
        contactId: pre.contactId,
        kind: 'call_summary',
        category: 'internal',
        autonomy: 'internal',
        playbookVersionId: null,
        status: 'proposed',
        ownerUserId: forUser,
        explanation: run.explanation ?? 'What was said on the call, with where it was said.',
        payload: { callId },
        pinnedInboundSeq: run.inboundSeq,
        boundOwnershipSeq: run.contact.periodSeq,
        aiRunId: run.aiRunId,
        triggerRef: trigger,
        dedupeKey: `call_summary:${callId}`,
        claims: run.claims,
      });
      if (!ok) return null;
      const n = await insertPromiseTasks(tx, deps, id, pre.contactId, forUser, run.claims);
      const review = run.claims.filter((c) => c.needsReview).length;
      await A.upsertFeed(tx, deps.ids, {
        userId: forUser,
        itemType: 'assistant_draft',
        contactId: pre.contactId,
        subjectType: 'assistant_action',
        subjectId: id,
        assistantActionId: id,
        score: 45,
        reasons: [{ code: 'CALL_SUMMARY', text: `Call summary ready${n > 0 ? ` · ${n} follow-up${n === 1 ? '' : 's'}` : ''}${review > 0 ? ` · ${review} to check` : ''}` }],
        dedupeKey: `call_summary:${callId}`,
      });
      void now;
      return { id, n };
    });
    if (s && typeof s === 'object' && 'skipped' in s) return { kind: 'skipped', reason: s.skipped };
    if (s) {
      summaryActionId = s.id;
      promises = s.n;
    }
  }

  let searchId: string | null = null;
  const done = await withTenantTx(actor, async (tx) => (await A.actionByDedupeKey(tx, `search_proposal:${callId}`)) !== null, { db: deps.db });
  if (!done) {
    const s = await runModel(actor, deps, { purpose: 'search_proposal', contactId: pre.contactId, forUserId: forUser, callIds: [callId], trigger }, async (tx, run, now) => {
      if (run.status !== 'succeeded') return null;
      return proposeSavedSearchInTx(tx, deps, actor.tenantId, { contact: run.contact, claims: run.claims, aiRunId: run.aiRunId, callId, inboundSeq: run.inboundSeq, now });
    });
    if (s && typeof s === 'object' && 'searchId' in s) searchId = s.searchId;
  }
  return { kind: 'done', summaryActionId, promises, searchId };
}

/** Calls with a ready transcript in the last 2 days and no summary yet (the scan behind assistant.call_summary). */
export async function callsAwaitingSummary(tx: Tx, now: Instant): Promise<string[]> {
  const r = await sql<{ id: string }>`
    SELECT c.id FROM calls c
      JOIN recordings r ON r.tenant_id = c.tenant_id AND r.call_id = c.id
      JOIN transcripts t ON t.tenant_id = r.tenant_id AND t.recording_id = r.id
     WHERE c.tenant_id = app.tenant_id() AND t.status = 'ready' AND NOT c.imported
       AND t.updated_at > ${new Date(now).toISOString()}::timestamptz - interval '2 days'
       AND NOT EXISTS (SELECT 1 FROM assistant_actions a WHERE a.tenant_id = c.tenant_id AND a.dedupe_key = 'call_summary:' || c.id::text)
       AND NOT EXISTS (SELECT 1 FROM ai_runs ar WHERE ar.tenant_id = c.tenant_id AND ar.purpose = 'call_summary' AND ar.input_refs -> 'callIds' ? c.id::text)
     ORDER BY t.updated_at LIMIT 100`.execute(tx);
  return r.rows.map((x) => x.id);
}

export const CALL_SUMMARY_DEDUPE = (callId: string) => `${ASSISTANT_JOBS.callSummary}:${callId}`;
