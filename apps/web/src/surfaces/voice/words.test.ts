/// <reference types="node" />
// The voice word maps (module 55 items 8 and 9): every code worded by its code, exhaustive over core's closed sets,
// tested against the API's literal strings (R-STAFF-1, R-STAFF-9, CONVENTIONS.md:198).
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MESSAGE_TOPICS, TRANSFER_OUTCOMES, VOICE_END_REASONS, VOICE_LEDGER_TOOLS, VOICE_OUTCOMES, VOICE_REASON_CODES } from '@realty/core/voice';
import { SCRIPTS } from '@realty/core/voice/testing';
import { describe, expect, it } from 'vitest';
import { API_ATTESTATION, API_OWNER_ONLY_DISABLE, API_REASON_SENTENCES, API_TEST_CALL_SENTENCE, API_VENDOR_NOT_CONFIGURED_TEXT, RAW_CODE } from './testing.js';
import {
  ANSWERING_REASON_CODES,
  ANSWERING_REASON_WORDS,
  END_REASON_WORDS,
  LINE_SOURCE_WORDS,
  OUTCOME_WORDS,
  REASON_CODE_WORDS,
  SCRIPT_CHOICES,
  TOOL_WORDS,
  TOPIC_WORDS,
  TRANSFER_WORDS,
  isWidening,
  ledgerRowWords,
  reasonWords,
  toolWords,
  unloggedWords,
  withoutCodes,
} from './words.js';

const here = dirname(fileURLToPath(import.meta.url));
const apiVoice = (f: string) => readFileSync(resolve(here, '../../../../api/src/voice', f), 'utf8');

describe('R-STAFF-1 E660: the answering reasons are worded by code, never by the server sentence', () => {
  it('the copied API strings are still the API strings (answering.ts:27-28, :31, :44-50; provider.ts:76; routes.ts:32)', () => {
    const answering = apiVoice('answering.ts');
    for (const [code, sentence] of Object.entries(API_REASON_SENTENCES)) expect(answering).toContain(`${code}: ${JSON.stringify(sentence).replace(/^"|"$/g, "'")}`);
    expect(answering).toContain(`'${API_ATTESTATION}'`);
    expect(answering).toContain(JSON.stringify(API_OWNER_ONLY_DISABLE));
    expect(apiVoice('provider.ts')).toContain(`'${API_VENDOR_NOT_CONFIGURED_TEXT}'`);
    expect(apiVoice('routes.ts')).toContain(`'${API_TEST_CALL_SENTENCE}'`);
    // the API's map has exactly these codes
    const codes = [...answering.slice(answering.indexOf('const REASON')).split('};')[0]!.matchAll(/^ {2}([A-Z_]+):/gm)].map((m) => m[1]);
    expect(codes.sort()).toEqual([...ANSWERING_REASON_CODES].sort());
  });

  it('every API reason has its own words; the API sentences would leak a pack key or a planning tag, ours do not', () => {
    expect(Object.keys(ANSWERING_REASON_WORDS).sort()).toEqual(Object.keys(API_REASON_SENTENCES).sort());
    expect(API_REASON_SENTENCES.VOICE_NOT_CLEARED).toMatch(RAW_CODE);
    expect(API_REASON_SENTENCES.VOICE_VENDOR_NOT_CONFIGURED).toMatch(RAW_CODE);
    for (const [code, sentence] of Object.entries(API_REASON_SENTENCES)) {
      const words = reasonWords({ code, sentence });
      expect(words).toBe(ANSWERING_REASON_WORDS[code as keyof typeof ANSWERING_REASON_WORDS]);
      expect(words, code).not.toMatch(RAW_CODE);
      expect(words).not.toMatch(/platform|\(N/);
    }
  });

  it('an unknown reason code shows the server sentence without codes, never the code', () => {
    expect(reasonWords({ code: 'VOICE_SOMETHING_NEW', sentence: 'Waits for a check (platform:voice is not cleared).' })).toBe('Waits for a check.');
    expect(reasonWords({ code: 'VOICE_SOMETHING_NEW', sentence: 'VOICE_SOMETHING_NEW' })).toBe('Another check is not met yet.');
    expect(withoutCodes(API_VENDOR_NOT_CONFIGURED_TEXT)).toBe('No voice vendor is set up on this platform yet. AI answering stays off.');
  });
});

describe('R-STAFF-9: the voice word maps are exhaustive over core/voice closed sets and show no code', () => {
  it('tools, reason codes, outcomes, end reasons, transfer outcomes, topics and line sources', () => {
    expect(Object.keys(TOOL_WORDS).sort()).toEqual([...VOICE_LEDGER_TOOLS].sort());
    expect(Object.keys(REASON_CODE_WORDS).sort()).toEqual([...VOICE_REASON_CODES].sort());
    expect(Object.keys(OUTCOME_WORDS).sort()).toEqual([...VOICE_OUTCOMES].sort());
    expect(Object.keys(END_REASON_WORDS).sort()).toEqual([...VOICE_END_REASONS, 'SESSION_LOST'].sort());
    expect(Object.keys(TRANSFER_WORDS).sort()).toEqual([...TRANSFER_OUTCOMES].sort());
    expect(Object.keys(TOPIC_WORDS).sort()).toEqual([...MESSAGE_TOPICS].sort());
    expect(Object.keys(LINE_SOURCE_WORDS).sort()).toEqual(['announcement', 'disclosure', 'model', 'script']);
    const all = [TOOL_WORDS, REASON_CODE_WORDS, OUTCOME_WORDS, END_REASON_WORDS, TRANSFER_WORDS, TOPIC_WORDS, LINE_SOURCE_WORDS, ANSWERING_REASON_WORDS].flatMap((m) => Object.values(m));
    for (const w of all) expect(w).not.toMatch(RAW_CODE);
  });

  it('ledger rows in words: allowed or refused with the reason, a tool outside the set and an unknown code without a code', () => {
    expect(ledgerRowWords({ tool: 'book_appointment', decision: 'allow', reasonCode: 'ALLOW_OFFERED_SLOT' })).toBe('Book a time: allowed, because the time was one of the times offered.');
    expect(ledgerRowWords({ tool: 'dial_number', decision: 'deny', reasonCode: 'VOICE_TOOL_UNKNOWN' })).toBe('A request outside the tools the assistant may use: refused, because it is not a tool the assistant may use.');
    expect(ledgerRowWords({ tool: null, decision: 'deny', reasonCode: 'SOMETHING_ELSE' })).toBe('A request outside the tools the assistant may use: refused.');
    expect(toolWords('end_call')).toBe('End the call');
    expect(unloggedWords('VOICE_TOOL_BEFORE_DISCLOSURE')).toMatch(/^A request was refused and not logged, because the caller had not yet heard/);
    expect(unloggedWords('NEW_CODE')).toBe('A request was refused and not logged.');
  });
});

describe('the test-call script list', () => {
  it("is pinned to core's scripted callers (packages/core/src/voice/testing/fixtures.ts SCRIPTS), each a name the API's body accepts", () => {
    expect(SCRIPT_CHOICES.map((s) => s.name).sort()).toEqual(Object.keys(SCRIPTS).sort());
    for (const s of SCRIPT_CHOICES) {
      expect(s.name).toMatch(/^[a-zA-Z]{1,40}$/); // TestCallBody.script
      expect(s.label).not.toMatch(RAW_CODE);
    }
    expect(SCRIPT_CHOICES[0]!.name).toBe('booking');
  });
});

describe('R-STAFF-4 E661: widening is what the API calls loosening', () => {
  it('sooner, or after-hours-only to missed-and-after-hours, widens; later or fewer hours narrows', () => {
    const cur = { answerAfterSeconds: 20, answerWhen: 'after_hours_only' };
    expect(isWidening(cur, { answerAfterSeconds: 15, answerWhen: 'after_hours_only' })).toBe(true);
    expect(isWidening(cur, { answerAfterSeconds: 20, answerWhen: 'missed_and_after_hours' })).toBe(true);
    expect(isWidening(cur, { answerAfterSeconds: 30, answerWhen: 'after_hours_only' })).toBe(false);
    expect(isWidening({ answerAfterSeconds: 20, answerWhen: 'missed_and_after_hours' }, { answerAfterSeconds: 20, answerWhen: 'after_hours_only' })).toBe(false);
    // the API's own definition, read from answering.ts
    expect(apiVoice('answering.ts')).toContain("return next.answerAfterSeconds < cur.answerAfterSeconds || (cur.answerWhen === 'after_hours_only' && next.answerWhen === 'missed_and_after_hours');");
  });
});
