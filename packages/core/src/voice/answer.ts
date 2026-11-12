// Whether the assistant answers a call, and when it takes over (R-VOICE-1, R-VOICE-3, R-VOICE-9,
// R-INT-6, R-GATE-9 core side; E150).
//
// Core refuses (null) unless every enabling fact holds; the DB stays authoritative
// (app.calls_voice_guard refuses VOICE_PLAYBOOK_NOT_APPROVED, VOICE_ANSWERING_OFF and
// VOICE_NOT_CLEARED; calls_assistant_inbound_only refuses AI outbound). An opt-out never stops the
// answer: the caller called (E112). Voice ships dark (D7): platform:voice is uncleared on every
// environment until counsel (C2) and the vendor latency spike (N12) clear it.
import { type IdentityFacts, type VoiceContent, VoiceContentSchema, storedContent, validatePlaybookContent } from '../assistant/index.js';
import { type BusinessCalendar, type Instant, isBusinessOpen, plusSeconds } from '../foundation/index.js';
import type { CallFacts, PlatformVoicePack, VoicePlaybookFacts, VoiceSettings } from './types.js';

/** platform:voice is cleared: published, counsel-reviewed and vendor-ready (app.platform_cleared(key, true)). */
export function platformVoiceCleared(p: PlatformVoicePack): boolean {
  return p.status === 'published' && p.reviewedByCounselAt !== null && p.vendorReadyAt !== null && p.vendorReadyAt.trim() !== '';
}

/** The Owner enabled AND attested voice answering in the active compliance policy (R-VOICE-9). */
export function voiceAnsweringOn(s: Pick<VoiceSettings, 'answeringEnabled' | 'attestation'>): boolean {
  return s.answeringEnabled && s.attestation !== null && s.attestation.trim() !== '';
}

/**
 * The approved voice content of a playbook version, or null: the version must be an approved
 * `voice_answering` version whose stored content passes validatePlaybookContent (no issue at all).
 */
export function approvedVoiceContent(p: VoicePlaybookFacts | null, identity?: IdentityFacts): VoiceContent | null {
  if (p === null || p.kind !== 'voice_answering' || p.status !== 'approved') return null;
  if (validatePlaybookContent(p.content, { kind: 'voice_answering', ...(identity !== undefined ? { identity } : {}) }).length > 0) return null;
  // validatePlaybookContent passed ⇒ the stored object is kind 'voice' and its voice parses
  const c = storedContent(p.content) as { kind: 'voice'; voice: unknown };
  return VoiceContentSchema.parse(c.voice);
}

/**
 * R-VOICE-3: the takeover is the telephony dial timeout decided once, at call start, and stored
 * (`calls.ai_takeover_at`, module 48). `now` is the call-start instant (the DB clock in the call-start
 * transaction); routing hours are read at that instant only.
 *   missed_and_after_hours: takeoverAt = now + voice_answer_after_seconds, inside or outside hours
 *   after_hours_only:       the same outside routing hours; null inside them (known gap (e): the ring
 *                           timeout applies in both modes, read literally)
 */
export function shouldAnswer(call: CallFacts, s: VoiceSettings, hours: BusinessCalendar, now: Instant): { takeoverAt: Instant } | null {
  if (call.direction !== 'inbound' || call.initiator !== 'client') return null;
  if (approvedVoiceContent(call.playbook, call.identity) === null) return null;
  if (!voiceAnsweringOn(s)) return null;
  if (!platformVoiceCleared(s.platform)) return null;
  if (!Number.isInteger(s.answerAfterSeconds) || s.answerAfterSeconds < 10 || s.answerAfterSeconds > 60) return null;
  if (s.answerWhen !== 'missed_and_after_hours' && s.answerWhen !== 'after_hours_only') return null;
  if (s.answerWhen === 'after_hours_only' && isBusinessOpen(now, hours)) return null;
  return { takeoverAt: plusSeconds(now, s.answerAfterSeconds) };
}
