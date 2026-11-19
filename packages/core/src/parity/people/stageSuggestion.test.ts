// The stage an outcome suggests (R-STG-2). A table test of every cell (eight current stages by every signal) and two
// properties: a suggestion never moves a person back, and never names nurture, under_contract, closed or lost.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { STAGES, type Stage } from './stage.js';
import { APPOINTMENT_RESULTS, CALL_SIGNAL_OUTCOMES, type StageSignal, activitySignal, suggestStageFromOutcome } from './stageSuggestion.js';

const call = (outcome: (typeof CALL_SIGNAL_OUTCOMES)[number]): StageSignal => ({ kind: 'call', outcome });
const sent = (channel: 'text' | 'email'): StageSignal => ({ kind: 'message', channel, direction: 'outbound' });
const reply = (channel: 'text' | 'email'): StageSignal => ({ kind: 'message', channel, direction: 'inbound' });
const appt = (result: (typeof APPOINTMENT_RESULTS)[number]): StageSignal => ({ kind: 'appointment', result });

const ALL_SIGNALS: { name: string; signal: StageSignal }[] = [
  ...CALL_SIGNAL_OUTCOMES.map((o) => ({ name: `call ${o}`, signal: call(o) })),
  { name: 'text sent', signal: sent('text') },
  { name: 'email sent', signal: sent('email') },
  { name: 'text reply', signal: reply('text') },
  { name: 'email reply', signal: reply('email') },
  ...APPOINTMENT_RESULTS.map((r) => ({ name: `appointment ${r}`, signal: appt(r) })),
];

/** The table of the brief, written out as data: signal → the stage it suggests and the stages it suggests it from. */
const TABLE: Record<string, { to: Stage; from: Stage[] } | null> = {
  'call left_voicemail': { to: 'attempting', from: ['new'] },
  'call no_answer': { to: 'attempting', from: ['new'] },
  'call other': { to: 'attempting', from: ['new'] },
  'text sent': { to: 'attempting', from: ['new'] },
  'email sent': { to: 'attempting', from: ['new'] },
  'call connected': { to: 'connected', from: ['new', 'attempting'] },
  'call callback_requested': { to: 'connected', from: ['new', 'attempting'] },
  'text reply': { to: 'connected', from: ['new', 'attempting'] },
  'email reply': { to: 'connected', from: ['new', 'attempting'] },
  'call wrong_number': null,
  'call bad_number': null,
  'call do_not_call_request': null,
  'appointment agreement_signed': { to: 'active', from: ['new', 'attempting', 'connected', 'nurture'] },
  'appointment follow_up': null,
  'appointment not_a_fit': null,
  'appointment no_decision': null,
  'appointment no_show': null,
};

describe('core/parity-people: the stage an outcome suggests (R-STG-2)', () => {
  it('R-STG-2 the table names every signal there is (no signal is left to a default)', () => {
    expect(ALL_SIGNALS.map((s) => s.name).sort()).toEqual(Object.keys(TABLE).sort());
  });

  for (const { name, signal } of ALL_SIGNALS) {
    for (const current of STAGES) {
      const row = TABLE[name] ?? null;
      const want = row !== null && row.from.includes(current) ? row.to : null;
      it(`R-STG-2 ${name} while ${current}: ${want === null ? 'suggests nothing' : `suggests ${want}`}`, () => {
        const got = suggestStageFromOutcome({ current, signal });
        if (want === null) {
          expect(got).toBeNull();
          return;
        }
        expect(got).not.toBeNull();
        expect(got!.stage).toBe(want);
        // the reason is one plain sentence for the screen
        expect(got!.why).toMatch(/^[A-Z].*\.$/);
        expect(got!.why).not.toMatch(/[\r\n]/);
      });
    }
  }

  it('R-STG-2 E759 a voicemail is not a conversation: it suggests "attempting" from new and never "connected"', () => {
    expect(suggestStageFromOutcome({ current: 'new', signal: call('left_voicemail') })).toMatchObject({ stage: 'attempting' });
    for (const current of STAGES) expect(suggestStageFromOutcome({ current, signal: call('left_voicemail') })?.stage).not.toBe('connected');
    // a second voicemail to someone already "attempting" changes nothing
    expect(suggestStageFromOutcome({ current: 'attempting', signal: call('left_voicemail') })).toBeNull();
  });

  it('R-STG-2 E760 a reply does not make someone an active client: only a signed agreement suggests "active"', () => {
    for (const { name, signal } of ALL_SIGNALS) {
      for (const current of STAGES) {
        const got = suggestStageFromOutcome({ current, signal });
        if (got?.stage === 'active') expect(name).toBe('appointment agreement_signed');
      }
    }
    expect(suggestStageFromOutcome({ current: 'connected', signal: reply('text') })).toBeNull();
    expect(suggestStageFromOutcome({ current: 'connected', signal: call('connected') })).toBeNull();
  });

  it('R-STG-2 a two-way conversation (a connected call, the person\'s own reply) also offers "nurture" beside "connected"; nothing else offers anything more', () => {
    const twoWay = new Set(['call connected', 'text reply', 'email reply']);
    for (const { name, signal } of ALL_SIGNALS) {
      for (const current of STAGES) {
        const got = suggestStageFromOutcome({ current, signal });
        if (got === null) continue;
        // someone who talked but is months away: the screen offers "Long-term follow-up" next to "Connected"
        expect(got.alsoOffer, `${name} ${current}`).toEqual(twoWay.has(name) ? ['nurture'] : []);
        // the suggested stage itself is still never nurture
        expect(got.stage, `${name} ${current}`).not.toBe('nurture');
      }
    }
    expect(suggestStageFromOutcome({ current: 'new', signal: call('connected') })).toMatchObject({ stage: 'connected', alsoOffer: ['nurture'] });
    // a callback request reached them, but nobody has talked about their plans yet: nothing more is offered
    expect(suggestStageFromOutcome({ current: 'new', signal: call('callback_requested') })).toMatchObject({ stage: 'connected', alsoOffer: [] });
    // a try is not a conversation, and a signed agreement is not "months away"
    expect(suggestStageFromOutcome({ current: 'new', signal: call('left_voicemail') })).toMatchObject({ stage: 'attempting', alsoOffer: [] });
    expect(suggestStageFromOutcome({ current: 'connected', signal: appt('agreement_signed') })).toMatchObject({ stage: 'active', alsoOffer: [] });
  });

  it('L11 E789 a call logged with a BLANK outcome suggests nothing from any stage, however the blank is written; "other" (a real outcome the agent chose) is a try, as the table says', () => {
    for (const current of STAGES) {
      for (const blank of [null, undefined, '', '   ', 'OTHER', 'none']) {
        expect(suggestStageFromOutcome({ current, signal: { kind: 'call', outcome: blank } as never }), `${current} / ${String(blank)}`).toBeNull();
      }
      // the log sheet's own reading of what was logged: a call with no outcome is no signal at all
      expect(activitySignal({ kind: 'call', direction: 'outbound', outcome: null })).toBeNull();
      expect(activitySignal({ kind: 'call', direction: 'inbound', outcome: null })).toBeNull();
    }
    expect(suggestStageFromOutcome({ current: 'new', signal: { kind: 'call', outcome: 'other' } })).toMatchObject({ stage: 'attempting', why: 'You tried to call. There has been no two-way conversation yet.' });
    expect(suggestStageFromOutcome({ current: 'attempting', signal: { kind: 'call', outcome: 'other' } })).toBeNull();
  });

  it('L11 E789 a text or email THEY sent is worded as what it is: they wrote; it is never called an answer or a reply, because the log does not say we wrote first', () => {
    for (const channel of ['text', 'email'] as const) {
      const s = suggestStageFromOutcome({ current: 'new', signal: { kind: 'message', channel, direction: 'inbound' } })!;
      expect(s.stage).toBe('connected');
      expect(s.why).toBe(`They sent ${channel === 'email' ? 'an email' : 'a text'}, so you have heard from them directly.`);
      expect(s.why).not.toMatch(/answer|repl|two-way/i);
    }
    // what WE sent is still a try with no reply yet
    expect(suggestStageFromOutcome({ current: 'new', signal: { kind: 'message', channel: 'text', direction: 'outbound' } })!.why).toBe('You sent a text and they have not replied yet.');
  });

  it('R-STG-2 a wrong number, a bad number and a do-not-call request suggest nothing from any stage', () => {
    for (const o of ['wrong_number', 'bad_number', 'do_not_call_request'] as const) {
      for (const current of STAGES) expect(suggestStageFromOutcome({ current, signal: call(o) }), `${o} ${current}`).toBeNull();
    }
  });

  it('R-STG-2 an unknown current stage or an unknown outcome suggests nothing (total: never throws)', () => {
    expect(suggestStageFromOutcome({ current: 'parked' as never, signal: call('connected') })).toBeNull();
    expect(suggestStageFromOutcome({ current: 'new', signal: { kind: 'call', outcome: 'sang_a_song' as never } })).toBeNull();
    expect(suggestStageFromOutcome({ current: 'new', signal: { kind: 'appointment', result: 'maybe' as never } })).toBeNull();
    expect(suggestStageFromOutcome({ current: 'new', signal: { kind: 'fax' } as never })).toBeNull();
  });
});

const signalArb: fc.Arbitrary<StageSignal> = fc.oneof(
  fc.constantFrom(...CALL_SIGNAL_OUTCOMES).map(call),
  fc.record({ kind: fc.constant('message' as const), channel: fc.constantFrom('text' as const, 'email' as const), direction: fc.constantFrom('outbound' as const, 'inbound' as const) }),
  fc.constantFrom(...APPOINTMENT_RESULTS).map(appt),
  // junk a caller could pass: the function is total
  fc.record({ kind: fc.constantFrom('call', 'message', 'appointment', 'x'), outcome: fc.string(), result: fc.string(), channel: fc.string(), direction: fc.string() }) as unknown as fc.Arbitrary<StageSignal>,
);
const currentArb = fc.oneof(fc.constantFrom(...STAGES), fc.string() as unknown as fc.Arbitrary<Stage>);

describe('property: the stage an outcome suggests (R-STG-2)', () => {
  it('R-STG-2 never demotes: a suggested stage is always later than the current one', () => {
    fc.assert(
      fc.property(currentArb, signalArb, (current, signal) => {
        const got = suggestStageFromOutcome({ current, signal });
        if (got === null) return;
        expect(STAGES.indexOf(current)).toBeGreaterThanOrEqual(0);
        expect(STAGES.indexOf(got.stage)).toBeGreaterThan(STAGES.indexOf(current));
      }),
      { numRuns: 2000 },
    );
  });

  it('R-STG-2 never returns nurture, under_contract, closed or lost as the suggested stage', () => {
    fc.assert(
      fc.property(currentArb, signalArb, (current, signal) => {
        const got = suggestStageFromOutcome({ current, signal });
        if (got === null) return;
        expect(['attempting', 'connected', 'active']).toContain(got.stage);
        // what is offered beside it is "nurture" or nothing, only next to "connected", and never a step back either
        expect(got.alsoOffer.every((s) => s === 'nurture')).toBe(true);
        if (got.alsoOffer.length > 0) expect(got.stage).toBe('connected');
        for (const s of got.alsoOffer) expect(STAGES.indexOf(s)).toBeGreaterThan(STAGES.indexOf(current));
      }),
      { numRuns: 2000 },
    );
  });
});
