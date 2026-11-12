// Who a seller update goes to, and who it cannot reach, BEFORE the tap (R-SELL-5, D1, R-PAR-12, R-CHAN-2).
//
// The recipients are the listing's seller and co-seller contacts. Each gets one informational message through
// dispatchOutbound on one channel: email when the person has an email address, otherwise a text. Whether that
// channel is blocked comes from the same facts the send-time gate uses: comms reachabilityFor (core
// pointBlocks: STOP and other keywords on any of the person's phones including removed ones except a phone
// removed as a wrong number, unsubscribe, agent-recorded opt-outs, suppressions) for the informational purpose,
// plus the person-level do-not-contact (the contact or a duplicate merged into it). No override exists.
// Read under the caller's RLS: a seller contact the caller may not see is listed as not visible and never
// sent to (the agent cannot see who it would reach). An approved draft goes out only from the contact's
// owner (dispatch binds it to the owner and ownership period, R-AST-7), so a seller another agent owns is
// shown as not reachable by the caller, before the tap.
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import type { Instant } from '@realty/core/foundation';
import { type ReasonView, reachabilityFor } from '../comms/reachability.js';
import { personDoNotContact } from '../comms/repos/gate.js';
import { sellerContacts } from './assembly.js';

export interface RecipientView {
  contactId: string;
  name: string | null;
  role: 'seller' | 'co_seller';
  /** the channel the update goes out on; null: no phone or email on file */
  channel: 'email' | 'sms' | null;
  addressHint: string | null;
  /** the caller may see this contact's details */
  visible: boolean;
  /** the caller owns the contact: an approved draft is sent only by the contact's owner (dispatch R-AST-7 binding) */
  ownedByYou: boolean;
  /** the update will be sent to this person when the agent taps Send */
  sendable: boolean;
  /** why not: an opt-out / suppression on the channel (server's facts), for the web's one sentence */
  reasons: ReasonView[];
  personDoNotContact: boolean;
  /** one plain sentence when not sendable */
  whyNot: string | null;
}

/** email when the person has an email address on file, else sms (system or caller transaction). */
export async function channelFor(tx: Tx, contactId: string): Promise<'email' | 'sms'> {
  const r = await sql<{ e: boolean }>`
    SELECT EXISTS (SELECT 1 FROM contact_points WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND kind = 'email' AND removed_at IS NULL) AS e`.execute(tx);
  return r.rows[0]?.e ? 'email' : 'sms';
}

const SOURCE_WORDS: Record<string, string> = {
  keyword: 'texted STOP',
  opt_out_language: 'asked not to be texted',
  unsubscribe: 'unsubscribed',
  agent_recorded: 'asked not to be contacted (recorded by your team)',
  call_outcome: 'asked not to be called',
  wrong_number: 'is a wrong number',
  provider_report: 'opted out with their carrier or email provider',
  imported: 'opted out in your previous system',
  suppression: 'is suppressed (bounce or block list)',
  contact_point: 'cannot receive this',
  other: 'opted out',
};

export function whyNotSentence(r: Pick<RecipientView, 'visible' | 'ownedByYou' | 'channel' | 'personDoNotContact' | 'reasons'>): string | null {
  if (!r.visible) return 'Not sent: you cannot see this contact. Ask their owner to share them.';
  if (r.personDoNotContact) return 'Not sent: asked not to be contacted at all.';
  if (r.channel === null) return 'Not sent: no phone or email on file.';
  const first = r.reasons[0];
  if (first) return `Not sent: ${r.channel === 'email' ? 'their email' : 'their phone'} ${SOURCE_WORDS[first.source] ?? 'opted out'}.`;
  if (!r.ownedByYou) return 'Not sent: this contact belongs to another agent; only their owner can message them.';
  return null;
}

/**
 * The listing's recipients as the caller sees them now. `allIds` are every live seller id (read as the system by
 * the caller): one the caller's RLS hides is listed as not visible, never named, so the agent knows before the
 * tap that a seller will not receive the update.
 */
export async function recipientsOf(tx: Tx, listingId: string, now: Instant, allIds: readonly string[] = []): Promise<RecipientView[]> {
  const shown = await sellerContacts(tx, listingId);
  const seen = new Set(shown.map((s) => s.contactId));
  const hidden = await sql<{ contact_id: string; role: 'seller' | 'co_seller' }>`
    SELECT x.id AS contact_id, 'co_seller'::text AS role FROM unnest(${allIds.filter((id) => !seen.has(id))}::uuid[]) AS x(id)`.execute(tx);
  const sellers = [...shown, ...hidden.rows.map((h) => ({ contactId: h.contact_id, role: h.role, displayName: '' }))];
  const reach = await reachabilityFor(tx, sellers.map((s) => s.contactId), now);
  const owned = new Set(
    (await sql<{ id: string }>`SELECT id FROM contacts WHERE tenant_id = app.tenant_id() AND id = ANY (${sellers.map((s) => s.contactId)}::uuid[]) AND owner_user_id = app.user_id()`.execute(tx)).rows.map((x) => x.id),
  );
  const out: RecipientView[] = [];
  for (const s of sellers) {
    const r = reach.get(s.contactId);
    if (!r) {
      const v = { contactId: s.contactId, name: null, role: s.role, channel: null, addressHint: null, visible: false, ownedByYou: false, sendable: false, reasons: [], personDoNotContact: false };
      out.push({ ...v, whyNot: whyNotSentence(v) });
      continue;
    }
    const channel: 'email' | 'sms' | null = r.channels.email.hasAddress ? 'email' : r.channels.sms.hasAddress ? 'sms' : null;
    const ch = channel ? r.channels[channel] : null;
    const dp = ch?.points.find((p) => p.pointId === ch.defaultPointId) ?? null;
    const reasons = dp ? dp.reasons.filter((x) => x.purposes.includes('informational')) : [];
    const dnc = await personDoNotContact(tx, s.contactId);
    const v = { contactId: s.contactId, name: s.displayName, role: s.role, channel, addressHint: dp?.addressHint ?? null, visible: true, ownedByYou: owned.has(s.contactId), personDoNotContact: dnc, reasons };
    const sendable = channel !== null && dp !== null && reasons.length === 0 && !dnc && v.ownedByYou;
    out.push({ ...v, sendable, whyNot: sendable ? null : whyNotSentence(v) });
  }
  return out;
}
