// The outbound gate: canContact() (ARCHITECTURE §9; R-CONSENT-5, -13, -14, -15, -17, -18;
// R-GATE-5, -6, -7, -11, -12).
//
// Pure and deterministic: the same input gives the same decision and the same inputsDigest. Every
// check runs and every reason is collected; then any deny ⇒ deny, else any confirm ⇒
// needs_confirmation, else any defer ⇒ defer(until), else allow. Assistant and system initiators
// never get needs_confirmation (DB CHECK): no automated rule produces a `confirm` reason.
//
// Checks (numbers as in ARCHITECTURE §9):
//   0  category / recipient sanity: always-human categories are never automated, the assistant
//      sends only policy-approved autonomous categories (and so does the system, for the categories a
//      tenant can switch on), no automated calls (Phase 1), agent alerts only to users
//   1  tenant suspended                                       deny
//   2  contact point invalid / wrong number / SMS to landline  deny
//   3  sender missing / unregistered; marketing email domain   deny
//   4  marketing identity: brokerage name, postal address, unsubscribe (email)  deny
//   5  opted out (channel + purpose; SMS also the contact's other phones)  deny, no override
//   6  active suppression                                      deny
//   7  payment / wire instructions                            deny
//   8  consent basis below R-CONSENT-5                         automated deny; human confirm/deny
//   9  DNC (marketing SMS/voice, R-CONSENT-15)                 deny
//  10  automation paused (client replied)                     automated deny
//  11  contact window (recipient-local, intersected)          automated defer; human deny / confirm
//  12  frequency caps (R-CONSENT-14)                          automated defer; human confirm / deny
//  13  weak timezone evidence                                 info
//
// Consent-exempt categories (opt-out confirmation, HELP; system-initiated informational SMS only)
// skip 5, 8, 10 and 12 but still check the tenant, the point, the sender, suppressions, content and
// quiet hours. Agent alerts (recipient
// `user`) are checked for tenant, sender, the agent's own opt-out, suppressions and content only.
//
// Legal parameters come from `input.policy` (resolvePolicy). VERIFY WITH COUNSEL every default.
import {
  DAY_MS,
  type IanaZone,
  type Instant,
  MINUTE_MS,
  SECOND_MS,
  type TzSource,
  instant,
  localWindowContains,
  nextWindowStart,
} from '../foundation/index.js';
import { effectiveLevel } from './consent.js';
import { canonicalize, canonicalJson, hash32, sha256Hex, type Canonical } from './digest.js';
import { type ResolvedPolicy, windowIsEmpty } from './policy.js';
import { type ReasonCode, explain, REASON_EFFECTS } from './reasons.js';
import {
  type ActionCategory,
  ALWAYS_HUMAN_CATEGORIES,
  AUTONOMOUS_ELIGIBLE,
  CAP_EXEMPT_CATEGORIES,
  type Channel,
  CONSENT_EXEMPT_CATEGORIES,
  type ConsentLevel,
  type ConsentStateRow,
  type DncCheckRow,
  type Initiator,
  type LineType,
  type PointStatus,
  type Purpose,
  type SuppressionRow,
  atLeast,
} from './types.js';
import { INFORMATIONAL_REPLY_WINDOW_MS } from './content.js';

/** Stored in gate_decisions.core_rules_version. Bump on any change to a decision rule. */
export const RULES_VERSION = 'core-compliance/1.1.0';

/** Deterministic quiet-hours jitter range (R-CONSENT-13): 0–20 minutes, whole seconds. */
export const MAX_JITTER_SECONDS = 20 * 60;

export interface GateInput {
  now: Instant;
  recipient: { kind: 'contact' | 'user'; addressHmac: string; channel: Channel };
  purpose: Purpose;
  initiator: Initiator;
  category: ActionCategory;
  /** consent_state rows for this address, plus the contact's other phones (SMS revokes). */
  consent: ConsentStateRow[];
  /** suppressions for this address. */
  suppressions: SuppressionRow[];
  /** dnc_checks for this phone. */
  dnc: DncCheckRow[];
  contactPoint: { status: PointStatus; lineType: LineType } | null;
  automationPausedAt: Instant | null;
  sender: { kind: 'phone' | 'email'; registration: 'ready' | 'pending' | 'blocked'; domainVerified?: boolean } | null;
  /**
   * Automated sends to this contact in the last 7 days (any channel). `sameAddress: false` marks a
   * send to another of the contact's addresses (counts only toward the cross-channel cap);
   * omitted counts as the same address (stricter). `exempt` sends never count.
   */
  recentAutomated: { channel: Channel; at: Instant; exempt: boolean; sameAddress?: boolean }[];
  recentManualSms24h: number;
  callAttempts24h: number;
  lastInboundAt: Instant | null;
  zones: { zones: IanaZone[]; source: TzSource };
  tenant: { suspended: boolean; brokerageNamePresent: boolean; postalAddressPresent: boolean };
  rendered?: { containsBrokerageName: boolean; containsOptOutHint: boolean; paymentInstructions: boolean };
  policy: ResolvedPolicy;
  /** The message id: seeds the deterministic 0–20 min quiet-hours jitter (spec correction). */
  jitterKey?: string;
}

export type GateOutcome = 'allow' | 'deny' | 'defer' | 'needs_confirmation';

export interface GateDecision {
  outcome: GateOutcome;
  reasons: ReasonCode[];
  deferUntil?: Instant;
  explanation: string;
  rulesVersion: string;
  inputsDigest: string;
}

function rowFor(rows: readonly ConsentStateRow[], channel: Channel, purpose: Purpose, hmac: string): ConsentStateRow | undefined {
  return rows.find((r) => r.channel === channel && r.purpose === purpose && r.addressHmac === hmac);
}

/** When the count of `sends` in the trailing window drops below `cap` (null: already below). */
function capRelease(sends: readonly Instant[], cap: number, windowMs: number, now: Instant): number | null {
  const within = sends.filter((t) => t > now - windowMs).sort((a, b) => b - a);
  if (within.length < cap) return null;
  return (within[cap - 1] as number) + windowMs;
}

function insideAll(t: Instant, zones: readonly IanaZone[], policy: ResolvedPolicy): boolean {
  return zones.every((z) => localWindowContains(t, z, policy.window.start, policy.window.end));
}

/** The canonical, plaintext-free `gate_decisions.inputs` object (R-GATE-11). */
export function gateInputsRecord(input: GateInput): { [k: string]: Canonical } {
  return canonicalize(input) as { [k: string]: Canonical };
}

export function canContact(input: GateInput): GateDecision {
  const { now, recipient, policy, category } = input;
  const ch = recipient.channel;
  const reasons: ReasonCode[] = [];
  const add = (r: ReasonCode): void => {
    reasons.push(r); // each check adds a distinct code at most once
  };
  const automated = input.initiator !== 'human';
  const toUser = recipient.kind === 'user';
  const marketing = input.purpose === 'marketing';
  // The consent exemption (ARCHITECTURE §9 path 8) covers only what it exists for: the system's own
  // informational SMS reply to a STOP/HELP keyword. A human, assistant, marketing, email or voice
  // send labelled with one of these categories is gated like any other send, so the label can never
  // be used to message an opted-out address (R-CONSENT-10: no override).
  const consentExempt =
    CONSENT_EXEMPT_CATEGORIES.has(category) && input.initiator === 'system' && !marketing && ch === 'sms' && !toUser;
  const messaging = ch !== 'voice';

  // 0. category / recipient
  if ((category === 'agent_alert') !== toUser) add('RECIPIENT_CATEGORY_MISMATCH');
  if (automated && ALWAYS_HUMAN_CATEGORIES.has(category)) add('CATEGORY_REQUIRES_HUMAN');
  // The assistant sends only the tenant's approved autonomous categories; a system-initiated send of
  // a category the tenant may switch on (reminders, document chase, …) respects the same switch.
  if (
    (input.initiator === 'assistant' || (input.initiator === 'system' && AUTONOMOUS_ELIGIBLE.has(category))) &&
    !policy.autonomous.has(category)
  ) {
    add('CATEGORY_NOT_AUTONOMOUS');
  }
  if (automated && ch === 'voice') add('AUTOMATED_VOICE_UNAVAILABLE');

  // 1. tenant
  if (input.tenant.suspended) add('TENANT_SUSPENDED');

  // 2. contact point
  const point = input.contactPoint;
  if (point === null) {
    if (!toUser) add('CONTACT_POINT_INVALID');
  } else if (point.status === 'wrong_number') add('WRONG_NUMBER');
  else if (point.status !== 'active') add('CONTACT_POINT_INVALID');
  if (point !== null && ch === 'sms' && point.lineType === 'landline') add('LANDLINE_NO_SMS');

  // 3. sender
  const sender = input.sender;
  if (sender === null || sender.kind !== (ch === 'email' ? 'email' : 'phone')) add('SENDER_UNAVAILABLE');
  else if (ch === 'voice' ? sender.registration === 'blocked' : sender.registration !== 'ready') add('SENDER_NOT_REGISTERED');
  if (ch === 'email' && marketing && sender?.domainVerified !== true) add('EMAIL_DOMAIN_UNVERIFIED');

  // 4. marketing identity (R-GATE-12, R-CONSENT-18) and content presence
  const rendered = input.rendered;
  if (messaging && rendered === undefined) add('RENDERED_CONTENT_MISSING');
  if (marketing && (!input.tenant.brokerageNamePresent || rendered?.containsBrokerageName === false)) add('BROKERAGE_IDENTITY_MISSING');
  if (marketing && ch === 'email') {
    if (!input.tenant.postalAddressPresent) add('POSTAL_ADDRESS_MISSING');
    if (rendered?.containsOptOutHint === false) add('UNSUBSCRIBE_MISSING');
  }

  // 5. opt-out (no override, R-CONSENT-10). SMS revokes on the contact's other phones also block.
  const own = rowFor(input.consent, ch, input.purpose, recipient.addressHmac);
  const revoked =
    own?.status === 'revoked' ||
    (ch === 'sms' && input.consent.some((r) => r.channel === 'sms' && r.purpose === input.purpose && r.status === 'revoked'));
  if (!consentExempt && revoked) add('CONSENT_REVOKED');

  // 6. suppressions
  if (input.suppressions.some((s) => s.liftedAt === null && (s.channel === 'all' || s.channel === ch))) add('SUPPRESSED');

  // 7. payment instructions (R-GATE-7)
  if (rendered?.paymentInstructions === true) add('PAYMENT_INSTRUCTIONS');

  // 8. consent basis (R-CONSENT-5)
  const level = effectiveLevel(own, now);
  const recentInbound = input.lastInboundAt !== null && input.lastInboundAt <= now && now - input.lastInboundAt <= INFORMATIONAL_REPLY_WINDOW_MS;
  if (!toUser && !consentExempt && !revoked && ch === 'sms') {
    const min: ConsentLevel = marketing ? 'express_written' : 'express';
    if (automated) {
      if (!atLeast(level, min)) add('CONSENT_BASIS_INSUFFICIENT');
    } else if (marketing && level === 'imported_unverified') add('CONSENT_IMPORTED_BASIS_ONLY');
    else if (marketing ? !atLeast(level, 'inquiry') : level === 'none' && !recentInbound) add('CONSENT_CONFIRMATION_REQUIRED');
  }

  // 9. DNC (R-CONSENT-15)
  if (!toUser && marketing && ch !== 'email') {
    const validMs = policy.dncValidityDays * DAY_MS;
    const valid = input.dnc.filter((d) => d.checkedAt <= now && now < Math.min(d.validUntil, d.checkedAt + validMs));
    const listed = valid.some((d) => d.listed);
    const clear = !listed && valid.some((d) => d.registry === 'us_national');
    if (listed && level !== 'express_written') add('DNC_LISTED');
    if (!listed && !clear) {
      const other = effectiveLevel(rowFor(input.consent, ch, 'informational', recipient.addressHmac), now);
      if (!atLeast(level, 'inquiry') && !atLeast(other, 'inquiry')) add('DNC_STATUS_UNKNOWN_NO_RELATIONSHIP');
    }
  }

  // 10. automation pause (R-AST-9); humans can always reply
  if (automated && !toUser && !consentExempt && input.automationPausedAt !== null) add('AUTOMATION_PAUSED');

  // 11. contact window (R-CONSENT-13)
  const zones = input.zones.zones;
  const windowApplies = !toUser && (ch !== 'email' || policy.emailQuietHours);
  const noWindow = windowIsEmpty(policy.window) || zones.length === 0;
  const insideNow = !windowApplies || (!noWindow && insideAll(now, zones, policy));
  if (!insideNow && !automated) {
    const reply =
      !marketing && input.lastInboundAt !== null && input.lastInboundAt <= now && now - input.lastInboundAt < policy.humanReplyWindowMin * MINUTE_MS;
    add(reply ? 'OUTSIDE_WINDOW_REPLY' : 'OUTSIDE_CONTACT_WINDOW');
  }

  // 12. frequency caps (R-CONSENT-14)
  let release: number | null = null;
  if (automated && !toUser && !CAP_EXEMPT_CATEGORIES.has(category) && messaging) {
    const caps = policy.caps;
    const [per24, per7] = ch === 'sms' ? [caps.autoSmsPer24h, caps.autoSmsPer7d] : [caps.autoEmailPer24h, caps.autoEmailPer7d];
    if (per24 === 0 || per7 === 0 || caps.autoCrossChannelPer24h === 0) add('POLICY_CAP_ZERO');
    else {
      const counted = input.recentAutomated.filter((x) => !x.exempt);
      const same = counted.filter((x) => x.channel === ch && x.sameAddress !== false).map((x) => x.at);
      for (const r of [
        capRelease(same, per24, DAY_MS, now),
        capRelease(same, per7, 7 * DAY_MS, now),
        capRelease(counted.map((x) => x.at), caps.autoCrossChannelPer24h, DAY_MS, now),
      ]) {
        if (r !== null && (release === null || r > release)) release = r;
      }
      if (release !== null) add('FREQUENCY_CAP');
    }
  }
  if (!automated && !toUser && ch === 'sms' && input.recentManualSms24h >= policy.caps.manualSmsConfirmAfter24h) add('MANUAL_SMS_VOLUME');
  if (!automated && !toUser && ch === 'voice' && input.callAttempts24h >= policy.caps.callAttemptsPer24h) add('CALL_ATTEMPT_LIMIT');

  // Automated defer target: the cap release and the next window opening (+ jitter at an opening).
  let deferUntil: Instant | undefined;
  if (automated && (release !== null || !insideNow)) {
    const earliest = instant(release === null ? now : Math.max(now, release));
    if (!windowApplies) deferUntil = earliest;
    else {
      const opening = noWindow ? null : nextWindowStart(earliest, zones, policy.window.start, policy.window.end);
      if (opening === null) add('NO_CONTACTABLE_WINDOW');
      else if (opening === earliest) deferUntil = earliest;
      else {
        const key = input.jitterKey ?? `${recipient.addressHmac}:${category}`;
        const jittered = instant(opening + (hash32(key) % (MAX_JITTER_SECONDS + 1)) * SECOND_MS);
        deferUntil = insideAll(jittered, zones, policy) ? jittered : opening;
      }
      if (!insideNow) add('QUIET_HOURS_DEFERRED');
    }
  }

  // 13. timezone evidence
  if (windowApplies && (input.zones.source === 'area_code' || input.zones.source === 'tenant_default')) add('RECIPIENT_TZ_UNCERTAIN');

  const effects = reasons.map((r) => REASON_EFFECTS[r]);
  const outcome: GateOutcome = effects.includes('deny')
    ? 'deny'
    : effects.includes('confirm')
      ? 'needs_confirmation'
      : effects.includes('defer')
        ? 'defer'
        : 'allow';
  const decision: GateDecision = {
    outcome,
    reasons,
    explanation: explain(outcome, reasons, {
      channel: ch,
      window: policy.window,
      ...(outcome === 'defer' ? { deferUntil } : {}),
      ...(zones[0] === undefined ? {} : { zone: zones[0] }),
      caps: policy.caps,
    }),
    rulesVersion: RULES_VERSION,
    inputsDigest: sha256Hex(canonicalJson(input)),
  };
  if (outcome === 'defer') decision.deferUntil = deferUntil;
  return decision;
}

/**
 * Whether a human may confirm past this decision (R-GATE-6): only a needs_confirmation outcome
 * whose every reason is confirmable or informational. The confirmation is a second decision
 * (phase 'confirm', outcome allow) written and audited by the API.
 */
export function canConfirm(d: Pick<GateDecision, 'outcome' | 'reasons'>): boolean {
  return d.outcome === 'needs_confirmation' && d.reasons.every((r) => REASON_EFFECTS[r] === 'confirm' || REASON_EFFECTS[r] === 'info');
}

/** After a defer: keep deferring, or mark the step `skipped_ineligible` (R-CONSENT-14). */
export function afterDeferral(priorDeferrals: number, policy: Pick<ResolvedPolicy, 'caps'>): 'defer' | 'skipped_ineligible' {
  return priorDeferrals >= policy.caps.maxDeferrals ? 'skipped_ineligible' : 'defer';
}

/**
 * The next instant ≥ `from` at which the recipient may be contacted on `channel` per the window
 * (for SLA clocks such as E8's first touch). Null when no instant is contactable.
 */
export function nextContactableAt(from: Instant, zones: readonly IanaZone[], policy: Pick<ResolvedPolicy, 'window' | 'emailQuietHours'>, channel: Channel): Instant | null {
  if (channel === 'email' && !policy.emailQuietHours) return from;
  if (windowIsEmpty(policy.window) || zones.length === 0) return null;
  return nextWindowStart(from, zones, policy.window.start, policy.window.end);
}
