// R-TODAY-7: the follow-up a one-pass sheet preselects after an outcome, so that a logged outcome from Today has a
// next step without one more tap. It is only a preselection the agent sees and can change; nothing is created until
// the sheet's one button is tapped.
import { describe, expect, it } from 'vitest';
import { CALL_SIGNAL_OUTCOMES, type StageSignal, suggestedFollowUpDays } from './index.js';

describe('R-TODAY-7: suggestedFollowUpDays, the follow-up a one-pass sheet preselects', () => {
  const TABLE: [string, StageSignal | null, number | null][] = [
    ['left a voicemail: try again tomorrow', { kind: 'call', outcome: 'left_voicemail' }, 1],
    ['no answer: try again tomorrow', { kind: 'call', outcome: 'no_answer' }, 1],
    ['they asked for a call back: tomorrow', { kind: 'call', outcome: 'callback_requested' }, 1],
    ['talked: keep in touch in a week', { kind: 'call', outcome: 'connected' }, 7],
    ['a text we sent, no reply yet: in 3 days', { kind: 'message', channel: 'text', direction: 'outbound' }, 3],
    ['an email we sent, no reply yet: in 3 days', { kind: 'message', channel: 'email', direction: 'outbound' }, 3],
    ['their own reply: keep in touch in a week', { kind: 'message', channel: 'text', direction: 'inbound' }, 7],
    ['wrong number: nothing to follow up', { kind: 'call', outcome: 'wrong_number' }, null],
    ['number not working', { kind: 'call', outcome: 'bad_number' }, null],
    ['they asked not to be called: never a follow-up', { kind: 'call', outcome: 'do_not_call_request' }, null],
    ['"other": nobody can say', { kind: 'call', outcome: 'other' }, null],
    ['an appointment result', { kind: 'appointment', result: 'follow_up' }, null],
    ['no outcome yet', null, null],
  ];
  it.each(TABLE)('%s', (_n, signal, days) => {
    expect(suggestedFollowUpDays(signal)).toBe(days);
  });
  it('every call outcome has an answer, and it is one of the sheet’s own chips (1, 3 or 7 days) or none', () => {
    for (const outcome of CALL_SIGNAL_OUTCOMES) expect([1, 3, 7, null]).toContain(suggestedFollowUpDays({ kind: 'call', outcome }));
  });
  it('a signal it does not know suggests nothing', () => {
    expect(suggestedFollowUpDays({ kind: 'call', outcome: 'something_new' } as never)).toBeNull();
    expect(suggestedFollowUpDays({ kind: 'visit' } as never)).toBeNull();
  });
});
