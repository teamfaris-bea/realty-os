// Plain-language states and refusals of module 75 (honest UI: every hold, pause and refusal is said as what it is).
// API error bodies carry codes only (errors.ts); the web lane (ISA-4) shows these sentences.
import type { AssignmentRow } from './repo.js';

export const STATE_SENTENCES = {
  paused: 'Paused: nobody is following up automatically.',
  held: 'Held: sending is off or a daily limit is reached; it continues on its own when that clears.',
} as const;

const START_REFUSALS: Record<string, string> = {
  AI_ISA_OFF: 'The AI assistant is off for your team.',
  AI_ISA_NOT_CLEARED: 'Waiting on counsel review (platform:ai_isa). Nothing is sent until counsel clears it.',
  AI_ISA_POLICY_NOT_APPROVED: 'Your team has no approved AI assistant policy.',
  AI_ISA_NO_OPTIN: 'Opt in to the AI assistant first (Settings, My AI assistant).',
  AI_ISA_NOT_OWNER: "Only the lead's owner can start AI care.",
  AI_ISA_NOT_ROOT: 'This record was merged; start AI care on the surviving record.',
  AI_ISA_ALREADY_ACTIVE: 'AI care is already on for this person.',
  AI_ISA_DO_NOT_CONTACT: 'This person asked not to be contacted.',
  AI_ISA_PERSON_DECLINED: 'This person declined or stopped AI care. A restart needs a new message from them and your attestation.',
  AI_ISA_FIRST_TOUCH_PENDING: "Text or call them yourself first. AI messages don't count as your first contact.",
  AI_ISA_SHARED_ADDRESS: 'Another person shares one of their phone numbers or emails.',
  AI_ISA_ACTIVE_CLIENT: 'They are a client on an open deal or an active listing.',
  AI_ISA_NO_CHANNEL: 'No phone or email of theirs can receive AI messages.',
  AI_ISA_LISTED_ELSEWHERE: 'Their home is listed with another brokerage.',
};
export function startRefusalSentence(code: string): string {
  return START_REFUSALS[code] ?? 'AI care cannot start right now.';
}

type Chip = { kind: 'active' | 'waiting_reply' | 'reply_scheduled' | 'scheduling' | 'waiting_on_agent' | 'paused' | 'held' | 'ended'; sentence: string };
export function chipOf(a: AssignmentRow, notBefore: Date | null): Chip {
  if (a.endedAt !== null) return { kind: 'ended', sentence: `Ended: ${String(a.endReason ?? '').replace(/_/g, ' ')}` };
  if (a.pausedAt !== null) return { kind: 'paused', sentence: `Paused: ${String(a.pauseReason ?? '').replace(/_/g, ' ')} (nobody is following up)` };
  if (notBefore !== null && notBefore.getTime() > Date.now()) return { kind: 'reply_scheduled', sentence: `Reply scheduled ${notBefore.toISOString().slice(11, 16)} UTC` };
  if (a.machine.held.length > 0) return { kind: 'waiting_on_agent', sentence: `Waiting on you: ${a.machine.held[0]!.class.replace(/_/g, ' ')}` };
  if (a.machine.phase === 'scheduling' || a.machine.phase === 'booking') return { kind: 'scheduling', sentence: 'Scheduling' };
  if (a.machine.phase === 'awaiting_reply' || a.machine.phase === 'nurture') return { kind: 'waiting_reply', sentence: 'Waiting for reply' };
  return { kind: 'active', sentence: 'Active' };
}
