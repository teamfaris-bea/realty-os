import { DAY_MS, plusMs } from '../foundation/index.js';
import type { Instant } from '../foundation/index.js';
import type { IngestPlan, IngestRequest, TranscriptionPolicy } from './types.js';

/** Audio types the local transcriber decodes (ffmpeg). Anything else is refused before storage. */
export const ACCEPTED_AUDIO_TYPES: ReadonlySet<string> = new Set(['audio/wav', 'audio/x-wav', 'audio/wave', 'audio/mpeg', 'audio/mp4', 'audio/x-m4a', 'audio/ogg', 'audio/webm', 'audio/flac']);

/**
 * Placeholder defaults for the Owner to review (OPEN DECISION T3). Off until the Owner turns recording on; uploads off
 * until T1 is decided.
 */
export const DEFAULT_TRANSCRIPTION_POLICY: TranscriptionPolicy = Object.freeze({
  provider: 'unconfigured',
  recordingEnabled: false,
  uploadsEnabled: false,
  audioRetentionDays: 90,
  transcriptRetentionDays: 730,
  maxAudioBytes: 50 * 1024 * 1024,
  maxDurationMs: 2 * 60 * 60 * 1000,
});

export function assertPolicy(p: TranscriptionPolicy): void {
  for (const k of ['audioRetentionDays', 'transcriptRetentionDays', 'maxAudioBytes', 'maxDurationMs'] as const) {
    if (!Number.isInteger(p[k]) || p[k] <= 0) throw new RangeError(`${k} must be a positive integer`);
  }
  if (p.transcriptRetentionDays > 3650 || p.audioRetentionDays > 3650) throw new RangeError('retention is capped at 10 years');
}

export function retainUntil(recordedAt: Instant, days: number): Instant {
  return plusMs(recordedAt, days * DAY_MS);
}

/** Normalised audio type (lowercase, no parameters). */
export function audioType(contentType: string): string {
  return contentType.split(';')[0]!.trim().toLowerCase();
}

/**
 * The ingest hook's decision for one arriving recording: keep and transcribe it, or refuse with a reason. Pure.
 * Order matters: switches first (nothing is read when recording is off), then source and consent, then the file.
 */
export function planIngest(req: IngestRequest, policy: TranscriptionPolicy): IngestPlan {
  assertPolicy(policy);
  if (!policy.recordingEnabled) return { accept: false, reason: 'RECORDING_DISABLED' };
  if (policy.provider === 'unconfigured') return { accept: false, reason: 'TRANSCRIPTION_NOT_CONFIGURED' };
  if (req.source === 'upload' && !policy.uploadsEnabled) return { accept: false, reason: 'UPLOAD_SOURCE_NOT_ENABLED' };
  if (req.consentBasis === null) return { accept: false, reason: 'CONSENT_BASIS_MISSING' };
  if (!ACCEPTED_AUDIO_TYPES.has(audioType(req.contentType))) return { accept: false, reason: 'UNSUPPORTED_AUDIO_TYPE' };
  if (req.byteLength <= 0) return { accept: false, reason: 'AUDIO_EMPTY' };
  if (req.byteLength > policy.maxAudioBytes) return { accept: false, reason: 'AUDIO_TOO_LARGE' };
  if (req.durationMs !== null && req.durationMs > policy.maxDurationMs) return { accept: false, reason: 'AUDIO_TOO_LONG' };
  return {
    accept: true,
    // a dialer recording is the provider's; an upload needs its own recordings.source value (migration, OPEN DECISION T1)
    dbSource: req.source === 'dialer' ? 'provider' : 'upload',
    consentBasis: req.consentBasis,
    audioRetainUntil: retainUntil(req.recordedAt, policy.audioRetentionDays),
    transcriptRetainUntil: retainUntil(req.recordedAt, Math.max(policy.audioRetentionDays, policy.transcriptRetentionDays)),
    transcribe: true,
  };
}
