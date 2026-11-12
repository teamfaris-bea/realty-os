// Controls (R-ISA-15, R-ISA-16, R-ISA-28; docs/AI_ISA.md §3.4, §3.7): the human start, pause, resume, take over, end,
// undo, continue and block lift, and the system pause/end every other path uses. A human control is two
// transactions: the user's own (RLS and the assignment guard decide: the projection onto the assignment, the insert-
// only controls row, the audit), then a SYSTEM transaction under lock 2 that cancels queued AI messages, withdraws
// proposed AI actions and writes the cards (messages_update RLS lets only tenant-wide actors or the initiator update
// AI rows). The system never clears a pause (the DB guard refuses it).
import type { ContactId, Instant, SystemActor, UserActor } from '@realty/core/foundation';
import { instantFromDate } from '@realty/core/foundation';
import { type Tx, enqueueJob, lockContacts, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../audit.js';
import { AppError } from '../errors.js';
import { systemActor } from '../worker/systemActor.js';
import { capabilitiesInEffect, type IsaEndReason, type IsaFacts, type IsaPauseReason, step } from './coreSeam.js';

/** human_control, stop_signal and authorization_lost read no facts (core onControl): an explicit empty set */
const NOFACTS = {} as IsaFacts;
import { applyActionsInTx, cancelForAssignmentInTx, chainEnvOf, contextFor, control, type IsaDeps, pauseCardInTx } from './effects.js';
import { type AssignmentRow, activeBlock, assignmentById, evaluateChain, exclusivity, inFlightIsaMessages, liveAssignmentOf, lockForTurn, personIds, tenantIsaFacts } from './repo.js';

export const UNDO_MS = 10_000;

export interface ControlOutcome {
  assignmentId: string;
  state: 'starting' | 'awaiting_reply' | 'engaged' | 'nurture' | 'scheduling' | 'booking' | 'awaiting_agent' | 'paused' | 'ended';
  epoch: number;
  inFlight: { messageId: string; at: string; sentence: string }[];
  canceled: number;
  undoUntil: string | null;
  sentence: string;
}

const iso = (t: Instant) => new Date(t).toISOString();

function inFlightView(rows: { id: string; status: string; dispatchedAt: Instant | null }[]): ControlOutcome['inFlight'] {
  return rows.filter((m) => m.status === 'dispatching' || m.status === 'dispatch_unknown').map((m) => ({
    messageId: m.id, at: iso(m.dispatchedAt ?? (Date.now() as Instant)),
    sentence: `1 message was already on its way at ${new Date(m.dispatchedAt ?? Date.now()).toISOString().slice(11, 19)} UTC.`,
  }));
}

function asSystem<T>(deps: IsaDeps, tenantId: string, fn: (tx: Tx, now: Instant, actor: SystemActor) => Promise<T>): Promise<T> {
  const actor = systemActor(tenantId, 'assistant');
  return withTenantTx(actor, (tx, now) => fn(tx, now, actor), { db: deps.db, retries: 2 });
}

/** The current approved ai_isa team policy version (or null). */
export async function currentPolicy(tx: Tx): Promise<{ versionId: string; sha: string; steps: unknown } | null> {
  const r = await sql<{ id: string; sha: string; steps: unknown }>`SELECT v.id, v.content_sha256 AS sha, v.steps FROM playbook_versions v
    JOIN playbooks p ON p.tenant_id = v.tenant_id AND p.id = v.playbook_id
    WHERE v.tenant_id = app.tenant_id() AND p.kind = 'ai_isa' AND p.status = 'active' AND v.status = 'approved' ORDER BY v.version_no DESC LIMIT 1`.execute(tx);
  return r.rows[0] ? { versionId: r.rows[0].id, sha: r.rows[0].sha, steps: r.rows[0].steps } : null;
}

export interface StartInput {
  side: 'buyer' | 'seller' | 'both';
  channels?: ('sms' | 'email')[];
  fromHandbackId?: string;
  /** set by Continue AI care (reinquiry, policy re-attestation) */
  continuedFrom?: string;
}

/**
 * R-ISA-2: ANY point of the person, live or removed (unless removed as a wrong number), on another live contact.
 * It must see every contact of the tenant, so callers run it as the system (sharedAddressAsSystem).
 */
async function sharedAddressCount(tx: Tx, contactId: string): Promise<number> {
  const shared = await sql<{ n: number }>`SELECT count(*)::int AS n FROM contact_points p JOIN contact_points o ON o.tenant_id = p.tenant_id AND o.address_hmac = p.address_hmac
      JOIN contacts oc ON oc.tenant_id = o.tenant_id AND oc.id = o.contact_id
    WHERE p.tenant_id = app.tenant_id() AND p.contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${contactId}::uuid))
      AND (p.removed_at IS NULL OR p.removed_reason IS DISTINCT FROM 'wrong_number')
      AND NOT (o.contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${contactId}::uuid))) AND oc.deleted_at IS NULL AND oc.merged_into_contact_id IS NULL`.execute(tx);
  return shared.rows[0]!.n;
}

export async function sharedAddressAsSystem(deps: IsaDeps, tenantId: string, contactId: string): Promise<boolean> {
  return asSystem(deps, tenantId, async (tx) => (await sharedAddressCount(tx, contactId)) > 0);
}

/** Why a start would be refused right now (the panel's honest state), or null. */
export async function startRefusal(tx: Tx, actor: UserActor, contactId: string, i: Pick<StartInput, 'channels' | 'continuedFrom'> & { sharedAddress?: boolean } = {}): Promise<{ code: string; points?: AssignmentRow['boundPoints']; optinId?: string; versionId?: string; seq?: number } | null> {
  const t = await tenantIsaFacts(tx);
  if (!t.isaEnabled || !t.aiEnabled) return { code: 'AI_ISA_OFF' };
  if (!t.packCleared) return { code: 'AI_ISA_NOT_CLEARED' };
  const pol = await currentPolicy(tx);
  if (pol === null) return { code: 'AI_ISA_POLICY_NOT_APPROVED' };
  const opt = await sql<{ id: string; channels: string[] }>`SELECT id, channels FROM ai_isa_agent_optins WHERE tenant_id = app.tenant_id() AND user_id = ${actor.userId}
    AND status = 'active' AND playbook_version_id = ${pol.versionId}`.execute(tx);
  if (!opt.rows[0]) return { code: 'AI_ISA_NO_OPTIN' };
  const c = await sql<{ owner_user_id: string | null; merged: string | null; first_touch_at: Date | null; release_due_at: Date | null; dnc: Date | null; seq: string | null }>`
    SELECT owner_user_id, merged_into_contact_id AS merged, first_touch_at, release_due_at, do_not_contact_at AS dnc, ownership_period_seq AS seq
      FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${contactId} AND deleted_at IS NULL`.execute(tx);
  const cr = c.rows[0];
  if (!cr || cr.owner_user_id !== actor.userId) return { code: 'AI_ISA_NOT_OWNER' };
  if (cr.merged !== null) return { code: 'AI_ISA_NOT_ROOT' };
  const live = await liveAssignmentOf(tx, contactId);
  if (live !== null && live.id !== i.continuedFrom) return { code: 'AI_ISA_ALREADY_ACTIVE' };
  if (cr.dnc !== null) return { code: 'AI_ISA_DO_NOT_CONTACT' };
  if ((await activeBlock(tx, contactId)) !== null) return { code: 'AI_ISA_PERSON_DECLINED' };
  if (cr.first_touch_at === null && cr.release_due_at !== null) return { code: 'AI_ISA_FIRST_TOUCH_PENDING' };
  if (i.sharedAddress ?? (await sharedAddressCount(tx, contactId)) > 0) return { code: 'AI_ISA_SHARED_ADDRESS' };
  if ((await exclusivity(tx, contactId)).activeClient) return { code: 'AI_ISA_ACTIVE_CLIENT' };
  // the bindable points: the primary mobile and primary email that pass reply-tier evidence (no revoke of either
  // purpose on the person's points of that kind, not suppressed)
  const pts = await sql<{ id: string; kind: string; hmac: string; ok: boolean }>`
    SELECT p.id, p.kind, encode(p.address_hmac, 'hex') AS hmac,
      NOT EXISTS (SELECT 1 FROM consent_state cs WHERE cs.tenant_id = p.tenant_id AND cs.status = 'revoked' AND cs.channel = CASE WHEN p.kind = 'phone' THEN 'sms' ELSE 'email' END
                    AND cs.address_hmac IN (SELECT q.address_hmac FROM contact_points q WHERE q.tenant_id = p.tenant_id AND q.kind = p.kind
                      AND q.contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${contactId}::uuid))))
      AND NOT EXISTS (SELECT 1 FROM suppressions s WHERE s.tenant_id = p.tenant_id AND s.address_hmac = p.address_hmac AND s.lifted_at IS NULL) AS ok
      FROM contact_points p WHERE p.tenant_id = app.tenant_id() AND p.contact_id = ${contactId} AND p.removed_at IS NULL AND p.kind IN ('phone','email')
        AND (p.kind = 'email' OR p.line_type IS DISTINCT FROM 'landline')
     ORDER BY p.is_primary DESC, p.created_at`.execute(tx);
  const allowed = new Set<string>(opt.rows[0].channels.filter((ch) => (i.channels ?? ['sms', 'email']).includes(ch as 'sms' | 'email')));
  const points: AssignmentRow['boundPoints'] = {};
  const phone = pts.rows.find((p) => p.kind === 'phone' && p.ok);
  const email = pts.rows.find((p) => p.kind === 'email' && p.ok);
  if (phone && allowed.has('sms')) points.sms = { point_id: phone.id, hmac: phone.hmac };
  if (email && allowed.has('email')) points.email = { point_id: email.id, hmac: email.hmac };
  if (Object.keys(points).length === 0) return { code: 'AI_ISA_NO_CHANNEL' };
  return { code: 'OK', points, optinId: opt.rows[0].id, versionId: pol.versionId, seq: Number(cr.seq) };
}

export async function startCare(actor: UserActor, deps: IsaDeps, contactId: string, i: StartInput): Promise<ControlOutcome & { stoppedEnrollment: boolean; supersededProposals: number }> {
  const assignmentId = deps.ids.next<'X'>() as string;
  const sharedAddress = await sharedAddressAsSystem(deps, actor.tenantId, contactId);
  await withTenantTx(actor, async (tx, now) => {
    await lockContacts(tx, (await personIds(tx, contactId)) as ContactId[]);
    const r = await startRefusal(tx, actor, contactId, { ...i, sharedAddress });
    if (r === null || r.code !== 'OK') throw new AppError((r?.code ?? 'AI_ISA_OFF') as 'AI_ISA_OFF');
    if (i.fromHandbackId) await closeHandbackForStart(tx, actor, contactId, i.fromHandbackId, r.points!, now);
    const snapshot = { boundChannels: Object.keys(r.points!), at: iso(now) };
    await sql`INSERT INTO ai_isa_assignments (tenant_id, id, contact_id, owner_user_id, optin_id, playbook_version_id, bound_ownership_seq, bound_points, side,
        started_by_user_id, from_handback_id, continued_from_assignment_id, consent_snapshot)
      VALUES (app.tenant_id(), ${assignmentId}, ${contactId}, ${actor.userId}, ${r.optinId!}, ${r.versionId!}, ${r.seq!}, ${JSON.stringify(r.points)}::jsonb, ${i.side},
        ${actor.userId}, ${i.fromHandbackId ?? null}, ${i.continuedFrom ?? null}, ${JSON.stringify(snapshot)}::jsonb)`.execute(tx);
    await control(tx, deps.ids, { id: assignmentId, contactId }, 'continue', i.continuedFrom ? 'continuation' : 'start', actor.userId);
    await audit(tx, actor, { action: 'ai_isa.assignment_started', entity: { type: 'ai_isa_assignment', id: assignmentId }, reason: i.continuedFrom ? 'continuation' : 'start' });
    await enqueueJob(tx, { queue: 'realtime', kind: 'ai_isa.turn', payload: { assignmentId, trigger: i.fromHandbackId ? 'inbound' : 'start', epoch: 1 }, dedupeKey: `ai_isa.turn:${assignmentId}:1:start` });
  }, { db: deps.db, retries: 2 });
  // the system part: stop the live playbook enrollment, supersede every proposed draft and handback of the contact
  const sys = await asSystem(deps, actor.tenantId, async (tx) => {
    const e = await sql<{ id: string }>`UPDATE playbook_enrollments SET state = 'stopped', stop_reason = 'ai_isa_started', ended_at = now(), pause_reason = NULL, paused_at = NULL
      WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND state IN ('active','paused') RETURNING id`.execute(tx);
    const d = await sql<{ id: string }>`UPDATE assistant_actions SET status = 'invalidated' WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}
      AND kind IN ('message_draft','handback') AND status = 'proposed' RETURNING id`.execute(tx);
    return { stopped: e.rows.length > 0, superseded: d.rows.length };
  });
  return { assignmentId, state: 'starting', epoch: 1, inFlight: [], canceled: 0, undoUntil: null, stoppedEnrollment: sys.stopped, supersededProposals: sys.superseded,
    sentence: sys.stopped ? "AI care started. Starting AI care stops the 'New lead' playbook for this person." : 'AI care started.' };
}

/** §3.4 "Let the AI assistant continue": the handback must be current and from a point that becomes bound. */
async function closeHandbackForStart(tx: Tx, actor: UserActor, contactId: string, handbackId: string, points: AssignmentRow['boundPoints'], now: Instant): Promise<void> {
  const r = await sql<{ status: string; contact_id: string | null; owner_user_id: string | null; pinned: string | null; seq: string | null; from_hmac: string | null; queued: boolean }>`
    SELECT a.status, a.contact_id, a.owner_user_id, a.pinned_inbound_seq AS pinned, cv.inbound_seq AS seq,
      (SELECT encode(p.address_hmac, 'hex') FROM messages m JOIN contact_points p ON p.tenant_id = m.tenant_id AND p.contact_id = m.contact_id AND p.address = m.from_address
        WHERE m.tenant_id = a.tenant_id AND m.id = (a.payload->>'inboundMessageId')::uuid LIMIT 1) AS from_hmac,
      EXISTS (SELECT 1 FROM assistant_actions s WHERE s.tenant_id = a.tenant_id AND s.id = (a.payload->>'sentActionId')::uuid) AS queued
      FROM assistant_actions a LEFT JOIN conversations cv ON cv.tenant_id = a.tenant_id AND cv.contact_id = a.contact_id
     WHERE a.tenant_id = app.tenant_id() AND a.id = ${handbackId} AND a.kind = 'handback'`.execute(tx);
  const h = r.rows[0];
  if (!h || h.contact_id !== contactId || h.owner_user_id !== actor.userId) throw new AppError('NOT_FOUND'); // E539
  if (h.status !== 'proposed' || h.queued || Number(h.pinned) !== Number(h.seq)) throw new AppError('AI_ISA_HANDBACK_STALE');
  const bound = new Set(Object.values(points).map((p) => p!.hmac));
  if (h.from_hmac === null || !bound.has(h.from_hmac)) throw new AppError('AI_ISA_HANDBACK_STALE');
  // closed through the "nothing to send" branch: approved, acknowledged; its draft is discarded, nothing is sent
  await sql`UPDATE assistant_actions SET status = 'approved', decided_by_user_id = ${actor.userId}, decided_by_role = ${actor.role}, decided_at = ${new Date(now)},
      payload = payload || '{"result":"acknowledged","aiIsaContinued":true}'::jsonb
    WHERE tenant_id = app.tenant_id() AND id = ${handbackId} AND status = 'proposed'`.execute(tx);
}

async function loadFor(tx: Tx, contactId: string): Promise<AssignmentRow> {
  const a = await liveAssignmentOf(tx, contactId, 'update');
  if (a === null) throw new AppError('AI_ISA_NOT_LIVE');
  return a;
}

/** The second (system) transaction of a human control: cancels, withdrawals and the owner card. */
async function afterControl(deps: IsaDeps, tenantId: string, a: AssignmentRow, card: string | null): Promise<{ canceled: number; inFlight: ControlOutcome['inFlight'] }> {
  return asSystem(deps, tenantId, async (tx, now) => {
    await lockContacts(tx, (await personIds(tx, a.contactId)) as ContactId[]);
    const canceled = await cancelForAssignmentInTx(tx, a, 'AI_ISA_PAUSED');
    const fresh = (await assignmentById(tx, a.id)) ?? a;
    if (card !== null) await pauseCardInTx({ tx, deps, ctx: { ...(await contextFor(tx, fresh, now)), a: fresh }, now }, card);
    return { canceled, inFlight: inFlightView(await inFlightIsaMessages(tx, a.contactId)) };
  });
}

export async function pauseCare(actor: UserActor, deps: IsaDeps, contactId: string, kind: 'pause' | 'take_over' | 'end'): Promise<ControlOutcome> {
  const reason: IsaPauseReason = kind === 'pause' ? 'user' : kind === 'take_over' ? 'taking_over' : 'ending';
  const out = await withTenantTx(actor, async (tx, now) => {
    await lockContacts(tx, (await personIds(tx, contactId)) as ContactId[]);
    const a = await loadFor(tx, contactId);
    const r = step(a.machine, { type: 'human_control', at: now, control: kind, byOwner: actor.userId === a.ownerUserId }, NOFACTS);
    const undoUntil = kind === 'pause' ? null : ((now + UNDO_MS) as Instant);
    if (a.pausedAt === null) {
      await sql`UPDATE ai_isa_assignments SET paused_at = ${new Date(now)}, paused_by_kind = 'user', paused_by_user_id = ${actor.userId}, pause_reason = ${reason},
          machine = ${JSON.stringify(r.state)}::jsonb, state = 'paused'
          ${undoUntil ? sql`, finalize_at = ${new Date(undoUntil)}, finalize_kind = ${kind}` : sql``}
        WHERE tenant_id = app.tenant_id() AND id = ${a.id}`.execute(tx);
    } else {
      await sql`UPDATE ai_isa_assignments SET pause_reason = ${kind === 'pause' ? a.pauseReason : reason}, machine = ${JSON.stringify(r.state)}::jsonb
          ${undoUntil ? sql`, finalize_at = ${new Date(undoUntil)}, finalize_kind = ${kind}` : sql``}
        WHERE tenant_id = app.tenant_id() AND id = ${a.id}`.execute(tx);
    }
    await control(tx, deps.ids, a, kind, reason, actor.userId);
    await audit(tx, actor, { action: kind === 'take_over' ? 'ai_isa.assignment_taken_over' : kind === 'end' ? 'ai_isa.assignment_ended' : 'ai_isa.assignment_paused', entity: { type: 'ai_isa_assignment', id: a.id }, reason });
    if (undoUntil) await enqueueJob(tx, { queue: 'realtime', kind: 'ai_isa.finalize', payload: { assignmentId: a.id, epoch: a.epoch }, runAt: undoUntil, dedupeKey: `ai_isa.finalize:${a.id}:${a.epoch}` });
    return { a, undoUntil };
  }, { db: deps.db, retries: 2 });
  const sys = await afterControl(deps, actor.tenantId, out.a, kind === 'pause' && out.a.ownerUserId !== actor.userId ? 'user' : null);
  return { assignmentId: out.a.id, state: 'paused', epoch: out.a.epoch, inFlight: sys.inFlight, canceled: sys.canceled, undoUntil: out.undoUntil ? iso(out.undoUntil) : null,
    sentence: kind === 'pause' ? 'Paused: nobody is following up automatically.' : kind === 'take_over' ? 'You took over. Undo within 10 seconds keeps it paused.' : 'AI care ends in 10 seconds unless you undo.' };
}

export async function undoControl(actor: UserActor, deps: IsaDeps, contactId: string): Promise<ControlOutcome> {
  return withTenantTx(actor, async (tx, now) => {
    await lockContacts(tx, (await personIds(tx, contactId)) as ContactId[]);
    const a = await loadFor(tx, contactId);
    if (a.finalizeAt === null || a.finalizeAt <= now) throw new AppError('AI_ISA_UNDO_EXPIRED');
    const r = step(a.machine, { type: 'human_control', at: now, control: 'undo', byOwner: actor.userId === a.ownerUserId }, NOFACTS);
    // Undo leaves care paused, never live (R-ISA-15)
    await sql`UPDATE ai_isa_assignments SET finalize_at = NULL, finalize_kind = NULL, pause_reason = 'user', machine = ${JSON.stringify(r.state)}::jsonb
      WHERE tenant_id = app.tenant_id() AND id = ${a.id}`.execute(tx);
    await sql`SELECT app.cancel_jobs(ARRAY[${`ai_isa.finalize:${a.id}:${a.epoch}`}]::text[])`.execute(tx);
    await control(tx, deps.ids, a, 'undo', a.finalizeKind ?? 'undo', actor.userId);
    await audit(tx, actor, { action: 'ai_isa.undo', entity: { type: 'ai_isa_assignment', id: a.id }, reason: a.finalizeKind ?? 'undo' });
    return { assignmentId: a.id, state: 'paused', epoch: a.epoch, inFlight: [], canceled: 0, undoUntil: null, sentence: 'Undone. AI care stays paused until the owner resumes it.' };
  }, { db: deps.db, retries: 2 });
}

export async function resumeCare(actor: UserActor, deps: IsaDeps, contactId: string): Promise<ControlOutcome> {
  const out = await withTenantTx(actor, async (tx, now) => {
    await lockContacts(tx, (await personIds(tx, contactId)) as ContactId[]);
    const a = await loadFor(tx, contactId);
    if (a.ownerUserId !== actor.userId) throw new AppError('NOT_FOUND');
    if (a.pausedAt === null || a.finalizeAt !== null) throw new AppError('AI_ISA_NOT_PAUSED');
    // the chain must hold (a hold is fine: it is not a pause)
    const chain = await evaluateChain(tx, a, chainEnvOf(deps));
    if (chain.effect === 'pause' || chain.effect === 'end') throw new AppError((chain.worst?.code === 'AI_ISA_NOT_CLEARED' ? 'AI_ISA_NOT_CLEARED' : chain.worst?.code === 'AI_ISA_NO_OPTIN' ? 'AI_ISA_NO_OPTIN' : 'AI_ISA_OFF'));
    const r = step({ ...a.machine, paused: a.machine.paused ?? { reason: (a.pauseReason ?? 'user') as IsaPauseReason, byKind: a.pausedByKind ?? 'system', since: a.pausedAt } },
      { type: 'human_control', at: now, control: 'resume', byOwner: true }, NOFACTS);
    await sql`UPDATE ai_isa_assignments SET paused_at = NULL, paused_by_kind = NULL, paused_by_user_id = NULL, pause_reason = NULL, epoch = epoch + 1,
        machine = ${JSON.stringify(r.state)}::jsonb, state = ${r.state.phase}
      WHERE tenant_id = app.tenant_id() AND id = ${a.id}`.execute(tx);
    await control(tx, deps.ids, a, 'resume', 'owner', actor.userId);
    await audit(tx, actor, { action: 'ai_isa.assignment_resumed', entity: { type: 'ai_isa_assignment', id: a.id }, reason: a.pauseReason ?? 'user' });
    // a new turn picks up anything that arrived while paused
    await enqueueJob(tx, { queue: 'realtime', kind: 'ai_isa.turn', payload: { assignmentId: a.id, trigger: 'control', epoch: a.epoch + 1 }, dedupeKey: `ai_isa.turn:${a.id}:${a.epoch + 1}:resume` });
    return { a, epoch: a.epoch + 1 };
  }, { db: deps.db, retries: 2 });
  // withdraw any proposed action from an older epoch
  await asSystem(deps, actor.tenantId, (tx) => sql`UPDATE assistant_actions SET status = 'invalidated' WHERE tenant_id = app.tenant_id() AND contact_id = ${out.a.contactId}
    AND kind = 'ai_isa_message' AND status = 'proposed' AND epoch < ${out.epoch}`.execute(tx));
  return { assignmentId: out.a.id, state: 'engaged', epoch: out.epoch, inFlight: [], canceled: 0, undoUntil: null, sentence: 'AI care resumed.' };
}

/** The finalize job: after the 10-second undo window the take over or end becomes final, with the one handoff. */
export async function finalizeInTx(tx: Tx, deps: IsaDeps, actor: SystemActor, assignmentId: string, now: Instant): Promise<boolean> {
  const peek = await assignmentById(tx, assignmentId);
  if (peek === null) return false;
  await lockForTurn(tx, peek.contactId, peek.id);
  const a = await assignmentById(tx, assignmentId, 'update');
  if (a === null || a.endedAt !== null || a.finalizeAt === null || a.finalizeAt > now) return false;
  const ctx = await contextFor(tx, a, now);
  const machine = { ...a.machine, paused: { reason: (a.finalizeKind === 'take_over' ? 'taking_over' : 'ending') as IsaPauseReason, byKind: 'user' as const, since: a.pausedAt ?? now } };
  const r = step(machine, { type: 'human_control', at: now, control: 'finalize', byOwner: false }, NOFACTS);
  await applyActionsInTx({ tx, deps, actor, ctx: { ...ctx, a: { ...a, machine } }, now, turnId: null, pinnedSeq: a.lastInboundSeq }, r);
  return true;
}

/** A system end with the one handoff (stop signals, the sweep's link failures, tenant off, revocations). */
export async function systemEndInTx(tx: Tx, deps: IsaDeps, actor: SystemActor, a: AssignmentRow, reason: IsaEndReason, now: Instant, o: { stop?: 'opted_out' | 'suppressed' | 'do_not_contact' | 'wrong_number' | 'owner_change' | 'merged' } = {}): Promise<boolean> {
  if (a.endedAt !== null) return false;
  const ctx = await contextFor(tx, a, now);
  const r = o.stop ? step(a.machine, { type: 'stop_signal', at: now, reason: o.stop }, NOFACTS) : step(a.machine, { type: 'authorization_lost', at: now, effect: 'end', endReason: reason }, NOFACTS);
  if (r.state.ended === null) return false;
  await applyActionsInTx({ tx, deps, actor, ctx, now, turnId: null, pinnedSeq: a.lastInboundSeq }, r);
  return true;
}

export async function systemPauseInTx(tx: Tx, deps: IsaDeps, actor: SystemActor, a: AssignmentRow, reason: IsaPauseReason, now: Instant): Promise<boolean> {
  if (a.endedAt !== null || a.pausedAt !== null) return false;
  const ctx = await contextFor(tx, a, now);
  const r = step(a.machine, { type: 'authorization_lost', at: now, effect: 'pause', pauseReason: reason }, NOFACTS);
  await applyActionsInTx({ tx, deps, actor, ctx, now, turnId: null, pinnedSeq: a.lastInboundSeq }, { state: r.state, actions: [{ kind: 'pause', reason }, { kind: 'cancel_messages' }] });
  return true;
}

/** Owner "Continue AI care" after a same-owner reinquiry (or a re-attestation): end this one, start a linked one. */
export async function continueCare(actor: UserActor, deps: IsaDeps, contactId: string, side: StartInput['side'] | null = null): Promise<ControlOutcome & { stoppedEnrollment: boolean; supersededProposals: number }> {
  const prev = await withTenantTx(actor, async (tx) => {
    const a = await loadFor(tx, contactId);
    if (a.ownerUserId !== actor.userId) throw new AppError('NOT_FOUND');
    return a;
  }, { db: deps.db });
  await asSystem(deps, actor.tenantId, async (tx, now, sa) => {
    await lockForTurn(tx, prev.contactId, prev.id);
    const a = await assignmentById(tx, prev.id, 'update');
    if (a && a.endedAt === null) await systemEndInTx(tx, deps, sa, a, 'reinquiry_period', now);
  });
  return startCare(actor, deps, contactId, { side: side ?? prev.side, continuedFrom: prev.id });
}

export async function liftBlock(actor: UserActor, deps: IsaDeps, contactId: string, inboundMessageId: string, attestation: string): Promise<boolean> {
  return withTenantTx(actor, async (tx, now) => {
    const b = await activeBlock(tx, contactId);
    if (b === null) throw new AppError('NOT_FOUND');
    if (b.reason === 'opted_out' || b.reason === 'do_not_contact' || b.reason === 'wrong_number') throw new AppError('AI_ISA_BLOCK_NOT_LIFTABLE');
    const ok = await sql<{ id: string }>`UPDATE ai_isa_person_blocks SET lifted_at = ${new Date(now)}, lifted_by_user_id = ${actor.userId}, lift_inbound_message_id = ${inboundMessageId},
        lift_attestation = ${attestation} WHERE tenant_id = app.tenant_id() AND id = ${b.id} RETURNING id`.execute(tx).catch(() => null);
    if (ok === null || ok.rows.length === 0) throw new AppError('AI_ISA_BLOCK_NOT_LIFTABLE');
    await audit(tx, actor, { action: 'ai_isa.block_lifted', entity: { type: 'ai_isa_person_block', id: b.id }, reason: b.reason });
    return true;
  }, { db: deps.db });
}

/** "Pause all mine" (ai_isa.pause_all). */
export async function pauseAll(actor: UserActor, deps: IsaDeps): Promise<number> {
  const ids = await withTenantTx(actor, async (tx) => (await sql<{ contact_id: string }>`SELECT contact_id FROM ai_isa_assignments WHERE tenant_id = app.tenant_id()
    AND owner_user_id = ${actor.userId} AND ended_at IS NULL AND paused_at IS NULL`.execute(tx)).rows.map((r) => r.contact_id), { db: deps.db });
  for (const c of ids) await pauseCare(actor, deps, c, 'pause');
  await withTenantTx(actor, (tx) => audit(tx, actor, { action: 'ai_isa.pause_all', entity: { type: 'user', id: actor.userId }, reason: String(ids.length) }), { db: deps.db });
  return ids.length;
}

/** Capabilities in effect after intersecting the policy and the opt-in (the panel). */
export function capabilitySet(content: Parameters<typeof capabilitiesInEffect>[0], optIn: readonly string[]): Set<string> {
  return capabilitiesInEffect(content, optIn);
}

export const instantOf = (d: Date) => instantFromDate(d);
