import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ESCALATION_CLASSES, type EscalationClass } from './types.js';
import { ESCALATION_TABLE, STOP_CLASSES, escalationPriority, inboundSignals, isAcknowledgementOnly, legalRequest, precedence, questionClauses, requestFrame, topClass, uncoveredLanguage } from './signals.js';
import { MUST_ESCALATE, MUST_NOT_ESCALATE, NEGATED, classify } from './testing/fixtures.js';

const sig = (text: string, reaction = false) => inboundSignals({ ownText: text, classification: classify(text), reaction });

describe('R-ISA-6 lexicon fixtures: every class escalates on its must-escalate phrases', () => {
  for (const [cls, phrases] of Object.entries(MUST_ESCALATE)) {
    for (const p of phrases) {
      it(`${cls}: "${p}"`, () => expect(sig(p).classes).toContain(cls));
    }
  }
});

describe('R-ISA-6 E507 negated fixtures never escalate their class', () => {
  for (const [cls, phrases] of Object.entries(NEGATED)) {
    for (const p of phrases) {
      it(`${cls} negated: "${p}"`, () => expect(sig(p).classes).not.toContain(cls));
    }
  }
});

describe('R-ISA-6 E504 statements are qualification, never an escalation (every B3 and S3 phrase)', () => {
  for (const p of MUST_NOT_ESCALATE) {
    it(`no escalation: "${p}"`, () => expect(sig(p).classes).toEqual([]));
  }
  it('E504 "What rate can we get?" is financial; "our budget is around 450k" is not', () => {
    expect(sig('What rate can we get?').classes).toEqual(['financial']);
    expect(sig('our budget is around 450k').classes).toEqual([]);
  });
  it('request frames: the question clause must hold the topic ("we\'re preapproved, what\'s next?" is not financial)', () => {
    expect(requestFrame("we're preapproved, what's next?", 'financial')).toBe(false);
    expect(requestFrame('are FHA loans ok?', 'financial')).toBe(true);
    expect(questionClauses('Hi. We are preapproved, what next? Also, ok.')).toEqual(['what next?']);
    expect(requestFrame('is the price negotiable?', 'pricing_negotiation')).toBe(true);
  });
  it('legal topics escalate only in a question or an ask', () => {
    expect(legalRequest('we had the inspection last week')).toBe(false);
    expect(legalRequest('can you look at the disclosure?')).toBe(true);
    expect(legalRequest('is the title clean?')).toBe(true);
  });
});

describe('R-ISA-6 E500 bot question versus human request', () => {
  it('"Is this a real person?" is the bot line, care continues', () => {
    const s = sig('Is this a real person?');
    expect(s.botQuestion).toBe(true);
    expect(s.classes).toEqual([]);
  });
  it('"I want a real person" is human_request, not a bot question', () => {
    const s = sig('I want a real person');
    expect(s.classes).toContain('human_request');
    expect(s.botQuestion).toBe(false);
  });
  it('"are you a bot?" is a bot question', () => expect(sig('are you a bot?').botQuestion).toBe(true));
});

describe('R-ISA-6 opt-outs and the precedence table', () => {
  it('STOP and opt-out language are row 1 (opt_out); wrong number is row 1 too', () => {
    expect(sig('STOP').classes[0]).toBe('opt_out');
    expect(sig('please stop texting me').classes[0]).toBe('opt_out');
    expect(sig('wrong number').classes[0]).toBe('wrong_number');
    expect(sig('STOP').trigger).toBe('classification');
  });
  it('the stop classes are rows 1–9, in table order', () => {
    expect([...STOP_CLASSES]).toEqual(['opt_out', 'wrong_number', 'possible_opt_out', 'safety', 'fraud_risk', 'consent_dispute', 'privacy_request', 'ai_declined', 'complaint', 'human_request']);
    expect(STOP_CLASSES.has('fair_housing')).toBe(false);
  });
  it('a stop class wins over a hold topic in the same message', () => {
    const s = sig("what's my home worth? also how did you get my number?");
    expect(topClass(s.classes)).toBe('consent_dispute');
    expect(s.classes).toContain('pricing_negotiation');
  });
  it('E530 safety outranks every other class; triggers name their source', () => {
    expect(topClass(sig('I want to kill myself, also what rate can we get?').classes)).toBe('safety');
    expect(sig('What rate can we get?').trigger).toBe('frame');
    expect(sig('Is it safe? Who lives there?').trigger).toBe('fair_housing');
    expect(sig('Hola, quiero vender mi casa por favor').trigger).toBe('language');
    expect(sig('this is her husband').trigger).toBe('lexicon');
  });
  it('property: topClass is the minimum precedence and is order-independent', () => {
    fc.assert(
      fc.property(fc.subarray([...ESCALATION_CLASSES], { minLength: 1 }), (cs) => {
        const t = topClass(cs) as EscalationClass;
        expect(cs.every((c) => precedence(t) <= precedence(c))).toBe(true);
        expect(topClass([...cs].reverse())).toBe(t);
      }),
    );
    expect(topClass([])).toBeNull();
  });
  it('the table types: terminal, hold_topic and check_this rows as in §4.4', () => {
    const holds = ESCALATION_CLASSES.filter((c) => ESCALATION_TABLE[c].type === 'hold_topic');
    expect(holds).toEqual(['pricing_negotiation', 'financial', 'data_unavailable', 'booking_unavailable']);
    expect(ESCALATION_CLASSES.filter((c) => ESCALATION_TABLE[c].type === 'check_this')).toEqual(['other_agent']);
    const blocks = ESCALATION_CLASSES.filter((c) => ESCALATION_TABLE[c].block);
    expect(blocks).toEqual(['opt_out', 'wrong_number', 'possible_opt_out', 'consent_dispute', 'ai_declined', 'complaint']);
    expect(ESCALATION_TABLE.safety.line).toBe('safety');
    expect(ESCALATION_TABLE.consent_dispute.line).toBeNull();
  });
  it('limit and flood go high when an inbound is unanswered', () => {
    expect(escalationPriority('flood', false)).toBe('low');
    expect(escalationPriority('flood', true)).toBe('high');
    expect(escalationPriority('limit', true)).toBe('high');
    expect(escalationPriority('safety', false)).toBe('critical');
  });
});

describe('acknowledgements and languages', () => {
  it('E533 "thanks!", "ok", a reaction are acknowledgement-only; a question is not', () => {
    expect(isAcknowledgementOnly('thanks!', false)).toBe(true);
    expect(isAcknowledgementOnly('ok', false)).toBe(true);
    expect(isAcknowledgementOnly('anything', true)).toBe(true);
    expect(isAcknowledgementOnly('actually can we do Wednesday?', false)).toBe(false);
    expect(sig('👍', true).acknowledgementOnly).toBe(true);
  });
  it('uncovered languages: non-Latin script or a dominant other-language word set; one borrowed word is not', () => {
    expect(uncoveredLanguage('我想买房子')).toBe(true);
    expect(uncoveredLanguage('Hola, quiero vender mi casa')).toBe(true);
    expect(uncoveredLanguage('we love the casa on the hill')).toBe(false);
    expect(uncoveredLanguage('')).toBe(false);
    expect(uncoveredLanguage('Jose here, looking for 3 beds')).toBe(false);
  });
});
