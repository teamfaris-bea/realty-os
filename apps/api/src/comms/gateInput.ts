// The send-time gate (ARCHITECTURE §9): buildGateInput assembles every fact canContact needs inside the
// dispatch transaction (under the per-contact lock), evaluateGate runs core.canContact, and
// insertDecision appends the gate_decisions row (R-GATE-11: policy version, core rules version,
// plaintext-free inputs, inputs digest).
import {
  CAP_EXEMPT_CATEGORIES,
  type GateDecision,
  type GateInput,
  type JurisdictionPack,
  PLATFORM_FLOOR,
  type ResolvedPolicy,
  canConfirm,
  canContact,
  emailSenderFacts,
  gateInputsRecord,
  parseJurisdictionPack,
  phoneSenderFacts,
  renderedFacts,
  resolvePolicy,
} from '@realty/core/compliance';
import type { IanaZone, IdGenerator, Instant } from '@realty/core/foundation';
import { resolveRecipientZones, toIso, zone } from '@realty/core/foundation';
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

  // consent rows: this address, plus (SMS) the contact's other phones (R-CONSENT-7: a STOP on any of
  // the contact's phones blocks texting the contact)
  const hmacs = new Set([m.recipient.addressHmac]);
  if (ch === 'sms' && m.contactId && !toUser) for (const p of await g.contactPoints(tx, m.contactId)) if (p.kind === 'phone') hmacs.add(p.hmac);
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
  const cz = m.contactId && !toUser ? await g.contactZone(tx, m.contactId) : null;
  // R-CONSENT-13 candidate zones: explicit → contact point → address → area code (+ the tenant zone,
  // intersected) → tenant zone. A contact zone inferred from the area code is weak evidence, but it is
  // a candidate: ignoring it would let a text land at 6 AM for a recipient three zones away.
  const zones = resolveRecipientZones({
    contactTz: cz?.source === 'explicit' ? cz.timezone : null,
    addressTz: cz?.source === 'address' ? cz.timezone : null,
    pointTz: point?.timezone ?? null,
    areaCodeZones: cz?.source === 'area_code' && cz.timezone ? [cz.timezone as IanaZone] : [], // validated (and dropped if invalid) by core
    tenantZone: zone(tenant.defaultTimezone),
  });
  const automated = m.initiator !== 'human';
  const recent = m.contactId && !toUser && automated ? await g.recentAutomated(tx, m.contactId, m.recipient.pointId, now, m.excludeMessageId ?? null) : [];

  const input: GateInput = {
    now,
    recipient: { kind: m.recipient.kind, addressHmac: m.recipient.addressHmac, channel: ch },
    purpose: m.purpose,
    initiator: m.initiator,
    category: m.category,
    consent,
    suppressions: await g.suppressionRows(tx, m.recipient.addressHmac),
    dnc: ch === 'email' ? [] : await g.dncRows(tx, m.recipient.addressHmac),
    contactPoint: toUser ? null : point ? { status: point.status, lineType: point.lineType } : null,
    automationPausedAt: conv?.pausedAt ?? null,
    sender,
    recentAutomated: recent.map((x) => ({ channel: x.channel, at: x.at, exempt: CAP_EXEMPT_CATEGORIES.has(x.category as never), sameAddress: x.sameAddress })),
    recentManualSms24h: m.contactId && !toUser && !automated && ch === 'sms' ? await g.manualSms24h(tx, m.contactId, now, m.excludeMessageId ?? null) : 0,
    callAttempts24h: m.contactId && !toUser && ch === 'voice' ? await g.callAttempts24h(tx, m.contactId, now) : 0,
    lastInboundAt: conv?.lastInboundAt ?? null,
    zones,
    tenant: { suspended: tenant.suspended, brokerageNamePresent: tenant.brokerageLegalName.trim() !== '', postalAddressPresent: (tenant.postalAddress ?? '').trim() !== '' },
    policy,
    ...(ch === 'voice' ? {} : { rendered: renderedFacts(m.body ?? '', { channel: ch, brokerageLegalName: tenant.brokerageLegalName }) }),
    ...(m.jitterKey ? { jitterKey: m.jitterKey } : {}),
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
 * authorized for the contact (E15), the assistant action / playbook is no longer valid, or the tenant
 * policy could not be resolved. Each is a deny and never confirmable.
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

export interface DecisionSpec {
  ids: IdGenerator;
  intent: OutboundIntent;
  evaluated: Evaluated;
  phase: 'preview' | 'send' | 'confirm';
  actorUserId: string | null;
  messageId?: string | null;
  callId?: string | null;
  now: Instant;
  /** API-level deny reasons (dispatch authorization) added to the core reasons */
  extraDeny?: DispatchDenyReason[];
  confirm?: { confirmedByUserId: string; confirmsDecisionId: string };
}

export interface StoredDecision {
  id: string;
  outcome: GateDecision['outcome'];
  reasons: string[];
  explanation: string;
  deferUntil: Instant | null;
}

/** The decision a row stores: the core decision, or a deny when an API-level reason applies. */
export function effectiveDecision(d: GateDecision, extra: readonly DispatchDenyReason[] = []): Omit<StoredDecision, 'id'> {
  if (extra.length === 0) return { outcome: d.outcome, reasons: [...d.reasons], explanation: d.explanation, deferUntil: d.deferUntil ?? null };
  const sentence = extra.map((r) => DISPATCH_DENY_SENTENCES[r]).join(' ');
  const coreDeny = d.outcome === 'deny' ? ` ${d.explanation}` : '';
  return { outcome: 'deny', reasons: [...extra, ...d.reasons], explanation: `${sentence}${coreDeny}`.slice(0, 1000), deferUntil: null };
}

export async function insertDecision(tx: Tx, s: DecisionSpec): Promise<StoredDecision> {
  const id = s.ids.next<'GateDecisionId'>();
  const eff = s.confirm ? { outcome: 'allow' as const, reasons: s.evaluated.decision.reasons.slice(), explanation: 'Sent after you confirmed.', deferUntil: null } : effectiveDecision(s.evaluated.decision, s.extraDeny);
  const toUser = s.intent.recipient.kind === 'user';
  await sql`
    INSERT INTO gate_decisions (tenant_id, id, contact_id, recipient_kind, recipient_user_id, address_hmac, channel, purpose, initiator,
      action_category, phase, outcome, reason_codes, defer_until, explanation, actor_user_id, confirmed_by_user_id, confirms_decision_id,
      policy_version_id, core_rules_version, inputs, inputs_sha256, message_id, call_id, evaluated_at)
    VALUES (app.tenant_id(), ${id}, ${s.intent.contactId}, ${s.intent.recipient.kind}, ${toUser ? (s.intent.recipient.userId ?? null) : null},
      ${hmacBytes(s.intent.recipient.addressHmac)}, ${s.intent.recipient.channel}, ${s.intent.purpose}, ${s.intent.initiator},
      ${s.intent.category}, ${s.phase}, ${eff.outcome}, ${eff.reasons}::text[],
      ${eff.deferUntil === null ? null : toIso(eff.deferUntil)}::timestamptz, ${eff.explanation}, ${s.actorUserId},
      ${s.confirm?.confirmedByUserId ?? null}, ${s.confirm?.confirmsDecisionId ?? null},
      ${s.evaluated.policy.version.policyId}, ${s.evaluated.decision.rulesVersion},
      ${JSON.stringify({ ...gateInputsRecord(s.evaluated.input), ...(s.extraDeny?.length ? { dispatchReasons: s.extraDeny } : {}) })}::jsonb,
      ${s.evaluated.decision.inputsDigest}, ${s.messageId ?? null}, ${s.callId ?? null}, ${toIso(s.now)}::timestamptz)`.execute(tx);
  return { id, ...eff };
}

export function decisionView(d: StoredDecision, phase: DecisionView['phase']): DecisionView {
  return {
    id: d.id,
    outcome: d.outcome,
    reasons: d.reasons,
    explanation: d.explanation,
    deferUntil: d.deferUntil === null ? null : toIso(d.deferUntil),
    canConfirm: canConfirm({ outcome: d.outcome, reasons: d.reasons as never }),
    phase,
  };
}

/**
 * A fresh decision of this message/call by this user that a confirmation may cite: the same contact,
 * the same channel, and (for a message) that message, or (for a call) a dial-time decision — never a
 * text preview standing in for a call or the other way round.
 */
export async function confirmableDecision(tx: Tx, decisionId: string, ref: { messageId?: string; callId?: string; contactId: string; channel: 'sms' | 'email' | 'voice' }, userId: string, now: Instant): Promise<StoredDecision | null> {
  const r = await sql<{ id: string; outcome: StoredDecision['outcome']; reason_codes: string[]; explanation: string; message_id: string | null; call_id: string | null; contact_id: string | null; actor_user_id: string | null; evaluated_at: Date; channel: string; phase: string }>`
    SELECT id, outcome, reason_codes, explanation, message_id, call_id, contact_id, actor_user_id, evaluated_at, channel, phase FROM gate_decisions
     WHERE tenant_id = app.tenant_id() AND id = ${decisionId}`.execute(tx);
  const d = r.rows[0];
  if (!d || d.outcome !== 'needs_confirmation' || d.actor_user_id !== userId || d.contact_id !== ref.contactId || d.channel !== ref.channel) return null;
  if (ref.messageId !== undefined && d.message_id !== ref.messageId) return null;
  if (ref.callId !== undefined && (d.message_id !== null || d.call_id === null || d.phase !== 'send')) return null;
  if (now - d.evaluated_at.getTime() > 10 * 60_000) return null;
  return { id: d.id, outcome: d.outcome, reasons: d.reason_codes, explanation: d.explanation, deferUntil: null };
}

/** Confirmation is valid when the fresh decision is confirmable and raises nothing the human did not see. */
export function confirmationCovers(fresh: GateDecision, confirmed: StoredDecision): boolean {
  return canConfirm(fresh) && fresh.reasons.every((r) => confirmed.reasons.includes(r) || r === 'RECIPIENT_TZ_UNCERTAIN');
}
