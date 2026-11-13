// Module 75 data access and the authorization chain (R-ISA-1; docs/AI_ISA.md §3.1, §3.7). Every read runs in the
// caller's transaction under RLS. The global lock order (§3.7): addresses, then lock_contact for every record of the
// person (sorted), then the turn lock, then the assignment row; no provider call while any of them is held.
import type { ContactId, Instant } from '@realty/core/foundation';
import { instantFromDate } from '@realty/core/foundation';
import { type Tx, lockContacts } from '@realty/db';
import { sql } from 'kysely';
import { type IsaSide, type IsaState, initialState } from './coreSeam.js';
import { sellerSubjectLinkInTx } from './seller/index.js';

export interface BoundPoint {
  point_id: string;
  hmac: string;
}

export interface AssignmentRow {
  id: string;
  contactId: string;
  ownerUserId: string;
  optinId: string;
  playbookVersionId: string;
  boundOwnershipSeq: number;
  boundPoints: { sms?: BoundPoint; email?: BoundPoint };
  side: IsaSide;
  state: string;
  machine: IsaState;
  epoch: number;
  startedAt: Instant;
  startedByUserId: string;
  pausedAt: Instant | null;
  pausedByKind: 'user' | 'system' | null;
  pausedByUserId: string | null;
  pauseReason: string | null;
  endedAt: Instant | null;
  endReason: string | null;
  lastInboundSeq: number;
  finalizeAt: Instant | null;
  finalizeKind: 'take_over' | 'end' | null;
  messagesSent: number;
}

const COLS = sql`id, contact_id, owner_user_id, optin_id, playbook_version_id, bound_ownership_seq, bound_points, side, state, machine, epoch,
  started_at, started_by_user_id, paused_at, paused_by_kind, paused_by_user_id, pause_reason, ended_at, end_reason, last_inbound_seq,
  finalize_at, finalize_kind, messages_sent`;

type Raw = Record<string, unknown>;
const at = (v: unknown): Instant | null => (v === null || v === undefined ? null : instantFromDate(v as Date));

function rowOf(r: Raw): AssignmentRow {
  const startedAt = at(r.started_at)!;
  const side = r.side as IsaSide;
  const machine = r.machine && Object.keys(r.machine as object).length > 0 ? (r.machine as IsaState) : initialState({ assignmentId: r.id as string, side, startedAt });
  return {
    id: r.id as string,
    contactId: r.contact_id as string,
    ownerUserId: r.owner_user_id as string,
    optinId: r.optin_id as string,
    playbookVersionId: r.playbook_version_id as string,
    boundOwnershipSeq: Number(r.bound_ownership_seq),
    boundPoints: r.bound_points as AssignmentRow['boundPoints'],
    side,
    state: r.state as string,
    machine: { ...machine, epoch: Number(r.epoch) },
    epoch: Number(r.epoch),
    startedAt,
    startedByUserId: r.started_by_user_id as string,
    pausedAt: at(r.paused_at),
    pausedByKind: (r.paused_by_kind as AssignmentRow['pausedByKind']) ?? null,
    pausedByUserId: (r.paused_by_user_id as string | null) ?? null,
    pauseReason: (r.pause_reason as string | null) ?? null,
    endedAt: at(r.ended_at),
    endReason: (r.end_reason as string | null) ?? null,
    lastInboundSeq: Number(r.last_inbound_seq),
    finalizeAt: at(r.finalize_at),
    finalizeKind: (r.finalize_kind as AssignmentRow['finalizeKind']) ?? null,
    messagesSent: Number(r.messages_sent),
  };
}

export type RowLock = 'update' | 'share' | null;
const lockSql = (l: RowLock) => (l === 'update' ? sql` FOR UPDATE` : l === 'share' ? sql` FOR SHARE` : sql``);

export async function assignmentById(tx: Tx, id: string, lock: RowLock = null): Promise<AssignmentRow | null> {
  const r = await sql<Raw>`SELECT ${COLS} FROM ai_isa_assignments WHERE tenant_id = app.tenant_id() AND id = ${id}${lockSql(lock)}`.execute(tx);
  return r.rows[0] ? rowOf(r.rows[0]) : null;
}

/** The person's not-ended assignment (any record of the person), or null. */
export async function liveAssignmentOf(tx: Tx, contactId: string, lock: RowLock = null): Promise<AssignmentRow | null> {
  const r = await sql<Raw>`SELECT ${COLS} FROM ai_isa_assignments
    WHERE tenant_id = app.tenant_id() AND ended_at IS NULL AND contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${contactId}::uuid))
    ORDER BY started_at DESC LIMIT 1${lockSql(lock)}`.execute(tx);
  return r.rows[0] ? rowOf(r.rows[0]) : null;
}

/**
 * The latest assignment of the person of `contactId` (b12 review F6): every record of its merge tree, a merged-away
 * record's included (0081's root-survivor branch lets the survivor's audience read it). The panel's read-only history.
 */
export async function latestAssignmentOf(tx: Tx, contactId: string): Promise<AssignmentRow | null> {
  const r = await sql<Raw>`SELECT ${COLS} FROM ai_isa_assignments WHERE tenant_id = app.tenant_id()
      AND contact_id = ANY (app.contact_merge_tree_ids(app.tenant_id(), app.contact_merge_root(app.tenant_id(), ${contactId}::uuid)))
    ORDER BY started_at DESC LIMIT 1`.execute(tx);
  return r.rows[0] ? rowOf(r.rows[0]) : null;
}

export async function personIds(tx: Tx, contactId: string): Promise<string[]> {
  const r = await sql<{ ids: string[] }>`SELECT app.contact_person_ids(app.tenant_id(), ${contactId}::uuid) AS ids`.execute(tx);
  return r.rows[0]?.ids ?? [contactId];
}

/** Locks 2 → 3 (and the caller then takes 4: the assignment row). */
export async function lockForTurn(tx: Tx, contactId: string, assignmentId: string): Promise<void> {
  await lockContacts(tx, (await personIds(tx, contactId)) as ContactId[]);
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('ai_isa.turn:' || app.tenant_id()::text || ':' || ${assignmentId}, 0))`.execute(tx);
}

export async function saveMachine(tx: Tx, a: Pick<AssignmentRow, 'id'>, s: IsaState, extra: { lastInboundSeq?: number; nextFollowUpAt?: Instant | null } = {}): Promise<void> {
  const phase = s.ended !== null ? 'ended' : s.paused !== null ? 'paused' : s.phase;
  await sql`UPDATE ai_isa_assignments SET machine = ${JSON.stringify(s)}::jsonb, state = ${phase},
      awaiting_agent = ${JSON.stringify(s.held.map((h) => ({ class: h.class, since: h.since })))}::jsonb,
      messages_sent = ${s.counters.messagesSent}, unanswered_initiated = ${s.counters.unansweredInitiated}, undelivered_streak = ${s.counters.undeliveredStreak},
      last_inbound_seq = GREATEST(last_inbound_seq, ${extra.lastInboundSeq ?? 0})
      ${extra.nextFollowUpAt !== undefined ? sql`, next_follow_up_at = ${extra.nextFollowUpAt === null ? null : new Date(extra.nextFollowUpAt)}` : sql``}
    WHERE tenant_id = app.tenant_id() AND id = ${a.id} AND ended_at IS NULL`.execute(tx);
}

/** Every HMAC of the person (removed points included unless removed as a wrong number: R-PAR-12), hex. */
export async function personHmacs(tx: Tx, contactId: string): Promise<string[]> {
  const r = await sql<{ h: string }>`SELECT DISTINCT encode(address_hmac, 'hex') AS h FROM contact_points
    WHERE tenant_id = app.tenant_id() AND contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${contactId}::uuid))
      AND (removed_at IS NULL OR removed_reason IS DISTINCT FROM 'wrong_number') ORDER BY 1`.execute(tx);
  return r.rows.map((x) => x.h);
}

/** The first stop signal for the person since the assignment started (liveness reads the ledger, R-ISA-31). */
export async function stopSignalSince(tx: Tx, a: Pick<AssignmentRow, 'contactId' | 'startedAt'>): Promise<{ id: string; reason: string } | null> {
  const r = await sql<{ id: string; reason: string }>`SELECT s.id, s.reason FROM ai_isa_stop_signals s
    WHERE s.tenant_id = app.tenant_id() AND s.created_at >= ${new Date(a.startedAt)}
      AND (s.contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${a.contactId}::uuid))
           OR s.address_hmac IN (SELECT p.address_hmac FROM contact_points p WHERE p.tenant_id = app.tenant_id()
                                   AND p.contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${a.contactId}::uuid))
                                   AND (p.removed_at IS NULL OR p.removed_reason IS DISTINCT FROM 'wrong_number')))
    ORDER BY s.created_at LIMIT 1`.execute(tx);
  return r.rows[0] ?? null;
}

/**
 * The person's newest unlifted block. b12 review db-isa-merge-1: the records come from the definer merge-tree helpers
 * (0075), so a merged-away record the caller's contacts RLS hides still counts; 0081's root-survivor branch lets the
 * survivor's audience read its block row (the guard asks app.ai_isa_person_blocked, past RLS, at start).
 */
export async function activeBlock(tx: Tx, contactId: string): Promise<{ id: string; reason: string; createdAt: Instant } | null> {
  const r = await sql<{ id: string; reason: string; created_at: Date }>`SELECT id, reason, created_at FROM ai_isa_person_blocks
    WHERE tenant_id = app.tenant_id() AND lifted_at IS NULL
      AND contact_id = ANY (app.contact_merge_tree_ids(app.tenant_id(), app.contact_merge_root(app.tenant_id(), ${contactId}::uuid)))
    ORDER BY created_at DESC LIMIT 1`.execute(tx);
  const b = r.rows[0];
  return b ? { id: b.id, reason: b.reason, createdAt: instantFromDate(b.created_at) } : null;
}

// ---- the chain (§3.1) ---------------------------------------------------------------------------------------

export type LinkEffect = 'ok' | 'hold' | 'pause' | 'end';
export interface LinkResult {
  link: number;
  name: string;
  effect: LinkEffect;
  code: string | null;
  /** the pause or end reason the effect applies */
  reason: string | null;
  sentence: string;
}
export interface ChainResult {
  links: LinkResult[];
  effect: LinkEffect;
  /** the first failing link with the strongest effect */
  worst: LinkResult | null;
}

const RANK: Record<LinkEffect, number> = { ok: 0, hold: 1, pause: 2, end: 3 };

export interface ChainEnv {
  /** R-ISA-25: AI_ISA_LIVE_SENDS off with a non-fake adapter, per channel */
  liveOff: { sms: boolean; email: boolean };
  /** the telephony kill switch (TELEPHONY_LIVE_REQUESTS=false on the real adapter) */
  telephonyOff: boolean;
}

export interface TenantIsaFacts {
  aiEnabled: boolean;
  isaEnabled: boolean;
  dailyCap: number;
  sentToday: number;
  packCleared: boolean;
  timezone: string;
  teamName: string;
  brokerageName: string;
}

export async function tenantIsaFacts(tx: Tx): Promise<TenantIsaFacts> {
  const r = await sql<{ ai_enabled: boolean; ai_isa_enabled: boolean; ai_isa_daily_cap: number; tz: string; team_name: string | null; brokerage: string; cleared: boolean; sent: number | null }>`
    SELECT s.ai_enabled, s.ai_isa_enabled, s.ai_isa_daily_cap, s.default_timezone AS tz, s.team_name, s.brokerage_legal_name AS brokerage,
           app.platform_cleared('platform:ai_isa') AS cleared,
           (SELECT d.n FROM ai_isa_daily_counts d WHERE d.tenant_id = s.tenant_id AND d.local_day = (now() AT TIME ZONE s.default_timezone)::date) AS sent
      FROM tenant_settings s WHERE s.tenant_id = app.tenant_id()`.execute(tx);
  const t = r.rows[0]!;
  return { aiEnabled: t.ai_enabled, isaEnabled: t.ai_isa_enabled, dailyCap: t.ai_isa_daily_cap, sentToday: t.sent ?? 0, packCleared: t.cleared, timezone: t.tz, teamName: t.team_name ?? t.brokerage, brokerageName: t.brokerage };
}

/** The approval state of a policy version: approved (latest approval matches), narrowing-superseded, widened, revoked. */
export async function versionState(tx: Tx, versionId: string): Promise<'approved' | 'narrowed' | 'widened' | 'revoked' | 'missing'> {
  const r = await sql<{ status: string; ok: boolean | null; widened: boolean; has_approved_successor: boolean }>`
    SELECT v.status,
      (SELECT pa.decision = 'approve' AND pa.content_sha256 = v.content_sha256 FROM playbook_approvals pa
        WHERE pa.tenant_id = v.tenant_id AND pa.playbook_version_id = v.id ORDER BY pa.decided_at DESC LIMIT 1) AS ok,
      EXISTS (SELECT 1 FROM playbook_versions w WHERE w.tenant_id = v.tenant_id AND w.playbook_id = v.playbook_id AND w.version_no > v.version_no
                AND w.status IN ('approved','superseded','revoked') AND (w.status = 'revoked' OR w.narrows_previous IS NOT TRUE)) AS widened,
      EXISTS (SELECT 1 FROM playbook_versions w WHERE w.tenant_id = v.tenant_id AND w.playbook_id = v.playbook_id AND w.version_no > v.version_no
                AND w.status = 'approved') AS has_approved_successor
      FROM playbook_versions v WHERE v.tenant_id = app.tenant_id() AND v.id = ${versionId}`.execute(tx);
  const v = r.rows[0];
  if (!v) return 'missing';
  if (v.status === 'approved') return v.ok ? 'approved' : 'revoked';
  if (v.status === 'revoked') return 'revoked';
  if (v.status === 'superseded') return v.widened ? 'widened' : v.has_approved_successor ? 'narrowed' : 'revoked';
  return 'missing';
}

const L = (link: number, name: string, effect: LinkEffect, code: string | null, reason: string | null, sentence: string): LinkResult => ({ link, name, effect, code, reason, sentence });

/**
 * The link-failure table (§3.1), applied identically at ingestion, TX-A, TX-B, the sweep and the panel. The guard
 * re-checks every link but link 1 at dispatch.
 */
export async function evaluateChain(tx: Tx, a: AssignmentRow, env: ChainEnv): Promise<ChainResult> {
  const t = await tenantIsaFacts(tx);
  const links: LinkResult[] = [];
  const channels = Object.keys(a.boundPoints) as ('sms' | 'email')[];
  const liveOff = channels.length > 0 && channels.every((c) => env.liveOff[c] || (c === 'sms' && env.telephonyOff));
  links.push(liveOff ? L(1, 'Live sending', 'hold', 'AI_ISA_LIVE_OFF', null, 'AI assistant sending is off on this deployment.') : L(1, 'Live sending', 'ok', null, null, 'Sending is allowed on this deployment.'));
  links.push(t.packCleared ? L(2, 'Counsel review', 'ok', null, null, 'Counsel cleared the AI assistant.') : L(2, 'Counsel review', 'pause', 'AI_ISA_NOT_CLEARED', 'pack_withdrawn', 'Waiting on counsel review (platform:ai_isa).'));
  if (!t.isaEnabled) links.push(L(3, 'Team switch', 'end', 'AI_ISA_OFF', 'tenant_off', 'The Owner turned the AI assistant off.'));
  else if (!t.aiEnabled) links.push(L(3, 'Team switch', 'pause', 'AI_OFF', 'ai_off', 'AI features are off for the team.'));
  else if (t.sentToday >= t.dailyCap) links.push(L(3, 'Team switch', 'hold', 'ISA_CAP_REACHED', null, "The team's daily AI assistant limit is reached; it continues tomorrow."));
  else links.push(L(3, 'Team switch', 'ok', null, null, 'The Owner turned the AI assistant on.'));
  const vs = await versionState(tx, a.playbookVersionId);
  links.push(vs === 'approved' || vs === 'narrowed' ? L(4, 'Team policy', 'ok', null, null, 'The team policy is approved.')
    : vs === 'widened' ? L(4, 'Team policy', 'pause', 'POLICY_UPDATED', 'policy_updated', 'The team updated the AI rules. Re-attest to continue.')
    : L(4, 'Team policy', 'pause', 'AI_ISA_POLICY_NOT_APPROVED', 'approval_revoked', 'The team policy approval was revoked.'));
  const opt = await sql<{ status: string }>`SELECT status FROM ai_isa_agent_optins WHERE tenant_id = app.tenant_id() AND id = ${a.optinId}`.execute(tx);
  links.push(opt.rows[0]?.status === 'active' ? L(5, 'Your opt-in', 'ok', null, null, 'You opted in.') : L(5, 'Your opt-in', 'end', 'AI_ISA_NO_OPTIN', 'optin_revoked', 'The opt-in was revoked.'));
  const c = await sql<{ owner_user_id: string | null; seq: string | null; merged: string | null; deleted: Date | null; member_active: boolean; points_live: number }>`
    SELECT c.owner_user_id, c.ownership_period_seq AS seq, c.merged_into_contact_id AS merged, c.deleted_at AS deleted,
           EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = c.tenant_id AND m.user_id = ${a.ownerUserId} AND m.status = 'active') AS member_active,
           (SELECT count(*)::int FROM contact_points p WHERE p.tenant_id = c.tenant_id AND p.removed_at IS NULL
              AND p.id = ANY (${channels.map((ch) => a.boundPoints[ch]!.point_id)}::uuid[])) AS points_live
      FROM contacts c WHERE c.tenant_id = app.tenant_id() AND c.id = ${a.contactId}`.execute(tx);
  const cr = c.rows[0];
  if (!cr || cr.deleted !== null) links.push(L(6, 'Lead', 'end', 'AI_ISA_NOT_ROOT', 'merged', 'The record was deleted.'));
  else if (cr.merged !== null) links.push(L(6, 'Lead', 'end', 'AI_ISA_NOT_ROOT', 'merged', 'The record was merged into another.'));
  else if (cr.owner_user_id !== a.ownerUserId) links.push(L(6, 'Lead', 'end', 'OWNER_CHANGED', 'owner_change', 'AI care ended because this lead moved.'));
  else if (!cr.member_active) links.push(L(6, 'Lead', 'end', 'OWNER_INACTIVE', 'owner_inactive', 'The owner is no longer active.'));
  else if (Number(cr.seq) !== a.boundOwnershipSeq) links.push(L(6, 'Lead', 'pause', 'REINQUIRY', 'reinquiry', 'They inquired again. AI care is paused so you can see the new inquiry.'));
  else if (cr.points_live < channels.length) links.push(L(6, 'Lead', 'end', 'POINT_REMOVED', 'point_removed', 'An address bound at start was removed.'));
  else links.push(L(6, 'Lead', 'ok', null, null, "You own this lead; the bound addresses are live."));
  const sig = await stopSignalSince(tx, a);
  const blk = await activeBlock(tx, a.contactId);
  links.push(sig !== null ? L(7, 'Opt-outs', 'end', 'ISA_STOPPED', sig.reason, 'They opted out, were suppressed or asked not to be contacted.')
    // b12 review db-isa-merge-1: any unlifted block of the person, whenever written (lifts are explicit; the guard agrees)
    : blk !== null ? L(7, 'Opt-outs', 'end', 'ISA_STOPPED', 'opted_out', 'This person declined AI care.')
    : L(7, 'Opt-outs', 'ok', null, null, 'No opt-out since care started.'));
  const ex = await exclusivity(tx, a.contactId);
  links.push(ex.shared ? L(8, 'Exclusivity', 'end', 'ISA_SHARED_ADDRESS', 'shared_address', 'Another person shares one of their addresses.')
    : ex.activeClient ? L(8, 'Exclusivity', 'end', 'ISA_ACTIVE_CLIENT', 'active_client', 'They are a client on an open deal or an active listing.')
    : L(8, 'Exclusivity', 'ok', null, null, 'No shared address and no open deal.'));
  // ISA-3 H5: link 10 "Seller home" (R-ISA-26) for a seller- or both-side assignment
  const home = await sellerSubjectLinkInTx(tx, a);
  if (home !== null) links.push(home);
  let worst: LinkResult | null = null;
  for (const l of links) if (l.effect !== 'ok' && (worst === null || RANK[l.effect] > RANK[worst.effect])) worst = l;
  return { links, effect: worst?.effect ?? 'ok', worst };
}

export async function exclusivity(tx: Tx, contactId: string): Promise<{ shared: boolean; activeClient: boolean }> {
  const r = await sql<{ shared: boolean; client: boolean }>`
    WITH person AS (SELECT unnest(app.contact_person_ids(app.tenant_id(), ${contactId}::uuid)) AS id),
         h AS (SELECT p.address_hmac FROM contact_points p WHERE p.tenant_id = app.tenant_id() AND p.contact_id IN (SELECT id FROM person)
                 AND (p.removed_at IS NULL OR p.removed_reason IS DISTINCT FROM 'wrong_number'))
    SELECT EXISTS (SELECT 1 FROM contact_points o JOIN contacts oc ON oc.tenant_id = o.tenant_id AND oc.id = o.contact_id
                    WHERE o.tenant_id = app.tenant_id() AND o.address_hmac IN (SELECT address_hmac FROM h) AND o.removed_at IS NULL
                      AND o.contact_id NOT IN (SELECT id FROM person) AND oc.deleted_at IS NULL) AS shared,
           (EXISTS (SELECT 1 FROM deal_contacts dc JOIN deals d ON d.tenant_id = dc.tenant_id AND d.id = dc.deal_id
                     WHERE dc.tenant_id = app.tenant_id() AND dc.contact_id IN (SELECT id FROM person) AND d.stage NOT IN ('closed','lost'))
            OR EXISTS (SELECT 1 FROM deals d WHERE d.tenant_id = app.tenant_id() AND d.primary_contact_id IN (SELECT id FROM person) AND d.stage NOT IN ('closed','lost'))
            OR EXISTS (SELECT 1 FROM listing_contacts lc JOIN listings l ON l.tenant_id = lc.tenant_id AND l.id = lc.listing_id
                        WHERE lc.tenant_id = app.tenant_id() AND lc.contact_id IN (SELECT id FROM person) AND l.source = 'team'
                          AND l.status IN ('coming_soon','active','pending'))) AS client`.execute(tx);
  return { shared: r.rows[0]!.shared, activeClient: r.rows[0]!.client };
}

/** Queued and scheduled AI ISA messages of the person, and their proposed actions (for cancels and in-flight lists). */
export async function inFlightIsaMessages(tx: Tx, contactId: string): Promise<{ id: string; status: string; dispatchedAt: Instant | null }[]> {
  const r = await sql<{ id: string; status: string; dispatched_at: Date | null }>`SELECT id, status, dispatched_at FROM messages
    WHERE tenant_id = app.tenant_id() AND contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${contactId}::uuid))
      AND direction = 'outbound' AND initiator = 'assistant' AND action_category IN ('ai_isa_message','ai_isa_confirmation','ai_isa_holding_line')
      AND status IN ('queued','scheduled','dispatching','dispatch_unknown')`.execute(tx);
  return r.rows.map((m) => ({ id: m.id, status: m.status, dispatchedAt: at(m.dispatched_at) }));
}
