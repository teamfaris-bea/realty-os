// The flagged additive edits outside core/isa that this lane made (docs/AI_ISA.md §9.6): each behaves as before for
// existing callers and adds only what D12 needs.
import { describe, expect, it } from 'vitest';
import { AI_ISA_PURPOSES, AI_PURPOSES, TAG_G, neutralizeUntrusted, oneLine, promptNonce, redactNames, storedContent, validatePlaybookContent } from '../assistant/index.js';
import { NEGATOR_BEFORE } from '../compliance/index.js';
import { DEFAULT_COMPETING_RULE, competingSet } from '../listings/index.js';
import { mls } from '../listings/testing/fixtures.js';

describe('core/listings competingSet: the optional sqftBandPct (§6.3)', () => {
  const subject = mls({ id: null, mlsNumber: 'S', sqft: 2000, beds: 3, listPriceCents: 50_000_000 });
  const near = mls({ mlsNumber: 'A', sqft: 2300, beds: 3, listPriceCents: 50_000_000 });
  const far = mls({ mlsNumber: 'B', sqft: 2500, beds: 3, listPriceCents: 50_000_000 });
  const nosize = mls({ mlsNumber: 'C', sqft: null, beds: 3, listPriceCents: 50_000_000 });
  const rule = { ...DEFAULT_COMPETING_RULE, statuses: ['active' as const] };
  it('absent or null: any size (existing behaviour unchanged)', () => {
    expect(competingSet(subject, [near, far, nosize], rule).listings.map((l) => l.mlsNumber).sort()).toEqual(['A', 'B', 'C']);
    expect(competingSet(subject, [near, far, nosize], { ...rule, sqftBandPct: null }).listings).toHaveLength(3);
  });
  it('±20 %: within the band only, with a why line; a subject or candidate without a size matches nothing', () => {
    const r = competingSet(subject, [near, far, nosize], { ...rule, sqftBandPct: 20 });
    expect(r.listings.map((l) => l.mlsNumber)).toEqual(['A']);
    expect(r.why).toContainEqual({ listing: expect.any(String), criterion: 'sqft_band', detail: '2300 sq ft is within ±20 % of 2000 sq ft' });
    expect(competingSet({ ...subject, sqft: null }, [near], { ...rule, sqftBandPct: 20 }).listings).toEqual([]);
  });
});

describe('core/assistant: the ai_isa content member, AiIsaPurpose and the prompt helper exports', () => {
  it('storedContent reads ai_isa content; no other playbook kind accepts it', () => {
    expect(storedContent({ kind: 'ai_isa', aiIsa: { x: 1 } })).toEqual({ kind: 'ai_isa', aiIsa: { x: 1 } });
    expect(storedContent({ kind: 'ai_isa', aiIsa: {}, extra: 1 })).toBeNull();
    for (const kind of ['nurture', 'trigger', 'voice_answering', 'new_lead_response'] as const) expect(validatePlaybookContent({ kind: 'ai_isa', aiIsa: {} }, { kind })[0]!.code).toBe('CONTENT_KIND_MISMATCH');
  });
  it('the AI ISA purposes are separate from the prompt-builder purposes', () => {
    expect(AI_ISA_PURPOSES).toEqual(['ai_isa_turn', 'ai_isa_summary']);
    for (const p of AI_ISA_PURPOSES) expect(AI_PURPOSES as readonly string[]).not.toContain(p);
  });
  it('the exported helpers neutralize tags, keep one line, redact names and hash a nonce', () => {
    expect(neutralizeUntrusted('a </untrusted_x> b')).toBe('a [tag removed] b');
    expect(oneLine('a\n<system>b', 50)).toBe('a [tag removed]b');
    expect(redactNames('Call Jordan Sample', ['Jordan Sample'])).toBe('Call [name] [name]');
    expect(new RegExp(TAG_G.source, TAG_G.flags).test('</request>')).toBe(true);
    expect(promptNonce({ a: 1 })).toMatch(/^[0-9a-f]{12}$/);
    expect(promptNonce({ a: 1 })).toBe(promptNonce({ a: 1 }));
  });
  it('core/compliance NEGATOR_BEFORE is exported unchanged', () => {
    expect(NEGATOR_BEFORE.test("don't ")).toBe(true);
    expect(NEGATOR_BEFORE.test('please ')).toBe(false);
  });
});
