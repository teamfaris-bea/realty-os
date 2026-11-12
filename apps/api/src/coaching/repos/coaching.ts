// SQL of api/coaching (module 36). Every query runs inside the caller's withTenantTx, under RLS:
//   - the review job and the daily fix reconcile run as the tenant's system actor;
//   - the pages run as the signed-in person, so call_scores RLS decides what a Team Lead reads (only while
//     the Owner's tl_sees_call_scores is on) and the recording scope decides what anyone reads (R-COACH-3).
// No query here touches routing, ownership, offers, ponds or the scoreboard (R-COACH-5, architecture test).
import { type ItemStatus, REVIEWED_ROLES, isRubricVersion } from '@realty/core/coaching';
import type { CallId, Instant } from '@realty/core/foundation';
import { instantFromDate, toIso } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

// ---- settings ---------------------------------------------------------------------------------

export interface CoachingSettingsRow {
  scoringEnabled: boolean;
  tlSeesCallScores: boolean;
  disabledKeys: string[];
  aiEnabled: boolean;
  zone: string;
  packCleared: boolean;
  packReviewedAt: string | null;
  packVersion: string | null;
}

export async function coachingSettings(tx: Tx, o: { lock?: boolean; forUpdate?: boolean } = {}): Promise<CoachingSettingsRow | null> {
  // FOR SHARE: the review job's final check holds the row, so the Owner turning scoring off either commits
  // before it (and is seen) or waits until the review is stored (and closes the tips at once)
  if (o.lock) await sql`SELECT 1 FROM tenant_settings WHERE tenant_id = app.tenant_id() FOR SHARE`.execute(tx);
  // FOR NO KEY UPDATE: a settings change decides on the row as it is now, after any change in flight commits (an
  // Admin's "off"), and holds it until it writes, so nothing slips in between its read and its write (E283)
  if (o.forUpdate) await sql`SELECT 1 FROM tenant_settings WHERE tenant_id = app.tenant_id() FOR NO KEY UPDATE`.execute(tx);
  const r = await sql<{ call_scoring_enabled: boolean; tl_sees_call_scores: boolean; coaching_rubric_disabled: string[]; ai_enabled: boolean; default_timezone: string; cleared: boolean; reviewed_at: Date | null; version: string | null }>`
    SELECT s.call_scoring_enabled, s.tl_sees_call_scores, s.coaching_rubric_disabled, s.ai_enabled, s.default_timezone,
           app.platform_cleared('platform:coaching') AS cleared,
           (SELECT j.reviewed_by_counsel_at FROM jurisdiction_packs j WHERE j.key = 'platform:coaching' AND j.status = 'published' ORDER BY j.reviewed_by_counsel_at DESC NULLS LAST LIMIT 1) AS reviewed_at,
           (SELECT j.version FROM jurisdiction_packs j WHERE j.key = 'platform:coaching' AND j.status = 'published' ORDER BY j.reviewed_by_counsel_at DESC NULLS LAST LIMIT 1) AS version
      FROM tenant_settings s WHERE s.tenant_id = app.tenant_id()`.execute(tx);
  const x = r.rows[0];
  if (!x) return null;
  return {
    scoringEnabled: x.call_scoring_enabled,
    tlSeesCallScores: x.tl_sees_call_scores,
    disabledKeys: [...x.coaching_rubric_disabled],
    aiEnabled: x.ai_enabled,
    zone: x.default_timezone,
    packCleared: x.cleared,
    packReviewedAt: x.reviewed_at ? x.reviewed_at.toISOString() : null,
    packVersion: x.version,
  };
}

/**
 * Writes the given call-scoring settings and no others (none given: no write). tenant_settings_p23_guard refuses
 * anyone but the Owner, except an Admin's write that turns call reviews off alone (E283), and refuses "on" while the
 * pack is not cleared.
 */
export async function updateCoachingSettings(tx: Tx, v: { scoringEnabled?: boolean; tlSeesCallScores?: boolean; disabledKeys?: readonly string[] }): Promise<void> {
  const sets = [
    ...(v.scoringEnabled === undefined ? [] : [sql`call_scoring_enabled = ${v.scoringEnabled}`]),
    ...(v.tlSeesCallScores === undefined ? [] : [sql`tl_sees_call_scores = ${v.tlSeesCallScores}`]),
    ...(v.disabledKeys === undefined ? [] : [sql`coaching_rubric_disabled = ${[...v.disabledKeys]}::text[]`]),
  ];
  if (sets.length === 0) return;
  await sql`UPDATE tenant_settings SET ${sql.join(sets, sql`, `)} WHERE tenant_id = app.tenant_id()`.execute(tx);
}

/** The tenant's local date at `now` (one fix per agent per local day; the tenant zone, as the scoreboard days). */
export async function localDateAt(tx: Tx, now: Instant): Promise<string> {
  const r = await sql<{ d: string }>`
    SELECT to_char((${toIso(now)}::timestamptz AT TIME ZONE s.default_timezone)::date, 'YYYY-MM-DD') AS d
      FROM tenant_settings s WHERE s.tenant_id = app.tenant_id()`.execute(tx);
  const d = r.rows[0]?.d;
  if (!d) throw new Error('coaching: tenant settings missing');
  return d;
}

// ---- the call review job ----------------------------------------------------------------------

export interface CallReviewFactsRow {
  callId: string;
  contactId: string;
  agentUserId: string | null;
  /** the agent's membership role (null without an agent) */
  agentRole: string | null;
  handledBy: string;
  imported: boolean;
  recording: { source: string; consentBasis: string; shredded: boolean } | null;
  hasTranscript: boolean;
  reviewed: boolean;
}

export async function callReviewFacts(tx: Tx, callId: string): Promise<CallReviewFactsRow | null> {
  const r = await sql<{ id: string; contact_id: string; agent_user_id: string | null; agent_role: string | null; handled_by: string; imported: boolean; source: string | null; consent_basis: string | null; rec_status: string | null; has_transcript: boolean; reviewed: boolean }>`
    SELECT c.id, c.contact_id, c.agent_user_id, c.handled_by, c.imported, r.source, r.consent_basis, r.status AS rec_status,
           (SELECT m.role FROM memberships m WHERE m.tenant_id = c.tenant_id AND m.user_id = c.agent_user_id) AS agent_role,
           EXISTS (SELECT 1 FROM transcripts t WHERE t.tenant_id = r.tenant_id AND t.recording_id = r.id AND t.status = 'ready') AS has_transcript,
           EXISTS (SELECT 1 FROM call_scores s WHERE s.tenant_id = c.tenant_id AND s.call_id = c.id) AS reviewed
      FROM calls c
      LEFT JOIN LATERAL (SELECT * FROM recordings r WHERE r.tenant_id = c.tenant_id AND r.call_id = c.id ORDER BY r.created_at LIMIT 1) r ON true
     WHERE c.tenant_id = app.tenant_id() AND c.id = ${callId}`.execute(tx);
  const x = r.rows[0];
  if (!x) return null;
  return {
    callId: x.id,
    contactId: x.contact_id,
    agentUserId: x.agent_user_id,
    agentRole: x.agent_role,
    handledBy: x.handled_by,
    imported: x.imported,
    recording: x.source === null ? null : { source: x.source, consentBasis: x.consent_basis ?? '', shredded: x.rec_status === 'shredded' },
    hasTranscript: x.has_transcript,
    reviewed: x.reviewed,
  };
}

/**
 * Calls the scan hands to the review job: human-handled, not imported, a provider recording on a lawful
 * basis with a ready transcript in the last 2 days, no review yet and no review run yet. Empty while the
 * Owner's switch is off or the platform:coaching pack is not cleared (the job checks both again).
 */
export async function callsAwaitingReview(tx: Tx, now: Instant): Promise<string[]> {
  const r = await sql<{ id: string }>`
    SELECT c.id FROM calls c
      JOIN recordings r ON r.tenant_id = c.tenant_id AND r.call_id = c.id
      JOIN transcripts t ON t.tenant_id = r.tenant_id AND t.recording_id = r.id
      JOIN tenant_settings s ON s.tenant_id = c.tenant_id
     WHERE c.tenant_id = app.tenant_id() AND c.handled_by = 'human' AND NOT c.imported AND c.agent_user_id IS NOT NULL
       AND EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = c.tenant_id AND m.user_id = c.agent_user_id AND m.role = ANY (${[...REVIEWED_ROLES]}::text[]))
       AND r.source = 'provider' AND r.consent_basis IN ('announced_all_parties','one_party_policy') AND r.status <> 'shredded'
       AND t.status = 'ready' AND t.updated_at > ${toIso(now)}::timestamptz - interval '2 days'
       AND s.call_scoring_enabled AND app.platform_cleared('platform:coaching')
       AND NOT EXISTS (SELECT 1 FROM call_scores cs WHERE cs.tenant_id = c.tenant_id AND cs.call_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM ai_runs ar WHERE ar.tenant_id = c.tenant_id AND ar.purpose = 'call_review' AND ar.input_refs -> 'callIds' ? c.id::text)
     ORDER BY t.updated_at LIMIT 100`.execute(tx);
  return r.rows.map((x) => x.id);
}

export async function insertAiRun(tx: Tx, r: { id: string; model: string; templateKey: string; templateVersion: string; callId: string; outputEnc: Buffer | null; signals: Record<string, unknown>; inputTokens: number; outputTokens: number; latencyMs: number; status: 'succeeded' | 'failed' | 'refused' }): Promise<void> {
  await sql`
    INSERT INTO ai_runs (tenant_id, id, purpose, model, prompt_template_key, prompt_version, input_refs, output_enc, key_version, internal_signals,
      input_tokens, output_tokens, latency_ms, status, requested_for_user_id)
    VALUES (app.tenant_id(), ${r.id}, 'call_review', ${r.model.slice(0, 100)}, ${r.templateKey}, ${r.templateVersion},
      ${JSON.stringify({ callIds: [r.callId] })}::jsonb, ${r.outputEnc}, ${r.outputEnc === null ? null : 1}, ${JSON.stringify(r.signals)}::jsonb,
      ${r.inputTokens}, ${r.outputTokens}, ${r.latencyMs}, ${r.status}, NULL)`.execute(tx);
}

export async function insertCallScore(tx: Tx, s: { callId: string; rubricVersion: string; agentUserId: string; contactId: string; items: unknown; metCount: number; scoredCount: number; actionId: string }): Promise<boolean> {
  const r = await sql<{ call_id: string }>`
    INSERT INTO call_scores (tenant_id, call_id, rubric_version, agent_user_id, contact_id, items, met_count, scored_count, assistant_action_id)
    VALUES (app.tenant_id(), ${s.callId}, ${s.rubricVersion}, ${s.agentUserId}, ${s.contactId}, ${JSON.stringify(s.items)}::jsonb, ${s.metCount}, ${s.scoredCount}, ${s.actionId})
    ON CONFLICT (tenant_id, call_id, rubric_version) DO NOTHING RETURNING call_id`.execute(tx);
  return r.rows.length > 0;
}

// ---- reviews as the daily fix reads them ------------------------------------------------------

export interface StoredReview {
  callId: CallId;
  agentUserId: string;
  contactId: string;
  occurredAt: Instant;
  rubricVersion: string;
  items: { key: string; status: ItemStatus; claimId: string | null }[];
  metCount: number;
  scoredCount: number;
}

const STATUSES = new Set<ItemStatus>(['met', 'missed', 'not_applicable', 'needs_review']);

function itemsOf(v: unknown): StoredReview['items'] {
  if (!Array.isArray(v)) return [];
  const out: StoredReview['items'] = [];
  for (const x of v) {
    if (!x || typeof x !== 'object') continue;
    const o = x as { key?: unknown; status?: unknown; claim_id?: unknown };
    if (typeof o.key !== 'string' || typeof o.status !== 'string' || !STATUSES.has(o.status as ItemStatus)) continue;
    out.push({ key: o.key, status: o.status as ItemStatus, claimId: typeof o.claim_id === 'string' ? o.claim_id : null });
  }
  return out;
}

/**
 * The latest scored reviews (scored_count ≥ 1) of these agents that the CALLER may read (RLS), newest call
 * first, at most `perAgent` each. Reviews of every rubric version count (core matches items by key).
 */
export async function latestReviews(tx: Tx, agentUserIds: readonly string[], perAgent: number): Promise<StoredReview[]> {
  if (agentUserIds.length === 0) return [];
  const r = await sql<{ call_id: string; agent_user_id: string; contact_id: string; started_at: Date; rubric_version: string; items: unknown; met_count: number; scored_count: number }>`
    SELECT x.call_id, x.agent_user_id, x.contact_id, x.started_at, x.rubric_version, x.items, x.met_count, x.scored_count
      FROM unnest(${[...agentUserIds]}::uuid[]) AS a(uid)
      CROSS JOIN LATERAL (
        SELECT s.call_id, s.agent_user_id, s.contact_id, c.started_at, s.rubric_version, s.items, s.met_count, s.scored_count
          FROM call_scores s JOIN calls c ON c.tenant_id = s.tenant_id AND c.id = s.call_id
         WHERE s.tenant_id = app.tenant_id() AND s.agent_user_id = a.uid AND s.scored_count > 0
         ORDER BY c.started_at DESC, s.call_id LIMIT ${perAgent}) x`.execute(tx);
  return r.rows
    .filter((x) => isRubricVersion(x.rubric_version))
    .map((x) => ({
      callId: x.call_id as CallId,
      agentUserId: x.agent_user_id,
      contactId: x.contact_id,
      occurredAt: instantFromDate(x.started_at),
      rubricVersion: x.rubric_version,
      items: itemsOf(x.items),
      metCount: x.met_count,
      scoredCount: x.scored_count,
    }));
}

export interface EvidenceLite {
  id: string;
  claimId: string;
  sourceId: string;
  locator: { kind: 'transcript_offset'; startMs: number; endMs: number };
}

/** Verified transcript quotes of these claims that the caller may read (RLS: evidence follows its claim's action). */
export async function verifiedQuotes(tx: Tx, claimIds: readonly string[]): Promise<EvidenceLite[]> {
  if (claimIds.length === 0) return [];
  const r = await sql<{ id: string; claim_id: string; source_id: string; locator: Record<string, unknown> }>`
    SELECT e.id, e.claim_id, e.source_id, e.locator FROM evidence_refs e
     WHERE e.tenant_id = app.tenant_id() AND e.claim_id = ANY (${[...claimIds]}::uuid[]) AND e.verbatim_verified AND e.source_available
       AND e.source_type = 'call' AND e.locator ->> 'kind' = 'transcript_offset'
     ORDER BY e.created_at, e.id`.execute(tx);
  const out: EvidenceLite[] = [];
  for (const x of r.rows) {
    const s = Number(x.locator.startMs);
    const e = Number(x.locator.endMs);
    if (!Number.isFinite(s) || !Number.isFinite(e)) continue;
    out.push({ id: x.id, claimId: x.claim_id, sourceId: x.source_id, locator: { kind: 'transcript_offset', startMs: s, endMs: e } });
  }
  return out;
}

// ---- the daily fix cards (priority_feed_items under the coaching_fix:{user}:{date} key family) --

export const fixKeyPrefix = (userId: string) => `coaching_fix:${userId}:`;

/**
 * Members whose reviews the reconcile looks at: active members of a role with call reviews (never a TC: the tip's
 * page is closed to them; batch 7 review ui/F5) with at least one review.
 */
export async function reviewedMembers(tx: Tx): Promise<string[]> {
  const r = await sql<{ user_id: string }>`
    SELECT m.user_id FROM memberships m
     WHERE m.tenant_id = app.tenant_id() AND m.status = 'active' AND m.role = ANY (${[...REVIEWED_ROLES]}::text[])
       AND EXISTS (SELECT 1 FROM call_scores s WHERE s.tenant_id = m.tenant_id AND s.agent_user_id = m.user_id AND s.scored_count > 0)
     ORDER BY m.user_id`.execute(tx);
  return r.rows.map((x) => x.user_id);
}

export interface FixCardRow {
  id: string;
  userId: string;
  key: string;
  state: 'open' | 'done' | 'snoozed' | 'dismissed';
  resolvedBy: string | null;
  resolvedAt: Date | null;
  reasons: unknown;
}

/** A member's coaching cards (any state) for the given local dates, or of any date when `dates` is null. */
export async function fixCards(tx: Tx, userId: string, o: { dates?: readonly string[]; sinceResolved?: Instant } = {}): Promise<FixCardRow[]> {
  const keys = o.dates ? o.dates.map((d) => `${fixKeyPrefix(userId)}${d}`) : null;
  const r = await sql<{ id: string; user_id: string; dedupe_key: string; state: FixCardRow['state']; resolved_by: string | null; resolved_at: Date | null; reasons: unknown }>`
    SELECT id, user_id, dedupe_key, state, resolved_by, resolved_at, reasons FROM priority_feed_items
     WHERE tenant_id = app.tenant_id() AND user_id = ${userId} AND item_type = 'coaching_fix'
       AND (${keys}::text[] IS NULL OR dedupe_key = ANY (${keys}::text[]))
       AND (${o.sinceResolved === undefined ? null : toIso(o.sinceResolved)}::timestamptz IS NULL OR resolved_at >= ${o.sinceResolved === undefined ? null : toIso(o.sinceResolved)}::timestamptz)
     ORDER BY created_at DESC, id`.execute(tx);
  return r.rows.map((x) => ({ id: x.id, userId: x.user_id, key: x.dedupe_key, state: x.state, resolvedBy: x.resolved_by, resolvedAt: x.resolved_at, reasons: x.reasons }));
}

export async function insertFixCard(tx: Tx, c: { id: string; userId: string; key: string; reasons: unknown[] }): Promise<boolean> {
  const r = await sql<{ id: string }>`
    INSERT INTO priority_feed_items (tenant_id, id, user_id, item_type, band, contact_id, subject_type, subject_id, due_at, score, score_version, reasons, dedupe_key)
    VALUES (app.tenant_id(), ${c.id}, ${c.userId}, 'coaching_fix', 'scored', NULL, 'user', ${c.userId}, NULL, 30, 1, ${JSON.stringify(c.reasons)}::jsonb, ${c.key})
    ON CONFLICT (tenant_id, user_id, dedupe_key) WHERE state IN ('open','snoozed') DO NOTHING RETURNING id`.execute(tx);
  return r.rows.length > 0;
}

/** Closes open/snoozed coaching cards of a member (all of them, or all but `keepKey`): the condition ended. */
export async function closeFixCards(tx: Tx, o: { userId?: string; keepKey?: string; now: Instant }): Promise<number> {
  const r = await sql`
    UPDATE priority_feed_items SET state = 'done', snoozed_until = NULL, resolved_at = ${toIso(o.now)}::timestamptz, resolved_by = 'condition'
     WHERE tenant_id = app.tenant_id() AND item_type = 'coaching_fix' AND state IN ('open','snoozed')
       AND (${o.userId ?? null}::uuid IS NULL OR user_id = ${o.userId ?? null}::uuid)
       AND (${o.keepKey ?? null}::text IS NULL OR dedupe_key <> ${o.keepKey ?? null}::text)`.execute(tx);
  return Number(r.numAffectedRows ?? 0);
}

/** Closes open/snoozed coaching cards of everyone NOT in `userIds` (members who left or have no review). */
export async function closeFixCardsExcept(tx: Tx, userIds: readonly string[], now: Instant): Promise<number> {
  const r = await sql`
    UPDATE priority_feed_items SET state = 'done', snoozed_until = NULL, resolved_at = ${toIso(now)}::timestamptz, resolved_by = 'condition'
     WHERE tenant_id = app.tenant_id() AND item_type = 'coaching_fix' AND state IN ('open','snoozed')
       AND NOT (user_id = ANY (${[...userIds]}::uuid[]))`.execute(tx);
  return Number(r.numAffectedRows ?? 0);
}

/** The person dismisses their own card (feed_update RLS: their own row only). */
export async function dismissFixCard(tx: Tx, id: string, now: Instant): Promise<boolean> {
  const r = await sql<{ id: string }>`
    UPDATE priority_feed_items SET state = 'dismissed', snoozed_until = NULL, resolved_at = ${toIso(now)}::timestamptz, resolved_by = 'user'
     WHERE tenant_id = app.tenant_id() AND id = ${id} AND user_id = app.user_id() AND item_type = 'coaching_fix' AND state IN ('open','snoozed')
     RETURNING id`.execute(tx);
  return r.rows.length > 0;
}

// ---- what a quote needs to be played ----------------------------------------------------------

export interface QuoteSourceRow {
  evidenceId: string;
  claimId: string;
  callId: string;
  snippetEnc: Buffer | null;
  snippet: string | null;
  startMs: number;
  endMs: number;
  recordingId: string | null;
  callStartedAt: Date | null;
  contactId: string | null;
  contactFirstName: string | null;
}

/**
 * Evidence rows by id, with the call's recording and contact, as far as the CALLER may read them: the
 * evidence follows its call_review action (RESTRICTIVE call_review_scope: readable exactly where the review
 * is), the recording its recording scope. A row the caller may not read is simply absent.
 */
export async function quoteSources(tx: Tx, evidenceIds: readonly string[]): Promise<QuoteSourceRow[]> {
  if (evidenceIds.length === 0) return [];
  const r = await sql<{ id: string; claim_id: string; source_id: string; snippet_enc: Buffer | null; snippet: string | null; locator: Record<string, unknown>; recording_id: string | null; started_at: Date | null; contact_id: string | null; first_name: string | null }>`
    SELECT e.id, e.claim_id, e.source_id, e.snippet_enc, e.snippet, e.locator, rec.id AS recording_id, c.started_at, c.contact_id, ct.first_name
      FROM evidence_refs e
      JOIN assistant_claims cl ON cl.tenant_id = e.tenant_id AND cl.id = e.claim_id
      JOIN assistant_actions a ON a.tenant_id = cl.tenant_id AND a.id = cl.action_id AND a.kind = 'call_review'
      JOIN call_scores s ON s.tenant_id = a.tenant_id AND s.assistant_action_id = a.id
      LEFT JOIN calls c ON c.tenant_id = e.tenant_id AND c.id = e.source_id
      LEFT JOIN contacts ct ON ct.tenant_id = c.tenant_id AND ct.id = c.contact_id AND ct.deleted_at IS NULL
      LEFT JOIN LATERAL (SELECT r.id FROM recordings r WHERE r.tenant_id = e.tenant_id AND r.call_id = e.source_id AND r.status <> 'shredded' ORDER BY r.created_at LIMIT 1) rec ON true
     WHERE e.tenant_id = app.tenant_id() AND e.id = ANY (${[...evidenceIds]}::uuid[]) AND e.verbatim_verified AND e.source_available
       AND e.source_type = 'call' AND s.call_id = e.source_id`.execute(tx);
  return r.rows.map((x) => ({
    evidenceId: x.id,
    claimId: x.claim_id,
    callId: x.source_id,
    snippetEnc: x.snippet_enc,
    snippet: x.snippet,
    startMs: Number(x.locator.startMs),
    endMs: Number(x.locator.endMs),
    recordingId: x.recording_id,
    callStartedAt: x.started_at,
    contactId: x.contact_id,
    contactFirstName: x.first_name,
  }));
}

/** Team members the caller leads (Team Lead) or every active member (tenant-wide), with display names. */
export async function teamMembers(tx: Tx, scope: 'team' | 'all'): Promise<{ userId: string; name: string }[]> {
  const r = await sql<{ user_id: string; name: string }>`
    SELECT m.user_id, COALESCE(NULLIF(btrim(u.display_name), ''), 'Team member') AS name
      FROM memberships m JOIN users u ON u.id = m.user_id
     WHERE m.tenant_id = app.tenant_id() AND m.status = 'active' AND m.user_id <> app.user_id()
       AND (${scope} = 'all' OR m.user_id = ANY ((SELECT app.my_team_member_ids())::uuid[]))
     ORDER BY name, m.user_id`.execute(tx);
  return r.rows.map((x) => ({ userId: x.user_id, name: x.name }));
}
