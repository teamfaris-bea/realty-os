// Telephony safeguards (lane telephony-safeguards; R-TWL-1..11, E380-E389). Every piece plugs into the existing single
// send path (dispatch.ts / dial.ts) and the existing opt-out model (D1: sending checks only opt-outs); nothing here
// is a second path for an effect that already has one.
//
//   R-TWL-1  kill switch: the Twilio adapter refuses every request with TELEPHONY_LIVE_OFF (providers/twilio/http.ts);
//            here: the one sentence every path answers with, and the reason codes that are never an opt-out,
//            never retried and never reconciled.
//   R-TWL-2  daily cap: claimTelephonySend, one unit per outbound text or call through the real adapter, inside the
//            send-time transaction (TX1); the STOP confirmation and HELP reply are exempt. A client's sign-in link
//            text (portal_login_link, asked for on a public route) claims through claimPortalLinkSend: it also counts
//            toward a share of the cap of its own, so anonymous requests never spend the team's budget (b14 review R1).
//   R-TWL-9  unverified sender (Twilio 30032 toll-free / 30034 unregistered 10DLC): SENDER_NOT_VERIFIED, the NUMBER
//            marked not ready to text in the same transaction (never its shared registration; b9 review sends/F1), one
//            Owner/Admin notice per number per day.
//
// OWNER DEFAULTS (open owner questions; each is ONE constant here, so one edit changes it):
//   UNVERIFIED_SENDER_BLOCKS_CALLS   false  an unverified sender blocks texts only; calls keep working
//   DEFAULT_DAILY_CAP                200    tenant_settings.telephony_daily_cap default (the column is the setting)
//   PORTAL_LINK_CAP_PERCENT          10     the share of that cap sign-in link texts may use a day (b14 review R1)
//   (the others live where they act: comms/mmsText.ts TEXT_PART_MAX_BYTES / PLATFORM_CONFIRMS_PART_STOP,
//    comms/inbound.ts OPTOUTTYPE handling: YES is not an opt-in keyword; Advanced Opt-Out stays off at Twilio)
import type { ActionCategory } from '@realty/core/compliance';
import { CONSENT_EXEMPT_CATEGORIES } from '@realty/core/compliance';
import type { Instant, SystemActor } from '@realty/core/foundation';
import { toIso } from '@realty/core/foundation';
import { type Tx, recordConsentEvent } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../audit.js';
import { TELEPHONY_LIVE_OFF } from '../providers/twilio/http.js';
import { adminUserIds, notifyUser } from './repos/notify.js';
import { LEDGER_SYSTEM, SYSTEM_NOTICE, type CommsDeps } from './types.js';

export { TELEPHONY_LIVE_OFF };

/** R-TWL-1: what the agent sees for a send, a call or a number purchase the kill switch refused. */
export const TELEPHONY_LIVE_OFF_SENTENCE = 'Live texting and calling are off on this deployment.';
/** R-TWL-2: the gate reason sentence (gateInput.ts DISPATCH_DENY_SENTENCES.DAILY_SEND_CAP_REACHED). */
export const DAILY_CAP_SENTENCE = "Today's sending limit for this team is reached.";
/** R-TWL-9: what the agent sees on a text an unverified sender could not deliver. */
export const SENDER_NOT_VERIFIED_SENTENCE = "Not delivered: the team's number isn't verified for texting. The Owner has been told.";

/** Owner default (R-TWL-9): an unverified sender blocks texts only; true would block calls from it as well. */
export const UNVERIFIED_SENDER_BLOCKS_CALLS = false;
/** Owner default (R-TWL-2): matches the migration's column default. */
export const DEFAULT_DAILY_CAP = 200;
/**
 * Owner default (b14 review R1, owner question Q-PORTAL-17): the percentage of the tenant's daily cap that client
 * sign-in link texts may use a tenant-local day, rounded down (a cap of 200 gives 20; a cap under 10 gives none, so
 * the link is refused and the client can still ask for it by email).
 */
export const PORTAL_LINK_CAP_PERCENT = 10;
/** b14 review R1: the gate reason sentence (gateInput.ts DISPATCH_DENY_SENTENCES.PORTAL_LINK_DAILY_CAP_REACHED). */
export const PORTAL_LINK_CAP_SENTENCE = "Today's limit on sign-in link texts for this team is reached.";

/**
 * Twilio error codes meaning the SENDER is not verified for texting (R-TWL-9). Never an opt-out, never retried.
 *   30032  Toll-Free Number Has Not Been Verified
 *   30034  US A2P 10DLC: Message from an Unregistered Number
 * VERIFY both against Twilio's error dictionary in the pilot test step (the codes are configurable here).
 */
export const SENDER_NOT_VERIFIED_CODES: ReadonlySet<string> = new Set(['30032', '30034']);
export const SENDER_NOT_VERIFIED = 'SENDER_NOT_VERIFIED';

/** Is this outbound text one the cap counts? The platform's own STOP confirmation / HELP reply never is (E381). */
export function countsTowardDailyCap(category: string): boolean {
  return !CONSENT_EXEMPT_CATEGORIES.has(category as ActionCategory);
}

/**
 * R-TWL-2: claims one unit of the tenant's daily telephony budget in the CALLER's transaction (TX1). true = the send
 * may go; false = today's cap is reached (nothing written). The day is the tenant's local day. Concurrency (E380):
 * ON CONFLICT DO UPDATE locks the day's row and re-evaluates the WHERE on its newest version, so of two sends that
 * both see sends = cap-1, exactly one increments; the other gets no row back. A rolled-back TX1 returns its unit.
 */
export async function claimTelephonySend(tx: Tx): Promise<boolean> {
  const r = await sql<{ sends: number }>`
    INSERT INTO telephony_daily_usage AS u (tenant_id, day, sends)
    SELECT s.tenant_id, (now() AT TIME ZONE s.default_timezone)::date, 1
      FROM tenant_settings s WHERE s.tenant_id = app.tenant_id()
    ON CONFLICT (tenant_id, day) DO UPDATE SET sends = u.sends + 1
     WHERE u.sends < (SELECT s2.telephony_daily_cap FROM tenant_settings s2 WHERE s2.tenant_id = u.tenant_id)
    RETURNING u.sends`.execute(tx);
  return r.rows.length === 1;
}

/**
 * R-TWL-2 for a client's sign-in link text (b14 review R1): one statement raises the day's `sends` and
 * `portal_link_sends` together, only while sends < the cap AND portal_link_sends < PORTAL_LINK_CAP_PERCENT of the
 * cap (0090), under the same row lock as claimTelephonySend (E380). null = the link may go; else the reason it may
 * not, and nothing is written: DAILY_SEND_CAP_REACHED when the team's cap itself is reached, otherwise
 * PORTAL_LINK_DAILY_CAP_REACHED. The public sign-in route therefore spends at most that share of the team's budget.
 */
export async function claimPortalLinkSend(tx: Tx): Promise<'DAILY_SEND_CAP_REACHED' | 'PORTAL_LINK_DAILY_CAP_REACHED' | null> {
  const r = await sql<{ sends: number }>`
    INSERT INTO telephony_daily_usage AS u (tenant_id, day, sends, portal_link_sends)
    SELECT s.tenant_id, (now() AT TIME ZONE s.default_timezone)::date, 1, 1
      FROM tenant_settings s WHERE s.tenant_id = app.tenant_id() AND s.telephony_daily_cap * ${PORTAL_LINK_CAP_PERCENT}::int / 100 >= 1
    ON CONFLICT (tenant_id, day) DO UPDATE SET sends = u.sends + 1, portal_link_sends = u.portal_link_sends + 1
     WHERE u.sends < (SELECT s2.telephony_daily_cap FROM tenant_settings s2 WHERE s2.tenant_id = u.tenant_id)
       AND u.portal_link_sends < (SELECT s2.telephony_daily_cap * ${PORTAL_LINK_CAP_PERCENT}::int / 100 FROM tenant_settings s2 WHERE s2.tenant_id = u.tenant_id)
    RETURNING u.sends`.execute(tx);
  if (r.rows.length === 1) return null;
  const f = await sql<{ full: boolean }>`
    SELECT COALESCE(u.sends >= s.telephony_daily_cap, false) AS full
      FROM tenant_settings s
      LEFT JOIN telephony_daily_usage u ON u.tenant_id = s.tenant_id AND u.day = (now() AT TIME ZONE s.default_timezone)::date
     WHERE s.tenant_id = app.tenant_id()`.execute(tx);
  return f.rows[0]?.full === true ? 'DAILY_SEND_CAP_REACHED' : 'PORTAL_LINK_DAILY_CAP_REACHED';
}

// ---- R-TWL-9: unverified sender ---------------------------------------------------------------------------

/** True for a provider error code that means the sending number is not verified/registered for texting. */
export function isSenderNotVerified(code: string | null | undefined): boolean {
  return code !== null && code !== undefined && SENDER_NOT_VERIFIED_CODES.has(code);
}

/**
 * R-TWL-9, in the caller's transaction (the status event's, or dispatch TX2). b9 review sends/F1: sender health is per
 * NUMBER. Only the number that sent the text is marked not ready (phone_numbers.sender_not_verified_at, with a detail
 * naming the code); its registration, normally shared by every team number, is never touched. The gate's sender facts
 * read the flag (repos/gate.ts numberFacts): texts from that number are refused SENDER_NOT_REGISTERED while calls keep
 * working (owner default UNVERIFIED_SENDER_BLOCKS_CALLS); every other number keeps texting. Audited; one Owner/Admin
 * notice per number per tenant-local day, naming exactly that number. "Check registration status" (numbers.ts
 * refreshRegistration, a provider read the kill switch blocks while off) clears it once the carrier reports approved.
 */
export async function markSenderNotVerified(tx: Tx, actor: SystemActor, deps: Pick<CommsDeps, 'ids'>, phoneNumberId: string | null, code: string, messageId: string, now: Instant): Promise<void> {
  if (!phoneNumberId) return;
  const n = await sql<{ registration_id: string | null; e164: string; number_type: string; day: string }>`
    SELECT n.registration_id, n.e164, n.number_type, to_char((${toIso(now)}::timestamptz AT TIME ZONE s.default_timezone)::date, 'YYYY-MM-DD') AS day
      FROM phone_numbers n JOIN tenant_settings s ON s.tenant_id = n.tenant_id
     WHERE n.tenant_id = app.tenant_id() AND n.id = ${phoneNumberId}`.execute(tx);
  const num = n.rows[0];
  if (!num) return;
  const last4 = num.e164.slice(-4);
  const detail = `SENDER_NOT_VERIFIED: provider error ${code} on a ${num.number_type === 'toll_free' ? 'toll-free' : 'local'} number ending ${last4}`;
  const u = await sql`
    UPDATE phone_numbers SET sender_not_verified_at = ${toIso(now)}::timestamptz, sender_not_verified_detail = ${detail}, updated_at = now()
     WHERE tenant_id = app.tenant_id() AND id = ${phoneNumberId} AND sender_not_verified_at IS NULL`.execute(tx);
  if (Number(u.numAffectedRows ?? 0n) === 1) {
    await audit(tx, actor, { action: 'sender_registration.changed', entity: { type: 'phone_number', id: phoneNumberId }, reason: `SENDER_NOT_VERIFIED ${code} message ${messageId}`.slice(0, 120) });
  }
  const body = num.registration_id
    ? `Texts from the number ending ${last4} are paused; calls still work. Other team numbers are not affected. Open Phone numbers and tap "Check registration status" once the carrier verifies it.`
    : `Texts from the number ending ${last4} are paused: it has no texting registration. Calls still work, and other team numbers are not affected.`;
  for (const a of await adminUserIds(tx)) {
    await notifyUser(tx, deps.ids, {
      userId: a,
      kind: SYSTEM_NOTICE,
      priority: 'high',
      title: "A team number isn't verified for texting",
      body: body.slice(0, 240),
      subjectType: 'phone_number',
      subjectId: phoneNumberId,
      dedupeKey: `sender_not_verified:${phoneNumberId}:${num.day}`,
    }, now);
  }
}

/** What a number flagged by markSenderNotVerified reports as its registration to the gate (sms refused; voice per the owner default). */
export function flaggedRegistrationStatus(): 'submitted' | 'suspended' {
  return UNVERIFIED_SENDER_BLOCKS_CALLS ? 'suspended' : 'submitted';
}

/** b9 review sends/F1: clears the per-number flag (refresh found the campaign approved, or a registration was attached). */
export async function clearSenderNotVerified(tx: Tx, where: { registrationId: string } | { phoneNumberId: string }): Promise<string[]> {
  const r = 'registrationId' in where
    ? await sql<{ id: string }>`UPDATE phone_numbers SET sender_not_verified_at = NULL, sender_not_verified_detail = NULL, updated_at = now()
         WHERE tenant_id = app.tenant_id() AND registration_id = ${where.registrationId}::uuid AND sender_not_verified_at IS NOT NULL RETURNING id`.execute(tx)
    : await sql<{ id: string }>`UPDATE phone_numbers SET sender_not_verified_at = NULL, sender_not_verified_detail = NULL, updated_at = now()
         WHERE tenant_id = app.tenant_id() AND id = ${where.phoneNumberId}::uuid AND sender_not_verified_at IS NOT NULL RETURNING id`.execute(tx);
  return r.rows.map((x) => x.id);
}

// ---- R-TWL-8 / E388: an agent's alert phone opted out (21610 on an alert text, or STOP in an MMS text part) ------------

/**
 * Records the alert phone's SMS revoke EXACTLY as the agent keyword path does (comms/inbound.ts agentKeyword: recipient
 * user, source inbound_keyword, purpose all), so the agent's own START from that phone lifts it (owner default), plus
 * the audit and the Admins' notice. `matched` says what carried the opt-out (PROVIDER_21610, TEXT_PART_STOP).
 * Returns false (nothing written) when the phone's latest SMS event is already a revoke: an opt-out is recorded once.
 */
export async function recordAgentAlertOptOut(tx: Tx, actor: SystemActor, ids: CommsDeps['ids'], a: { userId: string; hmac: string; hint: string; matched: string; reason: string; evidence?: Record<string, string> }, now: Instant): Promise<boolean> {
  const last = await sql<{ event_type: string }>`
    SELECT event_type FROM consent_events WHERE tenant_id = app.tenant_id() AND address_hmac = ${Buffer.from(a.hmac, 'hex')} AND channel = 'sms'
     ORDER BY occurred_at DESC, id DESC LIMIT 1`.execute(tx);
  if (last.rows[0]?.event_type === 'revoke') return false;
  await recordConsentEvent(tx, {
    id: ids.next<'ConsentEventId'>(), addressKind: 'phone', addressHmac: a.hmac, addressHint: a.hint, channel: 'sms', purpose: 'all',
    eventType: 'revoke', level: 'none', source: 'inbound_keyword', occurredAt: now, contactId: null,
    actor: LEDGER_SYSTEM, disclosureId: null, evidenceObjectId: null, evidenceMessageId: null, evidenceCallId: null, evidenceCallOffsetMs: null,
    evidence: { recipient: 'user', matched: a.matched, ...(a.evidence ?? {}) }, imported: false, importRecordId: null, originalProvenance: null,
    revertsEventId: null, expiresAt: null, needsReview: false,
  });
  await audit(tx, actor, { action: 'consent.opt_out_received', entity: { type: 'membership', id: a.userId }, reason: a.reason });
  for (const admin of await adminUserIds(tx)) {
    await notifyUser(tx, ids, { userId: admin, kind: SYSTEM_NOTICE, priority: 'normal', title: 'A team member turned off alert texts', body: 'Their alerts now go to push and email only.', subjectType: 'membership', subjectId: a.userId, dedupeKey: `alert_stop:${a.userId}:${toIso(now)}` }, now);
  }
  return true;
}
