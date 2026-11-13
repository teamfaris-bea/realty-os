// The module 48 voice routes as the web reads them (apps/api/src/voice/schemas.ts; the staff contract checks every
// fixture against the real schemas). Codes stay strings here: they are worded through words.ts and never shown.
import type { VoiceAnswerWhen } from '@realty/core/voice';

export type AnsweringState = 'dark' | 'off' | 'on';

export interface AnsweringView {
  state: AnsweringState;
  reasons: { code: string; sentence: string }[];
  pack: { version: string | null; reviewedByCounselAt: string | null; vendorReady: boolean; cleared: boolean };
  playbook: { id: string; approvedVersionId: string | null; state: string } | null;
  enabled: { on: boolean; sentence: string };
  settings: { answerAfterSeconds: number; answerWhen: VoiceAnswerWhen; version: number };
  provider: { configured: boolean; statusText: string };
  transfers: string;
  attestationText: string;
}

export interface SettingsBody {
  answerAfterSeconds: number;
  answerWhen: VoiceAnswerWhen;
  version: number;
  attestation?: string;
}

export interface TestCallResult {
  sentence: string;
  lines: { source: string; text: string }[];
  ledger: { seq: number; tool: string | null; decision: 'allow' | 'deny'; reasonCode: string }[];
  handback: { outcome: string; endReason: string; critical: boolean; messageTopics: string[]; noPhoneCallback: boolean; confirmationChannel: string | null };
}

/** GET /calls/:id/voice */
export interface CallVoiceView {
  callId: string;
  state: 'in_progress' | 'ended' | 'recovered' | 'not_answered';
  sentence: string;
  takeoverAt: string | null;
  outcome: string | null;
  outcomeSentence: string | null;
  endReason: string | null;
  transferOutcome: string | null;
  ledger: { seq: number; tool: string; args: Record<string, string>; decision: 'allow' | 'deny'; reasonCode: string; occurredAt: string }[];
  unlogged: { seq: number; reason: string; at: string }[];
  handbackId: string | null;
}
