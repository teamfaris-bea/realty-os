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

/**
 * Whose automation a change may have to stop: one label's people, one import's no-label group, every person a lead
 * source sent, or named records.
 */
export type PeopleScope = { label: string } | { unlabeledImportId: string } | { sourceId: string } | { contactIds: readonly string[] };

/**
 * The records a lead source sent, as one set (R-LSRC-8; the same four ways as app.person_from_lead_source, 0103, read
 * from the SOURCE's side so nothing is asked per row of the team): a record whose own lead source it is (live, through
 * contacts_list_source_idx, or merged away since, through contacts_merged_into_idx), a record an inquiry of the source
 * is on, and the people an import COMMITTED under each label, and in each no-label group, the source holds
 * (app.import_source_people, through import_records_contact_label or the import's stage). The caller is tenant-wide
 * (the Owner on the sources routes): it reads these rows under its own row-level security.
 */
export function sourceRecordsSql(sourceId: string) {
  return sql`
    SELECT c.id FROM contacts c
     WHERE c.tenant_id = app.tenant_id() AND c.original_lead_source_id = ${sourceId}::uuid AND c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL
    UNION
    SELECT c.id FROM contacts c
     WHERE c.tenant_id = app.tenant_id() AND c.merged_into_contact_id IS NOT NULL AND c.original_lead_source_id = ${sourceId}::uuid
    UNION
    SELECT i.contact_id FROM lead_inquiries i
     WHERE i.tenant_id = app.tenant_id() AND i.lead_source_id = ${sourceId}::uuid AND i.contact_id IS NOT NULL
    UNION
    SELECT p.contact_id FROM lead_sources s CROSS JOIN LATERAL unnest(s.import_labels) AS l(label)
           CROSS JOIN LATERAL app.import_source_people(app.tenant_id(), l.label, NULL::uuid) p
     WHERE s.tenant_id = app.tenant_id() AND s.id = ${sourceId}::uuid AND p.committed
    UNION
    SELECT p.contact_id FROM lead_sources s CROSS JOIN LATERAL unnest(s.import_unlabeled_batches) AS b(id)
           CROSS JOIN LATERAL app.import_source_people(app.tenant_id(), NULL::text, b.id) p
     WHERE s.tenant_id = app.tenant_id() AND s.id = ${sourceId}::uuid AND p.committed`;
}

/** The records of a scope, as a query of one `id` column (see PeopleScope). */
export function scopeRecordsSql(scope: PeopleScope) {
  // a label's or a no-label group's COMMITTED people come from app.import_source_people (0101): a definer, so the lookup
  // may use import_records_contact_label (under row-level security the caller's own query could not), answering only
  // the tenant-wide caller who may read import_records anyway
  return 'label' in scope
    ? sql`SELECT p.contact_id AS id FROM app.import_source_people(app.tenant_id(), ${scope.label}::text, NULL::uuid) p WHERE p.committed`
    : 'unlabeledImportId' in scope
      ? sql`SELECT p.contact_id AS id FROM app.import_source_people(app.tenant_id(), NULL::text, ${scope.unlabeledImportId}::uuid) p WHERE p.committed`
      : 'sourceId' in scope
        ? sourceRecordsSql(scope.sourceId)
        : sql`SELECT unnest(${[...scope.contactIds]}::uuid[]) AS id`;
}

/**
 * The people of a scope, as the CTEs `t` (its records), `gone` and `person` (each record, and for a record merged away
 * since, every record of its person: app.contact_person_ids; only those are walked). A merge stops the merged-away
 * record's plans and moves its drafts and its saved searches' person to the survivor (packages/db ownership/merge.ts),
 * so whatever is live for a person sits on a record in `person`.
 */
export function scopePeopleCtes(scope: PeopleScope) {
  return sql`t AS MATERIALIZED (${scopeRecordsSql(scope)}),
         gone AS MATERIALIZED (SELECT DISTINCT c.id FROM t JOIN contacts c ON c.tenant_id = app.tenant_id() AND c.id = t.id WHERE c.merged_into_contact_id IS NOT NULL),
         person AS MATERIALIZED (SELECT id FROM t UNION SELECT p.id FROM gone g CROSS JOIN LATERAL unnest(app.contact_person_ids(app.tenant_id(), g.id)) AS p(id))`;
}

/**
 * R-LSRC-9 A4 (owner decision 2026-11-14) and R-LSRC-8: the people of `scope`, made safe now when nothing automatic may
 * go to them any more: a mapping was removed (their label is unclassified again), their label became ambiguous, an
 * import just committed them, their label was mapped to a marked source, or the Owner turned "No automated contact for
 * leads from this source" on for the source that sent them (`{ sourceId }`). For each of them who is refused NOW
 * (app.person_source_refusal: unclassified, or a marked source), live AI care is asked for a turn (its chain, link 11,
 * pauses it), each active plan is asked for a step (the step runner stops it before any due check) and the pending
 * drafts a plan step or a trigger wrote are withdrawn here, with the reason that applies. A person who is not refused
 * (classified to an unmarked source) is left alone.
 *
 * Bounded work, no lock: one statement finds the scope's people through an index (app.import_source_people over
 * import_records_contact_label, the import's stage, or the source's own records and inquiries), follows a merged-away
 * record to its person, and joins straight to the rows there are to stop; the definer is asked once per person who HAS
 * something to stop, never per person of the scope and never per plan, AI care or draft of the team
 * (leads/sourceStop.volume.test.ts). It takes no contact lock and no advisory lock (an opt-out, a pause, a stop or an
 * inbound call for one of these people never waits on this transaction, except on the very draft rows it withdraws).
 * Paused plans stay paused (they cannot be resumed while refused: the enrolment guard).
 */
export async function stopAutomatedContactForPeople(tx: Tx, scope: PeopleScope, now: Instant): Promise<Stopped> {
  if ('contactIds' in scope && scope.contactIds.length === 0) return NOTHING_STOPPED;
  const r = await sql<{ kind: 'care' | 'plan' | 'draft'; id: string | null; epoch: number | null; contact_id: string; why: string }>`
    WITH ${scopePeopleCtes(scope)},
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

/**
 * R-LSRC-10 M7 (E756; migration 0104): the saved-search alert sender holds the searches of a person the source check
 * refused (`saved_searches.alerts_held_until`, an hour ahead) so it does not ask about them on every run. When the
 * Owner's change may have RELEASED people (a label or a no-label group mapped, moved or un-mapped; the setting turned
 * off for a source), the holds of that scope's people are cleared here, in the Owner's transaction, so the homes still
 * waiting for them are alerted on the sender's next run and not up to an hour later. Clearing is always safe: a hold is
 * only a "do not ask again before" time, and the sender asks the source check again before anything is queued (a
 * person who is still refused is simply held again). Bounded work: the scope's people, joined to the held searches
 * through saved_searches_held_contact; no lock beyond the held rows it clears. Returns how many searches were released.
 */
export async function releaseAlertHolds(tx: Tx, scope: PeopleScope): Promise<number> {
  if ('contactIds' in scope && scope.contactIds.length === 0) return 0;
  const r = await sql`
    WITH ${scopePeopleCtes(scope)}
    UPDATE saved_searches s SET alerts_held_until = NULL
     WHERE s.tenant_id = app.tenant_id() AND s.alerts_held_until IS NOT NULL AND s.contact_id IN (SELECT id FROM person)`.execute(tx);
  return Number(r.numAffectedRows ?? 0n);
}
