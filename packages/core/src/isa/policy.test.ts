// The team AI policy in words, its field list, its diff and the texts an approver accepts (R-ISA-33, R-ISA-34; E1000 to
// E1003; docs/AI_ISA.md §3.2).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type AiIsaContent, DEFAULT_AI_ISA_CONTENT, narrowsPrevious, validateAiIsaContent } from './content.js';
import { ISA_CADENCES, ISA_PACK_CEILING } from './constants.js';
import {
  AI_ISA_POLICY_FIELDS,
  AI_ISA_POLICY_SECTIONS,
  AI_ISA_POLICY_TEXT_VERSION,
  aiIsaPolicyApprovalText,
  aiIsaPolicyRevokeText,
  policyDiff,
  policyFieldValue,
  policyIssueWords,
  policySections,
  setPolicyField,
} from './policy.js';
import { ISA_CAPABILITIES } from './types.js';

const D = DEFAULT_AI_ISA_CONTENT;
const withC = (o: Partial<AiIsaContent>): AiIsaContent => ({ ...D, ...o });
const SHA = 'a'.repeat(64);

/** Every leaf path of the content, an array counting as one leaf. */
function leaves(o: unknown, at: string[] = []): string[] {
  if (o === null || typeof o !== 'object' || Array.isArray(o)) return [at.join('.')];
  return Object.entries(o as Record<string, unknown>).flatMap(([k, v]) => leaves(v, [...at, k]));
}

describe('R-ISA-33 the field list is the validator’s', () => {
  it('covers every value of the content once, and nothing else', () => {
    const full: AiIsaContent = { ...D, holdingLines: { pricing_negotiation: 'x'.repeat(12), financial: 'x'.repeat(12), data_unavailable: 'x'.repeat(12), booking_unavailable: 'x'.repeat(12) } };
    expect(AI_ISA_POLICY_FIELDS.map((f) => f.path.join('.')).sort()).toEqual(leaves(full).sort());
    expect(new Set(AI_ISA_POLICY_FIELDS.map((f) => f.key)).size).toBe(AI_ISA_POLICY_FIELDS.length);
    for (const f of AI_ISA_POLICY_FIELDS) expect(AI_ISA_POLICY_SECTIONS.some((s) => s.key === f.section)).toBe(true);
  });
  it('every bound a field shows is the bound the validator enforces: the edge is valid, one step past it is refused on that field', () => {
    // two rules join two fields (end after start; slower-after not above stops-after): the partner is moved out of the way
    const room: AiIsaContent = { ...D, window: { startSec: ISA_PACK_CEILING.window.startSec, endSec: ISA_PACK_CEILING.window.endSec } };
    const base = (key: string, v: number): AiIsaContent =>
      key === 'limits.slowAfterUnanswered' ? { ...room, limits: { ...room.limits, dormantAfterUnanswered: 100 } } : key === 'limits.dormantAfterUnanswered' ? { ...room, limits: { ...room.limits, slowAfterUnanswered: Math.max(1, Math.min(v, 1)) } } : room;
    let checked = 0;
    for (const f of AI_ISA_POLICY_FIELDS) {
      if (f.kind !== 'int' && f.kind !== 'time') continue;
      const step = f.kind === 'time' ? 60 : 1;
      for (const [edge, past] of [[f.max!, f.max! + step], [f.min!, f.min! - step]] as const) {
        expect(validateAiIsaContent(setPolicyField(base(f.key, edge), f, edge)), `${f.key} at ${edge}`).toEqual([]);
        const bad = setPolicyField(base(f.key, edge), f, past);
        const words = validateAiIsaContent(bad).map((i) => policyIssueWords(i, bad));
        // a window whose two ends meet is refused on its end, whichever end moved
        expect(words.some((w) => w.field === f.key || (f.key === 'window.startSec' && w.field === 'window.endSec')), `${f.key} at ${past}`).toBe(true);
        checked += 1;
      }
    }
    expect(checked).toBe(2 * AI_ISA_POLICY_FIELDS.filter((f) => f.kind === 'int' || f.kind === 'time').length);
  });
  it('offers every capability the validator accepts and none it refuses; converse cannot be removed', () => {
    const caps = AI_ISA_POLICY_FIELDS.find((f) => f.key === 'capabilities')!;
    expect(caps.options!.map((o) => o.value)).toEqual([...ISA_CAPABILITIES]);
    expect(caps.locked).toEqual(['converse']);
    expect(AI_ISA_POLICY_FIELDS.find((f) => f.key === 'cadence')!.options!.map((o) => o.value)).toEqual([...ISA_CADENCES]);
    expect(AI_ISA_POLICY_FIELDS.find((f) => f.key === 'noInitiatedOnHolidays')!.locked).toEqual([true]);
  });
  it('reads and writes a value by field without touching the rest', () => {
    const f = AI_ISA_POLICY_FIELDS.find((x) => x.key === 'caps.ai24h')!;
    const next = setPolicyField(D, f, 2);
    expect(policyFieldValue(next, f)).toBe(2);
    expect({ ...next, caps: { ...next.caps, ai24h: D.caps.ai24h } }).toEqual(D);
    expect(D.caps.ai24h).toBe(ISA_PACK_CEILING.caps.ai24h);
  });
});

describe('R-ISA-33 field-level reasons', () => {
  it('names the field and says the limit in words, never a code', () => {
    const words = (c: unknown) => validateAiIsaContent(c).map((i) => policyIssueWords(i, c));
    expect(words(withC({ caps: { ...D.caps, ai24h: 4 } }))).toEqual([{ code: 'CAP_ABOVE_CEILING', field: 'caps.ai24h', sentence: 'At most 3: the platform’s limit.' }]);
    expect(words(withC({ capabilities: ['converse', 'share_value_estimate'] }))[0]).toEqual({
      code: 'CAPABILITY_NOT_AVAILABLE', field: 'capabilities', sentence: 'Value estimates and market statistics are not available to the assistant.' });
    expect(words(withC({ capabilities: [] })).map((x) => x.field)).toEqual(['capabilities']);
    expect(words(withC({ channels: [] }))).toEqual([{ code: 'SCHEMA', field: 'channels', sentence: 'Choose at least one.' }]);
    expect(words(withC({ window: { startSec: 7 * 3600, endSec: 20 * 3600 } }))[0]).toMatchObject({ field: 'window.startSec', sentence: 'No earlier than 8:00 AM: the platform’s limit.' });
    expect(words(withC({ window: { startSec: 9 * 3600, endSec: 21 * 3600 } }))[0]).toMatchObject({ field: 'window.endSec', sentence: 'No later than 8:00 PM: the platform’s limit.' });
    expect(words(withC({ noInitiatedOnHolidays: false }))[0]).toMatchObject({ field: 'noInitiatedOnHolidays' });
    expect(words(withC({ limits: { ...D.limits, slowAfterUnanswered: 7 } }))[0]).toMatchObject({ field: 'limits.slowAfterUnanswered' });
    expect(words(withC({ holdingLines: { financial: 'short' } }))).toEqual([{ code: 'SCHEMA', field: 'holdingLines.financial', sentence: 'Use 10 to 240 characters, or leave it empty.' }]);
    expect(words(withC({ caps: { ...D.caps, ai24h: 1.5 } }))[0]).toEqual({ code: 'SCHEMA', field: 'caps.ai24h', sentence: 'Enter a whole number from 0 to 3.' });
    expect(words({ ...D, extra: 1 })[0]).toMatchObject({ field: null });
    for (const x of [...words({ ...D, extra: 1, tone: 5 }), ...words(null)]) expect(x.sentence).not.toMatch(/[A-Z]{3,}_|undefined/);
  });
});

describe('R-ISA-33 the policy in words, by section', () => {
  it('says what the assistant may and may not do', () => {
    const s = policySections(D);
    expect(s.map((x) => x.key)).toEqual(AI_ISA_POLICY_SECTIONS.map((x) => x.key));
    const does = s.find((x) => x.key === 'does')!;
    expect(does.may).toContain('Talk with leads by text and email.');
    expect(does.mayNot).toContain('Propose appointment times and book them on the agent’s calendar.');
    expect(does.mayNot).toContain('Give value estimates or market statistics (not available to the assistant).');
    const when = s.find((x) => x.key === 'when')!;
    expect(when.may).toContain('Write between 9:00 AM and 8:00 PM in the person’s own time.');
    expect(when.mayNot).toContain('Start a follow-up on Sun or on a US federal holiday.');
    const booked = policySections(withC({ capabilities: ['converse', 'book_appointments'] }));
    expect(booked.find((x) => x.key === 'does')!.may).toContain('Propose appointment times and book them on the agent’s calendar.');
  });
});

describe('R-ISA-34 the diff in words and whether it is wider (E1001, E1002)', () => {
  it('says each addition and each removal', () => {
    const d = policyDiff(D, withC({ capabilities: ['converse', 'book_appointments'], channels: ['sms'] }));
    expect(d.adds).toEqual(['may propose appointment times and book them on the agent’s calendar']);
    expect(d.removes).toEqual(['no longer writes by email']);
    expect(d.wider).toBe(true);
    const n = policyDiff(withC({ capabilities: ['converse', 'seller_competition'] }), D);
    expect(n).toMatchObject({ adds: [], removes: ['no longer shares competing listings with sellers'], wider: false });
  });
  it('numbers say the new value and the old one', () => {
    expect(policyDiff(withC({ caps: { ...D.caps, ai24h: 2 } }), D).adds).toEqual(['up to 3 AI messages per person in 24 hours (was 2)']);
    expect(policyDiff(D, withC({ caps: { ...D.caps, ai24h: 2 } })).removes).toEqual(['at most 2 AI messages per person in 24 hours (was 3)']);
    expect(policyDiff(D, withC({ cadence: '7d' })).removes).toEqual(['follows up every 7 days (was every 3 days)']);
    expect(policyDiff(D, withC({ window: { startSec: 10 * 3600, endSec: 20 * 3600 } })).removes).toEqual(['writes no earlier than 10:00 AM (was 9:00 AM)']);
  });
  it('new wording alone is neither wider nor narrower', () => {
    const d = policyDiff(D, withC({ tone: 'Warm and brief.', holdingLines: { financial: 'I will ask your agent to go over that with you.' } }));
    expect(d).toMatchObject({ adds: [], removes: [], wider: false });
    expect(d.rewords).toEqual(['the line it uses for money questions', 'the tone sample']);
    expect(policyDiff(D, D)).toEqual({ adds: [], removes: [], rewords: [], wider: false });
    expect(policyDiff(null, D).wider).toBe(false);
  });
  it('property: wider is exactly the existing comparison, and every wider version says what it adds', () => {
    const sub = <T,>(xs: readonly T[]) => fc.subarray([...xs]);
    const arb: fc.Arbitrary<AiIsaContent> = fc.record({
      capabilities: sub(ISA_CAPABILITIES.filter((c) => c !== 'converse')).map((x) => ['converse', ...x]),
      channels: sub(['sms', 'email'] as const).filter((x) => x.length > 0),
      window: fc.record({ startSec: fc.integer({ min: 8, max: 11 }).map((h) => h * 3600), endSec: fc.integer({ min: 17, max: 20 }).map((h) => h * 3600) }),
      initiatedDays: sub([1, 2, 3, 4, 5, 6, 7]),
      noInitiatedOnHolidays: fc.boolean(),
      caps: fc.record({ ai24h: fc.integer({ min: 0, max: 3 }), automated24h: fc.integer({ min: 0, max: 3 }), initiated24h: fc.integer({ min: 0, max: 1 }), initiated7d: fc.integer({ min: 0, max: 3 }), minGapSeconds: fc.integer({ min: 120, max: 240 }) }),
      cadence: fc.constantFrom(...ISA_CADENCES),
      limits: fc.record({ maxMessagesPerAssignment: fc.integer({ min: 38, max: 40 }), maxDays: fc.integer({ min: 178, max: 180 }), slowAfterUnanswered: fc.integer({ min: 2, max: 4 }), dormantAfterUnanswered: fc.integer({ min: 5, max: 7 }) }),
      readiness: fc.record({ timelineDays: fc.integer({ min: 88, max: 90 }) }),
      booking: fc.record({
        kinds: fc.record({ buyer: sub(['buyer_consult', 'consult'] as const), seller: sub(['listing_appointment', 'consult'] as const) }),
        durationMinutes: fc.constantFrom(30, 45), minNoticeHours: fc.integer({ min: 4, max: 6 }), horizonDays: fc.integer({ min: 12, max: 14 }), bufferMinutes: fc.integer({ min: 15, max: 17 }),
      }),
      holdingLines: fc.constant({}),
      tone: fc.constantFrom('', 'Warm.'),
    });
    fc.assert(fc.property(arb, arb, (a, b) => {
      const d = policyDiff(a, b);
      expect(d.wider).toBe(!narrowsPrevious(a, b));
      expect(d.adds.length > 0).toBe(d.wider);
      if (JSON.stringify(a) !== JSON.stringify(b)) expect(d.adds.length + d.removes.length + d.rewords.length).toBeGreaterThan(0);
    }), { numRuns: 400 });
  });
});

describe('R-ISA-34 the texts an approver accepts (Q2: served by core, versioned)', () => {
  it('name the version and its exact content, and say what a wider version does', () => {
    expect(AI_ISA_POLICY_TEXT_VERSION).toBe('ai_isa.policy_attestation/1');
    const first = aiIsaPolicyApprovalText({ versionNo: 1, contentSha256: SHA, effect: 'first' });
    expect(first).toContain(`version 1 of the team's AI assistant policy (content ${SHA})`);
    expect(first).toContain('engineering defaults that counsel has not reviewed');
    expect(first).not.toContain('pauses');
    expect(aiIsaPolicyApprovalText({ versionNo: 3, contentSha256: SHA, effect: 'wider' })).toContain('It lets the assistant do more than the approved version, so AI care pauses for every lead until each agent re-confirms.');
    expect(aiIsaPolicyApprovalText({ versionNo: 3, contentSha256: SHA, effect: 'narrower' })).toContain('It lets the assistant do no more than the approved version, so AI care continues under it at once.');
    expect(aiIsaPolicyApprovalText({ versionNo: 4, contentSha256: SHA, effect: 'after_revoke' })).toContain('The last approved version was revoked, so AI care stays paused for every lead until each agent re-confirms.');
    expect(aiIsaPolicyRevokeText({ versionNo: 3, contentSha256: SHA })).toBe(
      `I revoke version 3 of the team's AI assistant policy (content ${SHA}). AI care pauses for every lead at once, and nothing more is sent by the assistant until a new version is approved and each agent re-confirms. [${AI_ISA_POLICY_TEXT_VERSION}]`);
    for (const t of [first, aiIsaPolicyApprovalText({ versionNo: 999, contentSha256: SHA, effect: 'wider' }), aiIsaPolicyRevokeText({ versionNo: 999, contentSha256: SHA })]) expect(t.length).toBeLessThanOrEqual(500);
  });
});
