// Playbooks: step schema, validation, content hash, and the pure step logic the worker runs
// (R-AST-4, R-AST-8, R-AST-16, R-CONSENT-5 purpose validation).
//
// "Approve rules, not every message": an Owner/Admin (team) or the agent (agent playbooks) approves
// a hash-frozen version once; its steps then run on their own, each one re-authorized and gated at
// SEND time. A step declares its channel, purpose, category and intent up front, so the validator
// can refuse a marketing intent declared as informational (R-CONSENT-5) and the always-human
// categories can never appear in a step at all (R-AST-3).
import { z } from 'zod';
import {
  type ActionCategory,
  AUTONOMOUS_ELIGIBLE,
  type GateDecision,
  canonicalJson,
  detectPaymentInstructions,
  sha256Hex,
} from '../compliance/index.js';
import { DAY_MS, type Instant, instant } from '../foundation/index.js';
import { check as fairHousingCheck, DEFAULT_FAIR_HOUSING_PACK, type FairHousingPack } from '../fairhousing/index.js';
import { approvalCurrent } from './autonomy.js';
import { findHumanClaim, lexiconHits } from './guard.js';
import type { IdentityFacts } from './types.js';

// ---- vocabulary ---------------------------------------------------------------------------------

export const SLOT_NAMES = [
  'first_name',
  'agent_first_name',
  'team_name',
  'brokerage_name',
  'inquiry_property',
  'listing_address',
  'listing_price',
  'listing_url',
  'search_name',
  'match_count',
  'appointment_time',
  'appointment_place',
  'document_name',
  'due_date',
  'home_years',
  'va_question',
] as const;
export type SlotName = (typeof SLOT_NAMES)[number];

export const STEP_INTENTS = [
  'first_response_qualify',
  'check_in',
  'market_update',
  'listing_suggestion',
  'search_alert',
  'home_anniversary',
  'home_value_update',
  'referral_ask',
  'holiday_greeting',
  'appointment_confirmation',
  'appointment_reminder',
  'deadline_reminder',
  'document_request',
  // Phase 2 (module 25): the review step of the post-closing playbook (R-MKT-11)
  'review_request',
  // trigger playbooks (module 25, R-NURT-2): facts only
  'price_drop_alert',
  'back_on_market_alert',
] as const;
export type StepIntent = (typeof STEP_INTENTS)[number];

/**
 * A capability a step needs at send time. `avm`: a home-value vendor and the cleared `platform:avm`
 * pack; `review_requests`: the cleared `platform:review_requests` pack (R-INT-6, R-MKT-11).
 */
export type Capability = 'avm' | 'review_requests';
export const CAPABILITIES: readonly Capability[] = ['avm', 'review_requests'];

/**
 * What each intent is (R-CONSENT-5): its natural purpose and the categories it may run under.
 * A marketing intent can never be declared informational; an informational one may be declared
 * marketing (stricter). VERIFY WITH COUNSEL: which nurture intents count as marketing.
 */
export const INTENT_RULES: Readonly<Record<StepIntent, { purpose: 'marketing' | 'informational'; categories: readonly ActionCategory[]; requires?: readonly Capability[] }>> = {
  first_response_qualify: { purpose: 'informational', categories: ['speed_to_lead_reply'] },
  check_in: { purpose: 'marketing', categories: ['nurture_step'] },
  market_update: { purpose: 'marketing', categories: ['nurture_step'] },
  listing_suggestion: { purpose: 'marketing', categories: ['nurture_step'] },
  search_alert: { purpose: 'marketing', categories: ['search_alert'] },
  home_anniversary: { purpose: 'marketing', categories: ['nurture_step'] },
  home_value_update: { purpose: 'marketing', categories: ['nurture_step'], requires: ['avm'] },
  referral_ask: { purpose: 'marketing', categories: ['nurture_step'] },
  holiday_greeting: { purpose: 'marketing', categories: ['nurture_step'] },
  appointment_confirmation: { purpose: 'informational', categories: ['booking_confirmation'] },
  appointment_reminder: { purpose: 'informational', categories: ['reminder'] },
  deadline_reminder: { purpose: 'informational', categories: ['reminder'] },
  document_request: { purpose: 'informational', categories: ['document_chase'] },
  // VERIFY WITH COUNSEL (C8): FTC consumer-review rule; treated as marketing (stricter).
  review_request: { purpose: 'marketing', categories: ['nurture_step'], requires: ['review_requests'] },
  price_drop_alert: { purpose: 'marketing', categories: ['search_alert', 'nurture_step'] },
  back_on_market_alert: { purpose: 'marketing', categories: ['search_alert', 'nurture_step'] },
};

export const STOP_CONDITIONS = ['appointment_booked', 'deal_opened', 'deal_closed', 'listing_inactive', 'event_canceled'] as const;
export type StopCondition = (typeof STOP_CONDITIONS)[number];

export type PlaybookKind =
  | 'new_lead_response'
  | 'nurture'
  | 'post_closing'
  | 'booking_confirmation'
  | 'reminder'
  | 'document_chase'
  // Phase 2/3 (0018): trigger playbooks hold `PlaybookContent` kind 'triggers'; voice answering kind 'voice'
  | 'trigger'
  | 'voice_answering';

const KIND_CATEGORIES: Readonly<Record<PlaybookKind, readonly ActionCategory[]>> = {
  new_lead_response: ['speed_to_lead_reply'],
  nurture: ['nurture_step'],
  post_closing: ['nurture_step'],
  booking_confirmation: ['booking_confirmation'],
  reminder: ['reminder'],
  document_chase: ['document_chase'],
  // R-AST-20: no new autonomous category; trigger alerts run as existing ones
  trigger: ['nurture_step', 'search_alert', 'reminder'],
  voice_answering: [],
};

const AUTONOMOUS_CATEGORY_VALUES = [...AUTONOMOUS_ELIGIBLE] as [ActionCategory, ...ActionCategory[]];
const MAX_OFFSET_SECONDS = 3 * 366 * 24 * 3600;

// ---- schemas ------------------------------------------------------------------------------------

const StepSchemaInner = z.strictObject({
  stepKey: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  /**
   * `inbound_channel` = "reply where the lead wrote" (web chat; owner decision D2 keeps Messenger and
   * Instagram DMs out of scope): only for the
   * 60-second first response, as part of the approved content (R-INBOX-4).
   */
  channel: z.enum(['sms', 'email', 'inbound_channel']),
  delay: z.strictObject({
    anchor: z.enum(['enrollment', 'previous_step', 'event']),
    offsetSeconds: z.number().int().min(-MAX_OFFSET_SECONDS).max(MAX_OFFSET_SECONDS),
  }),
  purpose: z.enum(['marketing', 'informational']),
  category: z.enum(AUTONOMOUS_CATEGORY_VALUES),
  intent: z.enum(STEP_INTENTS),
  template: z.string().min(1).max(4000),
  subject: z.string().min(1).max(200).optional(),
  personalization: z.enum(['none', 'light']),
  slots: z.array(z.enum(SLOT_NAMES)).max(SLOT_NAMES.length),
  maxLength: z.number().int().min(20).max(10_000),
  stopIf: z.array(z.enum(STOP_CONDITIONS)).max(STOP_CONDITIONS.length),
  requires: z.array(z.enum(CAPABILITIES as unknown as ['avm', 'review_requests'])).optional(),
  /** Email form of an SMS step, used only when SMS is not allowed (the first response, R-AST-16). */
  fallback: z
    .strictObject({
      subject: z.string().min(1).max(200),
      template: z.string().min(1).max(4000),
      maxLength: z.number().int().min(20).max(10_000),
    })
    .optional(),
});

/** One playbook step (playbook_versions.steps[] is `PlaybookStep[]`). */
export type PlaybookStep = z.infer<typeof StepSchemaInner>;
export const PlaybookStepSchema: z.ZodType<PlaybookStep> = StepSchemaInner;

const ToneSchemaInner = z.strictObject({
  formality: z.enum(['casual', 'neutral', 'formal']).optional(),
  emoji: z.boolean().optional(),
  notes: z.string().max(300).optional(),
});
export type Tone = z.infer<typeof ToneSchemaInner>;
export const ToneSchema: z.ZodType<Tone> = ToneSchemaInner;

/**
 * sha256(canonical JSON of {steps, tone}): playbook_versions.content_sha256 and the approval binding.
 * `steps` is the version's stored content: `PlaybookStep[]` for step playbooks (Phase 1, hashes
 * unchanged) or one `PlaybookContent` object for trigger and voice playbooks (0018).
 */
export function contentSha256(steps: readonly PlaybookStep[] | PlaybookContentLike, tone: Tone): string {
  return sha256Hex(canonicalJson({ steps, tone }));
}

/** Structural stand-in for `PlaybookContent` (defined in ./content.ts, which imports this file). */
export interface PlaybookContentLike {
  kind: 'steps' | 'triggers' | 'voice';
  [field: string]: unknown;
}

// ---- validation ---------------------------------------------------------------------------------

export type ValidationCode =
  | 'NO_STEPS'
  | 'SCHEMA'
  | 'DUPLICATE_STEP_KEY'
  | 'MARKETING_INTENT_DECLARED_INFORMATIONAL'
  | 'INTENT_CATEGORY_MISMATCH'
  | 'KIND_CATEGORY_MISMATCH'
  | 'KIND_STEP_COUNT'
  | 'UNDECLARED_SLOT'
  | 'TEMPLATE_SYNTAX'
  | 'TEMPLATE_PAYMENT_INSTRUCTIONS'
  | 'TEMPLATE_ALWAYS_HUMAN_TOPIC'
  | 'TEMPLATE_HUMAN_CLAIM'
  | 'TEMPLATE_TOO_LONG'
  | 'EMAIL_SUBJECT_REQUIRED'
  | 'SMS_SUBJECT_NOT_ALLOWED'
  | 'FALLBACK_INVALID'
  | 'NEGATIVE_DELAY_WITHOUT_EVENT'
  // Phase 2 (module 25)
  | 'INBOUND_CHANNEL_NOT_ALLOWED'
  | 'TEMPLATE_FAIR_HOUSING'
  | 'REVIEW_REQUEST_INCENTIVE'
  | 'CONTENT_KIND_MISMATCH'
  | 'TRIGGER_INTENT_MISMATCH'
  | 'DUPLICATE_TRIGGER'
  | 'VOICE_DISCLOSURE_MISSING';

export interface ValidationIssue {
  index: number;
  stepKey?: string;
  code: ValidationCode;
  detail?: string;
}

const SECTION_RE = /\{\{#([a-z_]+)\}\}([\s\S]*?)\{\{\/\1\}\}/g;
const VAR_RE = /\{\{([a-z_]+)\}\}/g;

function templateSlots(t: string): { names: string[]; syntaxOk: boolean; staticText: string } {
  const names: string[] = [];
  for (const m of t.matchAll(SECTION_RE)) names.push(m[1] as string);
  for (const m of t.matchAll(VAR_RE)) names.push(m[1] as string);
  const stripped = t.replace(SECTION_RE, (_m, _n, inner: string) => inner).replace(VAR_RE, '');
  return { names, syntaxOk: !/\{\{|\}\}/.test(stripped), staticText: t.replace(SECTION_RE, '').replace(VAR_RE, '') };
}

/** Approx. length the identity lines add (sign-off, brokerage, STOP line). */
const IDENTITY_ALLOWANCE = 80;

/**
 * Issues that block approval of a version. `identity` (optional) also checks templates for human
 * claims ("this is Sarah") against the real names.
 */
export function validatePlaybook(steps: readonly unknown[], opts: { kind?: PlaybookKind; identity?: IdentityFacts; fairHousing?: FairHousingPack } = {}): ValidationIssue[] {
  const fh = opts.fairHousing ?? DEFAULT_FAIR_HOUSING_PACK;
  const issues: ValidationIssue[] = [];
  if (steps.length === 0) return [{ index: -1, code: 'NO_STEPS' }];
  if (opts.kind === 'new_lead_response' && steps.length !== 1) issues.push({ index: -1, code: 'KIND_STEP_COUNT', detail: 'new_lead_response sends exactly one message' });
  const seen = new Set<string>();
  steps.forEach((raw, index) => {
    const parsed = StepSchemaInner.safeParse(raw);
    if (!parsed.success) {
      for (const e of parsed.error.issues) issues.push({ index, code: 'SCHEMA', detail: e.path.join('.') || e.code });
      return;
    }
    const s = parsed.data;
    const at = (code: ValidationCode, detail?: string): void => {
      issues.push(detail === undefined ? { index, stepKey: s.stepKey, code } : { index, stepKey: s.stepKey, code, detail });
    };
    if (seen.has(s.stepKey)) at('DUPLICATE_STEP_KEY');
    seen.add(s.stepKey);
    const rule = INTENT_RULES[s.intent];
    if (rule.purpose === 'marketing' && s.purpose === 'informational') at('MARKETING_INTENT_DECLARED_INFORMATIONAL', s.intent);
    if (!rule.categories.includes(s.category)) at('INTENT_CATEGORY_MISMATCH', `${s.intent}/${s.category}`);
    if (opts.kind !== undefined && !KIND_CATEGORIES[opts.kind].includes(s.category)) at('KIND_CATEGORY_MISMATCH', `${opts.kind}/${s.category}`);
    if (s.delay.offsetSeconds < 0 && s.delay.anchor !== 'event') at('NEGATIVE_DELAY_WITHOUT_EVENT');
    if (s.channel === 'email' && s.subject === undefined) at('EMAIL_SUBJECT_REQUIRED');
    if (s.channel !== 'email' && s.subject !== undefined) at('SMS_SUBJECT_NOT_ALLOWED');
    if (s.fallback !== undefined && s.channel === 'email') at('FALLBACK_INVALID');
    // R-INBOX-4: DM/chat only for the 60-second first response (no multi-turn autonomous replies)
    if (s.channel === 'inbound_channel' && opts.kind !== 'new_lead_response') at('INBOUND_CHANNEL_NOT_ALLOWED');

    const texts: { text: string; maxLength: number }[] = [{ text: s.template, maxLength: s.maxLength }];
    if (s.subject !== undefined) texts.push({ text: s.subject, maxLength: 200 });
    if (s.fallback !== undefined) texts.push({ text: s.fallback.template, maxLength: s.fallback.maxLength }, { text: s.fallback.subject, maxLength: 200 });
    for (const { text, maxLength } of texts) {
      const t = templateSlots(text);
      if (!t.syntaxOk) at('TEMPLATE_SYNTAX');
      for (const n of t.names) if (!(s.slots as readonly string[]).includes(n)) at('UNDECLARED_SLOT', n);
      if (detectPaymentInstructions(t.staticText)) at('TEMPLATE_PAYMENT_INSTRUCTIONS');
      for (const h of lexiconHits(t.staticText)) at('TEMPLATE_ALWAYS_HUMAN_TOPIC', h.label);
      if (opts.identity !== undefined && findHumanClaim(t.staticText, opts.identity) !== null) at('TEMPLATE_HUMAN_CLAIM');
      // R-FH-2: a template with fair-housing wording would only ever produce drafts; fix it first
      const fhr = fairHousingCheck(t.staticText, fh);
      for (const m of [...fhr.hard, ...fhr.soft]) at('TEMPLATE_FAIR_HOUSING', m.termId);
      if (s.intent === 'review_request' && reviewIncentive(t.staticText)) at('REVIEW_REQUEST_INCENTIVE');
      if (t.staticText.length + (text === s.template || text === s.fallback?.template ? IDENTITY_ALLOWANCE : 0) > maxLength) at('TEMPLATE_TOO_LONG');
    }
  });
  return issues;
}

/**
 * R-MKT-11: a review request never offers anything in return. VERIFY WITH COUNSEL (C8). The step
 * schema has no condition fields, so a request cannot be gated on sentiment or outcome at all.
 */
export function reviewIncentive(text: string): boolean {
  return /\b(?:gift\s*cards?|discount|coupon|rebate|reward|prize|raffle|giveaway|drawing|chance\s+to\s+win|free\s+\w+|in\s+(?:exchange|return)\s+for|thank[- ]you\s+gift|\$\s?\d|\d+\s*%\s*off|entered\s+to\s+win|(?:5|five)[- ]stars?|if\s+you\s+(?:were|are|felt)\s+(?:happy|satisfied|pleased)|positive\s+reviews?|good\s+reviews?|happy\s+(?:clients?|customers?)\s+only)\b/iu.test(text);
}

// ---- step scheduling ----------------------------------------------------------------------------

export interface StepAnchors {
  enrolledAt: Instant;
  /** When the previous step ran (sent or skipped); null before the first step. */
  previousStepAt: Instant | null;
  /** The event the playbook hangs off: appointment start, closing date, document deadline. */
  eventAt: Instant | null;
}

/** When a step is due, or null when its event anchor is unknown. */
export function stepDueAt(step: Pick<PlaybookStep, 'delay'>, a: StepAnchors): Instant | null {
  const base = step.delay.anchor === 'enrollment' ? a.enrolledAt : step.delay.anchor === 'previous_step' ? (a.previousStepAt ?? a.enrolledAt) : a.eventAt;
  return base === null ? null : instant(base + step.delay.offsetSeconds * 1000);
}

export type StepPlan =
  | { action: 'none'; reason: 'NOT_ACTIVE' }
  | { action: 'complete' }
  | { action: 'wait'; until: Instant }
  | { action: 'run'; index: number; step: PlaybookStep }
  /** Mark the step `skipped_ineligible` (visible reason) and move on to the next one. */
  | { action: 'skip'; index: number; step: PlaybookStep; reason: 'CAPABILITY_UNAVAILABLE' | 'EVENT_MISSING' | 'EVENT_PASSED' }
  /** End the enrollment (`stopped`, stop_reason `stop_if:<condition>`). */
  | { action: 'stop'; index: number; condition: StopCondition };

/**
 * What the worker does with an enrollment now. Pure: the facts (stop conditions that hold,
 * capabilities that exist) come from the caller under the contact lock.
 */
export function planNextStep(i: {
  state: 'active' | 'paused' | 'completed' | 'stopped';
  steps: readonly PlaybookStep[];
  currentStep: number;
  now: Instant;
  anchors: StepAnchors;
  facts: ReadonlySet<StopCondition>;
  capabilities: ReadonlySet<Capability>;
}): StepPlan {
  if (i.state !== 'active') return { action: 'none', reason: 'NOT_ACTIVE' };
  const step = i.steps[i.currentStep];
  if (step === undefined) return { action: 'complete' };
  const stop = step.stopIf.find((c) => i.facts.has(c));
  if (stop !== undefined) return { action: 'stop', index: i.currentStep, condition: stop };
  const required = [...(step.requires ?? []), ...(INTENT_RULES[step.intent].requires ?? [])];
  if (required.some((c) => !i.capabilities.has(c))) return { action: 'skip', index: i.currentStep, step, reason: 'CAPABILITY_UNAVAILABLE' };
  if (step.delay.anchor === 'event') {
    if (i.anchors.eventAt === null) return { action: 'skip', index: i.currentStep, step, reason: 'EVENT_MISSING' };
    if (step.delay.offsetSeconds <= 0 && i.anchors.eventAt <= i.now) return { action: 'skip', index: i.currentStep, step, reason: 'EVENT_PASSED' };
  }
  const due = stepDueAt(step, i.anchors) as Instant;
  if (due > i.now) return { action: 'wait', until: due };
  return { action: 'run', index: i.currentStep, step };
}

export type StepRunUpdate =
  | { status: 'sent' }
  | { status: 'skipped_ineligible'; reason: 'GATE_DENIED' }
  | { status: 'canceled_paused' };

/**
 * playbook_step_runs status after the send-time gate decision. Nothing is deferred any more
 * (core-compliance/2.0.0): an allowed step is sent; a step blocked because the client replied is
 * `canceled_paused` (the handback takes over); any other block is `skipped_ineligible`, visibly.
 */
export function stepRunAfterGate(d: Pick<GateDecision, 'outcome' | 'reasons'>): StepRunUpdate {
  if (d.outcome === 'allow') return { status: 'sent' };
  if (d.reasons.includes('AUTOMATION_PAUSED')) return { status: 'canceled_paused' };
  return { status: 'skipped_ineligible', reason: 'GATE_DENIED' };
}

// ---- versions and enrollments -------------------------------------------------------------------

/**
 * R-AST-4 migration at a step boundary: an enrollment moves to the newly approved version and
 * continues with the first step (in the new order) whose `stepKey` it has not run yet.
 */
export function migrateEnrollment(i: { newSteps: readonly PlaybookStep[]; ranStepKeys: ReadonlySet<string>; oldSteps: readonly PlaybookStep[] }): {
  currentStep: number;
  complete: boolean;
  /** Old steps not yet run that the new version no longer has. */
  droppedStepKeys: string[];
} {
  const idx = i.newSteps.findIndex((s) => !i.ranStepKeys.has(s.stepKey));
  const newKeys = new Set(i.newSteps.map((s) => s.stepKey));
  const droppedStepKeys = i.oldSteps.filter((s) => !i.ranStepKeys.has(s.stepKey) && !newKeys.has(s.stepKey)).map((s) => s.stepKey);
  return idx < 0 ? { currentStep: i.newSteps.length, complete: true, droppedStepKeys } : { currentStep: idx, complete: false, droppedStepKeys };
}

export type EnrollPlan =
  | { ok: true; action: 'enroll' }
  | { ok: true; action: 'replace'; stopEnrollmentId: string; stopReason: 'replaced' }
  | { ok: false; code: 'ALREADY_ENROLLED' }
  | { ok: false; code: 'ENROLLMENT_REPLACE_NEEDS_CONFIRMATION'; currentEnrollmentId: string; currentPlaybookId: string }
  | { ok: false; code: 'PLAYBOOK_INVALID' };

/**
 * R-AST-8: one live enrollment per contact. Enrolling into another playbook stops the first
 * (`replaced`) only after a human confirmed it; system enrollments never replace silently.
 */
export function planEnroll(i: {
  live: { enrollmentId: string; playbookId: string } | null;
  target: { playbookId: string; versionApproved: boolean };
  confirmedReplace: boolean;
}): EnrollPlan {
  if (!i.target.versionApproved) return { ok: false, code: 'PLAYBOOK_INVALID' };
  if (i.live === null) return { ok: true, action: 'enroll' };
  if (i.live.playbookId === i.target.playbookId) return { ok: false, code: 'ALREADY_ENROLLED' };
  if (!i.confirmedReplace) return { ok: false, code: 'ENROLLMENT_REPLACE_NEEDS_CONFIRMATION', currentEnrollmentId: i.live.enrollmentId, currentPlaybookId: i.live.playbookId };
  return { ok: true, action: 'replace', stopEnrollmentId: i.live.enrollmentId, stopReason: 'replaced' };
}

/**
 * R-AST-8: an ownership change pauses agent-scoped enrollments (`owner_change`) and offers the new
 * owner a one-tap continue; team playbooks keep running. A live enrollment that is already paused
 * (say, for a client reply) is re-paused as `owner_change` too: otherwise the re-homed handback's
 * "resume" would restart the previous agent's playbook without the new owner choosing to continue.
 */
export function onOwnerChange(i: { state: 'active' | 'paused' | 'completed' | 'stopped'; scope: 'team' | 'agent'; playbookOwnerUserId: string | null; newOwnerUserId: string | null }):
  | { action: 'keep' }
  | { action: 'pause'; pauseReason: 'owner_change'; offerContinueTo: string | null } {
  if ((i.state !== 'active' && i.state !== 'paused') || i.scope === 'team') return { action: 'keep' };
  if (i.playbookOwnerUserId !== null && i.playbookOwnerUserId === i.newOwnerUserId) return { action: 'keep' };
  return { action: 'pause', pauseReason: 'owner_change', offerContinueTo: i.newOwnerUserId };
}

// ---- the 60-second first response ---------------------------------------------------------------

export const FIRST_RESPONSE_DEDUPE_MS = DAY_MS;

const INBOUND_WORDS: Readonly<Record<InboundChannel, string>> = { web_chat: 'web chat' };

/** Where a lead wrote from, when it was a DM or chat (R-INBOX-4). */
// Owner decision D2: Messenger and Instagram direct messages are out of scope; web chat only.
export type InboundChannel = 'web_chat';

export type FirstResponsePlan =
  | { send: true; channel: 'sms' | 'email' | InboundChannel; explanation: string }
  | { send: false; reason: 'PLAYBOOK_NOT_APPROVED' | 'CATEGORY_DISABLED' | 'ALREADY_SENT' | 'NO_ALLOWED_CHANNEL'; explanation: string };

/**
 * R-AST-16: ONE message from the approved team `new_lead_response` playbook. SMS when the step is an
 * SMS step and the lead's phone can take texts and has not opted out (STOP / do-not-contact) and is
 * not suppressed; otherwise email, if there is a usable, not opted-out address and the step has an
 * email form. No consent level is read (owner decision, core-compliance/2.0.0). Deduped per contact
 * per 24 h. When nothing can be sent, the feed card says why. The send-time gate re-checks
 * everything (opt-out included) when the message goes.
 */
export function planFirstResponse(i: {
  now: Instant;
  version: { status: string; contentSha256: string } | null;
  latestApproval: { decision: 'approve' | 'revoke'; contentSha256: string } | null;
  step: PlaybookStep | null;
  tenantAutonomous: ReadonlySet<ActionCategory>;
  sms: { reachable: boolean; revokedOrSuppressed: boolean };
  email: { reachable: boolean; revokedOrSuppressed: boolean };
  /** The DM/chat the lead wrote from; only an `inbound_channel` step replies there (R-INBOX-4). */
  inbound?: { channel: InboundChannel; reachable: boolean; revokedOrSuppressed: boolean };
  lastFirstResponseAt: Instant | null;
}): FirstResponsePlan {
  if (i.step === null || !approvalCurrent(i.version, i.latestApproval)) {
    return { send: false, reason: 'PLAYBOOK_NOT_APPROVED', explanation: 'No instant reply was sent: the new-lead reply playbook is not approved yet.' };
  }
  if (!i.tenantAutonomous.has('speed_to_lead_reply')) {
    return { send: false, reason: 'CATEGORY_DISABLED', explanation: 'No instant reply was sent: instant replies to new leads are turned off for the team.' };
  }
  // A first response stamped in the future (clock skew between writers) is still a recent one.
  if (i.lastFirstResponseAt !== null && i.now - i.lastFirstResponseAt < FIRST_RESPONSE_DEDUPE_MS) {
    return { send: false, reason: 'ALREADY_SENT', explanation: 'The assistant already sent this lead an instant reply in the last 24 hours.' };
  }
  if (i.step.channel === 'inbound_channel' && i.inbound !== undefined && i.inbound.reachable && !i.inbound.revokedOrSuppressed) {
    return { send: true, channel: i.inbound.channel, explanation: `The assistant sent the instant reply where the lead wrote (${INBOUND_WORDS[i.inbound.channel]}).` };
  }
  const smsOk = i.step.channel === 'sms' && i.sms.reachable && !i.sms.revokedOrSuppressed;
  if (smsOk) return { send: true, channel: 'sms', explanation: 'The assistant sent the instant reply by text.' };
  const emailForm = i.step.channel === 'email' || i.step.fallback !== undefined;
  if (emailForm && i.email.reachable && !i.email.revokedOrSuppressed) {
    return {
      send: true,
      channel: 'email',
      explanation:
        i.step.channel === 'sms'
          ? 'The assistant sent the instant reply by email (this number cannot get texts or opted out).'
          : i.step.channel === 'inbound_channel'
            ? 'The assistant sent the instant reply by email (it could not reply where the lead wrote).'
            : 'The assistant sent the instant reply by email.',
    };
  }
  return { send: false, reason: 'NO_ALLOWED_CHANNEL', explanation: 'No instant reply was sent: there is no number or email address that can get it (opted out, a landline or missing). Reach out yourself.' };
}
