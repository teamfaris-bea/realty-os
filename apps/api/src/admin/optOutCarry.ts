// A person's do-not-contact outlives the person (D1; R-DATA-4, R-DATA-5, R-CONSENT-1; migration 0037 §2b).
//
// contacts.do_not_contact_at blocks every channel of the person while a record of them exists (core canContact
// and both dispatch guards), but it is a column of the person's rows: an erasure or a purge deletes it, and only
// the HMAC-keyed consent ledger survives. The ledger does not always hold all of it. POST
// /contacts/:id/do-not-contact revokes the live points the record had at that moment, and a merge copies only the
// flag onto the survivor (0018 contacts_dnc_follow_merge), so the survivor's own phones and emails, and points
// added later, carry no revoke.
//
// carryPersonOptOut runs before any record of the person is deleted: the erase route as the Owner/Admin, and the
// worker as the system before each retention sweep. It records an agent_revoke for every purpose on each
// (address, channel) that app.person_optout_uncarried lists: the points of the contact and of every record merged
// into it, live or removed except a confirmed wrong number, that do not already carry a revoke which only the
// person's own action can lift. The database refuses the deletion while one is missing
// (PERSON_DO_NOT_CONTACT_UNCARRIED), so a caller that forgets fails closed. It only ever refuses more: it writes no
// grant and no resubscribe, and lifts nothing.
import { type Channel, type ConsentEventSpec, POINT_KINDS, type PointKind } from '@realty/core/compliance';
import type { IdGenerator, Instant, SystemActor, UserActor } from '@realty/core/foundation';
import { type Tx, recordConsentEvent } from '@realty/db';
import { audit, redactSnapshot } from '../audit.js';
import { hint } from '../comms/dispatch.js';
import { cancelQueuedSmsTo } from '../comms/repos/messages.js';
import { LEDGER_SYSTEM } from '../comms/types.js';
import * as repo from './repos/erasure.js';

const isPointKind = (k: string): k is PointKind => (POINT_KINDS as readonly string[]).includes(k);

function carriedRevoke(r: repo.UncarriedOptOutRow & { kind: PointKind }, contactId: string, actor: UserActor | SystemActor, now: Instant, ids: IdGenerator): ConsentEventSpec {
  return {
    id: ids.next<'ConsentEventId'>(),
    addressKind: r.kind,
    addressHmac: r.hmac,
    addressHint: hint(r.address),
    channel: r.channel as Channel,
    purpose: 'all',
    eventType: 'revoke',
    level: 'none',
    source: 'agent_revoke',
    // the carry happens now; an earlier instant could sort below a grant that the person-level flag was overriding
    occurredAt: now,
    contactId,
    actor: actor.kind === 'user' ? { kind: 'user', userId: actor.userId } : LEDGER_SYSTEM,
    disclosureId: null,
    evidenceObjectId: null,
    evidenceMessageId: null,
    evidenceCallId: null,
    evidenceCallOffsetMs: null,
    // the person-level do-not-contact this revoke carries (ids only)
    evidence: { scope: 'person', carries_do_not_contact_event_id: r.do_not_contact_event_id },
    imported: false,
    importRecordId: null,
    originalProvenance: null,
    revertsEventId: null,
    expiresAt: null,
    needsReview: false,
  };
}

export interface CarryResult {
  /** revokes written, one per address and channel (0: no do-not-contact on the person, or already carried) */
  written: number;
  /**
   * (address, channel) pairs left uncarried: Messenger/Instagram identities, out of scope since D2, have no core
   * channel. While any is left the database refuses to delete the person (fail closed), never dropping the opt-out.
   */
  uncarriable: number;
}

/**
 * Puts the person's do-not-contact on each of their addresses in the consent ledger, in the caller's transaction.
 * Audited (consent.recorded) when it writes anything.
 */
export async function carryPersonOptOut(tx: Tx, contactId: string, actor: UserActor | SystemActor, now: Instant, ids: IdGenerator): Promise<CarryResult> {
  const done = new Set<string>();
  const left = new Set<string>();
  const phones = new Set<string>();
  for (const r of await repo.uncarriedOptOut(tx, contactId)) {
    const key = `${r.channel}:${r.hmac}`;
    const kind = r.kind;
    if (!isPointKind(kind)) {
      left.add(key);
      continue;
    }
    if (done.has(key)) continue; // the same address on two records of the person (a merge copies points)
    done.add(key);
    await recordConsentEvent(tx, carriedRevoke({ ...r, kind }, contactId, actor, now, ids));
    if (kind === 'phone') phones.add(r.address);
  }
  if (done.size > 0) {
    // as the do-not-contact itself does: texts still queued to those numbers are canceled (the gate refuses them anyway)
    await cancelQueuedSmsTo(tx, [...phones], 'OPTED_OUT');
    await audit(tx, actor, {
      action: 'consent.recorded',
      entity: { type: 'contact', id: contactId },
      changes: redactSnapshot({ kind: 'revoke', source: 'agent_revoke', scope: 'person', revoked_count: done.size }, { entity: 'consent_event' }),
      reason: 'PERSON_DO_NOT_CONTACT_CARRIED',
    });
  }
  return { written: done.size, uncarriable: left.size };
}
