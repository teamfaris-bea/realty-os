// SQL of api/nurture. Every statement is tenant-scoped (tenant_id = app.tenant_id()) and runs under the
// caller's RLS; trigger runs (playbook_step_runs with no enrollment) are written only by the system actor
// (policy step_runs_trigger: WITH CHECK is_tenant_wide()).
import { type PlaybookContent, approvalCurrent, storedContent } from '@realty/core/assistant';
import type { Instant } from '@realty/core/foundation';
import { instantFromDate, toIso } from '@realty/core/foundation';
import type { Firing, ListingStatus, TriggerPlaybookRef } from '@realty/core/nurture';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { type RunSkipReason, type StoredTriggerRef, type TriggerRunRow, skipText, storedRefOf } from './decide.js';

const iso = (t: number) => new Date(t).toISOString();

// ---- approved trigger playbooks ------------------------------------------------------------------------

export interface TriggerPlaybook {
  ref: TriggerPlaybookRef;
  name: string;
  /** playbooks.template_key: the built-in template it was created from (module 31 fires only 'transaction_updates') */
  templateKey: string | null;
  content: Extract<PlaybookContent, { kind: 'triggers' }>;
}

/**
 * Active trigger playbooks whose approved version is current (latest approval approves exactly its hash,
 * R-AST-4). Only these fire; a draft, superseded or revoked version never does.
 */
export async function approvedTriggerPlaybooks(tx: Tx): Promise<TriggerPlaybook[]> {
  const r = await sql<{ id: string; scope: 'team' | 'agent'; owner_user_id: string | null; name: string; template_key: string | null; version_id: string; status: string; content_sha256: string; steps: unknown; decision: 'approve' | 'revoke' | null; approved_sha: string | null }>`
    SELECT p.id, p.scope, p.owner_user_id, p.name, p.template_key, v.id AS version_id, v.status, v.content_sha256, v.steps, a.decision, a.content_sha256 AS approved_sha
      FROM playbooks p
      JOIN playbook_versions v ON v.tenant_id = p.tenant_id AND v.playbook_id = p.id AND v.status = 'approved'
      LEFT JOIN LATERAL (SELECT decision, content_sha256 FROM playbook_approvals pa
                          WHERE pa.tenant_id = v.tenant_id AND pa.playbook_version_id = v.id ORDER BY decided_at DESC, id DESC LIMIT 1) a ON true
     WHERE p.tenant_id = app.tenant_id() AND p.kind = 'trigger' AND p.status = 'active'
     ORDER BY p.id`.execute(tx);
  const out: TriggerPlaybook[] = [];
  for (const x of r.rows) {
    if (!approvalCurrent({ status: x.status, contentSha256: x.content_sha256 }, x.decision === null ? null : { decision: x.decision, contentSha256: x.approved_sha ?? '' })) continue;
    const c = storedContent(x.steps);
    if (c === null || c.kind !== 'triggers') continue;
    const content = c as unknown as Extract<PlaybookContent, { kind: 'triggers' }>;
    const steps = content.triggers.filter((t) => typeof t === 'object' && t !== null).map((t) => ({ trigger: t.trigger, stepKey: t.stepKey, offsetSeconds: t.offsetSeconds }));
    out.push({ ref: { playbookId: x.id, versionId: x.version_id, scope: x.scope, ownerUserId: x.owner_user_id, steps }, name: x.name, templateKey: x.template_key, content });
  }
  return out;
}

export interface VersionFacts {
  id: string;
  playbookId: string;
  status: string;
  contentSha256: string;
  steps: unknown;
  scope: 'team' | 'agent';
  ownerUserId: string | null;
  name: string;
  playbookStatus: string;
  latest: { decision: 'approve' | 'revoke'; contentSha256: string } | null;
}

export async function versionFacts(tx: Tx, versionId: string): Promise<VersionFacts | null> {
  const r = await sql<{ id: string; playbook_id: string; status: string; content_sha256: string; steps: unknown; scope: 'team' | 'agent'; owner_user_id: string | null; name: string; pstatus: string; kind: string }>`
    SELECT v.id, v.playbook_id, v.status, v.content_sha256, v.steps, p.scope, p.owner_user_id, p.name, p.status AS pstatus, p.kind
      FROM playbook_versions v JOIN playbooks p ON p.tenant_id = v.tenant_id AND p.id = v.playbook_id
     WHERE v.tenant_id = app.tenant_id() AND v.id = ${versionId}`.execute(tx);
  const v = r.rows[0];
  if (!v || v.kind !== 'trigger') return null;
  const a = await sql<{ decision: 'approve' | 'revoke'; content_sha256: string }>`
    SELECT decision, content_sha256 FROM playbook_approvals WHERE tenant_id = app.tenant_id() AND playbook_version_id = ${versionId} ORDER BY decided_at DESC, id DESC LIMIT 1`.execute(tx);
  return { id: v.id, playbookId: v.playbook_id, status: v.status, contentSha256: v.content_sha256, steps: v.steps, scope: v.scope, ownerUserId: v.owner_user_id, name: v.name, playbookStatus: v.pstatus, latest: a.rows[0] ? { decision: a.rows[0].decision, contentSha256: a.rows[0].content_sha256 } : null };
}

// ---- who a fact concerns ---------------------------------------------------------------------------------

export interface ContactRel {
  contactId: string;
  ownerUserId: string | null;
  via: 'saved' | 'matched';
}

/**
 * Live contacts a listing concerns (R-NURT-2): a client's interest (listing_contacts role 'interested') or an
 * active saved search that matched it. Merged-away and deleted records never receive anything.
 */
export async function listingFollowers(tx: Tx, listingId: string): Promise<ContactRel[]> {
  const r = await sql<{ contact_id: string; owner_user_id: string | null; via: 'saved' | 'matched' }>`
    SELECT DISTINCT ON (c.id) c.id AS contact_id, c.owner_user_id, rel.via FROM (
      SELECT lc.contact_id, 'saved' AS via FROM listing_contacts lc WHERE lc.tenant_id = app.tenant_id() AND lc.listing_id = ${listingId} AND lc.role = 'interested'
      UNION ALL
      SELECT ss.contact_id, 'matched' FROM saved_search_matches m JOIN saved_searches ss ON ss.tenant_id = m.tenant_id AND ss.id = m.search_id
       WHERE m.tenant_id = app.tenant_id() AND m.listing_id = ${listingId} AND ss.status = 'active') rel
      JOIN contacts c ON c.tenant_id = app.tenant_id() AND c.id = rel.contact_id
     WHERE c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL
     ORDER BY c.id, rel.via DESC`.execute(tx);
  return r.rows.map((x) => ({ contactId: x.contact_id, ownerUserId: x.owner_user_id, via: x.via }));
}

export async function stillFollows(tx: Tx, contactId: string, listingId: string): Promise<boolean> {
  return (await listingFollowers(tx, listingId)).some((x) => x.contactId === contactId);
}

export interface ContactState {
  id: string;
  ownerUserId: string | null;
  live: boolean;
  periodSeq: number | null;
}

export async function contactState(tx: Tx, contactId: string): Promise<ContactState | null> {
  const r = await sql<{ id: string; owner_user_id: string | null; live: boolean; seq: string | null }>`
    SELECT id, owner_user_id, (deleted_at IS NULL AND merged_into_contact_id IS NULL) AS live, ownership_period_seq AS seq
      FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${contactId}`.execute(tx);
  const c = r.rows[0];
  return c ? { id: c.id, ownerUserId: c.owner_user_id, live: c.live, periodSeq: c.seq === null ? null : Number(c.seq) } : null;
}

export async function conversationPaused(tx: Tx, contactId: string): Promise<{ paused: boolean; inboundSeq: number }> {
  const r = await sql<{ paused: boolean; s: string }>`
    SELECT automation_paused_at IS NOT NULL AS paused, inbound_seq AS s FROM conversations WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}`.execute(tx);
  return { paused: r.rows[0]?.paused === true, inboundSeq: r.rows[0] ? Number(r.rows[0].s) : 0 };
}

// ---- listings ------------------------------------------------------------------------------------------

export interface ListingSnapshot {
  id: string;
  status: ListingStatus;
  priceCents: number | null;
  modifiedAt: Instant | null;
}

export async function listingSnapshotByMls(tx: Tx, mlsNumber: string, connectionId: string): Promise<ListingSnapshot | null> {
  const r = await sql<{ id: string; status: ListingStatus; list_price_cents: string | null; mls_modified_at: Date | null }>`
    SELECT id, status, list_price_cents, mls_modified_at FROM listings
     WHERE tenant_id = app.tenant_id() AND source = 'mls' AND mls_number = ${mlsNumber} AND mls_connection_id = ${connectionId}`.execute(tx);
  const x = r.rows[0];
  return x ? { id: x.id, status: x.status, priceCents: x.list_price_cents === null ? null : Number(x.list_price_cents), modifiedAt: x.mls_modified_at ? instantFromDate(x.mls_modified_at) : null } : null;
}

export async function listingSnapshotById(tx: Tx, id: string): Promise<ListingSnapshot | null> {
  const r = await sql<{ id: string; status: ListingStatus; list_price_cents: string | null; mls_modified_at: Date | null }>`
    SELECT id, status, list_price_cents, mls_modified_at FROM listings WHERE tenant_id = app.tenant_id() AND id = ${id}`.execute(tx);
  const x = r.rows[0];
  return x ? { id: x.id, status: x.status, priceCents: x.list_price_cents === null ? null : Number(x.list_price_cents), modifiedAt: x.mls_modified_at ? instantFromDate(x.mls_modified_at) : null } : null;
}

/** The price-history row and the one before it (listing_price_history is append-only, written by trigger). */
export async function priceStep(tx: Tx, listingId: string, historyId: string | null): Promise<{ historyId: string; newCents: number; oldCents: number | null; at: Instant } | null> {
  const r = await sql<{ id: string; price_cents: string; changed_at: Date; prev: string | null }>`
    SELECT h.id, h.price_cents, h.changed_at,
           (SELECT p.price_cents FROM listing_price_history p WHERE p.tenant_id = h.tenant_id AND p.listing_id = h.listing_id
             AND (p.changed_at, p.id) < (h.changed_at, h.id) ORDER BY p.changed_at DESC, p.id DESC LIMIT 1) AS prev
      FROM listing_price_history h
     WHERE h.tenant_id = app.tenant_id() AND h.listing_id = ${listingId} AND (${historyId}::uuid IS NULL OR h.id = ${historyId}::uuid)
     ORDER BY h.changed_at DESC, h.id DESC LIMIT 1`.execute(tx);
  const x = r.rows[0];
  return x ? { historyId: x.id, newCents: Number(x.price_cents), oldCents: x.prev === null ? null : Number(x.prev), at: instantFromDate(x.changed_at) } : null;
}

// ---- trigger runs --------------------------------------------------------------------------------------

/** Inserts a firing as a scheduled step run without an enrollment; the unique trigger_key makes it once per fact. */
export async function insertFiring(tx: Tx, id: string, f: Firing): Promise<boolean> {
  const r = await sql`
    INSERT INTO playbook_step_runs (tenant_id, id, enrollment_id, playbook_version_id, step_key, status, scheduled_for, contact_id, trigger_key, trigger_ref)
    VALUES (app.tenant_id(), ${id}, NULL, ${f.versionId}, ${f.stepKey}, 'scheduled', ${iso(f.scheduledFor)}::timestamptz, ${f.contactId}, ${f.triggerKey},
            ${JSON.stringify(storedRefOf(f))}::jsonb)
    ON CONFLICT (tenant_id, trigger_key) WHERE trigger_key IS NOT NULL DO NOTHING`.execute(tx);
  return Number(r.numAffectedRows ?? 0n) === 1;
}

type RawRun = { id: string; contact_id: string; playbook_version_id: string; step_key: string; trigger_key: string; scheduled_for: Date; trigger_ref: unknown; status: string; message_id: string | null; assistant_action_id: string | null; enrollment_id: string | null };
const RUN_COLS = sql`r.id, r.contact_id, r.playbook_version_id, r.step_key, r.trigger_key, r.scheduled_for, r.trigger_ref, r.status, r.message_id, r.assistant_action_id, r.enrollment_id`;

export interface RunRow extends TriggerRunRow {
  status: string;
  messageId: string | null;
  actionId: string | null;
  enrollmentId: string | null;
}

const runOf = (x: RawRun): RunRow => ({ id: x.id, contactId: x.contact_id, versionId: x.playbook_version_id, stepKey: x.step_key, triggerKey: x.trigger_key, scheduledFor: instantFromDate(x.scheduled_for), triggerRef: x.trigger_ref, status: x.status, messageId: x.message_id, actionId: x.assistant_action_id, enrollmentId: x.enrollment_id });

export async function runById(tx: Tx, id: string, lock = false): Promise<RunRow | null> {
  const r = lock
    ? await sql<RawRun>`SELECT ${RUN_COLS} FROM playbook_step_runs r WHERE r.tenant_id = app.tenant_id() AND r.id = ${id} FOR UPDATE`.execute(tx)
    : await sql<RawRun>`SELECT ${RUN_COLS} FROM playbook_step_runs r WHERE r.tenant_id = app.tenant_id() AND r.id = ${id}`.execute(tx);
  return r.rows[0] ? runOf(r.rows[0]) : null;
}

/** Scheduled, not yet built firings of one contact and playbook (all its versions), oldest first, locked. */
export async function openFirings(tx: Tx, contactId: string, playbookId: string, o: { dueBy?: Instant } = {}): Promise<RunRow[]> {
  const r = await sql<RawRun>`
    SELECT ${RUN_COLS} FROM playbook_step_runs r
      JOIN playbook_versions v ON v.tenant_id = r.tenant_id AND v.id = r.playbook_version_id
     WHERE r.tenant_id = app.tenant_id() AND r.contact_id = ${contactId} AND r.enrollment_id IS NULL AND r.status = 'scheduled'
       AND r.message_id IS NULL AND r.assistant_action_id IS NULL AND v.playbook_id = ${playbookId}
       AND (${o.dueBy === undefined ? null : iso(o.dueBy)}::timestamptz IS NULL OR r.scheduled_for <= ${o.dueBy === undefined ? null : iso(o.dueBy)}::timestamptz)
     ORDER BY r.scheduled_for, r.id FOR UPDATE OF r`.execute(tx);
  return r.rows.map(runOf);
}

export async function setScheduledFor(tx: Tx, ids: readonly string[], at: Instant): Promise<void> {
  if (ids.length === 0) return;
  await sql`UPDATE playbook_step_runs SET scheduled_for = ${iso(at)}::timestamptz, updated_at = now()
             WHERE tenant_id = app.tenant_id() AND id = ANY (${ids}::uuid[]) AND status = 'scheduled' AND message_id IS NULL`.execute(tx);
}

export async function skipRun(tx: Tx, id: string, reason: RunSkipReason): Promise<void> {
  await sql`
    UPDATE playbook_step_runs SET status = 'skipped_ineligible', updated_at = now(),
           trigger_ref = trigger_ref || jsonb_build_object('skip', jsonb_build_object('reason', ${reason}::text, 'text', ${skipText(reason)}::text))
     WHERE tenant_id = app.tenant_id() AND id = ${id} AND enrollment_id IS NULL`.execute(tx);
}

export async function currentApprovedVersionId(tx: Tx, playbookId: string): Promise<string | null> {
  const r = await sql<{ id: string }>`SELECT id FROM playbook_versions WHERE tenant_id = app.tenant_id() AND playbook_id = ${playbookId} AND status = 'approved'`.execute(tx);
  return r.rows[0]?.id ?? null;
}

export async function attachRuns(tx: Tx, ids: readonly string[], u: { status: 'scheduled' | 'converted_to_draft'; actionId: string; messageId: string | null; versionId: string }): Promise<void> {
  if (ids.length === 0) return;
  await sql`
    UPDATE playbook_step_runs SET status = ${u.status}, assistant_action_id = ${u.actionId}, message_id = ${u.messageId}, playbook_version_id = ${u.versionId}, updated_at = now()
     WHERE tenant_id = app.tenant_id() AND id = ANY (${ids}::uuid[]) AND enrollment_id IS NULL`.execute(tx);
}

/** Due firings that have not been built yet, one per contact and playbook version (the batch lead). */
export async function dueLeads(tx: Tx, now: Instant, limit: number): Promise<string[]> {
  const r = await sql<{ id: string }>`
    SELECT DISTINCT ON (r.contact_id, r.playbook_version_id) r.id FROM playbook_step_runs r
     WHERE r.tenant_id = app.tenant_id() AND r.enrollment_id IS NULL AND r.status = 'scheduled'
       AND r.scheduled_for <= ${iso(now)}::timestamptz AND r.message_id IS NULL AND r.assistant_action_id IS NULL
     ORDER BY r.contact_id, r.playbook_version_id, r.scheduled_for, r.id LIMIT ${limit}`.execute(tx);
  return r.rows.map((x) => x.id);
}

/**
 * Batch members follow their lead's outcome once dispatch decided it: a member run shares the lead's message;
 * dispatch updates the lead run (sent, failed, skipped by the gate, canceled while paused), and the members
 * take the same status. A lead whose message was canceled before dispatch (and was not canceled by an inbound
 * reply, which cancels the run itself) is skipped visibly.
 */
export async function settleBatches(tx: Tx, limit = 500): Promise<number> {
  let total = 0;
  // (1) members follow their lead once dispatch decided it; the limited set holds only rows that can settle
  for (;;) {
    const a = await sql`
      UPDATE playbook_step_runs r SET status = lead.status, last_gate_decision_id = lead.last_gate_decision_id, updated_at = now()
        FROM messages m, playbook_step_runs lead
       WHERE r.tenant_id = app.tenant_id() AND m.tenant_id = r.tenant_id AND m.id = r.message_id
         AND lead.tenant_id = m.tenant_id AND lead.id = m.playbook_step_run_id
         AND r.id IN (SELECT x.id FROM playbook_step_runs x
                        JOIN messages mm ON mm.tenant_id = x.tenant_id AND mm.id = x.message_id
                        JOIN playbook_step_runs ld ON ld.tenant_id = mm.tenant_id AND ld.id = mm.playbook_step_run_id
                       WHERE x.tenant_id = app.tenant_id() AND x.enrollment_id IS NULL AND x.status = 'scheduled'
                         AND ld.id <> x.id AND ld.status <> 'scheduled'
                       ORDER BY x.updated_at, x.id LIMIT ${limit})`.execute(tx);
    const k = Number(a.numAffectedRows ?? 0n);
    total += k;
    if (k < limit) break;
  }
  // (2) a run (lead or member) whose message reached a final status the dispatch path did not write back to the
  // run (comms.reconcile resolving a dispatch_unknown): sent/delivered ⇒ sent, failed/undelivered/bounced ⇒ failed
  const b = await sql`
    UPDATE playbook_step_runs r SET status = CASE WHEN m.status IN ('sent','delivered') THEN 'sent' ELSE 'failed' END, updated_at = now()
      FROM messages m
     WHERE r.tenant_id = app.tenant_id() AND r.enrollment_id IS NULL AND r.status = 'scheduled'
       AND m.tenant_id = r.tenant_id AND m.id = r.message_id AND m.status IN ('sent','delivered','failed','undelivered','bounced')`.execute(tx);
  // (3) a message canceled before dispatch (not by an inbound reply, which cancels the run itself): skipped visibly
  const c = await sql`
    UPDATE playbook_step_runs r SET status = 'skipped_ineligible', updated_at = now(),
           trigger_ref = r.trigger_ref || jsonb_build_object('skip', jsonb_build_object('reason', 'NOT_QUEUED', 'text', ${'The message was canceled before it went out: '}::text || COALESCE(m.status_reason, 'canceled')))
      FROM messages m
     WHERE r.tenant_id = app.tenant_id() AND r.enrollment_id IS NULL AND r.status = 'scheduled'
       AND m.tenant_id = r.tenant_id AND m.id = r.message_id AND m.status = 'canceled'`.execute(tx);
  return total + Number(b.numAffectedRows ?? 0n) + Number(c.numAffectedRows ?? 0n);
}

/** Runs of a contact for the agent's view (most recent first). */
export async function runsOfContact(tx: Tx, contactId: string, limit: number): Promise<(RunRow & { updatedAt: Instant; playbookId: string; playbookName: string })[]> {
  const r = await sql<RawRun & { updated_at: Date; playbook_id: string; name: string }>`
    SELECT ${RUN_COLS}, r.updated_at, p.id AS playbook_id, p.name FROM playbook_step_runs r
      JOIN playbook_versions v ON v.tenant_id = r.tenant_id AND v.id = r.playbook_version_id
      JOIN playbooks p ON p.tenant_id = v.tenant_id AND p.id = v.playbook_id
     WHERE r.tenant_id = app.tenant_id() AND r.contact_id = ${contactId} AND r.enrollment_id IS NULL
     ORDER BY r.scheduled_for DESC, r.id DESC LIMIT ${limit}`.execute(tx);
  return r.rows.map((x) => ({ ...runOf(x), updatedAt: instantFromDate(x.updated_at), playbookId: x.playbook_id, playbookName: x.name }));
}

// ---- anniversaries -------------------------------------------------------------------------------------

export interface ClosedDealRow {
  dealId: string;
  closedOn: string;
  contactIds: string[];
  address: string;
}

/**
 * Closed deals whose closing month-day (in the tenant zone) is one of `monthDays` ("MM-DD"), with their client
 * contacts (the primary contact and buyer/seller parties) that are live records.
 */
export async function closedDealsOn(tx: Tx, monthDays: readonly string[], zoneName: string, afterDealId: string | null, limit: number): Promise<ClosedDealRow[]> {
  const r = await sql<{ id: string; closed_on: string; contact_ids: string[]; address: string }>`
    SELECT d.id, to_char((d.closed_at AT TIME ZONE ${zoneName})::date, 'YYYY-MM-DD') AS closed_on,
           COALESCE(l.address_line1, 'your home') AS address,
           ARRAY(SELECT DISTINCT c.id FROM contacts c
                  WHERE c.tenant_id = d.tenant_id AND c.deleted_at IS NULL AND c.merged_into_contact_id IS NULL
                    AND (c.id = d.primary_contact_id OR EXISTS (SELECT 1 FROM deal_contacts dc WHERE dc.tenant_id = d.tenant_id AND dc.deal_id = d.id
                                                                 AND dc.contact_id = c.id AND dc.role IN ('buyer','seller','co_buyer','co_seller')))) AS contact_ids
      FROM deals d LEFT JOIN listings l ON l.tenant_id = d.tenant_id AND l.id = d.listing_id
     WHERE d.tenant_id = app.tenant_id() AND d.stage = 'closed'
       AND to_char((d.closed_at AT TIME ZONE ${zoneName})::date, 'MM-DD') = ANY (${monthDays}::text[])
       AND (${afterDealId}::uuid IS NULL OR d.id > ${afterDealId}::uuid)
     ORDER BY d.id LIMIT ${limit}`.execute(tx);
  return r.rows.map((x) => ({ dealId: x.id, closedOn: x.closed_on, contactIds: x.contact_ids, address: x.address }));
}

export async function dealState(tx: Tx, dealId: string, contactId: string): Promise<{ status: 'open' | 'closed' | 'canceled'; contactIsParty: boolean; address: string; closedAt: Instant | null } | null> {
  const r = await sql<{ stage: string; party: boolean; address: string; closed_at: Date | null }>`
    SELECT d.stage, d.closed_at, COALESCE(l.address_line1, 'your home') AS address,
           (d.primary_contact_id = ${contactId} OR EXISTS (SELECT 1 FROM deal_contacts dc WHERE dc.tenant_id = d.tenant_id AND dc.deal_id = d.id AND dc.contact_id = ${contactId}
                                                            AND dc.role IN ('buyer','seller','co_buyer','co_seller'))) AS party
      FROM deals d LEFT JOIN listings l ON l.tenant_id = d.tenant_id AND l.id = d.listing_id
     WHERE d.tenant_id = app.tenant_id() AND d.id = ${dealId}`.execute(tx);
  const d = r.rows[0];
  if (!d) return null;
  return { status: d.stage === 'closed' ? 'closed' : d.stage === 'lost' ? 'canceled' : 'open', contactIsParty: d.party, address: d.address, closedAt: d.closed_at ? instantFromDate(d.closed_at) : null };
}

/**
 * Whether a post-closing ENROLLMENT already sent (or is about to send) this contact's anniversary note within
 * the last 330 days: an old post-closing version (v1) still has an anniversary step; one note a year (F7).
 */
export async function enrollmentAnniversarySent(tx: Tx, contactId: string, now: Instant): Promise<boolean> {
  const r = await sql<{ x: boolean }>`
    SELECT EXISTS (SELECT 1 FROM playbook_step_runs r
                     JOIN playbook_enrollments e ON e.tenant_id = r.tenant_id AND e.id = r.enrollment_id
                     JOIN playbook_versions v ON v.tenant_id = r.tenant_id AND v.id = r.playbook_version_id
                    WHERE r.tenant_id = app.tenant_id() AND e.contact_id = ${contactId} AND r.status IN ('scheduled','sent')
                      AND r.updated_at > ${iso(now)}::timestamptz - interval '330 days'
                      AND jsonb_typeof(v.steps) = 'array'
                      AND EXISTS (SELECT 1 FROM jsonb_array_elements(v.steps) s WHERE s->>'stepKey' = r.step_key AND s->>'intent' = 'home_anniversary')) AS x`.execute(tx);
  return r.rows[0]?.x === true;
}

/** The mirror check for the enrollment path (steps.ts): an anniversary TRIGGER run for the contact this year. */
export async function triggerAnniversaryCovered(tx: Tx, contactId: string, now: Instant): Promise<boolean> {
  const r = await sql<{ x: boolean }>`
    SELECT EXISTS (SELECT 1 FROM playbook_step_runs r
                    WHERE r.tenant_id = app.tenant_id() AND r.contact_id = ${contactId} AND r.enrollment_id IS NULL
                      AND r.trigger_ref->>'trigger' = 'home_anniversary' AND r.status IN ('scheduled','sent','converted_to_draft')
                      AND r.updated_at > ${iso(now)}::timestamptz - interval '330 days') AS x`.execute(tx);
  return r.rows[0]?.x === true;
}

export async function tenantZone(tx: Tx): Promise<string> {
  const r = await sql<{ z: string }>`SELECT default_timezone AS z FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx);
  return r.rows[0]?.z ?? 'America/New_York';
}

export async function platformCleared(tx: Tx, key: string): Promise<boolean> {
  const r = await sql<{ ok: boolean }>`SELECT app.platform_cleared(${key}) AS ok`.execute(tx);
  return r.rows[0]?.ok === true;
}

export type { StoredTriggerRef };
export { toIso };
