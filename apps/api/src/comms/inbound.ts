// Inbound ingestion (ARCHITECTURE §10; R-AST-9, R-CONSENT-1, -4, -7, -8, -10, -11, -20; E17, E21–E28,
// E55, E60, E61, E65). ONE system transaction per inbound SMS, email reply or inbound/missed call:
//   1 provider-event idempotency (messages / calls unique provider refs; the webhook row first)
//   2 match contacts by address HMAC (zero ⇒ an "Unknown" contact through intake routing; several ⇒
//     conversation affinity: the thread on the number that was texted, then the most recent thread)
//   3 app.lock_address, then app.lock_contact for every contact sharing the address (sorted) — the
//     global lock order, so dispatch, ownership commands and ingestion exclude each other (E22, E65)
//   4 the inbound message + conversations.inbound_seq + 1
//   5 STOP / START / HELP / wrong number / opt-out language (core.classifyInbound + planInboundEffects):
//     consent events (address-keyed, R-CONSENT-1), cancelling queued SMS, the one confirmation reply
//     VERIFY WITH COUNSEL: D5b reaction quotes (comms/reactions.ts)
//   6 pause: conversation automation_paused_at, live enrollments of EVERY contact on the address, their
//     scheduled step runs canceled_paused, queued assistant messages canceled
//   7 one handback (dedupe handback:{enrollment}:{message}) for the owner, or the Team Lead when unowned,
//     with deterministic evidence-backed claims (what was sent, what the client said)
//   8 feed item + notification (critical when the lead is new), assistant.enrich_handback job
// An agent texting the tenant number from their verified alert phone is a USER recipient (E60): only the
// keywords apply (their STOP stops alert texts; Admins are told), and nothing is stored on a contact.
//
// Module 22 (Phase 2): ingestChannelInbound runs the SAME transaction for a web-chat message (the session's own
// chat identity, R-INBOX-1/2): pause, cancel of queued assistant messages, one handback, feed card; opt-out language
// sets the person-level do-not-contact on the session's own contact (R-CHAN-3, E155). On every channel, ingestion also
// cancels the scheduled trigger runs of every contact on the address (R-NURT-5), and opt-out language records the
// person-level do-not-contact (app.record_person_opt_out, needs_review). Platform inbound email stores the Message-ID
// hash as the system (messages.rfc_message_id_sha256, R-GMAIL-12) and its handback is deduped by
// email:{contact}:{hash}, the key module 68 shares, so a Reply-All reaching both paths hands back once (E201).
import { type Channel, type InboundAddress, type InboundClassification, classifyInbound, planInboundEffects } from '@realty/core/compliance';
import type { ContactId, IdGenerator, Instant, SystemActor, TenantId } from '@realty/core/foundation';
import { normalizeEmail, normalizePhone, toIso } from '@realty/core/foundation';
import { type Tx, applyOwnershipCommandInTx, derivedCommandId, enqueueJob, lockAddresses, lockContacts, recordConsentEvent, setOwnershipCommand, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../audit.js';
import { queueOutboundInTx } from './compose.js';
import { enqueueTextParts } from './mmsText.js';
import { hint } from './dispatch.js';
import { resolvedPolicy } from './gateInput.js';
import { reactionCopy, reactionTitle, readReactionInTx } from './reactions.js';
import { autoReplyHeader } from './render.js';
import * as auto from './repos/automation.js';
import * as g from './repos/gate.js';
import * as msgs from './repos/messages.js';
import { adminUserIds, contactLabel, handlerOf, notifyUser, upsertFeedItem } from './repos/notify.js';
import { LEDGER_SYSTEM, SYSTEM_NOTICE, type CommsDeps } from './types.js';
import { emailHandbackKey, messageIdHeader, rfcMessageIdSha256 } from '../channels/rfcMessageId.js';
import { dkimAligned, ingestForAiIsaInTx } from '../isa/ingest.js';
import type { DkimVerdict } from '../leadEmail/trust.js';
import { type InquiryInput, ingestInquiryInTx, intakeLockKeys } from '../leads/intake.js';

export type InboundEvent =
  | { kind: 'sms'; providerRef: string; from: string; to: string; body: string; mediaCount?: number; occurredAt?: Instant; optOutType?: string; textParts?: TextPartRef[] }
  | { kind: 'email'; providerRef: string; from: string; to: string; subject: string | null; text: string; headers: Record<string, string>; conversationId: string; occurredAt?: Instant; dkim?: readonly DkimVerdict[] }
  | { kind: 'call'; providerRef: string; from: string; to: string; status: 'ringing' | 'no_answer' | 'voicemail' | 'completed' | 'busy'; occurredAt?: Instant }
  | ChannelInboundEvent;

/**
 * Module 22: a message on a Phase 2 channel. Web chat only (D2: no Messenger/Instagram). `from` is the session's own
 * chat identity (wc:<hex>), never anything the visitor typed; `connectionId` the widget it came through.
 */
export type ChannelInboundEvent = { kind: 'web_chat'; providerRef: string; from: string; connectionId: string; body: string; occurredAt?: Instant };

export interface ChannelIngestOptions {
  /**
   * The chat's opening message (it is also the lead's inquiry): stored and opt-out-classified like any message, but
   * it neither pauses nor hands back (nothing ran yet; intake already made the lead card and queued the first
   * response, which it must not cancel).
   */
  opening?: boolean;
}

export type IngestResult =
  | { kind: 'stored'; contactId: string; messageId: string | null; callId: string | null; sharedContactIds: string[]; classification: InboundClassification['kind']; paused: boolean; handbackId: string | null; created: boolean }
  | { kind: 'agent_keyword'; userId: string; classification: InboundClassification['kind'] }
  | { kind: 'duplicate' }
  | { kind: 'unroutable'; reason: 'NUMBER_NOT_LIVE' | 'ADDRESS_INVALID' | 'CONVERSATION_NOT_FOUND' };

/**
 * Lane telephony-safeguards (R-TWL-7, R-TWL-11): Twilio's OptOutType, and the declared text/plain parts of an MMS
 * (read later by comms.mms_text, enqueued in THIS transaction; comms/mmsText.ts).
 */
export type TextPartRef = { position: number; ref: string | null };
/** R-TWL-7: our classifications that already revoke; OptOutType=STOP changes only a message we read as anything else. */
const REVOKING: ReadonlySet<InboundClassification['kind']> = new Set(['stop', 'opt_out_language', 'wrong_number']);

/** The pause reason for a classification (conversations / enrollments CHECK lists). */
function pauseReasonOf(k: InboundClassification['kind']): auto.PauseReason {
  if (k === 'stop' || k === 'opt_out_language') return 'opt_out';
  if (k === 'wrong_number') return 'wrong_number';
  return 'client_reply';
}

/**
 * Opt-out confirmation / HELP wording: conservative placeholders. VERIFY WITH COUNSEL (CTIA / carrier
 * rules, state law). The default is that the provider sends the confirmation (Q7); the platform sends it
 * only when the tenant policy says `opt_out_confirmation_sender = platform`.
 */
export function systemReplyText(kind: 'opt_out_confirmation' | 'help_reply', brokerage: string): string {
  return kind === 'opt_out_confirmation'
    ? `${brokerage}: You're unsubscribed and won't get more texts from us. Reply START to resubscribe.`
    : `${brokerage}: Reply STOP to opt out of texts. For help, reply here and your agent will get back to you.`;
}

function displayPhone(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

/** BUILD_PLAN interface: one transaction: message + keywords + pause + handback. */
export async function ingestInbound(actor: SystemActor, e: InboundEvent, deps: CommsDeps): Promise<IngestResult> {
  return withTenantTx(actor, (tx, now) => ingestInTx(tx, actor, e, now, deps), { db: deps.db, retries: 3 });
}

/** PHASE2_3_PLAN §5.4 #22: the Phase 1 ingestion transaction, per Phase 2 channel. */
export async function ingestChannelInbound(actor: SystemActor, e: ChannelInboundEvent, deps: CommsDeps): Promise<IngestResult> {
  return withTenantTx(actor, (tx, now) => ingestInTx(tx, actor, e, now, deps), { db: deps.db, retries: 3 });
}

/** The same, inside the caller's system transaction (the web-chat start creates the contact and stores the opening). */
export async function ingestChannelInboundInTx(tx: Tx, actor: SystemActor, e: ChannelInboundEvent, now: Instant, deps: CommsDeps, o: ChannelIngestOptions = {}): Promise<IngestResult> {
  return ingestInTx(tx, actor, e, now, deps, o);
}

const WC_ADDRESS = /^wc:[0-9a-f]{32}$/;

async function ingestInTx(tx: Tx, actor: SystemActor, e: InboundEvent, txNow: Instant, deps: CommsDeps, o: ChannelIngestOptions = {}): Promise<IngestResult> {
  const ids = deps.ids;
  const tenantId = actor.tenantId as TenantId;
  const env = deps.envelope.inTx(tx, tenantId);
  const occurredAt = e.occurredAt ?? txNow;
  const isEmail = e.kind === 'email';
  const isChat = e.kind === 'web_chat';
  let from: string;
  if (isChat) {
    if (!WC_ADDRESS.test(e.from)) return { kind: 'unroutable', reason: 'ADDRESS_INVALID' };
    from = e.from;
  } else {
    const fromNorm = isEmail ? normalizeEmail(e.from) : normalizePhone(e.from, 'US');
    if (!fromNorm.ok) return { kind: 'unroutable', reason: 'ADDRESS_INVALID' };
    from = 'email' in fromNorm ? fromNorm.email : fromNorm.e164;
  }
  const hmac = Buffer.from(await env.hmacAddress(tenantId, from)).toString('hex');
  const { policy, tenant } = await resolvedPolicy(tx);

  // the number that was texted / called (still live for this tenant: the resolver checked, R-TEN-8)
  let toNumber: { id: string; assignedUserId: string | null; tollFree: boolean } | null = null;
  // module 22 (R-TRK-2/3): a live tracking number of an ACTIVE lead source makes unknown callers and texters leads
  let tracked: { input: InquiryInput } | null = null;
  if (!isEmail && !isChat) {
    const r = await sql<{ id: string; assigned_user_id: string | null; number_type: string; purpose: string; lead_source_id: string | null; source_active: boolean | null }>`
      SELECT n.id, n.assigned_user_id, n.number_type, n.purpose, n.lead_source_id, s.active AS source_active
        FROM phone_numbers n LEFT JOIN lead_sources s ON s.tenant_id = n.tenant_id AND s.id = n.lead_source_id
       WHERE n.tenant_id = app.tenant_id() AND n.e164 = ${e.to} AND n.released_at IS NULL`.execute(tx);
    if (!r.rows[0]) return { kind: 'unroutable', reason: 'NUMBER_NOT_LIVE' };
    toNumber = { id: r.rows[0].id, assignedUserId: r.rows[0].assigned_user_id, tollFree: r.rows[0].number_type === 'toll_free' };
    const n = r.rows[0];
    if ((e.kind === 'call' || e.kind === 'sms') && n.purpose === 'tracking' && n.lead_source_id !== null && n.source_active === true) {
      tracked = {
        input: {
          leadSourceId: n.lead_source_id,
          externalId: `tracking:${e.kind}:${e.providerRef}`.slice(0, 200),
          phones: [from],
          inquiryType: 'general',
          sourceDetail: { channel: 'tracking_number', via: e.kind, phone_number_id: n.id },
        },
      };
    }
  }

  // Global lock order step 1: the address lock and, on a tracked number, the intake's own lock set, in ONE sorted call
  // before matching (E323, E324): a tracked call and a signed webhook lead for the same new phone never deadlock
  await lockAddresses(tx, tracked ? [hmac, ...(await intakeLockKeys(tx, deps.envelope, tenantId, tracked.input))] : [hmac]);
  // b9 review ownership-data/F5: the source again, under the locks and FOR SHARE (turning it off waits for this
  // transaction). Turned off while this delivery waited: today's untracked path, the text or call is stored, never lost.
  if (tracked && !(await sourceStillOn(tx, tracked.input.leadSourceId))) tracked = null;

  // E60: an agent's own verified alert phone (a USER recipient, not a contact)
  if (e.kind === 'sms') {
    const agent = await sql<{ user_id: string }>`
      SELECT user_id FROM memberships WHERE tenant_id = app.tenant_id() AND status = 'active' AND alert_phone_e164 = ${from}
         AND alert_phone_verified_at IS NOT NULL ORDER BY user_id LIMIT 1`.execute(tx);
    const agentId = agent.rows[0]?.user_id;
    if (agentId && (await msgs.hmacPoints(tx, hmac)).length === 0) {
      // R-TWL-11 (E388): an alert phone has no message row; its text parts are read for a STOP all the same
      if (e.textParts && e.textParts.length > 0) await enqueueTextParts(tx, { agentUserId: agentId, messageRef: e.providerRef, parts: e.textParts });
      return agentKeyword(tx, actor, ids, e.body, from, hmac, agentId, policy, occurredAt, txNow, (e.optOutType ?? '').toUpperCase() === 'STOP', e.providerRef);
    }
  }

  // 2 match contacts
  const points = await msgs.hmacPoints(tx, hmac);
  let sharing = [...new Set(points.map((p) => p.contactId))];
  let target: string | null = null;
  let created = false;
  if (e.kind === 'email') {
    target = e.conversationId ? await conversationContact(tx, e.conversationId) : null;
    if (!target) return { kind: 'unroutable', reason: 'CONVERSATION_NOT_FOUND' };
  } else if (isChat) {
    // the session's own identity is on exactly one live contact (it follows a merge); never a new "Unknown" contact
    if (sharing.length !== 1) return { kind: 'unroutable', reason: 'ADDRESS_INVALID' };
    target = sharing[0]!;
  } else if (sharing.length === 1) target = sharing[0]!;
  else if (sharing.length > 1) target = await affinity(tx, sharing, toNumber?.id ?? null);
  if (target === null && tracked) {
    // R-TRK-2 (module 22): a new caller or texter on a tracked number becomes a lead through the intake: credited to
    // the number's source, routed by its rules, no 60-second reply and no consent text cited (the caller saw none;
    // the R-CONSENT-4 first-text grant below is unchanged). The intake adds the phone point ('mobile').
    const res = await ingestInquiryInTx(tx, actor, tracked.input, txNow, { envelope: deps.envelope, ids, db: deps.db }, {
      firstResponse: false,
      disclosure: 'none',
      unknownCaller: { displayName: `Unknown ${displayPhone(from)}`, pondSummary: e.kind === 'call' ? 'Called in' : 'Texted in' },
    });
    await setOwnershipCommand(tx, null);
    target = res.contactId;
    sharing = [res.contactId];
    created = res.outcome === 'new_contact';
    tracked = null; // this delivery is the inquiry: nothing more below
  }
  if (target === null) {
    // zero matches: an "Unknown +1…" contact through intake routing (system), with this number on it
    const contactId = ids.next<'ContactId'>();
    const res = await applyOwnershipCommandInTx(tx, actor, contactId, { kind: 'create', via: 'inbound' }, {
      commandId: derivedCommandId('comms.inbound.create', e.providerRef),
      ids,
      newContact: { displayName: `Unknown ${displayPhone(from)}`, firstName: null, lastName: null, intent: null, pondSummary: e.kind === 'call' ? 'Called in' : 'Texted in' },
    });
    await setOwnershipCommand(tx, null);
    if (!res.outcome.ok && !res.replayed) throw new Error('inbound contact creation rejected');
    await sql`
      INSERT INTO contact_points (tenant_id, id, contact_id, kind, address, address_hmac, label, is_primary)
      VALUES (app.tenant_id(), ${ids.next<'ContactPointId'>()}, ${contactId}, 'phone', ${from}, ${Buffer.from(hmac, 'hex')}, 'mobile', true)
      ON CONFLICT DO NOTHING`.execute(tx);
    target = contactId;
    sharing = [contactId];
    created = true;
  }
  if (!sharing.includes(target)) sharing.push(target);
  sharing.sort();
  // 3 lock every affected contact (global lock order step 2)
  await lockContacts(tx, sharing as ContactId[]);
  const now = (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(tx)).rows[0]!.now.getTime() as Instant;

  // 4 the inbound row (idempotent by provider ref)
  const conversationId = await msgs.ensureConversation(tx, ids.next<'ConversationId'>(), target, null);
  let messageId: string | null = null;
  let callId: string | null = null;
  let body = '';
  let autoReply: { name: string; value: string } | null = null;
  let rfcHash: Buffer | null = null;
  let hasTextParts = false;
  if (e.kind === 'call') {
    callId = ids.next<'CallId'>();
    const handler = await handlerOf(tx, target);
    const r = await sql<{ id: string }>`
      INSERT INTO calls (tenant_id, id, conversation_id, contact_id, direction, phone_number_id, agent_user_id, client_address, initiator,
        handled_by, status, started_at, recording_mode, recording_decision, provider_call_ref)
      VALUES (app.tenant_id(), ${callId}, ${conversationId}, ${target}, 'inbound', ${toNumber!.id}, ${handler.ownerUserId}, ${from}, 'client',
        ${e.status === 'voicemail' ? 'voicemail' : 'human'}, ${e.status}, ${toIso(occurredAt)}::timestamptz, 'off', '{"mode":"off","reason":"INBOUND_NOT_RECORDED"}'::jsonb,
        ${e.providerRef})
      ON CONFLICT DO NOTHING RETURNING id`.execute(tx);
    if (r.rows.length === 0) return { kind: 'duplicate' };
  } else {
    messageId = ids.next<'MessageId'>();
    body = e.kind === 'sms' || e.kind === 'web_chat' ? e.body : e.text;
    autoReply = e.kind === 'email' ? autoReplyHeader(e.headers) : null;
    // R-GMAIL-12: platform inbound email's Message-ID hash, written here by the system ingestion (never a person)
    rfcHash = e.kind === 'email' ? rfcMessageIdSha256(messageIdHeader(e.headers)) : null;
    const inserted = await msgs.insertInbound(tx, {
      id: messageId,
      conversationId,
      contactId: target,
      channel: e.kind === 'sms' ? ((e.mediaCount ?? 0) > 0 ? 'mms' : 'sms') : e.kind === 'web_chat' ? 'web_chat' : 'email',
      phoneNumberId: toNumber?.id ?? null,
      fromAddress: from,
      toAddress: e.kind === 'web_chat' ? `widget:${e.connectionId}` : e.to,
      subject: e.kind === 'email' ? e.subject : null,
      body,
      isAutoReply: autoReply !== null,
      optOutKeyword: null,
      provider: e.kind === 'email' ? 'email' : e.kind === 'web_chat' ? 'web_chat' : 'telephony',
      providerRef: e.providerRef,
      occurredAt,
      integrationConnectionId: e.kind === 'web_chat' ? e.connectionId : null,
      rfcMessageIdSha256: rfcHash,
    });
    if (!inserted) return { kind: 'duplicate' };
    // R-TWL-11: the declared text parts, pending, and their read job, in the inbound message's own transaction
    // b9 review sends/F2 (R-TRK-3, E595): with declared text parts, a tracked re-inquiry waits for the job to read them
    // (a STOP, opt-out language or wrong-number reply only in a part is never an inquiry); the job decides it
    if (e.kind === 'sms' && e.textParts && e.textParts.length > 0) {
      await enqueueTextParts(tx, { messageId, messageRef: e.providerRef, parts: e.textParts, ...(tracked ? { trackedLeadSourceId: tracked.input.leadSourceId } : {}) });
      hasTextParts = true;
    }
  }
  const inboundSeq = await msgs.bumpInbound(tx, conversationId, target, occurredAt);

  // 5 consent side of the message (SMS and email bodies; a call has no text)
  const channel: Channel = e.kind === 'email' ? 'email' : e.kind === 'web_chat' ? 'web_chat' : 'sms';
  const rx = e.kind === 'sms' && (e.mediaCount ?? 0) === 0 ? await readReactionInTx(tx, actor, { messageId: messageId!, contactId: target, from, phoneNumberId: toNumber!.id, body, keywords: policy.keywords, occurredAt, ids }) : null;
  let classification: InboundClassification = rx ? rx.classification : e.kind === 'call' ? { kind: 'none', needsReview: false } : classifyInbound(body, policy.keywords, channel);
  // R-TWL-7 (E383, E384): Twilio says the person opted out (OptOutType=STOP) and we did not read a revoke ourselves:
  // the usual STOP effects, with no platform reply (the provider sent its own). START / HELP / YES change nothing.
  const providerStop = e.kind === 'sms' && (e.optOutType ?? '').toUpperCase() === 'STOP' && !REVOKING.has(classification.kind);
  if (providerStop) classification = { kind: 'stop', matched: 'OPTOUTTYPE_STOP', needsReview: false, scope: 'channel' };
  // R-TWL-10: a toll-free receiving number's carrier answers STOP / HELP itself, so the platform sends no reply of its own
  // (VERIFY in the pilot test step); local numbers follow the tenant policy
  const replyPolicy = providerStop || toNumber?.tollFree === true ? { optOutConfirmationSender: 'provider' as const } : policy;
  if (e.kind !== 'call') {
    const targetPoints = await g.contactPoints(tx, target);
    const inbound: InboundAddress = { kind: isEmail ? 'email' : isChat ? 'web_chat' : 'phone', hmac, hint: isChat ? 'web chat' : hint(from) };
    const others = (kind: 'phone' | 'email') => targetPoints.filter((p) => p.kind === kind && p.hmac !== hmac).map((p) => ({ kind, hmac: p.hmac, hint: hint(p.address) }) as InboundAddress);
    let otherPhones = others('phone');
    if (classification.kind === 'start' && e.kind === 'sms') {
      // outbound-4: START lifts another phone only when its keyword revoke came from this number's own STOP.
      // The candidates are the phones the send-time fan-out reads (R-PAR-12): the live ones, plus those
      // removed other than as a confirmed wrong number, which still block the person. Only the lift reaches
      // removed phones; the STOP fan-out, the cancel list and the reply target stay on live points.
      const seen = new Set([hmac, ...otherPhones.map((p) => p.hmac)]);
      for (const p of await g.removedFanoutPhones(tx, target)) {
        if (seen.has(p.hmac)) continue;
        seen.add(p.hmac);
        otherPhones.push({ kind: 'phone', hmac: p.hmac, hint: hint(p.address) });
      }
      const bySender = await g.keywordRevokedBy(tx, otherPhones.map((p) => p.hmac), from);
      otherPhones = otherPhones.map((p) => ({ ...p, keywordRevokedBySender: bySender.has(p.hmac) }));
    }
    const otherChats = targetPoints.filter((p) => p.kind === 'web_chat' && p.hmac !== hmac).map((p) => ({ kind: 'web_chat', hmac: p.hmac, hint: 'web chat' }) as InboundAddress);
    const fx = planInboundEffects({ classification, channel, address: inbound, otherPhones, otherEmails: others('email'), otherPointsOfKind: otherChats, occurredAt: now, contactId: target, messageId, policy: replyPolicy, ids });
    for (const ev of fx.consentEvents) await recordConsentEvent(tx, ev);
    if (isChat) {
      const byHmac = new Map<string, string>([[hmac, from], ...targetPoints.map((p) => [p.hmac, p.address] as [string, string])]);
      const chatTargets = fx.cancelQueued.filter((c) => c.channel === 'web_chat').map((c) => byHmac.get(c.hmac)).filter((a): a is string => !!a);
      await msgs.cancelQueuedTo(tx, 'web_chat', chatTargets, 'OPTED_OUT');
    }
    // R-CHAN-3 / D-OPTOUT-LANG: opt-out language sets the person-level do-not-contact (needs_review) on the contact
    // that wrote (from web chat: the session's own contact, never someone the visitor named, E155), citing the
    // revoke just written. It only ever refuses more; "Not an opt-out" is the reviewed reversal.
    const firstRevoke = fx.consentEvents.find((ev) => ev.eventType === 'revoke');
    if (fx.personDoNotContact && firstRevoke) {
      await sql`SELECT app.record_person_opt_out(${target}::uuid, ${firstRevoke.id}::uuid)`.execute(tx);
    }
    if (classification.kind !== 'none' && messageId) {
      await sql`UPDATE messages SET opt_out_keyword = ${(classification.matched ?? classification.kind).slice(0, 40)} WHERE tenant_id = app.tenant_id() AND id = ${messageId}`.execute(tx);
    }
    // R-CONSENT-4: a person texting first is express consent, informational SMS only
    if (e.kind === 'sms' && classification.kind === 'none' && !(await hadOutbound(tx, target))) {
      const st = await g.consentRows(tx, 'sms', [hmac]);
      if (!st.some((r) => r.purpose === 'informational' && r.status !== 'none')) {
        await recordConsentEvent(tx, {
          id: ids.next<'ConsentEventId'>(), addressKind: 'phone', addressHmac: hmac, addressHint: hint(from), channel: 'sms', purpose: 'informational',
          eventType: 'grant', level: 'express', source: 'inbound_first_contact', occurredAt: now, contactId: target, actor: LEDGER_SYSTEM,
          disclosureId: null, evidenceObjectId: null, evidenceMessageId: messageId, evidenceCallId: null, evidenceCallOffsetMs: null, evidence: {},
          imported: false, importRecordId: null, originalProvenance: null, revertsEventId: null, expiresAt: null, needsReview: false,
        });
      }
    }
    if (fx.cancelQueuedSmsTo.length > 0) {
      const byHmac = new Map<string, string>([[hmac, from], ...targetPoints.map((p) => [p.hmac, p.address] as [string, string])]);
      await msgs.cancelQueuedSmsTo(tx, fx.cancelQueuedSmsTo.map((h) => byHmac.get(h)).filter((a): a is string => !!a), 'OPTED_OUT');
    }
    if (fx.markWrongNumber) {
      await sql`UPDATE contact_points SET status = 'wrong_number' WHERE tenant_id = app.tenant_id() AND address_hmac = ${Buffer.from(hmac, 'hex')} AND removed_at IS NULL`.execute(tx);
    }
    // the keyword reply goes to the number that texted the keyword, never the contact's primary phone
    // (R-CONSENT-7, outbound-1): no point for it, no reply
    const keywordPoint = targetPoints.find((p) => p.kind === 'phone' && p.hmac === hmac);
    if (fx.reply !== 'none' && toNumber && keywordPoint) {
      await queueOutboundInTx(tx, deps, {
        contactId: target, channel: 'sms', body: systemReplyText(fx.reply, tenant.brokerageLegalName), initiator: 'system', purpose: 'informational',
        category: fx.reply, phoneNumberId: await g.keywordReplySender(tx, toNumber.id), toPointId: keywordPoint.id, idempotencyKey: `${fx.reply}:${messageId}`,
      }, now);
    }
    if (classification.kind === 'stop' || classification.kind === 'opt_out_language' || classification.kind === 'wrong_number') {
      await audit(tx, actor, { action: 'consent.opt_out_received', entity: { type: 'message', id: messageId }, reason: classification.kind.toUpperCase() });
    }
    if (fx.notifyOwner) {
      const h = await handlerOf(tx, target);
      if (h.userId) {
        const label = await contactLabel(tx, target);
        const title = classification.kind === 'wrong_number' ? `${label ?? 'A contact'}'s number may be a wrong number` : `${label ?? 'A contact'} opted out`;
        await notifyUser(tx, ids, { userId: h.userId, kind: 'opt_out', priority: 'normal', title, body: null, subjectType: 'contact', subjectId: target, dedupeKey: `opt_out:${messageId}` }, now);
      }
    }
  }

  // R-TRK-3 (module 22): a known person in a pond or unassigned who calls, or texts something that is not STOP, opt-out
  // language or a wrong-number reply, on a tracked number: the call or text is also an inquiry from the number's
  // source, so the re-inquiry rules decide (R-OWN-20, owner decision D8(2)). Owned, offered and closed people are only
  // threaded. Read under the contact locks taken in step 3; the intake attaches to a contact in `sharing` (same HMAC).
  // A reaction text (a tapback quoting the team's text, D5b: `rx`) is a reply, never a new inquiry (E595).
  // b9 review: an MMS with declared text parts is decided by comms.mms_text once every part is read (sends/F2); the
  // inquiry attaches to the contact this delivery was threaded on, `target` (ownership-data/F2), and keeps the pond card
  // (ownership-data/F6: a call or text carries no structured facts).
  if (tracked && !hasTextParts && (e.kind === 'call' || (classification.kind === 'none' && !rx))) {
    const st = await sql<{ ownership_state: string }>`SELECT ownership_state FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${target}`.execute(tx);
    const state = st.rows[0]?.ownership_state;
    if (state === 'in_pond' || state === 'unassigned') {
      await ingestInquiryInTx(tx, actor, tracked.input, txNow, { envelope: deps.envelope, ids, db: deps.db }, { firstResponse: false, disclosure: 'none', attachTo: target, keepPondSummary: true });
      await setOwnershipCommand(tx, null);
    }
  }

  if (o.opening) {
    // the chat's opening message is the inquiry itself: intake routed it and queued the first response
    return { kind: 'stored', contactId: target, messageId, callId, sharedContactIds: sharing, classification: classification.kind, paused: false, handbackId: null, created };
  }

  // 6 pause every contact on this address (R-AST-9: shared-address pause)
  const reason = pauseReasonOf(classification.kind);
  let paused = false;
  for (const c of sharing) {
    const conv = c === target ? conversationId : await msgs.ensureConversation(tx, ids.next<'ConversationId'>(), c, null);
    if (await auto.pauseConversation(tx, conv, reason, messageId, now)) paused = true;
  }
  const pausedEnrollments = await auto.pauseEnrollments(tx, sharing, reason, messageId, now);
  const canceledAssistant = await msgs.cancelQueuedAssistant(tx, sharing, 'CLIENT_REPLIED');
  // R-NURT-5 / R-INBOX-2 (module 22): the scheduled trigger runs of every contact on the address, too
  // (module 26's executeTriggerRun also re-checks the pause)
  const canceledTriggerRuns = await msgs.cancelScheduledTriggerRuns(tx, sharing);

  // 0190 (D12 proposed, R-ISA-3/-28): the AI ISA branch, after step 6 (unchanged for everyone). A turn under live care
  // skips steps 7 and 8 (one activity row, one debounced turn, the backstop); anything else under live care pauses it
  // and continues below exactly as today (R-AST-9, the E61 card included).
  const dkimOk = e.kind === 'email' ? dkimAligned(from, e.dkim ?? []) : null;
  if (e.kind === 'email' && messageId) await sql`UPDATE messages SET email_dkim_aligned = ${dkimOk} WHERE tenant_id = app.tenant_id() AND id = ${messageId}`.execute(tx);
  const isa = await ingestForAiIsaInTx(tx, { db: deps.db, ids, providers: deps.providers, aiIsaLiveOff: deps.aiIsaLiveOff }, actor, {
    contactId: target, messageId, channel: e.kind === 'sms' ? ((e.mediaCount ?? 0) > 0 ? 'mms' : 'sms') : e.kind, fromAddress: from, isAutoReply: autoReply !== null,
    classification: classification.kind, dkimAligned: dkimOk, mediaCount: e.kind === 'sms' ? (e.mediaCount ?? 0) : 0,
    textParts: e.kind === 'sms' ? (e.textParts?.length ?? 0) : 0, inboundSeq,
  }, now);
  if (isa.kind === 'turn') return { kind: 'stored', contactId: target, messageId, callId, sharedContactIds: sharing, classification: classification.kind, paused, handbackId: null, created };

  // 7 handback for the replying contact when the assistant was running (or about to run) its thread
  const h = await handlerOf(tx, target);
  const enrollment = pausedEnrollments.find((x) => x.contactId === target) ?? (await auto.liveEnrollment(tx, target));
  const inFlight = await auto.messagesInFlight(tx, target, now);
  const assistantWasActive = pausedEnrollments.some((x) => x.contactId === target) || canceledAssistant.length > 0 || inFlight.length > 0 || canceledTriggerRuns.length > 0;
  let handbackId: string | null = null;
  const label = await contactLabel(tx, target);
  const who = h.firstName ?? 'They';
  if (assistantWasActive && h.userId) {
    handbackId = ids.next<'AssistantActionId'>();
    const claims: auto.ClaimSpec[] = [];
    const srcType = e.kind === 'email' ? 'email' : e.kind === 'call' ? 'call' : 'message';
    // E201 / R-GMAIL-12: with the Message-ID hash known, one handback per message per contact, shared with module 68
    const dedupeKey = rfcHash ? emailHandbackKey(target, rfcHash) : `handback:${enrollment?.id ?? 'none'}:${messageId ?? callId}`;
    const srcId = (messageId ?? callId)!;
    const rxCopy = rx ? reactionCopy(rx, { firstName: h.firstName, label, body, messageId: srcId, ids }) : null;
    if (rxCopy) {
      claims.push(rxCopy.claim);
    } else if (e.kind !== 'call' && body.trim()) {
      const snippet = body.slice(0, 280);
      claims.push({ id: ids.next(), kind: 'client_statement', text: `${who} wrote: “${snippet}”`, evidence: { id: ids.next(), sourceType: srcType as 'message' | 'email', sourceId: srcId, locator: { kind: 'message' }, snippet } });
    } else if (e.kind === 'call') {
      claims.push({ id: ids.next(), kind: 'fact', text: `${who} called (${e.status.replace('_', ' ')}).`, evidence: { id: ids.next(), sourceType: 'call', sourceId: srcId, locator: { kind: 'field', field: 'status' }, snippet: e.status } });
    }
    const last = (await msgs.lastOutbound(tx, target, 1))[0];
    if (last) {
      const snippet = last.body.slice(0, 200);
      claims.push({ id: ids.next(), kind: 'sent_summary', text: `Last sent: “${snippet}”`, evidence: { id: ids.next(), sourceType: 'message', sourceId: last.id, locator: { kind: 'message' }, snippet } });
    }
    const flying = inFlight[0];
    if (flying) {
      // E22: dispatch committed first (a millisecond window): say so honestly
      claims.push({ id: ids.next(), kind: 'fact', text: `A message went out at the same moment ${who === 'They' ? 'they' : who} replied.`, evidence: { id: ids.next(), sourceType: 'message', sourceId: flying.id, locator: { kind: 'message' }, snippet: flying.body.slice(0, 200) } });
    }
    if (autoReply) {
      claims.push({ id: ids.next(), kind: 'fact', text: `This looks like an automatic reply (${autoReply.name}: ${autoReply.value}). You can resume with one tap.`.slice(0, 300), evidence: { id: ids.next(), sourceType: 'email', sourceId: srcId, locator: { kind: 'field', field: `header:${autoReply.name.toLowerCase()}` }, snippet: `${autoReply.name}: ${autoReply.value}`.slice(0, 500) } });
    }
    const explanation = autoReply
      ? `An automatic reply came in, so the assistant paused and handed this back to you.`
      : rxCopy
        ? rxCopy.explanation
        : `${who} replied, so the assistant paused and handed the conversation back to you.`;
    const ok = await auto.insertHandback(tx, {
      id: handbackId,
      contactId: target,
      ownerUserId: h.userId,
      explanation,
      payload: { inboundMessageId: messageId, inboundCallId: callId, enrollmentId: enrollment?.id ?? null, autoReply: autoReply !== null, sentAtSameMoment: flying !== undefined, canceledMessageIds: canceledAssistant, ...(canceledTriggerRuns.length > 0 ? { canceledTriggerRunIds: canceledTriggerRuns } : {}), ...(isChat ? { channel: 'web_chat' } : {}) },
      pinnedInboundSeq: inboundSeq,
      boundOwnershipSeq: h.periodSeq,
      dedupeKey,
      claims,
    });
    if (!ok) handbackId = null;
  }

  // 8 feed + notification for whoever handles the contact now (E17: the number's agent is told, content-free)
  if (h.userId) {
    const hot = h.stage === 'new' || h.stage === 'attempting';
    if (handbackId) {
      await upsertFeedItem(tx, ids, { userId: h.userId, itemType: 'handback', band: 'pinned', contactId: target, subjectType: 'assistant_action', subjectId: handbackId, assistantActionId: handbackId, score: hot ? 95 : 80, reasons: [{ code: autoReply ? 'AUTO_REPLY' : 'CLIENT_REPLIED', text: autoReply ? 'Automatic reply received; the assistant paused' : 'Replied; the assistant paused and handed back' }], dedupeKey: `handback:${handbackId}` });
      await notifyUser(tx, ids, { userId: h.userId, kind: hot ? 'handback_hot' : 'handback', priority: hot ? 'critical' : 'high', title: rx ? reactionTitle(rx, label) : `${label ?? 'A client'} replied`, body: null, subjectType: 'assistant_action', subjectId: handbackId, dedupeKey: `handback:${handbackId}` }, now);
      await enqueueJob(tx, { queue: 'default', kind: 'assistant.enrich_handback', payload: { actionId: handbackId }, dedupeKey: `assistant.enrich_handback:${handbackId}` });
    } else if (e.kind === 'call') {
      // honest UI: a call that is still ringing is not (yet) missed; the later no-answer / busy /
      // voicemail status callback adds the item (recordMissedInboundCall)
      if (isMissedCallStatus(e.status)) await missedCallItem(tx, ids, h.userId, target, callId!, e.status, label, now);
    } else {
      await upsertFeedItem(tx, ids, { userId: h.userId, itemType: 'unanswered_inbound', band: 'pinned', contactId: target, subjectType: 'message', subjectId: messageId!, assistantActionId: null, score: hot ? 90 : 70, reasons: [{ code: 'UNANSWERED_INBOUND', text: 'Waiting for your reply' }], dedupeKey: `inbound:${target}` });
      await notifyUser(tx, ids, { userId: h.userId, kind: 'inbound_message', priority: hot ? 'high' : 'normal', title: rx ? reactionTitle(rx, label) : `${label ?? 'A client'} sent a message`, body: null, subjectType: 'message', subjectId: messageId!, dedupeKey: `inbound:${messageId}` }, now);
    }
    if (e.kind === 'email' && !points.some((p) => p.contactId === target)) {
      // E61: a reply from an address not on the contact: a suggestion, never auto-added
      await upsertFeedItem(tx, ids, { userId: h.userId, itemType: 'unanswered_inbound', band: 'scored', contactId: target, subjectType: 'message', subjectId: messageId!, assistantActionId: null, score: 40, reasons: [{ code: 'UNKNOWN_SENDER_ADDRESS', text: `Replied from a new address (${hint(from)}). Add it to the contact?` }], dedupeKey: `new_address:${target}:${hmac.slice(0, 16)}` });
    }
  }
  if (toNumber?.assignedUserId && toNumber.assignedUserId !== h.userId) {
    await notifyUser(tx, ids, { userId: toNumber.assignedUserId, kind: 'inbound_message', priority: 'low', title: 'A client texted your number. It went to their current agent.', body: null, subjectType: 'phone_number', subjectId: toNumber.id, dedupeKey: `old_number:${messageId ?? callId}` }, now);
  }
  return { kind: 'stored', contactId: target, messageId, callId, sharedContactIds: sharing, classification: classification.kind, paused, handbackId, created };
}

const MISSED_CALL_STATUSES = ['no_answer', 'busy', 'voicemail'] as const;
export function isMissedCallStatus(s: string): s is (typeof MISSED_CALL_STATUSES)[number] {
  return (MISSED_CALL_STATUSES as readonly string[]).includes(s);
}

async function missedCallItem(tx: Tx, ids: IdGenerator, userId: string, contactId: string, callId: string, status: string, label: string | null, now: Instant): Promise<void> {
  await upsertFeedItem(tx, ids, { userId, itemType: 'missed_call', band: 'pinned', contactId, subjectType: 'call', subjectId: callId, assistantActionId: null, score: 85, reasons: [{ code: 'MISSED_CALL', text: status === 'voicemail' ? 'Left a voicemail' : 'Missed call' }], dedupeKey: `missed_call:${contactId}` });
  await notifyUser(tx, ids, { userId, kind: 'missed_call', priority: 'high', title: `Missed call from ${label ?? 'a client'}`, body: null, subjectType: 'call', subjectId: callId, dedupeKey: `missed_call:${callId}` }, now);
}

/**
 * A known inbound call ended unanswered (its first webhook was 'ringing'): the missed-call feed item
 * and notification for whoever handles the contact now. Idempotent (feed and notification dedupe keys).
 */
export async function recordMissedInboundCall(actor: SystemActor, callId: string, deps: CommsDeps): Promise<boolean> {
  return withTenantTx(actor, async (tx, now) => {
    const r = await sql<{ contact_id: string; status: string; direction: string }>`
      SELECT contact_id, status, direction FROM calls WHERE tenant_id = app.tenant_id() AND id = ${callId}`.execute(tx);
    const c = r.rows[0];
    if (!c || c.direction !== 'inbound' || !isMissedCallStatus(c.status)) return false;
    await lockContacts(tx, [c.contact_id as ContactId]);
    const h = await handlerOf(tx, c.contact_id);
    if (!h.userId) return false;
    // a handback already put this contact's reply in front of the handler
    const hb = await sql<{ x: boolean }>`
      SELECT EXISTS (SELECT 1 FROM assistant_actions WHERE tenant_id = app.tenant_id() AND kind = 'handback' AND payload ->> 'inboundCallId' = ${callId}) AS x`.execute(tx);
    if (hb.rows[0]?.x) return false;
    await missedCallItem(tx, deps.ids, h.userId, c.contact_id, callId, c.status, await contactLabel(tx, c.contact_id), now);
    return true;
  }, { db: deps.db, retries: 2 });
}

/** b9 review ownership-data/F5: is the tracking number's source still on? Read FOR SHARE, so turning it off waits. */
export async function sourceStillOn(tx: Tx, leadSourceId: string): Promise<boolean> {
  const r = await sql<{ active: boolean }>`SELECT active FROM lead_sources WHERE tenant_id = app.tenant_id() AND id = ${leadSourceId}::uuid FOR SHARE`.execute(tx);
  return r.rows[0]?.active === true;
}

async function conversationContact(tx: Tx, conversationId: string): Promise<string | null> {
  const r = await sql<{ contact_id: string }>`SELECT contact_id FROM conversations WHERE tenant_id = app.tenant_id() AND id = ${conversationId}`.execute(tx);
  return r.rows[0]?.contact_id ?? null;
}

/** Several contacts share the address: the thread on the texted number, then the most recent thread. */
async function affinity(tx: Tx, contactIds: readonly string[], numberId: string | null): Promise<string> {
  const r = await sql<{ contact_id: string }>`
    SELECT c.contact_id FROM conversations c WHERE c.tenant_id = app.tenant_id() AND c.contact_id = ANY (${contactIds}::uuid[])
     ORDER BY (c.sticky_phone_number_id IS NOT DISTINCT FROM ${numberId}::uuid AND ${numberId}::uuid IS NOT NULL) DESC,
              GREATEST(c.last_inbound_at, c.last_outbound_at) DESC NULLS LAST, c.contact_id LIMIT 1`.execute(tx);
  return r.rows[0]?.contact_id ?? [...contactIds].sort()[0]!;
}

async function hadOutbound(tx: Tx, contactId: string): Promise<boolean> {
  const r = await sql<{ x: boolean }>`
    SELECT EXISTS (SELECT 1 FROM messages WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND direction = 'outbound'
                     AND status IN ('dispatching','sent','delivered','dispatch_unknown')) AS x`.execute(tx);
  return r.rows[0]?.x ?? false;
}

/** E60: keywords from an agent's own alert phone revoke/restore THEIR alert texts (recipient_kind user). */
async function agentKeyword(tx: Tx, actor: SystemActor, ids: IdGenerator, body: string, from: string, hmac: string, userId: string, policy: Awaited<ReturnType<typeof resolvedPolicy>>['policy'], occurredAt: Instant, now: Instant, providerStop = false, providerRef: string | null = null): Promise<IngestResult> {
  const c0 = classifyInbound(body, policy.keywords);
  // R-TWL-7: OptOutType=STOP from the agent's own alert phone stops alert texts like their STOP (never lifts anything)
  const c: InboundClassification = providerStop && c0.kind !== 'stop' && c0.kind !== 'start' ? { kind: 'stop', matched: 'OPTOUTTYPE_STOP', needsReview: false, scope: 'channel' } : c0;
  // b9 review sends/F4 (R-LSRC-7): an alert phone's text has no message row, so the provider ref that dedupes a contact's
  // SMS never applies. A re-armed delivery of the same MessageSid records nothing again: one ledger row, one notice, and
  // a replayed STOP never re-revokes after the agent's later START.
  const ref = providerRef ? providerRef.slice(0, 64) : null;
  if (ref && (c.kind === 'stop' || c.kind === 'start')) {
    const seen = await sql<{ x: boolean }>`
      SELECT EXISTS (SELECT 1 FROM consent_events WHERE tenant_id = app.tenant_id() AND address_hmac = ${Buffer.from(hmac, 'hex')}
                       AND channel = 'sms' AND evidence ->> 'providerRef' = ${ref}) AS x`.execute(tx);
    if (seen.rows[0]?.x) return { kind: 'agent_keyword', userId, classification: c.kind };
  }
  if (c.kind === 'stop' || c.kind === 'start') {
    await recordConsentEvent(tx, {
      id: ids.next<'ConsentEventId'>(), addressKind: 'phone', addressHmac: hmac, addressHint: hint(from), channel: 'sms', purpose: 'all',
      eventType: c.kind === 'stop' ? 'revoke' : 'resubscribe', level: 'none', source: 'inbound_keyword', occurredAt, contactId: null,
      actor: LEDGER_SYSTEM, disclosureId: null, evidenceObjectId: null, evidenceMessageId: null, evidenceCallId: null, evidenceCallOffsetMs: null,
      evidence: { recipient: 'user', matched: c.matched ?? c.kind, ...(ref ? { providerRef: ref } : {}) }, imported: false, importRecordId: null, originalProvenance: null,
      revertsEventId: null, expiresAt: null, needsReview: false,
    });
    if (c.kind === 'stop') {
      await audit(tx, actor, { action: 'consent.opt_out_received', entity: { type: 'membership', id: userId }, reason: 'AGENT_ALERT_STOP' });
      for (const admin of await adminUserIds(tx)) {
        await notifyUser(tx, ids, { userId: admin, kind: SYSTEM_NOTICE, priority: 'normal', title: 'A team member turned off alert texts', body: 'Their alerts now go to push and email only.', subjectType: 'membership', subjectId: userId, dedupeKey: ref ? `alert_stop:${userId}:${ref}` : `alert_stop:${userId}:${toIso(now)}` }, now);
      }
    }
  }
  return { kind: 'agent_keyword', userId, classification: c.kind };
}

// ---- module 68 (D2): synced Gmail (ONE flagged edit of this file, after module 22; PHASE2_3_PLAN §5.3) -------------

export interface SyncedMailIngestDeps {
  ids: IdGenerator;
}

export interface SyncedMailIngestResult {
  paused: boolean;
  handbackId: string | null;
}

/**
 * R-GMAIL-10, E201, E226: a FRESH live Gmail message from a client (module 68 calls this only for a stored live copy
 * whose Gmail internalDate is at most 1 hour old at fetch, in the same system transaction that stored it). The Phase 1
 * lock (address, then every contact on it), the pause of every contact on the address (conversation and enrollments),
 * the cancel of queued assistant messages and scheduled trigger runs (R-NURT-5), and at most ONE handback "replied in
 * Gmail" for the contact's handler when the assistant was running its thread, citing the mail_message by id and time
 * only (evidence source_type 'mail_message', no snippet: evidence_refs_mail_not_quoted). The handback dedupe key is
 * email:{contact}:{rfc_message_id_sha256} when the Message-ID hash is known, the SAME key platform inbound email uses,
 * so a Reply-All that reaches both paths hands back once whichever lands first; else one per Gmail message.
 * It bumps the replying contact's conversation inbound_seq only (E27, R-AST-6: a counter, not a row; never last_inbound_at, D1).
 * It writes no messages row (synced mail is never a channel, a touch, speed-to-lead or an ownership event, R-GMAIL-14),
 * does not classify again (module 68 classified once with classifyInbound, R-GMAIL-9: `classification` only picks the
 * pause reason), quotes nothing and enqueues no assistant.enrich_handback job (never sent to a model).
 */
export async function ingestSyncedMailInTx(tx: Tx, contactId: string, mailMessageId: string, classification: InboundClassification['kind'], deps: SyncedMailIngestDeps): Promise<SyncedMailIngestResult> {
  const ids = deps.ids;
  const copy = (
    await sql<{ contact_address_hmac: Buffer; rfc_message_id_sha256: Buffer | null; gmail_message_id: string; internal_at: Date; sender: string }>`
      SELECT contact_address_hmac, rfc_message_id_sha256, gmail_message_id, internal_at, sender FROM mail_messages
       WHERE tenant_id = app.tenant_id() AND id = ${mailMessageId}::uuid AND contact_id = ${contactId}::uuid`.execute(tx)
  ).rows[0];
  if (!copy || copy.sender !== 'contact') return { paused: false, handbackId: null };
  const hmac = copy.contact_address_hmac.toString('hex');
  await lockAddresses(tx, [hmac]);
  const sharing = [...new Set([contactId, ...(await msgs.hmacPoints(tx, hmac)).map((p) => p.contactId)])].sort();
  await lockContacts(tx, sharing as ContactId[]);
  const now = (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(tx)).rows[0]!.now.getTime() as Instant;

  const reason = pauseReasonOf(classification);
  let paused = false;
  const conversationId = await msgs.ensureConversation(tx, ids.next<'ConversationId'>(), contactId, null);
  for (const c of sharing) {
    const conv = c === contactId ? conversationId : await msgs.ensureConversation(tx, ids.next<'ConversationId'>(), c, null);
    if (await auto.pauseConversation(tx, conv, reason, null, now)) paused = true;
  }
  // the replying contact's conversation counts the reply (inbound_seq only), so E27's re-tap and R-AST-6 DRAFT_STALE
  // see it; a counter is not a messages row (R-GMAIL-14). last_inbound_at is NOT moved: it would reclassify free-form
  // sends as informational and step around a marketing-only unsubscribe (D1)
  await msgs.bumpInboundSeq(tx, conversationId);
  const pausedEnrollments = await auto.pauseEnrollments(tx, sharing, reason, null, now);
  const canceledAssistant = await msgs.cancelQueuedAssistant(tx, sharing, 'CLIENT_REPLIED');
  const canceledTriggerRuns = await msgs.cancelScheduledTriggerRuns(tx, sharing);

  const h = await handlerOf(tx, contactId);
  const enrollment = pausedEnrollments.find((x) => x.contactId === contactId) ?? (await auto.liveEnrollment(tx, contactId));
  const inFlight = await auto.messagesInFlight(tx, contactId, now);
  const assistantWasActive = pausedEnrollments.some((x) => x.contactId === contactId) || canceledAssistant.length > 0 || inFlight.length > 0 || canceledTriggerRuns.length > 0;
  if (!assistantWasActive || !h.userId) return { paused: paused || pausedEnrollments.length > 0, handbackId: null };

  const seq = (await sql<{ s: string }>`SELECT inbound_seq::text AS s FROM conversations WHERE tenant_id = app.tenant_id() AND id = ${conversationId}::uuid`.execute(tx)).rows[0]?.s ?? '0';
  const who = h.firstName ?? 'They';
  const at = copy.internal_at.toISOString();
  const dedupeKey = copy.rfc_message_id_sha256 ? emailHandbackKey(contactId, copy.rfc_message_id_sha256) : `gmail:${contactId}:${copy.gmail_message_id}`;
  const handbackId = ids.next<'AssistantActionId'>();
  const ins = await sql<{ id: string }>`
    INSERT INTO assistant_actions (tenant_id, id, contact_id, kind, action_category, autonomy, status, owner_user_id, explanation, payload,
      pinned_inbound_seq, bound_ownership_seq, dedupe_key)
    VALUES (app.tenant_id(), ${handbackId}::uuid, ${contactId}::uuid, 'handback', 'internal', 'internal', 'proposed', ${h.userId}::uuid,
      ${`${who} replied in Gmail, so the assistant paused and handed the conversation back to you.`.slice(0, 300)},
      ${JSON.stringify({ channel: 'synced_gmail', mailMessageId, internalAt: copy.internal_at.toISOString(), enrollmentId: enrollment?.id ?? null, canceledMessageIds: canceledAssistant, ...(canceledTriggerRuns.length > 0 ? { canceledTriggerRunIds: canceledTriggerRuns } : {}) })}::jsonb,
      ${Number(seq)}, ${h.periodSeq}, ${dedupeKey})
    ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`.execute(tx);
  if (ins.rows.length === 0) return { paused: true, handbackId: null };
  const claimId = ids.next();
  await sql`
    INSERT INTO assistant_claims (tenant_id, id, action_id, ordinal, claim_kind, text, needs_review)
    VALUES (app.tenant_id(), ${claimId}::uuid, ${handbackId}::uuid, 0, 'fact', ${`${who} replied in Gmail (read-only copy in the timeline).`}, true)`.execute(tx);
  // cited by id and time, never quoted (R-GMAIL-14, CHECK evidence_refs_mail_not_quoted): a citation that is never
  // verbatim-verified, so the claim carries needs_review (R-AST-1: only a verified quote clears it)
  await sql`
    INSERT INTO evidence_refs (tenant_id, id, claim_id, source_type, source_id, locator, snippet, verbatim_verified)
    VALUES (app.tenant_id(), ${ids.next()}::uuid, ${claimId}::uuid, 'mail_message', ${mailMessageId}::uuid, ${JSON.stringify({ kind: 'mail_message', internalAt: at })}::jsonb, NULL, false)`.execute(tx);
  const label = await contactLabel(tx, contactId);
  const hot = h.stage === 'new' || h.stage === 'attempting';
  await upsertFeedItem(tx, ids, { userId: h.userId, itemType: 'handback', band: 'pinned', contactId, subjectType: 'assistant_action', subjectId: handbackId, assistantActionId: handbackId, score: hot ? 95 : 80, reasons: [{ code: 'CLIENT_REPLIED', text: 'Replied in Gmail; the assistant paused and handed back' }], dedupeKey: `handback:${handbackId}` });
  await notifyUser(tx, ids, { userId: h.userId, kind: hot ? 'handback_hot' : 'handback', priority: hot ? 'critical' : 'high', title: `${label ?? 'A client'} replied in Gmail`, body: null, subjectType: 'assistant_action', subjectId: handbackId, dedupeKey: `handback:${handbackId}` }, now);
  return { paused: true, handbackId };
}
