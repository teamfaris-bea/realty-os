// The stage guide (R-STG-1): what each of the eight stages means, in words an agent can pick from without asking
// their team lead. The keys never change; the guide only says what is true of a person in that stage.
import { describe, expect, it } from 'vitest';
import { DEFAULT_STAGE_LABELS, STAGES, STAGE_GUIDE, stageGuide, stageLabel, validateStageLabels } from './index.js';

describe('core/parity-people: the stage guide (R-STG-1)', () => {
  it('R-STG-1 every one of the eight keys has a default label, a one-line definition and a one-line "does not mean"', () => {
    expect(Object.keys(STAGE_GUIDE).sort()).toEqual([...STAGES].sort());
    for (const key of STAGES) {
      const g = STAGE_GUIDE[key];
      for (const line of [g.label, g.definition, g.notThis]) {
        expect(line.trim(), key).toBe(line);
        expect(line.length, key).toBeGreaterThan(0);
        expect(line, key).not.toMatch(/[\r\n]/);
      }
      // a definition is one line an agent reads on a phone, not a paragraph
      expect(g.definition.length, key).toBeLessThanOrEqual(120);
      expect(g.notThis.length, key).toBeLessThanOrEqual(120);
    }
  });

  it('R-STG-1 the default labels say what is true of the person, and each fits the 24 characters a tenant label may have', () => {
    expect(STAGES.map((k) => STAGE_GUIDE[k].label)).toEqual(['New lead', 'Trying to reach', 'Connected', 'Long-term follow-up', 'Active client', 'Under contract', 'Closed sale', 'Not moving forward']);
    for (const key of STAGES) {
      expect(STAGE_GUIDE[key].label.length, key).toBeLessThanOrEqual(24);
      // a default label is itself a label a tenant could save
      expect(validateStageLabels({ [key]: STAGE_GUIDE[key].label }), key).toEqual({ ok: true, labels: { [key]: STAGE_GUIDE[key].label } });
      // the labels core exports are the guide's (one source)
      expect(DEFAULT_STAGE_LABELS[key]).toBe(STAGE_GUIDE[key].label);
      expect(stageLabel(key)).toBe(STAGE_GUIDE[key].label);
    }
  });

  it('R-STG-1 the definitions draw the lines agents get wrong: a try is not a conversation, a conversation is not a client', () => {
    expect(STAGE_GUIDE.attempting.definition).toBe('We tried to reach them but have not had a two-way conversation yet.');
    expect(STAGE_GUIDE.connected.definition).toBe('We have talked, but we are not actively working together yet.');
    expect(STAGE_GUIDE.active.definition).toBe('We are working together now.');
    expect(STAGE_GUIDE.attempting.notThis).toMatch(/voicemail/i);
    expect(STAGE_GUIDE.active.notThis).toMatch(/reply/i);
    // "not moving forward" is not an opt-out: do-not-contact is recorded separately
    expect(STAGE_GUIDE.lost.notThis).toMatch(/do not contact/i);
  });

  it('R-STG-1 a tenant label override wins for the label only: the definition and "does not mean" stay the guide\'s', () => {
    const g = stageGuide({ nurture: 'Long term', lost: 'Archived' });
    expect(g.map((s) => s.key)).toEqual([...STAGES]);
    expect(g.find((s) => s.key === 'nurture')).toEqual({ key: 'nurture', label: 'Long term', definition: STAGE_GUIDE.nurture.definition, notThis: STAGE_GUIDE.nurture.notThis });
    expect(g.find((s) => s.key === 'lost')!.label).toBe('Archived');
    expect(g.find((s) => s.key === 'active')!.label).toBe('Active client');
    expect(stageGuide().map((s) => s.label)).toEqual(STAGES.map((k) => STAGE_GUIDE[k].label));
  });
});
