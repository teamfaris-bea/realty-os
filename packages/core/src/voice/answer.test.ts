// shouldAnswer (R-VOICE-1, R-VOICE-3, R-VOICE-9, R-INT-6, R-GATE-9 core side; E112, E150).
// The DB halves (calls_assistant_inbound_only, app.calls_voice_guard, the compliance policy guard) stay
// proven by packages/db/test/rls_smoke_p23.sql; this file proves core refuses whenever the facts say so.
// R-VOICE-3's storing of calls.ai_takeover_at is module 48's (the decision below is what it stores).
import { describe, expect, it } from 'vitest';
import { type Instant, at, businessCalendar, plusSeconds } from '../foundation/index.js';
import { approvedVoiceContent, platformVoiceCleared, shouldAnswer, voiceAnsweringOn } from './index.js';
import { AFTER_HOURS, CONTENT, IDENTITY, IN_HOURS, ROUTING_HOURS, STORED_CONTENT, VERSION_ID, callFacts, voiceSettings } from './testing/index.js';

describe('shouldAnswer: the enabling facts', () => {
  it('R-VOICE-1 R-VOICE-9 R-INT-6 answers an inbound client call under an approved, valid voice_answering version, the Owner\'s attested setting and a cleared platform:voice', () => {
    expect(shouldAnswer(callFacts(), voiceSettings(), ROUTING_HOURS, IN_HOURS)).toEqual({ takeoverAt: plusSeconds(IN_HOURS, 20) });
  });

  it.each([
    ['outbound', { direction: 'outbound' as const, initiator: 'human' as const }],
    ['AI-originated', { direction: 'outbound' as const, initiator: 'assistant' as const }],
    ['inbound but not client-initiated (import)', { initiator: 'import' as const }],
    ['inbound system call', { initiator: 'system' as const }],
  ])('R-GATE-9 R-VOICE-1 never answers a call that is not inbound and client-initiated (%s)', (_n, o) => {
    expect(shouldAnswer(callFacts(o), voiceSettings(), ROUTING_HOURS, AFTER_HOURS)).toBeNull();
  });

  it.each([
    ['no voice playbook', { playbook: null }],
    ['a draft version', { playbook: { versionId: VERSION_ID, kind: 'voice_answering', status: 'draft' as const, content: STORED_CONTENT } }],
    ['a revoked version', { playbook: { versionId: VERSION_ID, kind: 'voice_answering', status: 'revoked' as const, content: STORED_CONTENT } }],
    ['a superseded version', { playbook: { versionId: VERSION_ID, kind: 'voice_answering', status: 'superseded' as const, content: STORED_CONTENT } }],
    ['another playbook kind', { playbook: { versionId: VERSION_ID, kind: 'nurture', status: 'approved' as const, content: STORED_CONTENT } }],
    ['content without the assistant disclosure', { playbook: { versionId: VERSION_ID, kind: 'voice_answering', status: 'approved' as const, content: { kind: 'voice', voice: { ...CONTENT, disclosure: 'Hello, thanks for calling the team, how can we help you?' } } } }],
    ['content that claims to be a person', { playbook: { versionId: VERSION_ID, kind: 'voice_answering', status: 'approved' as const, content: { kind: 'voice', voice: { ...CONTENT, disclosure: "Hi, this is Jordan. I'm a real person, not an AI assistant." } } } }],
    ['malformed content', { playbook: { versionId: VERSION_ID, kind: 'voice_answering', status: 'approved' as const, content: { kind: 'voice', voice: { disclosure: 'x' } } } }],
    ['step content under a voice playbook', { playbook: { versionId: VERSION_ID, kind: 'voice_answering', status: 'approved' as const, content: [] } }],
  ])('E150 R-VOICE-1 refuses without an approved voice_answering version whose stored content validates (%s)', (_n, o) => {
    expect(shouldAnswer(callFacts(o), voiceSettings(), ROUTING_HOURS, AFTER_HOURS)).toBeNull();
  });

  it.each([
    ['the setting off', { answeringEnabled: false }],
    ['enabled but unattested', { attestation: null }],
    ['enabled with a blank attestation', { attestation: '  ' }],
  ])('E150 R-VOICE-9 refuses with %s', (_n, o) => {
    expect(shouldAnswer(callFacts(), voiceSettings(o), ROUTING_HOURS, AFTER_HOURS)).toBeNull();
  });

  it.each([
    ['the pack unreviewed (as shipped)', { status: 'published' as const, reviewedByCounselAt: null, vendorReadyAt: null }],
    ['reviewed but no vendor_ready_at', { status: 'published' as const, reviewedByCounselAt: at('2026-11-01T00:00:00Z'), vendorReadyAt: null }],
    ['vendor ready but unreviewed', { status: 'published' as const, reviewedByCounselAt: null, vendorReadyAt: '2026-11-02T00:00:00Z' }],
    ['a blank vendor_ready_at', { status: 'published' as const, reviewedByCounselAt: at('2026-11-01T00:00:00Z'), vendorReadyAt: ' ' }],
    ['a draft pack', { status: 'draft' as const, reviewedByCounselAt: at('2026-11-01T00:00:00Z'), vendorReadyAt: '2026-11-02T00:00:00Z' }],
  ])('E150 R-INT-6 refuses while platform:voice is not cleared (%s)', (_n, platform) => {
    expect(shouldAnswer(callFacts(), voiceSettings({ platform }), ROUTING_HOURS, AFTER_HOURS)).toBeNull();
    expect(platformVoiceCleared(platform)).toBe(false);
  });

  it.each([9, 61, 20.5, Number.NaN])('refuses a ring timeout outside the DB CHECK (10–60): %s', (s) => {
    expect(shouldAnswer(callFacts(), voiceSettings({ answerAfterSeconds: s }), ROUTING_HOURS, AFTER_HOURS)).toBeNull();
  });

  it('refuses an answer mode outside the DB CHECK', () => {
    expect(shouldAnswer(callFacts(), voiceSettings({ answerWhen: 'always' as never }), ROUTING_HOURS, AFTER_HOURS)).toBeNull();
  });

  it('E112 an opt-out never stops the answer: nothing about the caller\'s opt-outs is even an input', () => {
    // CallFacts carries no opt-out facts at all; the caller called, so the call is answered (R-VOICE-6, R-GATE-14)
    expect(Object.keys(callFacts()).sort()).toEqual(['callId', 'direction', 'identity', 'initiator', 'playbook']);
    expect(shouldAnswer(callFacts(), voiceSettings(), ROUTING_HOURS, AFTER_HOURS)).not.toBeNull();
  });

  it('approvedVoiceContent returns the parsed content; voiceAnsweringOn needs both the switch and the attestation', () => {
    expect(approvedVoiceContent(callFacts().playbook, IDENTITY)).toEqual(CONTENT);
    expect(approvedVoiceContent(callFacts().playbook)).toEqual(CONTENT);
    expect(voiceAnsweringOn({ answeringEnabled: true, attestation: 'ok' })).toBe(true);
    expect(voiceAnsweringOn({ answeringEnabled: false, attestation: 'ok' })).toBe(false);
  });
});

describe('R-VOICE-3 the takeover: the dial timeout decided once at call start', () => {
  const both = ['missed_and_after_hours', 'after_hours_only'] as const;

  it.each(both)('R-VOICE-3 %s: outside routing hours the takeover is call start + voice_answer_after_seconds', (answerWhen) => {
    for (const s of [10, 20, 45, 60]) {
      expect(shouldAnswer(callFacts(), voiceSettings({ answerWhen, answerAfterSeconds: s }), ROUTING_HOURS, AFTER_HOURS)).toEqual({ takeoverAt: plusSeconds(AFTER_HOURS, s) });
    }
  });

  it('R-VOICE-3 missed_and_after_hours answers a missed call inside routing hours after the ring-through; after_hours_only does not answer inside them', () => {
    expect(shouldAnswer(callFacts(), voiceSettings({ answerWhen: 'missed_and_after_hours' }), ROUTING_HOURS, IN_HOURS)).toEqual({ takeoverAt: plusSeconds(IN_HOURS, 20) });
    expect(shouldAnswer(callFacts(), voiceSettings({ answerWhen: 'after_hours_only' }), ROUTING_HOURS, IN_HOURS)).toBeNull();
  });

  it('R-VOICE-3 the routing-hours boundary: open at 08:00 local exactly, closed at 21:00 local exactly', () => {
    const s = voiceSettings({ answerWhen: 'after_hours_only' });
    expect(shouldAnswer(callFacts(), s, ROUTING_HOURS, at('2026-11-10T07:59:59-05:00'))).not.toBeNull();
    expect(shouldAnswer(callFacts(), s, ROUTING_HOURS, at('2026-11-10T08:00:00-05:00'))).toBeNull();
    expect(shouldAnswer(callFacts(), s, ROUTING_HOURS, at('2026-11-10T20:59:59-05:00'))).toBeNull();
    expect(shouldAnswer(callFacts(), s, ROUTING_HOURS, at('2026-11-10T21:00:00-05:00'))).not.toBeNull();
  });

  // The routing zone's DST changes: 2026-03-08 (spring forward) and 2026-11-01 (fall back) in New York.
  const cases: [string, Instant, boolean][] = [
    ['07:30 EST the day before spring forward', at('2026-03-07T07:30:00-05:00'), false],
    ['08:30 EDT on spring-forward day', at('2026-03-08T08:30:00-04:00'), true],
    ['07:30 EDT on spring-forward day', at('2026-03-08T07:30:00-04:00'), false],
    ['20:30 EDT the day after spring forward', at('2026-03-09T20:30:00-04:00'), true],
    ['21:30 EDT the day after spring forward', at('2026-03-09T21:30:00-04:00'), false],
    ['01:30 EDT on fall-back day (first occurrence)', at('2026-11-01T01:30:00-04:00'), false],
    ['01:30 EST on fall-back day (second occurrence)', at('2026-11-01T01:30:00-05:00'), false],
    ['08:00 EST on fall-back day', at('2026-11-01T08:00:00-05:00'), true],
    ['07:59 EST on fall-back day', at('2026-11-01T07:59:00-05:00'), false],
  ];
  it.each(cases)('R-VOICE-3 across the DST changes in the routing zone: %s', (_n, t, open) => {
    // after_hours_only answers exactly when the routing zone's wall clock is outside 08:00–21:00
    const r = shouldAnswer(callFacts(), voiceSettings({ answerWhen: 'after_hours_only' }), ROUTING_HOURS, t);
    expect(r === null).toBe(open);
    // the takeover is elapsed time from call start, never a wall-clock time: DST does not move it
    if (r !== null) expect(r.takeoverAt - t).toBe(20_000);
    expect(shouldAnswer(callFacts(), voiceSettings(), ROUTING_HOURS, t)).toEqual({ takeoverAt: plusSeconds(t, 20) });
  });

  it('R-VOICE-3 the routing calendar is the tenant\'s, in its own zone', () => {
    const la = businessCalendar({ zone: 'America/Los_Angeles', open: '08:00', close: '21:00' });
    // 22:30 New York = 19:30 Los Angeles: after hours in NY, inside hours in LA
    expect(shouldAnswer(callFacts(), voiceSettings({ answerWhen: 'after_hours_only' }), la, AFTER_HOURS)).toBeNull();
    expect(shouldAnswer(callFacts(), voiceSettings({ answerWhen: 'after_hours_only' }), ROUTING_HOURS, AFTER_HOURS)).not.toBeNull();
  });
});
