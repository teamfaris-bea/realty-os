// Module 28's operations on one seller update (PHASE2_3_PLAN §5.4 #28; R-SELL-3, R-SELL-4, R-SELL-5,
// R-AST-17, R-AST-21; E88, E89).
//
//   view         the assembled update with every figure's source and date, the recipients and who cannot
//                be reached (before any tap), and whether the data moved since assembly (stale)
//   patch        the agent's own choices on the unsent draft: their recommendation (never prefilled) and
//                the feedback items they removed (E89)
//   reassemble   one tap: re-read the data for the same period (the draft's watermark moves)
//   send         approve-and-send, the seller-update branch of assistant approve (drafts.ts):
//     A  as the agent (RLS)  their own proposed draft of a listing they are still the agent of (another agent:
//                            NOT_FOUND; the listing changed agent: DRAFT_INVALIDATED); a recommendation of at
//                            least 20 characters (SELLER_UPDATE_NEEDS_RECOMMENDATION, E88); the recipients
//                            now, which must equal what the agent was shown (SELLER_UPDATE_RECIPIENTS_CHANGED:
//                            an opt-out is shown before the tap, never discovered after it); at least one
//                            reachable seller (SELLER_UPDATE_NO_RECIPIENT)
//     B  as the system       re-assemble the same period and compare the hash: any change to showings,
//                            feedback, marketing or competing data after `assembled_through` is
//                            SELLER_UPDATE_STALE and nothing is approved or sent
//     C  as the agent        lock, still proposed → approved by the agent (the 0018 CHECK needs
//                            edited_payload.recommendation ≥ 20; the decision guard binds it to the agent);
//                            one approved per-seller send action (message_draft, category seller_update,
//                            bound to that contact's owner and ownership period like every approved draft,
//                            so dispatch's R-AST-7 check holds: the handback-reply pattern); audited
//                            (draft.approved_with_edits, PII redacted); the feed card closes
//     D  as the system       one informational message per reachable seller, queued with idempotency key
//                            seller-update:{action}:{contact} (initiator assistant, its send action)
//     E  dispatchOutbound    the send-time gate decides each one (opt-outs, D1: no override)
// A repeated tap after C resumes D/E (the keys make it idempotent) and reports the same messages.
// Assembly reads as the system both times so the hash compares like with like; the agent sees only the
// assembled counts and the feedback text members may read.
import type { Instant, UserActor } from '@realty/core/foundation';
import { recommendationOk } from '@realty/core/marketing';
import { type Tx, lockContact } from '@realty/db';
import { sql } from 'kysely';
import * as A from '../assistant/repos/actions.js';
import type { AssistantDeps } from '../assistant/types.js';
import { audit, redactDiff } from '../audit.js';
import { dispatchOutbound, queueOutboundInTx } from '../comms/index.js';
import { renderHumanBody } from '../comms/render.js';
import { tenantFacts } from '../comms/repos/gate.js';
import { asSystem, asUser } from '../comms/runtime.js';
import { AppError } from '../errors.js';
import { senderSignature } from '../templates/repos/signature.js';
import { assemble, fmtPeriod, listingHead, sellerText } from './assembly.js';
import { type RecipientView, recipientsOf } from './recipients.js';
import { type AgentChoices, type SellerUpdatePayload, payloadOf, periodOf, replaceAssembly } from './store.js';

/** R-SELL-3: the shortest recommendation the 0018 CHECK accepts (core recommendationOk counts it). */
export const RECOMMENDATION_MIN = 20;

export interface EvidenceItem {
  sourceType: string;
  sourceId: string;
  label: string;
}

export interface SectionView {
  kind: string;
  title: string;
  state: string;
  statement: string;
  lines: { text: string; feedback: { feedbackId: string; namesPerson: boolean; excluded: boolean } | null }[];
  sources: { text: string; evidence: EvidenceItem[] }[];
}

export interface SellerUpdateView {
  id: string;
  listingId: string;
  address: string;
  status: string;
  ownerUserId: string | null;
  /** the caller is the draft's owner and it is unsent */
  canSend: boolean;
  period: { start: string; end: string; key: string; label: string; text: string };
  assembledThrough: string;
  /** the data changed since assembly (SELLER_UPDATE_STALE on send): reassemble first */
  stale: boolean;
  sections: SectionView[];
  recommendation: string;
  excludedFeedbackIds: string[];
  recipients: RecipientView[];
  preview: { channel: 'email' | 'sms'; subject: string; body: string };
  sentAt: string | null;
}

export interface SendInput {
  commandId: string;
  recommendation?: string | undefined;
  excludedFeedbackIds?: string[] | undefined;
  /** the seller contacts the agent was shown as reachable; when given, they must still be exactly those */
  recipientIds?: string[] | undefined;
}

export interface RecipientOutcome {
  contactId: string;
  messageId: string | null;
  result: 'sent' | 'queued' | 'blocked' | 'failed' | 'dispatch_unknown' | 'noop' | 'not_queued';
}

export interface SendResult {
  actionId: string;
  status: string;
  result: 'sent' | 'queued' | 'blocked' | 'failed' | 'dispatch_unknown' | 'noop';
  messageId: string | null;
  recipients: RecipientOutcome[];
}

const sendKey = (actionId: string, contactId: string) => `seller-update:${actionId}:${contactId}`;

function isSellerUpdate(a: A.ActionRow): a is A.ActionRow & { payload: Record<string, unknown> } {
  return a.kind === 'seller_update_draft' && typeof a.triggerRef['listing_id'] === 'string' && typeof a.payload['dataSha256'] === 'string';
}

/** A listing-bound seller-update draft (module 28's shape); false for anything else. */
export function isListingSellerUpdate(a: Pick<A.ActionRow, 'kind' | 'triggerRef' | 'payload'>): boolean {
  return isSellerUpdate(a as A.ActionRow);
}

function choicesOf(a: A.ActionRow): AgentChoices {
  const e = a.editedPayload ?? {};
  return {
    recommendation: typeof e['recommendation'] === 'string' ? (e['recommendation'] as string) : '',
    excludedFeedbackIds: Array.isArray(e['excludedFeedbackIds']) ? (e['excludedFeedbackIds'] as unknown[]).filter((x): x is string => typeof x === 'string') : [],
  };
}

async function ownDraft(tx: Tx, actor: UserActor, actionId: string, o: { lock?: boolean; mine?: boolean } = {}): Promise<A.ActionRow & { payload: Record<string, unknown> }> {
  const a = await A.actionById(tx, actionId, o.lock ? { lock: true } : {});
  if (!a || !isSellerUpdate(a)) throw new AppError('NOT_FOUND');
  if (o.mine !== false && a.ownerUserId !== actor.userId) throw new AppError('NOT_FOUND');
  return a;
}

async function displayName(tx: Tx): Promise<string | null> {
  const r = await sql<{ n: string | null }>`SELECT display_name AS n FROM users WHERE id = app.user_id()`.execute(tx);
  return r.rows[0]?.n ?? null;
}

const SOURCE_LABEL: Record<string, string> = {
  showing: 'Showing log',
  showing_feedback: 'Feedback log',
  marketing_activity: 'Marketing your team logged',
  message: 'Invite email',
  listing: 'Listing record',
};

function evidenceLabel(e: { sourceType: string; locator: Record<string, unknown>; snippet: string | null }): string {
  const what = SOURCE_LABEL[e.sourceType] ?? 'Record';
  const field = typeof e.locator['name'] === 'string' ? (e.locator['name'] as string) : '';
  if (e.sourceType === 'listing' && field.endsWith('.count')) return `${what}: ${e.snippet ?? '0'} logged`;
  if (e.sourceType === 'listing' && field.startsWith('marketing_pieces.')) return 'Marketing piece: published';
  return e.snippet ? `${what}: ${e.snippet}` : what;
}

async function sectionViews(tx: Tx, a: A.ActionRow, payload: SellerUpdatePayload, excluded: readonly string[]): Promise<SectionView[]> {
  const claims = await A.claimsOf(tx, [a.id]);
  return payload.sections.map((s) => ({
    kind: s.kind,
    title: s.title,
    state: s.state,
    statement: s.statement,
    lines: s.lines.map((l) => ({ text: l.text, feedback: l.feedback ? { feedbackId: l.feedback.feedbackId, namesPerson: l.feedback.namesPerson, excluded: excluded.includes(l.feedback.feedbackId) } : null })),
    sources: claims
      .filter((c) => c.ordinal >= (payload.claimOrdinalFrom ?? 0) && (c.structured as { section?: string } | null)?.section === s.kind)
      .map((c) => ({ text: c.text, evidence: c.evidence.map((e) => ({ sourceType: e.sourceType, sourceId: e.sourceId, label: evidenceLabel({ sourceType: e.sourceType, locator: e.locator as Record<string, unknown>, snippet: e.snippet }) })) })),
  }));
}

/** Re-assembles the draft's period as the system and says whether the shown data still holds. */
async function freshHash(deps: AssistantDeps, tenantId: string, payload: SellerUpdatePayload): Promise<string> {
  return asSystem(deps, tenantId, 'worker', async (tx, now) => (await assemble(tx, payload.listingId, periodOf(payload.period), now)).dataSha256);
}

async function viewOf(tx: Tx, actor: UserActor, a: A.ActionRow & { payload: Record<string, unknown> }, stale: boolean, now: Instant): Promise<SellerUpdateView> {
  const payload = a.payload as unknown as SellerUpdatePayload;
  const head = await listingHead(tx, payload.listingId);
  if (!head) throw new AppError('NOT_FOUND');
  const choices = choicesOf(a);
  const recipients = await recipientsOf(tx, payload.listingId, now);
  const period = periodOf(payload.period);
  const firstSendable = recipients.find((r) => r.sendable);
  const channel = firstSendable?.channel ?? payload.channel;
  const text = sellerText({ address: head.addressLine1, period, sections: payload.sections, excludedFeedbackIds: choices.excludedFeedbackIds ?? [], recommendation: choices.recommendation || null, agentName: null });
  const sent = a.status === 'approved' || a.status === 'executed' ? await sql<{ at: Date | null }>`SELECT decided_at AS at FROM assistant_actions WHERE tenant_id = app.tenant_id() AND id = ${a.id}`.execute(tx) : null;
  return {
    id: a.id,
    listingId: payload.listingId,
    address: head.addressLine1,
    status: a.status,
    ownerUserId: a.ownerUserId,
    canSend: a.status === 'proposed' && a.ownerUserId === actor.userId && head.listingAgentUserId === actor.userId,
    period: { ...payload.period, text: fmtPeriod(period) },
    assembledThrough: payload.assembledThrough,
    stale,
    sections: await sectionViews(tx, a, payload, choices.excludedFeedbackIds ?? []),
    recommendation: choices.recommendation ?? '',
    excludedFeedbackIds: choices.excludedFeedbackIds ?? [],
    recipients,
    preview: { channel, subject: text.subject, body: text.body },
    sentAt: sent?.rows[0]?.at ? sent.rows[0].at.toISOString() : null,
  };
}

/** GET /seller-updates/:id */
export async function sellerUpdateView(actor: UserActor, actionId: string, deps: AssistantDeps): Promise<SellerUpdateView> {
  const payload = await asUser(deps, actor, async (tx) => (await ownDraft(tx, actor, actionId, { mine: false })).payload as unknown as SellerUpdatePayload);
  const stale = (await freshHash(deps, actor.tenantId, payload)) !== payload.dataSha256;
  return asUser(deps, actor, async (tx, now) => viewOf(tx, actor, await ownDraft(tx, actor, actionId, { mine: false }), stale, now));
}

/** GET /listings/:id/seller-update: the listing's current unsent update (else its last sent one), and the next due instant. */
export async function listingSellerUpdate(actor: UserActor, listingId: string, deps: AssistantDeps): Promise<{ update: SellerUpdateView | null; nextDueAt: string | null }> {
  const found = await asUser(deps, actor, async (tx) => {
    const head = await listingHead(tx, listingId);
    if (!head) throw new AppError('NOT_FOUND');
    const due = await sql<{ d: Date | null }>`SELECT seller_update_next_due_at AS d FROM listings WHERE tenant_id = app.tenant_id() AND id = ${listingId}`.execute(tx);
    const r = await sql<{ id: string }>`
      SELECT id FROM assistant_actions
       WHERE tenant_id = app.tenant_id() AND kind = 'seller_update_draft' AND trigger_ref->>'listing_id' = ${listingId}
         AND status IN ('proposed','approved','executed')
       ORDER BY status = 'proposed' DESC, created_at DESC, id DESC LIMIT 1`.execute(tx);
    return { id: r.rows[0]?.id ?? null, nextDueAt: due.rows[0]?.d ? due.rows[0].d.toISOString() : null };
  });
  if (!found.id) return { update: null, nextDueAt: found.nextDueAt };
  return { update: await sellerUpdateView(actor, found.id, deps), nextDueAt: found.nextDueAt };
}

/** PATCH /seller-updates/:id { recommendation?, excludedFeedbackIds? } (the agent's own, unsent draft). */
export async function patchSellerUpdate(actor: UserActor, actionId: string, input: AgentChoices, deps: AssistantDeps): Promise<SellerUpdateView> {
  await asUser(deps, actor, async (tx) => {
    const a = await ownDraft(tx, actor, actionId, { lock: true });
    if (a.status !== 'proposed') throw new AppError('ACTION_NOT_PENDING', { status: a.status });
    const payload = a.payload as unknown as SellerUpdatePayload;
    const ids = feedbackIdsOf(payload);
    const cur = choicesOf(a);
    const next: AgentChoices = {
      recommendation: input.recommendation !== undefined ? input.recommendation.trim() : cur.recommendation ?? '',
      excludedFeedbackIds: input.excludedFeedbackIds !== undefined ? [...new Set(input.excludedFeedbackIds)].filter((x) => ids.has(x)) : cur.excludedFeedbackIds ?? [],
    };
    if (input.excludedFeedbackIds?.some((x) => !ids.has(x))) throw new AppError('VALIDATION_FAILED');
    await sql`UPDATE assistant_actions SET edited_payload = ${JSON.stringify(next)}::jsonb, updated_at = now() WHERE tenant_id = app.tenant_id() AND id = ${a.id}`.execute(tx);
  });
  return sellerUpdateView(actor, actionId, deps);
}

function feedbackIdsOf(p: SellerUpdatePayload): Set<string> {
  return new Set(p.sections.flatMap((s) => s.lines.flatMap((l) => (l.feedback ? [l.feedback.feedbackId] : []))));
}

/** POST /seller-updates/:id/reassemble: one tap re-reads the period's data (the watermark moves). */
export async function reassembleSellerUpdate(actor: UserActor, actionId: string, deps: AssistantDeps): Promise<SellerUpdateView> {
  const a = await asUser(deps, actor, async (tx) => {
    const x = await ownDraft(tx, actor, actionId);
    if (x.status !== 'proposed') throw new AppError('ACTION_NOT_PENDING', { status: x.status });
    return x;
  });
  const payload = a.payload as unknown as SellerUpdatePayload;
  await asSystem(deps, actor.tenantId, 'worker', async (tx, now) => {

    const cur = await A.actionById(tx, actionId, { lock: true });
    if (!cur || cur.status !== 'proposed') throw new AppError('ACTION_NOT_PENDING', { status: cur?.status ?? 'missing' });
    const head = await listingHead(tx, payload.listingId);
    if (!head) throw new AppError('NOT_FOUND');
    const period = periodOf(payload.period);
    const fresh = await assemble(tx, payload.listingId, period, now);
    const next = payloadOf({ listingId: payload.listingId, address: head.addressLine1, period, a: fresh, channel: payload.channel });
    await replaceAssembly(tx, { envelope: deps.envelope, tenantId: actor.tenantId, ids: deps.ids }, actionId, next, fresh.claims);
    // feedback the agent removed that is no longer in the period is dropped from their choices
    const ids = feedbackIdsOf(next);
    const ch = choicesOf(cur);
    await sql`UPDATE assistant_actions SET edited_payload = ${JSON.stringify({ ...ch, excludedFeedbackIds: (ch.excludedFeedbackIds ?? []).filter((x) => ids.has(x)) })}::jsonb
               WHERE tenant_id = app.tenant_id() AND id = ${actionId}`.execute(tx);
  });
  return sellerUpdateView(actor, actionId, deps);
}

interface Plan {
  listingId: string;
  address: string;
  period: SellerUpdatePayload['period'];
  sections: SellerUpdatePayload['sections'];
  recommendation: string;
  excluded: string[];
  recipients: { contactId: string; channel: 'email' | 'sms' }[];
}

const childKey = (actionId: string, contactId: string) => `seller_update_send:${actionId}:${contactId}`;

/** The approved per-recipient send action (created once, in the agent's approval transaction). */
async function sendActionFor(tx: Tx, deps: AssistantDeps, actor: UserActor, parentId: string, listingId: string, contactId: string): Promise<string> {
  const prior = await A.actionByDedupeKey(tx, childKey(parentId, contactId));
  if (prior) return prior.id;
  const c = await sql<{ p: string | null }>`SELECT ownership_period_seq AS p FROM contacts WHERE tenant_id = app.tenant_id() AND id = ${contactId}`.execute(tx);
  const id = deps.ids.next<'AssistantActionId'>();
  await A.insertAction(tx, { envelope: deps.envelope, tenantId: actor.tenantId, ids: deps.ids }, {
    id,
    contactId,
    kind: 'message_draft',
    category: 'seller_update',
    autonomy: 'requires_approval',
    playbookVersionId: null,
    status: 'approved',
    ownerUserId: actor.userId,
    explanation: 'Your seller update, sent on your tap.',
    payload: { sellerUpdateActionId: parentId },
    pinnedInboundSeq: null,
    boundOwnershipSeq: c.rows[0]?.p == null ? null : Number(c.rows[0].p),
    aiRunId: null,
    triggerRef: { kind: 'seller_update_send', actionId: parentId, listing_id: listingId },
    dedupeKey: childKey(parentId, contactId),
    claims: [],
    decidedByUserId: actor.userId,
  });
  return id;
}

function planOfApproved(a: A.ActionRow): Plan | null {
  const e = a.editedPayload ?? {};
  const p = a.payload as unknown as SellerUpdatePayload;
  const rec = Array.isArray(e['recipients']) ? (e['recipients'] as { contactId: string; channel: 'email' | 'sms' }[]) : [];
  if (typeof e['recommendation'] !== 'string') return null;
  return { listingId: p.listingId, address: typeof e['address'] === 'string' ? (e['address'] as string) : '', period: p.period, sections: p.sections, recommendation: e['recommendation'] as string, excluded: (e['excludedFeedbackIds'] as string[] | undefined) ?? [], recipients: rec };
}

/** The seller-update branch of approve (POST /seller-updates/:id/send and POST /assistant/actions/:id/approve). */
export async function sendSellerUpdate(actor: UserActor, actionId: string, input: SendInput, deps: AssistantDeps): Promise<SendResult> {
  // A: validate as the agent
  type Pre = { kind: 'replay'; plan: Plan; status: string } | { kind: 'go'; payload: SellerUpdatePayload; recommendation: string; excluded: string[]; recipients: RecipientView[]; address: string } | { kind: 'invalidated' };
  const pre: Pre = await asUser(deps, actor, async (tx, now) => {
    const a = await ownDraft(tx, actor, actionId);
    if (a.status === 'invalidated') return { kind: 'invalidated' };
    if (a.status !== 'proposed') {
      if ((a.status === 'approved' || a.status === 'executed') && a.decidedByUserId === actor.userId) {
        const plan = planOfApproved(a);
        if (plan) return { kind: 'replay', plan, status: a.status };
      }
      throw new AppError('ACTION_NOT_PENDING', { status: a.status });
    }
    const payload = a.payload as unknown as SellerUpdatePayload;
    const head = await listingHead(tx, payload.listingId);
    if (!head) throw new AppError('NOT_FOUND');
    if (head.listingAgentUserId !== actor.userId) return { kind: 'invalidated' };
    const choices = choicesOf(a);
    const recommendation = (input.recommendation ?? choices.recommendation ?? '').trim();
    if (!recommendationOk(recommendation)) throw new AppError('SELLER_UPDATE_NEEDS_RECOMMENDATION');
    const ids = feedbackIdsOf(payload);
    const excluded = input.excludedFeedbackIds !== undefined ? [...new Set(input.excludedFeedbackIds)] : (choices.excludedFeedbackIds ?? []);
    if (excluded.some((x) => !ids.has(x))) throw new AppError('VALIDATION_FAILED');
    const recipients = await recipientsOf(tx, payload.listingId, now);
    const sendable = recipients.filter((r) => r.sendable).map((r) => r.contactId).sort();
    if (input.recipientIds !== undefined) {
      const seen = [...new Set(input.recipientIds)].sort();
      if (seen.length !== sendable.length || seen.some((x, i) => x !== sendable[i])) throw new AppError('SELLER_UPDATE_RECIPIENTS_CHANGED', { reachable: sendable.length });
    }
    if (sendable.length === 0) throw new AppError('SELLER_UPDATE_NO_RECIPIENT');
    return { kind: 'go', payload, recommendation, excluded, recipients, address: head.addressLine1 };
  });
  if (pre.kind === 'invalidated') {
    await asUser(deps, actor, async (tx, now) => {
      const a = await ownDraft(tx, actor, actionId, { lock: true });
      if (a.status === 'proposed') {
        await A.setStatus(tx, a.id, 'invalidated');
        await A.resolveFeedFor(tx, a.id, now);
      }
    });
    throw new AppError('DRAFT_INVALIDATED');
  }
  if (pre.kind === 'replay') return queueAndSend(actor, actionId, pre.plan, pre.status, deps);

  // B: the data must still be what the agent read (R-SELL-4)
  if ((await freshHash(deps, actor.tenantId, pre.payload)) !== pre.payload.dataSha256) throw new AppError('SELLER_UPDATE_STALE', { assembledThrough: pre.payload.assembledThrough });

  // C: the agent's approval
  const recipients = pre.recipients.filter((r) => r.sendable && r.channel !== null).map((r) => ({ contactId: r.contactId, channel: r.channel as 'email' | 'sms' }));
  const plan: Plan = { listingId: pre.payload.listingId, address: pre.address, period: pre.payload.period, sections: pre.payload.sections, recommendation: pre.recommendation, excluded: pre.excluded, recipients };
  await asUser(deps, actor, async (tx, now) => {
    const a = await ownDraft(tx, actor, actionId, { lock: true });
    if (a.status !== 'proposed') throw new AppError('ACTION_NOT_PENDING', { status: a.status });
    if ((a.payload as unknown as SellerUpdatePayload).dataSha256 !== pre.payload.dataSha256) throw new AppError('SELLER_UPDATE_STALE', { assembledThrough: (a.payload as unknown as SellerUpdatePayload).assembledThrough });
    const edited = { recommendation: plan.recommendation, excludedFeedbackIds: plan.excluded, recipients: plan.recipients, address: plan.address };
    await A.setDecision(tx, a.id, { status: 'approved', decidedByUserId: actor.userId, now, editedPayload: edited });
    // one approved send per seller, bound like any approved draft to that contact's owner (the agent) and
    // ownership period, so dispatch's R-AST-7 check holds for each (the handback-reply pattern of drafts.ts)
    for (const r of plan.recipients) await sendActionFor(tx, deps, actor, a.id, plan.listingId, r.contactId);
    await audit(tx, actor, { action: 'draft.approved_with_edits', entity: { type: 'assistant_action', id: a.id }, changes: redactDiff({ recommendation: '', excluded_count: 0 }, { recommendation: plan.recommendation, excluded_count: plan.excluded.length }, { entity: 'message' }) });
    await A.resolveFeedFor(tx, a.id, now);
  });
  return queueAndSend(actor, actionId, plan, 'approved', deps);
}

async function queueAndSend(actor: UserActor, actionId: string, plan: Plan, status: string, deps: AssistantDeps): Promise<SendResult> {
  const { signature, agentName } = await asUser(deps, actor, async (tx) => ({ signature: await senderSignature(tx), agentName: await displayName(tx) }));
  const period = periodOf(plan.period);
  type Q = { contactId: string; messageId: string | null };
  const queued: Q[] = await asSystem(deps, actor.tenantId, 'assistant', async (tx, now) => {
    const t = await tenantFacts(tx);
    const identity = { brokerageLegalName: t.brokerageLegalName, postalAddress: t.postalAddress };
    const out: Q[] = [];
    for (const r of plan.recipients) {
      await lockContact(tx, r.contactId as never);
      const sig = r.channel === 'email' ? signature : null;
      const text = sellerText({ address: plan.address, period, sections: plan.sections, excludedFeedbackIds: plan.excluded, recommendation: plan.recommendation, agentName: sig ? null : agentName });
      const body = renderHumanBody(text.body, { channel: r.channel, purpose: 'informational', identity, unsubscribe: null, signature: sig });
      const child = await A.actionByDedupeKey(tx, childKey(actionId, r.contactId));
      if (!child) {
        out.push({ contactId: r.contactId, messageId: null });
        continue;
      }
      const q = await queueOutboundInTx(tx, deps, {
        contactId: r.contactId,
        channel: r.channel,
        body,
        ...(r.channel === 'email' ? { subject: text.subject } : {}),
        initiator: 'assistant',
        purpose: 'informational',
        category: 'seller_update',
        assistantActionId: child.id,
        idempotencyKey: sendKey(actionId, r.contactId),
      }, now);
      out.push({ contactId: r.contactId, messageId: q.ok ? q.messageId : null });
    }
    return out;
  });
  const outcomes: RecipientOutcome[] = [];
  for (const q of queued) {
    if (!q.messageId) {
      outcomes.push({ contactId: q.contactId, messageId: null, result: 'not_queued' });
      continue;
    }
    const d = await dispatchOutbound(q.messageId, deps, { tenantId: actor.tenantId });
    outcomes.push({ contactId: q.contactId, messageId: q.messageId, result: d.kind === 'not_due' ? 'queued' : d.kind === 'needs_retap' ? 'blocked' : d.kind });
  }
  const order: SendResult['result'][] = ['sent', 'queued', 'dispatch_unknown', 'noop', 'blocked', 'failed'];
  const best = order.find((k) => outcomes.some((o) => o.result === k)) ?? 'failed';
  const first = outcomes.find((o) => o.messageId !== null);
  return { actionId, status, result: best, messageId: first?.messageId ?? null, recipients: outcomes };
}

