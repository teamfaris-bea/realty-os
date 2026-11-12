// Playbook editor helpers (pure; unit-tested). A playbook is "approve rules, not every message"
// (ARCHITECTURE §11, R-AST-4): a person approves an exact version (bound to its content hash), and the
// assistant may then send those messages on its own, with opt-outs checked at the moment each one
// goes out and a pause the moment the client replies.
import { messageFor } from '../../shell/errorMessages.js'; // the pure lookup itself: the shell index pulls in the app and its registry
import { ADMIN_MESSAGES } from '../admin/lib/messages.js';
import type { Playbook, PlaybookStepView, PlaybookVersion } from '../admin/lib/types.js';

/** GET /playbooks/:id/auto-enroll-stage (api/stage-automation, R-PAR-16). */
export interface AutoEnrollSetting {
  playbook: { id: string; name: string; scope: 'team' | 'agent'; autoEnrollStage: string | null };
  /** the caller may change it: the server's own can() for the PUT (team playbooks Owner/Admin; an agent their own) */
  canChange: boolean;
}

/**
 * A refusal of PUT /playbooks/:id/auto-enroll-stage in plain words. The 409 says which stage is taken and by
 * whose playbook (the one-per-stage rule is per team, or per agent for personal playbooks); the 422s say why
 * this playbook cannot start on a stage at all, or that the stage was not one of the list.
 */
export function autoEnrollRefusal(code: string, ctx: { stageLabel: string | null; scope: 'team' | 'agent' }): string {
  if (code === 'AUTO_ENROLL_STAGE_TAKEN' && ctx.stageLabel) {
    return `${ctx.scope === 'team' ? 'Another team playbook' : 'Another of your playbooks'} already starts when a person enters “${ctx.stageLabel}”. Clear the stage on that playbook first, or pick another one.`;
  }
  if (code === 'VALIDATION_FAILED') return 'Pick one of the stages in the list, or “No stage”.';
  return messageFor(code, ADMIN_MESSAGES);
}

export const KIND_LABEL: Record<string, string> = {
  new_lead_response: 'Instant reply to new leads',
  nurture: 'Stay in touch',
  post_closing: 'After closing',
  booking_confirmation: 'Appointment confirmation',
  reminder: 'Appointment reminder',
  document_chase: 'Document reminders',
  // module 26 (batch 7 review ui/F2): kept read-only on this page until module 26 has its own editor
  trigger: 'Alerts',
  voice_answering: 'Call answering',
};

/**
 * Batch 7 review ui/F2: module 26's trigger playbooks (and voice answering) keep one content object in `steps`, not
 * a list of messages, and this page has no editor for them. They are listed under their own heading and open
 * read-only: no editor, no approval, no stop, no stage.
 */
export const READ_ONLY_KINDS: readonly string[] = ['trigger', 'voice_answering'];
export const ALERTS_HEADING = 'Alerts and call answering (read-only here)';
export const READ_ONLY_ALERTS = "These playbooks can't be changed, approved or stopped on this page yet.";

export function isReadOnlyPlaybook(p: Pick<Playbook, 'kind'>): boolean {
  return READ_ONLY_KINDS.includes(p.kind);
}

/** The built-in starting points (api/assistant templates.ts) and who may create each. */
export const TEMPLATES: readonly { key: string; name: string; scope: 'team' | 'agent' }[] = [
  { key: 'new_lead_response', name: 'Instant reply to new leads', scope: 'team' },
  { key: 'booking_confirmation', name: 'Appointment confirmation', scope: 'team' },
  { key: 'reminder', name: 'Appointment reminder', scope: 'team' },
  { key: 'nurture', name: 'Stay in touch', scope: 'agent' },
  { key: 'post_closing', name: 'After closing', scope: 'agent' },
];

export const STATUS_LABEL: Record<string, string> = {
  draft: 'Draft',
  approved: 'Running',
  superseded: 'Replaced',
  revoked: 'Stopped',
};

/** One plain sentence per core.validatePlaybook code (what blocks approval). */
export const ISSUE_SENTENCE: Record<string, string> = {
  NO_STEPS: 'A playbook needs at least one message.',
  SCHEMA: 'This message is missing something it needs.',
  DUPLICATE_STEP_KEY: 'Two messages have the same name.',
  MARKETING_INTENT_DECLARED_INFORMATIONAL: 'This message is marketing, so it cannot be sent as an informational message.',
  INTENT_CATEGORY_MISMATCH: "This message's purpose doesn't match what it is for.",
  KIND_CATEGORY_MISMATCH: "This message doesn't belong in this kind of playbook.",
  KIND_STEP_COUNT: 'This kind of playbook has a fixed number of messages.',
  UNDECLARED_SLOT: 'This message uses a placeholder that is not available here.',
  TEMPLATE_SYNTAX: 'A placeholder is not written correctly. Use {{first_name}} style.',
  TEMPLATE_PAYMENT_INSTRUCTIONS: 'Messages the assistant sends on its own may never contain payment or wiring instructions.',
  TEMPLATE_ALWAYS_HUMAN_TOPIC: 'This mentions money, offers, commission or contracts. Those always need a person to send them.',
  TEMPLATE_HUMAN_CLAIM: 'This reads as if a person wrote it. The assistant must not claim to be a person.',
  TEMPLATE_TOO_LONG: 'This message is longer than allowed.',
  EMAIL_SUBJECT_REQUIRED: 'An email needs a subject.',
  SMS_SUBJECT_NOT_ALLOWED: 'A text message has no subject.',
  FALLBACK_INVALID: 'The email version of this text is incomplete.',
  NEGATIVE_DELAY_WITHOUT_EVENT: 'Only messages tied to an event (like an appointment) can go before it.',
};

export function issueSentence(code: string): string {
  return ISSUE_SENTENCE[code] ?? 'Something in this message needs fixing before approval.';
}

const SLOT_RE = /\{\{\s*[#/^]?\s*([a-z_]+)\s*\}\}/g;

/** Placeholders a template uses ({{first_name}}, {{#va_question}}…{{/va_question}}). */
export function placeholdersIn(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(SLOT_RE)) if (m[1]) out.add(m[1]);
  return [...out];
}

export type DelayUnit = 'minutes' | 'hours' | 'days';

export function splitDelay(seconds: number): { amount: number; unit: DelayUnit } {
  const abs = Math.abs(seconds);
  if (abs !== 0 && abs % 86_400 === 0) return { amount: seconds / 86_400, unit: 'days' };
  if (abs !== 0 && abs % 3600 === 0) return { amount: seconds / 3600, unit: 'hours' };
  return { amount: Math.round(seconds / 60), unit: 'minutes' };
}

export function joinDelay(amount: number, unit: DelayUnit): number {
  return Math.round(amount) * (unit === 'days' ? 86_400 : unit === 'hours' ? 3600 : 60);
}

const ANCHOR: Record<PlaybookStepView['delay']['anchor'], string> = {
  enrollment: 'after the contact starts this playbook',
  previous_step: 'after the previous message',
  event: 'from the event (closing, appointment)',
};

/** "Right away", "30 days after the previous message", "1 day before the event". */
export function delayText(d: PlaybookStepView['delay']): string {
  if (d.offsetSeconds === 0) return d.anchor === 'event' ? 'At the event' : d.anchor === 'previous_step' ? 'Right after the previous message' : 'Right away';
  const { amount, unit } = splitDelay(d.offsetSeconds);
  const n = Math.abs(amount);
  const u = n === 1 ? unit.slice(0, -1) : unit;
  if (d.offsetSeconds < 0) return `${n} ${u} before the event`;
  return `${n} ${u} ${ANCHOR[d.anchor]}`;
}

/** Steps as editable views (unknown shapes are kept as-is by the editor and never rewritten). */
export function stepsOf(v: PlaybookVersion): PlaybookStepView[] {
  if (!Array.isArray(v.steps)) return []; // object content (module 26 triggers): no messages to edit here
  return v.steps.filter((s): s is PlaybookStepView => typeof s === 'object' && s !== null && 'stepKey' in s && 'template' in s);
}

/** The version a person edits: the newest draft, or else the running/newest one as a base. */
export function workingVersion(p: Playbook): PlaybookVersion | null {
  const sorted = [...p.versions].sort((a, b) => b.versionNo - a.versionNo);
  return sorted.find((v) => v.status === 'draft') ?? sorted.find((v) => v.id === p.approvedVersionId) ?? sorted[0] ?? null;
}

/** The exact sentence the approver confirms; it is stored verbatim with the approval. */
export function approvalAttestation(p: Pick<Playbook, 'name'>, v: Pick<PlaybookVersion, 'versionNo' | 'steps'>): string {
  const n = Array.isArray(v.steps) ? v.steps.length : 0;
  if (n === 0) return `I reviewed “${p.name}” version ${v.versionNo}. The assistant may act on it on its own for contacts who have not opted out, signed as the assistant, and must stop when a client replies.`;
  return `I reviewed the ${n === 1 ? 'message' : `${n} messages`} in “${p.name}” version ${v.versionNo}. The assistant may send ${n === 1 ? 'it' : 'them'} on its own to contacts who have not opted out, signed as the assistant, and must stop when a client replies.`;
}

export function revokeAttestation(p: Pick<Playbook, 'name'>, v: Pick<PlaybookVersion, 'versionNo'>): string {
  return `I am stopping “${p.name}” version ${v.versionNo}. Its messages that have not gone out yet will not be sent.`;
}

/** Who may approve: team playbooks by Owner/Admin; personal ones by their own agent (R-AST-4). */
export function mayApprove(p: Pick<Playbook, 'scope' | 'ownerUserId'>, viewer: { userId: string | undefined; role: string | undefined }): boolean {
  if (p.scope === 'team') return viewer.role === 'owner' || viewer.role === 'admin';
  return p.ownerUserId !== null && p.ownerUserId === viewer.userId;
}

/** "Running version 3" / "Draft waiting for approval" / "Not running". */
export function playbookState(p: Playbook): { text: string; tone: 'ok' | 'warn' | 'neutral' } {
  const running = p.versions.find((v) => v.id === p.approvedVersionId);
  const newest = [...p.versions].sort((a, b) => b.versionNo - a.versionNo)[0];
  const draftPending = newest && newest.status === 'draft';
  if (running) return { text: draftPending ? `Running version ${running.versionNo} · a newer draft waits for approval` : `Running version ${running.versionNo}`, tone: 'ok' };
  if (draftPending) return { text: 'Not running · draft waits for approval', tone: 'warn' };
  return { text: 'Not running', tone: 'neutral' };
}
