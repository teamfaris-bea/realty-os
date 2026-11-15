// b18 review B18S-5 (owner product boundary, 2026-11-14): "No automated contact for leads from this source".
//
// A referral partner is not an AI cohort, and its first-week email introduction does not permit this CRM's autonomous
// texting, calling or mass enrolment. The Owner marks that partner's lead source in the app (0094's
// lead_sources.no_ai_care; the repository never names a partner). For every person the source sent (any record of
// the person, any inquiry, and any imported person whose source label the Owner mapped to it: app.person_no_ai_care_source
// over app.person_from_lead_source, 0094, 0096 and 0099; leads/importLabels.ts) nothing automatic goes out:
//   - the 60-second first response (assistant/firstResponse.ts, speed_to_lead_reply), by text or email;
//   - every plan enrolment: a stage entry, a closed deal, a bulk enroll, and a person enrolling one lead by hand
//     (counted as automated contact: OQ-B18-S5's conservative default); a running plan stops the next time its step
//     job runs, due or not (the sources routes and the intake ask for that step at once: round 3 item 4), and a paused
//     one cannot be resumed;
//   - module 26 trigger messages, saved-search alerts and any other assistant or system message, and bulk texts,
//     bulk emails and open-house invites (each person is left out and counted);
//   - AI care (start, Continue, resume: isa/, chain link 11; a handoff's pending confirmation or holding line of an
//     ended assignment is refused at dispatch, TX1 and the guard: round 3 item 5) and AI-answered calls (voice/takeover.ts);
//   - a draft a plan step or a module 26 trigger wrote for a person to approve (round 3 item 3, OQ-B18-S6): it stays
//     automated even when a person taps it. Pending ones are withdrawn (withdrawAutomatedDrafts) when the setting is
//     turned on, when a label is mapped to a marked source, when a marked source sends the person again (leads/intake.ts)
//     and when a plan, a trigger or the first response meets such a person; approving one is refused
//     (assistant/drafts.ts) and one already approved is blocked at dispatch.
// A person's own one-to-one call, text and email still go. The opt-out confirmation and HELP reply the person asked
// for by texting a keyword, and a client's own portal sign-in link, are answers to the person, not outreach, and go.
// comms/dispatch.ts TX1 refuses any automated message still queued (SOURCE_NO_AUTOMATED_CONTACT), and 0098's
// invoker guards refuse it in the database too (enrolments, messages moved to dispatching, AI-answered calls).
import { type Instant, toIso } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

/** The code every non-AI-care path refuses or skips with (AI care keeps AI_ISA_SOURCE_NO_AI_CARE). */
export const SOURCE_NO_AUTOMATED_CONTACT = 'SOURCE_NO_AUTOMATED_CONTACT';

export const SOURCE_UNCLASSIFIED = 'SOURCE_UNCLASSIFIED';
export const SOURCE_UNCLASSIFIED_SENTENCE = 'Automated contact is blocked until the Owner confirms an exact mapping for every imported source label. Missing or ambiguous sources require review. Existing source prohibitions still apply.';
export type SourceRefusal = typeof SOURCE_NO_AUTOMATED_CONTACT | typeof SOURCE_UNCLASSIFIED;
export async function sourceRefusal(tx: Tx, contactId: string): Promise<SourceRefusal | null> {
  const r = await sql<{ reason: SourceRefusal | null }>`SELECT app.person_source_refusal(app.tenant_id(), ${contactId}::uuid) AS reason`.execute(tx);
  return r.rows[0]?.reason ?? null;
}

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

/**
 * b18 round 3 item 2: "Resume automation" (POST /contacts/:id/automation/resume) for such a person lifts only the
 * conversation pause; their paused plans stay paused, and the answer says how many and why.
 */
export function notResumedSentence(plans: number): string {
  return `${plans === 1 ? '1 plan was' : `${plans} plans were`} not resumed: "${NO_AUTOMATED_CONTACT_LABEL}" is on for this person's lead source (an Owner setting). Call, text or email them one to one.`;
}

/**
 * Whether an error is one of 0098's invoker guards refusing a write (a check_violation whose message starts
 * 'SOURCE_NO_AUTOMATED_CONTACT:'): app.playbook_enrollments_source_guard, app.messages_source_guard or
 * app.calls_source_guard. A caller maps it to its own clear refusal (comms/dispatch.ts a deny, comms/consent.ts a 409),
 * so a source marked between a check and a write is never a 500.
 */
export function isSourceGuardViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const { code, message } = err as { code?: unknown; message?: unknown };
  return code === '23514' && typeof message === 'string' && (message.startsWith(`${SOURCE_NO_AUTOMATED_CONTACT}:`) || message.startsWith(`${SOURCE_UNCLASSIFIED}:`));
}

// ---- b18 round 3 item 3 (OQ-B18-S6): drafts automation wrote ----

/**
 * assistant_actions.trigger_ref.kind of a draft automation wrote for a person to approve: a plan step
 * (assistant/steps.ts) or a module 26 trigger firing (nurture/execute.ts). A reply the assistant drafted to the
 * person's own message or call, a handback reply and a seller update are not in this set: a person asked for or
 * reviews those one to one. 0100's app.messages_source_guard lists the same two kinds.
 */
export const AUTOMATED_DRAFT_TRIGGER_KINDS: readonly string[] = ['playbook_step', 'trigger_run'];

/** Whether an action is a draft automation wrote (it stays automated contact even when a person approves it). */
export function isAutomatedDraft(a: { autonomy: string; triggerRef: Record<string, unknown> | null }): boolean {
  const kind = a.triggerRef?.['kind'];
  return a.autonomy === 'requires_approval' && typeof kind === 'string' && AUTOMATED_DRAFT_TRIGGER_KINDS.includes(kind);
}

/** Approving such a draft for a covered person: 409 SOURCE_NO_AUTOMATED_CONTACT details.sentence (assistant/drafts.ts). */
export const AUTOMATED_DRAFT_REFUSAL = `This draft was written by a plan or an alert, and "${NO_AUTOMATED_CONTACT_LABEL}" is on for this person's lead source (an Owner setting), so it was withdrawn and nothing was sent. Call, text or email them one to one.`;

/** The same tap on a draft withdrawn earlier, when the setting no longer covers the person (it stays withdrawn). */
export const AUTOMATED_DRAFT_WITHDRAWN_EARLIER = `This draft was written by a plan or an alert and was withdrawn while "${NO_AUTOMATED_CONTACT_LABEL}" was on for this person's lead source (an Owner setting). Nothing was sent. Write to them yourself.`;

/** The Owner's count of drafts withdrawn when the setting is turned on or a label is mapped (leads/sources.ts). */
export function withdrawnDraftsSentence(drafts: number): string {
  return `${drafts === 1 ? '1 draft a plan or an alert wrote for them was' : `${drafts} drafts a plan or an alert wrote for them were`} withdrawn.`;
}

/** Whether a draft's payload says it was withdrawn for the setting (payload.withdrawn.reason). */
export function withdrawnForSource(payload: Record<string, unknown> | null): boolean {
  const w = payload?.['withdrawn'];
  return typeof w === 'object' && w !== null && [SOURCE_NO_AUTOMATED_CONTACT, SOURCE_UNCLASSIFIED].includes(String((w as { reason?: unknown }).reason));
}

/**
 * Withdraws the pending drafts automation wrote for one person, or for every person a source sent: each becomes
 * `invalidated` with payload.withdrawn { reason, at }, its feed cards close, and a module 26 trigger run that waited on
 * it is skipped with the visible reason (never left as "drafted: it waits for the contact owner"). Returns how many
 * were withdrawn. The caller is tenant-wide (the Owner on the sources routes, or the system: intake, the step runner,
 * the trigger runner, the first response, the approval's follow-up); RLS and the tenant filter bound it to this tenant.
 */
export async function withdrawAutomatedDrafts(tx: Tx, scope: { contactId: string } | { sourceId: string }, now: Instant): Promise<number> {
  // one person: every record of them (the merge tree, app.contact_person_ids, as app.person_no_ai_care_source reads it)
  const who = 'contactId' in scope
    ? sql`a.contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${scope.contactId}::uuid))`
    : sql`a.contact_id IS NOT NULL AND app.person_from_lead_source(a.tenant_id, a.contact_id, ${scope.sourceId}::uuid)`;
  const reason = 'contactId' in scope ? (await sourceRefusal(tx, scope.contactId)) ?? SOURCE_NO_AUTOMATED_CONTACT : SOURCE_NO_AUTOMATED_CONTACT;
  const mark = JSON.stringify({ withdrawn: { reason, at: toIso(now) } });
  const r = await sql<{ id: string }>`
    UPDATE assistant_actions a SET status = 'invalidated', payload = a.payload || ${mark}::jsonb
     WHERE a.tenant_id = app.tenant_id() AND a.status = 'proposed' AND a.autonomy = 'requires_approval'
       AND a.trigger_ref->>'kind' = ANY (${[...AUTOMATED_DRAFT_TRIGGER_KINDS]}::text[]) AND ${who}
    RETURNING a.id`.execute(tx);
  const ids = r.rows.map((x) => x.id);
  if (ids.length === 0) return 0;
  await sql`
    UPDATE priority_feed_items SET state = 'done', resolved_at = ${toIso(now)}::timestamptz, snoozed_until = NULL, updated_at = now()
     WHERE tenant_id = app.tenant_id() AND assistant_action_id = ANY (${ids}::uuid[]) AND state IN ('open','snoozed')`.execute(tx);
  await sql`
    UPDATE playbook_step_runs SET status = 'skipped_ineligible', updated_at = now(),
           trigger_ref = trigger_ref || jsonb_build_object('skip', jsonb_build_object('reason', ${SOURCE_NO_AUTOMATED_CONTACT}::text, 'text', ${NO_AUTOMATED_CONTACT_SKIP_TEXT}::text))
     WHERE tenant_id = app.tenant_id() AND enrollment_id IS NULL AND assistant_action_id = ANY (${ids}::uuid[]) AND status = 'converted_to_draft'`.execute(tx);
  return ids.length;
}
