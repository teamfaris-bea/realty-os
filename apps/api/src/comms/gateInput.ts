// The send-time gate (ARCHITECTURE §9; core-compliance/2.0.0): buildGateInput assembles every fact
// canContact needs inside the dispatch transaction (under the per-contact lock), evaluateGate runs
// core.canContact, and insertBlockedDecision appends a gate_decisions row ONLY when the send is blocked
// (R-GATE-11: policy version, core rules version, plaintext-free inputs, inputs digest). That row is the
// evidence for the Team Lead "failed sends" exception and the "why wasn't this sent" view; an allowed
// send writes nothing, and a compose preview is never stored.
import {
  CONSENT_EXEMPT_CATEGORIES,
  type GateDecision,
  type GateInput,
  type JurisdictionPack,
  PLATFORM_FLOOR,
  type ResolvedPolicy,
  canContact,
  canonicalJson,
  emailSenderFacts,
  gateInputsRecord,
  parseJurisdictionPack,
  phoneSenderFacts,
  renderedFacts,
  resolvePolicy,
  sha256Hex,
} from '@realty/core/compliance';
import type { IdGenerator, Instant } from '@realty/core/foundation';
import { toIso } from '@realty/core/foundation';
import { type Tx, hmacBytes } from '@realty/db';
import { sql } from 'kysely';
import * as g from './repos/gate.js';
import type { DecisionView, OutboundIntent } from './types.js';

/** A jurisdiction pack failed validation: fail closed, nothing is sent until it is fixed. */
export class PolicyUnavailableError extends Error {
  override readonly name = 'PolicyUnavailableError';
}

export async function resolvedPolicy(tx: Tx): Promise<{ policy: ResolvedPolicy; tenant: g.TenantFacts; packs: JurisdictionPack[] }> {
  const tenant = await g.tenantFacts(tx);
  const row = await g.policyRow(tx, tenant.activePolicyId);
  const packs: JurisdictionPack[] = [];
  for (const p of await g.publishedPacks(tx, tenant.operatingJurisdictions)) {
    const parsed = parseJurisdictionPack(p);
    if (!parsed.ok) throw new PolicyUnavailableError(`pack ${p.key}@${p.version} invalid`);
    packs.push(parsed.pack);
  }
  return { policy: resolvePolicy(PLATFORM_FLOOR, packs, row), tenant, packs };
}

/** BUILD_PLAN interface: every GateInput fact for one outbound intent, read in `tx` at `now`. */
export async function buildGateInput(tx: Tx, m: OutboundIntent, now: Instant): Promise<GateInput> {
  return (await gateContext(tx, m, now)).input;
}

async function gateContext(tx: Tx, m: OutboundIntent, now: Instant): Promise<{ input: GateInput; policy: ResolvedPolicy; tenant: g.TenantFacts }> {
  const { policy, tenant } = await resolvedPolicy(tx);
  const ch = m.recipient.channel;
  const toUser = m.recipient.kind === 'user';
  const point = m.recipient.pointId ? await g.pointById(tx, m.recipient.pointId) : null;

  // consent rows (only revocations matter): this address, plus (SMS, voice) the contact's other phones
  // (R-CONSENT-7: a STOP on any of the contact's phones blocks texting the contact; outbound-3: a
  // "do not call me" on any of them blocks calling the contact)
  const hmacs = new Set([m.recipient.addressHmac]);
  if (ch !== 'email' && m.contactId && !toUser) for (const p of await g.contactPoints(tx, m.contactId)) if (p.kind === 'phone') hmacs.add(p.hmac);
  const consent = await g.consentRows(tx, ch, [...hmacs]);

  let sender: GateInput['sender'];
  if (ch === 'email') {
    const e = m.sender.emailIdentityId ? await g.emailIdentityFacts(tx, m.sender.emailIdentityId) : null;
    sender = emailSenderFacts(e ? { status: e.status, domain: e.domain } : null);
  } else {
    const n = m.sender.phoneNumberId ? await g.numberFacts(tx, m.sender.phoneNumberId) : null;
    sender = phoneSenderFacts(n && (ch === 'sms' ? n.smsCapable : n.voiceCapable) ? n : n ? { ...n, released: true } : null);
  }

  const conv = m.contactId && !toUser ? await g.conversationOf(tx, m.contactId) : null;
  // the keyword reply may reach only the number that texted the keyword (R-CONSENT-7, outbound-1)
  const keywordReply = CONSENT_EXEMPT_CATEGORIES.has(m.category) && m.initiator === 'system' && ch === 'sms' && conv !== null;
  const keywordSenders = keywordReply && conv ? await g.keywordSenderHmacs(tx, conv.id, now) : null;
  const input: GateInput = {
    now,
    recipient: { kind: m.recipient.kind, addressHmac: m.recipient.addressHmac, channel: ch },
    purpose: m.purpose,
    initiator: m.initiator,
    category: m.category,
    consent,
    suppressions: await g.suppressionRows(tx, m.recipient.addressHmac),
    ...(keywordSenders ? { keywordSenders } : {}),
    contactPoint: toUser ? null : point ? { status: point.status, lineType: point.lineType } : null,
    automationPausedAt: conv?.pausedAt ?? null,
    sender,
    tenant: { suspended: tenant.suspended, brokerageNamePresent: tenant.brokerageLegalName.trim() !== '', postalAddressPresent: (tenant.postalAddress ?? '').trim() !== '' },
    policy,
    ...(ch === 'voice' ? {} : { rendered: renderedFacts(m.body ?? '', { channel: ch, brokerageLegalName: tenant.brokerageLegalName }) }),
    // core-compliance/3.0.0: the person-level do-not-contact (R-CHAN-2). The chat widget connection is
    // wired by module 22's chat send path; until then a chat reply is refused here (CHANNEL_NOT_CONNECTED).
    personDoNotContact: m.contactId && !toUser ? await g.personDoNotContact(tx, m.contactId) : false,
    connection: null,
  };
  return { input, policy, tenant };
}

export interface Evaluated {
  input: GateInput;
  decision: GateDecision;
  policy: ResolvedPolicy;
  tenant: g.TenantFacts;
}

export async function evaluateGate(tx: Tx, m: OutboundIntent, now: Instant): Promise<Evaluated> {
  const ctx = await gateContext(tx, m, now);
  return { ...ctx, decision: canContact(ctx.input) };
}

/**
 * API-level reasons that join the core reasons in a send-time decision row: the sender is no longer
 * authorized for the contact (E15), the assistant action / playbook is no longer valid. Each is a deny.
 */
export const DISPATCH_DENY_SENTENCES = {
  SENDER_NOT_AUTHORIZED: 'You no longer handle this contact, so this message was not sent.',
  ASSISTANT_ACTION_NOT_APPROVED: 'This draft was not approved, so it was not sent.',
  ASSISTANT_ACTION_STALE: 'The lead moved to someone else after this was drafted, so it was not sent.',
  PLAYBOOK_NOT_APPROVED: 'The playbook is no longer approved, so the assistant did not send this.',
  PLAYBOOK_OWNER_NOT_CONTACT_OWNER: 'This playbook belongs to an agent who no longer owns the lead, so the assistant did not send this.',
  ENROLLMENT_NOT_ACTIVE: 'The playbook for this contact is paused or stopped, so the assistant did not send this.',
  AUTONOMY_DOWNGRADED: 'The assistant held this message for review instead of sending it.',
} as const;
export type DispatchDenyReason = keyof typeof DISPATCH_DENY_SENTENCES;

/** The send-time verdict: the core decision, or a deny when an API-level reason applies. */
export interface Verdict {
  outcome: GateDecision['outcome'];
  reasons: string[];
  explanation: string;
}

export function verdictOf(d: GateDecision, extra: readonly DispatchDenyReason[] = []): Verdict {
  if (extra.length === 0) return { outcome: d.outcome, reasons: [...d.reasons], explanation: d.explanation };
  const sentence = extra.map((r) => DISPATCH_DENY_SENTENCES[r]).join(' ');
  const coreDeny = d.outcome === 'deny' ? ` ${d.explanation}` : '';
  return { outcome: 'deny', reasons: [...extra, ...d.reasons], explanation: `${sentence}${coreDeny}`.slice(0, 1000) };
}

export interface BlockedSpec {
  ids: IdGenerator;
  intent: OutboundIntent;
  evaluated: Evaluated;
  verdict: Verdict;
  actorUserId: string | null;
  messageId?: string | null;
  callId?: string | null;
  now: Instant;
  /** API-level deny reasons, recorded in the inputs for the "why" view */
  extraDeny?: readonly DispatchDenyReason[];
}

/** A stored blocked-send row (or an allowed send, which stores nothing and has no id). */
export interface StoredDecision extends Verdict {
  id: string | null;
}

/**
 * Appends the gate_decisions row of a BLOCKED send (DB CHECK: outcome 'deny', phase 'send'). Never
 * called for an allowed send or a preview.
 */
export async function insertBlockedDecision(tx: Tx, s: BlockedSpec): Promise<StoredDecision & { id: string }> {
  if (s.verdict.outcome !== 'deny') throw new Error('insertBlockedDecision: only a blocked send is logged');
  const id = s.ids.next<'GateDecisionId'>();
  const toUser = s.intent.recipient.kind === 'user';
  // integrity-2 / R-GATE-11: the digest covers exactly the stored inputs (API-level reasons included), so
  // sha256(canonicalJson(inputs)) recomputed from the row matches inputs_sha256
  const stored = { ...gateInputsRecord(s.evaluated.input), ...(s.extraDeny?.length ? { dispatchReasons: [...s.extraDeny] } : {}) };
  const digest = s.extraDeny?.length ? sha256Hex(canonicalJson(stored)) : s.evaluated.decision.inputsDigest;
  await sql`
    INSERT INTO gate_decisions (tenant_id, id, contact_id, recipient_kind, recipient_user_id, address_hmac, channel, purpose, initiator,
      action_category, phase, outcome, reason_codes, explanation, actor_user_id, policy_version_id, core_rules_version, inputs, inputs_sha256,
      message_id, call_id, evaluated_at)
    VALUES (app.tenant_id(), ${id}, ${s.intent.contactId}, ${s.intent.recipient.kind}, ${toUser ? (s.intent.recipient.userId ?? null) : null},
      ${hmacBytes(s.intent.recipient.addressHmac)}, ${s.intent.recipient.channel}, ${s.intent.purpose}, ${s.intent.initiator},
      ${s.intent.category}, 'send', 'deny', ${s.verdict.reasons}::text[], ${s.verdict.explanation}, ${s.actorUserId},
      ${s.evaluated.policy.version.policyId}, ${s.evaluated.decision.rulesVersion},
      ${JSON.stringify(stored)}::jsonb,
      ${digest}, ${s.messageId ?? null}, ${s.callId ?? null}, ${toIso(s.now)}::timestamptz)`.execute(tx);
  return { id, ...s.verdict };
}

export function decisionView(d: StoredDecision, phase: DecisionView['phase']): DecisionView {
  return { id: d.id, outcome: d.outcome, reasons: d.reasons, explanation: d.explanation, phase };
}
