// The policy state machine: edge cases E112–E117, E119, E150 (core halves) and the bounds
// (R-VOICE-2, R-VOICE-5, R-VOICE-6, R-VOICE-7, R-VOICE-10, R-FH-3). Module 48 owns the wiring:
// sending a confirmation through dispatchOutbound (E112, R-GATE-14), storing the handback with its
// transcript evidence and the 10-minute P1 alert (R-VOICE-7), and the vendor events (R-VOICE-10).
import { describe, expect, it } from 'vitest';
import type { Instant } from '../foundation/index.js';
import { type StepResult, type VoiceAction, type VoiceEvent, type VoiceFacts, type VoiceHandback, type VoiceState, VOICE_LINES, outcomeOf, shouldAnswer, startSession, step } from './index.js';
import {
  CONTENT,
  H_EMAIL,
  H_PHONE,
  H_PHONE_2,
  H_REMOVED,
  HOT_CLAIMS,
  OWNER_ID,
  ROUTING_HOURS,
  SESSION_START,
  SLOT_A,
  SLOT_3AM,
  SLOT_ARGS,
  SLOT_B,
  callFacts,
  claim,
  contact,
  openSession,
  reach,
  revokedRow,
  voiceFacts,
  voiceSettings,
} from './testing/index.js';

const T = (ms: number) => (SESSION_START + ms) as Instant;

interface Run {
  state: VoiceState;
  actions: VoiceAction[];
}

/** Applies events to a state; collects every action. */
function run(state: VoiceState, facts: VoiceFacts, events: VoiceEvent[]): Run {
  let s = state;
  const actions: VoiceAction[] = [];
  for (const e of events) {
    const r: StepResult = step(s, e, facts);
    s = r.state;
    actions.push(...r.actions);
  }
  return { state: s, actions };
}
const lines = (r: Run) => r.actions.flatMap((a) => (a.kind === 'say' ? [a.line ?? a.source] : []));
const handbackOf = (r: Run): VoiceHandback => {
  const ends = r.actions.filter((a): a is Extract<VoiceAction, { kind: 'end' }> => a.kind === 'end');
  expect(ends).toHaveLength(1);
  return (ends[0] as Extract<VoiceAction, { kind: 'end' }>).handback;
};
const caller = (ms: number, text: string, language: string | null = 'en'): VoiceEvent => ({ type: 'caller_turn', at: T(ms), text, language });
const tool = (ms: number, name: string, args: unknown = {}): VoiceEvent => ({ type: 'tool_request', at: T(ms), request: { tool: name, args, at: T(ms) } });
const transferTo = (ms: number): VoiceEvent => tool(ms, 'warm_transfer', { target_user_id: OWNER_ID });

describe('E116 R-VOICE-2 disclosure and recording announcement before any processing', () => {
  it('R-VOICE-2 E116 the disclosure is said first, then the announcement, then the model is asked', () => {
    const f = voiceFacts();
    const start = startSession(f, SESSION_START);
    expect(start.actions).toEqual([{ kind: 'say', source: 'disclosure', line: null, text: CONTENT.disclosure }]);
    const r = run(start.state, f, [{ type: 'disclosure_played', at: T(4000) }, { type: 'announcement_played', at: T(7000) }]);
    expect(r.actions).toEqual([{ kind: 'say', source: 'announcement', line: null, text: CONTENT.recordingAnnouncement }, { kind: 'await_model' }]);
    expect(r.state).toMatchObject({ phase: 'conversing', disclosedAt: T(4000), announcedAt: T(7000) });
  });

  it('R-VOICE-2 E116 an AI call always announces, even where decideRecording would allow one-party recording without one', () => {
    // core/voice takes no recording decision as input: the announcement is unconditional
    const f = voiceFacts();
    const r = run(startSession(f, SESSION_START).state, f, [{ type: 'disclosure_played', at: T(4000) }]);
    expect(r.actions[0]).toMatchObject({ kind: 'say', source: 'announcement' });
  });

  it('R-VOICE-2 E116 no caller speech is processed until both have played (not even an opt-out or a model turn)', () => {
    const f = voiceFacts();
    const s0 = startSession(f, SESSION_START).state;
    for (const e of [caller(1000, 'STOP'), caller(1000, 'What would the seller take?'), { type: 'model_turn', at: T(1000), text: 'Hello!' } as VoiceEvent, { type: 'silence', at: T(1000) } as VoiceEvent]) {
      expect(step(s0, e, f)).toEqual({ state: s0, actions: [] });
    }
    const s1 = step(s0, { type: 'disclosure_played', at: T(4000) }, f).state;
    expect(step(s1, caller(5000, 'STOP'), f)).toEqual({ state: s1, actions: [] });
  });

  it.each([
    ['announcement_failed', 'ANNOUNCEMENT_FAILED'],
    ['announcement_declined', 'ANNOUNCEMENT_DECLINED'],
  ] as const)('R-VOICE-2 E116 a %s ⇒ fallback_voicemail, never answered', (type, reason) => {
    const f = voiceFacts();
    const r = run(startSession(f, SESSION_START).state, f, [{ type: 'disclosure_played', at: T(4000) }, { type, at: T(6000) }]);
    expect(r.actions.map((a) => a.kind)).toEqual(['say', 'voicemail', 'end']);
    expect(r.state).toMatchObject({ outcome: 'fallback_voicemail', endReason: reason, announcedAt: null });
    expect(handbackOf(r)).toMatchObject({ critical: true, outcome: 'fallback_voicemail' });
  });

  it('a failed disclosure ⇒ fallback_voicemail; failures out of phase change nothing', () => {
    const f = voiceFacts();
    const s0 = startSession(f, SESSION_START).state;
    expect(run(s0, f, [{ type: 'disclosure_failed', at: T(1000) }]).state).toMatchObject({ outcome: 'fallback_voicemail', endReason: 'DISCLOSURE_FAILED', disclosedAt: null });
    expect(step(s0, { type: 'announcement_failed', at: T(1000) }, f)).toEqual({ state: s0, actions: [] });
    expect(step(s0, { type: 'announcement_played', at: T(1000) }, f)).toEqual({ state: s0, actions: [] });
    const open = openSession(f);
    for (const type of ['disclosure_played', 'disclosure_failed', 'announcement_played', 'announcement_failed', 'announcement_declined'] as const) {
      expect(step(open, { type, at: T(9000) }, f)).toEqual({ state: open, actions: [] });
    }
  });

  it('R-VOICE-10 a disclosure that never reports played is bounded: voicemail after the playback timeout', () => {
    const f = voiceFacts({ playbackTimeoutSeconds: 30 });
    const s0 = startSession(f, SESSION_START).state;
    expect(step(s0, { type: 'tick', at: T(29_999) }, f)).toEqual({ state: s0, actions: [] });
    expect(run(s0, f, [{ type: 'tick', at: T(30_000) }]).state).toMatchObject({ outcome: 'fallback_voicemail', endReason: 'PLAYBACK_TIMEOUT' });
  });

  it('a hang-up before the disclosures ends the session as caller_ended with its one critical handback', () => {
    const f = voiceFacts();
    const r = run(startSession(f, SESSION_START).state, f, [{ type: 'hangup', at: T(2000) }]);
    expect(handbackOf(r)).toMatchObject({ outcome: 'caller_ended', endReason: 'CALLER_HUNG_UP', critical: true });
  });
});

describe('E112 an opted-out caller is answered; no phone callback; a confirmation only on an allowed channel', () => {
  const failedTransfer = (f: VoiceFacts) => run(openSession(f), f, [transferTo(10_000), { type: 'transfer_result', at: T(15_000), outcome: 'no_answer' }]);

  it('E112 the call is answered whatever the caller\'s opt-outs (shouldAnswer reads none)', () => {
    expect(shouldAnswer(callFacts(), voiceSettings(), ROUTING_HOURS, T(0))).not.toBeNull();
  });

  it.each([
    ['voice revoked on the calling phone', { reach: reach({ consent: [revokedRow('voice', H_PHONE)] }), personDoNotContact: false }],
    ['voice revoked on another of the person\'s phones', { reach: reach({ points: [...reach().points, { id: 'p2', kind: 'phone', addressHmac: H_PHONE_2, status: 'active', lineType: 'mobile' }], consent: [revokedRow('voice', H_PHONE_2)] }), personDoNotContact: false }],
    ['R-PAR-12 voice revoked on a removed phone that still counts', { reach: reach({ removedPhoneHmacs: [H_REMOVED], consent: [revokedRow('voice', H_REMOVED)] }), personDoNotContact: false }],
    ['the person is do-not-contact', { reach: reach(), personDoNotContact: true }],
    ['a voice suppression on a phone', { reach: reach({ suppressions: [{ id: 's1', addressHmac: H_PHONE, channel: 'voice', reason: 'internal_dnc', liftedAt: null }] }), personDoNotContact: false }],
    ['no phone on file', { reach: reach({ points: reach().points.filter((p) => p.kind !== 'phone') }), personDoNotContact: false }],
  ])('E112 R-VOICE-6 no phone callback is offered when %s', (_n, optOuts) => {
    const f = voiceFacts({ claims: HOT_CLAIMS, optOuts });
    const r = failedTransfer(f);
    expect(lines(r)).toContain('ownerUnavailableNoCallback');
    expect(lines(r)).not.toContain('ownerUnavailableCallback');
    const h = handbackOf(run(r.state, f, [{ type: 'hangup', at: T(20_000) }]));
    expect(h.noPhoneCallback).toBe(true);
  });

  it('E112 a phone callback is offered when nothing blocks voice on the person\'s phones', () => {
    const f = voiceFacts({ claims: HOT_CLAIMS });
    expect(lines(failedTransfer(f))).toContain('ownerUnavailableCallback');
  });

  it.each([
    ['nothing blocks texts', reach(), false, 'bookedConfirmSms', 'sms'],
    ['texts revoked: by email', reach({ consent: [revokedRow('sms', H_PHONE)] }), false, 'bookedConfirmEmail', 'email'],
    ['texts and email revoked: none', reach({ consent: [revokedRow('sms', H_PHONE), revokedRow('email', H_EMAIL)] }), false, 'bookedNoConfirmation', null],
    ['do-not-contact: none', reach(), true, 'bookedNoConfirmation', null],
  ] as const)('E112 a booking confirmation is promised only on an allowed channel (%s)', (_n, r0, dnc, line, channel) => {
    const f = voiceFacts({ optOuts: { reach: r0, personDoNotContact: dnc } });
    const r = run(openSession(f), f, [tool(10_000, 'book_appointment', SLOT_ARGS(SLOT_A)), { type: 'booking_result', at: T(11_000), ok: true }, { type: 'hangup', at: T(12_000) }]);
    expect(lines(r)).toContain(line);
    expect(handbackOf(r)).toMatchObject({ outcome: 'booked', booked: SLOT_A, confirmationChannel: channel });
  });

  it('E112 an opt-out heard in this call withdraws every callback and confirmation promise', () => {
    const f = voiceFacts();
    const r = run(openSession(f), f, [caller(10_000, 'please stop calling me'), { type: 'hangup', at: T(12_000) }]);
    expect(handbackOf(r)).toMatchObject({ outcome: 'opted_out', noPhoneCallback: true, confirmationChannel: null });
  });
});

describe('opt-outs heard in the call (R-CONSENT-8, D1, D-OPTOUT-LANG)', () => {
  it('a keyword then opt-out language: the person-level one is kept; never downgraded', () => {
    const f = voiceFacts();
    const a = run(openSession(f), f, [caller(10_000, 'STOP'), caller(12_000, 'take me off your list')]);
    expect(a.state.optOut).toMatchObject({ scope: 'person', channel: 'all' });
    expect(a.actions.filter((x) => x.kind === 'apply_inbound')).toHaveLength(2);
    const b = run(openSession(f), f, [caller(10_000, 'take me off your list'), caller(12_000, 'STOP')]);
    expect(b.state.optOut).toMatchObject({ scope: 'person', channel: 'all' });
  });

  it('a wrong-number or HELP utterance on a live inbound call is not an opt-out (it goes to the model)', () => {
    const f = voiceFacts();
    for (const t of ['Sorry, do I have the wrong number?', 'HELP']) {
      const r = run(openSession(f), f, [caller(10_000, t)]);
      expect(r.actions).toEqual([{ kind: 'await_model' }]);
      expect(r.state.optOut).toBeNull();
    }
  });

  it('silence after an opt-out ends the call as opted_out, with no re-prompt', () => {
    const f = voiceFacts();
    const r = run(openSession(f), f, [caller(10_000, 'STOP'), { type: 'silence', at: T(20_000) }]);
    expect(lines(r)).toEqual(['optOutAck']);
    expect(r.state).toMatchObject({ outcome: 'opted_out', endReason: 'SILENCE' });
  });
});

describe('caller-turn scope (R-VOICE-5, R-FH-3, R-VOICE-8)', () => {
  it('R-VOICE-5 E114 legal and lending questions: the decline line, a message and their categories', () => {
    const f = voiceFacts();
    const r = run(openSession(f), f, [caller(10_000, 'Do I need a lawyer?'), caller(12_000, 'What mortgage rate can I get?'), { type: 'hangup', at: T(14_000) }]);
    expect(lines(r)).toEqual(['decline', 'decline']);
    expect(handbackOf(r)).toMatchObject({ outcome: 'message_taken', categories: ['legal', 'lending'], messageTopics: ['LEGAL', 'LENDING'] });
  });

  it('R-FH-3 an area question: AREA_QUESTION_CLIENT_REPLY, and the handback carries its neutral agent note', () => {
    const f = voiceFacts();
    const r = run(openSession(f), f, [caller(10_000, 'Is it a safe neighborhood?'), caller(12_000, 'Is it a safe neighborhood?'), { type: 'hangup', at: T(14_000) }]);
    expect(lines(r)).toEqual(['areaQuestion', 'areaQuestion']);
    expect(r.actions.find((a) => a.kind === 'say')).toMatchObject({ text: VOICE_LINES.areaQuestion });
    const h = handbackOf(r);
    expect(h).toMatchObject({ outcome: 'message_taken', categories: ['fair_housing'], messageTopics: ['AREA_QUESTION'] });
    expect(h.agentNotes).toHaveLength(1);
    expect(h.agentNotes[0]).toMatch(/^Fair housing: they asked about how safe the area is/);
  });

  it('R-VOICE-8 E113 the truthful answer, then the conversation goes on', () => {
    const f = voiceFacts();
    const r = run(openSession(f), f, [caller(10_000, 'Is this a real person?'), caller(12_000, 'OK, can I see the house Saturday?')]);
    expect(r.actions).toEqual([{ kind: 'say', source: 'script', line: 'truthfulAnswer', text: VOICE_LINES.truthfulAnswer }, { kind: 'await_model' }]);
  });

  it('E119 a language the content does not cover: says so, then voicemail; the handback says why', () => {
    const f = voiceFacts({ coveredLanguages: ['en'] });
    const r = run(openSession(f), f, [caller(10_000, 'Hola, quiero ver la casa.', 'es-MX')]);
    expect(lines(r)).toEqual(['uncoveredLanguage']);
    expect(r.actions.map((a) => a.kind)).toEqual(['say', 'voicemail', 'end']);
    expect(handbackOf(r)).toMatchObject({ outcome: 'fallback_voicemail', endReason: 'UNCOVERED_LANGUAGE', categories: ['language'], messageTopics: ['LANGUAGE'] });
  });

  it('E119 a covered language, or none reported by the STT, goes on normally', () => {
    const f = voiceFacts({ coveredLanguages: ['en', 'es'] });
    expect(run(openSession(f), f, [caller(10_000, 'Hola, quiero ver la casa.', 'es-MX')]).actions).toEqual([{ kind: 'await_model' }]);
    expect(run(openSession(f), f, [caller(10_000, 'Hello', null)]).actions).toEqual([{ kind: 'await_model' }]);
  });
});

describe('model turns (R-VOICE-8, R-VOICE-10)', () => {
  it('R-VOICE-8 a turn that fails voiceTurnGuard is never spoken; the replacement line is', () => {
    const f = voiceFacts();
    const r = run(openSession(f), f, [{ type: 'model_turn', at: T(8000), text: "I'm a real person, promise." }]);
    expect(r.actions).toEqual([{ kind: 'say', source: 'script', line: 'replacement', text: VOICE_LINES.replacement }]);
  });

  it('R-VOICE-10 E117 a turn slower than max_turn_latency_ms ⇒ voicemail (reported latency, or a late arrival)', () => {
    const f = voiceFacts({ maxTurnLatencyMs: 1500 });
    expect(run(openSession(f), f, [{ type: 'model_turn', at: T(8000), text: 'Hi!', latencyMs: 1501 }]).state).toMatchObject({ outcome: 'fallback_voicemail', endReason: 'TURN_LATENCY' });
    expect(run(openSession(f), f, [{ type: 'model_turn', at: T(8000), text: 'Hi!', latencyMs: 1500 }]).state.phase).toBe('conversing');
    // waiting for the model since the announcement played at +7 s
    expect(run(openSession(f), f, [{ type: 'model_turn', at: T(8501), text: 'Hi!' }]).state).toMatchObject({ endReason: 'TURN_LATENCY' });
    expect(run(openSession(f), f, [{ type: 'model_turn', at: T(8500), text: 'Hi!' }]).state.phase).toBe('conversing');
  });

  it('R-VOICE-10 E117 a turn_latency event above the pack threshold ⇒ voicemail; at or below it nothing happens', () => {
    const f = voiceFacts({ maxTurnLatencyMs: 1500 });
    const s = openSession(f);
    expect(step(s, { type: 'turn_latency', at: T(8000), ms: 1500 }, f)).toEqual({ state: s, actions: [] });
    const r = run(s, f, [{ type: 'turn_latency', at: T(8000), ms: 2400 }]);
    expect(r.actions.map((a) => a.kind)).toEqual(['voicemail', 'end']);
  });

  it('R-VOICE-10 E117 a vendor error ⇒ voicemail, in any phase before the end', () => {
    const f = voiceFacts({ claims: HOT_CLAIMS });
    for (const s of [startSession(f, SESSION_START).state, openSession(f), run(openSession(f), f, [transferTo(10_000)]).state]) {
      const r = run(s, f, [{ type: 'vendor_error', at: T(12_000) }]);
      expect(r.state).toMatchObject({ outcome: 'fallback_voicemail', endReason: 'VENDOR_ERROR' });
      expect(handbackOf(r).critical).toBe(true);
    }
  });

  it('R-VOICE-10 the model never answering is bounded by a tick: voicemail, never silence', () => {
    const f = voiceFacts();
    const s = openSession(f);
    expect(step(s, { type: 'tick', at: T(8500) }, f)).toEqual({ state: s, actions: [] });
    expect(run(s, f, [{ type: 'tick', at: T(8501) }]).state).toMatchObject({ endReason: 'TURN_LATENCY' });
  });
});

describe('transfers (R-VOICE-6, R-VOICE-7; E115)', () => {
  const f = voiceFacts({ claims: HOT_CLAIMS });

  it('R-VOICE-6 E115 the hold ends at exactly holdSeconds: no answer ⇒ back to the caller', () => {
    const s = run(openSession(f), f, [transferTo(10_000)]).state;
    expect(s).toMatchObject({ phase: 'transferring', transfer: { userId: OWNER_ID, holdEndsAt: T(30_000), outcome: null } });
    expect(step(s, { type: 'tick', at: T(29_999) }, f)).toEqual({ state: s, actions: [] });
    const r = run(s, f, [{ type: 'tick', at: T(30_000) }]);
    expect(r.state).toMatchObject({ phase: 'conversing', transfer: { outcome: 'no_answer' } });
    expect(lines(r)).toEqual(['ownerUnavailableCallback']);
  });

  it('R-VOICE-6 E115 declined ⇒ back to the caller; a booking then gives a booked outcome with the critical handback', () => {
    const r = run(openSession(f), f, [
      transferTo(10_000),
      { type: 'transfer_result', at: T(14_000), outcome: 'declined' },
      tool(16_000, 'book_appointment', SLOT_ARGS(SLOT_B)),
      { type: 'booking_result', at: T(17_000), ok: true },
      { type: 'hangup', at: T(20_000) },
    ]);
    expect(handbackOf(r)).toMatchObject({ outcome: 'booked', transferOutcome: 'declined', critical: true, booked: SLOT_B });
  });

  it('R-AST-5 E115 the promise task has a due time only from a usable dated claim', () => {
    const due = { at: T(86_400_000), allDay: false, zone: 'America/New_York', phrase: 'tomorrow at 2', saidAt: T(9000), display: 'Wed Nov 11, 2 PM' };
    const usable = claim(7, { kind: 'commitment', structured: { due: due as never } });
    const flagged = claim(8, { kind: 'commitment', structured: { due: due as never }, needsReview: true, reviewReasons: ['DATE_AMBIGUOUS'] });
    const done = (claims: VoiceFacts['claims']) => {
      const g = voiceFacts({ claims: [...HOT_CLAIMS, ...claims] });
      return handbackOf(run(openSession(g), g, [transferTo(10_000), { type: 'transfer_result', at: T(15_000), outcome: 'no_answer' }, { type: 'hangup', at: T(20_000) }])).promiseTask;
    };
    expect(done([usable])).toEqual({ kind: 'promise', claimId: usable.id, dueAt: due.at, dueAllDay: false, dueTz: 'America/New_York', needsReview: false });
    // a needs-review dated claim gives no due time: the task has none rather than a guessed one
    expect(done([flagged])).toEqual({ kind: 'promise', claimId: null, dueAt: null, dueAllDay: false, dueTz: null, needsReview: false });
  });

  it('a live transfer is the only non-critical handback; while transferring caller speech, model turns and silence wait', () => {
    const s = run(openSession(f), f, [transferTo(10_000)]).state;
    for (const e of [caller(12_000, 'STOP'), { type: 'model_turn', at: T(12_000), text: 'Hi' } as VoiceEvent, { type: 'silence', at: T(12_000) } as VoiceEvent]) expect(step(s, e, f)).toEqual({ state: s, actions: [] });
    expect(step(openSession(f), { type: 'transfer_result', at: T(12_000), outcome: 'connected' }, f).actions).toEqual([]);
    expect(handbackOf(run(s, f, [{ type: 'transfer_result', at: T(15_000), outcome: 'connected' }]))).toMatchObject({ outcome: 'transferred', critical: false, to: { kind: 'owner', userId: OWNER_ID } });
  });

  it('R-VOICE-6 an unowned caller\'s handback goes to the intake offer', () => {
    const g = voiceFacts({ contact: contact({ owner: null, contactId: null }) });
    expect(handbackOf(run(openSession(g), g, [{ type: 'hangup', at: T(9000) }])).to).toEqual({ kind: 'intake_offer' });
    const after = voiceFacts({ contact: contact({ owner: { userId: OWNER_ID, role: 'agent', status: 'active', acceptingLeads: false } }) });
    expect(handbackOf(run(openSession(after), after, [{ type: 'hangup', at: T(9000) }])).to).toEqual({ kind: 'owner', userId: OWNER_ID });
  });
});

describe('bookings (R-VOICE-7; E151 core half: a taken slot is never offered again)', () => {
  const f = voiceFacts();

  it('a failed booking (the slot was just taken, E151) says so, asks the model again, and never offers or books that slot again', () => {
    const r = run(openSession(f), f, [tool(10_000, 'book_appointment', SLOT_ARGS(SLOT_A)), { type: 'booking_result', at: T(11_000), ok: false }, tool(12_000, 'check_availability'), tool(12_500, 'book_appointment', SLOT_ARGS(SLOT_A))]);
    expect(lines(r)).toEqual(['bookingFailed']);
    expect(r.actions).toContainEqual({ kind: 'offer_slots', slots: [SLOT_B] });
    expect(r.state.ledger.map((e) => e.reason)).toEqual(['ALLOW_OFFERED_SLOT', 'ALLOW_AVAILABILITY', 'SLOT_NOT_OFFERED']);
  });

  it('R-VOICE-7 a booking result that never comes is bounded: the caller hears it is unconfirmed; a late success still books', () => {
    const g = voiceFacts({ playbackTimeoutSeconds: 10 });
    const s = run(openSession(g), g, [tool(10_000, 'book_appointment', SLOT_ARGS(SLOT_A))]).state;
    expect(step(s, { type: 'tick', at: T(19_999) }, g).actions).toEqual([]);
    const r = run(s, g, [{ type: 'tick', at: T(20_000) }]);
    expect(lines(r)).toEqual(['bookingUnconfirmed']);
    expect(handbackOf(run(r.state, g, [{ type: 'hangup', at: T(21_000) }])).needsReview).toEqual([{ code: 'UNCONFIRMED_SLOT', slot: SLOT_A }]);
    expect(run(r.state, g, [{ type: 'booking_result', at: T(21_000), ok: true }]).state.booking?.status).toBe('booked');
  });

  it('R-VOICE-7 the handback lists every unverified detail once: an unconfirmed slot, each unoffered slot, one possible opt-out', () => {
    const r = run(openSession(f), f, [
      tool(9000, 'record_opt_out'),
      tool(9100, 'book_appointment', SLOT_ARGS(SLOT_3AM)),
      tool(9200, 'record_opt_out'),
      tool(9300, 'book_appointment', SLOT_ARGS(SLOT_A)),
      { type: 'hangup', at: T(9400) },
    ]);
    expect(handbackOf(r).needsReview).toEqual([{ code: 'UNCONFIRMED_SLOT', slot: SLOT_A }, { code: 'POSSIBLE_OPT_OUT' }, { code: 'SLOT_NOT_OFFERED', slot: SLOT_3AM }]);
  });

  it('a booking result with no booking pending changes nothing', () => {
    const s = openSession(f);
    expect(step(s, { type: 'booking_result', at: T(9000), ok: true }, f)).toEqual({ state: s, actions: [] });
  });

  it('R-VOICE-7 in-call claims that need review go to the handback, never into an appointment', () => {
    const r = run(openSession(f), f, [{ type: 'claims', at: T(9000), claims: [claim(9, { kind: 'date_time', needsReview: true, reviewReasons: ['DATE_UNRESOLVED'] })] }, { type: 'hangup', at: T(10_000) }]);
    expect(handbackOf(r).needsReview).toEqual([{ code: 'CLAIM_NEEDS_REVIEW', claimId: claim(9).id }]);
    expect(r.actions.some((a) => a.kind === 'book')).toBe(false);
  });
});

describe('bounds and the end (R-VOICE-7, R-VOICE-10)', () => {
  it('maxCallSeconds ends the session with the wrap-up line', () => {
    const f = voiceFacts({ content: { ...CONTENT, maxCallSeconds: 60 } });
    const s = run(openSession(f), f, [caller(10_000, 'Can I see it Saturday?'), { type: 'model_turn', at: T(10_500), text: 'Sure.' }]).state;
    const r = run(s, f, [{ type: 'tick', at: T(60_000) }]);
    expect(lines(r)).toEqual(['wrapUp']);
    expect(r.state).toMatchObject({ outcome: 'caller_ended', endReason: 'MAX_CALL_SECONDS' });
  });

  it('silence without a silence event is bounded by silenceSeconds; after the last re-prompt a booked caller is not sent to voicemail', () => {
    const f = voiceFacts({ silenceSeconds: 5, maxSilenceReprompts: 1 });
    const s = run(openSession(f), f, [tool(8000, 'book_appointment', SLOT_ARGS(SLOT_A)), { type: 'booking_result', at: T(8200), ok: true }]).state;
    expect(step(s, { type: 'tick', at: T(13_199) }, f).actions).toEqual([]);
    const r = run(s, f, [{ type: 'tick', at: T(13_200) }, { type: 'tick', at: T(18_200) }]);
    expect(lines(r)).toEqual(['reprompt', 'silenceGoodbye']);
    expect(r.state).toMatchObject({ outcome: 'booked', endReason: 'SILENCE' });
    expect(r.actions.some((a) => a.kind === 'voicemail')).toBe(false);
  });

  it('a caller turn resets the re-prompt count', () => {
    const f = voiceFacts();
    const r = run(openSession(f), f, [{ type: 'silence', at: T(16_000) }, caller(17_000, 'Sorry, yes, Saturday?')]);
    expect(r.state.reprompts).toBe(0);
  });

  it('the model ending a call with nothing done ⇒ caller_ended; outcome precedence: transfer, booking, opt-out, message', () => {
    const f = voiceFacts();
    expect(run(openSession(f), f, [tool(9000, 'end_call')]).state).toMatchObject({ outcome: 'caller_ended', endReason: 'MODEL_ENDED_CALL' });
    const base = openSession(f);
    const opted = { ...base, optOut: { kind: 'stop' as const, scope: 'channel' as const, channel: 'voice' as const, classification: { kind: 'stop' as const, needsReview: false } } };
    expect(outcomeOf({ ...opted, messageTaken: true })).toBe('opted_out');
    expect(outcomeOf({ ...opted, booking: { slot: SLOT_A, kind: 'consult', status: 'booked' } })).toBe('booked');
    expect(outcomeOf({ ...base, booking: { slot: SLOT_A, kind: 'consult', status: 'pending' }, messageTaken: true })).toBe('message_taken');
    expect(outcomeOf({ ...base, transfer: { userId: OWNER_ID, holdEndsAt: T(0), outcome: 'connected' }, booking: { slot: SLOT_A, kind: 'consult', status: 'booked' } })).toBe('transferred');
  });

  it('a take_message without a topic records GENERAL; claims events replace the in-call claims', () => {
    const f = voiceFacts();
    const r = run(openSession(f), f, [tool(9000, 'take_message'), { type: 'claims', at: T(9500), claims: [claim(1)] }, { type: 'claims', at: T(9600), claims: [claim(2)] }]);
    expect(r.state).toMatchObject({ messageTaken: true, messageTopics: ['GENERAL'] });
    expect(r.state.claims.map((c) => c.id)).toEqual([claim(2).id]);
  });

  it('E150 voice turned off or the playbook revoked mid-session changes nothing: the session finishes with its one handback', () => {
    const f = voiceFacts();
    const s = run(openSession(f), f, [caller(10_000, 'Can I see it Saturday?')]).state;
    expect(step(s, { type: 'enablement_changed', at: T(10_100) }, f)).toEqual({ state: s, actions: [] });
    const r = run(s, f, [{ type: 'enablement_changed', at: T(10_100) }, { type: 'model_turn', at: T(10_500), text: 'Sure, let me check.' }, tool(11_000, 'take_message', { topic: 'SHOWING' }), { type: 'hangup', at: T(15_000) }]);
    expect(handbackOf(r)).toMatchObject({ outcome: 'message_taken', critical: true });
    // a new call after the switch is refused (and the DB refuses it too: rls_smoke_p23)
    expect(shouldAnswer(callFacts(), voiceSettings({ answeringEnabled: false }), ROUTING_HOURS, T(16_000))).toBeNull();
  });

  it('events after the end change nothing; a late tool request is only logged as denied', () => {
    const f = voiceFacts({ claims: HOT_CLAIMS });
    const ended = run(openSession(f), f, [{ type: 'hangup', at: T(9000) }]).state;
    const events: VoiceEvent[] = [
      { type: 'disclosure_played', at: T(9500) },
      caller(9500, 'STOP'),
      { type: 'model_turn', at: T(9500), text: 'Hi' },
      { type: 'booking_result', at: T(9500), ok: true },
      { type: 'transfer_result', at: T(9500), outcome: 'connected' },
      { type: 'claims', at: T(9500), claims: [] },
      { type: 'vendor_error', at: T(9500) },
      { type: 'turn_latency', at: T(9500), ms: 99_999 },
      { type: 'silence', at: T(9500) },
      { type: 'hangup', at: T(9500) },
      { type: 'tick', at: T(999_999) },
      { type: 'enablement_changed', at: T(9500) },
    ];
    for (const e of events) expect(step(ended, e, f)).toEqual({ state: ended, actions: [] });
    const late = step(ended, transferTo(9500), f);
    expect(late.actions).toEqual([{ kind: 'ledger', entry: { seq: 1, at: T(9500), decision: 'deny', reason: 'VOICE_SESSION_ENDED', row: { tool: 'warm_transfer', args: { target_user_id: OWNER_ID } } } }]);
    expect({ ...late.state, ledger: [] }).toEqual({ ...ended, ledger: [] });
  });
});
