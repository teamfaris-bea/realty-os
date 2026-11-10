// The 60-second first response (ARCHITECTURE §11; R-AST-15, R-AST-16; core-compliance/2.0.0).
//
// Lead intake (api/leads) enqueues assistant.first_response (realtime) in the intake transaction. This
// handler, as the system actor under the contact lock:
//   - core.planFirstResponse: ONE message from the team `new_lead_response` playbook, only when that
//     playbook is approved and `speed_to_lead_reply` is enabled; SMS to the lead's mobile unless that
//     number (or another of the lead's phones) opted out or is suppressed, otherwise email (if not opted
//     out / suppressed); deduped per contact per 24 h. No consent level is read (owner decision).
//   - enrolls the contact (enrolled_by new_lead) and builds the step like any playbook step (steps.ts):
//     sign-off "— the {Team} assistant", brokerage name and "Reply STOP to opt out" on the first text.
//   - the message's comms.dispatch job (realtime) gates it at SEND time (opt-out, pause, sender) and it
//     goes at once.
// When nothing may be sent, nothing is sent, and the lead's open feed card says why. The first response
// never counts as a touch (R-AST-15): it is an assistant message, and only gate-allowed HUMAN sends are
// touches (dispatch records them).
import { type PlaybookStep, PlaybookStepSchema, planEnroll, planFirstResponse, stepForChannel } from '@realty/core/assistant';
import { optedOut } from '@realty/core/compliance';
import type { ContactId, Instant, SystemActor } from '@realty/core/foundation';
import { plusMs } from '@realty/core/foundation';
import { type Tx, lockContact, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { resolvedPolicy } from '../comms/gateInput.js';
import { consentRows, contactPoints, suppressionRows } from '../comms/repos/gate.js';
import { enqueueStep } from './enrollments.js';
import { contactCore } from './repos/context.js';
import * as P from './repos/playbooks.js';
import { CHECK_BACK_MS, anchorFacts, buildStep } from './steps.js';
import type { AssistantDeps, StepOutcome } from './types.js';

async function lastFirstResponseAt(tx: Tx, contactId: string): Promise<Instant | null> {
  const r = await sql<{ at: Date | null }>`
    SELECT max(created_at) AS at FROM assistant_actions
     WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND action_category = 'speed_to_lead_reply'
       AND kind IN ('autonomous_message','message_draft') AND status NOT IN ('blocked','superseded')`.execute(tx);
  return r.rows[0]?.at ? (r.rows[0].at.getTime() as Instant) : null;
}

/** "The feed card says why": the lead's open offer / first-touch card gains the reason (no new card). */
async function explainOnLeadCard(tx: Tx, contactId: string, code: string, text: string): Promise<void> {
  await sql`
    UPDATE priority_feed_items SET reasons = reasons || ${JSON.stringify([{ code, text }])}::jsonb, updated_at = now()
     WHERE tenant_id = app.tenant_id() AND contact_id = ${contactId} AND state IN ('open','snoozed')
       AND item_type IN ('lead_offer','first_touch_due','pond_new')
       AND NOT reasons @> ${JSON.stringify([{ code }])}::jsonb`.execute(tx);
}

export async function sendFirstResponseInTx(tx: Tx, deps: AssistantDeps, tenantId: string, contactId: string, now: Instant): Promise<StepOutcome> {
  await lockContact(tx, contactId as ContactId);
  const c = await contactCore(tx, contactId);
  if (!c || c.deleted) return { kind: 'noop', reason: 'CONTACT_MISSING' };
  const pb = await P.teamPlaybookOfKind(tx, 'new_lead_response');
  const version = pb ? await P.approvedVersionOf(tx, pb.id) : null;
  const raw = version?.steps[0];
  const parsed = raw === undefined ? null : PlaybookStepSchema.safeParse(raw);
  const step: PlaybookStep | null = parsed?.success ? parsed.data : null;
  const { policy } = await resolvedPolicy(tx);
  const points = await contactPoints(tx, contactId);
  const phone = points.find((p) => p.kind === 'phone' && p.status === 'active') ?? null;
  const email = points.find((p) => p.kind === 'email' && p.status === 'active') ?? null;
  const purpose = step?.purpose ?? 'informational';
  let smsBlocked = false;
  if (phone) {
    // the gate's SMS opt-out rule: a STOP on any of the lead's phones blocks texting all of them
    const rows = await consentRows(tx, 'sms', points.filter((p) => p.kind === 'phone').map((p) => p.hmac));
    const sup = await suppressionRows(tx, phone.hmac);
    smsBlocked = optedOut(rows, 'sms', purpose, phone.hmac) || sup.some((s) => s.liftedAt === null && (s.channel === 'sms' || s.channel === 'all'));
  }
  let emailBlocked = false;
  if (email) {
    const rows = await consentRows(tx, 'email', [email.hmac]);
    const sup = await suppressionRows(tx, email.hmac);
    emailBlocked = optedOut(rows, 'email', purpose, email.hmac) || sup.some((s) => s.liftedAt === null && (s.channel === 'email' || s.channel === 'all'));
  }
  const plan = planFirstResponse({
    now,
    version: version ? { status: version.status, contentSha256: version.contentSha256 } : null,
    latestApproval: version ? await P.latestApproval(tx, version.id) : null,
    step,
    tenantAutonomous: policy.autonomous,
    sms: { reachable: phone !== null && phone.lineType !== 'landline', revokedOrSuppressed: smsBlocked },
    email: { reachable: email !== null, revokedOrSuppressed: emailBlocked },
    lastFirstResponseAt: await lastFirstResponseAt(tx, contactId),
  });
  if (!plan.send) {
    if (plan.reason === 'NO_ALLOWED_CHANNEL') await explainOnLeadCard(tx, contactId, 'NO_INSTANT_REPLY', plan.explanation);
    return { kind: 'not_sent', reason: plan.reason, explanation: plan.explanation };
  }
  const live = await P.liveEnrollmentOf(tx, contactId);
  const enroll = planEnroll({ live: live ? { enrollmentId: live.id, playbookId: live.playbookId } : null, target: { playbookId: pb!.id, versionApproved: true }, confirmedReplace: false });
  if (!enroll.ok) {
    // the system never replaces an enrollment silently (R-AST-8)
    const explanation = 'No instant reply was sent: this lead is already in another playbook.';
    await explainOnLeadCard(tx, contactId, 'NO_INSTANT_REPLY', explanation);
    return { kind: 'not_sent', reason: enroll.code, explanation };
  }
  const enrollmentId = deps.ids.next<'EnrollmentId'>();
  await P.insertEnrollment(tx, { id: enrollmentId, playbookId: pb!.id, versionId: version!.id, contactId, enrolledBy: 'new_lead', userId: null, dueAt: null, anchor: null });
  const e = (await P.enrollmentById(tx, enrollmentId))!;
  const channelStep = stepForChannel(step!, plan.channel)!;
  const out = await buildStep(tx, deps, tenantId, {
    enrollment: e,
    playbook: pb!,
    version: version!,
    step: channelStep,
    existingRunId: null,
    contact: c,
    anchor: await anchorFacts(tx, { anchorKind: null, anchorId: null, enrolledBy: 'new_lead', contactId }),
    now,
    firstResponse: true,
    explanation: plan.explanation,
  });
  // look again after the send so the one-step enrollment completes
  const back = plusMs(now, CHECK_BACK_MS);
  await P.scheduleEnrollment(tx, enrollmentId, back, out.kind === 'queued' ? 0 : 1);
  await enqueueStep(tx, enrollmentId, back);
  if (out.kind !== 'queued' && out.kind !== 'drafted') await explainOnLeadCard(tx, contactId, 'NO_INSTANT_REPLY', `No instant reply was sent (${out.kind === 'skipped' ? out.reason : out.kind}).`);
  return out;
}

/** BUILD_PLAN interface: new_lead_response, ≤ 60 s (the realtime job + the realtime dispatch job). */
export async function sendFirstResponse(actor: SystemActor, contactId: string, deps: AssistantDeps): Promise<StepOutcome> {
  return withTenantTx(actor, (tx, now) => sendFirstResponseInTx(tx, deps, actor.tenantId, contactId, now), { db: deps.db, retries: 2 });
}
