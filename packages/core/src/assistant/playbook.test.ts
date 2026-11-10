import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { ActionCategory, ConsentStateRow, GateDecision } from '../compliance/index.js';
import { DAY_MS, HOUR_MS, type Instant, at, instant } from '../foundation/index.js';
import {
  INTENT_RULES,
  PlaybookStepSchema,
  STEP_INTENTS,
  type StopCondition,
  ToneSchema,
  contentSha256,
  migrateEnrollment,
  onOwnerChange,
  planEnroll,
  planFirstResponse,
  planNextStep,
  stepDueAt,
  stepRunAfterGate,
  validatePlaybook,
} from './playbook.js';
import { NOW, firstResponseStep, step, teamIdentity } from './testing/fixtures.js';

const codes = (steps: unknown[], o?: Parameters<typeof validatePlaybook>[1]) => validatePlaybook(steps, o).map((i) => i.code);

describe('PlaybookStepSchema', () => {
  it('accepts a well-formed step and rejects always-human categories, voice and unknown keys', () => {
    expect(PlaybookStepSchema.safeParse(step()).success).toBe(true);
    for (const category of ['money', 'contract', 'novel_message', 'seller_update', 'none', 'agent_alert']) {
      expect(PlaybookStepSchema.safeParse(step({ category: category as ActionCategory })).success, category).toBe(false);
    }
    expect(PlaybookStepSchema.safeParse({ ...step(), channel: 'voice' }).success).toBe(false);
    expect(PlaybookStepSchema.safeParse({ ...step(), confidence: 0.9 }).success).toBe(false);
    expect(PlaybookStepSchema.safeParse({ ...step(), stepKey: 'Bad Key' }).success).toBe(false);
    expect(ToneSchema.safeParse({ formality: 'casual', emoji: false }).success).toBe(true);
    expect(ToneSchema.safeParse({ confidence: 1 }).success).toBe(false);
  });
});

describe('validatePlaybook (R-CONSENT-5 purpose, R-AST-3, R-AST-16)', () => {
  it('a good nurture playbook and a good first-response playbook have no issues', () => {
    expect(validatePlaybook([step(), step({ stepKey: 'check_in_2', delay: { anchor: 'previous_step', offsetSeconds: 7 * 86400 } })], { kind: 'nurture', identity: teamIdentity() })).toEqual([]);
    expect(validatePlaybook([firstResponseStep()], { kind: 'new_lead_response' })).toEqual([]);
  });

  it.each(STEP_INTENTS.filter((i) => INTENT_RULES[i].purpose === 'marketing'))('R-CONSENT-5 rejects the marketing intent %s declared as informational', (intent) => {
    const category = INTENT_RULES[intent].categories[0] as ActionCategory;
    expect(codes([step({ intent, category, purpose: 'informational' })])).toEqual(['MARKETING_INTENT_DECLARED_INFORMATIONAL']);
    expect(codes([step({ intent, category, purpose: 'marketing' })])).toEqual([]);
  });

  it('R-CONSENT-5 an informational intent may be declared marketing (stricter)', () => {
    expect(codes([step({ intent: 'appointment_reminder', category: 'reminder', purpose: 'marketing' })])).toEqual([]);
  });

  it('flags every structural problem', () => {
    expect(codes([])).toEqual(['NO_STEPS']);
    expect(codes([{ nope: 1 }]).every((c) => c === 'SCHEMA')).toBe(true);
    expect(codes([{ ...step(), category: 'money' }])).toEqual(['SCHEMA']);
    expect(codes([step(), step()])).toEqual(['DUPLICATE_STEP_KEY']);
    expect(codes([step({ intent: 'appointment_reminder' })])).toEqual(['INTENT_CATEGORY_MISMATCH']);
    expect(codes([step()], { kind: 'reminder' })).toEqual(['KIND_CATEGORY_MISMATCH']);
    expect(codes([firstResponseStep(), firstResponseStep({ stepKey: 'second' })], { kind: 'new_lead_response' })).toEqual(['KIND_STEP_COUNT']);
    expect(codes([step({ template: 'Hi {{last_name}}' })])).toEqual(['UNDECLARED_SLOT']);
    expect(codes([step({ template: 'Hi {{first_name}' })])).toEqual(['TEMPLATE_SYNTAX']);
    expect(codes([step({ template: 'Hi {{#first_name}}x' })])).toEqual(['TEMPLATE_SYNTAX']);
    expect(codes([step({ channel: 'email' })])).toEqual(['EMAIL_SUBJECT_REQUIRED']);
    expect(codes([step({ subject: 'Hi' })])).toEqual(['SMS_SUBJECT_NOT_ALLOWED']);
    expect(codes([step({ channel: 'email', subject: 'Hi', fallback: { subject: 's', template: 't', maxLength: 100 } })])).toEqual(['FALLBACK_INVALID']);
    expect(codes([step({ delay: { anchor: 'enrollment', offsetSeconds: -60 } })])).toEqual(['NEGATIVE_DELAY_WITHOUT_EVENT']);
    expect(codes([step({ template: 'x'.repeat(300), maxLength: 320 })])).toEqual(['TEMPLATE_TOO_LONG']);
  });

  it('R-AST-3 R-GATE-7 templates that would always need a tap, or claim to be a person, are refused up front', () => {
    expect(codes([step({ template: 'Ready to make an offer, {{first_name}}?' })])).toEqual(['TEMPLATE_ALWAYS_HUMAN_TOPIC']);
    expect(codes([step({ template: 'Wire funds to routing 021000021' })])).toEqual(['TEMPLATE_PAYMENT_INSTRUCTIONS', 'TEMPLATE_ALWAYS_HUMAN_TOPIC', 'TEMPLATE_ALWAYS_HUMAN_TOPIC']);
    expect(codes([step({ template: 'Hi {{first_name}}, this is Sarah!' })], { identity: teamIdentity() })).toEqual(['TEMPLATE_HUMAN_CLAIM']);
    expect(codes([firstResponseStep({ fallback: { subject: 'Your contract', template: 'Hi', maxLength: 500 } })])).toEqual(['TEMPLATE_ALWAYS_HUMAN_TOPIC']);
  });
});

describe('contentSha256 (R-AST-4 hash binding)', () => {
  it('R-AST-4 is stable under key order and changes with any content change', () => {
    const a = step();
    const reordered = Object.fromEntries(Object.entries(a).reverse()) as typeof a;
    expect(contentSha256([a], { emoji: false })).toBe(contentSha256([reordered], { emoji: false }));
    expect(contentSha256([a], {})).toMatch(/^[0-9a-f]{64}$/);
    expect(contentSha256([a], {})).not.toBe(contentSha256([{ ...a, template: `${a.template} ` }], {}));
    expect(contentSha256([a], {})).not.toBe(contentSha256([a], { emoji: true }));
    expect(contentSha256([a, step({ stepKey: 'b' })], {})).not.toBe(contentSha256([step({ stepKey: 'b' }), a], {}));
  });

  it('R-AST-4 property: equal content ⇔ equal hash', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 40 }), fc.string({ minLength: 1, maxLength: 40 }), (t1, t2) => {
        expect(contentSha256([step({ template: t1 })], {}) === contentSha256([step({ template: t2 })], {})).toBe(t1 === t2);
      }),
    );
  });
});

describe('step scheduling and planNextStep', () => {
  const enrolledAt = at('2026-11-01T15:00:00Z');
  const anchors = { enrolledAt, previousStepAt: null, eventAt: null };
  const plan = (o: Partial<Parameters<typeof planNextStep>[0]>) =>
    planNextStep({ state: 'active', steps: [step()], currentStep: 0, now: NOW, anchors, facts: new Set(), capabilities: new Set(), ...o });

  it('computes due times from enrollment, previous step or event', () => {
    expect(stepDueAt({ delay: { anchor: 'enrollment', offsetSeconds: 3600 } }, anchors)).toBe(enrolledAt + HOUR_MS);
    expect(stepDueAt({ delay: { anchor: 'previous_step', offsetSeconds: 60 } }, anchors)).toBe(enrolledAt + 60_000);
    expect(stepDueAt({ delay: { anchor: 'previous_step', offsetSeconds: 60 } }, { ...anchors, previousStepAt: NOW })).toBe(NOW + 60_000);
    expect(stepDueAt({ delay: { anchor: 'event', offsetSeconds: -86400 } }, anchors)).toBeNull();
    expect(stepDueAt({ delay: { anchor: 'event', offsetSeconds: -86400 } }, { ...anchors, eventAt: NOW })).toBe(NOW - DAY_MS);
  });

  it('runs a due step, waits for a future one, completes past the end, ignores non-active enrollments', () => {
    expect(plan({})).toMatchObject({ action: 'run', index: 0 });
    expect(plan({ steps: [step({ delay: { anchor: 'enrollment', offsetSeconds: 30 * 86400 } })] })).toEqual({ action: 'wait', until: enrolledAt + 30 * DAY_MS });
    expect(plan({ currentStep: 1 })).toEqual({ action: 'complete' });
    for (const state of ['paused', 'completed', 'stopped'] as const) expect(plan({ state })).toEqual({ action: 'none', reason: 'NOT_ACTIVE' });
  });

  it('stops on a stop condition, skips steps that need a missing capability (the post-closing AVM step) or a missing/passed event', () => {
    expect(plan({ steps: [step({ stopIf: ['appointment_booked'] })], facts: new Set<StopCondition>(['appointment_booked']) })).toEqual({ action: 'stop', index: 0, condition: 'appointment_booked' });
    expect(plan({ steps: [step({ stopIf: ['deal_closed'] })], facts: new Set<StopCondition>(['appointment_booked']) })).toMatchObject({ action: 'run' });
    expect(plan({ steps: [step({ intent: 'home_value_update' })] })).toMatchObject({ action: 'skip', reason: 'CAPABILITY_UNAVAILABLE' });
    expect(plan({ steps: [step({ intent: 'home_value_update' })], capabilities: new Set(['avm']) })).toMatchObject({ action: 'run' });
    expect(plan({ steps: [step({ requires: ['avm'] })] })).toMatchObject({ action: 'skip', reason: 'CAPABILITY_UNAVAILABLE' });
    const reminder = step({ intent: 'appointment_reminder', category: 'reminder', purpose: 'informational', delay: { anchor: 'event', offsetSeconds: -86400 } });
    expect(plan({ steps: [reminder] })).toMatchObject({ action: 'skip', reason: 'EVENT_MISSING' });
    expect(plan({ steps: [reminder], anchors: { ...anchors, eventAt: instant(NOW - 1) } })).toMatchObject({ action: 'skip', reason: 'EVENT_PASSED' });
    expect(plan({ steps: [reminder], anchors: { ...anchors, eventAt: instant(NOW + 2 * HOUR_MS) } })).toMatchObject({ action: 'run' }); // late, but before the appointment
    expect(plan({ steps: [reminder], anchors: { ...anchors, eventAt: instant(NOW + 3 * DAY_MS) } })).toEqual({ action: 'wait', until: NOW + 2 * DAY_MS });
    const anniversary = step({ intent: 'home_anniversary', delay: { anchor: 'event', offsetSeconds: 365 * 86400 } });
    expect(plan({ steps: [anniversary], anchors: { ...anchors, eventAt: instant(NOW - 400 * DAY_MS) } })).toMatchObject({ action: 'run' });
  });
});

// R-CONSENT-14 deferral bookkeeping (the caps themselves are core/compliance)
describe('stepRunAfterGate', () => {
  const policy = { caps: { maxDeferrals: 3 } as never };
  const d = (outcome: GateDecision['outcome'], reasons: GateDecision['reasons'], deferUntil?: Instant) => ({ outcome, reasons, deferUntil });
  it('allow ⇒ sent; pause ⇒ canceled_paused; other deny ⇒ skipped_ineligible (visible)', () => {
    expect(stepRunAfterGate(d('allow', []), 0, policy)).toEqual({ status: 'sent' });
    expect(stepRunAfterGate(d('deny', ['AUTOMATION_PAUSED', 'CONSENT_REVOKED']), 0, policy)).toEqual({ status: 'canceled_paused' });
    expect(stepRunAfterGate(d('deny', ['CONSENT_REVOKED']), 1, policy)).toEqual({ status: 'skipped_ineligible', reason: 'GATE_DENIED', deferrals: 1 });
    expect(stepRunAfterGate(d('needs_confirmation', ['CONSENT_CONFIRMATION_REQUIRED']), 0, policy)).toMatchObject({ status: 'skipped_ineligible' });
  });

  it('caps defer and never drop until maxDeferrals; quiet-hours deferrals do not count', () => {
    const until = instant(NOW + HOUR_MS);
    expect(stepRunAfterGate(d('defer', ['FREQUENCY_CAP'], until), 0, policy)).toEqual({ status: 'deferred', scheduledFor: until, deferrals: 1 });
    expect(stepRunAfterGate(d('defer', ['FREQUENCY_CAP'], until), 2, policy)).toEqual({ status: 'deferred', scheduledFor: until, deferrals: 3 });
    expect(stepRunAfterGate(d('defer', ['FREQUENCY_CAP'], until), 3, policy)).toEqual({ status: 'skipped_ineligible', reason: 'TOO_MANY_DEFERRALS', deferrals: 3 });
    expect(stepRunAfterGate(d('defer', ['QUIET_HOURS_DEFERRED'], until), 3, policy)).toEqual({ status: 'deferred', scheduledFor: until, deferrals: 3 });
  });
});

describe('migrateEnrollment (R-AST-4, E31)', () => {
  const a = step({ stepKey: 'a' });
  const b = step({ stepKey: 'b' });
  const c = step({ stepKey: 'c' });
  const x = step({ stepKey: 'x' });
  it('R-AST-4 E31 continues with the first step of the new version not yet run, by stepKey', () => {
    expect(migrateEnrollment({ oldSteps: [a, b, c], newSteps: [a, x, b, c], ranStepKeys: new Set(['a', 'b']) })).toEqual({ currentStep: 1, complete: false, droppedStepKeys: [] });
    expect(migrateEnrollment({ oldSteps: [a, b, c], newSteps: [a, b], ranStepKeys: new Set(['a']) })).toEqual({ currentStep: 1, complete: false, droppedStepKeys: ['c'] });
    expect(migrateEnrollment({ oldSteps: [a, b], newSteps: [a, b], ranStepKeys: new Set(['a', 'b']) })).toEqual({ currentStep: 2, complete: true, droppedStepKeys: [] });
  });

  it('R-AST-4 property: a migrated enrollment never re-runs a step it already ran', () => {
    const keys = ['a', 'b', 'c', 'd', 'e'];
    fc.assert(
      fc.property(fc.shuffledSubarray(keys), fc.shuffledSubarray(keys), fc.subarray(keys), (oldK, newK, ran) => {
        const r = migrateEnrollment({ oldSteps: oldK.map((k) => step({ stepKey: k })), newSteps: newK.map((k) => step({ stepKey: k })), ranStepKeys: new Set(ran) });
        if (!r.complete) expect(ran).not.toContain(newK[r.currentStep]);
        else expect(newK.every((k) => ran.includes(k))).toBe(true);
      }),
    );
  });
});

describe('planEnroll / onOwnerChange (R-AST-8)', () => {
  it('R-AST-8 one live enrollment: replacing another playbook needs confirmation, then stops the first as replaced', () => {
    const target = { playbookId: 'p2', versionApproved: true };
    expect(planEnroll({ live: null, target, confirmedReplace: false })).toEqual({ ok: true, action: 'enroll' });
    expect(planEnroll({ live: { enrollmentId: 'e1', playbookId: 'p2' }, target, confirmedReplace: true })).toEqual({ ok: false, code: 'ALREADY_ENROLLED' });
    expect(planEnroll({ live: { enrollmentId: 'e1', playbookId: 'p1' }, target, confirmedReplace: false })).toEqual({
      ok: false,
      code: 'ENROLLMENT_REPLACE_NEEDS_CONFIRMATION',
      currentEnrollmentId: 'e1',
      currentPlaybookId: 'p1',
    });
    expect(planEnroll({ live: { enrollmentId: 'e1', playbookId: 'p1' }, target, confirmedReplace: true })).toEqual({ ok: true, action: 'replace', stopEnrollmentId: 'e1', stopReason: 'replaced' });
    expect(planEnroll({ live: null, target: { ...target, versionApproved: false }, confirmedReplace: true })).toEqual({ ok: false, code: 'PLAYBOOK_INVALID' });
  });

  it('R-AST-8 an ownership change pauses agent-scoped enrollments and offers the new owner a continue; team ones keep running', () => {
    expect(onOwnerChange({ state: 'active', scope: 'agent', playbookOwnerUserId: 'u1', newOwnerUserId: 'u2' })).toEqual({ action: 'pause', pauseReason: 'owner_change', offerContinueTo: 'u2' });
    expect(onOwnerChange({ state: 'active', scope: 'agent', playbookOwnerUserId: 'u1', newOwnerUserId: null })).toEqual({ action: 'pause', pauseReason: 'owner_change', offerContinueTo: null });
    expect(onOwnerChange({ state: 'active', scope: 'agent', playbookOwnerUserId: 'u2', newOwnerUserId: 'u2' })).toEqual({ action: 'keep' });
    expect(onOwnerChange({ state: 'active', scope: 'team', playbookOwnerUserId: null, newOwnerUserId: 'u2' })).toEqual({ action: 'keep' });
    // a paused live enrollment is re-paused as owner_change (see adversarial.test.ts)
    expect(onOwnerChange({ state: 'paused', scope: 'agent', playbookOwnerUserId: 'u1', newOwnerUserId: 'u2' })).toEqual({ action: 'pause', pauseReason: 'owner_change', offerContinueTo: 'u2' });
    expect(onOwnerChange({ state: 'completed', scope: 'agent', playbookOwnerUserId: 'u1', newOwnerUserId: 'u2' })).toEqual({ action: 'keep' });
  });
});

describe('planFirstResponse (R-AST-16, E37)', () => {
  const fr = firstResponseStep();
  const hash = contentSha256([fr], {});
  const sms = (level: ConsentStateRow['level'], o: Partial<ConsentStateRow> = {}): ConsentStateRow => ({
    channel: 'sms',
    purpose: 'informational',
    addressHmac: 'a'.repeat(64),
    status: 'granted',
    level,
    basisEventId: 'e1',
    expiresAt: null,
    ledgerEventCount: 1,
    ...o,
  });
  const base = {
    now: NOW,
    version: { status: 'approved', contentSha256: hash },
    latestApproval: { decision: 'approve' as const, contentSha256: hash },
    step: fr,
    tenantAutonomous: new Set<ActionCategory>(['speed_to_lead_reply']),
    sms: { reachable: true, consent: sms('express') },
    email: { reachable: true, revokedOrSuppressed: false },
    lastFirstResponseAt: null,
  };

  it('R-AST-16 SMS when the basis is express or better', () => {
    expect(planFirstResponse(base)).toMatchObject({ send: true, channel: 'sms' });
    expect(planFirstResponse({ ...base, sms: { reachable: true, consent: sms('express_written') } })).toMatchObject({ send: true, channel: 'sms' });
  });

  it.each([
    ['inquiry', sms('inquiry', { expiresAt: instant(NOW + DAY_MS) })],
    ['imported only', sms('imported_unverified')],
    ['revoked', sms('express', { status: 'revoked' })],
    ['expired', sms('express', { expiresAt: instant(NOW - 1) })],
    ['no row', undefined],
  ] as const)('R-AST-16 E37 basis %s ⇒ email only', (_n, consent) => {
    expect(planFirstResponse({ ...base, sms: { reachable: true, consent } })).toMatchObject({ send: true, channel: 'email' });
  });

  it('R-AST-16 no SMS-capable number ⇒ email; nothing usable ⇒ nothing sent and the card says why', () => {
    expect(planFirstResponse({ ...base, sms: { reachable: false, consent: sms('express') } })).toMatchObject({ send: true, channel: 'email' });
    const none = planFirstResponse({ ...base, sms: { reachable: true, consent: undefined }, email: { reachable: false, revokedOrSuppressed: false } });
    expect(none).toMatchObject({ send: false, reason: 'NO_ALLOWED_CHANNEL' });
    expect(none.explanation).toMatch(/Reach out yourself/);
    expect(planFirstResponse({ ...base, sms: { reachable: true, consent: undefined }, email: { reachable: true, revokedOrSuppressed: true } })).toMatchObject({ send: false, reason: 'NO_ALLOWED_CHANNEL' });
    expect(planFirstResponse({ ...base, step: { ...fr, fallback: undefined }, sms: { reachable: true, consent: undefined } })).toMatchObject({ send: false, reason: 'NO_ALLOWED_CHANNEL' });
    expect(planFirstResponse({ ...base, step: step({ channel: 'email', subject: 'Hi', category: 'speed_to_lead_reply', intent: 'first_response_qualify', purpose: 'informational' }) })).toMatchObject({ send: true, channel: 'email' });
  });

  it('R-AST-16 only from an approved playbook with speed_to_lead_reply on, and once per contact per 24 h', () => {
    expect(planFirstResponse({ ...base, version: { status: 'draft', contentSha256: hash } })).toMatchObject({ send: false, reason: 'PLAYBOOK_NOT_APPROVED' });
    expect(planFirstResponse({ ...base, latestApproval: { decision: 'revoke', contentSha256: hash } })).toMatchObject({ send: false, reason: 'PLAYBOOK_NOT_APPROVED' });
    expect(planFirstResponse({ ...base, step: null })).toMatchObject({ send: false, reason: 'PLAYBOOK_NOT_APPROVED' });
    expect(planFirstResponse({ ...base, tenantAutonomous: new Set() })).toMatchObject({ send: false, reason: 'CATEGORY_DISABLED' });
    expect(planFirstResponse({ ...base, lastFirstResponseAt: instant(NOW - 23 * HOUR_MS) })).toMatchObject({ send: false, reason: 'ALREADY_SENT' });
    expect(planFirstResponse({ ...base, lastFirstResponseAt: instant(NOW - 25 * HOUR_MS) })).toMatchObject({ send: true });
    for (const p of [planFirstResponse(base), planFirstResponse({ ...base, tenantAutonomous: new Set() })]) expect(p.explanation.length).toBeLessThanOrEqual(300);
  });
});
