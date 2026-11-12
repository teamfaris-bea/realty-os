// Telephony safeguards (lane telephony-safeguards; R-TWL-1..11, E380-E389). Every piece plugs into the existing single
// send path (dispatch.ts / dial.ts) and the existing opt-out model (D1: sending checks only opt-outs); nothing here
// is a second path for an effect that already has one.
//
//   R-TWL-1  kill switch: the Twilio adapter refuses every request with TELEPHONY_LIVE_OFF (providers/twilio/http.ts);
//            here: the one sentence every path answers with, and the reason codes that are never an opt-out,
//            never retried and never reconciled.
//   R-TWL-2  daily cap: claimTelephonySend, one unit per outbound text or call through the real adapter, inside the
//            send-time transaction (TX1); the STOP confirmation and HELP reply are exempt.
//   R-TWL-9  unverified sender (Twilio 30032 toll-free / 30034 unregistered 10DLC): SENDER_NOT_VERIFIED, the number's
//            registration marked not ready in the same transaction, one Owner/Admin notice per number per day.
//
// OWNER DEFAULTS (open owner questions; each is ONE constant here, so one edit changes it):
//   UNVERIFIED_SENDER_BLOCKS_CALLS   false  an unverified sender blocks texts only; calls keep working
//   DEFAULT_DAILY_CAP                200    tenant_settings.telephony_daily_cap default (the column is the setting)
//   (the others live where they act: comms/mmsText.ts TEXT_PART_MAX_BYTES / PLATFORM_CONFIRMS_PART_STOP,
//    comms/inbound.ts OPTOUTTYPE handling: YES is not an opt-in keyword; Advanced Opt-Out stays off at Twilio)
import type { ActionCategory } from '@realty/core/compliance';
import { CONSENT_EXEMPT_CATEGORIES } from '@realty/core/compliance';
import type { Instant, SystemActor } from '@realty/core/foundation';
import { toIso } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { audit } from '../audit.js';
import { TELEPHONY_LIVE_OFF } from '../providers/twilio/http.js';
import { adminUserIds, notifyUser } from './repos/notify.js';
import { SYSTEM_NOTICE, type CommsDeps } from './types.js';

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

// ---- R-TWL-9: unverified sender ---------------------------------------------------------------------------

/** True for a provider error code that means the sending number is not verified/registered for texting. */
export function isSenderNotVerified(code: string | null | undefined): boolean {
  return code !== null && code !== undefined && SENDER_NOT_VERIFIED_CODES.has(code);
}

/**
 * R-TWL-9, in the caller's transaction (the status event's, or dispatch TX2): the number's registration is marked not
 * ready (status 'submitted' = pending: the existing sender check then blocks texts from it, while voice, which only
 * refuses a 'blocked' registration, keeps working; owner default UNVERIFIED_SENDER_BLOCKS_CALLS), with a
 * status_detail naming the code; audited; one Owner/Admin notice per number per tenant-local day. Only "Check
 * registration status" (numbers.ts refreshRegistration, a provider read the kill switch blocks while off) restores
 * it. A number with no registration is already not ready: nothing to mark, the notice still goes.
 */
export async function markSenderNotVerified(tx: Tx, actor: SystemActor, deps: Pick<CommsDeps, 'ids'>, phoneNumberId: string | null, code: string, messageId: string, now: Instant): Promise<void> {
  if (!phoneNumberId) return;
  const n = await sql<{ registration_id: string | null; e164: string; number_type: string; day: string }>`
    SELECT n.registration_id, n.e164, n.number_type, to_char((${toIso(now)}::timestamptz AT TIME ZONE s.default_timezone)::date, 'YYYY-MM-DD') AS day
      FROM phone_numbers n JOIN tenant_settings s ON s.tenant_id = n.tenant_id
     WHERE n.tenant_id = app.tenant_id() AND n.id = ${phoneNumberId}`.execute(tx);
  const num = n.rows[0];
  if (!num) return;
  const detail = `SENDER_NOT_VERIFIED: provider error ${code} on a ${num.number_type === 'toll_free' ? 'toll-free' : 'local'} number ending ${num.e164.slice(-4)}`;
  const target = UNVERIFIED_SENDER_BLOCKS_CALLS ? 'suspended' : 'submitted';
  if (num.registration_id) {
    const u = await sql`
      UPDATE sender_registrations SET status = ${target}, status_detail = ${detail}, status_changed_at = ${toIso(now)}::timestamptz
       WHERE tenant_id = app.tenant_id() AND id = ${num.registration_id} AND status = 'approved'`.execute(tx);
    if (Number(u.numAffectedRows ?? 0n) === 1) {
      await audit(tx, actor, { action: 'sender_registration.changed', entity: { type: 'sender_registration', id: num.registration_id }, reason: 'SENDER_NOT_VERIFIED' });
    }
  }
  await audit(tx, actor, { action: 'sender_registration.changed', entity: { type: 'phone_number', id: phoneNumberId }, reason: `SENDER_NOT_VERIFIED ${code} message ${messageId}`.slice(0, 120) });
  for (const u of await adminUserIds(tx)) {
    await notifyUser(tx, deps.ids, {
      userId: u,
      kind: SYSTEM_NOTICE,
      priority: 'high',
      title: "A team number isn't verified for texting",
      body: `Texts from the number ending ${num.e164.slice(-4)} are paused; calls still work. Open Phone numbers and tap "Check registration status" once the carrier verifies it.`,
      subjectType: 'phone_number',
      subjectId: phoneNumberId,
      dedupeKey: `sender_not_verified:${phoneNumberId}:${num.day}`,
    }, now);
  }
}
