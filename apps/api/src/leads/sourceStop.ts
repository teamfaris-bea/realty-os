// R-LSRC-9 A4 (owner decision 2026-11-14; migration 0101): making people safe NOW when nothing automatic may go to them
// any more because their imported source is not reviewed: a mapping was removed, their label became ambiguous, or an
// import just committed them. The Owner's mapping (leads/sources.ts setImportSource) and the import's contacts commit
// (imports/commit.ts) call it, each in its own transaction.
//
// This module imports no assistant, comms or imports code (only the job contract), so imports/commit.ts can load it
// without a load cycle (imports/initOrder.architecture.test.ts).
import type { Instant } from '@realty/core/foundation';
import { type Tx, enqueueJob } from '@realty/db';
import { sql } from 'kysely';
import { PLAYBOOK_STEP } from '../worker/contracts.js';
import { AUTOMATED_DRAFT_TRIGGER_KINDS, SOURCE_NO_AUTOMATED_CONTACT, SOURCE_UNCLASSIFIED, type SourceRefusal, withdrawAutomatedDrafts } from './automatedContact.js';

/** What a change asked to stop: live AI care sent to its chain, active plans asked for a step, drafts withdrawn. */
export interface Stopped {
  pausing: number;
  stopping: number;
  withdrawn: number;
}
export const NOTHING_STOPPED: Stopped = { pausing: 0, stopping: 0, withdrawn: 0 };

/** Asks one live AI care assignment for a turn now: its chain (link 11) pauses it (the sweep's job and dedupe key). */
export async function askCareForATurn(tx: Tx, a: { id: string; epoch: number }): Promise<void> {
  await enqueueJob(tx, { queue: 'realtime', kind: 'ai_isa.turn', payload: { assignmentId: a.id, trigger: 'sweep', epoch: a.epoch }, dedupeKey: `ai_isa.turn:${a.id}:${a.epoch}:chain` });
}

/** Asks one active plan for a step now: the step runner stops it before any due check (the sweeper's job and dedupe key). */
export async function askPlanForAStep(tx: Tx, enrollmentId: string, at: Instant): Promise<void> {
  const p = { enrollmentId, dueAt: at };
  await enqueueJob(tx, { queue: PLAYBOOK_STEP.queue, kind: PLAYBOOK_STEP.kind, priority: PLAYBOOK_STEP.priority, payload: p, dedupeKey: PLAYBOOK_STEP.dedupeKey(p), runAt: at });
}

/** Whose automation a change may have to stop: one label's people, one import's no-label group, or named records. */
export type PeopleScope = { label: string } | { unlabeledImportId: string } | { contactIds: readonly string[] };

/**
 * R-LSRC-9 A4 (owner decision 2026-11-14): the people of `scope`, made safe now when nothing automatic may go to them
 * any more: a mapping was removed (their label is unclassified again), their label became ambiguous, or an import just
 * committed them. For each of them who is refused NOW (app.person_source_refusal: unclassified, or a marked source),
 * live AI care is asked for a turn (its chain, link 11, pauses it), each active plan is asked for a step (the step
 * runner stops it before any due check) and the pending drafts a plan step or a trigger wrote are withdrawn here, with
 * the reason that applies. A person who is not refused (classified to an unmarked source) is left alone.
 *
 * Bounded work, no lock: one statement finds the scope's people through an index (import_records_committed_label, or
 * the import's stage), follows a merged-away record to its person, and joins straight to the rows there are to stop;
 * the definer is asked once per person who HAS something to stop, never per person of the label and never over the
 * tenant. It takes no contact lock and no advisory lock (an opt-out, a pause, a stop or an inbound call for one of
 * these people never waits on this transaction, except on the very draft rows it withdraws). Paused plans stay paused
 * (they cannot be resumed while refused: the enrolment guard).
 */
export async function stopAutomatedContactForPeople(tx: Tx, scope: PeopleScope, now: Instant): Promise<Stopped> {
  if ('contactIds' in scope && scope.contactIds.length === 0) return NOTHING_STOPPED;
  const committed = sql`r.tenant_id = app.tenant_id() AND r.target_table = 'contacts' AND r.outcome IN ('imported', 'merged') AND (r.normalized ->> 'category') = 'contacts'`;
  const targets = 'label' in scope
    ? sql`SELECT r.target_id AS id FROM import_records r
           WHERE ${committed} AND left(COALESCE(r.normalized ->> 'leadSourceLabel', ''), 200) = left(${scope.label}::text, 200)
             AND COALESCE(r.normalized ->> 'leadSourceLabel', '') = ${scope.label}::text`
    : 'unlabeledImportId' in scope
      ? sql`SELECT r.target_id AS id FROM import_records r JOIN import_stages st ON st.tenant_id = r.tenant_id AND st.id = r.stage_id
             WHERE ${committed} AND st.batch_id = ${scope.unlabeledImportId}::uuid AND st.category = 'contacts'
               AND btrim(COALESCE(r.normalized ->> 'leadSourceLabel', '')) = ''`
      : sql`SELECT unnest(${[...scope.contactIds]}::uuid[]) AS id`;
  const r = await sql<{ kind: 'care' | 'plan' | 'draft'; id: string | null; epoch: number | null; contact_id: string; why: string }>`
    WITH t AS MATERIALIZED (${targets}),
         -- a record merged away since the import: the person lives on (app.contact_person_ids); only those are walked
         gone AS MATERIALIZED (SELECT DISTINCT c.id FROM t JOIN contacts c ON c.tenant_id = app.tenant_id() AND c.id = t.id WHERE c.merged_into_contact_id IS NOT NULL),
         person AS MATERIALIZED (SELECT id FROM t UNION SELECT p.id FROM gone g CROSS JOIN LATERAL unnest(app.contact_person_ids(app.tenant_id(), g.id)) AS p(id)),
         cand AS MATERIALIZED (
           SELECT 'care'::text AS kind, a.id, a.epoch, a.contact_id FROM ai_isa_assignments a JOIN person p ON p.id = a.contact_id
            WHERE a.tenant_id = app.tenant_id() AND a.ended_at IS NULL AND a.paused_at IS NULL
           UNION ALL
           SELECT 'plan', e.id, NULL::int, e.contact_id FROM playbook_enrollments e JOIN person p ON p.id = e.contact_id
            WHERE e.tenant_id = app.tenant_id() AND e.state = 'active'
           UNION ALL
           SELECT DISTINCT 'draft', NULL::uuid, NULL::int, a.contact_id FROM assistant_actions a JOIN person p ON p.id = a.contact_id
            WHERE a.tenant_id = app.tenant_id() AND a.status = 'proposed' AND a.autonomy = 'requires_approval'
              AND a.trigger_ref ->> 'kind' = ANY (${[...AUTOMATED_DRAFT_TRIGGER_KINDS]}::text[])),
         why AS MATERIALIZED (SELECT w.contact_id, app.person_source_refusal(app.tenant_id(), w.contact_id) AS why FROM (SELECT DISTINCT contact_id FROM cand) w)
    SELECT c.kind, c.id, c.epoch, c.contact_id, y.why FROM cand c JOIN why y ON y.contact_id = c.contact_id WHERE y.why IS NOT NULL
     ORDER BY c.kind, c.id, c.contact_id`.execute(tx);
  let pausing = 0;
  let stopping = 0;
  const drafts = new Map<SourceRefusal, string[]>();
  for (const x of r.rows) {
    if (x.kind === 'care') {
      await askCareForATurn(tx, { id: x.id!, epoch: x.epoch! });
      pausing += 1;
    } else if (x.kind === 'plan') {
      await askPlanForAStep(tx, x.id!, now);
      stopping += 1;
    } else {
      const why: SourceRefusal = x.why === SOURCE_UNCLASSIFIED ? SOURCE_UNCLASSIFIED : SOURCE_NO_AUTOMATED_CONTACT;
      drafts.set(why, [...(drafts.get(why) ?? []), x.contact_id]);
    }
  }
  let withdrawn = 0;
  for (const [why, contactIds] of drafts) withdrawn += await withdrawAutomatedDrafts(tx, { contactIds }, now, why);
  return { pausing, stopping, withdrawn };
}

