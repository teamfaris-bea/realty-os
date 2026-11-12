// voiceTurnGuard and the caller-turn lexicons (R-VOICE-5, R-VOICE-8, R-AST-3, R-AST-11, R-FH-2, R-FH-3).
import { describe, expect, it } from 'vitest';
import { DEFAULT_FAIR_HOUSING_PACK } from '../fairhousing/index.js';
import { KEYWORDS } from './testing/index.js';
import { CLEAN_TURNS, IDENTITY, MODEL_OUTPUTS, OBFUSCATED_TURNS, TOPIC_FIXTURES } from './testing/index.js';
import { VOICE_LINES, VOICE_LINE_IDS, callerTurnSignals, detectHumanQuestion, languageMatches, mentionsMoneyAmount, voiceScopeTopics, voiceTurnGuard } from './index.js';

const signals = (text: string, language: string | null = 'en') => callerTurnSignals(text, { keywords: KEYWORDS, language, coveredLanguages: ['en'] });

describe('voiceTurnGuard: a model turn that fails is never spoken', () => {
  it('R-VOICE-8 R-AST-11 every scripted line passes the guard and says it is an automated assistant', () => {
    for (const id of VOICE_LINE_IDS) {
      const r = voiceTurnGuard(VOICE_LINES[id], IDENTITY);
      expect({ id, issues: r.issues }).toEqual({ id, issues: [] });
      if (id !== 'areaQuestion') expect(VOICE_LINES[id]).toMatch(/automated assistant/);
    }
  });

  it('passes ordinary scheduling turns', () => {
    for (const t of [MODEL_OUTPUTS.greeting, MODEL_OUTPUTS.offerSlots, MODEL_OUTPUTS.takingMessage, MODEL_OUTPUTS.goodbye, 'The house has a family room and a big yard.']) {
      expect(voiceTurnGuard(t, IDENTITY)).toEqual({ pass: true, issues: [], hardBlock: false, category: null, checkThis: false });
    }
  });

  it('R-VOICE-8 R-AST-11 a human claim fails, plain or obfuscated, including the agent\'s name', () => {
    for (const t of [MODEL_OUTPUTS.claimsHuman, MODEL_OUTPUTS.claimsHumanObfuscated, MODEL_OUTPUTS.namedPerson, "I'm a human, don't worry.", "No, I'm not a bot.", 'jordan here, how can I help?']) {
      const r = voiceTurnGuard(t, IDENTITY);
      expect(r.pass).toBe(false);
      expect(r.issues.map((i) => i.code)).toEqual(expect.arrayContaining(['HUMAN_CLAIM']));
    }
  });

  it('R-VOICE-5 R-AST-3 money: the lexicon, a spoken amount, a lending term ⇒ category money; payment instructions are a hard block', () => {
    expect(voiceTurnGuard(MODEL_OUTPUTS.price, IDENTITY)).toMatchObject({ pass: false, category: 'money', hardBlock: false });
    expect(voiceTurnGuard(MODEL_OUTPUTS.spokenPrice, IDENTITY).issues).toContainEqual({ code: 'MONEY_TOPIC', detail: 'spoken amount' });
    expect(voiceTurnGuard(MODEL_OUTPUTS.lending, IDENTITY).issues).toContainEqual({ code: 'MONEY_TOPIC', detail: 'lending:mortgage' });
    expect(voiceTurnGuard(MODEL_OUTPUTS.wire, IDENTITY)).toMatchObject({ pass: false, category: 'money' });
    expect(voiceTurnGuard('Send it to routing 021000021 account 123456789.', IDENTITY)).toMatchObject({ hardBlock: true, category: 'money' });
  });

  it('a term matched twice is reported once', () => {
    const r = voiceTurnGuard('What would the seller take? The sellers would accept less.', IDENTITY);
    expect(r.issues.filter((i) => i.detail === 'price:seller would take')).toHaveLength(1);
  });

  it('R-VOICE-5 contracts and legal ⇒ category contract', () => {
    expect(voiceTurnGuard('You can add an inspection contingency.', IDENTITY)).toMatchObject({ pass: false, category: 'contract' });
    expect(voiceTurnGuard('You may want to ask a lawyer about that.', IDENTITY).issues).toContainEqual({ code: 'CONTRACT_TOPIC', detail: 'legal:lawyer' });
  });

  it('R-FH-2 a fair-housing match fails and sets checkThis; another pack can be given', () => {
    const r = voiceTurnGuard(MODEL_OUTPUTS.area, IDENTITY);
    expect(r).toMatchObject({ pass: false, checkThis: true });
    expect(r.issues.some((i) => i.code === 'FAIR_HOUSING')).toBe(true);
    const empty = { ...DEFAULT_FAIR_HOUSING_PACK, hard: [], soft: [] };
    expect(voiceTurnGuard('perfect for families', IDENTITY, empty).issues.some((i) => i.code === 'FAIR_HOUSING')).toBe(false);
    expect(voiceTurnGuard('perfect for families', IDENTITY, DEFAULT_FAIR_HOUSING_PACK).checkThis).toBe(true);
  });

  it('obfuscation and an empty turn fail', () => {
    expect(voiceTurnGuard('Happy to he​lp.', IDENTITY).issues).toContainEqual({ code: 'OBFUSCATED_TEXT' });
    expect(voiceTurnGuard('   ', IDENTITY).issues).toContainEqual({ code: 'EMPTY' });
    expect(voiceTurnGuard('​', IDENTITY).issues.map((i) => i.code)).toEqual(expect.arrayContaining(['EMPTY', 'OBFUSCATED_TEXT']));
  });

  it('runs none of the text-only checks (no sign-off, STOP hint, brokerage name or link checks)', () => {
    const r = voiceTurnGuard('Sure, let me check that for you.', IDENTITY);
    expect(r.pass).toBe(true);
    const codes = new Set(voiceTurnGuard('See example.org for details.', IDENTITY).issues.map((i) => i.code));
    for (const c of ['MISSING_SIGN_OFF', 'MISSING_OPT_OUT_HINT', 'MISSING_BROKERAGE_NAME', 'UNKNOWN_LINK', 'TOO_LONG', 'UNFILLED_SLOT']) expect(codes.has(c as never)).toBe(false);
  });
});

describe('caller-turn scope: topic fixtures with zero false negatives', () => {
  const expectCategory = { money: 'money', offers: 'money', contracts: 'contract', commission: 'money', legal: 'legal', lending: 'lending' } as const;
  for (const [topic, cat] of Object.entries(expectCategory)) {
    it.each(TOPIC_FIXTURES[topic as keyof typeof expectCategory])(`R-VOICE-5 ${topic}: "%s" is out of scope (${cat})`, (t) => {
      expect(signals(t).scope).toContain(cat);
    });
  }

  it.each(TOPIC_FIXTURES.area)('R-FH-3 area question: "%s" hands back with the neutral line', (t) => {
    expect(signals(t).area.action).toBe('handback');
  });

  it.each(CLEAN_TURNS)('ordinary turn "%s" is not flagged ("family room" included)', (t) => {
    const s = signals(t);
    expect({ scope: s.scope, area: s.area.action, human: s.humanQuestion, opt: s.optOut.kind }).toEqual({ scope: [], area: 'continue', human: false, opt: 'none' });
  });

  it.each(Object.entries(OBFUSCATED_TURNS).flatMap(([k, ts]) => ts.map((t) => [k, t] as const)))('obfuscated %s turn "%s" is still caught', (kind, t) => {
    const s = signals(t);
    if (kind === 'money') expect(s.scope).toContain('money');
    if (kind === 'lending') expect(s.scope).toContain('lending');
    if (kind === 'area') expect(s.area.action).toBe('handback');
    if (kind === 'human') expect(s.humanQuestion).toBe(true);
  });

  it.each(['Am I talking to a real person?', 'Are you a robot?', 'r u a bot', 'Is this a recording?', 'Are you real?', 'Can I talk to a real person?', "You're a person named Casey, right?", 'Are you an AI?'])('R-VOICE-8 E113 "%s" is a human question', (t) => {
    expect(detectHumanQuestion(t)).toBe(true);
  });

  it('spoken money amounts, and the area words that are not money', () => {
    for (const t of ['$450k', '450 thousand', 'four hundred fifty thousand', 'two point five million', 'half a million', 'a few hundred dollars', '300 bucks']) expect(mentionsMoneyAmount(t)).toBe(true);
    for (const t of ['two thousand square feet', '3 bedrooms', '1,800 sq ft', 'ten thousand people live there', 'the year 2026']) expect(mentionsMoneyAmount(t)).toBe(false);
    expect(voiceScopeTopics('what about the mortgage and the lawyer and the price?')).toEqual(['legal', 'lending', 'price']);
  });

  it('E119 the covered-language fact: a reported code outside the covered set; none reported is not uncovered', () => {
    expect(signals('Hola', 'es').uncoveredLanguage).toBe(true);
    expect(signals('Hello', 'en-US').uncoveredLanguage).toBe(false);
    expect(signals('Hello', null).uncoveredLanguage).toBe(false);
    expect(languageMatches('en', 'EN-gb')).toBe(true);
    expect(languageMatches('en', 'eng')).toBe(false);
    expect(languageMatches(' ', 'en')).toBe(false);
  });

  it('several out-of-scope categories come in a fixed order', () => {
    expect(signals('Do I need a lawyer to sign the contract, and what is the price, and the mortgage rate?').scope).toEqual(['money', 'contract', 'legal', 'lending']);
  });
});
