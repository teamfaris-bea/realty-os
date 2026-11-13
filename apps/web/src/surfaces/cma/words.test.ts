// The CMA surface's words (module 72; R-AST-13 display half, R-CMA-4, R-AVM-1): no confidence, probability, accuracy,
// score, likelihood or guarantee word in any string the surface shows (words.ts and every component's literal text);
// a sentence for every error code the CMA routes send (read as text from apps/api/src/errors.ts, as
// shell/errorMessages.test.ts does: apps/web does not depend on @realty/api); the restated property types equal core's.
/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CMA_PROPERTY_TYPES as CORE_TYPES } from '@realty/core/valuation';
import { describe, expect, it } from 'vitest';
import { buildPageTable, messageFor } from '../../shell/index.js';
import { homeFallback } from '../../shell/shellSurface.js';
import { surfaces } from '../../shell/registry.js';
import { CMA_PROPERTY_TYPES, day, miles, money, signedMoney } from './lib.js';
import { CMA_ERROR_MESSAGES, DISCLOSURE_WORDS, FACT_WORDS, FEATURE_WORDS, INSPECTION_WORDS, PROPERTY_TYPE_WORDS, PURPOSE_WORDS, ROLE_WORDS, STATUS_WORDS, W, WHERE_WORDS } from './words.js';

const here = dirname(fileURLToPath(import.meta.url));
const BANNED = /confiden|probab|accura|score|likel|guarantee/i;

/** Every string a value holds; functions are called with sample arguments. */
function strings(v: unknown): string[] {
  if (typeof v === 'string') return [v];
  if (typeof v === 'function') return strings((v as (...a: unknown[]) => unknown)('Sam', 'Sample', 3));
  if (v && typeof v === 'object') return Object.values(v).flatMap(strings);
  return [];
}

/** The literal text of a source file: string and template literals and JSX text, comments removed. */
function literals(src: string): string[] {
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
  const out: string[] = [];
  for (const m of code.matchAll(/'((?:[^'\\\n]|\\.)*)'|"((?:[^"\\\n]|\\.)*)"|`((?:[^`\\]|\\.)*)`/g)) out.push(m[1] ?? m[2] ?? m[3] ?? '');
  for (const m of code.matchAll(/>([^<>{}]+)</g)) if (m[1]!.trim()) out.push(m[1]!.trim());
  return out;
}

const SOURCES = readdirSync(here).filter((f) => /\.(ts|tsx)$/.test(f) && !/\.test\.tsx?$/.test(f) && f !== 'testing.tsx');

describe('CMA words', () => {
  it('R-AST-13 R-CMA-4: no confidence, probability, accuracy, score, likelihood or guarantee word in words.ts', () => {
    const all = strings({ W, STATUS_WORDS, PURPOSE_WORDS, INSPECTION_WORDS, PROPERTY_TYPE_WORDS, DISCLOSURE_WORDS, WHERE_WORDS, ROLE_WORDS, FACT_WORDS, FEATURE_WORDS, CMA_ERROR_MESSAGES });
    expect(all.length).toBeGreaterThan(150);
    expect(all.filter((s) => BANNED.test(s))).toEqual([]);
  });

  it("R-AST-13 R-CMA-4: nor in any component's literal text", () => {
    expect(SOURCES).toEqual(expect.arrayContaining(['CmaPage.tsx', 'CompCard.tsx', 'NotUsed.tsx', 'SubjectFacts.tsx', 'Purpose.tsx', 'SharePanel.tsx', 'HomeValueSection.tsx', 'lib.ts', 'words.ts', 'index.ts']));
    const found = SOURCES.flatMap((f) => literals(readFileSync(resolve(here, f), 'utf8')).filter((s) => BANNED.test(s)).map((s) => `${f}: ${s}`));
    expect(found).toEqual([]);
    // the scan does see the text it guards
    expect(literals(readFileSync(resolve(here, 'words.ts'), 'utf8'))).toContain('This is an estimate, not an appraisal.');
    expect(literals('<p>Your score</p>').some((s) => BANNED.test(s))).toBe(true);
  });

  it('R-AVM-1: it is an estimate, not an appraisal, from MLS sales', () => {
    expect(W.estimate).toBe('This is an estimate, not an appraisal.');
    expect(W.source).toBe('Source: MLS sales');
  });

  it('has a sentence for every code of the api/cma sections of apps/api/src/errors.ts, each a full sentence that shows no code', () => {
    const text = readFileSync(resolve(here, '../../../../api/src/errors.ts'), 'utf8');
    const codes: string[] = [];
    let take = false;
    for (const line of text.split('\n')) {
      const section = /^\s*\/\/ ---- (.+?) ----/.exec(line);
      if (section) {
        take = /^api\/cma\b/.test(section[1]!);
        continue;
      }
      if (/^\s*\/\/ registry: add new entries/.test(line)) break;
      const m = /^\s*([A-Z][A-Z0-9_]*):\s*\d{3},/.exec(line);
      if (take && m) codes.push(m[1]!);
    }
    expect(codes).toEqual(
      expect.arrayContaining(['CMA_NOT_SHAREABLE', 'CMA_DISCLOSURE_INCOMPLETE', 'CMA_STATEMENT_NOT_RENDERABLE', 'CMA_FAIR_HOUSING', 'CMA_STALE', 'CMA_REPORT_TOO_LONG', 'CMA_RECIPIENT_BLOCKED', 'CMA_NO_RECIPIENT', 'CMA_VALUATION_NOT_ALLOWED', 'CMA_NO_MLS_CONNECTION', 'CMA_SUBJECT_INCOMPLETE', 'CMA_SUBJECT_TYPE_NOT_SUPPORTED', 'CMA_NOT_DRAFT', 'CMA_SUBJECT_ADDRESS_GONE']),
    );
    expect(codes.filter((c) => !Object.hasOwn(CMA_ERROR_MESSAGES, c))).toEqual([]);
    for (const [code, s] of Object.entries(CMA_ERROR_MESSAGES)) {
      expect(s, code).toMatch(/[.!?]$/);
      expect(s, code).not.toMatch(/\b[A-Z]{2,}_[A-Z_]+\b/);
    }
    // registered: the page table carries them to every page (the contact page's section too)
    const table = buildPageTable(surfaces, homeFallback);
    for (const c of codes) expect(messageFor(c, table.errorMessages)).toBe(CMA_ERROR_MESSAGES[c]);
  });

  it('the restated property types are core/valuation CMA_PROPERTY_TYPES, each with words', () => {
    expect([...CMA_PROPERTY_TYPES]).toEqual([...CORE_TYPES]);
    for (const t of CMA_PROPERTY_TYPES) expect(PROPERTY_TYPE_WORDS[t]).toEqual(expect.any(String));
  });

  it('money, signed amounts, distances and dates in words', () => {
    expect(money(51_250_000)).toBe('$512,500');
    expect(money(null)).toBe('not known');
    expect(signedMoney(-400_000)).toBe('−$4,000');
    expect(signedMoney(1_250_000)).toBe('+$12,500');
    expect(miles(644)).toBe('0.4 mi');
    expect(miles(null)).toBe('distance not known');
    expect(day('2026-10-02')).toBe('Oct 2, 2026');
  });
});
