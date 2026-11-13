// An opt-out heard in the caller's own words during an AI call (R-VOICE-18, R-CONSENT-7, -8, R-CHAN-3, R-PAR-12, D1).
//
// Core heard it (classifyInbound on 'voice', in callerTurnSignals) and handed the classification over as
// `apply_inbound`; this runs exactly what the SMS/email ingestion runs for the same classification (comms/inbound.ts),
// on channel 'voice': planInboundEffects with the caller's phone as the address and the contact's other phones (live
// and the removed ones that still count, R-PAR-12) as otherPhones. A spoken STOP revokes voice on the caller's
// address only (core compliance/inbound.ts); opt-out language ("stop calling me") revokes the named channels and
// sets the person-level do-not-contact (needs_review). Each consent event cites this call (evidenceCallId and the
// offset of the words in the call). The model's tool arguments never choose an effect (R-CONSENT-8).
import { type InboundAddress, type InboundClassification, planInboundEffects } from '@realty/core/compliance';
import type { ContactId, IdGenerator, Instant, SystemActor } from '@realty/core/foundation';
import { type Tx, lockContact, recordConsentEvent } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../audit.js';
import type { EnvelopeService } from '../crypto/envelope.js';
import { hint } from '../comms/dispatch.js';
import { resolvedPolicy } from '../comms/gateInput.js';
import * as g from '../comms/repos/gate.js';
import * as msgs from '../comms/repos/messages.js';
import { contactLabel, handlerOf, notifyUser } from '../comms/repos/notify.js';

export interface HeardOptOutInput {
  callId: string;
  contactId: string;
  callerAddress: string;
  classification: InboundClassification;
  at: Instant;
  /** where in the call the words were said (ms from the session start) */
  offsetMs: number;
}

/** Returns the consent event ids written (empty for a classification that changes nothing). */
export async function applyHeardOptOut(tx: Tx, actor: SystemActor, deps: { envelope: EnvelopeService; ids: IdGenerator }, i: HeardOptOutInput): Promise<string[]> {
  if (i.classification.kind !== 'stop' && i.classification.kind !== 'opt_out_language') return [];
  await lockContact(tx, i.contactId as ContactId);
  const hmac = Buffer.from(await deps.envelope.inTx(tx, actor.tenantId).hmacAddress(actor.tenantId, i.callerAddress)).toString('hex');
  const { policy } = await resolvedPolicy(tx);
  const points = await g.contactPoints(tx, i.contactId);
  const address: InboundAddress = { kind: 'phone', hmac, hint: hint(i.callerAddress) };
  const others = (kind: 'phone' | 'email'): InboundAddress[] => points.filter((p) => p.kind === kind && p.hmac !== hmac).map((p) => ({ kind, hmac: p.hmac, hint: hint(p.address) }));
  const seen = new Set([hmac, ...others('phone').map((p) => p.hmac)]);
  const otherPhones = others('phone');
  for (const p of await g.removedFanoutPhones(tx, i.contactId)) {
    if (seen.has(p.hmac)) continue;
    seen.add(p.hmac);
    otherPhones.push({ kind: 'phone', hmac: p.hmac, hint: hint(p.address) });
  }
  const fx = planInboundEffects({ classification: i.classification, channel: 'voice', address, otherPhones, otherEmails: others('email'), otherPointsOfKind: [], occurredAt: i.at, contactId: i.contactId, messageId: null, policy, ids: deps.ids });
  const written: string[] = [];
  for (const ev of fx.consentEvents) {
    await recordConsentEvent(tx, { ...ev, evidenceCallId: i.callId, evidenceCallOffsetMs: Math.max(0, Math.round(i.offsetMs)) });
    written.push(ev.id);
  }
  const firstRevoke = fx.consentEvents.find((ev) => ev.eventType === 'revoke');
  if (fx.personDoNotContact && firstRevoke) await sql`SELECT app.record_person_opt_out(${i.contactId}::uuid, ${firstRevoke.id}::uuid)`.execute(tx);
  // queued texts to the revoked phones are canceled in this transaction, as the ingestion does (the dispatch guards
  // refuse every other channel's queued send at dispatch, D1)
  const byHmac = new Map<string, string>([[hmac, i.callerAddress], ...points.map((p) => [p.hmac, p.address] as [string, string])]);
  if (fx.cancelQueuedSmsTo.length > 0) await msgs.cancelQueuedSmsTo(tx, fx.cancelQueuedSmsTo.map((x) => byHmac.get(x)).filter((a): a is string => !!a), 'OPTED_OUT');
  await audit(tx, actor, { action: 'consent.opt_out_received', entity: { type: 'call', id: i.callId }, reason: i.classification.kind.toUpperCase() });
  if (fx.notifyOwner) {
    const h = await handlerOf(tx, i.contactId);
    if (h.userId) {
      const label = await contactLabel(tx, i.contactId);
      await notifyUser(tx, deps.ids, { userId: h.userId, kind: 'opt_out', priority: 'normal', title: `${label ?? 'A contact'} opted out`, body: null, subjectType: 'contact', subjectId: i.contactId, dedupeKey: `opt_out:call:${i.callId}:${written[0] ?? 'x'}` }, i.at);
    }
  }
  return written;
}
