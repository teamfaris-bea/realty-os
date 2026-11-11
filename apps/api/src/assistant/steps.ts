// Building one playbook step into a queued assistant message (ARCHITECTURE §11 "within_playbook";
// R-AST-3, R-AST-5, R-AST-11, R-GATE-3, R-GATE-4, R-GATE-12).
//
// At BUILD time the step is rendered exactly as it will be sent (core.renderStep: sign-off, first-message
// brokerage name + STOP line, brokerage name on marketing), then pre-checked with the same
// core.authorizeAutonomousAction that dispatch re-runs at SEND time. Allowed ⇒ an `autonomous_message`
// (within_playbook) and a queued message whose comms.dispatch job runs the send-time gate. Not allowed
// (money/contract topic, a human claim, the category switched off, ...) ⇒ a `message_draft` for the
// agent with the reason, and the step run is `converted_to_draft` (never sent without a tap, E35).
// Needs-review values never fill a slot (core.renderStep refuses them, R-AST-5).
import {
  INTENT_RULES,
  type PlaybookStep,
  type SlotValues,
  authorizeAutonomousAction,
  classifyAction,
  downgradeExplanation,
  formatAppointment,
  formatDue,
  renderStep,
  signOffFor,
} from '@realty/core/assistant';
import type { ActionCategory } from '@realty/core/compliance';
import type { IanaZone, Instant } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { sql } from 'kysely';
import { queueOutboundInTx } from '../comms/index.js';
import { resolvedPolicy } from '../comms/gateInput.js';
import * as A from './repos/actions.js';
import { type ContactCore, firstNameOf, identityFacts, latestInquiry } from './repos/context.js';
import * as P from './repos/playbooks.js';
import type { AssistantDeps, StepOutcome } from './types.js';

/** How long after queuing a step the enrollment is looked at again (to advance once the message went out). */
export const CHECK_BACK_MS = 2 * 60_000;

/**
 * Marketing email needs an unsubscribe mechanism in the body (gate: UNSUBSCRIBE_MISSING); dispatch adds
 * the one-click List-Unsubscribe headers. A link to our own unsubscribe page cannot be in the body of an
 * AUTONOMOUS email, because the send-time content guard treats every link host as unknown (comms passes
 * no allowed hosts). VERIFY WITH COUNSEL: CAN-SPAM "clear and conspicuous" opt-out wording.
 */
export const EMAIL_UNSUBSCRIBE_LINE = 'To unsubscribe from these emails, use the unsubscribe option your email app shows for this message.';

export async function firstInThread(tx: Tx, contactId: string): Promise<boolean> {
  const r = await sql<{ x: boolean }>`
    SELECT EXISTS (SELECT 1 FROM messages m JOIN conversations c ON c.tenant_id = m.tenant_id AND c.id = m.conversation_id
                    WHERE m.tenant_id = app.tenant_id() AND c.contact_id = ${contactId} AND m.direction = 'outbound' AND NOT m.imported
                      AND m.status IN ('dispatching','sent','delivered')) AS x`.execute(tx);
  return r.rows[0]?.x !== true;
}

export interface Anchor {
  kind: 'deal' | 'appointment' | 'task';
  id: string;
}

export interface AnchorFacts {
  eventAt: Instant | null;
  canceled: boolean;
  appointmentAt: Instant | null;
  appointmentPlace: string | null;
  documentName: string | null;
  closedAt: Instant | null;
}

const dealOfContact = (contactId: string) => sql`(d.primary_contact_id = ${contactId}
  OR EXISTS (SELECT 1 FROM deal_contacts dc WHERE dc.tenant_id = d.tenant_id AND dc.deal_id = d.id AND dc.contact_id = ${contactId}))`;

/**
 * Whether an enrollment anchor is this contact's own event (read in the caller's transaction, so under the
 * requesting user's RLS for a human enrollment). An anchor's details (place, time, document name) are
 * rendered into the contact's message, so an event of another contact is never an anchor.
 */
export async function anchorBelongsTo(tx: Tx, contactId: string, anchor: Anchor): Promise<boolean> {
  const r =
    anchor.kind === 'appointment'
      ? await sql<{ x: boolean }>`SELECT EXISTS (SELECT 1 FROM appointments WHERE tenant_id = app.tenant_id() AND id = ${anchor.id} AND contact_id = ${contactId}) AS x`.execute(tx)
      : anchor.kind === 'task'
        ? await sql<{ x: boolean }>`SELECT EXISTS (SELECT 1 FROM tasks WHERE tenant_id = app.tenant_id() AND id = ${anchor.id} AND contact_id = ${contactId}) AS x`.execute(tx)
        : await sql<{ x: boolean }>`SELECT EXISTS (SELECT 1 FROM deals d WHERE d.tenant_id = app.tenant_id() AND d.id = ${anchor.id} AND ${dealOfContact(contactId)}) AS x`.execute(tx);
  return r.rows[0]?.x === true;
}

export async function anchorFacts(tx: Tx, e: { anchorKind: Anchor['kind'] | null; anchorId: string | null; enrolledBy: string; contactId: string }): Promise<AnchorFacts> {
  const none: AnchorFacts = { eventAt: null, canceled: false, appointmentAt: null, appointmentPlace: null, documentName: null, closedAt: null };
  if (e.anchorKind === 'appointment' && e.anchorId) {
    const r = await sql<{ starts_at: Date; status: string; location: string | null }>`SELECT starts_at, status, location FROM appointments WHERE tenant_id = app.tenant_id() AND id = ${e.anchorId} AND contact_id = ${e.contactId}`.execute(tx);
    const a = r.rows[0];
    if (!a) return none;
    const at = a.starts_at.getTime() as Instant;
    return { ...none, eventAt: at, appointmentAt: at, appointmentPlace: a.location, canceled: a.status === 'canceled' || a.status === 'rescheduled' };
  }
  if (e.anchorKind === 'task' && e.anchorId) {
    const r = await sql<{ due_at: Date | null; status: string; title: string }>`SELECT due_at, status, title FROM tasks WHERE tenant_id = app.tenant_id() AND id = ${e.anchorId} AND contact_id = ${e.contactId}`.execute(tx);
    const t = r.rows[0];
    if (!t) return none;
    return { ...none, eventAt: t.due_at ? (t.due_at.getTime() as Instant) : null, documentName: t.title, canceled: t.status === 'canceled' };
  }
  const dealId = e.anchorKind === 'deal' ? e.anchorId : null;
  if (dealId || e.enrolledBy === 'deal_closed') {
    const r = dealId
      ? await sql<{ closed_at: Date | null; stage: string }>`SELECT closed_at, stage FROM deals d WHERE d.tenant_id = app.tenant_id() AND d.id = ${dealId} AND ${dealOfContact(e.contactId)}`.execute(tx)
      : await sql<{ closed_at: Date | null; stage: string }>`
          SELECT closed_at, stage FROM deals WHERE tenant_id = app.tenant_id() AND primary_contact_id = ${e.contactId} AND stage = 'closed'
           ORDER BY closed_at DESC NULLS LAST LIMIT 1`.execute(tx);
    const d = r.rows[0];
    if (!d) return none;
    const closed = d.closed_at ? (d.closed_at.getTime() as Instant) : null;
    return { ...none, eventAt: closed, closedAt: closed, canceled: d.stage === 'lost' };
  }
  return none;
}

export async function slotsFor(tx: Tx, c: ContactCore, teamName: string, brokerage: string, anchor: AnchorFacts, now: Instant): Promise<SlotValues> {
  const inq = await latestInquiry(tx, c.id);
  const s: SlotValues = {
    first_name: c.firstName?.trim() || 'there',
    team_name: teamName,
    brokerage_name: brokerage,
  };
  const agent = await firstNameOf(tx, c.ownerUserId);
  if (agent) s.agent_first_name = agent;
  const property = inq?.listingAddress ?? inq?.propertyText ?? null;
  if (property) s.inquiry_property = property;
  if (inq?.vaLoanIndicated) s.va_question = 'yes';
  if (anchor.appointmentAt !== null) s.appointment_time = formatAppointment(anchor.appointmentAt, c.zone);
  if (anchor.appointmentPlace) s.appointment_place = anchor.appointmentPlace;
  if (anchor.documentName) s.document_name = anchor.documentName;
  if (anchor.eventAt !== null && anchor.documentName) s.due_date = formatDue(anchor.eventAt, true, c.zone as IanaZone);
  if (anchor.closedAt !== null) s.home_years = String(Math.max(1, Math.round((now - anchor.closedAt) / (365.25 * 86_400_000))));
  return s;
}

export interface BuildInput {
  enrollment: P.EnrollmentRow;
  playbook: P.PlaybookRow;
  version: P.VersionRow;
  /** the step as it will go out on its channel (core.stepForChannel already applied) */
  step: PlaybookStep;
  /** an existing scheduled step run without a message (rebuilt after a version migration) */
  existingRunId: string | null;
  contact: ContactCore;
  anchor: AnchorFacts;
  now: Instant;
  firstResponse?: boolean;
  /** the card's one-line why (default: which playbook step this is) */
  explanation?: string;
  /**
   * Module 22 (flagged edit, R-INBOX-4): an `inbound_channel` step goes out where the lead wrote: 'web_chat' (the
   * first response in the lead's open website chat, to that chat identity). Absent ⇒ such a step is skipped.
   */
  sendChannel?: 'web_chat';
  toPointId?: string | undefined;
}

/** Builds, authorizes and queues (or drafts) ONE step. Caller holds the contact lock. */
export async function buildStep(tx: Tx, deps: AssistantDeps, tenantId: string, b: BuildInput): Promise<StepOutcome> {
  const { step, contact, now } = b;
  const identity = await identityFacts(tx, { scope: b.playbook.scope, agentUserId: b.playbook.ownerUserId });
  const first = await firstInThread(tx, contact.id);
  const slots = await slotsFor(tx, contact, identity.teamName, identity.brokerageLegalName, b.anchor, now);
  const rendered = renderStep(step, slots, { signOff: signOffFor(identity), brokerageName: identity.brokerageLegalName, firstInThread: first, postalAddress: identity.brokeragePostalAddress, unsubscribeUrl: null });
  const runId = b.existingRunId ?? deps.ids.next<'PlaybookStepRunId'>();
  const ownerForDraft = contact.ownerUserId ?? b.playbook.ownerUserId;
  if (!rendered.ok) {
    await upsertRun(tx, b, runId, 'skipped_ineligible', null);
    return { kind: 'skipped', stepKey: step.stepKey, reason: `${rendered.code}:${rendered.slot}` };
  }
  // core module 25 added the `inbound_channel` step channel (R-INBOX-4). Module 22: it goes out in web chat when
  // the caller resolved where the lead wrote (b.sendChannel); otherwise it is skipped visibly and never sent on
  // another channel.
  if (step.channel === 'inbound_channel' && b.sendChannel !== 'web_chat') {
    await upsertRun(tx, b, runId, 'skipped_ineligible', null);
    return { kind: 'skipped', stepKey: step.stepKey, reason: 'STEP_CHANNEL_UNAVAILABLE' };
  }
  let text = rendered.text;
  if (step.channel === 'email' && step.purpose === 'marketing') text = `${text}\n${EMAIL_UNSUBSCRIBE_LINE}`;
  const { policy } = await resolvedPolicy(tx);
  const intentCheck = INTENT_RULES[step.intent].purpose === step.purpose ? 'match' : 'mismatch';
  const verdict = authorizeAutonomousAction({
    category: step.category,
    playbookVersion: { status: b.version.status, contentSha256: b.version.contentSha256 },
    latestApproval: await P.latestApproval(tx, b.version.id),
    tenantAutonomous: policy.autonomous,
    step,
    rendered: text,
    intentCheck,
    identity,
    firstInThread: first,
  });
  const conv = await sql<{ s: string }>`SELECT inbound_seq AS s FROM conversations WHERE tenant_id = app.tenant_id() AND contact_id = ${contact.id}`.execute(tx);
  const pinned = conv.rows[0] ? Number(conv.rows[0].s) : 0;
  const actionId = deps.ids.next<'AssistantActionId'>();
  const env = { envelope: deps.envelope, tenantId, ids: deps.ids };
  const payload = { channel: step.channel, body: text, ...(rendered.subject ? { subject: rendered.subject } : {}), stepKey: step.stepKey, playbookId: b.playbook.id };
  const trigger = { kind: 'playbook_step', enrollmentId: b.enrollment.id };

  if (!verdict.allow) {
    if (verdict.downgrade === 'PAYMENT_INSTRUCTIONS' || !ownerForDraft) {
      // wiring details are never sendable, with or without a tap (R-GATE-7); with nobody to hand a draft to, skip visibly
      await upsertRun(tx, b, runId, 'skipped_ineligible', null);
      return { kind: 'skipped', stepKey: step.stepKey, reason: verdict.downgrade };
    }
    const cls = classifyAction({ kind: 'autonomous_message', category: (verdict.category ?? step.category) as never, authorized: false, playbookVersionId: b.version.id });
    await A.insertAction(tx, env, {
      id: actionId,
      contactId: contact.id,
      kind: cls.kind,
      category: cls.category,
      autonomy: 'requires_approval',
      playbookVersionId: null,
      status: 'proposed',
      ownerUserId: ownerForDraft,
      explanation: downgradeExplanation(verdict.downgrade, verdict.category),
      payload: { ...payload, downgrade: verdict.downgrade },
      pinnedInboundSeq: pinned,
      boundOwnershipSeq: contact.ownerUserId === ownerForDraft ? contact.periodSeq : null,
      aiRunId: null,
      triggerRef: trigger,
      dedupeKey: `step_draft:${runId}:${b.version.id}`,
      claims: [],
    });
    await upsertRun(tx, b, runId, 'converted_to_draft', actionId);
    await A.upsertFeed(tx, deps.ids, { userId: ownerForDraft, itemType: 'assistant_draft', contactId: contact.id, subjectType: 'assistant_action', subjectId: actionId, assistantActionId: actionId, score: cls.category === 'money' || cls.category === 'contract' ? 75 : 55, reasons: [{ code: 'NEEDS_YOUR_TAP', text: downgradeExplanation(verdict.downgrade, verdict.category) }], dedupeKey: `draft:${actionId}` });
    return { kind: 'drafted', actionId, stepKey: step.stepKey, reason: verdict.downgrade };
  }

  await A.insertAction(tx, env, {
    id: actionId,
    contactId: contact.id,
    kind: 'autonomous_message',
    category: step.category,
    autonomy: 'within_playbook',
    playbookVersionId: b.version.id,
    status: 'proposed',
    ownerUserId: contact.ownerUserId,
    explanation: b.explanation ?? `Step "${step.stepKey}" of the approved playbook "${b.playbook.name}".`,
    payload,
    pinnedInboundSeq: pinned,
    boundOwnershipSeq: contact.periodSeq,
    aiRunId: null,
    triggerRef: trigger,
    dedupeKey: `step:${runId}:${b.version.id}`,
    claims: [],
  });
  await upsertRun(tx, b, runId, 'scheduled', actionId);
  const q = await queueOutboundInTx(tx, deps, {
    contactId: contact.id,
    channel: step.channel === 'inbound_channel' ? 'web_chat' : step.channel,
    ...(step.channel === 'inbound_channel' && b.toPointId ? { toPointId: b.toPointId } : {}),
    body: text,
    ...(step.channel === 'email' ? { subject: rendered.subject ?? 'A note from your agent' } : {}),
    initiator: 'assistant',
    purpose: step.purpose,
    category: step.category as ActionCategory as never,
    assistantActionId: actionId,
    playbookStepRunId: runId,
    idempotencyKey: `playbook-step:${runId}:${b.version.id}`,
    firstResponse: b.firstResponse === true,
  }, now);
  if (!q.ok) {
    await A.setStatus(tx, actionId, 'blocked');
    await P.updateStepRun(tx, runId, { status: 'skipped_ineligible' });
    return { kind: 'skipped', stepKey: step.stepKey, reason: q.code };
  }
  await P.updateStepRun(tx, runId, { status: 'scheduled', messageId: q.messageId });
  return { kind: 'queued', messageId: q.messageId, actionId, stepKey: step.stepKey };
}

async function upsertRun(tx: Tx, b: BuildInput, runId: string, status: P.StepRunRow['status'], actionId: string | null): Promise<void> {
  if (b.existingRunId) await P.updateStepRun(tx, runId, { status, actionId, versionId: b.version.id, scheduledFor: b.now });
  else await P.insertStepRun(tx, { id: runId, enrollmentId: b.enrollment.id, versionId: b.version.id, stepKey: b.step.stepKey, status, scheduledFor: b.now, actionId });
}
