// Module 48 architecture (R-VOICE-1, R-VOICE-11, R-VOICE-13, R-VOICE-24, R-GATE-9, R-TWL-3, R-TWL-5, D1, D7): source scans
// of apps/api/src/voice prove that the module sends, dials and books nothing on its own path, changes no ownership, makes
// no network call, configures no number, reads no prediction or call score, keeps the fixtures out of production code
// except the fake and the in-memory test call, ships no hot rule and hands the vendor no contact field.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { VOICE_SESSION_CONTEXT_KEYS } from './provider.js';

const DIR = dirname(fileURLToPath(import.meta.url));
const FILES = readdirSync(DIR).filter((n) => n.endsWith('.ts'));
const isTest = (n: string) => n.endsWith('.test.ts') || n === 'testing.ts';
const RUNTIME = FILES.filter((n) => !isTest(n));
const src = (n: string) => readFileSync(join(DIR, n), 'utf8');
/** Source without comments, so a doc line naming a forbidden symbol does not count. */
const code = (n: string) => src(n).replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

describe('R-VOICE-11 D1 R-GATE-9: what module 48 may not do', () => {
  it('the scan is not vacuous', () => {
    expect(RUNTIME.sort()).toEqual(['answering.ts', 'effects.ts', 'facts.ts', 'fake.ts', 'handback.ts', 'handlers.ts', 'ledger.ts', 'optout.ts', 'provider.ts', 'routes.ts', 'runtime.ts', 'schemas.ts', 'session.ts', 'slots.ts', 'takeover.ts', 'transfer.ts']);
  });

  it('D1: no send, dial or telephony call: dispatchOutbound, queueOutbound*, dialOutbound and providers.telephony are never named', () => {
    for (const n of RUNTIME) expect(code(n), n).not.toMatch(/dispatchOutbound|queueOutbound|dialOutbound|(?<!config\.)providers\.telephony|deps\.providers\.telephony/);
  });

  it('R-VOICE-6: no ownership command and no ownership import', () => {
    for (const n of RUNTIME) expect(code(n), n).not.toMatch(/applyOwnershipCommand|ownershipCommand|setOwnershipCommand|leads\/intake|ownership\/commands/);
  });

  it('R-TWL-5 R-TWL-3: no network call, no number configuration, no new webhook path', () => {
    for (const n of RUNTIME) {
      expect(code(n), n).not.toMatch(/\bfetch\(|IncomingPhoneNumbers|\bVoiceUrl\b|\bStatusCallback\b|\bSmsUrl\b|https?:\/\/api\./);
      expect(code(n), n).not.toMatch(/\/webhooks\//);
    }
  });

  it('R-PRED-4 R-COACH-5: no prediction or coaching import', () => {
    for (const n of FILES) expect(src(n), n).not.toMatch(/core\/predict|core\/coaching|\.\.\/predict\/|\.\.\/coaching\//);
  });

  it('only the fake, the in-memory test call and tests import @realty/core/voice/testing (it ships in dist)', () => {
    const users = FILES.filter((n) => /@realty\/core\/voice\/testing/.test(src(n))).filter((n) => !isTest(n));
    expect(users.sort()).toEqual(['fake.ts', 'routes.ts']);
    const elsewhere = (dir: string): string[] =>
      readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? (d.name === 'node_modules' || d.name === 'voice' ? [] : elsewhere(join(dir, d.name))) : d.name.endsWith('.ts') && !d.name.endsWith('.test.ts') && d.name !== 'testing.ts' ? [join(dir, d.name)] : []));
    for (const f of elsewhere(join(DIR, '..'))) expect(readFileSync(f, 'utf8'), f).not.toMatch(/@realty\/core\/voice\/testing/);
  });

  it('R-VOICE-24: production ships no hot rule: the default answers null and only the test seam sets one', () => {
    expect(code('runtime.ts')).toMatch(/hotRuleFor: s\.hotRuleFor \?\? \(\(\) => null\)/);
    for (const n of RUNTIME.filter((x) => x !== 'runtime.ts')) expect(code(n), n).not.toMatch(/hotRuleFor\s*[:=]/);
    for (const n of RUNTIME) expect(code(n), n).not.toMatch(/FIXTURE_HOT_RULE|parseHotRule/);
  });

  it('R-VOICE-13: the vendor context names no contact, person, address, phone, email, claim or owner field', () => {
    for (const k of VOICE_SESSION_CONTEXT_KEYS) expect(k).not.toMatch(/contact|name|phone|email|address|claim|owner|caller/i);
    const block = /export interface VoiceSessionContext \{([\s\S]*?)\n\}/.exec(src('provider.ts'))![1]!;
    const keys = [...block.matchAll(/^\s+(\w+)\??:/gm)].map((m) => m[1]);
    expect(keys.sort()).toEqual([...VOICE_SESSION_CONTEXT_KEYS].sort());
  });

  it('R-VOICE-7: the module enqueues no assistant.enrich_handback job and calls no model in a session', () => {
    for (const n of RUNTIME) expect(code(n), n).not.toMatch(/enrich_handback|providers\.ai|runModel/);
  });

  it('R-VOICE-1: no outbound call is ever made: no direction other than inbound is written', () => {
    for (const n of RUNTIME) expect(code(n), n).not.toMatch(/direction\s*=\s*'outbound'|'outbound'\s*,\s*'assistant'/);
  });

  it('D7 D11: nothing writes jurisdiction_packs (no pack bump, no clearance, no voice_transfer_hold_seconds seed)', () => {
    for (const n of RUNTIME) expect(code(n), n).not.toMatch(/(UPDATE|INSERT INTO)\s+jurisdiction_packs|vendor_ready_at\s*=/i);
  });
});
