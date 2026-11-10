import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { at, sequentialIds } from '../foundation/index.js';
import { claimUsable, handbackClaims, normalizeClaims, taskDueFromClaim } from './claims.js';
import { type SourceText, sourceIndex } from './evidence.js';
import { ALL_SOURCES, BAD_MODEL_OUTPUTS, CALL, GOOD_OUTPUT, LA, LATE_SMS, NOTE, OUTBOUND, SMS_ID } from './testing/fixtures.js';

const idx = sourceIndex(ALL_SOURCES);
const norm = (raw: unknown) => normalizeClaims(raw, idx, { contactZone: LA, ids: sequentialIds({ prefix: 7 }) });

describe('normalizeClaims (R-AST-1, R-AST-2, E33, E34)', () => {
  it('R-AST-1 R-AST-2 a good extraction yields asserted claims, each with a verified ref, and resolves the date', () => {
    const claims = norm(GOOD_OUTPUT);
    expect(claims).toHaveLength(4);
    for (const c of claims) {
      expect(c.needsReview).toBe(false);
      expect(c.reviewReasons).toEqual([]);
      expect(c.evidence.some((e) => e.verified)).toBe(true);
    }
    const callback = claims[0]!;
    expect(callback.structured?.due).toEqual({
      at: at('2026-11-12T16:00:00-08:00'),
      allDay: false,
      zone: LA,
      phrase: 'Thursday around four',
      saidAt: CALL.kind === 'transcript' ? CALL.startedAt + 22_000 : 0,
      display: 'Thu Nov 12, 4 PM',
    });
    expect(claims.map((c) => c.ordinal)).toEqual([0, 1, 2, 3]);
    expect(new Set(claims.map((c) => c.id)).size).toBe(4);
    expect(claims[1]!.structured?.criterion).toEqual({ key: 'priceMaxCents', value: 45_000_000 });
  });

  it.each(BAD_MODEL_OUTPUTS.map((b) => [b.name, b.output] as const))('R-AST-1 E33 deliberately bad output "%s" never yields an asserted claim', (_name, output) => {
    const claims = norm(output);
    for (const c of claims) {
      expect(c.needsReview).toBe(true);
      expect(c.reviewReasons.length).toBeGreaterThan(0);
    }
  });

  it('R-AST-5 E33 a fabricated quote is kept as an unverified ref and the claim needs review', () => {
    const [c] = norm(BAD_MODEL_OUTPUTS.find((b) => b.name.startsWith('fabricated'))!.output);
    expect(c!.evidence).toEqual([expect.objectContaining({ verified: false, reason: 'NOT_FOUND' })]);
    expect(c!.reviewReasons).toEqual(['QUOTE_NOT_VERIFIED']);
    expect(taskDueFromClaim(c!)).toEqual({ dueAt: null, dueAllDay: false, dueTz: null, needsReview: true });
  });

  it("refs to unknown handles or to another contact's source are dropped (never stored)", () => {
    for (const name of ['unknown handle', "another contact's source id"]) {
      const [c] = norm(BAD_MODEL_OUTPUTS.find((b) => b.name === name)!.output);
      expect(c!.evidence).toEqual([]);
      expect(c!.reviewReasons).toEqual(['NO_EVIDENCE']);
    }
  });

  it('R-AST-2 a date the model computed differently from core is flagged and core\'s date is not asserted', () => {
    const [c] = norm(BAD_MODEL_OUTPUTS.find((b) => b.name.startsWith('model computed'))!.output);
    expect(c!.reviewReasons).toEqual(['DATE_MISMATCH']);
    expect(c!.structured?.due).toBeNull();
  });

  it('R-AST-2 the model may state the date when it agrees with core', () => {
    const out = JSON.parse(JSON.stringify(GOOD_OUTPUT)) as typeof GOOD_OUTPUT & { claims: { resolved_at?: string }[] };
    out.claims[0]!.resolved_at = '2026-11-12T16:00:00-08:00';
    expect(norm(out)[0]!.needsReview).toBe(false);
  });

  it('R-AST-2 E34 "call me tomorrow" texted at 11:50 PM ET by a Pacific client resolves to the next Pacific day, all day', () => {
    const [c] = norm({ claims: [{ kind: 'commitment', text: 'Callback', when: 'tomorrow', evidence: [{ source: 'S2', snippet: 'call me tomorrow' }] }] });
    expect(c!.needsReview).toBe(false);
    expect(c!.structured?.due).toMatchObject({ at: at('2026-11-11T00:00:00-08:00'), allDay: true, display: 'Wed Nov 11', saidAt: LATE_SMS.kind === 'text' ? LATE_SMS.at : 0 });
    expect(taskDueFromClaim(c!)).toEqual({ dueAt: at('2026-11-11T00:00:00-08:00'), dueAllDay: true, dueTz: 'America/Los_Angeles', needsReview: false });
  });

  it('R-AST-2 date phrases that are ambiguous or not quoted are flagged with a reason', () => {
    const reasons = (name: string) => norm(BAD_MODEL_OUTPUTS.find((b) => b.name === name)!.output)[0]!.reviewReasons;
    expect(reasons('date phrase not in the quote')).toEqual(['DATE_PHRASE_NOT_QUOTED']);
    expect(reasons('date_time without a phrase')).toEqual(['DATE_UNRESOLVED']);
    expect(reasons('ambiguous date ("next Thursday")')).toEqual(['DATE_PHRASE_NOT_QUOTED']);
    const [amb] = norm({ claims: [{ kind: 'commitment', text: 'x', when: 'Tuesday', evidence: [{ source: 'S4', snippet: 'Pre-approved' }] }] });
    expect(amb!.reviewReasons).toEqual(['DATE_PHRASE_NOT_QUOTED']);
    const s: SourceText = { kind: 'text', sourceType: 'message', sourceId: SMS_ID, handle: 'S9', text: 'call me next Thursday', at: at('2026-11-10T11:00:00-08:00'), author: 'client' };
    const [c] = normalizeClaims({ claims: [{ kind: 'commitment', text: 'x', when: 'next Thursday', evidence: [{ source: 'S9', snippet: 'call me next Thursday' }] }] }, sourceIndex([s]), {
      contactZone: LA,
      ids: sequentialIds(),
    });
    expect(c!.reviewReasons).toEqual(['DATE_AMBIGUOUS']);
    const [u] = normalizeClaims({ claims: [{ kind: 'date_time', text: 'x', when: 'call me', evidence: [{ source: 'S9', snippet: 'call me next Thursday' }] }] }, sourceIndex([s]), {
      contactZone: LA,
      ids: sequentialIds(),
    });
    expect(u!.reviewReasons).toEqual(['DATE_UNRESOLVED']);
  });

  it('clips long text to 300 chars on a word boundary and flags it', () => {
    const [c] = norm(BAD_MODEL_OUTPUTS.find((b) => b.name === 'text far over 300 chars')!.output);
    expect(c!.text.length).toBeLessThanOrEqual(300);
    expect(c!.text.endsWith('…')).toBe(true);
    expect(c!.reviewReasons).toEqual(['TEXT_TRUNCATED']);
  });

  it('accepts camelCase/snake_case refs, type+id refs, and defaults a text locator to the whole message', () => {
    const [c] = norm({ claims: [{ kind: 'fact', text: 'Pre-approved', evidence: [{ sourceType: 'note', sourceId: NOTE.sourceId.toUpperCase(), snippet: 'Pre-approved with First Bank' }] }] });
    expect(c!.needsReview).toBe(false);
    expect(c!.evidence[0]).toMatchObject({ sourceType: 'note', sourceId: NOTE.sourceId, locator: { kind: 'message' }, verified: true });
    const [d] = norm({ claims: [{ kind: 'fact', text: 'x', evidence: [{ source_type: 'call', source_id: CALL.sourceId, locator: { kind: 'transcript_offset', startMs: 9000, endMs: 15000 }, snippet: 'Our budget' }] }] });
    expect(d!.needsReview).toBe(false);
    const [e] = norm({ claims: [{ kind: 'fact', text: 'x', evidence: [{ source: 'S4', locator: { kind: 'char_range', start: 0, end: 12 }, snippet: 'Pre-approved' }] }] });
    expect(e!.needsReview).toBe(false);
    const [f] = norm({ claims: [{ kind: 'fact', text: 'x', evidence: [{ source: 'S5', locator: { kind: 'field', name: 'price' }, snippet: '$439,000' }] }] });
    expect(f!.needsReview).toBe(false);
    const [g] = norm({ claims: [{ kind: 'fact', text: 'x', evidence: [{ source: 'S5', locator: { kind: 'field', name: 'Bad Name' }, snippet: '$439,000' }, { source: 'S5', locator: { kind: 'nope' }, snippet: 'x' }] }] });
    expect(g!.reviewReasons).toEqual(['NO_EVIDENCE']);
    const [h] = norm({ claims: [{ kind: 'fact', text: 'x', evidence: [{ source: 'S1', snippet: 'Our budget' }, { source: 'S4', locator: { kind: 'char_range', start: 'a' }, snippet: 'x' }] }] });
    expect(h!.reviewReasons).toEqual(['NO_EVIDENCE']); // a transcript ref needs offsets
  });

  it('drops claims without text and caps the number of claims and refs', () => {
    expect(norm({ claims: [{ kind: 'fact', text: '   ' }, { text: 5 }, 'junk'] })).toEqual([]);
    const many = { claims: Array.from({ length: 100 }, () => ({ kind: 'fact', text: 'x', evidence: Array.from({ length: 20 }, () => ({ source: 'S4', snippet: 'Pre-approved' })) })) };
    const out = norm(many);
    expect(out).toHaveLength(40);
    expect(out[0]!.evidence).toHaveLength(8);
  });

  // R-AST-13 (core data): the API snapshot test covers the response schemas.
  it('no claim field carries a confidence value', () => {
    const json = JSON.stringify(norm(GOOD_OUTPUT));
    expect(json).not.toMatch(/confidence|probability|score/i);
  });

  it('R-AST-1 property: for ANY input, an asserted claim always has at least one verified evidence ref', () => {
    const snippetPool = ['call me Thursday around four', 'Our budget', 'Pre-approved', 'nope', '', 'call me tomorrow', '$439,000'];
    const ref = fc.record({
      source: fc.constantFrom('S1', 'S2', 'S3', 'S4', 'S5', 'S7'),
      locator: fc.oneof(
        fc.constant({ kind: 'message' }),
        fc.record({ kind: fc.constant('transcript_offset'), start_ms: fc.integer({ min: -5000, max: 50_000 }), end_ms: fc.integer({ min: -5000, max: 50_000 }) }),
        fc.record({ kind: fc.constant('field'), name: fc.constantFrom('price', 'address', 'beds') }),
        fc.record({ kind: fc.constant('char_range'), start: fc.integer({ min: -2, max: 80 }), end: fc.integer({ min: -2, max: 80 }) }),
        fc.anything(),
      ),
      snippet: fc.oneof(fc.constantFrom(...snippetPool), fc.string()),
    });
    const claim = fc.record({
      kind: fc.oneof(fc.constantFrom('fact', 'commitment', 'date_time', 'preference'), fc.string()),
      text: fc.string({ minLength: 1, maxLength: 400 }),
      when: fc.option(fc.constantFrom('tomorrow', 'Thursday around four', 'next week', 'whenever'), { nil: undefined }),
      needs_review: fc.option(fc.boolean(), { nil: undefined }),
      evidence: fc.option(fc.array(fc.oneof(ref, fc.anything()), { maxLength: 4 }), { nil: undefined }),
    });
    fc.assert(
      fc.property(fc.oneof(fc.record({ claims: fc.array(fc.oneof(claim, fc.anything()), { maxLength: 6 }) }), fc.anything()), (raw) => {
        for (const c of norm(raw)) {
          if (!c.needsReview) expect(c.evidence.some((e) => e.verified)).toBe(true);
          expect(c.text.length).toBeGreaterThan(0);
          expect(c.text.length).toBeLessThanOrEqual(300);
          for (const e of c.evidence) expect(e.snippet.length).toBeLessThanOrEqual(500);
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('claimUsable / taskDueFromClaim (R-AST-5)', () => {
  it('R-AST-5 a needs-review claim is unusable until confirmed or corrected; rejected never', () => {
    expect(claimUsable({ needsReview: false })).toBe(true);
    expect(claimUsable({ needsReview: true })).toBe(false);
    expect(claimUsable({ needsReview: true, reviewStatus: 'unreviewed' })).toBe(false);
    expect(claimUsable({ needsReview: true, reviewStatus: 'confirmed' })).toBe(true);
    expect(claimUsable({ needsReview: true, reviewStatus: 'corrected' })).toBe(true);
    expect(claimUsable({ needsReview: false, reviewStatus: 'rejected' })).toBe(false);
  });

  it('R-AST-5 an open promise task from a needs-review or dateless claim has no due_at', () => {
    const due = { at: at('2026-11-12T16:00:00-08:00'), allDay: false, zone: LA, phrase: 'x', saidAt: at('2026-11-10T11:00:00-08:00'), display: 'x' };
    expect(taskDueFromClaim({ needsReview: true, structured: { due } })).toEqual({ dueAt: null, dueAllDay: false, dueTz: null, needsReview: true });
    expect(taskDueFromClaim({ needsReview: false, structured: { due: null } })).toEqual({ dueAt: null, dueAllDay: false, dueTz: null, needsReview: true });
    expect(taskDueFromClaim({ needsReview: false })).toEqual({ dueAt: null, dueAllDay: false, dueTz: null, needsReview: true });
    expect(taskDueFromClaim({ needsReview: false, structured: { due } })).toEqual({ dueAt: due.at, dueAllDay: false, dueTz: LA, needsReview: false });
    expect(taskDueFromClaim({ needsReview: true, reviewStatus: 'confirmed', structured: { due } }).dueAt).toBe(due.at);
  });
});

// R-AST-9 core part only: the ingestion transaction, pause and dedupe are db/api tests.
describe('handbackClaims (deterministic handback claims)', () => {
  it('quotes what the client said verbatim and cites what was sent, both verified', () => {
    const claims = handbackClaims({ ids: sequentialIds(), clientFirstName: 'Jane', inbound: LATE_SMS, lastOutbound: [OUTBOUND] });
    expect(claims).toHaveLength(2);
    expect(claims[0]).toMatchObject({ kind: 'client_statement', needsReview: false, text: 'Jane wrote: “Can’t talk now — call me TOMORROW, please!”' });
    expect(claims[0]!.evidence[0]).toMatchObject({ sourceId: SMS_ID, locator: { kind: 'message' }, verified: true });
    expect(claims[1]).toMatchObject({ kind: 'sent_summary', needsReview: false });
    expect(claims[1]!.text.startsWith('Last sent by the assistant: “Hi Jane!')).toBe(true);
    expect(claims[1]!.evidence.map((e) => e.sourceId)).toEqual([OUTBOUND.sourceId]);
  });

  // E22 wording only (the lock race is a db/api test)
  it('says honestly when a message went out at the same moment the client replied', () => {
    const claims = handbackClaims({ ids: sequentialIds(), clientFirstName: 'Jane', inbound: LATE_SMS, lastOutbound: [OUTBOUND], sentConcurrently: true });
    expect(claims[1]!.text.startsWith('Sent at the same moment Jane replied: “')).toBe(true);
  });

  // E28 evidence only (pause and one-tap resume are db/api)
  it('labels an auto-reply with its header as evidence', () => {
    const header: SourceText = { kind: 'fields', sourceType: 'email', sourceId: SMS_ID, at: at('2026-11-10T12:00:00Z'), fields: { auto_submitted: 'auto-replied' } };
    const claims = handbackClaims({ ids: sequentialIds(), clientFirstName: 'Jane', inbound: LATE_SMS, lastOutbound: [], autoReply: { source: header, field: 'auto_submitted' } });
    expect(claims.map((c) => c.kind)).toEqual(['client_statement', 'fact']);
    expect(claims[1]).toMatchObject({ needsReview: false, evidence: [expect.objectContaining({ locator: { kind: 'field', name: 'auto_submitted' }, snippet: 'auto-replied', verified: true })] });
    const missing = handbackClaims({ ids: sequentialIds(), clientFirstName: 'Jane', inbound: LATE_SMS, lastOutbound: [], autoReply: { source: header, field: 'nope' } });
    expect(missing[1]!.needsReview).toBe(true);
  });

  it('handles calls (missed or with a voicemail transcript) and long texts', () => {
    const missed: SourceText = { kind: 'fields', sourceType: 'call', sourceId: CALL.sourceId, at: at('2026-11-10T12:00:00Z'), fields: { status: 'no_answer' } };
    expect(handbackClaims({ ids: sequentialIds(), clientFirstName: '', inbound: missed, lastOutbound: [] })[0]).toMatchObject({ text: 'The client called (no answer)', needsReview: false });
    const bare: SourceText = { kind: 'fields', sourceType: 'call', sourceId: CALL.sourceId, at: at('2026-11-10T12:00:00Z'), fields: {} };
    expect(handbackClaims({ ids: sequentialIds(), clientFirstName: 'Jane', inbound: bare, lastOutbound: [] })[0]).toMatchObject({ text: 'Jane called', needsReview: true });
    const vm = handbackClaims({ ids: sequentialIds(), clientFirstName: 'Jane', inbound: CALL, lastOutbound: [OUTBOUND, OUTBOUND, OUTBOUND, OUTBOUND] });
    expect(vm[0]).toMatchObject({ kind: 'client_statement', needsReview: false });
    expect(vm[0]!.text.length).toBeLessThanOrEqual(300);
    expect(vm[1]!.evidence).toHaveLength(3);
    const long: SourceText = { ...LATE_SMS, text: 'word '.repeat(300) } as SourceText;
    const l = handbackClaims({ ids: sequentialIds(), clientFirstName: 'Jane', inbound: long, lastOutbound: [] });
    expect(l[0]!.text.length).toBeLessThanOrEqual(300);
    expect(l[0]!.evidence[0]!.snippet.length).toBeLessThanOrEqual(500);
    expect(l[0]!.needsReview).toBe(false);
    const empty: SourceText = { ...CALL, segments: [] } as SourceText;
    expect(handbackClaims({ ids: sequentialIds(), clientFirstName: 'Jane', inbound: empty, lastOutbound: [] })[0]!.needsReview).toBe(true);
  });
});

describe('normalizeClaims edge cases', () => {
  it('clips a single giant word mid-word', () => {
    const [c] = norm({ claims: [{ kind: 'fact', text: 'x'.repeat(400), evidence: [{ source: 'S4', snippet: 'Pre-approved' }] }] });
    expect(c!.text).toBe(`${'x'.repeat(299)}…`);
  });

  it('R-AST-2 an all-day model date is compared by calendar day; an unparseable one is a mismatch', () => {
    const mk = (resolved_at: string) => norm({ claims: [{ kind: 'commitment', text: 'Callback', when: 'tomorrow', resolved_at, evidence: [{ source: 'S2', snippet: 'call me tomorrow' }] }] })[0]!;
    expect(mk('2026-11-11T09:00:00-08:00').needsReview).toBe(false);
    expect(mk('2026-11-12T09:00:00-08:00').reviewReasons).toEqual(['DATE_MISMATCH']);
    expect(mk('2026-11-11').reviewReasons).toEqual(['DATE_MISMATCH']);
  });

  it('a handback for an empty text has an unverifiable quote; an auto-reply flag from a non-field source has no evidence', () => {
    const empty: SourceText = { ...LATE_SMS, text: '   ' } as SourceText;
    expect(handbackClaims({ ids: sequentialIds(), clientFirstName: 'Jane', inbound: empty, lastOutbound: [] })[0]!.reviewReasons).toEqual(['QUOTE_NOT_VERIFIED']);
    const claims = handbackClaims({ ids: sequentialIds(), clientFirstName: 'Jane', inbound: LATE_SMS, lastOutbound: [], autoReply: { source: OUTBOUND, field: 'x' } });
    expect(claims[1]!.reviewReasons).toEqual(['NO_EVIDENCE']);
  });
});

describe('clip', () => {
  it('cuts mid-word rather than losing most of the text when the only space is early', () => {
    const [c] = norm({ claims: [{ kind: 'fact', text: `ab ${'x'.repeat(400)}`, evidence: [{ source: 'S4', snippet: 'Pre-approved' }] }] });
    expect(c!.text.length).toBe(300);
    expect(c!.text.startsWith('ab xxx')).toBe(true);
  });
});
