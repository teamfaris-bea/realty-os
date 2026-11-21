// Shared vocabulary of core/transcription: local call transcription (draft lane, docs/design/draft-local-transcription.md).
//
// String unions mirror CHECK constraints where a column exists: `recordings.source` and `recordings.consent_basis`
// (0001_init.sql). `upload` is NOT a recordings.source value yet: an agent-uploaded recording needs a migration and an
// owner decision on consent (OPEN DECISION T1), so the ingest plan refuses it until both exist.
import type { CallId, ContactId, Instant } from '../foundation/index.js';

/** One transcript segment, the same shape transcripts.segments_enc holds and assistant/evidence reads. */
export interface Segment {
  startMs: number;
  endMs: number;
  /** 'agent' | 'client' from a dual-channel dialer recording; null for mono audio (whisper does not separate speakers). */
  speaker: string | null;
  text: string;
}

/** Which transcriber the tenant runs. There is deliberately no cloud option: audio never leaves the team's own machines. */
export type TranscriptionProviderKind = 'local_whisper' | 'unconfigured';

/** Where a call recording comes from. FUB exposes no recordings, so there is no FUB source here. */
export type IngestSource =
  /** a future Realty OS dialer (Twilio-shaped telephony): arrives through comms/recordings.ts onRecordingReady */
  | 'dialer'
  /** an agent uploads an audio file of a call they made elsewhere (OPEN DECISION T1; refused until decided) */
  | 'upload';

/** recordings.source */
// 'upload' is not in the recordings.source CHECK yet: it needs a migration once OPEN DECISION T1 is made.
export type DbRecordingSource = 'provider' | 'import_fub' | 'upload';
/** recordings.consent_basis */
export type DbConsentBasis = 'announced_all_parties' | 'one_party_policy' | 'unknown_imported';

/**
 * The tenant's transcription and recording-retention settings. Every number is a policy choice the Owner makes
 * (OPEN DECISION T3); the defaults below are placeholders for review, not advice.
 */
export interface TranscriptionPolicy {
  provider: TranscriptionProviderKind;
  /** tenant_settings recording switch: off means no recording is kept and nothing is transcribed. */
  recordingEnabled: boolean;
  /** Agent uploads accepted (needs a recordings.source migration and OPEN DECISION T1). */
  uploadsEnabled: boolean;
  /** Days the audio is kept (recordings.retain_until). */
  audioRetentionDays: number;
  /** Days the transcript text is kept; may be longer than the audio (the text is what the summaries read). */
  transcriptRetentionDays: number;
  maxAudioBytes: number;
  maxDurationMs: number;
}

/** One recording arriving to be kept and transcribed. Ids and metadata only: the audio bytes stay with the caller. */
export interface IngestRequest {
  source: IngestSource;
  callId: CallId;
  contactId: ContactId;
  contentType: string;
  byteLength: number;
  durationMs: number | null;
  /** When the call happened. */
  recordedAt: Instant;
  /**
   * The basis the CALL recorded (comms/dial.ts decideRecording stamps it per call). The ingest plan never invents one:
   * a request with no basis is refused.
   */
  consentBasis: Exclude<DbConsentBasis, 'unknown_imported'> | null;
}

export type IngestRefusal =
  | 'RECORDING_DISABLED'
  | 'TRANSCRIPTION_NOT_CONFIGURED'
  | 'UPLOAD_SOURCE_NOT_ENABLED'
  | 'CONSENT_BASIS_MISSING'
  | 'UNSUPPORTED_AUDIO_TYPE'
  | 'AUDIO_EMPTY'
  | 'AUDIO_TOO_LARGE'
  | 'AUDIO_TOO_LONG';

export type IngestPlan =
  | {
      accept: true;
      dbSource: DbRecordingSource;
      consentBasis: Exclude<DbConsentBasis, 'unknown_imported'>;
      audioRetainUntil: Instant;
      transcriptRetainUntil: Instant;
      /** the job that follows a stored recording (comms/recordings.ts TRANSCRIBE_JOB) */
      transcribe: boolean;
    }
  | { accept: false; reason: IngestRefusal };

// ---- timing cues -------------------------------------------------------------------------------------------------

export type MoveIntent = 'buy' | 'sell' | 'both' | 'unclear';

/** A move-timing statement found in a call, with the transcript range it came from (assistant Locator transcript_offset). */
export interface TimingCue {
  /** The words that carried the timing, verbatim from the segment. */
  quote: string;
  startMs: number;
  endMs: number;
  speaker: string | null;
  intent: MoveIntent;
  /** Months from the call until the stated window opens (0 = now), or null when the window has no clear start. */
  horizonMonths: number | null;
  /** Whether the stated window is within six months of the call (the nudge list's threshold). */
  withinSixMonths: boolean;
  /**
   * The statement is about renting (a lease, a PCS move to a rental). The 90-day pilot's one false positive was exactly
   * this, so it never counts as a buy or sell cue; it is kept for the agent to read.
   */
  leaseContext: boolean;
}

/** What the timing scan reads for one call: the client's words only when the speakers are known. */
export interface TimingScanInput {
  callId: CallId;
  contactId: ContactId;
  callAt: Instant;
  segments: readonly Segment[];
}
