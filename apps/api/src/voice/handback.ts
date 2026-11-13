// The end of an AI call: exactly one handback (R-VOICE-7, R-VOICE-15, R-VOICE-16, R-VOICE-17; E112, E115, E427, E430).
//
// One system transaction, contact lock first:
//   (a) one handback: a still-proposed handback already naming this call (the ring-time one inbound.ts wrote, or a
//       recovery one) is merged into, its owner kept; payload.enriched and payload.suggested are set, so a pending
//       assistant.enrich_handback job skips at its locked re-read and never replaces the confirmation draft (E430).
//       VERIFY: setting enriched/suggested on a merged handback is the intended way to stop the enrichment.
//       Otherwise, or when the agent already handled the ring-time one (E430), a new one (dedupe 'voice:{callId}')
//       pinned to the contact's current inbound seq.
//   (b) code-built, quote-free claims: facts citing the call's own fields (voice_outcome, transfer_outcome,
//       ai_takeover_at) or the appointment's starts_at, snippet = the stored value; core's needs-review items and
//       agent notes as needs_review claims without evidence. In-call claims are never stored.
//   (c) payload.voice: codes, counts and ids only   (d) the calls row: voice_outcome, transfer_outcome, handback
//   (e) a failed transfer ⇒ a promise task (E115)   (f) booked with a confirmation channel ⇒ a one-tap draft (E112)
//   (g) an appointment the session did not count as booked is canceled (E427)   (h) recipient: owner, else the offer
//       holder, else whoever handles the contact   (i) feed + notification (critical unless transferred live)
//   (j) ai_runs (no output)   (k) audit voice.session_ended (codes and ids only)
// Idempotent: a re-run finds calls.handback_action_id set and writes nothing. No enrich job is enqueued here.
import { type Claim, formatDue } from '@realty/core/assistant';
import type { ContactId, IanaZone, Instant, SystemActor } from '@realty/core/foundation';
import { toIso } from '@realty/core/foundation';
import type { VoiceHandback, VoiceOutcome } from '@realty/core/voice';
import { type Tx, lockContact, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../audit.js';
import * as A from '../assistant/repos/actions.js';
import { enqueueCalendarPush } from '../calendar/hooks.js';
import * as auto from '../comms/repos/automation.js';
import { contactLabel, handlerOf, notifyUser, upsertFeedItem } from '../comms/repos/notify.js';
import type { VoiceDeps } from './runtime.js';
import type { Unlogged } from './ledger.js';

export const OUTCOME_SENTENCES: Record<VoiceOutcome, string> = {
  booked: 'The assistant booked a time with you.',
  transferred: 'The assistant put the caller through to you.',
  message_taken: 'The assistant took a message for you.',
  caller_ended: 'The caller hung up before leaving a message.',
  opted_out: 'The caller asked not to be contacted.',
  fallback_voicemail: 'The assistant sent the caller to voicemail.',
  error: 'The assistant could not finish this call.',
};

const EXPLANATION: Record<VoiceOutcome, string> = {
  booked: 'The assistant answered a missed call and booked a time with you. Check the details.',
  transferred: 'The assistant answered a missed call and put the caller through to you.',
  message_taken: 'The assistant answered a missed call and took a message for you.',
  caller_ended: 'The assistant answered a missed call; the caller hung up. Call or text them back.',
  opted_out: 'The assistant answered a missed call; the caller asked not to be contacted.',
  fallback_voicemail: 'The assistant answered a missed call and sent the caller to voicemail.',
  error: 'The assistant answered a missed call but could not finish it. Check the call.',
};

export interface HandbackInput {
  tenantId: string;
  callId: string;
  contactId: string;
  handback: VoiceHandback;
  /** booking state the runner observed */
  appointmentId: string | null;
  bookingFailureCode: string | null;
  unlogged: readonly Unlogged[];
  spokeBeforeProcessing: number;
  providerKind: string;
  playbookVersionId: string | null;
  recovered?: boolean;
  at: Instant;
}

/** voice.reconcile's end reason for a session that never wrote its handback (not one of core's: the session was lost). */
export const SESSION_LOST = 'SESSION_LOST';

export interface HandbackResult {
  actionId: string;
  created: boolean;
  merged: boolean;
}

function needsReviewClaim(ids: VoiceDeps['ids'], text: string): Claim {
  return { id: ids.next<'AssistantClaimId'>(), ordinal: 0, kind: 'fact', text: text.slice(0, 300), evidence: [], needsReview: true, reviewReasons: ['NO_EVIDENCE'] };
}

async function tenantZone(tx: Tx): Promise<IanaZone> {
  return (await sql<{ z: string }>`SELECT default_timezone AS z FROM tenant_settings WHERE tenant_id = app.tenant_id()`.execute(tx)).rows[0]!.z as IanaZone;
}

/** E112, R-VOICE-17: the confirmation text (booking_confirmation's sentence, templates.ts) for one tap. */
export function confirmationDraft(channel: 'sms' | 'email', firstName: string | null, when: string): { channel: 'sms' | 'email'; subject?: string; body: string } {
  const body = `Hi${firstName ? ` ${firstName}` : ''}, you are all set for ${when}. Reply here if you need to change it.`;
  return channel === 'email' ? { channel, subject: 'Your appointment', body } : { channel, body };
}

/** The recipient (h): the owner, else whoever holds the intake offer, else whoever handles the contact now (owner question
 *  O8's default). VERIFY: reading offered_to_user_id before handlerOf for an unowned caller (comms/repos/notify.ts). */
async function recipientOf(tx: Tx, contactId: string, to: VoiceHandback['to']): Promise<string | null> {
  if (to.kind === 'owner') return to.userId;
  const r = await sql<{ offered_to_user_id: string | null }>`SELECT offered_to_user_id FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${contactId}`.execute(tx);
  return r.rows[0]?.offered_to_user_id ?? (await handlerOf(tx, contactId)).userId;
}

export async function writeHandback(actor: SystemActor, deps: Pick<VoiceDeps, 'db' | 'ids' | 'envelope'>, i: HandbackInput): Promise<HandbackResult | null> {
  return withTenantTx(actor, (tx, now) => writeHandbackInTx(tx, now, actor, deps, i), { db: deps.db, retries: 2 });
}

/** The same, inside the caller's system transaction (voice.reconcile). */
export async function writeHandbackInTx(tx: Tx, now: Instant, actor: SystemActor, deps: Pick<VoiceDeps, 'ids' | 'envelope'>, i: HandbackInput): Promise<HandbackResult | null> {
  {
    // VERIFY: the lock order of the end transaction (the contact, then the call row, then the booking's cancel in (g)),
    // and bookSlot's own owner lock (calendar/service.ts) waiting behind it (E427).
    await lockContact(tx, i.contactId as ContactId);
    const call = (await sql<{ handback_action_id: string | null; ai_takeover_at: Date | null; transfer_outcome: string | null; handled_by: string }>`
      SELECT handback_action_id, ai_takeover_at, transfer_outcome, handled_by FROM calls WHERE tenant_id = app.tenant_id() AND id = ${i.callId} FOR UPDATE`.execute(tx)).rows[0];
    if (!call || call.handled_by !== 'assistant') return null;
    if (call.handback_action_id) return { actionId: call.handback_action_id, created: false, merged: false };
    const hb = i.handback;
    const outcome = hb.outcome;
    // the arbiter's stored transfer outcome wins over a session that did not see it (calls.transfer_outcome)
    const transferOutcome = call.transfer_outcome ?? hb.transferOutcome;
    const recipient = await recipientOf(tx, i.contactId, hb.to);
    const handler = await handlerOf(tx, i.contactId);
    const ownerUserId = recipient ?? handler.userId;
    if (!ownerUserId) throw new Error('VOICE_HANDBACK_NO_RECIPIENT');
    const zone = await tenantZone(tx);

    // (g) a booking the session did not count (it ended first, or the result never reached it) is canceled
    let appointmentId = i.appointmentId;
    if (appointmentId && hb.booked === null) {
      await sql`UPDATE appointments SET status = 'canceled' WHERE tenant_id = app.tenant_id() AND id = ${appointmentId} AND status IN ('scheduled','held')`.execute(tx);
      await enqueueCalendarPush(tx, appointmentId);
      appointmentId = null;
    }
    const appt = appointmentId ? (await sql<{ starts_at: Date }>`SELECT starts_at FROM appointments WHERE tenant_id = app.tenant_id() AND id = ${appointmentId}`.execute(tx)).rows[0] ?? null : null;

    // (d) the call's own fields first, so the claims below cite stored values
    await sql`UPDATE calls SET voice_outcome = ${outcome}, transfer_outcome = COALESCE(transfer_outcome, ${transferOutcome}) WHERE tenant_id = app.tenant_id() AND id = ${i.callId}`.execute(tx);

    const voice = {
      outcome,
      endReason: hb.endReason,
      categories: hb.categories,
      messageTopics: hb.messageTopics,
      transferOutcome,
      booked: hb.booked ? { start: toIso(hb.booked.start), end: toIso(hb.booked.end) } : null,
      appointmentId,
      bookingFailureCode: i.bookingFailureCode,
      noPhoneCallback: hb.noPhoneCallback,
      confirmationChannel: hb.confirmationChannel,
      unlogged: i.unlogged.slice(0, 50),
      spokeBeforeProcessing: i.spokeBeforeProcessing,
      sessionId: i.callId,
      providerKind: i.providerKind,
      ...(i.recovered ? { recovered: true } : {}),
    };

    // (b) the quote-free claims
    const claims: auto.ClaimSpec[] = [];
    const field = (text: string, f: string, snippet: string) => claims.push({ id: deps.ids.next(), kind: 'fact', text, evidence: { id: deps.ids.next(), sourceType: 'call', sourceId: i.callId, locator: { kind: 'field', field: f }, snippet } });
    if (call.ai_takeover_at) field(`The assistant answered at ${formatDue(call.ai_takeover_at.getTime() as Instant, false, zone)}.`, 'ai_takeover_at', call.ai_takeover_at.toISOString());
    field(OUTCOME_SENTENCES[outcome], 'voice_outcome', outcome);
    if (transferOutcome) field(transferOutcome === 'connected' ? 'You picked up the transfer.' : transferOutcome === 'declined' ? 'You declined the transfer.' : 'The transfer was not picked up in time.', 'transfer_outcome', transferOutcome);

    // (a) one handback
    const existing = (await sql<{ id: string; owner_user_id: string | null; payload: Record<string, unknown> }>`
      SELECT id, owner_user_id, payload FROM assistant_actions
       WHERE tenant_id = app.tenant_id() AND kind = 'handback' AND contact_id = ${i.contactId} AND payload ->> 'inboundCallId' = ${i.callId}
         AND status = 'proposed'
       ORDER BY created_at LIMIT 1 FOR UPDATE`.execute(tx)).rows[0];
    let actionId: string;
    let created = false;
    let merged = false;
    let hasDraft = false;
    if (existing) {
      actionId = existing.id;
      merged = true;
      hasDraft = existing.payload['draft'] !== undefined && existing.payload['draft'] !== null;
      await A.mergePayload(tx, actionId, { voice, enriched: true, suggested: true });
      await sql`UPDATE assistant_actions SET explanation = ${EXPLANATION[outcome]} WHERE tenant_id = app.tenant_id() AND id = ${actionId} AND status = 'proposed'`.execute(tx);
      const start = await A.claimCount(tx, actionId);
      let ordinal = start;
      for (const c of claims) {
        await sql`INSERT INTO assistant_claims (tenant_id, id, action_id, ordinal, claim_kind, text, needs_review) VALUES (app.tenant_id(), ${c.id}, ${actionId}, ${ordinal++}, ${c.kind}, ${c.text.slice(0, 300)}, false)`.execute(tx);
        await sql`INSERT INTO evidence_refs (tenant_id, id, claim_id, source_type, source_id, locator, snippet, verbatim_verified)
                  VALUES (app.tenant_id(), ${c.evidence.id}, ${c.id}, 'call', ${i.callId}, ${JSON.stringify(c.evidence.locator)}::jsonb, ${c.evidence.snippet.slice(0, 500)}, true)`.execute(tx);
      }
    } else {
      actionId = deps.ids.next<'AssistantActionId'>();
      const seq = (await sql<{ s: string }>`SELECT inbound_seq AS s FROM conversations WHERE tenant_id = app.tenant_id() AND contact_id = ${i.contactId}`.execute(tx)).rows[0]?.s ?? '0';
      const ok = await auto.insertHandback(tx, {
        id: actionId,
        contactId: i.contactId,
        ownerUserId,
        explanation: EXPLANATION[outcome],
        payload: { inboundCallId: i.callId, inboundMessageId: null, enriched: true, suggested: true, voice },
        pinnedInboundSeq: Number(seq),
        boundOwnershipSeq: handler.periodSeq,
        dedupeKey: `voice:${i.callId}`,
        claims,
      });
      if (!ok) {
        const again = await A.actionByDedupeKey(tx, `voice:${i.callId}`);
        if (!again) throw new Error('VOICE_HANDBACK_DEDUPE');
        actionId = again.id;
      } else created = true;
    }
    // the appointment's own time, cited from the appointment
    if (appt && appointmentId) {
      const cid = deps.ids.next();
      const n = await A.claimCount(tx, actionId);
      await sql`INSERT INTO assistant_claims (tenant_id, id, action_id, ordinal, claim_kind, text, needs_review)
                VALUES (app.tenant_id(), ${cid}, ${actionId}, ${n}, 'fact', ${`Booked for ${formatDue(appt.starts_at.getTime() as Instant, false, zone)}.`.slice(0, 300)}, false)`.execute(tx);
      await sql`INSERT INTO evidence_refs (tenant_id, id, claim_id, source_type, source_id, locator, snippet, verbatim_verified)
                VALUES (app.tenant_id(), ${deps.ids.next()}, ${cid}, 'appointment', ${appointmentId}, '{"kind":"field","field":"starts_at"}'::jsonb, ${appt.starts_at.toISOString()}, true)`.execute(tx);
    }
    // core's needs-review items and agent notes: needs_review, no evidence (R-VOICE-7: never an appointment time)
    const review: Claim[] = [];
    for (const it of hb.needsReview) {
      if (it.code === 'POSSIBLE_OPT_OUT') review.push(needsReviewClaim(deps.ids, 'The caller may have asked not to be contacted. Check before you reach out.'));
      if (it.code === 'UNCONFIRMED_SLOT') review.push(needsReviewClaim(deps.ids, 'The caller picked a time, but the booking was not confirmed. Confirm a time with them.'));
      if (it.code === 'SLOT_NOT_OFFERED') review.push(needsReviewClaim(deps.ids, 'The caller asked for a time that was not offered. Confirm a time with them.'));
      if (it.code === 'CLAIM_NEEDS_REVIEW') review.push(needsReviewClaim(deps.ids, 'A detail from the call could not be checked against the caller’s words.'));
    }
    for (const note of hb.agentNotes) review.push(needsReviewClaim(deps.ids, note));
    for (const t of hb.messageTopics) review.push(needsReviewClaim(deps.ids, `Message topic: ${t.toLowerCase().replace(/_/g, ' ')}.`));

    // (f) the confirmation draft, one tap through drafts.ts (the gate decides again at send, R-GATE-14)
    if (appt && hb.booked && hb.confirmationChannel) {
      if (hasDraft) review.push(needsReviewClaim(deps.ids, 'No confirmation was drafted because a reply is already drafted. Confirm the time with the caller.'));
      else {
        const first = (await sql<{ first_name: string | null }>`SELECT first_name FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${i.contactId}`.execute(tx)).rows[0]?.first_name ?? null;
        await A.mergePayload(tx, actionId, { draft: confirmationDraft(hb.confirmationChannel, first, formatDue(appt.starts_at.getTime() as Instant, false, zone)) });
      }
    }
    if (review.length > 0) await A.insertClaims(tx, { envelope: deps.envelope, tenantId: actor.tenantId, ids: deps.ids }, actionId, review, await A.claimCount(tx, actionId));

    await sql`UPDATE calls SET handback_action_id = ${actionId} WHERE tenant_id = app.tenant_id() AND id = ${i.callId}`.execute(tx);

    // (e) a failed transfer: a promise task (E115); no callback wording when no phone callback is allowed (E112).
    // VERIFY: the due date comes from an in-call claim that is never stored, so source_claim_id is NULL.
    if (hb.promiseTask) {
      const p = hb.promiseTask;
      const title = hb.noPhoneCallback ? 'Get back to the caller who asked for you (not by phone: they opted out of calls)' : 'Call back the caller who asked for you';
      await sql`
        INSERT INTO tasks (tenant_id, id, assignee_user_id, contact_id, kind, title, due_at, due_all_day, due_tz, created_by_kind, source_action_id, source_claim_id, needs_review)
        VALUES (app.tenant_id(), ${deps.ids.next()}, ${ownerUserId}, ${i.contactId}, 'promise', ${title}, ${p.dueAt === null ? null : toIso(p.dueAt)}::timestamptz, ${p.dueAllDay}, ${p.dueTz},
                'assistant', ${actionId}, NULL, ${p.needsReview})`.execute(tx);
    }

    // (i) feed + notification
    const label = await contactLabel(tx, i.contactId);
    const critical = hb.critical;
    await upsertFeedItem(tx, deps.ids, { userId: ownerUserId, itemType: 'handback', band: 'pinned', contactId: i.contactId, subjectType: 'assistant_action', subjectId: actionId, assistantActionId: actionId, score: critical ? 95 : 80, reasons: [{ code: 'AI_CALL_HANDBACK', text: OUTCOME_SENTENCES[outcome] }], dedupeKey: `handback:${actionId}` });
    await notifyUser(tx, deps.ids, { userId: ownerUserId, kind: critical ? 'handback_hot' : 'handback', priority: critical ? 'critical' : 'high', title: `${label ?? 'A caller'}: ${OUTCOME_SENTENCES[outcome]}`, body: null, subjectType: 'assistant_action', subjectId: actionId, dedupeKey: `handback:${actionId}` }, now);

    // (j) the session's ai_runs row: ids only, no output
    await sql`
      INSERT INTO ai_runs (tenant_id, id, purpose, model, prompt_template_key, prompt_version, input_refs, status, requested_for_user_id)
      VALUES (app.tenant_id(), ${deps.ids.next()}, 'voice_session', ${i.providerKind}, 'voice_answering', ${i.playbookVersionId ?? 'none'}, ${JSON.stringify({ callId: i.callId })}::jsonb,
              ${outcome === 'error' || hb.endReason === 'VENDOR_ERROR' ? 'failed' : 'succeeded'}, ${ownerUserId})`.execute(tx);

    // (k) codes and ids only
    await audit(tx, actor, { action: i.recovered ? 'voice.handback_recovered' : 'voice.session_ended', entity: { type: 'call', id: i.callId }, reason: `${outcome}:${hb.endReason}`.slice(0, 80) });
    return { actionId, created, merged };
  }
}
