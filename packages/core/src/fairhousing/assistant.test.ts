import { describe, expect, it } from 'vitest';
import { AREA_QUESTION_CLIENT_REPLY, areaQuestionPolicy, check, DEFAULT_FAIR_HOUSING_PACK as PACK, detectAreaQuestion, guardAssistantOutput } from './index.js';

describe('assistant and voice guard (R-FH-2)', () => {
  it('R-FH-2: assistant output with a hard match is never autonomous and is flagged "Check this"', () => {
    const r = guardAssistantOutput('The Elm St home is perfect for young families. — the Smith Team assistant', PACK);
    expect(r).toMatchObject({ autonomousAllowed: false, checkThis: true });
    expect(r.hard.map((m) => m.termId)).toContain('fh.familial.ideal_occupant');
  });

  it('R-FH-2: a soft match alone also makes it a draft', () => {
    const r = guardAssistantOutput('It is a safe neighborhood with sidewalks.', PACK);
    expect(r).toMatchObject({ autonomousAllowed: false, checkThis: true, hard: [] });
    expect(r.soft.length).toBe(1);
  });

  it('R-FH-2: a negated (equal-opportunity) mention still makes it a draft', () => {
    const r = guardAssistantOutput('We serve everyone, regardless of familial status.', PACK);
    expect(r.hard).toEqual([]);
    expect(r.autonomousAllowed).toBe(false);
  });

  it('R-FH-2: clean output may go on its own (other guards still apply)', () => {
    expect(guardAssistantOutput('The home on Elm dropped to a new price. — the Smith Team assistant', PACK)).toEqual({ autonomousAllowed: true, checkThis: false, hard: [], soft: [] });
  });
});

describe('questions about who lives in an area (R-FH-3)', () => {
  const asks: [string, 'who_lives_there' | 'safety' | 'kind_of_people'][] = [
    ['Is it a safe neighborhood?', 'safety'],
    ['how safe is the area at night', 'safety'],
    ["What's the crime like over there?", 'safety'],
    ['Is that street sketchy?', 'safety'],
    ['Is it a bad area?', 'safety'],
    ['What kind of people live there?', 'kind_of_people'],
    ['Will we fit in?', 'kind_of_people'],
    ['are there people like us', 'kind_of_people'],
    ['Who lives on that block?', 'who_lives_there'],
    ['What are the demographics?', 'who_lives_there'],
    ['Is it diverse?', 'who_lives_there'],
    ['Is it mostly white?', 'who_lives_there'],
    ['Are there a lot of families with kids?', 'who_lives_there'],
    ['Any retirees nearby?', 'who_lives_there'],
    ['What are the neighbors like?', 'who_lives_there'],
    ['Is it a religious area?', 'who_lives_there'],
    ['Is it sаfe? — is the area safe', 'safety'],
  ];
  for (const [q, topic] of asks) {
    it(`R-FH-3: "${q}" is handed back (${topic})`, () => {
      expect(detectAreaQuestion(q)?.topic).toBe(topic);
      const p = areaQuestionPolicy(q);
      expect(p.action).toBe('handback');
      if (p.action === 'handback') {
        expect(p.topic).toBe(topic);
        expect(p.clientReply).toBe(AREA_QUESTION_CLIENT_REPLY);
        expect(p.agentNote).toMatch(/^Fair housing: they asked about/);
        expect(p.agentNote).toContain(p.quoted);
      }
    });
  }

  const ordinary = ['Can we see it Saturday?', 'How many bedrooms does it have?', 'Is the garage big enough for two cars?', 'What are the HOA fees?', 'Is there a safe room in the basement'.replace('safe room', 'storm shelter'), 'Is the yard fenced?'];
  for (const q of ordinary) {
    it(`R-FH-3: an ordinary question goes on: "${q}"`, () => {
      expect(detectAreaQuestion(q)).toBeNull();
      expect(areaQuestionPolicy(q)).toEqual({ action: 'continue' });
    });
  }

  it('R-FH-3: the neutral client line itself passes the copy check and makes no claim about the area', () => {
    expect(check(AREA_QUESTION_CLIENT_REPLY, PACK)).toEqual({ hard: [], soft: [] });
    expect(AREA_QUESTION_CLIENT_REPLY).not.toMatch(/\b(?:is|are) (?:safe|quiet|great|nice)\b/i);
  });
});
