// The handoff (R-ISA-14, R-ISA-30; docs/AI_ISA.md §4.7): exactly one per assignment, its package frozen (ids, codes
// and verified client quotes only; the hash is computed by Postgres over the stored jsonb so the CHECK holds), a
// pinned card and a notification, and a response deadline in business minutes that only a human touch clears. Once
// the handoff is done, the system closes its card and executes its action (b12 recheck R13, closeHandoffInTx).
import { pointBlocks } from '@realty/core/compliance';
import type { IdGenerator, Instant, UserId } from '@realty/core/foundation';
import { phoneCallbackAllowed } from '@realty/core/voice';
import { type Tx, loadPeople, unownedHandbackTarget } from '@realty/db';
import { sql } from 'kysely';
import { resolveFeedFor } from '../assistant/repos/actions.js';
import { audit } from '../audit.js';
import { adminUserIds, contactLabel, notifyUser, upsertFeedItem } from '../comms/repos/notify.js';
import { teamLeadOf } from '../leads/repos/members.js';
import { optOutFactsOf } from '../voice/facts.js';
import { ISA_SLA_MINUTES, type Handoff } from './coreSeam.js';
import type { AssignmentRow } from './repo.js';
import type { HANDOFF_CLOSE_REASONS } from './schemas.js';
import type { SystemActor } from '@realty/core/foundation';

/** 'none' (b12 review B12X-2, F3): no human touch can clear it, so there is no deadline (0081). */
export type SlaClass = 'critical' | 'high' | 'normal' | 'low' | 'none';

/** Business-time deadline (VERIFY): critical 15 min, high 2 h, normal/low by the end of the next day. */
export function slaDueAt(cls: SlaClass, now: Instant): Instant {
  if (cls === 'critical') return (now + ISA_SLA_MINUTES.critical * 60_000) as Instant;
  if (cls === 'high') return (now + ISA_SLA_MINUTES.high * 60_000) as Instant;
  return (now + 24 * 3_600_000) as Instant;
}

/** Who gets the handoff: the owner while active; otherwise the previous owner's team lead, then Owner/Admin (E521). */
export async function handoffRecipients(tx: Tx, ownerUserId: string): Promise<{ primary: string | null; escalation: string[] }> {
  const m = await sql<{ active: boolean }>`SELECT status = 'active' AS active FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = ${ownerUserId}`.execute(tx);
  const tl = await teamLeadOf(tx, ownerUserId);
  const admins = await adminUserIds(tx);
  const escalation = [...new Set([...(tl ? [tl.user_id] : []), ...admins])].filter((u) => u !== ownerUserId);
  return { primary: m.rows[0]?.active ? ownerUserId : null, escalation };
}

/**
 * Where the handoff lands and who gets it (b12 review F1, F3; AI_ISA.md §3.6, §4.7):
 *   - the record: the root survivor of the assignment's record (a merge stop ends care on a record the person no
 *     longer lives on; its handoff, action and card go where the person's messages moved);
 *   - the recipient: the assignment's owner when that record's current owner is still them and active ("handed back to
 *     you"); the current owner when the lead moved to another active owner ("this lead moved"); otherwise nobody
 *     primary, and the card goes to the previous owner's Team Lead and Owner/Admin (pond, closed, deactivated).
 */
export interface HandoffTarget {
  contactId: string;
  primary: string | null;
  escalation: string[];
  sentence: string;
  closed: boolean;
}

export async function handoffTarget(tx: Tx, a: Pick<AssignmentRow, 'contactId' | 'ownerUserId'>): Promise<HandoffTarget> {
  const c = await sql<{ id: string; state: string | null; owner: string | null; active: boolean }>`
    SELECT c.id, c.ownership_state AS state, c.owner_user_id AS owner,
           EXISTS (SELECT 1 FROM memberships m WHERE m.tenant_id = c.tenant_id AND m.user_id = c.owner_user_id AND m.status = 'active') AS active
      FROM contacts c WHERE c.tenant_id = app.tenant_id() AND c.id = app.contact_merge_root(app.tenant_id(), ${a.contactId}::uuid)`.execute(tx);
  const root = c.rows[0];
  const rec = await handoffRecipients(tx, a.ownerUserId);
  const owner = root?.state === 'owned' && root.active ? root.owner : null;
  const closed = root?.state === 'closed';
  if (owner !== null && owner === a.ownerUserId) return { contactId: root!.id, primary: owner, escalation: rec.escalation, sentence: 'AI care handed back to you', closed };
  const sentence = closed ? 'AI care ended because this lead was closed. Here is what it did.' : 'AI care ended because this lead moved. Here is what it did.';
  if (owner !== null) return { contactId: root!.id, primary: owner, escalation: (await handoffRecipients(tx, owner)).escalation, sentence, closed };
  return { contactId: root?.id ?? a.contactId, primary: null, escalation: rec.escalation, sentence, closed };
}

/** Whether D1 leaves any human channel to the person (a text or call to a phone, an email): its reachability. */
async function humanReachable(tx: Tx, contactId: string): Promise<{ any: boolean; callback: boolean }> {
  const o = await optOutFactsOf(tx, contactId);
  if (o.personDoNotContact) return { any: false, callback: false };
  const any = o.reach.points.some((p) => (p.kind === 'phone' ? (['sms', 'voice'] as const) : (['email'] as const))
    .some((ch) => pointBlocks(o.reach, p, ch, 'informational').length === 0));
  return { any, callback: phoneCallbackAllowed(o, null) };
}

export interface HandoffInput {
  handoff: Handoff;
  /** the pending post-handoff message (confirmation or holding line), when one was queued with it */
  pendingMessageId?: string | null;
  /** extra frozen sentences as codes ("CONFIRMATION_NOT_SENT", "BOOKED_WHILE_PAUSED", "IN_FLIGHT:<id>") */
  notes?: string[];
  nextSteps?: string[];
}

/** Writes the one handoff of `a` (idempotent on the assignment). Returns the handoff id, or null if one exists. */
export async function writeHandoffInTx(tx: Tx, ids: IdGenerator, actor: SystemActor, a: AssignmentRow, i: HandoffInput, now: Instant): Promise<string | null> {
  const exists = await sql<{ id: string }>`SELECT id FROM ai_isa_handoffs WHERE tenant_id = app.tenant_id() AND assignment_id = ${a.id}`.execute(tx);
  if (exists.rows[0]) return null;
  const h = i.handoff;
  const turns = await sql<{ seq: number; status: string; decision: unknown; denied: unknown; message_id: string | null }>`
    SELECT seq, status, decision, denied, message_id FROM ai_isa_turns WHERE tenant_id = app.tenant_id() AND assignment_id = ${a.id} ORDER BY created_at`.execute(tx);
  const facts = await sql<{ fact_kind: string; listing_id: string | null; message_id: string | null }>`
    SELECT fact_kind, listing_id, message_id FROM ai_isa_shared_facts WHERE tenant_id = app.tenant_id() AND assignment_id = ${a.id} AND status = 'sent'`.execute(tx);
  const target = await handoffTarget(tx, a);
  const reach = await humanReachable(tx, target.contactId);
  const unanswered = await sql<{ id: string }>`SELECT m.id FROM messages m JOIN conversations c ON c.tenant_id = m.tenant_id AND c.id = m.conversation_id
    WHERE m.tenant_id = app.tenant_id() AND m.contact_id = ${target.contactId} AND m.direction = 'inbound' AND m.created_at >= ${new Date(a.startedAt)}
      AND NOT EXISTS (SELECT 1 FROM messages o WHERE o.tenant_id = m.tenant_id AND o.conversation_id = m.conversation_id AND o.direction = 'outbound'
                        AND o.status IN ('sent','delivered') AND o.created_at > m.created_at)
    ORDER BY m.created_at`.execute(tx);
  const nextSteps = i.nextSteps ?? nextStepsFor(h, reach.callback);
  const pkg = {
    v: 1,
    reason: h.reason,
    escalation: h.escalation,
    priority: h.priority,
    basis: h.basis,
    appointment: h.appointment,
    openOffer: h.openOffer,
    commitments: h.commitments,
    claims: a.machine.claims.filter((c) => h.claims.includes(c.claimId)).map((c) => ({ claimId: c.claimId, field: c.field, value: c.value, quote: c.quote, messageId: c.messageId })),
    conversation: turns.rows.map((t) => ({ seq: t.seq, status: t.status, decision: t.decision, denied: t.denied, messageId: t.message_id })),
    factsSent: facts.rows.map((f) => ({ factKind: f.fact_kind, listingId: f.listing_id, messageId: f.message_id })),
    unansweredInbound: unanswered.rows.map((r) => r.id),
    nextSteps,
    notes: i.notes ?? [],
    startedAt: a.startedAt,
    epoch: a.epoch,
  };
  const actionId = ids.next<'X'>() as string;
  const handoffId = ids.next<'X'>() as string;
  const label = (await contactLabel(tx, target.contactId)) ?? 'This lead';
  const targets = target.primary ? [target.primary] : target.escalation;
  await sql`INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload, dedupe_key)
    VALUES (app.tenant_id(), ${actionId}, ${target.contactId}, 'ai_isa_handoff', 'internal', 'internal', 'proposed', ${targets[0] ?? a.ownerUserId},
            ${`AI care handed back: ${h.reason}`.slice(0, 300)}, ${JSON.stringify({ assignmentId: a.id, handoffId })}::jsonb, ${`ai_isa_handoff:${a.id}`})
    ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`.execute(tx);
  // b12 review B12X-2, F3: no deadline when no human touch can ever clear it (D1 blocks every channel to the person, or
  // the lead is closed: a touch is recorded only on an owned lead). The card and notification still go.
  const cls: SlaClass = !reach.any || target.closed ? 'none' : h.priority;
  const due = cls === 'none' ? null : slaDueAt(cls, now);
  const body = JSON.stringify(pkg);
  await sql`INSERT INTO ai_isa_handoffs (tenant_id, id, assignment_id, contact_id, reason, basis, assistant_action_id, appointment_id, package, package_sha256,
      pending_message_id, confirmation_status, sla_class, sla_due_at, recipient_user_id)
    VALUES (app.tenant_id(), ${handoffId}, ${a.id}, ${target.contactId}, ${h.reason}, ${JSON.stringify(h.basis ? { rule: h.basis.rule, ruleVersion: h.basis.ruleVersion, claimIds: h.basis.claimIds } : {})}::jsonb,
      ${actionId}, ${h.appointment?.appointmentId ?? null}, ${body}::jsonb, encode(sha256(convert_to(${body}::jsonb::text, 'UTF8')), 'hex'),
      ${i.pendingMessageId ?? null}, ${i.pendingMessageId ? 'queued' : 'none'}, ${cls}, ${due === null ? sql`now()` : sql`${new Date(due)}`}, ${target.primary})`.execute(tx);
  const hot = h.priority === 'critical';
  for (const userId of targets) {
    await upsertFeedItem(tx, ids, {
      userId, itemType: 'ai_isa_handoff', band: 'pinned', contactId: target.contactId, subjectType: 'ai_isa_handoff', subjectId: handoffId, assistantActionId: actionId,
      score: hot ? 98 : h.priority === 'high' ? 90 : 75, reasons: [{ code: `AI_ISA_HANDOFF:${h.reason}`, text: target.sentence }],
      dedupeKey: `ai_isa_handoff:${a.id}`, dueAt: due,
    });
    // a notification names no content: the reason code only (the AI summary is never in a notification)
    await notifyUser(tx, ids, { userId, kind: hot ? 'ai_isa_handoff_hot' : 'ai_isa_handoff', priority: hot ? 'critical' : h.priority === 'high' ? 'high' : 'normal',
      title: `AI care handed back: ${label}`.slice(0, 120), body: null, subjectType: 'contact', subjectId: target.contactId, dedupeKey: `ai_isa_handoff:${a.id}` }, now);
  }
  await audit(tx, actor, { action: 'ai_isa.handoff_created', entity: { type: 'ai_isa_handoff', id: handoffId }, reason: h.reason });
  return handoffId;
}

/** Why a handoff is done (b12 recheck R13): the audit reason of closeHandoffInTx, stored as closed_reason (R19, 0081). */
export type HandoffCloseReason = (typeof HANDOFF_CLOSE_REASONS)[number];

/**
 * b12 recheck R13: a handoff that is done closes. Its pinned card closes (every open card of its action, whoever holds
 * it; resolved_by NULL, the "handled by its module" close that is final for the key, b12 recheck R22) and its
 * still-proposed action is executed, by the system (a person decides an action only as themselves, 0018; `executed` is
 * what an internal action takes once handled). Done means: a human touch met the deadline (the sweep, in its
 * transaction), "Got it" on a handoff no touch can ever meet (sla_class 'none'), the lead was closed by a person (the
 * sweep: a closed lead takes no touch), or AI care restarted on the person after a human touch since the handoff
 * (startCare; a restart alone never ends it, b12 recheck R16). The handoff's stored close (closed_at, closed_reason;
 * 0081, b12 recheck R19) marks it done for the sweep, the panel, the list and the Admin count, so its deadline never
 * alerts afterwards. b12 recheck R21: the close keys on that marker, not on the action: a handoff whose card a person
 * already decided (rejected or invalidated, as the generic taps did before R11) is marked done too, its action left as
 * the person decided it, so a closed lead's decided handoff stops being read, once. Idempotent: a second call changes
 * nothing and writes no second audit row.
 */
export async function closeHandoffInTx(tx: Tx, actor: SystemActor, h: { id: string; actionId: string }, reason: HandoffCloseReason, now: Instant): Promise<boolean> {
  // b12 recheck R19: the handoff records that it is closed and why (system-only, final: 0081's guard)
  const c = await sql<{ id: string }>`UPDATE ai_isa_handoffs SET closed_at = ${new Date(now)}, closed_reason = ${reason}
    WHERE tenant_id = app.tenant_id() AND id = ${h.id} AND closed_at IS NULL RETURNING id`.execute(tx);
  if (c.rows.length === 0) return false;
  await sql`UPDATE assistant_actions SET status = 'executed', updated_at = now()
    WHERE tenant_id = app.tenant_id() AND id = ${h.actionId} AND kind = 'ai_isa_handoff' AND status = 'proposed'`.execute(tx);
  await resolveFeedFor(tx, h.actionId, now);
  await audit(tx, actor, { action: 'ai_isa.handoff_closed', entity: { type: 'ai_isa_handoff', id: h.id }, reason });
  return true;
}

/** The next-step codes (§4.7). `call_now` only when a phone callback is allowed (E112; b12 review B12X-2). */
function nextStepsFor(h: Handoff, callbackAllowed: boolean): string[] {
  const out: string[] = [];
  if (h.appointment) out.push('confirm_appointment');
  if (h.escalation === 'pricing_negotiation') out.push('answer_pricing_question');
  if (h.escalation === 'complaint') out.push('reply_to_complaint');
  if (h.escalation === 'fair_housing') out.push('review_fair_housing_question');
  if (h.escalation === 'consent_dispute') out.push('review_consent');
  if (out.length === 0 && callbackAllowed) out.push('call_now');
  return out;
}

/**
 * Who an overdue handoff alerts (R-ISA-30, E521). An owner (the lead's current owner, or the frozen recipient when no
 * card holder is known): their Team Lead, then Owner/Admin. An unowned lead's card already sits with the previous
 * owner's Team Lead or an Owner/Admin (handoffTarget, rehomeHandbacks, the merge): that holder is level 1 (every
 * Owner/Admin when the holder is one, or is no longer active), then the holder and Owner/Admin (b12 recheck R8).
 * A card that was decided (dismissed, or closed by a generic tap) is routed to nobody and nothing moves it, so its
 * action's owner may be the agent who then released the lead: the holder is then the one rehomeHandbacks would have
 * given the card, the Team Lead of the lead's last owner (else an Owner/Admin), and only with no last owner on record
 * the frozen recipient (b12 recheck R10).
 */
async function overdueTargets(tx: Tx, r: { owner: string | null; holder: string | null; previous: string | null; frozen: string }, level: number): Promise<string[]> {
  const holder = r.owner !== null ? null : (r.holder ?? (r.previous !== null ? unownedHandbackTarget(await loadPeople(tx), r.previous as UserId) : null));
  if (r.owner === null && holder !== null) {
    const active = (await handoffRecipients(tx, holder)).primary !== null;
    const admins = await adminUserIds(tx);
    if (level === 1 && active && !admins.includes(holder)) return [holder];
    return [...new Set([...(active ? [holder] : []), ...admins])];
  }
  const anchor = r.owner ?? r.frozen;
  const rec = await handoffRecipients(tx, anchor);
  const tl = (await teamLeadOf(tx, anchor))?.user_id ?? null;
  return level === 1 && tl !== null ? [tl] : rec.escalation;
}

/**
 * The deadline job (R-ISA-30): a human touch since the handoff (R-OWN-14's touch, contacts.last_human_touch_at)
 * clears it; "Got it" never does. A breach notifies the team lead (level 1), then Owner/Admin (level 2). b12 recheck
 * R13: a met deadline closes the handoff's card and executes its action in this transaction; so does a lead closed
 * since (no touch can meet it any more), without recording the deadline as met; a handoff already done (its stored
 * close, b12 recheck R19, R21) is not read again.
 */
export async function slaSweepInTx(tx: Tx, ids: IdGenerator, now: Instant, actor: SystemActor): Promise<{ met: number; escalated: number; closed: number }> {
  let met = 0;
  let escalated = 0;
  let closed = 0;
  // b12 review B12X-3: the touch is read on the record the person lives on now (a merged-away record takes none).
  // b12 recheck R2: the escalation follows that record's current owner, as the pending card does (rehomeHandbacks, the
  // merge). b12 recheck R8: an unowned record follows whoever holds the card now (the handoff action's owner, which
  // rehomeHandbacks and the merge keep current while it is proposed). b12 recheck R10: a decided card has no holder;
  // the record's last owner on the ownership ledger stands in, and only with none does it fall back to the frozen
  // recipient, then the assignment's owner
  // b12 recheck R17: the read set holds only the rows this pass has work for, decided in SQL: a touch that meets the
  // deadline, a closed lead, a level-0 row past its deadline or a level-1 row past its second one. A row at level 2 that
  // nobody touched on an open lead (a pond lead nobody claims, say) has nothing left to do and is not read, so however
  // many pile up they never fill the 200 and starve a newer handoff; a touch or a close brings it back. Every row read
  // leaves the set or moves up a level, so the 200 bound the work of one pass and every due row is reached in turn.
  const at = new Date(now);
  // b12 recheck R20: also an acknowledged handoff with no deadline that is still open (the ack route's own close after
  // the acknowledgement failed): it is closed here, so that close is retried until it holds
  const rows = await sql<{ id: string; action_id: string; contact_id: string; lead_closed: boolean; created_at: Date; sla_due_at: Date; sla_escalation_level: number; owner_user_id: string | null; holder_user_id: string | null; previous_user_id: string | null; frozen_user_id: string; touched: Date | null; ack_close: boolean; touch_met: boolean; escalate: boolean }>`
    SELECT s.* FROM (
      SELECT h.id, h.assistant_action_id AS action_id, c.id AS contact_id, c.ownership_state = 'closed' AS lead_closed, h.created_at, h.sla_due_at, h.sla_escalation_level,
             CASE WHEN c.ownership_state = 'owned' THEN c.owner_user_id END AS owner_user_id,
             CASE WHEN x.status = 'proposed' THEN x.owner_user_id END AS holder_user_id,
             CASE WHEN c.ownership_state <> 'owned' THEN (SELECT e.owner_user_id FROM lead_ownership_events e
                    WHERE e.tenant_id = c.tenant_id AND e.contact_id = c.id AND e.owner_user_id IS NOT NULL ORDER BY e.seq DESC LIMIT 1) END AS previous_user_id,
             COALESCE(h.recipient_user_id, a.owner_user_id) AS frozen_user_id, c.last_human_touch_at AS touched,
             h.sla_class = 'none' AS ack_close,
             h.sla_class <> 'none' AND COALESCE(c.last_human_touch_at >= h.created_at, false) AS touch_met,
             h.sla_class <> 'none' AND ((h.sla_escalation_level = 0 AND h.sla_due_at <= ${at}::timestamptz)
               OR (h.sla_escalation_level = 1 AND h.sla_due_at + (h.sla_due_at - h.created_at) <= ${at}::timestamptz)) AS escalate
        FROM ai_isa_handoffs h JOIN ai_isa_assignments a ON a.tenant_id = h.tenant_id AND a.id = h.assignment_id
        JOIN contacts c ON c.tenant_id = h.tenant_id AND c.id = app.contact_merge_root(h.tenant_id, h.contact_id)
        LEFT JOIN assistant_actions x ON x.tenant_id = h.tenant_id AND x.id = h.assistant_action_id
       WHERE h.tenant_id = app.tenant_id() AND h.sla_met_at IS NULL AND h.closed_at IS NULL AND (h.sla_class <> 'none' OR h.acknowledged_at IS NOT NULL)) s
     WHERE s.ack_close OR s.touch_met OR s.lead_closed OR s.escalate
     ORDER BY s.sla_due_at, s.id LIMIT 200`.execute(tx);
  for (const r of rows.rows) {
    if (r.ack_close) {
      if (await closeHandoffInTx(tx, actor, { id: r.id, actionId: r.action_id }, 'acknowledged', now)) closed += 1;
      continue;
    }
    if (r.touch_met) {
      await sql`UPDATE ai_isa_handoffs SET sla_met_at = ${r.touched} WHERE tenant_id = app.tenant_id() AND id = ${r.id}`.execute(tx);
      await closeHandoffInTx(tx, actor, { id: r.id, actionId: r.action_id }, 'deadline_met', now);
      met += 1;
      continue;
    }
    // b12 recheck R13: a touch is recorded only on an owned lead, so a closed lead's deadline can never be met: the
    // handoff is done (its card closes, its action is executed), and nothing alerts; the deadline is not recorded as met.
    // b12 recheck R21: a handoff whose card was decided is marked done here too (once), so it is not read again
    if (r.lead_closed) {
      if (await closeHandoffInTx(tx, actor, { id: r.id, actionId: r.action_id }, 'lead_closed', now)) closed += 1;
      continue;
    }
    // level 1 at the deadline; level 2 one more deadline-length later (the read set's `escalate`)
    if (!r.escalate) continue;
    const level = r.sla_escalation_level + 1;
    const targets = await overdueTargets(tx, { owner: r.owner_user_id, holder: r.holder_user_id, previous: r.previous_user_id, frozen: r.frozen_user_id }, level);
    const label = (await contactLabel(tx, r.contact_id)) ?? 'A lead';
    for (const userId of targets) {
      await notifyUser(tx, ids, { userId, kind: 'ai_isa_handoff_overdue', priority: 'critical', title: `AI handoff not picked up: ${label}`.slice(0, 120), body: null,
        subjectType: 'contact', subjectId: r.contact_id, dedupeKey: `ai_isa_overdue:${r.id}:${level}` }, now);
    }
    await sql`UPDATE ai_isa_handoffs SET sla_escalated_at = ${new Date(now)}, sla_escalation_level = ${level} WHERE tenant_id = app.tenant_id() AND id = ${r.id}`.execute(tx);
    escalated += 1;
  }
  return { met, escalated, closed };
}
