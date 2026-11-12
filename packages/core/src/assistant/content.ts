// One playbook content union (PHASE2_3_PLAN §5.4 #25; R-NURT-1, R-AST-20, R-INBOX-4).
//
// `playbook_versions.steps` holds a step playbook's `PlaybookStep[]` (Phase 1, unchanged) or one
// `PlaybookContent` object for trigger and voice playbooks (0018). `contentSha256` (./playbook.ts)
// hashes whatever is stored, so the Owner's or agent's approval binds the exact content, including a
// trigger playbook's digest window and a first response's `inbound_channel` step channel.
//
// Trigger steps run only as steps of an approved playbook in an EXISTING autonomous category (no
// new category, R-AST-20); each trigger kind admits exactly the intents listed in TRIGGER_RULES.
// The voice shape is the stored content of a `voice_answering` playbook; the call policy machine is
// core/voice (module 47), which reads it.
import { z } from 'zod';
import { AUTONOMOUS_ELIGIBLE, type ActionCategory } from '../compliance/index.js';
import { findHumanClaim } from './guard.js';
import { type PlaybookKind, type PlaybookStep, SLOT_NAMES, STEP_INTENTS, type StepIntent, type ValidationIssue, validatePlaybook } from './playbook.js';
import type { IdentityFacts } from './types.js';
import type { FairHousingPack } from '../fairhousing/index.js';

export const TRIGGER_KINDS = ['price_drop', 'back_on_market', 'home_value', 'home_anniversary', 'deal_date_upcoming'] as const;
export type TriggerKind = (typeof TRIGGER_KINDS)[number];

/** Which intents each trigger may carry (facts only, R-NURT-2). Rate moves are deferred (R-NURT-6). */
export const TRIGGER_RULES: Readonly<Record<TriggerKind, { intents: readonly StepIntent[] }>> = {
  price_drop: { intents: ['price_drop_alert'] },
  back_on_market: { intents: ['back_on_market_alert'] },
  home_value: { intents: ['home_value_update'] },
  home_anniversary: { intents: ['home_anniversary'] },
  deal_date_upcoming: { intents: ['deadline_reminder'] },
};

const AUTONOMOUS = [...AUTONOMOUS_ELIGIBLE] as [ActionCategory, ...ActionCategory[]];
const MAX_TRIGGER_OFFSET = 60 * 24 * 3600;

/**
 * deal_contacts roles (0018) a `deal_date_upcoming` step may name as its recipients (module 31, R-TXN-4).
 * Approved content: a deal-date update goes only to the deal's contacts in one of these roles.
 */
export const DEAL_CONTACT_ROLES = ['buyer', 'seller', 'co_buyer', 'co_seller', 'other', 'lender', 'title', 'attorney'] as const;
export type DealContactRole = (typeof DEAL_CONTACT_ROLES)[number];

const TriggerStepInner = z.strictObject({
  trigger: z.enum(TRIGGER_KINDS),
  stepKey: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
  channel: z.enum(['sms', 'email']),
  /** Seconds after the fact (negative: before a deal date). */
  offsetSeconds: z.number().int().min(-MAX_TRIGGER_OFFSET).max(MAX_TRIGGER_OFFSET),
  purpose: z.enum(['marketing', 'informational']),
  category: z.enum(AUTONOMOUS),
  intent: z.enum(STEP_INTENTS),
  template: z.string().min(1).max(4000),
  subject: z.string().min(1).max(200).optional(),
  slots: z.array(z.enum(SLOT_NAMES)).max(SLOT_NAMES.length),
  maxLength: z.number().int().min(20).max(10_000),
  /** `deal_date_upcoming` only (required there, refused elsewhere): the deal roles that receive it (R-TXN-4). */
  roles: z.array(z.enum(DEAL_CONTACT_ROLES)).min(1).max(DEAL_CONTACT_ROLES.length).optional(),
});
export type TriggerStep = z.infer<typeof TriggerStepInner>;
export const TriggerStepSchema: z.ZodType<TriggerStep> = TriggerStepInner;

/** Closed tool set of a voice answering session (R-VOICE-*; the policy machine is core/voice). */
export const VOICE_TOOLS = ['share_listing_facts', 'book_appointment', 'take_message', 'transfer_to_owner'] as const;
export type VoiceTool = (typeof VOICE_TOOLS)[number];

const VoiceContentInner = z.strictObject({
  /** Said first, before any tool request. Must say it is an assistant (R-AST-11). VERIFY WITH COUNSEL (C2). */
  disclosure: z.string().min(20).max(400),
  recordingAnnouncement: z.string().min(10).max(300),
  tools: z.array(z.enum(VOICE_TOOLS)).min(1).max(VOICE_TOOLS.length),
  maxCallSeconds: z.number().int().min(60).max(900),
  /** How long a hot caller holds for the contact's own agent (R-VOICE-6). */
  transferHoldSeconds: z.number().int().min(5).max(60),
});
export type VoiceContent = z.infer<typeof VoiceContentInner>;
export const VoiceContentSchema: z.ZodType<VoiceContent> = VoiceContentInner;

export type PlaybookContent =
  | { kind: 'steps'; steps: PlaybookStep[] }
  | { kind: 'triggers'; triggers: TriggerStep[]; digestWindowMinutes: number }
  | { kind: 'voice'; voice: VoiceContent };

const ContentInner = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('steps'), steps: z.array(z.unknown()) }),
  z.strictObject({ kind: z.literal('triggers'), triggers: z.array(z.unknown()).min(1).max(20), digestWindowMinutes: z.number().int().min(0).max(1440) }),
  z.strictObject({ kind: z.literal('voice'), voice: z.unknown() }),
]);

/** The content stored in `playbook_versions.steps`: an array is a step playbook (Phase 1). */
export function storedContent(json: unknown): { kind: 'steps'; steps: unknown[] } | { kind: 'triggers'; triggers: unknown[]; digestWindowMinutes: number } | { kind: 'voice'; voice: unknown } | null {
  if (Array.isArray(json)) return { kind: 'steps', steps: json };
  const r = ContentInner.safeParse(json);
  return r.success ? r.data : null;
}

/**
 * What `validatePlaybook` sees for a trigger step: the shared template, intent and category checks.
 * Exported (module 26, additive) so the send-time re-check in dispatch and the trigger run builder
 * authorize a trigger message against exactly the step the validator saw.
 */
export function triggerStepAsPlaybookStep(t: TriggerStep): PlaybookStep {
  return {
    stepKey: t.stepKey,
    channel: t.channel,
    delay: { anchor: 'event', offsetSeconds: t.offsetSeconds },
    purpose: t.purpose,
    category: t.category,
    intent: t.intent,
    template: t.template,
    ...(t.subject !== undefined ? { subject: t.subject } : {}),
    personalization: 'none',
    slots: t.slots,
    maxLength: t.maxLength,
    stopIf: [],
  };
}

const EXPECTED: Readonly<Record<PlaybookKind, PlaybookContent['kind']>> = {
  new_lead_response: 'steps',
  nurture: 'steps',
  post_closing: 'steps',
  booking_confirmation: 'steps',
  reminder: 'steps',
  document_chase: 'steps',
  trigger: 'triggers',
  voice_answering: 'voice',
};

/**
 * Issues that block approval of a version's content (any kind). Empty for every valid step,
 * trigger and voice content, so `PLAYBOOK_INVALID` never fires for one.
 */
export function validatePlaybookContent(raw: unknown, opts: { kind: PlaybookKind; identity?: IdentityFacts; fairHousing?: FairHousingPack }): ValidationIssue[] {
  const c = storedContent(raw);
  if (c === null) return [{ index: -1, code: 'SCHEMA', detail: 'content' }];
  if (c.kind !== EXPECTED[opts.kind]) return [{ index: -1, code: 'CONTENT_KIND_MISMATCH', detail: `${opts.kind}/${c.kind}` }];
  const base = { kind: opts.kind, ...(opts.identity !== undefined ? { identity: opts.identity } : {}), ...(opts.fairHousing !== undefined ? { fairHousing: opts.fairHousing } : {}) };
  if (c.kind === 'steps') return validatePlaybook(c.steps, base);
  if (c.kind === 'voice') {
    const v = VoiceContentInner.safeParse(c.voice);
    if (!v.success) return v.error.issues.map((e) => ({ index: -1, code: 'SCHEMA' as const, detail: `voice.${e.path.join('.') || e.code}` }));
    const issues: ValidationIssue[] = [];
    if (new Set(v.data.tools).size !== v.data.tools.length) issues.push({ index: -1, code: 'SCHEMA', detail: 'voice.tools duplicate' });
    if (!/\b(?:assistant|automated|virtual|ai)\b/iu.test(v.data.disclosure)) issues.push({ index: -1, code: 'VOICE_DISCLOSURE_MISSING' });
    if (opts.identity !== undefined && findHumanClaim(v.data.disclosure, opts.identity) !== null) issues.push({ index: -1, code: 'TEMPLATE_HUMAN_CLAIM', detail: 'voice.disclosure' });
    return issues;
  }
  const issues: ValidationIssue[] = [];
  const parsed: TriggerStep[] = [];
  c.triggers.forEach((raw, index) => {
    const r = TriggerStepInner.safeParse(raw);
    if (!r.success) {
      for (const e of r.error.issues) issues.push({ index, code: 'SCHEMA', detail: e.path.join('.') || e.code });
      return;
    }
    // R-TXN-4 (module 31): a deal-date update names its recipients and goes out at the date's stored reminder
    // time (reminder_at, computed at confirm time), so its offset is 0; no other trigger has recipients by role.
    // Reported as SCHEMA issues with the field as detail (ValidationCode stays unchanged).
    if (r.data.trigger === 'deal_date_upcoming') {
      if (r.data.roles === undefined) issues.push({ index, stepKey: r.data.stepKey, code: 'SCHEMA', detail: 'roles' });
      else if (new Set(r.data.roles).size !== r.data.roles.length) issues.push({ index, stepKey: r.data.stepKey, code: 'SCHEMA', detail: 'roles duplicate' });
      if (r.data.offsetSeconds !== 0) issues.push({ index, stepKey: r.data.stepKey, code: 'SCHEMA', detail: 'offsetSeconds' });
    } else if (r.data.roles !== undefined) {
      issues.push({ index, stepKey: r.data.stepKey, code: 'SCHEMA', detail: 'roles' });
    }
    parsed.push(r.data);
    if (!TRIGGER_RULES[r.data.trigger].intents.includes(r.data.intent)) issues.push({ index, stepKey: r.data.stepKey, code: 'TRIGGER_INTENT_MISMATCH', detail: `${r.data.trigger}/${r.data.intent}` });
  });
  const seen = new Set<TriggerKind>();
  parsed.forEach((t) => {
    if (seen.has(t.trigger)) issues.push({ index: c.triggers.indexOf(t as unknown), stepKey: t.stepKey, code: 'DUPLICATE_TRIGGER', detail: t.trigger });
    seen.add(t.trigger);
  });
  if (issues.some((i) => i.code === 'SCHEMA')) return issues;
  return [...issues, ...validatePlaybook(parsed.map(triggerStepAsPlaybookStep), base)];
}

/** The trigger step for a firing's trigger kind, or null when the content has none. */
export function triggerStepFor(content: Extract<PlaybookContent, { kind: 'triggers' }>, trigger: TriggerKind): TriggerStep | null {
  return content.triggers.find((t) => t.trigger === trigger) ?? null;
}

/**
 * The trigger step `stepKey` of stored trigger content (`playbook_versions.steps`), or null when the
 * content is not trigger content, has no such step, or the step does not parse. Module 26 (additive):
 * the send-time re-check of a trigger message reads its step here.
 */
export function storedTriggerStep(json: unknown, stepKey: string): TriggerStep | null {
  const c = storedContent(json);
  if (c === null || c.kind !== 'triggers') return null;
  const raw = c.triggers.find((t) => typeof t === 'object' && t !== null && (t as { stepKey?: unknown }).stepKey === stepKey);
  const r = raw === undefined ? null : TriggerStepInner.safeParse(raw);
  return r !== null && r.success ? r.data : null;
}
