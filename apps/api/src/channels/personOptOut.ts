// The person-level do-not-contact recorded by a person on the team (module 22; R-CHAN-2/3, R-PAR-32, F19).
//
// ONE path for both callers: POST /contacts/:id/do-not-contact (parity module 57, people/contacts.ts) and closing a
// lead with reason do_not_contact (leads/commands.ts, in the close command's own transaction). In the caller's
// transaction, as the caller (RLS decides what they may write):
//   1 every live point of the contact gets a staff revoke on each of its channels (phone: texts and calls; email;
//     a web-chat identity: web chat), in HMAC order; the ledger is the evidence
//   2 queued texts and chat messages to those points are canceled
//   3 app.record_person_opt_out (0044_channels_inbox, invoker) sets contacts.do_not_contact_at citing the first revoke
// It only ever refuses more: nothing here can clear an opt-out (the 0018 guard leaves that to a reviewed definer).
import { type ConsentEventSpec, validateConsentEventSpec } from '@realty/core/compliance';
import type { IdGenerator, Instant, UserActor } from '@realty/core/foundation';
import { type Tx, recordConsentEvent } from '@realty/db';
import { sql } from 'kysely';
import { hint } from '../comms/dispatch.js';
import { cancelQueuedSmsTo, cancelQueuedTo } from '../comms/repos/messages.js';
import { AppError } from '../errors.js';

type PointKind = 'phone' | 'email' | 'web_chat';
const CHANNELS: Record<PointKind, readonly ('sms' | 'voice' | 'email' | 'web_chat')[]> = { phone: ['sms', 'voice'], email: ['email'], web_chat: ['web_chat'] };

export interface PersonOptOutResult {
  /** true when the person-level do-not-contact was set now (false: it already was, or there is no address) */
  set: boolean;
  revokedPoints: number;
  firstEventId: string | null;
}

export async function recordPersonDoNotContactInTx(tx: Tx, ids: IdGenerator, actor: UserActor, contactId: string, reason: string, now: Instant): Promise<PersonOptOutResult> {
  const points = (
    await sql<{ kind: PointKind; address: string; hmac: string }>`
      SELECT kind, address, encode(address_hmac, 'hex') AS hmac FROM contact_points
       WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId}::uuid AND removed_at IS NULL AND kind IN ('phone','email','web_chat')
       ORDER BY address_hmac, kind`.execute(tx)
  ).rows;
  let firstEventId: string | null = null;
  for (const pt of points) {
    for (const channel of CHANNELS[pt.kind]) {
      const id = ids.next<'ConsentEventId'>();
      const spec: ConsentEventSpec = {
        id,
        addressKind: pt.kind,
        addressHmac: pt.hmac,
        addressHint: pt.kind === 'web_chat' ? 'web chat' : hint(pt.address),
        channel,
        purpose: 'all',
        eventType: 'revoke',
        level: 'none',
        source: 'agent_revoke',
        occurredAt: now,
        contactId,
        actor: { kind: 'user', userId: actor.userId },
        disclosureId: null,
        evidenceObjectId: null,
        evidenceMessageId: null,
        evidenceCallId: null,
        evidenceCallOffsetMs: null,
        evidence: { entered_by: 'staff', scope: 'person', reason },
        imported: false,
        importRecordId: null,
        originalProvenance: null,
        revertsEventId: null,
        expiresAt: null,
        needsReview: false,
      };
      if (validateConsentEventSpec(spec).length > 0) throw new AppError('INTERNAL_ERROR');
      await recordConsentEvent(tx, spec);
      firstEventId ??= id;
    }
  }
  if (firstEventId === null) return { set: false, revokedPoints: 0, firstEventId: null };
  await cancelQueuedSmsTo(tx, points.filter((x) => x.kind === 'phone').map((x) => x.address), 'OPTED_OUT');
  await cancelQueuedTo(tx, 'web_chat', points.filter((x) => x.kind === 'web_chat').map((x) => x.address), 'OPTED_OUT');
  const r = await sql<{ set: boolean }>`SELECT app.record_person_opt_out(${contactId}::uuid, ${firstEventId}::uuid) AS set`.execute(tx);
  return { set: r.rows[0]?.set === true, revokedPoints: points.length, firstEventId };
}
