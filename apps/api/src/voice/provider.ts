// The voice-agent port of module 48 (PHASE2_3_PLAN §5.4 #48; R-VOICE-10, R-VOICE-11, R-VOICE-13; N12).
//
// Source-neutral: no vendor is named and no vendor SDK is imported. Every transport capability below is a
// DESIGN ASSUMPTION about a real voice stack (telephony media stream + STT + LLM + TTS), to be checked per
// vendor before any real adapter exists. VERIFY per vendor (N12):
//   - connect returns an opaque telephony answer (for Twilio-style providers: TwiML that opens a media stream)
//   - the stream reports when a spoken line FINISHED playing (disclosure, announcement), not when it was queued
//   - caller turns arrive as final STT text with a language code (or null), model turns with a latency
//   - the model's tool requests arrive as {tool, args} and wait for a toolResult
//   - handOff(twiml) moves the live call to other TwiML (voicemail, a transfer leg); the stream ends meanwhile and
//     reconnect(sessionId) re-opens it on the same session (VERIFY: today's TelephonyProvider has no live-call
//     update method, providers/types.ts, so a real adapter needs the vendor's own call-control path)
//   - the latency spike (PLAN:613, :667) measures max_turn_latency_ms against a real vendor; until it passes,
//     platform:voice stays uncleared (rules.vendor_ready_at has no writer in this tree)
// The context a session hands the vendor holds the approved content and limits only: no contact field, no name,
// no address, no claim (R-VOICE-13). Production uses UnconfiguredVoiceAgent: nothing answers (honest state).
import type { Instant } from '@realty/core/foundation';
import type { VoiceEvent, VoiceLedgerTool, VoiceLineId } from '@realty/core/voice';
import { ProviderError } from '../providers/types.js';

/** Events the platform reports: core's VoiceEvent minus the ones module 48 makes itself, plus raw claim proposals. */
export type PlatformEvent =
  | Exclude<VoiceEvent, { type: 'booking_result' | 'transfer_result' | 'tick' | 'enablement_changed' | 'claims' }>
  /** The model's raw claim proposals (untrusted); module 48 normalizes them against the caller's own turns only. */
  | { type: 'claim_proposals'; at: Instant; raw: unknown };

/** A slot as the model sees it (ISO instants). */
export interface OfferedSlotIso {
  start: string;
  end: string;
}

export type SaySource = 'disclosure' | 'announcement' | 'script' | 'model';

/** What a session hands the vendor (R-VOICE-13): approved content and limits only. */
export interface VoiceSessionContext {
  disclosure: string;
  recordingAnnouncement: string;
  enabledTools: readonly VoiceLedgerTool[];
  maxCallSeconds: number;
  coveredLanguages: readonly string[];
  maxTurnLatencyMs: number;
  /** ids of core's fixed lines (VOICE_LINES), so a vendor can pre-render them; the text comes with each say */
  lineIds: readonly VoiceLineId[];
}

export const VOICE_SESSION_CONTEXT_KEYS = ['disclosure', 'recordingAnnouncement', 'enabledTools', 'maxCallSeconds', 'coveredLanguages', 'maxTurnLatencyMs', 'lineIds'] as const;

export type NextResult = PlatformEvent | 'idle' | null;

export interface VoiceTransport {
  /**
   * The next platform event that arrives before `until`; 'idle' when none did; null once the transport closed.
   * `pending` is work the runner started (a booking): a real transport ignores it, the fake waits for it before it
   * lets virtual time pass the next scripted event (determinism, tests only).
   */
  next(o: { until: Instant; pending: Promise<unknown> | null }): Promise<NextResult>;
  say(text: string, source: SaySource): Promise<void>;
  awaitModel(): Promise<void>;
  toolResult(seq: number, decision: 'allow' | 'deny', reason: string, slots?: readonly OfferedSlotIso[]): Promise<void>;
  /** Moves the live call to `twiml`; says issued while handed off are queued until reconnect. */
  handOff(twiml: string): Promise<void>;
  close(): Promise<void>;
}

export interface VoiceAgentProvider {
  readonly kind: string;
  readonly configured: boolean;
  readonly statusText: string;
  /** Opens a session for a call. `response` is the adapter's opaque telephony answer (served as the webhook reply). */
  connect(i: { callRef: string; sessionId: string; tenantId: string; context: VoiceSessionContext }): Promise<{ response: string; transport: VoiceTransport }>;
  /** Re-opens the stream of a session after a hand-off; throws when the session is unknown here. */
  reconnect(i: { sessionId: string; tenantId: string }): Promise<{ response: string }>;
}

export const VOICE_VENDOR_NOT_CONFIGURED_TEXT = 'No voice vendor is set up on this platform yet (N12). AI answering stays off.';

/** Production: no vendor procured (N12). Every call refuses; nothing answers. */
export class UnconfiguredVoiceAgent implements VoiceAgentProvider {
  readonly kind = 'unconfigured';
  readonly configured = false;
  readonly statusText = VOICE_VENDOR_NOT_CONFIGURED_TEXT;
  async connect(): Promise<never> {
    throw new ProviderError('not_configured', 'VOICE_VENDOR_NOT_CONFIGURED');
  }
  async reconnect(): Promise<never> {
    throw new ProviderError('not_configured', 'VOICE_VENDOR_NOT_CONFIGURED');
  }
}
