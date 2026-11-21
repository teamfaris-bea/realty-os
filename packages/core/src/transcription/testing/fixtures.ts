// Synthetic fixtures only. The repository is public: every name, number and sentence here is invented.
import { at } from '../../foundation/index.js';
import type { CallId, ContactId } from '../../foundation/index.js';
import { DEFAULT_TRANSCRIPTION_POLICY } from '../policy.js';
import type { IngestRequest, Segment, TimingScanInput, TranscriptionPolicy } from '../types.js';

export const CALL = '01900000-0000-7000-8000-00000000ca11' as CallId;
export const CONTACT = '01900000-0000-7000-8000-0000000c0de1' as ContactId;
/** A call on 21 Nov 2026 (UTC). */
export const CALL_AT = at('2026-11-21T15:00:00Z');

export const ON_POLICY: TranscriptionPolicy = { ...DEFAULT_TRANSCRIPTION_POLICY, provider: 'local_whisper', recordingEnabled: true };

export function ingest(over: Partial<IngestRequest> = {}): IngestRequest {
  return { source: 'dialer', callId: CALL, contactId: CONTACT, contentType: 'audio/wav', byteLength: 960_000, durationMs: 60_000, recordedAt: CALL_AT, consentBasis: 'one_party_policy', ...over };
}

let t = 0;
export function seg(speaker: string | null, text: string): Segment {
  const s = { startMs: t, endMs: t + 4_000, speaker, text };
  t += 4_000;
  return s;
}

export function scan(segments: Segment[]): TimingScanInput {
  return { callId: CALL, contactId: CONTACT, callAt: CALL_AT, segments };
}

/** An invented dual-channel call: agent "Alex Example" and client "Pat Sample". */
export const STEREO_CALL: Segment[] = [
  { startMs: 0, endMs: 3_000, speaker: 'agent', text: 'Hi Pat, this is Alex with the team. Are you still thinking about selling next spring?' },
  { startMs: 3_000, endMs: 7_000, speaker: 'client', text: "Yeah, we're planning to sell the house." },
  { startMs: 7_000, endMs: 10_000, speaker: 'client', text: 'Probably by March, once the orders come through.' },
  { startMs: 10_000, endMs: 13_000, speaker: 'agent', text: 'Great, and will you buy in the next town over?' },
  { startMs: 13_000, endMs: 17_000, speaker: 'client', text: "We'll rent there for a year first, the lease starts in February." },
];
