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

  // consent rows (only revocations matter): this address, plus (SMS, voice) every phone of the contact the
  // dispatch guards fan out over (R-CONSENT-7: a STOP on any of the contact's phones blocks texting the
  // contact; outbound-3: a "do not call me" on any of them blocks calling the contact; R-PAR-12: a removed
  // phone still counts unless removed as a confirmed wrong number). The guards' own set, read with their
  // WHERE clause, so canContact refuses first and says why instead of the guard refusing the dispatch.
  const hmacs = new Set([m.recipient.addressHmac]);
  if (ch !== 'email' && ch !== 'web_chat' && m.contactId && !toUser) for (const h of await g.optOutFanoutPhoneHmacs(tx, m.contactId)) hmacs.add(h);
  // module 22: a chat opt-out on any of the contact's chat identities blocks all of them (the guard's `others` set)
  if (ch === 'web_chat' && m.contactId && !toUser) for (const h of await g.chatFanoutHmacs(tx, m.contactId)) hmacs.add(h);
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
    // core-compliance/3.0.0: the person-level do-not-contact (R-CHAN-2). The chat widget connection comes from
    // module 22's chat send path (compose / dispatch: the widget's status, a closed session counting as not
    // connected, E77); absent ⇒ a chat reply is refused (CHANNEL_NOT_CONNECTED).
    personDoNotContact: m.contactId && !toUser ? await g.personDoNotContact(tx, m.contactId) : false,
    connection: m.connection ?? null,
    ...(m.aiIsa ? { aiIsa: m.aiIsa } : {}),
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
 * The last four are the dispatch guards' own refusals about the recipient (see guardOptOutRefusal); each
 * says the same fact the gate's own reason says (RECIPIENT_OPTED_OUT ~ CONSENT_REVOKED, RECIPIENT_SUPPRESSED
 * ~ SUPPRESSED; PERSON_DO_NOT_CONTACT is the gate's code itself).
 */
export const DISPATCH_DENY_SENTENCES = {
  SENDER_NOT_AUTHORIZED: 'You no longer handle this contact, so this message was not sent.',
  ASSISTANT_ACTION_NOT_APPROVED: 'This draft was not approved, so it was not sent.',
  ASSISTANT_ACTION_STALE: 'The lead moved to someone else after this was drafted, so it was not sent.',
  ASSISTANT_ACTION_WITHDRAWN: 'This automatic message was withdrawn before it went out (the lead was merged, reassigned, closed or started a new inquiry period), so it was not sent.',
  PLAYBOOK_NOT_APPROVED: 'The playbook is no longer approved, so the assistant did not send this.',
  PLAYBOOK_OWNER_NOT_CONTACT_OWNER: 'This playbook belongs to an agent who no longer owns the lead, so the assistant did not send this.',
  ENROLLMENT_NOT_ACTIVE: 'The playbook for this contact is paused or stopped, so the assistant did not send this.',
  AUTONOMY_DOWNGRADED: 'The assistant held this message for review instead of sending it.',
  RECIPIENT_OPTED_OUT: 'This person opted out, so it did not go out.',
  RECIPIENT_NOT_A_CONTACT_POINT: "This number or address is not on the person's record, so their opt-outs could not be checked and it did not go out.",
  PERSON_DO_NOT_CONTACT: 'This person asked not to be contacted on any channel, so it did not go out.',
  RECIPIENT_SUPPRESSED: 'This number or address is blocked (bounce, complaint or do-not-contact), so it did not go out.',
  // R-TWL-2 (lane telephony-safeguards): the tenant's daily telephony cap; telephonySafeguards.ts DAILY_CAP_SENTENCE
  DAILY_SEND_CAP_REACHED: "Today's sending limit for this team is reached.",
  // R-TWL-2 (b14 review R1): the share of that cap a client's sign-in link texts may use; telephonySafeguards.ts
  // PORTAL_LINK_CAP_SENTENCE
  PORTAL_LINK_DAILY_CAP_REACHED: "Today's limit on sign-in link texts for this team is reached.",
  // R-TWL-1 (b9 review ownership-data/F4): the kill switch, refused in TX1 so a refused text or call is never a touch;
  // telephonySafeguards.ts TELEPHONY_LIVE_OFF_SENTENCE
  TELEPHONY_LIVE_OFF: 'Live texting and calling are off on this deployment.',
  // 0080 (D12 proposed): the AI ISA's own refusals (isa/send.ts ISA_GUARD_REASONS and the TX1 checks); codes only in the row
  AI_ISA_LIVE_OFF: 'AI assistant sending is off on this deployment.',
  ISA_OFFSET_MISMATCH: 'The time-zone data disagreed, so the AI assistant waited.',
  FACT_CHANGED: 'A listing changed (status or price) before it went out, so the AI assistant did not send the old facts.', // ISA-2b (flagged, R-ISA-17)
  ISA_NOT_AUTHORIZED: 'The AI assistant is not authorized for this person right now, so it did not send this.',
  ISA_PURPOSE_MISMATCH: 'AI assistant messages are sent as marketing only.',
  ISA_CHANNEL_NOT_ALLOWED: 'The AI assistant texts and emails only, with no media.',
  ISA_BODY_CHANGED: 'The message changed after it was checked, so it did not go out.',
  ISA_UNBOUND_RECIPIENT: 'AI assistant messages go only to the address bound when AI care started.',
  ISA_STOPPED: 'An opt-out or do-not-contact stopped AI care.',
  ISA_PAUSED: 'AI care is paused, so the AI assistant did not send this.',
  ISA_STALE_EPOCH: 'AI care was paused and resumed after this was written, so it did not go out.',
  ISA_STALE_REPLY: 'The person wrote again after this was written; the AI assistant will answer both.',
  ISA_HANDOFF_CLOSED: 'AI care handed back; only its pending confirmation may go.',
  ISA_SHARED_ADDRESS: 'Another person shares this address, so AI care stopped.',
  ISA_ACTIVE_CLIENT: 'This person is a client on an open deal or listing, so AI care stopped.',
  ISA_UNREAD_PART: 'A part of their message has not been read yet, so the AI assistant waited.',
  ISA_SELLER_DATA_NOT_CLEARED: 'Recent sales wait on counsel review.',
  ISA_CONSENT_EVIDENCE_MISSING: 'The consent the AI assistant needs for this is not on file.',
  ISA_REPLY_WINDOW_CLOSED: 'The 24-hour reply window of their own message closed.',
  ISA_DNC_UNVERIFIED: 'An initiated AI text needs a fresh national Do Not Call result.',
  ISA_ZONE_UNRESOLVED: 'Their time zones could not all be resolved, so the AI assistant waited.',
  ISA_QUIET_HOURS: 'It is outside quiet hours in one of their time zones; the AI assistant waits.',
  ISA_MIN_GAP: 'AI assistant messages are spaced at least two minutes apart.',
  ISA_CAP_REACHED: 'The daily limit of AI assistant messages is reached.',
} as const;
export type DispatchDenyReason = keyof typeof DISPATCH_DENY_SENTENCES;

/**
 * The dispatch guards' refusals that are a BLOCKED send, never an error (defence in depth, R-PAR-12, R-CHAN-2,
 * D1): every refusal app.messages_dispatch_guard and app.calls_dispatch_guard (latest: migration 0043_merged_person_opt_outs) raise
 * about a contact recipient. The recipient opted out (RECIPIENT_OPTED_OUT), the person asked not to be
 * contacted, also through a duplicate merged into them (PERSON_DO_NOT_CONTACT), the address is suppressed
 * (RECIPIENT_SUPPRESSED), or its opt-out status cannot be checked (RECIPIENT_NOT_A_CONTACT_POINT). canContact
 * reads the facts the guards read (optOutFanoutPhoneHmacs, personDoNotContact, suppressionRows; proven case by
 * case in optOutFanout.test.ts and guardEquivalence.test.ts), so none should ever reach the database; if one
 * does, the send is recorded as blocked with the guard's code, exactly like a canContact deny. The guards'
 * other refusals are not about the recipient and stay errors: the assistant-autonomy codes (ASSISTANT_ACTION_*,
 * PLAYBOOK_NOT_APPROVED, AUTOMATION_PAUSED), MARKETING_PIECE_NOT_APPROVED, and the Meta and unknown-channel
 * codes (PLATFORM_NOT_CLEARED, CHANNEL_UNKNOWN), which no text, email or call of dispatch.ts / dial.ts raises.
 */
export const GUARD_DENY_REASONS = ['RECIPIENT_OPTED_OUT', 'RECIPIENT_NOT_A_CONTACT_POINT', 'PERSON_DO_NOT_CONTACT', 'RECIPIENT_SUPPRESSED'] as const satisfies readonly DispatchDenyReason[];
export type GuardDenyReason = (typeof GUARD_DENY_REASONS)[number];

/**
 * The code when `err` is app.messages_dispatch_guard or app.calls_dispatch_guard refusing a send with one of
 * GUARD_DENY_REASONS (a check_violation whose message starts with the code and a colon); null for anything
 * else. Every other guard refusal and every other database error stays an error.
 */
export function guardOptOutRefusal(err: unknown): GuardDenyReason | null {
  if (typeof err !== 'object' || err === null) return null;
  const { code, message } = err as { code?: unknown; message?: unknown };
  if (code !== '23514' || typeof message !== 'string') return null;
  return GUARD_DENY_REASONS.find((r) => message.startsWith(`${r}:`)) ?? null;
}

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
  // a guard's PERSON_DO_NOT_CONTACT is also a core code: listed once if both name it (a do-not-contact that
  // committed between the refused transaction and its rerun)
  return { outcome: 'deny', reasons: [...new Set<string>([...extra, ...d.reasons])], explanation: `${sentence}${coreDeny}`.slice(0, 1000) };
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

/**
 * The stored decision of a blocked message (messages.gate_decision_id), as the send that made it reported it; null for
 * a message that was not blocked. A replayed command (the same idempotency key or commandId after a lost answer)
 * returns it, so the client says what the first attempt did instead of reading the replay as a send (finding F1).
 * Read in the caller's transaction (gate_decisions_select: the actor's own decisions, or the contact's).
 */
export async function storedDecisionView(tx: Tx, decisionId: string | null): Promise<DecisionView | null> {
  if (!decisionId) return null;
  const r = await sql<{ id: string; outcome: DecisionView['outcome']; reason_codes: string[]; explanation: string }>`
    SELECT id, outcome, reason_codes, explanation FROM gate_decisions WHERE tenant_id = app.tenant_id() AND id = ${decisionId}::uuid`.execute(tx);
  const d = r.rows[0];
  return d ? { id: d.id, outcome: d.outcome, reasons: d.reason_codes, explanation: d.explanation, phase: 'send' } : null;
}
