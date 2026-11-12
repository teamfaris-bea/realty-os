// The handoff (R-ISA-14, R-ISA-30; docs/AI_ISA.md §4.7): exactly one per assignment, its package frozen (ids, codes
// and verified client quotes only; the hash is computed by Postgres over the stored jsonb so the CHECK holds), a
// pinned card and a notification, and a response deadline in business minutes that only a human touch clears.
import type { IdGenerator, Instant } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../audit.js';
import { adminUserIds, contactLabel, notifyUser, upsertFeedItem } from '../comms/repos/notify.js';
import { teamLeadOf } from '../leads/repos/members.js';
import { ISA_SLA_MINUTES, type Handoff } from './coreSeam.js';
import type { AssignmentRow } from './repo.js';
import type { SystemActor } from '@realty/core/foundation';

/** basis is codes-only (0190 ai_isa_codes_only): core's version 'isa-readiness/1' is stored as 'isa-readiness:1'. */
const codeOf = (v: string) => v.replace(/[^A-Za-z0-9_:.@-]/g, ':').slice(0, 64);

export type SlaClass = 'critical' | 'high' | 'normal' | 'low';

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

/** Who took over (the latest `take_over` control's user) while the take over is pending or final, else null. */
async function takerOf(tx: Tx, assignmentId: string): Promise<string | null> {
  const r = await sql<{ reason: string | null; u: string | null }>`SELECT a.pause_reason AS reason, (SELECT c.by_user_id FROM ai_isa_controls c
      WHERE c.tenant_id = a.tenant_id AND c.assignment_id = a.id AND c.kind = 'take_over' ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS u
    FROM ai_isa_assignments a WHERE a.tenant_id = app.tenant_id() AND a.id = ${assignmentId}`.execute(tx);
  const x = r.rows[0];
  return x?.reason === 'taking_over' ? (x.u ?? null) : null;
}

/**
 * The handoff recipient (Q1; R-ISA-15, R-ISA-30). While a take over is pending or final (pause_reason `taking_over`:
 * the finalize, or any end inside the undo window, a booking's included) it is the person who took over, from the
 * latest `take_over` control row (paused_by_user_id keeps only the FIRST pause). An inactive taker falls back to the
 * owner's recipients. Escalation always follows the owner's chain. An End keeps the owner, with endedByUserId.
 */
export async function recipientFor(tx: Tx, a: Pick<AssignmentRow, 'id' | 'ownerUserId'>): Promise<{ primary: string | null; escalation: string[]; takerUserId: string | null; endedByUserId: string | null }> {
  const base = await handoffRecipients(tx, a.ownerUserId);
  const taker = await takerOf(tx, a.id);
  const ender = await sql<{ u: string | null; reason: string | null }>`SELECT a.pause_reason AS reason, (SELECT c.by_user_id FROM ai_isa_controls c
      WHERE c.tenant_id = a.tenant_id AND c.assignment_id = a.id AND c.kind = 'end' ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS u
    FROM ai_isa_assignments a WHERE a.tenant_id = app.tenant_id() AND a.id = ${a.id}`.execute(tx);
  const endedByUserId = ender.rows[0]?.reason === 'ending' ? (ender.rows[0].u ?? null) : null;
  if (taker !== null) {
    const m = await sql<{ active: boolean }>`SELECT status = 'active' AS active FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = ${taker}`.execute(tx);
    if (m.rows[0]?.active) return { primary: taker, escalation: base.escalation.filter((u) => u !== taker), takerUserId: taker, endedByUserId };
  }
  return { ...base, takerUserId: taker, endedByUserId };
}

export interface HandoffInput {
  handoff: Handoff;
  /** the pending post-handoff message (confirmation or holding line), when one was queued with it */
  pendingMessageId?: string | null;
  /** extra frozen sentences as codes ("CONFIRMATION_NOT_SENT", "BOOKED_WHILE_PAUSED", "IN_FLIGHT:<id>") */
  notes?: string[];
  nextSteps?: string[];
  /** TX-C: the booked appointment's detail (ids, kind, times, organizer, offer, the agreed message and quote, the link and the read time) */
  appointmentDetail?: Record<string, unknown>;
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
  const unanswered = await sql<{ id: string }>`SELECT m.id FROM messages m JOIN conversations c ON c.tenant_id = m.tenant_id AND c.id = m.conversation_id
    WHERE m.tenant_id = app.tenant_id() AND m.contact_id = ${a.contactId} AND m.direction = 'inbound' AND m.created_at >= ${new Date(a.startedAt)}
      AND NOT EXISTS (SELECT 1 FROM messages o WHERE o.tenant_id = m.tenant_id AND o.conversation_id = m.conversation_id AND o.direction = 'outbound'
                        AND o.status IN ('sent','delivered') AND o.created_at > m.created_at)
    ORDER BY m.created_at`.execute(tx);
  const nextSteps = i.nextSteps ?? nextStepsFor(h);
  // R-ISA-16: the stored inactivity deadline (R-OWN-23) and the team zone, for the package and the card sentence
  const inact = await sql<{ release: Date | null; tz: string }>`SELECT c.inactivity_release_at AS release, s.default_timezone AS tz FROM contacts c
    JOIN tenant_settings s ON s.tenant_id = c.tenant_id WHERE c.tenant_id = app.tenant_id() AND c.id = ${a.contactId}`.execute(tx);
  const releaseAt = inact.rows[0]?.release ?? null;
  const rec = await recipientFor(tx, a);
  // the confirmation status follows its message: `scheduled` when the message waits for the window (§4.7)
  const pendingStatus = i.pendingMessageId
    ? ((await sql<{ s: string }>`SELECT status AS s FROM messages WHERE tenant_id = app.tenant_id() AND id = ${i.pendingMessageId}`.execute(tx)).rows[0]?.s === 'scheduled' ? 'scheduled' : 'queued')
    : 'none';
  const pkg = {
    v: 1,
    reason: h.reason,
    escalation: h.escalation,
    priority: h.priority,
    basis: h.basis,
    appointment: h.appointment,
    appointmentDetail: i.appointmentDetail ?? null,
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
    inactivityReleaseAt: releaseAt?.toISOString() ?? null,
    recipientUserId: rec.primary,
    endedByUserId: rec.endedByUserId,
  };
  const actionId = ids.next<'X'>() as string;
  const handoffId = ids.next<'X'>() as string;
  const label = (await contactLabel(tx, a.contactId)) ?? 'This lead';
  await sql`INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload, dedupe_key)
    VALUES (app.tenant_id(), ${actionId}, ${a.contactId}, 'ai_isa_handoff', 'internal', 'internal', 'proposed', ${a.ownerUserId},
            ${`AI care handed back: ${h.reason}`.slice(0, 300)}, ${JSON.stringify({ assignmentId: a.id, handoffId })}::jsonb, ${`ai_isa_handoff:${a.id}`})
    ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`.execute(tx);
  const cls: SlaClass = h.priority;
  const due = slaDueAt(cls, now);
  const body = JSON.stringify(pkg);
  await sql`INSERT INTO ai_isa_handoffs (tenant_id, id, assignment_id, contact_id, reason, basis, assistant_action_id, appointment_id, package, package_sha256,
      pending_message_id, confirmation_status, sla_class, sla_due_at, recipient_user_id)
    VALUES (app.tenant_id(), ${handoffId}, ${a.id}, ${a.contactId}, ${h.reason}, ${JSON.stringify(h.basis ? { rule: h.basis.rule, ruleVersion: codeOf(h.basis.ruleVersion), claimIds: h.basis.claimIds } : {})}::jsonb,
      ${actionId}, ${h.appointment?.appointmentId ?? null}, ${body}::jsonb, encode(sha256(convert_to(${body}::jsonb::text, 'UTF8')), 'hex'),
      ${i.pendingMessageId ?? null}, ${i.pendingMessageId ? pendingStatus : 'none'}, ${cls}, ${new Date(due)}, ${rec.primary})`.execute(tx);
  const targets = rec.primary ? [rec.primary] : rec.escalation;
  const hot = cls === 'critical';
  const cardText = h.reason === 'inactivity_warning' && releaseAt !== null
    ? inactivityCardText(label, releaseAt, inact.rows[0]!.tz)
    : rec.primary ? 'AI care handed back to you' : 'AI care ended because this lead moved. Here is what it did.';
  for (const userId of targets) {
    await upsertFeedItem(tx, ids, {
      userId, itemType: 'ai_isa_handoff', band: 'pinned', contactId: a.contactId, subjectType: 'ai_isa_handoff', subjectId: handoffId, assistantActionId: actionId,
      score: hot ? 98 : cls === 'high' ? 90 : 75, reasons: [{ code: `AI_ISA_HANDOFF:${h.reason}`, text: cardText }],
      dedupeKey: `ai_isa_handoff:${a.id}`, dueAt: due,
    });
    // a notification names no content: the reason code only (the AI summary is never in a notification)
    await notifyUser(tx, ids, { userId, kind: hot ? 'ai_isa_handoff_hot' : 'ai_isa_handoff', priority: hot ? 'critical' : cls === 'high' ? 'high' : 'normal',
      title: `AI care handed back: ${label}`.slice(0, 120), body: null, subjectType: 'contact', subjectId: a.contactId, dedupeKey: `ai_isa_handoff:${a.id}` }, now);
  }
  // Q1: after a take over the taker gets the card and the deadline; a different owner is told AI care ended
  if (rec.takerUserId !== null && rec.primary === rec.takerUserId && a.ownerUserId !== rec.takerUserId) {
    await notifyUser(tx, ids, { userId: a.ownerUserId, kind: 'ai_isa_ended', priority: 'normal', title: `AI care ended: ${label} was taken over`.slice(0, 120), body: null,
      subjectType: 'contact', subjectId: a.contactId, dedupeKey: `ai_isa_ended:${a.id}` }, now);
  }
  await audit(tx, actor, { action: 'ai_isa.handoff_created', entity: { type: 'ai_isa_handoff', id: handoffId }, reason: h.reason });
  return handoffId;
}

/** R-ISA-16 E516: "{Name} returns to the pond on {date, team zone} unless you touch them. AI care has handed back." */
export function inactivityCardText(label: string, releaseAt: Date, zone: string): string {
  let date: string;
  try {
    date = new Intl.DateTimeFormat('en-US', { timeZone: zone, weekday: 'short', month: 'short', day: 'numeric' }).format(releaseAt);
  } catch {
    date = releaseAt.toISOString().slice(0, 10);
  }
  return `${label} returns to the pond on ${date} unless you touch them. AI care has handed back.`.slice(0, 200);
}

function nextStepsFor(h: Handoff): string[] {
  const out: string[] = [];
  if (h.appointment) out.push('confirm_appointment');
  if (h.escalation === 'pricing_negotiation') out.push('answer_pricing_question');
  if (h.escalation === 'complaint') out.push('reply_to_complaint');
  if (h.escalation === 'fair_housing') out.push('review_fair_housing_question');
  if (h.escalation === 'consent_dispute') out.push('review_consent');
  if (out.length === 0) out.push('call_now');
  return out;
}

/**
 * The deadline job (R-ISA-30): a human touch since the handoff (R-OWN-14's touch, contacts.last_human_touch_at)
 * clears it; "Got it" never does. A breach notifies the team lead (level 1), then Owner/Admin (level 2).
 */
export async function slaSweepInTx(tx: Tx, ids: IdGenerator, now: Instant): Promise<{ met: number; escalated: number }> {
  let met = 0;
  let escalated = 0;
  const rows = await sql<{ id: string; contact_id: string; created_at: Date; sla_due_at: Date; sla_escalation_level: number; owner_user_id: string; touched: Date | null }>`
    SELECT h.id, h.contact_id, h.created_at, h.sla_due_at, h.sla_escalation_level, a.owner_user_id, c.last_human_touch_at AS touched
      FROM ai_isa_handoffs h JOIN ai_isa_assignments a ON a.tenant_id = h.tenant_id AND a.id = h.assignment_id
      JOIN contacts c ON c.tenant_id = h.tenant_id AND c.id = h.contact_id
     WHERE h.tenant_id = app.tenant_id() AND h.sla_met_at IS NULL ORDER BY h.sla_due_at LIMIT 200`.execute(tx);
  for (const r of rows.rows) {
    if (r.touched !== null && r.touched.getTime() >= r.created_at.getTime()) {
      await sql`UPDATE ai_isa_handoffs SET sla_met_at = ${r.touched} WHERE tenant_id = app.tenant_id() AND id = ${r.id}`.execute(tx);
      met += 1;
      continue;
    }
    if (now < r.sla_due_at.getTime() || r.sla_escalation_level >= 2) continue;
    // level 1 at the deadline; level 2 one more deadline-length later
    const span = r.sla_due_at.getTime() - r.created_at.getTime();
    if (r.sla_escalation_level === 1 && now < r.sla_due_at.getTime() + span) continue;
    const rec = await handoffRecipients(tx, r.owner_user_id);
    const tl = (await teamLeadOf(tx, r.owner_user_id))?.user_id ?? null;
    const level = r.sla_escalation_level + 1;
    const targets = level === 1 && tl !== null ? [tl] : rec.escalation;
    const label = (await contactLabel(tx, r.contact_id)) ?? 'A lead';
    for (const userId of targets) {
      await notifyUser(tx, ids, { userId, kind: 'ai_isa_handoff_overdue', priority: 'critical', title: `AI handoff not picked up: ${label}`.slice(0, 120), body: null,
        subjectType: 'contact', subjectId: r.contact_id, dedupeKey: `ai_isa_overdue:${r.id}:${level}` }, now);
    }
    await sql`UPDATE ai_isa_handoffs SET sla_escalated_at = ${new Date(now)}, sla_escalation_level = ${level} WHERE tenant_id = app.tenant_id() AND id = ${r.id}`.execute(tx);
    escalated += 1;
  }
  return { met, escalated };
}

/**
 * Item 9 (R-ISA-14; E533): the post-handoff confirmation did not go out. `not_sent` (canceled by a non-acknowledgement
 * inbound, failed, undelivered, blocked, or late): the card becomes critical (score 98, AI_ISA_CONFIRMATION_NOT_SENT),
 * an `ai_isa_handoff_hot` notification, and the deadline is pulled in to 15 minutes. `closed` (ISA_HANDOFF_CLOSED: a
 * person reached them first): the card says so, nothing hot. Codes only; never message content.
 */
export async function confirmationNotSentInTx(tx: Tx, ids: IdGenerator, h: { id: string; assignmentId: string; contactId: string; recipientUserId: string | null }, kind: 'not_sent' | 'closed', now: Instant): Promise<void> {
  const label = (await contactLabel(tx, h.contactId)) ?? 'A lead';
  if (kind === 'closed') {
    await sql`UPDATE priority_feed_items SET reasons = ${JSON.stringify([{ code: 'AI_ISA_CONFIRMATION_NOT_NEEDED', text: 'Someone on the team reached them first, so the AI confirmation was not sent.' }])}::jsonb,
        updated_at = now() WHERE tenant_id = app.tenant_id() AND dedupe_key = ${`ai_isa_handoff:${h.assignmentId}`} AND state IN ('open','snoozed')`.execute(tx);
    return;
  }
  const due = new Date(now + ISA_SLA_MINUTES.critical * 60_000);
  await sql`UPDATE ai_isa_handoffs SET sla_due_at = least(sla_due_at, ${due}) WHERE tenant_id = app.tenant_id() AND id = ${h.id} AND sla_met_at IS NULL`.execute(tx);
  await sql`UPDATE priority_feed_items SET score = 98, band = 'pinned', due_at = least(COALESCE(due_at, ${due}), ${due}),
      reasons = ${JSON.stringify([{ code: 'AI_ISA_CONFIRMATION_NOT_SENT', text: 'The appointment confirmation was not sent: confirm it by hand.' }])}::jsonb, updated_at = now()
    WHERE tenant_id = app.tenant_id() AND dedupe_key = ${`ai_isa_handoff:${h.assignmentId}`} AND state IN ('open','snoozed')`.execute(tx);
  const targets = h.recipientUserId ? [h.recipientUserId] : await adminUserIds(tx);
  for (const userId of targets) {
    await notifyUser(tx, ids, { userId, kind: 'ai_isa_handoff_hot', priority: 'critical', title: `Confirm the appointment: ${label}`.slice(0, 120), body: null,
      subjectType: 'contact', subjectId: h.contactId, dedupeKey: `ai_isa_confirmation_not_sent:${h.id}` }, now);
  }
}
