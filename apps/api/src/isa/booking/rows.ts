// Data access of the AI ISA booking path (ISA-2b items 8–9; R-ISA-13; docs/AI_ISA.md §4.6, §8.2). Every read runs
// in the caller's transaction under RLS (the system actor). No provider call here.
import type { IanaZone, Instant } from '@realty/core/foundation';
import { instantFromDate } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { type AiIsaContent, aiIsaSendWindow, clientOwnText, type IsaSlot, type IsaState } from '../coreSeam.js';
import { nextSendAt } from './windows.js';

export interface OfferRow {
  id: string;
  assignmentId: string;
  contactId: string;
  organizerUserId: string;
  kind: 'buyer_consult' | 'listing_appointment' | 'consult';
  slots: IsaSlot[];
  zones: IanaZone[];
  availabilityLinkId: string;
  readAt: Instant;
  expiresAt: Instant;
  offeredMessageId: string | null;
  status: 'pending_delivery' | 'offered' | 'accepting' | 'accepted' | 'expired' | 'superseded' | 'refused';
  /** 1-based (the CHECK); the machine's acceptedIndex is 0-based */
  acceptedSlot: number | null;
  acceptedMessageId: string | null;
  acceptedQuote: string | null;
  appointmentId: string | null;
  refusalCode: string | null;
  updatedAt: Instant;
}

const COLS = sql`id, assignment_id, contact_id, organizer_user_id, kind, slots, zones, availability_link_id, read_at, expires_at, offered_message_id, status,
  accepted_slot, accepted_message_id, accepted_quote, appointment_id, refusal_code, updated_at`;

function rowOf(r: Record<string, unknown>): OfferRow {
  return {
    id: r.id as string, assignmentId: r.assignment_id as string, contactId: r.contact_id as string, organizerUserId: r.organizer_user_id as string,
    kind: r.kind as OfferRow['kind'], slots: (r.slots as IsaSlot[]), zones: r.zones as IanaZone[], availabilityLinkId: r.availability_link_id as string,
    readAt: instantFromDate(r.read_at as Date), expiresAt: instantFromDate(r.expires_at as Date), offeredMessageId: (r.offered_message_id as string | null) ?? null,
    status: r.status as OfferRow['status'], acceptedSlot: (r.accepted_slot as number | null) ?? null, acceptedMessageId: (r.accepted_message_id as string | null) ?? null,
    acceptedQuote: (r.accepted_quote as string | null) ?? null, appointmentId: (r.appointment_id as string | null) ?? null, refusalCode: (r.refusal_code as string | null) ?? null,
    updatedAt: instantFromDate(r.updated_at as Date),
  };
}

export async function offerById(tx: Tx, id: string, lock: 'update' | null = null): Promise<OfferRow | null> {
  const r = await sql<Record<string, unknown>>`SELECT ${COLS} FROM ai_isa_slot_offers WHERE tenant_id = app.tenant_id() AND id = ${id}${lock === 'update' ? sql` FOR UPDATE` : sql``}`.execute(tx);
  return r.rows[0] ? rowOf(r.rows[0]) : null;
}

/** The assignment's live offer row (pending_delivery, offered or accepting; at most one, 0190's partial unique). */
export async function liveOfferOf(tx: Tx, assignmentId: string): Promise<OfferRow | null> {
  const r = await sql<Record<string, unknown>>`SELECT ${COLS} FROM ai_isa_slot_offers WHERE tenant_id = app.tenant_id() AND assignment_id = ${assignmentId}
    AND status IN ('pending_delivery','offered','accepting') LIMIT 1`.execute(tx);
  return r.rows[0] ? rowOf(r.rows[0]) : null;
}

/** Slots stored as {startsAt, endsAt} epoch milliseconds (the core IsaSlot shape). */
export const slotsJson = (slots: readonly IsaSlot[]) => JSON.stringify(slots.map((s) => ({ startsAt: s.startsAt, endsAt: s.endsAt })));

/**
 * The one reconcile (item 8): pending_delivery and offered rows follow the machine. A row the machine no longer holds
 * becomes `expired` (past expires_at) or `superseded`; an `offered` machine offer moves its row to offered. Accepting,
 * accepted and refused rows are never touched here (the book job owns them).
 */
export async function reconcileOfferRowsInTx(tx: Tx, assignmentId: string, s: IsaState): Promise<void> {
  const o = s.offer;
  const keepId = o !== null && (o.status === 'pending_delivery' || o.status === 'offered' || o.status === 'accepting') ? o.id : null;
  await sql`UPDATE ai_isa_slot_offers SET status = CASE WHEN expires_at <= now() THEN 'expired' ELSE 'superseded' END
    WHERE tenant_id = app.tenant_id() AND assignment_id = ${assignmentId} AND status IN ('pending_delivery','offered')
      ${keepId ? sql`AND id <> ${keepId}` : sql``}`.execute(tx);
  if (o !== null && o.status === 'offered') {
    await sql`UPDATE ai_isa_slot_offers SET status = 'offered' WHERE tenant_id = app.tenant_id() AND id = ${o.id} AND status = 'pending_delivery'`.execute(tx);
  }
}

/** Whether the owner has a connected or degraded calendar link (a DB read only: calendarLive for decideAction). */
export async function calendarLiveInTx(tx: Tx, userId: string): Promise<boolean> {
  const r = await sql<{ ok: boolean }>`SELECT EXISTS (SELECT 1 FROM user_calendar_links WHERE tenant_id = app.tenant_id() AND user_id = ${userId}
    AND status IN ('connected','degraded')) AS ok`.execute(tx);
  return r.rows[0]!.ok;
}

/** Q3: the person's open (scheduled or held, not yet over) appointment on any of their records, or null. */
export async function openAppointmentOf(tx: Tx, contactId: string): Promise<{ id: string; startsAt: Instant } | null> {
  const r = await sql<{ id: string; starts_at: Date }>`SELECT id, starts_at FROM appointments WHERE tenant_id = app.tenant_id()
    AND contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${contactId}::uuid)) AND status IN ('scheduled','held') AND ends_at > now()
    ORDER BY starts_at LIMIT 1`.execute(tx);
  return r.rows[0] ? { id: r.rows[0].id, startsAt: instantFromDate(r.rows[0].starts_at) } : null;
}

/**
 * When a confirmation queued now could be dispatched (confirmationInTime's nextSendAt): the first instant at which the
 * person's rolling AI and automated 24 h counts are below the caps, the minimum gap since the last AI outbound has
 * passed, and the reply window is open over the zone set at that very instant (R-ISA-13: caps in
 * confirmationInTime; an ISA-1 follow-up for core; batch 13 audit ISA2B-02: not the window at `now`).
 */
export async function nextSendAtInTx(tx: Tx, i: { contactId: string; zones: readonly IanaZone[]; content: AiIsaContent; now: Instant }): Promise<Instant | null> {
  const r = await sql<{ at: Date; ai: boolean }>`SELECT m.dispatched_at AS at,
      (m.initiator = 'assistant' AND m.action_category IN ('ai_isa_message','ai_isa_confirmation','ai_isa_holding_line')) AS ai
    FROM messages m WHERE m.tenant_id = app.tenant_id() AND m.contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${i.contactId}::uuid))
      AND m.direction = 'outbound' AND m.status IN ('dispatching','dispatch_unknown','sent','delivered','failed','undelivered')
      AND m.dispatched_at >= now() - interval '24 hours'
      AND (m.initiator IN ('assistant','system') OR m.bulk_action_id IS NOT NULL OR m.marketing_piece_id IS NOT NULL)`.execute(tx);
  const ai = r.rows.filter((x) => x.ai).map((x) => instantFromDate(x.at));
  const auto = r.rows.map((x) => instantFromDate(x.at));
  const last = (await sql<{ at: Date | null }>`SELECT max(dispatched_at) AS at FROM messages WHERE tenant_id = app.tenant_id()
    AND contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${i.contactId}::uuid)) AND initiator = 'assistant'
    AND action_category IN ('ai_isa_message','ai_isa_confirmation','ai_isa_holding_line')`.execute(tx)).rows[0]?.at ?? null;
  // the confirmation is a reply (initiated false); the window is read at whatever instant the caps and the gap allow
  const windowAt = (at: Instant) => aiIsaSendWindow({ at, zones: i.zones, startSec: i.content.window.startSec, endSec: i.content.window.endSec, initiated: false,
    initiatedDays: i.content.initiatedDays, noInitiatedOnHolidays: i.content.noInitiatedOnHolidays });
  return nextSendAt({ now: i.now, windowAt, aiSentAt: ai, automatedSentAt: auto, caps: i.content.caps, lastAiOutboundAt: last ? instantFromDate(last) : null });
}

/** The accepting UPDATE of the `book` action (in TX-A or TX-B, under locks 2–4, on an `offered` row only). */
export async function markAcceptingInTx(tx: Tx, i: { offerId: string; assignmentId: string; slotIndex: number; messageId: string }): Promise<boolean> {
  const m = await sql<{ body: string; channel: string }>`SELECT body, channel FROM messages WHERE tenant_id = app.tenant_id() AND id = ${i.messageId}`.execute(tx);
  const quote = m.rows[0] ? clientOwnText(m.rows[0].body, m.rows[0].channel === 'email' ? 'email' : 'sms').text.slice(0, 200) : null;
  const r = await sql<{ id: string }>`UPDATE ai_isa_slot_offers SET status = 'accepting', accepted_slot = ${i.slotIndex + 1}, accepted_message_id = ${i.messageId},
      accepted_quote = ${quote} WHERE tenant_id = app.tenant_id() AND id = ${i.offerId} AND assignment_id = ${i.assignmentId} AND status = 'offered'
      AND expires_at > now() RETURNING id`.execute(tx);
  return r.rows.length === 1;
}
