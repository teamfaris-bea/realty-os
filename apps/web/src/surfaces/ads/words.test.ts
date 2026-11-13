/// <reference types="node" />
// The ads words (module 55 item 10): the cap attestation the web builds is the API's own sentence (read from the API
// source text: the web never imports api code), every ads code of apps/api/src/errors.ts has words, and no sentence
// shows a raw code (R-STAFF-4, CONVENTIONS §7).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ADS_ERROR_MESSAGES, ADS_MESSAGES, CAMPAIGN_STATUS_WORDS, LEDGER_KIND_WORDS, capAttestation, dollars, refusalWords } from './words.js';
import { RAW } from './testing.js';

const here = dirname(fileURLToPath(import.meta.url));
const api = (p: string) => readFileSync(resolve(here, '../../../../api/src', p), 'utf8');
const web = (p: string) => readFileSync(resolve(here, p), 'utf8');

/** The text of a function's body in a source file (from its signature to the first line that is a lone `}`). */
function body(src: string, signature: RegExp): string {
  const m = signature.exec(src);
  if (!m) throw new Error(`not found: ${signature}`);
  const from = src.indexOf('{', m.index + m[0].length - 1);
  const to = src.indexOf('\n}', from);
  return src.slice(from, to + 2).replace(/\s+/g, ' ').trim();
}

describe('ads words', () => {
  it('R-STAFF-4 E670: capAttestation and dollars are the API’s own (apps/api/src/ads/settings.ts, compared as source text)', () => {
    const a = api('ads/settings.ts');
    const w = web('words.ts');
    expect(body(w, /export function capAttestation\(/)).toBe(body(a, /export function capAttestation\(/));
    expect(body(w, /export function dollars\(/)).toBe(body(a, /export function dollars\(/));
    expect(capAttestation(250_050, 10_000)).toBe('I approve a Google Ads cap of $2,500.50 a month and $100.00 a day.');
    expect(dollars(123_456_789)).toBe('$1,234,567.89');
  });

  it('R-STAFF-4: every module 52 ads code of apps/api/src/errors.ts (and ACTION_NOT_PENDING) has words, none showing a raw code', () => {
    const src = api('errors.ts');
    const block = src.slice(src.indexOf('module 52 api/ads'), src.indexOf('module 75'));
    const codes = [...block.matchAll(/^\s+([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1]!);
    expect(codes.length).toBeGreaterThanOrEqual(19);
    for (const c of codes) {
      expect(ADS_ERROR_MESSAGES[c], c).toBeTruthy();
      expect(refusalWords({ code: c, details: null }), c).not.toMatch(RAW);
    }
    expect(ADS_MESSAGES.ACTION_NOT_PENDING).toBeTruthy();
    for (const s of ['superseded', 'approved', 'executed', 'rejected', 'blocked', 'something_new']) {
      expect(refusalWords({ code: 'ACTION_NOT_PENDING', details: { status: s } })).not.toMatch(RAW);
    }
    for (const r of ['CAP_VERSION_CHANGED', 'CAMPAIGN_CHANGED', 'CAMPAIGN_NOT_ELIGIBLE', 'PLATFORM_CHANGED', 'UNKNOWN_REASON']) {
      expect(refusalWords({ code: 'ADS_PROPOSAL_STALE', details: { reason: r } })).not.toMatch(RAW);
    }
  });

  it('R-STAFF-1: the status and ledger word maps cover core/ads CAMPAIGN_STATUSES and LEDGER_EVENT_KINDS', () => {
    const core = readFileSync(resolve(here, '../../../../../packages/core/src/ads/types.ts'), 'utf8');
    const list = (name: string) => [...(new RegExp(`${name} = \\[([^\\]]+)\\]`).exec(core)?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
    expect(Object.keys(CAMPAIGN_STATUS_WORDS).sort()).toEqual(list('CAMPAIGN_STATUSES').sort());
    expect(Object.keys(LEDGER_KIND_WORDS).sort()).toEqual(list('LEDGER_EVENT_KINDS').sort());
  });
});
