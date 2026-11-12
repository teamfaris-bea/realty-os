// The plan's scripted-caller suite (PHASE2_3_PLAN §5.4 #47), run against the core fake conversation.
// Each script asserts the Accept line: one terminal outcome from the calls.voice_outcome CHECK set,
// exactly one handback, no tool allowed before both the disclosure and the recording announcement,
// every allowed request's arguments in app.voice_tool_args_ok's shape, and no spoken turn that fails
// voiceTurnGuard. Module 48 replays the same scripts through its fake VoiceAgentProvider.
import { describe, expect, it } from 'vitest';
import { type VoiceAction, type VoiceHandback, VOICE_LINES, VOICE_OUTCOMES, voiceTurnGuard } from './index.js';
import { IDENTITY, OWNER_ID, SCRIPTS, SLOT_A, type ScriptRun, runScript, sessionViolations } from './testing/index.js';

const guardPasses = (t: string) => voiceTurnGuard(t, IDENTITY).pass;
const handback = (r: ScriptRun): VoiceHandback => (r.actions.find((a) => a.action.kind === 'end')?.action as Extract<VoiceAction, { kind: 'end' }>).handback;
const spoken = (r: ScriptRun) => r.actions.flatMap((a) => (a.action.kind === 'say' ? [a.action] : []));
const ledger = (r: ScriptRun) => r.actions.flatMap((a) => (a.action.kind === 'ledger' ? [a.action.entry] : []));

describe('scripted-caller suite: every session keeps the Accept invariants', () => {
  it.each(Object.entries(SCRIPTS))('R-VOICE-7 R-VOICE-4 R-VOICE-2 %s: one terminal outcome, one handback, tools only after both disclosures, args in the DB allowlist, every spoken turn passes the guard', (_name, script) => {
    const r = runScript(script);
    expect(sessionViolations(r, guardPasses)).toEqual([]);
    expect(VOICE_OUTCOMES).toContain(r.state.outcome);
    expect(r.actions.filter((a) => a.action.kind === 'end')).toHaveLength(1);
    // the disclosure is the first thing said, then the announcement
    expect(spoken(r).slice(0, 2).map((s) => s.source)).toEqual(['disclosure', 'announcement']);
  });
});

describe('scripted-caller suite: what each script decides', () => {
  it('booking: books an offered slot of the owner, confirms on an allowed channel, hands back (booked)', () => {
    const r = runScript(SCRIPTS.booking);
    expect(r.state.outcome).toBe('booked');
    expect(ledger(r)[0]).toMatchObject({ decision: 'deny', reason: 'VOICE_TOOL_BEFORE_DISCLOSURE' });
    expect(r.actions.map((a) => a.action)).toContainEqual({ kind: 'book', slot: SLOT_A, appointmentKind: 'buyer_consult' });
    expect(spoken(r).map((s) => s.line)).toContain('bookedConfirmSms');
    expect(handback(r)).toMatchObject({ outcome: 'booked', booked: SLOT_A, to: { kind: 'owner', userId: OWNER_ID }, critical: true, confirmationChannel: 'sms' });
  });

  it('R-VOICE-6 hot transfer to the owner: only the contact\'s owner, within the hold; a live transfer is the one non-critical handback', () => {
    const r = runScript(SCRIPTS.hotTransfer);
    expect(r.actions.map((a) => a.action)).toContainEqual({ kind: 'start_transfer', userId: OWNER_ID, holdSeconds: 20 });
    expect(handback(r)).toMatchObject({ outcome: 'transferred', transferOutcome: 'connected', critical: false, promiseTask: null });
  });

  it('R-VOICE-6 R-VOICE-7 E115 owner no-answer within the 20 s hold: back to the caller, a message, a critical handback and a promise task', () => {
    const r = runScript(SCRIPTS.ownerNoAnswer);
    expect(spoken(r).map((s) => s.line)).toContain('ownerUnavailableCallback');
    const h = handback(r);
    expect(h).toMatchObject({ outcome: 'message_taken', transferOutcome: 'no_answer', critical: true, messageTopics: ['CALLBACK'] });
    // no usable dated claim ⇒ the promise task has no due time (R-AST-5)
    expect(h.promiseTask).toEqual({ kind: 'promise', claimId: null, dueAt: null, dueAllDay: false, dueTz: null, needsReview: false });
  });

  it('R-VOICE-5 E114 price question: declined politely, the model\'s price answer is never spoken, a money handback with a message', () => {
    const r = runScript(SCRIPTS.priceQuestion);
    const lines = spoken(r);
    expect(lines.map((s) => s.line)).toEqual(expect.arrayContaining(['decline', 'replacement']));
    expect(lines.some((s) => s.text.includes('450k'))).toBe(false);
    expect(handback(r)).toMatchObject({ outcome: 'message_taken', categories: ['money'], messageTopics: ['PRICE'], critical: true });
  });

  it('R-VOICE-8 E113 "are you a robot": the scripted truthful answer; a model reply claiming to be human is replaced', () => {
    const r = runScript(SCRIPTS.robot);
    const lines = spoken(r);
    expect(lines.filter((s) => s.line === 'truthfulAnswer')).toHaveLength(2);
    expect(lines.filter((s) => s.line === 'replacement')).toHaveLength(2);
    expect(lines.some((s) => s.source === 'model' && /real person|pers/.test(s.text))).toBe(false);
    expect(VOICE_LINES.truthfulAnswer).toMatch(/automated assistant/);
  });

  it('R-CONSENT-8 a spoken STOP: the keyword is heard by classifyInbound on voice, applied by module 48, logged with channel voice; other tools are refused', () => {
    const r = runScript(SCRIPTS.spokenStop);
    expect(r.actions.map((a) => a.action)).toContainEqual({ kind: 'apply_inbound', channel: 'voice', classification: { kind: 'stop', matched: 'STOP', needsReview: false, scope: 'channel' } });
    const l = ledger(r);
    // the model asked for channel 'sms': the ledger records what core heard, never the model's argument
    expect(l[0]).toMatchObject({ decision: 'allow', reason: 'ALLOW_OPT_OUT_HEARD', row: { tool: 'record_opt_out', args: { channel: 'voice' } } });
    expect(l[1]).toMatchObject({ decision: 'deny', reason: 'VOICE_OPTED_OUT' });
    expect(handback(r)).toMatchObject({ outcome: 'opted_out', noPhoneCallback: true, confirmationChannel: null });
  });

  it.each([
    ['stopCalling', 'stop calling'],
    ['takeMeOff', 'take me off'],
  ] as const)('R-CONSENT-8 D-OPTOUT-LANG opt-out language (%s) is person-level, needs review, and is logged with channel all', (name, matched) => {
    const r = runScript(SCRIPTS[name]);
    expect(r.actions.map((a) => a.action)).toContainEqual({ kind: 'apply_inbound', channel: 'voice', classification: { kind: 'opt_out_language', matched, needsReview: true, scope: 'person' } });
    expect(ledger(r)[0]).toMatchObject({ decision: 'allow', row: { tool: 'record_opt_out', args: { channel: 'all' } } });
    expect(handback(r)).toMatchObject({ outcome: 'opted_out', noPhoneCallback: true, confirmationChannel: null });
  });

  it('R-CONSENT-8 "don\'t stop, I want to see it" is not an opt-out: the model\'s record_opt_out is denied and the handback flags a possible opt-out for review', () => {
    const r = runScript(SCRIPTS.dontStop);
    expect(r.actions.some((a) => a.action.kind === 'apply_inbound')).toBe(false);
    expect(ledger(r)[0]).toMatchObject({ decision: 'deny', reason: 'OPT_OUT_NOT_HEARD' });
    expect(handback(r)).toMatchObject({ optOut: null, needsReview: [{ code: 'POSSIBLE_OPT_OUT' }] });
  });

  it('R-VOICE-4 prompt injection: no phone number, other member, unknown tool, unoffered slot or extra key gets through; nothing after the hang-up', () => {
    const r = runScript(SCRIPTS.injection);
    expect(ledger(r).map((e) => `${e.decision}:${e.reason}`)).toEqual([
      'deny:VOICE_TOOL_ARGS_INVALID',
      'deny:TRANSFER_NOT_OWNER',
      'deny:VOICE_TOOL_UNKNOWN',
      'deny:SLOT_NOT_OFFERED',
      'deny:VOICE_TOOL_ARGS_INVALID',
      'deny:VOICE_SESSION_ENDED',
    ]);
    expect(r.actions.some((a) => a.action.kind === 'book' || a.action.kind === 'start_transfer')).toBe(false);
    expect(spoken(r).some((s) => s.source === 'model' && /Casey|450k/.test(s.text))).toBe(false);
    expect(handback(r).needsReview).toContainEqual(expect.objectContaining({ code: 'SLOT_NOT_OFFERED' }));
  });

  it('R-VOICE-10 silence: a bounded number of re-prompts, then voicemail', () => {
    const r = runScript(SCRIPTS.silence);
    expect(spoken(r).map((s) => s.line).filter((l) => l !== null)).toEqual(['reprompt', 'reprompt', 'silenceGoodbye']);
    expect(r.actions.map((a) => a.action.kind)).toContain('voicemail');
    expect(r.state.outcome).toBe('fallback_voicemail');
  });

  it('R-VOICE-7 hang-up mid-booking: no booking (the result came too late), the slot goes to the handback as needs review', () => {
    const r = runScript(SCRIPTS.hangupMidBooking);
    expect(r.state.outcome).toBe('caller_ended');
    expect(handback(r)).toMatchObject({ booked: null, needsReview: [{ code: 'UNCONFIRMED_SLOT' }] });
  });
});
