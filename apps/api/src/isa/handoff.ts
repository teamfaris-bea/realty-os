// The handoff (R-ISA-14, R-ISA-30; docs/AI_ISA.md §4.7): exactly one per assignment, its package frozen (ids, codes
// and verified client quotes only; the hash is computed by Postgres over the stored jsonb so the CHECK holds), a
// pinned card and a notification, and a response deadline in business minutes that only a human touch clears. Once
// the handoff is done, the system closes its card and executes its action (b12 recheck R13, closeHandoffInTx).
import { pointBlocks } from '@realty/core/compliance';
import type { IdGenerator, Instant, UserId } from '@realty/core/foundation';
import { phoneCallbackAllowed } from '@realty/core/voice';
import { type Tx, loadPeople, unownedHandbackTarget } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../audit.js';
import { adminUserIds, contactLabel, notifyUser, resolveFeedFor, upsertFeedItem } from '../comms/repos/notify.js';
import { optOutFactsOf } from '../comms/repos/reachability.js';
import { teamLeadOf } from '../leads/repos/members.js';
import type { AlertSink, Logger } from '../worker/observability.js';
import { ISA_SLA_MINUTES, type Handoff } from './coreSeam.js';
import type { AssignmentRow } from './repo.js';
import type { HANDOFF_CLOSE_REASONS } from './schemas.js';
import type { SystemActor } from '@realty/core/foundation';

/** basis is codes-only (0080 ai_isa_codes_only): core's version 'isa-readiness/1' is stored as 'isa-readiness:1' (ISA-2b). */
const codeOf = (v: string) => v.replace(/[^A-Za-z0-9_:.@-]/g, ':').slice(0, 64);

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

/** Who took over (the latest `take_over` control's user) while the take over is pending or final, else null. */
async function takerOf(tx: Tx, assignmentId: string): Promise<string | null> {
  const r = await sql<{ reason: string | null; u: string | null }>`SELECT a.pause_reason AS reason, (SELECT c.by_user_id FROM ai_isa_controls c
      WHERE c.tenant_id = a.tenant_id AND c.assignment_id = a.id AND c.kind = 'take_over' ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS u
    FROM ai_isa_assignments a WHERE a.tenant_id = app.tenant_id() AND a.id = ${assignmentId}`.execute(tx);
  const x = r.rows[0];
  return x?.reason === 'taking_over' ? (x.u ?? null) : null;
}

/**
 * The handoff recipient (b12 review F1, F3 with ISA-2b item 5, Q1; R-ISA-15, R-ISA-30): handoffTarget's record and
 * routing, and while a take over is pending or final (pause_reason `taking_over`: the finalize, or any end inside the
 * undo window, a booking's included) the person who took over, from the latest `take_over` control row
 * (paused_by_user_id keeps only the FIRST pause), as long as the lead is still with the assignment's owner (a lead that
 * moved goes to its new owner, an unowned one to the escalation: handoffTarget). An inactive taker falls back to
 * handoffTarget's recipient. Escalation follows the owner's chain. An End keeps the owner, with endedByUserId.
 */
export async function recipientFor(tx: Tx, a: Pick<AssignmentRow, 'id' | 'contactId' | 'ownerUserId'>): Promise<HandoffTarget & { takerUserId: string | null; endedByUserId: string | null }> {
  const target = await handoffTarget(tx, a);
  const taker = await takerOf(tx, a.id);
  const ender = await sql<{ u: string | null; reason: string | null }>`SELECT a.pause_reason AS reason, (SELECT c.by_user_id FROM ai_isa_controls c
      WHERE c.tenant_id = a.tenant_id AND c.assignment_id = a.id AND c.kind = 'end' ORDER BY c.created_at DESC, c.id DESC LIMIT 1) AS u
    FROM ai_isa_assignments a WHERE a.tenant_id = app.tenant_id() AND a.id = ${a.id}`.execute(tx);
  const endedByUserId = ender.rows[0]?.reason === 'ending' ? (ender.rows[0].u ?? null) : null;
  if (taker !== null && taker !== a.ownerUserId && target.primary === a.ownerUserId) {
    const m = await sql<{ active: boolean }>`SELECT status = 'active' AS active FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = ${taker}`.execute(tx);
    if (m.rows[0]?.active) return { ...target, primary: taker, escalation: target.escalation.filter((u) => u !== taker), takerUserId: taker, endedByUserId };
  }
  return { ...target, takerUserId: taker, endedByUserId };
}

/**
 * b13 review B13S-3 / F4-ui: why a post-handoff appointment confirmation did not go out, as the web must say it.
 * 'not_needed': a person on the team reached them first (ISA_HANDOFF_CLOSED; the card says so, nothing to do);
 * 'unreachable': D1 leaves the person no text, call or email now, so it cannot be confirmed by hand (keep or cancel the
 * appointment; AI_ISA_CONFIRMATION_NOT_SENT_UNREACHABLE); 'by_hand': confirm it by hand. null when no confirmation
 * failed (none planned, still pending, sent, or the pending message is a holding line). Read now, under the reader's
 * RLS, on the record the handoff's merge chain ends at.
 */
export type ConfirmationNotSent = 'by_hand' | 'unreachable' | 'not_needed';
export async function confirmationNotSentOf(tx: Tx, h: { contactId: string; confirmationStatus: string; pendingMessageId: string | null }): Promise<ConfirmationNotSent | null> {
  if (h.confirmationStatus !== 'canceled' && h.confirmationStatus !== 'refused') return null;
  if (h.pendingMessageId) {
    const m = (await sql<{ category: string | null; reason: string | null }>`SELECT action_category AS category, status_reason AS reason FROM messages
      WHERE tenant_id = app.tenant_id() AND id = ${h.pendingMessageId}`.execute(tx)).rows[0];
    if (m && m.category !== 'ai_isa_confirmation') return null;
    if ((m?.reason ?? '').startsWith('ISA_HANDOFF_CLOSED')) return 'not_needed';
  }
  const root = (await sql<{ c: string }>`SELECT app.contact_merge_root(app.tenant_id(), ${h.contactId}::uuid) AS c`.execute(tx)).rows[0]?.c ?? h.contactId;
  return (await humanReachable(tx, root)).any ? 'by_hand' : 'unreachable';
}

/** Why D1 leaves the person no human channel (b14 to-do): they opted out (a person-level do-not-contact, or every
 *  channel of their live points), or they have no live phone or email at all (every point removed). */
export type UnreachableWhy = 'opted_out' | 'no_contact_details';
/** How a card says it, in parentheses after "no text, call or email can reach them now". */
export const UNREACHABLE_WHY_WORDS: Record<UnreachableWhy, string> = {
  opted_out: 'they opted out',
  no_contact_details: 'no contact details',
};

/** Whether D1 leaves any human channel to the person (a text or call to a phone, an email): its reachability, and why
 *  not when none is left. */
export async function humanReachable(tx: Tx, contactId: string): Promise<{ any: boolean; callback: boolean; why: UnreachableWhy | null }> {
  const o = await optOutFactsOf(tx, contactId);
  if (o.personDoNotContact) return { any: false, callback: false, why: 'opted_out' };
  const any = o.reach.points.some((p) => (p.kind === 'phone' ? (['sms', 'voice'] as const) : (['email'] as const))
    .some((ch) => pointBlocks(o.reach, p, ch, 'informational').length === 0));
  return { any, callback: phoneCallbackAllowed(o, null), why: any ? null : o.reach.points.length === 0 ? 'no_contact_details' : 'opted_out' };
}

export interface HandoffInput {
  handoff: Handoff;
  /** the pending post-handoff message (confirmation or holding line), when one was queued with it */
  pendingMessageId?: string | null;
  /** extra frozen sentences as codes ("CONFIRMATION_NOT_SENT", "BOOKED_WHILE_PAUSED", "IN_FLIGHT:<id>") */
  notes?: string[];
  nextSteps?: string[];
  /** TX-C (ISA-2b item 9): the booked appointment's detail (ids, kind, times, organizer, offer, the agreed message and quote, the link and the read time) */
  appointmentDetail?: Record<string, unknown>;
  /**
   * b13 review B13-MRG-3: the step planned a confirmation and it could not be queued (refused at queue time: a
   * merged-away record, a removed point, no shared window), or a booking stood while care was paused (E523, TX-C; b13
   * final M2). Stored as confirmation_status 'refused' with the CONFIRMATION_NOT_SENT note, and the card asks for a hand
   * confirmation (or says none is possible), never "No confirmation was planned".
   */
  confirmationNotQueued?: boolean;
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
  const target = await recipientFor(tx, a);
  const reach = await humanReachable(tx, target.contactId);
  const unanswered = await sql<{ id: string }>`SELECT m.id FROM messages m JOIN conversations c ON c.tenant_id = m.tenant_id AND c.id = m.conversation_id
    WHERE m.tenant_id = app.tenant_id() AND m.contact_id = ${target.contactId} AND m.direction = 'inbound' AND m.created_at >= ${new Date(a.startedAt)}
      AND NOT EXISTS (SELECT 1 FROM messages o WHERE o.tenant_id = m.tenant_id AND o.conversation_id = m.conversation_id AND o.direction = 'outbound'
                        AND o.status IN ('sent','delivered') AND o.created_at > m.created_at
                        AND o.action_category <> 'portal_login_link') -- a sign-in link is not an answer (b14 review R2)
    ORDER BY m.created_at`.execute(tx);
  // ISA-2b item 12: the AI-origin saved search (the end action paused an active one before this handoff)
  const ss = (await sql<{ id: string; status: string }>`SELECT id, status FROM saved_searches WHERE tenant_id = app.tenant_id() AND origin = 'ai_isa'
    AND contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${target.contactId}::uuid)) AND status IN ('proposed','approved','active','paused')
    ORDER BY created_at DESC LIMIT 1`.execute(tx)).rows[0] ?? null;
  const nextSteps = [...(i.nextSteps ?? nextStepsFor(h, reach.callback)), ...(ss ? [ss.status === 'proposed' ? 'approve_saved_search' : 'review_saved_search'] : [])];
  // R-ISA-16 (ISA-2b item 3): the stored inactivity deadline (R-OWN-23) and the team zone, for the package and the card sentence
  const inact = await sql<{ release: Date | null; tz: string }>`SELECT c.inactivity_release_at AS release, s.default_timezone AS tz FROM contacts c
    JOIN tenant_settings s ON s.tenant_id = c.tenant_id WHERE c.tenant_id = app.tenant_id() AND c.id = ${target.contactId}`.execute(tx);
  const releaseAt = inact.rows[0]?.release ?? null;
  // ISA-2b item 9: the confirmation status follows its message: `scheduled` when the message waits for the window (§4.7)
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
    notes: i.confirmationNotQueued && !i.pendingMessageId && !(i.notes ?? []).includes('CONFIRMATION_NOT_SENT') ? [...(i.notes ?? []), 'CONFIRMATION_NOT_SENT'] : i.notes ?? [],
    startedAt: a.startedAt,
    epoch: a.epoch,
    inactivityReleaseAt: releaseAt?.toISOString() ?? null,
    savedSearch: ss,
    recipientUserId: target.primary,
    endedByUserId: target.endedByUserId,
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
    VALUES (app.tenant_id(), ${handoffId}, ${a.id}, ${target.contactId}, ${h.reason}, ${JSON.stringify(h.basis ? { rule: h.basis.rule, ruleVersion: codeOf(h.basis.ruleVersion), claimIds: h.basis.claimIds } : {})}::jsonb,
      ${actionId}, ${h.appointment?.appointmentId ?? null}, ${body}::jsonb, encode(sha256(convert_to(${body}::jsonb::text, 'UTF8')), 'hex'),
      ${i.pendingMessageId ?? null}, ${i.pendingMessageId ? pendingStatus : i.confirmationNotQueued ? 'refused' : 'none'}, ${cls}, ${due === null ? sql`now()` : sql`${new Date(due)}`}, ${target.primary})`.execute(tx);
  const hot = h.priority === 'critical';
  // R-ISA-16 E516 (ISA-2b item 3): the inactivity warning's card names the pond date in the team zone
  const cardText = h.reason === 'inactivity_warning' && releaseAt !== null ? inactivityCardText(label, releaseAt, inact.rows[0]!.tz) : target.sentence;
  for (const userId of targets) {
    await upsertFeedItem(tx, ids, {
      userId, itemType: 'ai_isa_handoff', band: 'pinned', contactId: target.contactId, subjectType: 'ai_isa_handoff', subjectId: handoffId, assistantActionId: actionId,
      score: hot ? 98 : h.priority === 'high' ? 90 : 75, reasons: [{ code: `AI_ISA_HANDOFF:${h.reason}`, text: cardText }],
      dedupeKey: `ai_isa_handoff:${a.id}`, dueAt: due,
    });
    // a notification names no content: the reason code only (the AI summary is never in a notification)
    await notifyUser(tx, ids, { userId, kind: hot ? 'ai_isa_handoff_hot' : 'ai_isa_handoff', priority: hot ? 'critical' : h.priority === 'high' ? 'high' : 'normal',
      title: `AI care handed back: ${label}`.slice(0, 120), body: null, subjectType: 'contact', subjectId: target.contactId, dedupeKey: `ai_isa_handoff:${a.id}` }, now);
  }
  // Q1 (ISA-2b item 5): after a take over the taker gets the card and the deadline; a different owner is told AI care ended
  if (target.takerUserId !== null && target.primary === target.takerUserId && a.ownerUserId !== target.takerUserId) {
    await notifyUser(tx, ids, { userId: a.ownerUserId, kind: 'ai_isa_ended', priority: 'normal', title: `AI care ended: ${label} was taken over`.slice(0, 120), body: null,
      subjectType: 'contact', subjectId: target.contactId, dedupeKey: `ai_isa_ended:${a.id}` }, now);
  }
  await audit(tx, actor, { action: 'ai_isa.handoff_created', entity: { type: 'ai_isa_handoff', id: handoffId }, reason: h.reason });
  if (i.confirmationNotQueued && !i.pendingMessageId) {
    await confirmationNotSentInTx(tx, ids, { id: handoffId, assignmentId: a.id, contactId: target.contactId, recipientUserId: target.primary }, 'not_sent', now);
  }
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

/** Why a handoff is done (b12 recheck R13): the audit reason of closeHandoffInTx, stored as closed_reason (R19, 0081). */
export type HandoffCloseReason = (typeof HANDOFF_CLOSE_REASONS)[number];

/**
 * b12 recheck R13: a handoff that is done closes. Its pinned card closes (every open card of its action, whoever holds
 * it; resolved_by NULL, the "handled by its module" close that is final for the key, b12 recheck R22) and its
 * still-proposed action is executed, by the system (a person decides an action only as themselves, 0018; `executed` is
 * what an internal action takes once handled). Done means: a human touch met the deadline (the sweep, in its
 * transaction), "Got it" on a handoff no touch can ever meet (sla_class 'none'), the lead was closed by a person (the
 * sweep: a closed lead takes no touch), AI care restarted on the person after a human touch since the handoff
 * (startCare; a restart alone never ends it, b12 recheck R16), or the owner's "Continue AI care" decided the
 * continued-from assignment's own handoff (startCare with continueCare's handoff, care_continued; b12 recheck R23).
 * The handoff's stored close (closed_at, closed_reason; 0081, b12 recheck R19) marks it done for the sweep, the panel,
 * the list and the Admin count, so its deadline never alerts afterwards. b12 recheck R21: the close keys on that marker, not on the action: a handoff whose card a person
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
export async function slaSweepInTx(tx: Tx, ids: IdGenerator, now: Instant, actor: SystemActor, o: { alerts?: AlertSink; log?: Logger } = {}): Promise<{ met: number; escalated: number; closed: number; failed: number }> {
  let met = 0;
  let escalated = 0;
  let closed = 0;
  let failed = 0;
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
  // b12 recheck R24: a row whose work failed on an earlier pass sorts after every other (sweep_failure_count), so failing
  // rows never fill the 200 ahead of a healthy one
  const rows = await sql<SweepRow>`
    SELECT s.* FROM (
      SELECT h.id, h.assistant_action_id AS action_id, c.id AS contact_id, c.ownership_state = 'closed' AS lead_closed, h.created_at, h.sla_due_at, h.sla_escalation_level, h.sweep_failure_count,
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
     ORDER BY s.sweep_failure_count > 0, s.sla_due_at, s.id LIMIT ${AI_ISA_SWEEP_ROWS_PER_PASS}`.execute(tx);
  const failures: { id: string; error: string }[] = [];
  for (const r of rows.rows) {
    // b12 recheck R24: each row's work runs in its own savepoint. A row whose work fails (a close a guard keeps
    // refusing, say) is rolled back alone, counted and reported, and the pass goes on: before, one such row aborted the
    // tenant's whole sweep on every pass, and R20's retry re-read exactly that row each time
    await sql`SAVEPOINT ai_isa_sla_row`.execute(tx);
    let done: 'met' | 'closed' | 'escalated' | null;
    try {
      done = await sweepRowInTx(tx, ids, now, actor, r);
    } catch (err) {
      await sql`ROLLBACK TO SAVEPOINT ai_isa_sla_row`.execute(tx);
      await sql`RELEASE SAVEPOINT ai_isa_sla_row`.execute(tx);
      failed += 1;
      failures.push({ id: r.id, error: sqlstateOf(err) });
      continue;
    }
    await sql`RELEASE SAVEPOINT ai_isa_sla_row`.execute(tx);
    if (done === 'met') met += 1;
    else if (done === 'closed') closed += 1;
    else if (done === 'escalated') escalated += 1;
  }
  // batch 13 (b12 recheck R24 follow-up): the pass's failures are counted together, in ONE savepoint, after the rows
  if (failures.length > 0) {
    await slaSweepTestHooks.beforeFailureCount?.(failures.map((f) => f.id));
    await sweepFailedInTx(tx, actor, failures, now, o);
  }
  return { met, escalated, closed, failed };
}

/**
 * batch 13 (b12 recheck R24 follow-up): the rows one deadline pass reads. Every row's work runs in a savepoint, and a
 * savepoint that writes holds a subtransaction id until the pass commits; past 64 of them (PGPROC_MAX_CACHED_SUBXIDS)
 * Postgres's subxid cache overflows and every other backend's snapshot checks fall back to pg_subtrans while the pass
 * is open. 60 rows plus the one savepoint of the failure count stay under it. A backlog drains 60 rows a minute per
 * tenant; R17's read set (only rows with work) and the failed-rows-last order keep every due row reached in turn.
 */
export const AI_ISA_SWEEP_ROWS_PER_PASS = 60;

/** Test seam only (no production caller sets it): runs after the rows, before the pass's failures are counted. */
export const slaSweepTestHooks: { beforeFailureCount?: (handoffIds: string[]) => Promise<void> } = {};

const sqlstateOf = (err: unknown): string => {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : 'ERROR';
};

interface SweepRow {
  id: string;
  action_id: string;
  contact_id: string;
  lead_closed: boolean;
  created_at: Date;
  sla_due_at: Date;
  sla_escalation_level: number;
  sweep_failure_count: number;
  owner_user_id: string | null;
  holder_user_id: string | null;
  previous_user_id: string | null;
  frozen_user_id: string;
  touched: Date | null;
  ack_close: boolean;
  touch_met: boolean;
  escalate: boolean;
}

/** One row of the deadline sweep (slaSweepInTx runs it in a savepoint): what it did, or null. */
async function sweepRowInTx(tx: Tx, ids: IdGenerator, now: Instant, actor: SystemActor, r: SweepRow): Promise<'met' | 'closed' | 'escalated' | null> {
  if (r.ack_close) return (await closeHandoffInTx(tx, actor, { id: r.id, actionId: r.action_id }, 'acknowledged', now)) ? 'closed' : null;
  if (r.touch_met) {
    await sql`UPDATE ai_isa_handoffs SET sla_met_at = ${r.touched} WHERE tenant_id = app.tenant_id() AND id = ${r.id}`.execute(tx);
    await closeHandoffInTx(tx, actor, { id: r.id, actionId: r.action_id }, 'deadline_met', now);
    return 'met';
  }
  // b12 recheck R13: a touch is recorded only on an owned lead, so a closed lead's deadline can never be met: the
  // handoff is done (its card closes, its action is executed), and nothing alerts; the deadline is not recorded as met.
  // b12 recheck R21: a handoff whose card was decided is marked done here too (once), so it is not read again
  if (r.lead_closed) return (await closeHandoffInTx(tx, actor, { id: r.id, actionId: r.action_id }, 'lead_closed', now)) ? 'closed' : null;
  // level 1 at the deadline; level 2 one more deadline-length later (the read set's `escalate`)
  if (!r.escalate) return null;
  const level = r.sla_escalation_level + 1;
  const targets = await overdueTargets(tx, { owner: r.owner_user_id, holder: r.holder_user_id, previous: r.previous_user_id, frozen: r.frozen_user_id }, level);
  const label = (await contactLabel(tx, r.contact_id)) ?? 'A lead';
  for (const userId of targets) {
    await notifyUser(tx, ids, { userId, kind: 'ai_isa_handoff_overdue', priority: 'critical', title: `AI handoff not picked up: ${label}`.slice(0, 120), body: null,
      subjectType: 'contact', subjectId: r.contact_id, dedupeKey: `ai_isa_overdue:${r.id}:${level}` }, now);
  }
  await sql`UPDATE ai_isa_handoffs SET sla_escalated_at = ${new Date(now)}, sla_escalation_level = ${level} WHERE tenant_id = app.tenant_id() AND id = ${r.id}`.execute(tx);
  return 'escalated';
}

/**
 * b12 recheck R24: after this many failed passes on one handoff the sweep raises a P2 alert naming it (once). The count
 * is a total over the handoff's life, never reset by a pass that succeeds (OPERATIONS §4.17 says "in 3 passes in
 * total"); whether to reset it, and whether to repeat the alert while the row keeps failing, is an owner question.
 */
export const AI_ISA_SWEEP_ALERT_AFTER = 3;

/** batch 13: when the failure count itself cannot be written, at most one P2 per tenant per this long (per process). */
export const AI_ISA_SWEEP_COUNT_ALERT_EVERY_MS = 3_600_000;
const countAlertAt = new Map<string, number>();
/** Test seam: forget the per-tenant throttle of the count-unwritable alert. */
export const resetSweepAlertThrottle = (): void => countAlertAt.clear();

/**
 * b12 recheck R24: the rows the deadline sweep failed on in this pass. Their failed passes are counted on the handoff
 * (ai_isa_handoffs.sweep_failure_count, system-only, 0081) by ONE update in a savepoint of its own (batch 13: one
 * subtransaction per pass, not one per failed row); each failure is logged (AI_ISA_HANDOFF_SWEEP_FAILED, the handoff
 * id, the count and the SQLSTATE only), and a row whose count reaches AI_ISA_SWEEP_ALERT_AFTER raises one P2
 * `WORKER_ERROR` (reason AI_ISA_HANDOFF_SWEEP_FAILING; OPERATIONS §4.17), so a poisoned row is surfaced rather than
 * retried silently forever. batch 13 (b12 recheck R24 follow-up):
 * - a handoff the count no longer finds (erased, cascaded away after the read) is gone, not failing: logged only;
 * - when the count cannot be written at all, ONE P2 for the pass (reason AI_ISA_HANDOFF_SWEEP_COUNT_UNWRITABLE, the
 *   number of rows and up to 10 ids), at most once an hour per tenant, never one per row per minute.
 */
async function sweepFailedInTx(tx: Tx, actor: SystemActor, failed: { id: string; error: string }[], now: Instant, o: { alerts?: AlertSink; log?: Logger }): Promise<void> {
  const ids = failed.map((f) => f.id);
  let counted: Map<string, number> | null = null;
  await sql`SAVEPOINT ai_isa_sla_count`.execute(tx);
  try {
    const u = await sql<{ id: string; n: number }>`UPDATE ai_isa_handoffs SET sweep_failure_count = sweep_failure_count + 1
      WHERE tenant_id = app.tenant_id() AND id = ANY (${ids}::uuid[]) RETURNING id, sweep_failure_count AS n`.execute(tx);
    counted = new Map(u.rows.map((x) => [x.id, x.n]));
    await sql`RELEASE SAVEPOINT ai_isa_sla_count`.execute(tx);
  } catch {
    await sql`ROLLBACK TO SAVEPOINT ai_isa_sla_count`.execute(tx);
    await sql`RELEASE SAVEPOINT ai_isa_sla_count`.execute(tx);
  }
  for (const f of failed) {
    const failures = counted === null ? null : (counted.get(f.id) ?? null);
    if (counted !== null && failures === null) {
      o.log?.info('AI handoff the deadline sweep failed on is gone (erased after the read); nothing to alert', { errorCode: 'AI_ISA_HANDOFF_SWEEP_GONE', details: { handoffId: f.id, error: f.error } });
      continue;
    }
    o.log?.warn('AI handoff deadline sweep failed on one handoff; the pass went on', { errorCode: 'AI_ISA_HANDOFF_SWEEP_FAILED', details: { handoffId: f.id, failures, error: f.error } });
    if (failures === AI_ISA_SWEEP_ALERT_AFTER) {
      o.alerts?.raise({ severity: 'P2', code: 'WORKER_ERROR', tenantId: actor.tenantId, details: { reason: 'AI_ISA_HANDOFF_SWEEP_FAILING', handoffId: f.id, failures, error: f.error } });
    }
  }
  if (counted === null) {
    const last = countAlertAt.get(actor.tenantId);
    if (last === undefined || now - last >= AI_ISA_SWEEP_COUNT_ALERT_EVERY_MS) {
      countAlertAt.set(actor.tenantId, now);
      o.alerts?.raise({ severity: 'P2', code: 'WORKER_ERROR', tenantId: actor.tenantId, details: { reason: 'AI_ISA_HANDOFF_SWEEP_COUNT_UNWRITABLE', rows: failed.length, handoffIds: ids.slice(0, 10).join(','), error: failed[0]!.error } });
    }
  }
}

/**
 * Item 9 (R-ISA-14; E533): the post-handoff confirmation did not go out. `not_sent` (canceled by a non-acknowledgement
 * inbound, failed, undelivered, blocked, or late): the card becomes critical (score 98, AI_ISA_CONFIRMATION_NOT_SENT),
 * an `ai_isa_handoff_hot` notification, and the deadline is pulled in to 15 minutes. When D1 leaves the person no text,
 * call or email, a hand confirmation is impossible: the card says so (AI_ISA_CONFIRMATION_NOT_SENT_UNREACHABLE, keep or
 * cancel the appointment), the notification reads "Appointment not confirmed", and no deadline is set or pulled in; a
 * handoff with no deadline (sla_class 'none') never gets one (b13 integration). `closed` (ISA_HANDOFF_CLOSED: a person
 * reached them first): the card says so, nothing hot. Codes only; never message content.
 */
export async function confirmationNotSentInTx(tx: Tx, ids: IdGenerator, h: { id: string; assignmentId: string; contactId: string; recipientUserId: string | null }, kind: 'not_sent' | 'closed', now: Instant): Promise<void> {
  const label = (await contactLabel(tx, h.contactId)) ?? 'A lead';
  if (kind === 'closed') {
    await sql`UPDATE priority_feed_items SET reasons = ${JSON.stringify([{ code: 'AI_ISA_CONFIRMATION_NOT_NEEDED', text: 'Someone on the team reached them first, so the AI confirmation was not sent.' }])}::jsonb,
        updated_at = now() WHERE tenant_id = app.tenant_id() AND dedupe_key = ${`ai_isa_handoff:${h.assignmentId}`} AND state IN ('open','snoozed')`.execute(tx);
    return;
  }
  // b13 integration: ask for a hand confirmation only when one is possible. D1 (sending checks only opt-outs) can leave
  // the person no text, call or email (a person-level do-not-contact, or every channel opted out); then the card says so
  // and asks to keep or cancel the appointment. A handoff with no deadline (sla_class 'none', 0081) never gets one here.
  const reach = await humanReachable(tx, h.contactId);
  const ho = (await sql<{ sla_class: string }>`SELECT sla_class FROM ai_isa_handoffs WHERE tenant_id = app.tenant_id() AND id = ${h.id}`.execute(tx)).rows[0];
  const deadline = reach.any && ho?.sla_class !== 'none';
  const due = new Date(now + ISA_SLA_MINUTES.critical * 60_000);
  if (deadline) await sql`UPDATE ai_isa_handoffs SET sla_due_at = least(sla_due_at, ${due}) WHERE tenant_id = app.tenant_id() AND id = ${h.id} AND sla_met_at IS NULL`.execute(tx);
  const reason = reach.any
    ? { code: 'AI_ISA_CONFIRMATION_NOT_SENT', text: 'The appointment confirmation was not sent: confirm it by hand.' }
    // b14 to-do (b13 final low): says why none is left (no contact details when every point was removed), never assumes an opt-out
    : { code: 'AI_ISA_CONFIRMATION_NOT_SENT_UNREACHABLE', text: `The appointment confirmation was not sent, and no text, call or email can reach them now (${UNREACHABLE_WHY_WORDS[reach.why ?? 'opted_out']}), so it cannot be confirmed by hand: keep or cancel the appointment.` };
  await sql`UPDATE priority_feed_items SET score = 98, band = 'pinned', due_at = CASE WHEN ${deadline} THEN least(COALESCE(due_at, ${due}), ${due}) ELSE due_at END,
      reasons = ${JSON.stringify([reason])}::jsonb, updated_at = now()
    WHERE tenant_id = app.tenant_id() AND dedupe_key = ${`ai_isa_handoff:${h.assignmentId}`} AND state IN ('open','snoozed')`.execute(tx);
  const targets = h.recipientUserId ? [h.recipientUserId] : await adminUserIds(tx);
  const title = reach.any ? `Confirm the appointment: ${label}` : `Appointment not confirmed: ${label}`;
  for (const userId of targets) {
    await notifyUser(tx, ids, { userId, kind: 'ai_isa_handoff_hot', priority: 'critical', title: title.slice(0, 120), body: null,
      subjectType: 'contact', subjectId: h.contactId, dedupeKey: `ai_isa_confirmation_not_sent:${h.id}` }, now);
  }
}
