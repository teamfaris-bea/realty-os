// The `ai_isa.book` job and TX-C (ISA-2b item 9, D8c; R-ISA-13, -14, -15; E523, E528, E529, E531, E532, E533;
// docs/AI_ISA.md §3.7, §4.6 item 4). Standalone, two transactions:
//
//   tx#1 (system; lock 5 FIRST, then the offer row FOR UPDATE, nothing of locks 2–4):
//        1. lockPersonBookings(organizer); the offer FOR UPDATE, of the payload's assignment. Accepted with an
//           appointment, or refused: a replay, straight to TX-C.
//        2. the assignment and the chain, unlocked: ended, a stop signal or a block since start, or a chain `end` →
//           CARE_NOT_LIVE; paused at this read → CARE_PAUSED; a hold → CONFIRMATION_ON_HOLD.
//        3. expires_at ≤ now → OFFER_EXPIRED; confirmationInTime with the caps-aware nextSendAt → CONFIRMATION_TOO_LATE
//           (core's row 10 skips both checks: an ISA-1 follow-up the API compensates for here).
//        4. an open appointment of the person, read under lock 5 → APPOINTMENT_ALREADY_SET (one per person per
//           organizer; across organizers the residual is stated in DATA_MODEL R-ISA-13).
//        5. bookSlotInTx with requireLiveCalendar, the offer's link and the policy buffer (the live read under lock 5).
//        6. accepted with the appointment (unique), audited ai_isa.slot_booked; or refused with its code, audited
//           ai_isa.booking_refused.
//   TX-C (locks 2 → 3 → 4; trigger `booking`): step(booking_result). Codes core lacks go as CALENDAR_UNAVAILABLE
//        (booking_unavailable), the honest code kept on the row and the turn. Booked and live: end appointment_booked,
//        the confirmation the handoff's pending message (E528). Booked but paused after step 2 (E523): end with no
//        confirmation, notes BOOKED_WHILE_PAUSED and CONFIRMATION_NOT_SENT. Booked after care ended: the handoff is
//        frozen, so a separate critical card. Booked but the machine did not hold the offer as accepting, or held it
//        and did not end on the result: a system pause (check_this) and the same card. AI care is never live after a
//        booking.
import type { Instant, SystemActor, TenantId } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../../audit.js';
import { contactLabel, notifyUser, upsertFeedItem } from '../../comms/repos/notify.js';
import { lockPersonBookings } from '../../calendar/repos/links.js';
import { bookSlotInTx, type CalendarDeps } from '../../calendar/service.js';
import { systemActor } from '../../worker/systemActor.js';
import { confirmationInTime, formatSlot, type IsaSlot, step } from '../coreSeam.js';
import { applyActionsInTx, chainEnvOf, contextFor, ensureTurn, type IsaDeps } from '../effects.js';
import { recipientFor } from '../handoff.js';
import { activeBlock, assignmentById, evaluateChain, lockForTurn, stopSignalSince } from '../repo.js';
import { nextSendAtInTx, offerById, type OfferRow, openAppointmentOf } from './rows.js';

export type BookJobDeps = IsaDeps & Pick<CalendarDeps, 'envelope' | 'adapters' | 'now'>;

export interface BookPayload {
  assignmentId: string;
  offerId: string;
}

export type BookRefusal = 'CARE_NOT_LIVE' | 'CARE_PAUSED' | 'CONFIRMATION_ON_HOLD' | 'OFFER_EXPIRED' | 'CONFIRMATION_TOO_LATE' | 'APPOINTMENT_ALREADY_SET'
  | 'SLOT_TAKEN' | 'SLOT_SOURCE_CHANGED' | 'CALENDAR_UNAVAILABLE' | 'MEMBER_NOT_ACTIVE' | 'SLOT_INVALID';

/** The booking_result codes core's machine knows; everything else goes as CALENDAR_UNAVAILABLE (an ISA-1 follow-up). */
const CORE_CODES = new Set(['SLOT_TAKEN', 'SLOT_SOURCE_CHANGED', 'CALENDAR_UNAVAILABLE', 'MEMBER_NOT_ACTIVE']);

/** Test seam only (no production caller sets it): runs after tx#1's care read, while lock 5 is held. */
export const bookTestHooks: { afterCareRead?: (offerId: string) => Promise<void> } = {};

const actorOf = (tenantId: string): SystemActor => systemActor(tenantId as TenantId, 'assistant');

/** The 1-based accepted slot of a row (the CHECK), as the slot itself. */
export const acceptedSlotOf = (o: Pick<OfferRow, 'slots' | 'acceptedSlot'>): IsaSlot | null => (o.acceptedSlot === null ? null : (o.slots[o.acceptedSlot - 1] ?? null));

/** tx#1. Returns the offer's final status (accepted / refused / skipped). */
async function tx1(deps: BookJobDeps, tenantId: string, p: BookPayload): Promise<{ kind: 'skip' } | { kind: 'done'; readAt: Instant }> {
  return withTenantTx(actorOf(tenantId), async (tx, now) => {
    const peek = await offerById(tx, p.offerId);
    if (peek === null || peek.assignmentId !== p.assignmentId) return { kind: 'skip' as const };
    // 1. lock 5 first (the organizer's booking lock), then the offer row
    await lockPersonBookings(tx, peek.organizerUserId);
    const o = (await offerById(tx, p.offerId, 'update'))!;
    if ((o.status === 'accepted' && o.appointmentId !== null) || o.status === 'refused') return { kind: 'done' as const, readAt: o.updatedAt };
    if (o.status !== 'accepting') return { kind: 'skip' as const };
    const refuse = async (code: BookRefusal): Promise<{ kind: 'done'; readAt: Instant }> => {
      await sql`UPDATE ai_isa_slot_offers SET status = 'refused', refusal_code = ${code} WHERE tenant_id = app.tenant_id() AND id = ${o.id}`.execute(tx);
      await audit(tx, actorOf(tenantId), { action: 'ai_isa.booking_refused', entity: { type: 'ai_isa_slot_offer', id: o.id }, reason: code });
      return { kind: 'done', readAt: now };
    };
    // 2. care, unlocked (a control commits at once: the job holds no ISA lock)
    const a = await assignmentById(tx, o.assignmentId);
    if (a === null) return refuse('CARE_NOT_LIVE');
    // b12 review db-isa-merge-1: every unlifted block of the person, whenever it was written (repo.ts activeBlock, 0081)
    const blocked = (await activeBlock(tx, a.contactId)) !== null;
    const chain = await evaluateChain(tx, a, chainEnvOf(deps));
    if (a.endedAt !== null || blocked || (await stopSignalSince(tx, a)) !== null || chain.effect === 'end') return refuse('CARE_NOT_LIVE');
    if (a.pausedAt !== null || chain.effect === 'pause') return refuse('CARE_PAUSED');
    if (chain.effect === 'hold') return refuse('CONFIRMATION_ON_HOLD');
    if (bookTestHooks.afterCareRead) await bookTestHooks.afterCareRead(o.id);
    // 3. the offer's expiry and the confirmation's timing (caps included)
    const slot = acceptedSlotOf(o);
    if (slot === null) return refuse('SLOT_INVALID');
    if (o.expiresAt <= now) return refuse('OFFER_EXPIRED');
    const ctx = await contextFor(tx, a, now);
    const next = await nextSendAtInTx(tx, { contactId: a.contactId, zones: ctx.zones, content: ctx.content, now });
    if (!confirmationInTime({ slot, nextSendAt: next, minNoticeHours: ctx.content.booking.minNoticeHours })) return refuse('CONFIRMATION_TOO_LATE');
    // 4. one open appointment per person (under the organizer's lock)
    if ((await openAppointmentOf(tx, a.contactId)) !== null) return refuse('APPOINTMENT_ALREADY_SET');
    // 5. the booking, with a live read on the offer's link under lock 5
    const res = await bookSlotInTx(tx, deps, tenantId, { userId: o.organizerUserId, contactId: a.contactId, kind: o.kind, startsAt: new Date(slot.startsAt).toISOString(),
      endsAt: new Date(slot.endsAt).toISOString(), createdByKind: 'assistant' }, { requireLiveCalendar: true, expectLinkId: o.availabilityLinkId, bufferMinutes: ctx.content.booking.bufferMinutes });
    if (!res.ok) return refuse(res.code);
    // 6. accepted (appointment_id unique, 0190)
    await sql`UPDATE ai_isa_slot_offers SET status = 'accepted', appointment_id = ${res.appointmentId} WHERE tenant_id = app.tenant_id() AND id = ${o.id}`.execute(tx);
    await audit(tx, actorOf(tenantId), { action: 'ai_isa.slot_booked', entity: { type: 'ai_isa_slot_offer', id: o.id }, reason: 'BOOKED' });
    return { kind: 'done' as const, readAt: now };
  }, { db: deps.db, retries: 0 });
}

/** A critical card for a booking care could not hand back normally (the handoff is frozen or care did not end). */
async function bookedCardInTx(tx: Tx, deps: IsaDeps, a: { id: string; contactId: string; ownerUserId: string }, o: OfferRow, code: string, now: Instant): Promise<void> {
  const slot = acceptedSlotOf(o);
  const when = slot ? formatSlot(slot, o.zones[0]!) : 'the agreed time';
  const label = (await contactLabel(tx, a.contactId)) ?? 'A lead';
  // b12 review F1: the card goes where the handoff would (the root survivor's record and its recipient; recipientFor)
  const rec = await recipientFor(tx, a);
  for (const userId of rec.primary ? [rec.primary] : rec.escalation) {
    await upsertFeedItem(tx, deps.ids, { userId, itemType: 'ai_isa_escalation', band: 'pinned', contactId: rec.contactId, subjectType: 'ai_isa_assignment', subjectId: a.id,
      assistantActionId: null, score: 98, reasons: [{ code, text: `Booked ${when} after AI care ended; the confirmation was not sent: confirm or cancel it yourself.`.slice(0, 200) }],
      dedupeKey: `ai_isa_booked:${o.id}` });
    await notifyUser(tx, deps.ids, { userId, kind: 'ai_isa_handoff_hot', priority: 'critical', title: `Appointment needs you: ${label}`.slice(0, 120), body: null,
      subjectType: 'contact', subjectId: rec.contactId, dedupeKey: `ai_isa_booked:${o.id}` }, now);
  }
}

/**
 * The package's appointment detail (ids, codes, times and the verified quote only). minNoticeHours is the notice of the
 * policy the booking ran under (tx#1's confirmationInTime used it): the CONFIRMATION_LATE sweep reads it from here,
 * not core's default (batch 13 audit ISA2B-14).
 */
function appointmentDetail(o: OfferRow, readAt: Instant, minNoticeHours: number): Record<string, unknown> {
  const slot = acceptedSlotOf(o);
  return {
    appointmentId: o.appointmentId, kind: o.kind, startsAt: slot ? new Date(slot.startsAt).toISOString() : null, endsAt: slot ? new Date(slot.endsAt).toISOString() : null,
    organizerUserId: o.organizerUserId, offerId: o.id, acceptedMessageId: o.acceptedMessageId, acceptedQuote: o.acceptedQuote, linkId: o.availabilityLinkId,
    calendarReadAt: new Date(readAt).toISOString(), calendarSentence: `Your calendar showed this time free at ${new Date(readAt).toISOString()}`, zones: o.zones,
    minNoticeHours,
  };
}

/** TX-C. Returns an outcome code. */
export async function txC(deps: BookJobDeps, tenantId: string, offerId: string, readAt: Instant | null): Promise<string> {
  return withTenantTx(actorOf(tenantId), async (tx, now) => {
    const peek = await offerById(tx, offerId);
    if (peek === null) return 'NO_OFFER';
    const pa = await assignmentById(tx, peek.assignmentId);
    if (pa === null) return 'NO_ASSIGNMENT';
    await lockForTurn(tx, pa.contactId, pa.id);
    const a = (await assignmentById(tx, pa.id, 'update'))!;
    const o = (await offerById(tx, offerId))!;
    if (o.status !== 'accepted' && o.status !== 'refused') return 'NOT_DECIDED';
    const booked = o.status === 'accepted' && o.appointmentId !== null;
    const read = readAt ?? o.updatedAt;
    const machineAccepting = a.machine.offer !== null && a.machine.offer.id === o.id && a.machine.offer.status === 'accepting';
    if (a.endedAt !== null) {
      if (booked) await bookedCardInTx(tx, deps, a, o, 'AI_ISA_BOOKED_AFTER_END', now);
      return booked ? 'BOOKED_AFTER_END' : 'ENDED';
    }
    const ctx = await contextFor(tx, a, now);
    const turn = await ensureTurn(tx, deps.ids, ctx, { triggerKind: 'booking', triggerKey: `booking:${o.id}`, pinnedSeq: a.lastInboundSeq, status: 'no_reply' });
    await sql`UPDATE ai_isa_turns SET decision = ${JSON.stringify({ code: booked ? 'BOOKED' : o.refusalCode ?? 'REFUSED' })}::jsonb WHERE tenant_id = app.tenant_id() AND id = ${turn.id}`.execute(tx);
    const pausedNotes = a.pausedAt !== null ? ['BOOKED_WHILE_PAUSED', 'CONFIRMATION_NOT_SENT'] : [];
    const env = { tx, deps, actor: actorOf(tenantId), ctx, now, turnId: turn.id, pinnedSeq: a.lastInboundSeq,
      handoffExtra: booked ? { appointmentDetail: appointmentDetail(o, read, ctx.content.booking.minNoticeHours), notes: pausedNotes } : undefined };
    // AI care is never live after a booking (item 9): a system pause (check_this) that cancels anything queued, unless
    // care is already paused or ended
    const pauseAfterBooking = async (machine: typeof a.machine): Promise<void> => {
      if (machine.paused !== null || machine.ended !== null) return;
      const r = step(machine, { type: 'authorization_lost', at: now, effect: 'pause', pauseReason: 'check_this' }, ctx.facts);
      await applyActionsInTx(env, { state: r.state, actions: [{ kind: 'pause', reason: 'check_this' }, { kind: 'cancel_messages' }] });
    };
    if (!machineAccepting) {
      if (!booked) return 'STALE_RESULT';
      // the machine did not hold this offer as accepting: care must not stay live after a booking
      if (a.pausedAt === null) await pauseAfterBooking(a.machine);
      await bookedCardInTx(tx, deps, a, o, 'AI_ISA_BOOKED_NOT_HANDED_BACK', now);
      return 'BOOKED_PAUSED_CARD';
    }
    const code = o.refusalCode ?? 'CALENDAR_UNAVAILABLE';
    const r = booked
      ? step(a.machine, { type: 'booking_result', at: now, ok: true, appointmentId: o.appointmentId! }, ctx.facts)
      : step(a.machine, { type: 'booking_result', at: now, ok: false, code: (CORE_CODES.has(code) ? code : 'CALENDAR_UNAVAILABLE') as 'CALENDAR_UNAVAILABLE' }, ctx.facts);
    const out = await applyActionsInTx(env, r);
    if (booked && !out.ended) {
      // never live after a booking (defence in depth; core ends on an accepting offer): the same system pause as above,
      // then the card (batch 13 audit ISA2B-13: before, this branch wrote the card and left care live)
      await pauseAfterBooking(r.state);
      await bookedCardInTx(tx, deps, a, o, 'AI_ISA_BOOKED_NOT_HANDED_BACK', now);
      return 'BOOKED_NOT_ENDED';
    }
    return booked ? (pausedNotes.length > 0 ? 'BOOKED_WHILE_PAUSED' : 'BOOKED') : `REFUSED:${code}`;
  }, { db: deps.db, retries: 2 });
}

/** The job body: tx#1, then TX-C. */
export async function runBookJob(deps: BookJobDeps, tenantId: string, p: BookPayload): Promise<string> {
  const r = await tx1(deps, tenantId, p);
  if (r.kind === 'skip') return 'SKIPPED';
  return txC(deps, tenantId, p.offerId, r.readAt);
}
