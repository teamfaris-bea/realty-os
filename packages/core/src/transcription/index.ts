// @realty/core/transcription — local call transcription (draft lane; docs/design/draft-local-transcription.md):
// the ingest plan for an arriving call recording (switches, consent basis, file checks, retention dates) and the
// timing-cue scan over a finished transcript. Pure: no I/O, no clock, no randomness; instants are injected.
//
// No cloud transcriber exists in this module or its API adapter: audio is transcribed on the team's own machine.
// VERIFY WITH COUNSEL: recording and disclosure rules differ by state and by who is on the call. Nothing here decides
// consent; the ingest plan only refuses a recording whose call carries no consent basis (OPEN DECISIONS T1, T2).
export * from './types.js';
export { ACCEPTED_AUDIO_TYPES, DEFAULT_TRANSCRIPTION_POLICY, assertPolicy, audioType, planIngest, retainUntil } from './policy.js';
export { intentOf, nearestActionableCue, scannedSegments, timingCues, timingWindows } from './timing.js';
