// comms.mms_text (lane telephony-safeguards S3; R-TWL-11, E386-E389): reads the text/plain parts of an inbound MMS for
// opt-outs. Enqueued in the inbound message's own transaction (comms/mmsText.ts enqueueTextParts).
//
// Per pending part:
//   fetch    by SID through the telephony adapter (the kill switch refuses it while off: a refused part), never by URL;
//   decode   at most 16 KiB, strict UTF-8, BOM stripped, a NUL or invalid UTF-8 is unreadable (mmsText.ts decodeTextPart);
//   apply    ONE system transaction: app.lock_address on the sender, then app.lock_contact on every contact sharing it
//            (the global lock order of ingestion and dispatch), the part re-checked and marked read, classified with
//            core classifyInbound, and every REVOKING kind (stop, opt_out_language, wrong_number) that the Body (or
//            Twilio's OptOutType) and the message's earlier parts did not already produce is applied through core
//            planInboundEffects: the same consent events, cancels, person-level do-not-contact, wrong-number mark,
//            audit and owner notice the Body would have caused. START / HELP / anything else in a part changes nothing
//            (a part never lifts an opt-out, never gets a reply of its own). A STOP found only in a part is confirmed
//            by the platform once per message (idempotency key opt_out_confirmation:{message id}, the key the Body's own
//            confirmation uses), through the single send path.
//   refuse   an unreadable, oversized or refused part: a message_media_skipped row and ONE notice to the conversation's
//            handler per message. The provider copy is deleted (best effort) once read or refused.
// An agent's verified alert phone has no message row (E388): a STOP in its part revokes the agent's alert texts the way
// the agent keyword path does (telephonySafeguards.ts recordAgentAlertOptOut).
// Parts never reach an assistant prompt: nothing here writes messages.body, and only this module and the thread view
// read message_text_parts (architecture test).
import { type InboundAddress, type InboundClassification, classifyInbound, parseReaction, planInboundEffects } from '@realty/core/compliance';
import type { ContactId, Instant, SystemActor, TenantId } from '@realty/core/foundation';
import { type Tx, lockAddresses, lockContacts, recordConsentEvent, setOwnershipCommand, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../audit.js';
import { TELEPHONY_LIVE_OFF } from '../providers/twilio/http.js';
import { ProviderError, type TelephonyAccount } from '../providers/types.js';
import { queueOutboundInTx } from './compose.js';
import { hint } from './dispatch.js';
import { resolvedPolicy } from './gateInput.js';
import { sourceStillOn, systemReplyText } from './inbound.js';
import { type InquiryInput, ingestInquiryInTx, intakeLockKeys } from '../leads/intake.js';
import { PLATFORM_CONFIRMS_PART_STOP, type TextPartJob, UNREADABLE_PART_NOTICE, UNREADABLE_TRACKED_PART_BODY, decodeTextPart } from './mmsText.js';
import * as g from './repos/gate.js';
import { telephonyAccount } from './repos/credentials.js';
import * as msgs from './repos/messages.js';
import { contactLabel, handlerOf, notifyUser } from './repos/notify.js';
import { recordAgentAlertOptOut } from './telephonySafeguards.js';
import { SYSTEM_NOTICE, type CommsDeps } from './types.js';

const REVOKING: ReadonlySet<InboundClassification['kind']> = new Set(['stop', 'opt_out_language', 'wrong_number']);

type Fetched = { ok: true; text: string } | { ok: false; reason: 'TOO_LARGE' | 'CONTENT_MISMATCH' | 'FETCH_FAILED' };

async function fetchPart(deps: CommsDeps, account: TelephonyAccount | null, messageRef: string, ref: string | null): Promise<Fetched> {
  if (!ref || !account || !/^(SM|MM)[0-9a-f]{32}$/.test(messageRef)) return { ok: false, reason: 'FETCH_FAILED' };
  let got: { bytes: Uint8Array };
  try {
    got = await deps.providers.telephony.fetchMedia(account, { messageRef, mediaRef: ref });
  } catch (e) {
    // refused (gone, not allowed, or the kill switch): a refused part; unavailable / timeout: the job retries
    if (e instanceof ProviderError && (e.kind === 'rejected' || e.kind === 'not_configured' || e.providerCode === TELEPHONY_LIVE_OFF)) return { ok: false, reason: 'FETCH_FAILED' };
    throw e;
  }
  return decodeTextPart(got.bytes);
}

export type MmsTextResult = { read: number; skipped: number; revoked: string[] };

/** The job body (exported for tests). Re-runnable: a part already read or skipped is left alone. */
export async function readTextParts(actor: SystemActor, j: TextPartJob, deps: CommsDeps): Promise<MmsTextResult> {
  return j.messageId ? readMessageParts(actor, j.messageId, j, deps) : readAgentParts(actor, j, deps);
}

async function readMessageParts(actor: SystemActor, messageId: string, j: TextPartJob, deps: CommsDeps): Promise<MmsTextResult> {
  const tenantId = actor.tenantId as TenantId;
  const out: MmsTextResult = { read: 0, skipped: 0, revoked: [] };
  const pre = await withTenantTx(actor, async (tx) => {
    const m = await sql<{ provider_message_ref: string | null }>`
      SELECT provider_message_ref FROM messages WHERE tenant_id = app.tenant_id() AND id = ${messageId} AND direction = 'inbound'`.execute(tx);
    if (!m.rows[0]) return null;
    const pending = await sql<{ position: number; provider_media_ref: string | null }>`
      SELECT t.position, t.provider_media_ref FROM message_text_parts t
       WHERE t.tenant_id = app.tenant_id() AND t.message_id = ${messageId} AND t.status = 'pending'
         AND NOT EXISTS (SELECT 1 FROM message_media_skipped s WHERE s.tenant_id = t.tenant_id AND s.message_id = t.message_id AND s.position = t.position)
       ORDER BY t.position`.execute(tx);
    return { messageRef: m.rows[0].provider_message_ref ?? j.messageRef, pending: pending.rows };
  }, { db: deps.db });
  if (!pre) return out;
  if (pre.pending.length === 0) {
    // a retried job whose parts were all handled: the tracked re-inquiry may still be due (idempotent by external id)
    if (j.trackedLeadSourceId) await trackedInquiryAfterParts(actor, messageId, pre.messageRef, j.trackedLeadSourceId, deps);
    return out;
  }
  const account = await withTenantTx(actor, (tx) => telephonyAccount(tx, deps.envelope, tenantId), { db: deps.db });
  for (const part of pre.pending) {
    const f = await fetchPart(deps, account, pre.messageRef, part.provider_media_ref);
    const applied = await withTenantTx(actor, (tx, now) => applyPart(tx, actor, deps, messageId, part.position, f, now, j.trackedLeadSourceId !== undefined), { db: deps.db, retries: 3 });
    if (applied === 'read') out.read++;
    else if (applied === 'skipped') out.skipped++;
    else if (applied !== 'noop') {
      out.read++;
      out.revoked.push(applied);
    }
    if (part.provider_media_ref && account && deps.providers.telephony.deleteMedia) {
      await deps.providers.telephony.deleteMedia(account, { messageRef: pre.messageRef, mediaRef: part.provider_media_ref }).catch(() => undefined);
    }
  }
  if (j.trackedLeadSourceId) await trackedInquiryAfterParts(actor, messageId, pre.messageRef, j.trackedLeadSourceId, deps);
  return out;
}

/**
 * b9 review sends/F2 (R-TRK-3, E595 with R-TWL-11): an MMS with declared text parts to a tracking number makes its
 * re-inquiry HERE, once every part is read, never at ingestion. Only when the Body and every part read as nothing
 * (classification 'none'), none of them looks like a reaction (E595: a reply, never an inquiry), no part was unreadable
 * or refused (then no inquiry at all; the handler's notice says so), Twilio did not report an opt-out, the source is
 * still on (read FOR SHARE, ownership-data/F5) and the person is still in a pond or unassigned. The same locks as
 * ingestion (address + the intake's keys in one sorted call, then the contacts), the same input and external id
 * (tracking:sms:<sid>), so a re-run or a concurrent run makes at most one inquiry. It attaches to the message's own
 * contact (ownership-data/F2) and keeps the pond card (ownership-data/F6). The inquiry is late by the job's delay.
 */
async function trackedInquiryAfterParts(actor: SystemActor, messageId: string, messageRef: string, leadSourceId: string, deps: CommsDeps): Promise<boolean> {
  const tenantId = actor.tenantId as TenantId;
  return withTenantTx(actor, async (tx, txNow) => {
    const m = (await sql<{ contact_id: string; from_address: string; body: string; opt_out_keyword: string | null; phone_number_id: string | null }>`
      SELECT contact_id, from_address, body, opt_out_keyword, phone_number_id FROM messages WHERE tenant_id = app.tenant_id() AND id = ${messageId} AND direction = 'inbound'`.execute(tx)).rows[0];
    if (!m || !m.phone_number_id) return false;
    const input: InquiryInput = {
      leadSourceId,
      externalId: `tracking:sms:${messageRef}`.slice(0, 200),
      phones: [m.from_address],
      inquiryType: 'general',
      sourceDetail: { channel: 'tracking_number', via: 'sms', phone_number_id: m.phone_number_id },
    };
    const hmac = Buffer.from(await deps.envelope.inTx(tx, tenantId).hmacAddress(tenantId, m.from_address)).toString('hex');
    await lockAddresses(tx, [hmac, ...(await intakeLockKeys(tx, deps.envelope, tenantId, input))]);
    const sharing = [...new Set([m.contact_id, ...(await msgs.hmacPoints(tx, hmac)).map((p) => p.contactId)])].sort();
    await lockContacts(tx, sharing as ContactId[]);
    const partsRead = (await sql<{ status: string; body: string | null; classification: string | null; skipped: boolean }>`
      SELECT t.status, t.body, t.classification,
             EXISTS (SELECT 1 FROM message_media_skipped s WHERE s.tenant_id = t.tenant_id AND s.message_id = t.message_id AND s.position = t.position) AS skipped
        FROM message_text_parts t WHERE t.tenant_id = app.tenant_id() AND t.message_id = ${messageId}`.execute(tx)).rows;
    if (partsRead.length === 0 || partsRead.some((p) => p.skipped || p.status !== 'read' || p.classification !== 'none' || parseReaction(p.body ?? '') !== null)) return false;
    const { policy } = await resolvedPolicy(tx);
    if (m.opt_out_keyword !== null || classifyInbound(m.body, policy.keywords, 'sms').kind !== 'none' || (m.body.trim() !== '' && parseReaction(m.body) !== null)) return false;
    if (!(await sourceStillOn(tx, leadSourceId))) return false;
    const st = (await sql<{ ownership_state: string }>`SELECT ownership_state FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${m.contact_id}`.execute(tx)).rows[0];
    if (st?.ownership_state !== 'in_pond' && st?.ownership_state !== 'unassigned') return false;
    await ingestInquiryInTx(tx, actor, input, txNow, { envelope: deps.envelope, ids: deps.ids, db: deps.db }, { firstResponse: false, disclosure: 'none', attachTo: m.contact_id, keepPondSummary: true });
    await setOwnershipCommand(tx, null);
    return true;
  }, { db: deps.db, retries: 3 });
}

/** One part in one transaction. Returns 'noop' (already handled), 'skipped', 'read', or the revoking kind it applied. */
async function applyPart(tx: Tx, actor: SystemActor, deps: CommsDeps, messageId: string, position: number, f: Fetched, now0: Instant, tracked = false): Promise<'noop' | 'skipped' | 'read' | InboundClassification['kind']> {
  const tenantId = actor.tenantId as TenantId;
  const m = (await sql<{ contact_id: string; conversation_id: string; from_address: string; body: string; opt_out_keyword: string | null; phone_number_id: string | null }>`
    SELECT contact_id, conversation_id, from_address, body, opt_out_keyword, phone_number_id FROM messages
     WHERE tenant_id = app.tenant_id() AND id = ${messageId}`.execute(tx)).rows[0];
  if (!m) return 'noop';
  const env = deps.envelope.inTx(tx, tenantId);
  const hmac = Buffer.from(await env.hmacAddress(tenantId, m.from_address)).toString('hex');
  // the global lock order: the address, then every contact sharing it (sorted)
  await lockAddresses(tx, [hmac]);
  const sharing = [...new Set([m.contact_id, ...(await msgs.hmacPoints(tx, hmac)).map((p) => p.contactId)])].sort();
  await lockContacts(tx, sharing as ContactId[]);
  const now = (await sql<{ now: Date }>`SELECT clock_timestamp() AS now`.execute(tx)).rows[0]!.now.getTime() as Instant;
  void now0;
  const state = (await sql<{ status: string; skipped: boolean }>`
    SELECT t.status, EXISTS (SELECT 1 FROM message_media_skipped s WHERE s.tenant_id = t.tenant_id AND s.message_id = t.message_id AND s.position = t.position) AS skipped
      FROM message_text_parts t WHERE t.tenant_id = app.tenant_id() AND t.message_id = ${messageId} AND t.position = ${position} FOR UPDATE OF t`.execute(tx)).rows[0];
  if (!state || state.status !== 'pending' || state.skipped) return 'noop';

  if (!f.ok) {
    await sql`
      INSERT INTO message_media_skipped (tenant_id, message_id, position, reason, declared_type)
      VALUES (app.tenant_id(), ${messageId}, ${position}, ${f.reason}, 'text/plain') ON CONFLICT DO NOTHING`.execute(tx);
    const h = await handlerOf(tx, m.contact_id);
    if (h.userId) {
      const label = (await contactLabel(tx, m.contact_id)) ?? 'a client';
      // b9 review sends/F2: on a tracking number, a pond / unassigned person's text with an unreadable part is no inquiry
      const st = tracked ? (await sql<{ ownership_state: string }>`SELECT ownership_state FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${m.contact_id}`.execute(tx)).rows[0]?.ownership_state : undefined;
      const body = st === 'in_pond' || st === 'unassigned' ? UNREADABLE_TRACKED_PART_BODY : null;
      await notifyUser(tx, deps.ids, { userId: h.userId, kind: SYSTEM_NOTICE, priority: 'high', title: UNREADABLE_PART_NOTICE(label), body, subjectType: 'message', subjectId: messageId, dedupeKey: `text_part_unreadable:${messageId}` }, now);
    }
    return 'skipped';
  }

  const { policy, tenant } = await resolvedPolicy(tx);
  const c = classifyInbound(f.text, policy.keywords, 'sms');
  await sql`
    UPDATE message_text_parts SET status = 'read', body = ${f.text}, classification = ${c.kind}, read_at = ${new Date(now).toISOString()}::timestamptz
     WHERE tenant_id = app.tenant_id() AND message_id = ${messageId} AND position = ${position}`.execute(tx);
  if (!REVOKING.has(c.kind)) return 'read'; // START, HELP, YES, anything else: a part never lifts or answers (E389)

  // what this message already did: its Body (re-classified: deterministic), Twilio's OptOutType, its earlier parts
  const already = new Set<string>([classifyInbound(m.body, policy.keywords, 'sms').kind]);
  if (m.opt_out_keyword === 'OPTOUTTYPE_STOP') already.add('stop');
  const earlier = await sql<{ classification: string }>`
    SELECT classification FROM message_text_parts WHERE tenant_id = app.tenant_id() AND message_id = ${messageId} AND status = 'read' AND position <> ${position}`.execute(tx);
  for (const r of earlier.rows) already.add(r.classification);
  if (already.has(c.kind)) return 'read';

  // the effects the Body would have caused (comms/inbound.ts step 5), for the message's contact
  const target = m.contact_id;
  const targetPoints = await g.contactPoints(tx, target);
  const inbound: InboundAddress = { kind: 'phone', hmac, hint: hint(m.from_address) };
  const others = (kind: 'phone' | 'email') => targetPoints.filter((p) => p.kind === kind && p.hmac !== hmac).map((p) => ({ kind, hmac: p.hmac, hint: hint(p.address) }) as InboundAddress);
  // no reply from the plan: a part never gets a reply of its own; the one STOP confirmation is queued below
  const fx = planInboundEffects({ classification: c, channel: 'sms', address: inbound, otherPhones: others('phone'), otherEmails: others('email'), otherPointsOfKind: [], occurredAt: now, contactId: target, messageId, policy: { optOutConfirmationSender: 'provider' }, ids: deps.ids });
  for (const ev of fx.consentEvents) await recordConsentEvent(tx, { ...ev, evidence: { ...ev.evidence, source: 'mms_text_part', position: String(position) } });
  const firstRevoke = fx.consentEvents.find((ev) => ev.eventType === 'revoke');
  if (fx.personDoNotContact && firstRevoke) await sql`SELECT app.record_person_opt_out(${target}::uuid, ${firstRevoke.id}::uuid)`.execute(tx);
  if (fx.cancelQueuedSmsTo.length > 0) {
    const byHmac = new Map<string, string>([[hmac, m.from_address], ...targetPoints.map((p) => [p.hmac, p.address] as [string, string])]);
    await msgs.cancelQueuedSmsTo(tx, fx.cancelQueuedSmsTo.map((x) => byHmac.get(x)).filter((a): a is string => !!a), 'OPTED_OUT');
  }
  if (fx.markWrongNumber) {
    await sql`UPDATE contact_points SET status = 'wrong_number' WHERE tenant_id = app.tenant_id() AND address_hmac = ${Buffer.from(hmac, 'hex')} AND removed_at IS NULL`.execute(tx);
  }
  // the inbound row says it carried an opt-out (also what lets the one keyword confirmation reach this number)
  await sql`UPDATE messages SET opt_out_keyword = ${`TEXT_PART_${c.kind.toUpperCase()}`.slice(0, 40)} WHERE tenant_id = app.tenant_id() AND id = ${messageId} AND opt_out_keyword IS NULL`.execute(tx);
  await audit(tx, actor, { action: 'consent.opt_out_received', entity: { type: 'message', id: messageId }, reason: `${c.kind.toUpperCase()}_TEXT_PART` });
  if (fx.notifyOwner) {
    const h = await handlerOf(tx, target);
    if (h.userId) {
      const label = await contactLabel(tx, target);
      const title = c.kind === 'wrong_number' ? `${label ?? 'A contact'}'s number may be a wrong number` : `${label ?? 'A contact'} opted out`;
      await notifyUser(tx, deps.ids, { userId: h.userId, kind: 'opt_out', priority: 'normal', title, body: null, subjectType: 'contact', subjectId: target, dedupeKey: `opt_out:${messageId}` }, now);
    }
  }
  // E386: a STOP only in a part is confirmed by the platform, once per message (the Body's confirmation key)
  const keywordPoint = targetPoints.find((p) => p.kind === 'phone' && p.hmac === hmac);
  if (c.kind === 'stop' && PLATFORM_CONFIRMS_PART_STOP && keywordPoint && m.phone_number_id) {
    await queueOutboundInTx(tx, deps, {
      contactId: target, channel: 'sms', body: systemReplyText('opt_out_confirmation', tenant.brokerageLegalName), initiator: 'system', purpose: 'informational',
      category: 'opt_out_confirmation', phoneNumberId: await g.keywordReplySender(tx, m.phone_number_id), toPointId: keywordPoint.id, idempotencyKey: `opt_out_confirmation:${messageId}`,
    }, now);
  }
  return c.kind;
}

/** E388: the parts of a text from an agent's own verified alert phone (no message row): only a STOP matters. */
async function readAgentParts(actor: SystemActor, j: TextPartJob, deps: CommsDeps): Promise<MmsTextResult> {
  const tenantId = actor.tenantId as TenantId;
  const out: MmsTextResult = { read: 0, skipped: 0, revoked: [] };
  if (!j.agentUserId) return out;
  const account = await withTenantTx(actor, (tx) => telephonyAccount(tx, deps.envelope, tenantId), { db: deps.db });
  for (const part of j.parts) {
    const f = await fetchPart(deps, account, j.messageRef, part.ref);
    if (part.ref && account && deps.providers.telephony.deleteMedia) await deps.providers.telephony.deleteMedia(account, { messageRef: j.messageRef, mediaRef: part.ref }).catch(() => undefined);
    if (!f.ok) {
      out.skipped++;
      continue;
    }
    out.read++;
    const did = await withTenantTx(actor, async (tx, now) => {
      const mem = (await sql<{ alert_phone_e164: string | null; verified: boolean }>`
        SELECT alert_phone_e164, alert_phone_verified_at IS NOT NULL AS verified FROM memberships WHERE tenant_id = app.tenant_id() AND user_id = ${j.agentUserId!}`.execute(tx)).rows[0];
      if (!mem?.alert_phone_e164 || !mem.verified) return false;
      const { policy } = await resolvedPolicy(tx);
      if (classifyInbound(f.text, policy.keywords).kind !== 'stop') return false; // a part never lifts (E389)
      const hmac = Buffer.from(await deps.envelope.inTx(tx, tenantId).hmacAddress(tenantId, mem.alert_phone_e164)).toString('hex');
      await lockAddresses(tx, [hmac]);
      return recordAgentAlertOptOut(tx, actor, deps.ids, { userId: j.agentUserId!, hmac, hint: hint(mem.alert_phone_e164), matched: 'TEXT_PART_STOP', reason: 'AGENT_ALERT_STOP_TEXT_PART' }, now);
    }, { db: deps.db, retries: 3 });
    if (did) out.revoked.push('stop');
  }
  return out;
}
