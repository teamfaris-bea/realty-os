/// <reference types="node" />
// R-ISA-22 words: every code module 75 sends has words; no sentence shows a code; the always-human topics never come
// back to the AI (R-ISA-23); no score or confidence renders anywhere in the copy (R-AST-13).
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { ESCALATION_CLASSES, ISA_END_REASONS, ISA_LINES, ISA_PAUSE_REASONS } from '@realty/core/isa';
import { describe, expect, it } from 'vitest';
import { errorMessages as shellMessages } from '../../shell/errorMessages.js';
import { surface } from './index.js';
import { HANDOFF_CLOSED_REASONS, SLA_CLASSES } from './api.js';
import { isaContract } from './testing.js';
import { escalationOf } from './Feed.js';
import {
  ALWAYS_HUMAN,
  CARE_STATE_WORDS,
  CLOSED_REASON_WORDS,
  SLA_HAS_DEADLINE,
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
  bookedWhen,
  bookedWords,
  decisionCodeWords,
  endWords,
  escalationSentence,
  isaMessage,
  messageVerb,
  noteWords,
} from './words.js';

const CODE = /\b[A-Z]{2,}_[A-Z_]+\b/;
const ROOT = join(import.meta.dirname, '../../../../..');
/**
 * The newest CHECK list of `table.column` across every migration, in file order (batch 13: the migrations are found by
 * listing, never by one file's name; 0081 re-adds ai_isa_handoffs CHECKs, so the newest one is the one in force): the
 * column's CHECK in its CREATE TABLE, then any later ALTER TABLE that adds a CHECK on it.
 */
function newestCheck(table: string, column: string): string[] {
  const dir = join(ROOT, 'packages/db/migrations');
  let last: string | null = null;
  for (const f of readdirSync(dir).filter((x) => /^\d{4}_[a-z0-9_]+\.sql$/.test(x)).sort()) {
    const sql = readFileSync(join(dir, f), 'utf8');
    const create = new RegExp(`CREATE TABLE ${table} \\(([\\s\\S]*?)\\n\\);`).exec(sql);
    const col = create ? new RegExp(`\\n\\s+${column}\\s+text[^\\n]*?CHECK \\(${column} IN \\(([^)]*)\\)`).exec(create[1]!) : null;
    if (col) last = col[1]!;
    for (const stmt of sql.matchAll(new RegExp(`ALTER TABLE ${table}\\b([^;]*);`, 'g'))) {
      for (const m of stmt[1]!.matchAll(new RegExp(`CHECK \\(${column} IN \\(([^)]*)\\)`, 'g'))) last = m[1]!;
    }
  }
  expect(last, `${table}.${column} has a CHECK`).not.toBeNull();
  return [...last!.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!).sort();
}

const all = (): string[] => [
  ...Object.values(END_WORDS), ...Object.values(PAUSE_WORDS), ...Object.values(ESCALATION_WORDS).flatMap((e) => [e.topic, e.sentence]), ...Object.values(BLOCK_WORDS),
  ...Object.values(TRIGGER_WORDS), ...Object.values(STATUS_WORDS), ...Object.values(DECISION_CODE_WORDS), ...Object.values(CHAIN_CODE_WORDS), ...Object.values(NEXT_STEP_WORDS),
  ...Object.values(NOTE_WORDS), ...Object.values(CONFIRMATION_WORDS), ...Object.values(ISA_ERROR_MESSAGES), ...Object.values(TEAM_PAGE_MESSAGES),
  ...Object.values(CARE_STATE_WORDS), ...(['booked_after_end', 'booked_not_handed_back'] as const).flatMap((t) => [bookedWords(t, null), bookedWords(t, 'Tue Nov 17, 3:00–3:30 PM ET')]),
];

describe('R-ISA-22 words (module 76)', () => {
  it('R-ISA-22: the three core enums, the block reasons, turn statuses and triggers are each covered', () => {
    expect(Object.keys(END_WORDS).sort()).toEqual([...new Set(ISA_END_REASONS)].sort());
    expect(Object.keys(PAUSE_WORDS).sort()).toEqual([...new Set(ISA_PAUSE_REASONS)].sort());
    expect(Object.keys(ESCALATION_WORDS).sort()).toEqual([...ESCALATION_CLASSES].sort());
    expect(Object.keys(BLOCK_WORDS).sort()).toEqual([...BLOCK_REASONS].sort());
    // batch 13: the newest CHECK across the migrations (ISA-2's lane file 0190_ai_isa.sql is 0080 since batch 12)
    expect(newestCheck('ai_isa_turns', 'trigger_kind')).toEqual([...TURN_TRIGGERS].sort());
    expect(newestCheck('ai_isa_turns', 'status')).toEqual([...TURN_STATUSES].sort());
    expect(newestCheck('ai_isa_person_blocks', 'reason')).toEqual([...BLOCK_REASONS].sort());
  });

  it('R-ISA-30 (batch 13 merge, 0081): the handoff deadline classes and close reasons match the newest CHECKs, and each has words', () => {
    expect(newestCheck('ai_isa_handoffs', 'sla_class')).toEqual([...SLA_CLASSES].sort());
    expect(newestCheck('ai_isa_handoffs', 'closed_reason')).toEqual([...HANDOFF_CLOSED_REASONS].sort());
    expect(Object.keys(SLA_HAS_DEADLINE).sort()).toEqual([...SLA_CLASSES].sort());
    expect(SLA_CLASSES.filter((c) => !SLA_HAS_DEADLINE[c])).toEqual(['none']);
    expect(Object.keys(CLOSED_REASON_WORDS).sort()).toEqual([...HANDOFF_CLOSED_REASONS].sort());
    for (const w of Object.values(CLOSED_REASON_WORDS)) expect(w, w).not.toMatch(CODE);
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

  it('R-ISA-22 (batch 13 isa-4 F1): every booking card code ISA-2b writes has its own words, and the booked time comes from its sentence', () => {
    const book = readFileSync(join(ROOT, 'apps/api/src/isa/booking/book.ts'), 'utf8');
    const codes = [...new Set([...book.matchAll(/'(AI_ISA_BOOKED_[A-Z_]+)'/g)].map((m) => m[1]!))].sort();
    expect(codes).toEqual(['AI_ISA_BOOKED_AFTER_END', 'AI_ISA_BOOKED_NOT_HANDED_BACK']);
    for (const c of codes) expect(escalationOf({ reasons: [{ code: c, label: 'x' }] }).type, c).not.toBeNull();
    expect(escalationOf({ reasons: [{ code: 'AI_ISA_BRAND_NEW', label: 'x' }] }).type).toBeNull();
    // the sentence the time is read from (bookedCardInTx)
    expect(book).toContain('`Booked ${when} after AI care ended; the confirmation was not sent: confirm or cancel it yourself.`');
    expect(bookedWhen('Booked Tue Nov 17, 3:00–3:30 PM ET after AI care ended; the confirmation was not sent: confirm or cancel it yourself.')).toBe('Tue Nov 17, 3:00–3:30 PM ET');
    expect(bookedWhen('Booked the agreed time after AI care ended; the confirmation was not sent.')).toBeNull();
    expect(bookedWhen('Something else')).toBeNull();
    expect(bookedWords('booked_not_handed_back', null)).not.toMatch(/ended|paused/);
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
