// b18 review B18S-5 (owner product boundary, 2026-11-14): "No automated contact for leads from this source".
//
// A referral partner is not an AI cohort, and its first-week email introduction does not permit this CRM's autonomous
// texting, calling or mass enrolment. The Owner marks that partner's lead source in the app (0094's
// lead_sources.no_ai_care; the repository never names a partner). For every person the source sent (any record of
// the person, any inquiry, and any imported person whose source label the Owner mapped to it: app.person_no_ai_care_source
// over app.person_from_lead_source, 0094, 0096 and 0099; leads/importLabels.ts) nothing automatic goes out:
//   - the 60-second first response (assistant/firstResponse.ts, speed_to_lead_reply), by text or email;
//   - every plan enrolment: a stage entry, a closed deal, a bulk enroll, and a person enrolling one lead by hand
//     (counted as automated contact: OQ-B18-S5's conservative default); a running plan stops at its next step and a
//     paused one cannot be resumed;
//   - module 26 trigger messages, saved-search alerts and any other assistant or system message, and bulk texts,
//     bulk emails and open-house invites (each person is left out and counted);
//   - AI care (start, Continue, resume: isa/, chain link 11) and AI-answered calls (voice/takeover.ts).
// A person's own one-to-one call, text and email still go. The opt-out confirmation and HELP reply the person asked
// for by texting a keyword, and a client's own portal sign-in link, are answers to the person, not outreach, and go.
// comms/dispatch.ts TX1 refuses any automated message still queued (SOURCE_NO_AUTOMATED_CONTACT), and 0098's
// invoker guards refuse it in the database too (enrolments, messages moved to dispatching, AI-answered calls).
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

/** The code every non-AI-care path refuses or skips with (AI care keeps AI_ISA_SOURCE_NO_AI_CARE). */
export const SOURCE_NO_AUTOMATED_CONTACT = 'SOURCE_NO_AUTOMATED_CONTACT';

/** The setting's name, the same on the sources screen, the Owner's answer and every refusal. */
export const NO_AUTOMATED_CONTACT_LABEL = 'No automated contact for leads from this source';

/**
 * Whether the person (any record of them, any inquiry) came from a source marked "No automated contact for leads from
 * this source": app.person_no_ai_care_source (a definer returning one boolean; 0094, 0096, 0099: imported people by their mapped label too), in the caller's
 * transaction and tenant.
 */
export async function noAutomatedContact(tx: Tx, contactId: string): Promise<boolean> {
  const r = await sql<{ no: boolean }>`SELECT app.person_no_ai_care_source(app.tenant_id(), ${contactId}::uuid) AS no`.execute(tx);
  return r.rows[0]?.no === true;
}

/** The Owner's sentence for the setting, on the sources screen and in the Owner's answer (leads/sources.ts). */
export function noAutomatedContactSentence(on: boolean): string {
  return on
    ? `${NO_AUTOMATED_CONTACT_LABEL}: on. Nothing automatic reaches leads from this source (any record of the person): no instant reply, no plan, no bulk text, email or invite, no AI care and no AI-answered call. Plans and AI care already running for them stop or pause. People an import brought in count once the Owner maps their imported source label to this source. People on the team can still call, text and email them one to one. Only the Owner changes this.`
    : `${NO_AUTOMATED_CONTACT_LABEL}: off. Leads from this source get the team's automatic replies, plans and AI care as usual. Only the Owner changes this.`;
}

/** Why an automated or bulk message did not go (dispatch TX1's deny sentence, gateInput.ts DISPATCH_DENY_SENTENCES). */
export const NO_AUTOMATED_CONTACT_DENY_SENTENCE = `${NO_AUTOMATED_CONTACT_LABEL} is on for this person's lead source (an Owner setting), so this automatic or bulk message did not go out. Call, text or email them one to one.`;

/** The lead card's line when the 60-second first response is not sent (assistant/firstResponse.ts). */
export const NO_INSTANT_REPLY_SENTENCE = `No instant reply was sent: ${NO_AUTOMATED_CONTACT_LABEL} is on for their lead source (an Owner setting). Call, text or email them yourself.`;

/** A module 26 trigger firing's skip text (nurture/decide.ts API_SKIP_TEXT). */
export const NO_AUTOMATED_CONTACT_SKIP_TEXT = `${NO_AUTOMATED_CONTACT_LABEL} is on for this person's lead source (an Owner setting), so this automatic message was not sent.`;

/** An AI-answered call refused at the ring (voice/takeover.ts TAKEOVER_REFUSALS, after "The assistant did not answer: "). */
export const NO_AUTOMATED_CONTACT_CALL_REFUSAL = `"${NO_AUTOMATED_CONTACT_LABEL}" is on for this caller's lead source (an Owner setting), so a person on the team answers or calls them back.`;

/** The stop_reason of a plan the step runner stopped for such a person (assistant/enrollments.ts). */
export const NO_AUTOMATED_CONTACT_STOP_REASON = 'source_no_automated_contact';
