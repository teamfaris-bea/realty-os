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
import { type SellerValue, sellerRangeGate } from '../cma/sellerValue.js';
import { assemble, carriesValue, fmtPeriod, listingHead, sellerContacts, sellerText } from './assembly.js';
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
  /** lane V2-B (E631): the agent removed the value section */
  valueRemoved: boolean;
  /** lane V2-B (E630): said when a seller who gets this by text will not see the value range shown here */
  valueNote: string | null;
  recipients: RecipientView[];
  preview: { channel: 'email' | 'sms'; subject: string; body: string };
  sentAt: string | null;
  /** after the tap: each seller's message as it stands (sent, delivered, queued, blocked, failed, not_queued) */
  delivery: DeliveryItem[] | null;
}

export interface DeliveryItem {
  contactId: string;
  name: string | null;
  channel: 'email' | 'sms';
  status: string;
  /** b13 audit V2B-3 (E632): why a seller's message was never queued, in the blocked send's own words (else null) */
  reason: string | null;
}

export interface SendInput {
  commandId: string;
  recommendation?: string | undefined;
  excludedFeedbackIds?: string[] | undefined;
  /** the seller contacts the agent was shown as reachable; when given, they must still be exactly those */
  recipientIds?: string[] | undefined;
  /** lane V2-B: the agent removed the value section (else their stored choice) */
  valueRemoved?: boolean | undefined;
}

export interface RecipientOutcome {
  contactId: string;
  messageId: string | null;
  result: 'sent' | 'queued' | 'blocked' | 'failed' | 'dispatch_unknown' | 'noop' | 'not_queued';
  /** b13 audit V2B-3 (E632): a 'not_queued' send that was blocked before it was queued says why (else null) */
  reason: string | null;
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
    valueRemoved: e['valueRemoved'] === true,
  };
}

/** E630: the agent is told when a seller reached by text will not get the value range this update shows. */
export const VALUE_BY_TEXT_NOTE = 'Sellers who get this by text won’t see the value range.';

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

/** The generic words for a per-seller send blocked before it was queued whose explanation is not a "Not sent: …" sentence. */
const HELD_REASON = 'Not sent: it was stopped before it was queued.';

/**
 * b13 audit V2B-3 (E632, lane V2-B brief E6): each per-seller send of `parentId` that was blocked before any message was
 * queued (queueApprovedSends' value-range re-check), with its own explanation, by contact. The resume pass and a later
 * tap never queue these (they read approved or executed sends only), so the card says why instead of "no address".
 */
async function heldSendsOf(tx: Tx, parentId: string): Promise<Map<string, string>> {
  const r = await sql<{ contact_id: string; explanation: string | null }>`
    SELECT a.contact_id, a.explanation FROM assistant_actions a
     WHERE a.tenant_id = app.tenant_id() AND a.kind = 'message_draft' AND a.status = 'blocked'
       AND a.trigger_ref->>'kind' = 'seller_update_send' AND a.trigger_ref->>'actionId' = ${parentId}
       AND NOT EXISTS (SELECT 1 FROM messages m WHERE m.tenant_id = a.tenant_id AND m.idempotency_key = ('seller-update:' || ${parentId} || ':' || a.contact_id::text))`.execute(tx);
  return new Map(r.rows.map((x) => [x.contact_id, x.explanation !== null && x.explanation.startsWith('Not sent:') ? x.explanation : HELD_REASON]));
}

/** What happened to each seller's message after the tap: the message's own status (null when none was queued). */
async function deliveryOf(tx: Tx, a: A.ActionRow): Promise<DeliveryItem[] | null> {
  if (a.status !== 'approved' && a.status !== 'executed') return null;
  const e = a.editedPayload ?? {};
  const recipients = Array.isArray(e['recipients']) ? (e['recipients'] as { contactId: string; channel: 'email' | 'sms' }[]) : [];
  const ids = recipients.map((r) => r.contactId);
  const msgs = await sql<{ contact_id: string; status: string; display_name: string | null }>`
    SELECT c.id AS contact_id, m.status, c.display_name FROM contacts c
      LEFT JOIN messages m ON m.tenant_id = c.tenant_id AND m.idempotency_key = ('seller-update:' || ${a.id} || ':' || c.id::text)
     WHERE c.tenant_id = app.tenant_id() AND c.id = ANY (${ids}::uuid[])`.execute(tx);
  const held = await heldSendsOf(tx, a.id);
  return recipients.map((r) => {
    const m = msgs.rows.find((x) => x.contact_id === r.contactId);
    const status = m?.status ?? 'not_queued';
    return { contactId: r.contactId, name: m?.display_name ?? null, channel: r.channel, status, reason: status === 'not_queued' ? (held.get(r.contactId) ?? null) : null };
  });
}

async function viewOf(tx: Tx, actor: UserActor, a: A.ActionRow & { payload: Record<string, unknown> }, stale: boolean, now: Instant, allIds: readonly string[]): Promise<SellerUpdateView> {
  const payload = a.payload as unknown as SellerUpdatePayload;
  const head = await listingHead(tx, payload.listingId);
  if (!head) throw new AppError('NOT_FOUND');
  const choices = choicesOf(a);
  const recipients = await recipientsOf(tx, payload.listingId, now, allIds);
  const period = periodOf(payload.period);
  const firstSendable = recipients.find((r) => r.sendable);
  const channel = firstSendable?.channel ?? payload.channel;
  const text = sellerText({ address: head.addressLine1, period, sections: payload.sections, excludedFeedbackIds: choices.excludedFeedbackIds ?? [], recommendation: choices.recommendation || null, agentName: null, channel, valueRemoved: choices.valueRemoved });
  const shown = payload.sections.some((s) => s.kind === 'value' && s.state === 'has_data') && !choices.valueRemoved;
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
    valueRemoved: choices.valueRemoved ?? false,
    valueNote: shown && recipients.some((r) => r.sendable && r.channel === 'sms') ? VALUE_BY_TEXT_NOTE : null,
    recipients,
    preview: { channel, subject: text.subject, body: text.body },
    sentAt: sent?.rows[0]?.at ? sent.rows[0].at.toISOString() : null,
    delivery: await deliveryOf(tx, a),
  };
}

/** GET /seller-updates/:id */
export async function sellerUpdateView(actor: UserActor, actionId: string, deps: AssistantDeps): Promise<SellerUpdateView> {
  const payload = await asUser(deps, actor, async (tx) => (await ownDraft(tx, actor, actionId, { mine: false })).payload as unknown as SellerUpdatePayload);
  const stale = (await freshHash(deps, actor.tenantId, payload)) !== payload.dataSha256;
  const allIds = await sellerIdsAsSystem(deps, actor, actionId);
  return asUser(deps, actor, async (tx, now) => viewOf(tx, actor, await ownDraft(tx, actor, actionId, { mine: false }), stale, now, allIds));
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
      valueRemoved: input.valueRemoved !== undefined ? input.valueRemoved : cur.valueRemoved ?? false,
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

const childKey = (actionId: string, contactId: string) => `seller_update_send:${actionId}:${contactId}`;

/** What one seller receives, fixed at the tap (the agent's words, signature or name): the resume pass re-reads it. */
interface ChildPayload {
  sellerUpdateActionId: string;
  channel: 'email' | 'sms';
  subject: string;
  text: string;
  signature: string | null;
  /** lane V2-B: set when `text` carries the value range (its re-check inputs) */
  value?: SellerValue;
}

/** The approved per-recipient send action (created once, in the agent's approval transaction). */
async function sendActionFor(tx: Tx, deps: AssistantDeps, actor: UserActor, parentId: string, listingId: string, contactId: string, body: ChildPayload): Promise<string> {
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
    payload: body as unknown as Record<string, unknown>,
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

/**
 * Queues every approved per-seller send of `parentId` that has no message yet (idempotent by key), in the
 * caller's SYSTEM transaction. Each queued message carries its comms.dispatch job, so the worker sends it even
 * if this process stops right after; the reconcile pass calls this again for approvals that never got this far.
 */
export async function queueApprovedSends(tx: Tx, deps: Pick<AssistantDeps, 'ids'>, parentId: string, now: Instant): Promise<{ contactId: string; messageId: string | null; created: boolean; blocked?: boolean; reason?: string }[]> {
  const t = await tenantFacts(tx);
  const identity = { brokerageLegalName: t.brokerageLegalName, postalAddress: t.postalAddress };
  const children = await sql<{ id: string; contact_id: string; payload: ChildPayload }>`
    SELECT id, contact_id, payload FROM assistant_actions
     WHERE tenant_id = app.tenant_id() AND kind = 'message_draft' AND status IN ('approved','executed')
       AND trigger_ref->>'kind' = 'seller_update_send' AND trigger_ref->>'actionId' = ${parentId}
     ORDER BY contact_id`.execute(tx);
  const out: { contactId: string; messageId: string | null; created: boolean; blocked?: boolean; reason?: string }[] = [];
  // lane V2-B (R-CMA-7, E632): the value range is re-checked once per parent before any child is queued; on a failure
  // nothing is queued and each child not yet queued is blocked with the reason (the resume pass reads approved or
  // executed children only, so it never sends one later)
  const value = children.rows.find((c) => c.payload.value !== undefined)?.payload.value;
  if (value !== undefined) {
    const g = await sellerRangeGate(tx, now, value);
    if (!g.ok) {
      const explanation = `Not sent: the value range can no longer be shown to clients (${g.sentence}).`;
      for (const c of children.rows) {
        const m = await sql<{ id: string }>`SELECT id FROM messages WHERE tenant_id = app.tenant_id() AND idempotency_key = ${sendKey(parentId, c.contact_id)}`.execute(tx);
        if (m.rows[0]) {
          out.push({ contactId: c.contact_id, messageId: m.rows[0].id, created: false });
          continue;
        }
        await sql`UPDATE assistant_actions SET status = 'blocked', explanation = ${explanation} WHERE tenant_id = app.tenant_id() AND id = ${c.id}`.execute(tx);
        out.push({ contactId: c.contact_id, messageId: null, created: false, blocked: true, reason: explanation });
      }
      return out;
    }
  }
  for (const c of children.rows) {
    await lockContact(tx, c.contact_id as never);
    const p = c.payload;
    const body = renderHumanBody(p.text, { channel: p.channel, purpose: 'informational', identity, unsubscribe: null, signature: p.channel === 'email' ? p.signature : null });
    const q = await queueOutboundInTx(tx, deps, {
      contactId: c.contact_id,
      channel: p.channel,
      body,
      ...(p.channel === 'email' ? { subject: p.subject } : {}),
      initiator: 'assistant',
      purpose: 'informational',
      category: 'seller_update',
      assistantActionId: c.id,
      idempotencyKey: sendKey(parentId, c.contact_id),
    }, now);
    out.push({ contactId: c.contact_id, messageId: q.ok ? q.messageId : null, created: q.ok && q.created });
  }
  return out;
}

/** The seller-update branch of approve (POST /seller-updates/:id/send and POST /assistant/actions/:id/approve). */
export async function sendSellerUpdate(actor: UserActor, actionId: string, input: SendInput, deps: AssistantDeps): Promise<SendResult> {
  const allIds = await sellerIdsAsSystem(deps, actor, actionId);
  // A: validate as the agent
  type Pre = { kind: 'replay'; status: string } | { kind: 'go'; payload: SellerUpdatePayload; recommendation: string; excluded: string[]; recipients: RecipientView[]; address: string; valueRemoved: boolean } | { kind: 'invalidated' };
  const pre: Pre = await asUser(deps, actor, async (tx, now) => {
    const a = await ownDraft(tx, actor, actionId);
    if (a.status === 'invalidated') return { kind: 'invalidated' };
    if (a.status !== 'proposed') {
      // the same tap again, or "Try again" after a send that did not go out: finish what the approval fixed
      if ((a.status === 'approved' || a.status === 'executed') && a.decidedByUserId === actor.userId) return { kind: 'replay', status: a.status };
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
    const valueRemoved = input.valueRemoved ?? choices.valueRemoved ?? false;
    const recipients = await recipientsOf(tx, payload.listingId, now, allIds);
    const sendable = recipients.filter((r) => r.sendable).map((r) => r.contactId).sort();
    if (input.recipientIds !== undefined) {
      const seen = [...new Set(input.recipientIds)].sort();
      if (seen.length !== sendable.length || seen.some((x, i) => x !== sendable[i])) throw new AppError('SELLER_UPDATE_RECIPIENTS_CHANGED', { reachable: sendable.length });
    }
    if (sendable.length === 0) throw new AppError('SELLER_UPDATE_NO_RECIPIENT');
    return { kind: 'go', payload, recommendation, excluded, recipients, address: head.addressLine1, valueRemoved };
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
  if (pre.kind === 'replay') return queueAndSend(actor, actionId, pre.status, deps);

  // B: the data must still be what the agent read (R-SELL-4)
  if ((await freshHash(deps, actor.tenantId, pre.payload)) !== pre.payload.dataSha256) throw new AppError('SELLER_UPDATE_STALE', { assembledThrough: pre.payload.assembledThrough });
  // R-SELL-5: the recipients are confirmed by the tap that saw them (the seller card sends them); a caller that
  // did not show them (the generic approve route) is sent to the seller card
  if (input.recipientIds === undefined) throw new AppError('SELLER_UPDATE_CONFIRM_RECIPIENTS');

  // C: the agent's approval and, fixed with it, what each seller receives
  const recipients = pre.recipients.filter((r) => r.sendable && r.channel !== null).map((r) => ({ contactId: r.contactId, channel: r.channel as 'email' | 'sms' }));
  const period = periodOf(pre.payload.period);
  await asUser(deps, actor, async (tx, now) => {
    const a = await ownDraft(tx, actor, actionId, { lock: true });
    if (a.status !== 'proposed') throw new AppError('ACTION_NOT_PENDING', { status: a.status });
    if ((a.payload as unknown as SellerUpdatePayload).dataSha256 !== pre.payload.dataSha256) throw new AppError('SELLER_UPDATE_STALE', { assembledThrough: (a.payload as unknown as SellerUpdatePayload).assembledThrough });
    const signature = await senderSignature(tx);
    const agentName = await displayName(tx);
    const edited = { recommendation: pre.recommendation, excludedFeedbackIds: pre.excluded, recipients, address: pre.address, valueRemoved: pre.valueRemoved };
    await A.setDecision(tx, a.id, { status: 'approved', decidedByUserId: actor.userId, now, editedPayload: edited });
    // one approved send per seller, bound like any approved draft to that contact's owner (the agent) and
    // ownership period, so dispatch's R-AST-7 check holds for each (the handback-reply pattern of drafts.ts)
    for (const r of recipients) {
      const sig = r.channel === 'email' ? signature : null;
      const t = sellerText({ address: pre.address, period, sections: pre.payload.sections, excludedFeedbackIds: pre.excluded, recommendation: pre.recommendation, agentName: sig ? null : agentName, channel: r.channel, valueRemoved: pre.valueRemoved });
      // lane V2-B: a child whose text carries the value range stores what D re-checks before it is queued
      const carries = pre.payload.value !== undefined && pre.payload.sections.some((s) => s.kind === 'value' && s.state === 'has_data' && carriesValue(s, { channel: r.channel, valueRemoved: pre.valueRemoved }));
      await sendActionFor(tx, deps, actor, a.id, pre.payload.listingId, r.contactId, { sellerUpdateActionId: a.id, channel: r.channel, subject: t.subject, text: t.body, signature: sig, ...(carries ? { value: pre.payload.value! } : {}) });
    }
    await audit(tx, actor, { action: 'draft.approved_with_edits', entity: { type: 'assistant_action', id: a.id }, changes: redactDiff({ recommendation: '', excluded_count: 0 }, { recommendation: pre.recommendation, excluded_count: pre.excluded.length }, { entity: 'message' }) });
    await A.resolveFeedFor(tx, a.id, now);
  });
  return queueAndSend(actor, actionId, 'approved', deps);
}

async function queueAndSend(actor: UserActor, actionId: string, status: string, deps: AssistantDeps): Promise<SendResult> {
  const { queued, held } = await asSystem(deps, actor.tenantId, 'assistant', async (tx, now) => ({ queued: await queueApprovedSends(tx, deps, actionId, now), held: await heldSendsOf(tx, actionId) }));
  const outcomes: RecipientOutcome[] = [];
  for (const q of queued) {
    if (!q.messageId) {
      outcomes.push({ contactId: q.contactId, messageId: null, result: 'not_queued', reason: q.reason ?? held.get(q.contactId) ?? null });
      continue;
    }
    const d = await dispatchOutbound(q.messageId, deps, { tenantId: actor.tenantId });
    outcomes.push({ contactId: q.contactId, messageId: q.messageId, result: d.kind === 'not_due' ? 'queued' : d.kind === 'needs_retap' ? 'blocked' : d.kind, reason: null });
  }
  // b13 audit V2B-3 (E632): a send blocked by an earlier tap or the resume pass is no longer read by queueApprovedSends;
  // a later tap still reports it, with its reason, never an empty 'failed'
  for (const [contactId, reason] of held) if (!outcomes.some((o) => o.contactId === contactId)) outcomes.push({ contactId, messageId: null, result: 'not_queued', reason });
  const order: SendResult['result'][] = ['sent', 'queued', 'dispatch_unknown', 'noop', 'blocked', 'failed'];
  // lane V2-B (E632): nothing queued because the value range failed its re-check is 'blocked', never 'failed'
  const best = order.find((k) => outcomes.some((o) => o.result === k)) ?? (outcomes.length > 0 && outcomes.every((o) => o.reason !== null) ? 'blocked' : 'failed');
  const first = outcomes.find((o) => o.messageId !== null);
  return { actionId, status, result: best, messageId: first?.messageId ?? null, recipients: outcomes };
}

/** Every live seller contact id of the update's listing, read as the system (who the caller cannot see is listed, never named). */
async function sellerIdsAsSystem(deps: AssistantDeps, actor: UserActor, actionId: string): Promise<string[]> {
  return asSystem(deps, actor.tenantId, 'worker', async (tx) => {
    const a = await A.actionById(tx, actionId);
    const listingId = a && typeof a.triggerRef['listing_id'] === 'string' && a.ownerUserId === actor.userId ? (a.triggerRef['listing_id'] as string) : null; // others: only the sellers their RLS shows
    return listingId ? (await sellerContacts(tx, listingId)).map((s) => s.contactId) : [];
  });
}
