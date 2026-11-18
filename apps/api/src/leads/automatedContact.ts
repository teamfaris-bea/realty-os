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
//
// Owner decision 2026-11-14 (R-LSRC-9, migration 0101): an UNCLASSIFIED imported person gets none of this either. A
// person is unclassified while a committed import record of theirs carries a label that no lead source, or more than
// one, holds, or carries no label and the Owner has not classified that import's no-label group. It rides the SAME
// check: `noAutomatedContact` asks app.person_source_refusal and answers WHICH reason applies, so every path above
// refuses both, and each carries its own code and sentence (SOURCE_UNCLASSIFIED: the imported source has not been
// reviewed yet; an Owner reviews it under Lead sources). A marked source wins when both apply. Nothing here ever tells
// the team that the Owner turned a setting on when the person is only in review.
import { type Instant, toIso } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';

/** The code every non-AI-care path refuses or skips with for a marked source's person (AI care keeps AI_ISA_SOURCE_NO_AI_CARE). */
export const SOURCE_NO_AUTOMATED_CONTACT = 'SOURCE_NO_AUTOMATED_CONTACT';

/**
 * The code for an unclassified imported person (R-LSRC-9, owner decision 2026-11-14): a committed import record of
 * theirs has a label no lead source (or more than one) holds, or no label and an unclassified no-label group. AI care
 * uses AI_ISA_SOURCE_UNCLASSIFIED.
 */
export const SOURCE_UNCLASSIFIED = 'SOURCE_UNCLASSIFIED';

/** Why nothing automatic goes to a person: the two reasons app.person_source_refusal (0101) returns. */
export type SourceRefusal = typeof SOURCE_NO_AUTOMATED_CONTACT | typeof SOURCE_UNCLASSIFIED;
export const SOURCE_REFUSALS: readonly SourceRefusal[] = [SOURCE_NO_AUTOMATED_CONTACT, SOURCE_UNCLASSIFIED];

/** The setting's name, the same on the sources screen, the Owner's answer and every refusal. */
export const NO_AUTOMATED_CONTACT_LABEL = 'No automated contact for leads from this source';

/**
 * Why nothing automatic goes to the person, or null when automated contact is allowed. The ONE question every automated
 * path asks (the first response, every enrolment and resume, stage and deal-closed plans, bulk, triggers, invites, AI
 * care, AI calls, draft approval, dispatch TX1): app.person_source_refusal (a definer returning one code; 0101), in the
 * caller's transaction and tenant. SOURCE_NO_AUTOMATED_CONTACT: a source marked "No automated contact for leads from
 * this source" sent them (any record, any inquiry, any imported label or no-label group the Owner mapped to it; it wins).
 * SOURCE_UNCLASSIFIED: an import brought them in and the Owner has not reviewed that source yet. Truthy means refused,
 * so a caller that only needs yes or no reads it as a boolean; one that explains the refusal picks its words by the code.
 */
export async function noAutomatedContact(tx: Tx, contactId: string): Promise<SourceRefusal | null> {
  const r = await sql<{ why: string | null }>`SELECT app.person_source_refusal(app.tenant_id(), ${contactId}::uuid) AS why`.execute(tx);
  const why = r.rows[0]?.why ?? null;
  // any refusal the database names that this build does not know is still a refusal (fail closed, as the marked source)
  return why === null ? null : why === SOURCE_UNCLASSIFIED ? SOURCE_UNCLASSIFIED : SOURCE_NO_AUTOMATED_CONTACT;
}

/** The Owner's sentence for the setting, on the sources screen and in the Owner's answer (leads/sources.ts). */
export function noAutomatedContactSentence(on: boolean): string {
  return on
    ? `${NO_AUTOMATED_CONTACT_LABEL}: on. Nothing automatic reaches leads from this source (any record of the person): no instant reply, no plan, no bulk text, email or invite, no AI care and no AI-answered call. Plans and AI care already running for them stop or pause. People an import brought in count once the Owner maps their imported source label to this source. People on the team can still call, text and email them one to one. Only the Owner changes this.`
    : `${NO_AUTOMATED_CONTACT_LABEL}: off. Leads from this source get the team's automatic replies, plans and AI care as usual. Only the Owner changes this.`;
}

// ---- the words of each refusal, chosen by the reason (R-LSRC-9 A3) ----
//
// Every place that explains one of these refusals takes the reason and picks its sentence here. The unclassified
// sentences say what is true of a person in review: an import brought them in, their imported source has not been
// reviewed yet, and an Owner reviews it under Lead sources. They never name the Owner's setting.

/** What is true of an unclassified person, as a clause the sentences below share. */
const UNREVIEWED = 'this person came in from an import and their imported source has not been reviewed yet (an Owner reviews it under Lead sources)';
const cap = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/** The whole reason, on its own: a 409's details.sentence, the stage pill, a bulk row (SOURCE_UNCLASSIFIED). */
export const SOURCE_UNCLASSIFIED_SENTENCE = `${cap(UNREVIEWED)}, so nothing automatic goes to them. Call, text or email them one to one.`;
/** The same for a marked source's person (SOURCE_NO_AUTOMATED_CONTACT). */
export const SOURCE_NO_AUTOMATED_CONTACT_SENTENCE = `"${NO_AUTOMATED_CONTACT_LABEL}" is on for this person's lead source (an Owner setting), so nothing automatic goes to them. Call, text or email them one to one.`;
/** The refusal's own sentence (errors: details.sentence). */
export function sourceRefusalSentence(why: SourceRefusal): string {
  return why === SOURCE_UNCLASSIFIED ? SOURCE_UNCLASSIFIED_SENTENCE : SOURCE_NO_AUTOMATED_CONTACT_SENTENCE;
}

/** Why an automated or bulk message did not go (dispatch TX1's deny sentence, gateInput.ts DISPATCH_DENY_SENTENCES). */
export const NO_AUTOMATED_CONTACT_DENY_SENTENCE = `${NO_AUTOMATED_CONTACT_LABEL} is on for this person's lead source (an Owner setting), so this automatic or bulk message did not go out. Call, text or email them one to one.`;
export const SOURCE_UNCLASSIFIED_DENY_SENTENCE = `${cap(UNREVIEWED)}, so this automatic or bulk message did not go out. Call, text or email them one to one.`;
export function sourceDenySentence(why: SourceRefusal): string {
  return why === SOURCE_UNCLASSIFIED ? SOURCE_UNCLASSIFIED_DENY_SENTENCE : NO_AUTOMATED_CONTACT_DENY_SENTENCE;
}

/** The lead card's line when the 60-second first response is not sent (assistant/firstResponse.ts). */
export const NO_INSTANT_REPLY_SENTENCE = `No instant reply was sent: ${NO_AUTOMATED_CONTACT_LABEL} is on for their lead source (an Owner setting). Call, text or email them yourself.`;
export const UNCLASSIFIED_NO_INSTANT_REPLY_SENTENCE = `No instant reply was sent: ${UNREVIEWED}. Call, text or email them yourself.`;
export function noInstantReplySentence(why: SourceRefusal): string {
  return why === SOURCE_UNCLASSIFIED ? UNCLASSIFIED_NO_INSTANT_REPLY_SENTENCE : NO_INSTANT_REPLY_SENTENCE;
}

/** A module 26 trigger firing's skip text (nurture/decide.ts API_SKIP_TEXT). */
export const NO_AUTOMATED_CONTACT_SKIP_TEXT = `${NO_AUTOMATED_CONTACT_LABEL} is on for this person's lead source (an Owner setting), so this automatic message was not sent.`;
export const SOURCE_UNCLASSIFIED_SKIP_TEXT = `${cap(UNREVIEWED)}, so this automatic message was not sent.`;
export function sourceSkipText(why: SourceRefusal): string {
  return why === SOURCE_UNCLASSIFIED ? SOURCE_UNCLASSIFIED_SKIP_TEXT : NO_AUTOMATED_CONTACT_SKIP_TEXT;
}

/** An AI-answered call refused at the ring (voice/takeover.ts TAKEOVER_REFUSALS, after "The assistant did not answer: "). */
export const NO_AUTOMATED_CONTACT_CALL_REFUSAL = `"${NO_AUTOMATED_CONTACT_LABEL}" is on for this caller's lead source (an Owner setting), so a person on the team answers or calls them back.`;
export const SOURCE_UNCLASSIFIED_CALL_REFUSAL = 'this caller came in from an import and their imported source has not been reviewed yet (an Owner reviews it under Lead sources), so a person on the team answers or calls them back.';

/** The stop_reason of a plan the step runner stopped for such a person (assistant/enrollments.ts). */
export const NO_AUTOMATED_CONTACT_STOP_REASON = 'source_no_automated_contact';
export const SOURCE_UNCLASSIFIED_STOP_REASON = 'source_unclassified';
export type SourceStopReason = typeof NO_AUTOMATED_CONTACT_STOP_REASON | typeof SOURCE_UNCLASSIFIED_STOP_REASON;
/** A plan's stop_reason, a stage entry's skip reason and a 409's details.reason, by the refusal. */
export function sourceStopReason(why: SourceRefusal): SourceStopReason {
  return why === SOURCE_UNCLASSIFIED ? SOURCE_UNCLASSIFIED_STOP_REASON : NO_AUTOMATED_CONTACT_STOP_REASON;
}

/**
 * b18 round 3 item 2: "Resume automation" (POST /contacts/:id/automation/resume) for such a person lifts only the
 * conversation pause; their paused plans stay paused, and the answer says how many and why (by the reason).
 */
export function notResumedSentence(plans: number, why: SourceRefusal = SOURCE_NO_AUTOMATED_CONTACT): string {
  const n = plans === 1 ? '1 plan was' : `${plans} plans were`;
  return why === SOURCE_UNCLASSIFIED
    ? `${n} not resumed: ${UNREVIEWED}. Call, text or email them one to one.`
    : `${n} not resumed: "${NO_AUTOMATED_CONTACT_LABEL}" is on for this person's lead source (an Owner setting). Call, text or email them one to one.`;
}

/**
 * Which reason one of the invoker guards refused a write with, or null for any other error: a check_violation whose
 * message starts 'SOURCE_NO_AUTOMATED_CONTACT:' or 'SOURCE_UNCLASSIFIED:' (app.playbook_enrollments_source_guard,
 * app.messages_source_guard, app.calls_source_guard; 0098, 0100, 0101). A caller maps it to its own clear refusal
 * (comms/dispatch.ts a deny, comms/consent.ts a 409), so a change between a check and a write is never a 500.
 */
export function sourceGuardViolation(err: unknown): SourceRefusal | null {
  if (typeof err !== 'object' || err === null) return null;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code !== '23514' || typeof message !== 'string') return null;
  return SOURCE_REFUSALS.find((r) => message.startsWith(`${r}:`)) ?? null;
}
/** Whether an error is one of those guard refusals, for either reason. */
export function isSourceGuardViolation(err: unknown): boolean {
  return sourceGuardViolation(err) !== null;
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
/** The same for an unclassified person: 409 SOURCE_UNCLASSIFIED details.sentence. */
export const UNCLASSIFIED_DRAFT_REFUSAL = `This draft was written by a plan or an alert, and ${UNREVIEWED}, so it was withdrawn and nothing was sent. Call, text or email them one to one.`;
export function automatedDraftRefusalSentence(why: SourceRefusal): string {
  return why === SOURCE_UNCLASSIFIED ? UNCLASSIFIED_DRAFT_REFUSAL : AUTOMATED_DRAFT_REFUSAL;
}

/** The same tap on a draft withdrawn earlier, when the setting no longer covers the person (it stays withdrawn). */
export const AUTOMATED_DRAFT_WITHDRAWN_EARLIER = `This draft was written by a plan or an alert and was withdrawn while "${NO_AUTOMATED_CONTACT_LABEL}" was on for this person's lead source (an Owner setting). Nothing was sent. Write to them yourself.`;
/** A draft withdrawn while the person's imported source was not reviewed, tapped after the Owner reviewed it. */
export const UNCLASSIFIED_DRAFT_WITHDRAWN_EARLIER = 'This draft was written by a plan or an alert and was withdrawn while this person\'s imported source had not been reviewed yet. Nothing was sent. Write to them yourself.';
export function automatedDraftWithdrawnEarlierSentence(why: SourceRefusal): string {
  return why === SOURCE_UNCLASSIFIED ? UNCLASSIFIED_DRAFT_WITHDRAWN_EARLIER : AUTOMATED_DRAFT_WITHDRAWN_EARLIER;
}

/** The Owner's count of drafts withdrawn when the setting is turned on or a label is mapped (leads/sources.ts). */
export function withdrawnDraftsSentence(drafts: number): string {
  return `${drafts === 1 ? '1 draft a plan or an alert wrote for them was' : `${drafts} drafts a plan or an alert wrote for them were`} withdrawn.`;
}

/** The reason a draft's payload says it was withdrawn for (payload.withdrawn.reason), or null when it was not. */
export function withdrawnForSource(payload: Record<string, unknown> | null): SourceRefusal | null {
  const w = payload?.['withdrawn'];
  const reason = typeof w === 'object' && w !== null ? (w as { reason?: unknown }).reason : null;
  return SOURCE_REFUSALS.find((r) => r === reason) ?? null;
}

/**
 * Withdraws the pending drafts automation wrote for one person, for a set of people, or for every person a source sent:
 * each becomes `invalidated` with payload.withdrawn { reason, at }, its feed cards close, and a module 26 trigger run that
 * waited on it is skipped with the visible reason (never left as "drafted: it waits for the contact owner"). `why` is
 * the reason the person is refused for (a marked source's people: SOURCE_NO_AUTOMATED_CONTACT); it is written on the
 * draft and chooses the run's skip sentence. Returns how many were withdrawn. The caller is tenant-wide (the Owner on
 * the sources routes, or the system: intake, the import commit, the step runner, the trigger runner, the first response,
 * the approval's follow-up); RLS and the tenant filter bound it to this tenant.
 */
export async function withdrawAutomatedDrafts(tx: Tx, scope: { contactId: string } | { contactIds: readonly string[] } | { sourceId: string }, now: Instant, why: SourceRefusal = SOURCE_NO_AUTOMATED_CONTACT): Promise<number> {
  // one person: every record of them (the merge tree, app.contact_person_ids, as app.person_source_refusal reads it)
  const who = 'contactId' in scope
    ? sql`a.contact_id = ANY (app.contact_person_ids(app.tenant_id(), ${scope.contactId}::uuid))`
    : 'contactIds' in scope
      ? sql`a.contact_id = ANY (${[...scope.contactIds]}::uuid[])`
      : sql`a.contact_id IS NOT NULL AND app.person_from_lead_source(a.tenant_id, a.contact_id, ${scope.sourceId}::uuid)`;
  if ('contactIds' in scope && scope.contactIds.length === 0) return 0;
  const mark = JSON.stringify({ withdrawn: { reason: why, at: toIso(now) } });
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
           trigger_ref = trigger_ref || jsonb_build_object('skip', jsonb_build_object('reason', ${why}::text, 'text', ${sourceSkipText(why)}::text))
     WHERE tenant_id = app.tenant_id() AND enrollment_id IS NULL AND assistant_action_id = ANY (${ids}::uuid[]) AND status = 'converted_to_draft'`.execute(tx);
  return ids.length;
}
