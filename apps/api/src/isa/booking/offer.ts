// The `ai_isa.offer` job (ISA-2b item 8, D8b; R-ISA-13, R-ISA-4; E531; docs/AI_ISA.md §4.6 items 1–2). Standalone:
//
//   step 1  a short SYSTEM transaction with NO ISA lock and no lock_contact (§3.7): care live and unpaused, the epoch,
//           the machine's offer `requested`, the kind allowed (opt-in ∩ policy); then the owner's live free/busy read
//           (busyForBooking: the only provider call, under no lock). Not connected or degraded → CALENDAR_UNAVAILABLE.
//   step 2  TX-O (locks 2 → 3 → 4 through lockForTurn): the same checks again; Q3 (an open appointment of the person →
//           APPOINTMENT_ALREADY_SET); computeOffer over Q2's windows, the live read ∪ in-app appointments re-read now,
//           the conservative client zone set, the inactivity release and the booking settings (none → NO_FREE_SLOT).
//           A refusal steps `offer_unavailable` (the booking_unavailable holding line; the honest code on the turn).
//           With slots: the offer row (pending_delivery), step(offer_ready), the server-rendered offer queued through
//           queueIsaMessageInTx (dispatchOutbound decides again), and offered_message_id set.
import type { IanaZone, Instant, TenantId } from '@realty/core/foundation';
import { instantFromDate } from '@realty/core/foundation';
import { withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { busyForBooking } from '../../calendar/service.js';
import type { CalendarDeps } from '../../calendar/service.js';
import { busyAppointments } from '../../calendar/repos/links.js';
import { systemActor } from '../../worker/systemActor.js';
import { computeOffer, displayZones, type IsaSlot, step } from '../coreSeam.js';
import { applyActionsInTx, contextFor, ensureTurn, type IsaDeps } from '../effects.js';
import { assignmentById, lockForTurn } from '../repo.js';
import { openAppointmentOf, slotsJson } from './rows.js';
import { hhmmToSec, offerWindows, type OptInWindow } from './windows.js';

export type OfferJobDeps = IsaDeps & Pick<CalendarDeps, 'envelope' | 'adapters' | 'now'>;

export interface OfferPayload {
  assignmentId: string;
  epoch: number;
  kind: 'buyer_consult' | 'listing_appointment' | 'consult';
}

export type OfferRefusal = 'CARE_NOT_LIVE' | 'KIND_NOT_ALLOWED' | 'CALENDAR_UNAVAILABLE' | 'APPOINTMENT_ALREADY_SET' | 'NO_FREE_SLOT' | 'NO_AVAILABILITY';

const actorOf = (tenantId: string) => systemActor(tenantId as TenantId, 'assistant');

interface OptIn {
  timezone: string;
  availability: OptInWindow[];
  kinds: string[];
}

async function optInOf(tx: Parameters<typeof assignmentById>[0], optinId: string): Promise<OptIn> {
  const r = await sql<{ tz: string; av: unknown; booking: { kinds?: string[] } }>`SELECT timezone AS tz, availability AS av, booking FROM ai_isa_agent_optins
    WHERE tenant_id = app.tenant_id() AND id = ${optinId}`.execute(tx);
  const x = r.rows[0];
  return { timezone: x?.tz ?? 'America/New_York', availability: (Array.isArray(x?.av) ? x!.av : []) as OptInWindow[], kinds: x?.booking?.kinds ?? [] };
}

/** opt-in ∩ content[side] (side `both`: either side's kinds). */
function kindAllowed(kind: OfferPayload['kind'], side: string, optKinds: readonly string[], content: { booking: { kinds: { buyer: readonly string[]; seller: readonly string[] } } }): boolean {
  const policy = side === 'buyer' ? content.booking.kinds.buyer : side === 'seller' ? content.booking.kinds.seller : [...content.booking.kinds.buyer, ...content.booking.kinds.seller];
  return policy.includes(kind) && optKinds.includes(kind);
}

/** The job body. Returns the outcome code (for tests and the turn's decision). */
export async function runOfferJob(deps: OfferJobDeps, tenantId: string, p: OfferPayload): Promise<string> {
  // ---- step 1: no ISA lock, no lock_contact; the live read is the only provider call ----
  const pre = await withTenantTx(actorOf(tenantId), async (tx, now) => {
    const a = await assignmentById(tx, p.assignmentId);
    if (a === null || a.endedAt !== null || a.pausedAt !== null || a.epoch !== p.epoch || a.machine.offer?.status !== 'requested') return { kind: 'skip' as const };
    const ctx = await contextFor(tx, a, now);
    const opt = await optInOf(tx, a.optinId);
    if (!kindAllowed(p.kind, a.side, opt.kinds, ctx.content)) return { kind: 'refuse' as const, code: 'KIND_NOT_ALLOWED' as OfferRefusal };
    const horizonEnd = now + (ctx.content.booking.horizonDays + 1) * 86_400_000;
    const read = await busyForBooking(deps, tx, tenantId as TenantId, a.ownerUserId, { start: new Date(now).toISOString(), end: new Date(horizonEnd).toISOString() });
    if ((read.calendar !== 'connected' && read.calendar !== 'degraded') || read.linkId === null) return { kind: 'refuse' as const, code: 'CALENDAR_UNAVAILABLE' as OfferRefusal };
    return { kind: 'read' as const, busy: read.busy, linkId: read.linkId, readAt: now };
  }, { db: deps.db, retries: 2 });
  if (pre.kind === 'skip') return 'SKIPPED';

  // ---- step 2: TX-O (2 → 3 → 4) ----
  return withTenantTx(actorOf(tenantId), async (tx, now) => {
    const peek = await assignmentById(tx, p.assignmentId);
    if (peek === null) return 'SKIPPED';
    await lockForTurn(tx, peek.contactId, peek.id);
    const a = await assignmentById(tx, p.assignmentId, 'update');
    if (a === null || a.endedAt !== null || a.pausedAt !== null || a.epoch !== p.epoch || a.machine.offer?.status !== 'requested') return 'SKIPPED';
    const ctx = await contextFor(tx, a, now);
    const turn = await ensureTurn(tx, deps.ids, ctx, { triggerKind: 'offer', triggerKey: `offer:${a.epoch}:${a.machine.lastInboundSeq}:${a.machine.counters.bookingFailures}`, pinnedSeq: a.lastInboundSeq, status: 'no_reply' });
    const env = { tx, deps, actor: actorOf(tenantId), ctx, now, turnId: turn.id, pinnedSeq: a.lastInboundSeq };
    const refuse = async (code: OfferRefusal): Promise<string> => {
      await sql`UPDATE ai_isa_turns SET decision = ${JSON.stringify({ code })}::jsonb WHERE tenant_id = app.tenant_id() AND id = ${turn.id}`.execute(tx);
      const r = step(a.machine, { type: 'offer_unavailable', at: now }, ctx.facts);
      await applyActionsInTx(env, r);
      return code;
    };
    if (pre.kind === 'refuse') return refuse(pre.code);
    const appt = await openAppointmentOf(tx, a.contactId);
    if (appt !== null) return refuse('APPOINTMENT_ALREADY_SET');
    const opt = await optInOf(tx, a.optinId);
    const routing = (await sql<{ s: string; e: string }>`SELECT routing_hours_start::text AS s, routing_hours_end::text AS e FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx)).rows[0]!;
    const windows = offerWindows(opt.availability, { startSec: hhmmToSec(routing.s), endSec: hhmmToSec(routing.e) });
    if (windows.length === 0) return refuse('NO_AVAILABILITY');
    const horizonEnd = now + (ctx.content.booking.horizonDays + 1) * 86_400_000;
    const inApp = (await busyAppointments(tx, a.ownerUserId, new Date(now).toISOString(), new Date(horizonEnd).toISOString())).map((x) => ({ startsAt: instantFromDate(x.starts_at), endsAt: instantFromDate(x.ends_at) }));
    const busy: IsaSlot[] = [...pre.busy.map((b) => ({ startsAt: Date.parse(b.start) as Instant, endsAt: Date.parse(b.end) as Instant })), ...inApp];
    const release = (await sql<{ r: Date | null; tz: string | null; src: string | null }>`SELECT inactivity_release_at AS r, timezone AS tz, timezone_source AS src FROM contacts
      WHERE tenant_id = app.tenant_id() AND id = ${a.contactId}`.execute(tx)).rows[0];
    const b = ctx.content.booking;
    const offer = computeOffer({
      now, agentZone: opt.timezone as IanaZone, availability: windows, busy, clientZones: ctx.zones, inactivityReleaseAt: release?.r ? instantFromDate(release.r) : null,
      durationMinutes: b.durationMinutes, minNoticeHours: b.minNoticeHours, horizonDays: b.horizonDays, bufferMinutes: b.bufferMinutes,
    });
    if (offer === null) return refuse('NO_FREE_SLOT');
    const zones = displayZones(opt.timezone as IanaZone, release?.src === 'explicit' && release.tz ? (release.tz as IanaZone) : null);
    const offerId = deps.ids.next<'X'>() as string;
    await sql`INSERT INTO ai_isa_slot_offers (tenant_id, id, assignment_id, contact_id, turn_id, organizer_user_id, kind, slots, zones, availability_link_id, read_at, expires_at)
      VALUES (app.tenant_id(), ${offerId}, ${a.id}, ${a.contactId}, ${turn.id}, ${a.ownerUserId}, ${p.kind}, ${slotsJson(offer.slots)}::jsonb, ${zones}::text[],
              ${pre.linkId}, ${new Date(pre.readAt)}, ${new Date(offer.expiresAt)})`.execute(tx);
    const r = step(a.machine, { type: 'offer_ready', at: now, offerId, slots: offer.slots, zones, expiresAt: offer.expiresAt }, ctx.facts);
    const out = await applyActionsInTx(env, r);
    const messageId = out.queued[0] ?? null;
    if (messageId === null) {
      // nothing could be queued (no window ever, no bound channel): the offer is withdrawn honestly
      await sql`UPDATE ai_isa_slot_offers SET status = 'superseded', refusal_code = 'OFFER_NOT_QUEUED' WHERE tenant_id = app.tenant_id() AND id = ${offerId}`.execute(tx);
      return 'OFFER_NOT_QUEUED';
    }
    await sql`UPDATE ai_isa_slot_offers SET offered_message_id = ${messageId} WHERE tenant_id = app.tenant_id() AND id = ${offerId}`.execute(tx);
    await sql`UPDATE ai_isa_turns SET decision = ${JSON.stringify({ code: 'OFFER_QUEUED' })}::jsonb WHERE tenant_id = app.tenant_id() AND id = ${turn.id}`.execute(tx);
    return 'OFFER_QUEUED';
  }, { db: deps.db, retries: 2 });
}
