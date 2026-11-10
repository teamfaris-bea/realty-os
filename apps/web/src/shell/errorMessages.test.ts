// Error code → sentence. The web never shows a raw code (CONVENTIONS §7).
/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_ERROR_CODES } from '@realty/core/foundation';
import { describe, expect, it } from 'vitest';
import { GENERIC_ERROR_MESSAGE, errorMessages, messageFor } from './errorMessages.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Codes from the sections of apps/api/src/errors.ts that the shell owns the sentences for (base,
 * core can() denials, core normalize, api/platform auth). Read as text: apps/web does not depend
 * on @realty/api. Other modules' codes belong to their surfaces' `errorMessages`.
 */
function serverCodes(): string[] {
  const text = readFileSync(resolve(here, '../../../api/src/errors.ts'), 'utf8');
  const codes: string[] = [];
  let take = false;
  for (const line of text.split('\n')) {
    const section = /^\s*\/\/ ---- (.+?) ----/.exec(line);
    if (section) {
      take = /^(base|core can\(\)|core normalize|api\/platform)/.test(section[1]!);
      continue;
    }
    if (/^\s*\/\/ registry: add new entries/.test(line)) break;
    const m = /^\s*([A-Z][A-Z0-9_]*):\s*\d{3},/.exec(line);
    if (take && m) codes.push(m[1]!);
  }
  return codes;
}

describe('errorMessages', () => {
  it('has a sentence for every base, can() denial, normalize and api/platform auth code the server defines', () => {
    const codes = serverCodes();
    expect(codes.length).toBeGreaterThan(30);
    expect(codes).toEqual(expect.arrayContaining([...BASE_ERROR_CODES]));
    const missing = codes.filter((c) => !Object.hasOwn(errorMessages, c));
    expect(missing).toEqual([]);
  });

  it('every sentence is a full, human sentence that never shows a code', () => {
    for (const [code, s] of Object.entries(errorMessages)) {
      expect(s.length, code).toBeGreaterThan(10);
      expect(s, code).toMatch(/[.!?]$/);
      expect(s, code).not.toMatch(/\b[A-Z]{2,}_[A-Z_]+\b/);
    }
  });

  it('unknown codes get an honest generic sentence, never the code', () => {
    expect(messageFor('SOMETHING_NEW_FROM_A_LATER_MODULE')).toBe(GENERIC_ERROR_MESSAGE);
    expect(messageFor({ code: 'X_Y' })).not.toContain('X_Y');
  });

  it('a `rule` detail picks the specific variant, else the code sentence', () => {
    expect(messageFor({ code: 'PASSWORD_TOO_WEAK', details: { rule: 'length' } })).toMatch(/12 characters/);
    expect(messageFor({ code: 'PASSWORD_TOO_WEAK', details: { rule: 'unknown_rule' } })).toBe(errorMessages.PASSWORD_TOO_WEAK);
    expect(messageFor({ code: 'PASSWORD_TOO_WEAK', details: null })).toBe(errorMessages.PASSWORD_TOO_WEAK);
  });

  it('surface sentences take precedence over the shell map', () => {
    expect(messageFor('NOT_FOUND', { NOT_FOUND: 'This lead is no longer yours.' })).toBe('This lead is no longer yours.');
    expect(messageFor('NOT_FOUND', { OTHER: 'x' })).toBe(errorMessages.NOT_FOUND);
  });

  it('does not resolve prototype keys as codes', () => {
    expect(messageFor('constructor')).toBe(GENERIC_ERROR_MESSAGE);
    expect(messageFor('toString', {})).toBe(GENERIC_ERROR_MESSAGE);
  });

  it('LOGIN_FAILED stays uniform (does not say whether the account exists or is locked)', () => {
    expect(errorMessages.LOGIN_FAILED).not.toMatch(/locked|no account|not found|doesn't exist/i);
  });
});
