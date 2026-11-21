import { describe, expect, it } from 'vitest';
import { DAY_MS } from '../foundation/index.js';
import { DEFAULT_TRANSCRIPTION_POLICY, assertPolicy, audioType, planIngest } from './index.js';
import { CALL_AT, ON_POLICY, ingest } from './testing/fixtures.js';

describe('transcription ingest plan', () => {
  it('the default policy keeps nothing: recording is off and no transcriber is configured', () => {
    expect(DEFAULT_TRANSCRIPTION_POLICY.recordingEnabled).toBe(false);
    expect(DEFAULT_TRANSCRIPTION_POLICY.provider).toBe('unconfigured');
    expect(DEFAULT_TRANSCRIPTION_POLICY.uploadsEnabled).toBe(false);
    expect(planIngest(ingest(), DEFAULT_TRANSCRIPTION_POLICY)).toEqual({ accept: false, reason: 'RECORDING_DISABLED' });
  });

  it('a recording is refused while no transcriber is configured, even with recording on', () => {
    expect(planIngest(ingest(), { ...ON_POLICY, provider: 'unconfigured' })).toEqual({ accept: false, reason: 'TRANSCRIPTION_NOT_CONFIGURED' });
  });

  it('a dialer recording with a consent basis is kept, transcribed and dated for retention', () => {
    const p = planIngest(ingest(), ON_POLICY);
    expect(p).toEqual({
      accept: true,
      dbSource: 'provider',
      consentBasis: 'one_party_policy',
      audioRetainUntil: CALL_AT + 90 * DAY_MS,
      transcriptRetainUntil: CALL_AT + 730 * DAY_MS,
      transcribe: true,
    });
  });

  it('the transcript is never kept for less time than the audio it came from', () => {
    const p = planIngest(ingest(), { ...ON_POLICY, audioRetentionDays: 400, transcriptRetentionDays: 30 });
    expect(p.accept && p.transcriptRetainUntil).toBe(CALL_AT + 400 * DAY_MS);
  });

  it('an agent upload is refused until uploads are turned on (open decision T1), then gets its own source', () => {
    expect(planIngest(ingest({ source: 'upload' }), ON_POLICY)).toEqual({ accept: false, reason: 'UPLOAD_SOURCE_NOT_ENABLED' });
    const p = planIngest(ingest({ source: 'upload' }), { ...ON_POLICY, uploadsEnabled: true });
    expect(p.accept && p.dbSource).toBe('upload');
  });

  it('the plan never invents a consent basis: a call without one is refused', () => {
    expect(planIngest(ingest({ consentBasis: null }), ON_POLICY)).toEqual({ accept: false, reason: 'CONSENT_BASIS_MISSING' });
    const p = planIngest(ingest({ consentBasis: 'announced_all_parties' }), ON_POLICY);
    expect(p.accept && p.consentBasis).toBe('announced_all_parties');
  });

  it('file checks: type, empty, size and length', () => {
    expect(planIngest(ingest({ contentType: 'video/mp4' }), ON_POLICY)).toEqual({ accept: false, reason: 'UNSUPPORTED_AUDIO_TYPE' });
    expect(planIngest(ingest({ contentType: 'text/plain' }), ON_POLICY)).toEqual({ accept: false, reason: 'UNSUPPORTED_AUDIO_TYPE' });
    expect(planIngest(ingest({ contentType: 'Audio/MPEG; charset=binary' }), ON_POLICY).accept).toBe(true);
    expect(planIngest(ingest({ byteLength: 0 }), ON_POLICY)).toEqual({ accept: false, reason: 'AUDIO_EMPTY' });
    expect(planIngest(ingest({ byteLength: ON_POLICY.maxAudioBytes + 1 }), ON_POLICY)).toEqual({ accept: false, reason: 'AUDIO_TOO_LARGE' });
    expect(planIngest(ingest({ durationMs: ON_POLICY.maxDurationMs + 1 }), ON_POLICY)).toEqual({ accept: false, reason: 'AUDIO_TOO_LONG' });
    expect(planIngest(ingest({ durationMs: null }), ON_POLICY).accept).toBe(true);
    expect(audioType(' audio/WAV ; rate=8000')).toBe('audio/wav');
  });

  it('a policy with a zero, negative, fractional or absurd number is rejected', () => {
    expect(() => assertPolicy({ ...ON_POLICY, audioRetentionDays: 0 })).toThrow(RangeError);
    expect(() => assertPolicy({ ...ON_POLICY, transcriptRetentionDays: -1 })).toThrow(RangeError);
    expect(() => assertPolicy({ ...ON_POLICY, maxAudioBytes: 1.5 })).toThrow(RangeError);
    expect(() => assertPolicy({ ...ON_POLICY, transcriptRetentionDays: 4000 })).toThrow(RangeError);
    expect(() => assertPolicy(ON_POLICY)).not.toThrow();
  });
});
