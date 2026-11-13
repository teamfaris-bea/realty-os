/// <reference types="node" />
// R-ISA-22 words: every code module 75 sends has words; no sentence shows a code; the always-human topics never come
// back to the AI (R-ISA-23); no score or confidence renders anywhere in the copy (R-AST-13).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ESCALATION_CLASSES, ISA_END_REASONS, ISA_LINES, ISA_PAUSE_REASONS } from '@realty/core/isa';
import { describe, expect, it } from 'vitest';
import { errorMessages as shellMessages } from '../../shell/errorMessages.js';
import { surface } from './index.js';
import { isaContract } from './testing.js';
import {
  ALWAYS_HUMAN,
  BLOCK_REASONS,
  BLOCK_WORDS,
  CHAIN_CODE_WORDS,
  CONFIRMATION_WORDS,
  DECISION_CODE_WORDS,
  END_WORDS,
  ESCALATION_WORDS,
  ISA_ERROR_MESSAGES,
  LINES,
  NEXT_STEPS,
  NEXT_STEP_WORDS,
  NOTE_WORDS,
  NOT_LIFTABLE,
  OTHER_CHECK,
  PAUSE_WORDS,
  STATUS_WORDS,
  TEAM_PAGE_MESSAGES,
  TRIGGER_WORDS,
  TURN_STATUSES,
  TURN_TRIGGERS,
  blockWords,
  decisionCodeWords,
  endWords,
  escalationSentence,
  isaMessage,
  messageVerb,
  noteWords,
} from './words.js';

const CODE = /\b[A-Z]{2,}_[A-Z_]+\b/;
const ROOT = join(import.meta.dirname, '../../../../..');
const all = (): string[] => [
  ...Object.values(END_WORDS), ...Object.values(PAUSE_WORDS), ...Object.values(ESCALATION_WORDS).flatMap((e) => [e.topic, e.sentence]), ...Object.values(BLOCK_WORDS),
  ...Object.values(TRIGGER_WORDS), ...Object.values(STATUS_WORDS), ...Object.values(DECISION_CODE_WORDS), ...Object.values(CHAIN_CODE_WORDS), ...Object.values(NEXT_STEP_WORDS),
  ...Object.values(NOTE_WORDS), ...Object.values(CONFIRMATION_WORDS), ...Object.values(ISA_ERROR_MESSAGES), ...Object.values(TEAM_PAGE_MESSAGES),
];

describe('R-ISA-22 words (module 76)', () => {
  it('R-ISA-22: the three core enums, the block reasons, turn statuses and triggers are each covered', () => {
    expect(Object.keys(END_WORDS).sort()).toEqual([...new Set(ISA_END_REASONS)].sort());
    expect(Object.keys(PAUSE_WORDS).sort()).toEqual([...new Set(ISA_PAUSE_REASONS)].sort());
    expect(Object.keys(ESCALATION_WORDS).sort()).toEqual([...ESCALATION_CLASSES].sort());
    expect(Object.keys(BLOCK_WORDS).sort()).toEqual([...BLOCK_REASONS].sort());
    const sql = readFileSync(join(ROOT, 'packages/db/migrations/0190_ai_isa.sql'), 'utf8');
    const listOf = (re: RegExp) => [...(re.exec(sql)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
    expect(listOf(/trigger_kind\s+text NOT NULL CHECK \(trigger_kind IN \(([^)]*)\)/)).toEqual([...TURN_TRIGGERS].sort());
    expect(listOf(/status\s+text NOT NULL DEFAULT 'deciding' CHECK \(status IN \(([^)]*)\)/)).toEqual([...TURN_STATUSES].sort());
    expect(listOf(/reason\s+text NOT NULL CHECK \(reason IN \(([^)]*)\)\),\n\s+created_at/)).toEqual([...BLOCK_REASONS].sort());
  });

  it('R-ISA-22: every module-75 error code has a sentence (from the contract and from errors.ts as text)', () => {
    const text = readFileSync(join(ROOT, 'apps/api/src/errors.ts'), 'utf8');
    const start = text.indexOf('// ---- module 75');
    const next = text.indexOf('// ----', start + 10);
    const codes = [...text.slice(start, next).matchAll(/^\s+([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!);
    expect(codes.length).toBeGreaterThan(20);
    const contractCodes = Object.keys(isaContract.errors).filter((c) => !['NOT_FOUND', 'VALIDATION_FAILED', 'REAUTH_REQUIRED', 'OWNER_REQUIRED', 'ATTESTATION_REQUIRED'].includes(c));
    for (const c of new Set([...codes, ...contractCodes])) expect(ISA_ERROR_MESSAGES[c], c).toBeTruthy();
  });

  it('R-ISA-22: the chain codes of repo.ts each have words', () => {
    const repo = readFileSync(join(ROOT, 'apps/api/src/isa/repo.ts'), 'utf8');
    const codes = [...repo.matchAll(/L\(\d, '[^']+', '(?:hold|pause|end)', '([A-Z_]+)'/g)].map((m) => m[1]!);
    expect(codes.length).toBeGreaterThan(10);
    for (const c of codes) expect(CHAIN_CODE_WORDS[c], c).toBeTruthy();
  });

  it('R-ISA-22: every next step and note handoff.ts writes is covered; a prefixed note drops its id', () => {
    const h = readFileSync(join(ROOT, 'apps/api/src/isa/handoff.ts'), 'utf8');
    for (const s of [...h.matchAll(/out\.push\('([a-z_]+)'\)/g)].map((m) => m[1]!)) expect(NEXT_STEPS as readonly string[], s).toContain(s);
    expect(noteWords('IN_FLIGHT:01900000-0000-7000-8000-000000000001')).not.toMatch(/0190/);
    expect(noteWords('CONFIRMATION_NOT_SENT')).toMatch(/confirm by hand/);
    expect(noteWords('SOMETHING_NEW')).toBe(OTHER_CHECK);
  });

  it('R-ISA-22: no sentence matches a code pattern, and an unknown code becomes "Another check"', () => {
    for (const s of all()) expect(s, s).not.toMatch(CODE);
    expect(endWords('brand_new_reason')).toBe(OTHER_CHECK);
    expect(escalationSentence('brand_new_class')).toBe(OTHER_CHECK);
    expect(blockWords('brand_new')).toBe(OTHER_CHECK);
    expect(decisionCodeWords('BRAND_NEW:x')).toBe(OTHER_CHECK);
    expect(isaMessage('AI_ISA_BRAND_NEW')).not.toMatch(CODE);
    expect(OTHER_CHECK).not.toMatch(/details|below|above|see /i);
  });

  it("R-ISA-22: the surface's errorMessages hold module-75 codes only, never a shell-owned code", () => {
    const keys = Object.keys(surface.errorMessages ?? {});
    expect(keys.length).toBeGreaterThan(10);
    for (const k of keys) expect(Object.hasOwn(shellMessages, k), k).toBe(false);
    expect(keys).not.toContain('OWNER_REQUIRED');
    expect(keys).not.toContain('ATTESTATION_REQUIRED');
    expect(isaMessage({ code: 'OWNER_REQUIRED' }, TEAM_PAGE_MESSAGES)).toBe('Only the account owner can turn this on.');
  });

  it('R-ISA-23: no rendered sentence for pricing_negotiation, financial or legal_contract says the AI may discuss them later', () => {
    for (const c of ['pricing_negotiation', 'financial', 'legal_contract'] as const) {
      const s = ESCALATION_WORDS[c].sentence;
      expect(s).toMatch(/never/);
      expect(s).not.toMatch(/may (?:discuss|talk|answer|come back)|can (?:discuss|answer)|later|until you/i);
      expect(s).toMatch(/never this topic|stays off/);
    }
    expect(ALWAYS_HUMAN).toEqual(expect.arrayContaining(['pricing_negotiation', 'financial', 'legal_contract']));
    for (const s of all()) expect(s).not.toMatch(/AI (?:assistant )?(?:may|can|will) (?:discuss|negotiate|price|value)/i);
  });

  it('R-ISA-22 V18: each block reason gets its own words; the non-liftable ones say AI care cannot restart', () => {
    const texts = BLOCK_REASONS.map((r) => BLOCK_WORDS[r]);
    expect(new Set(texts.map((t) => t.split('.')[0])).size).toBe(BLOCK_REASONS.length);
    for (const r of NOT_LIFTABLE) expect(BLOCK_WORDS[r as (typeof BLOCK_REASONS)[number]]).toMatch(/can't restart/);
    expect(BLOCK_WORDS.complaint).not.toMatch(/can't restart/);
  });

  it('R-ISA-7: the verb follows the status: a scheduled, queued or blocked AI message never reads as sent', () => {
    expect(messageVerb('sent')).toBe('sent');
    expect(messageVerb('delivered')).toBe('sent');
    expect(messageVerb('scheduled')).toBe('scheduled');
    expect(messageVerb('queued')).toBe('queued');
    expect(messageVerb('dispatching')).toBe('queued');
    for (const s of ['blocked', 'failed', 'canceled', 'undelivered', null]) expect(messageVerb(s)).toBe('not_sent');
  });

  it("R-ISA-7: the fixed lines are core's, word for word (restated so the phone bundle does not load core)", () => {
    expect(LINES).toEqual(ISA_LINES);
  });

  it('R-ISA-22 R-AST-13 no scores: no source file of the surface renders confidence, a score, a probability or a percentage', () => {
    const dir = import.meta.dirname;
    const files = readdirSync(dir).filter((f) => /\.tsx?$/.test(f) && !/\.test\.|testing/.test(f));
    for (const f of files) {
      const code = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
      const literals = [...code.matchAll(/(['"`])((?:(?!\1)[^\\]|\\.)*)\1/g)].map((m) => m[2] ?? '').filter((s) => /\s/.test(s));
      for (const s of literals) expect(s, `${f}: ${s}`).not.toMatch(/confidence|\bscore\b|probabilit|\d%|%\)/i);
    }
  });
});
