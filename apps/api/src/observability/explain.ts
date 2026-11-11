// Plain-language words for the System page: what a job kind does and why a job failed. The stored
// error is already a scrubbed code (worker/loop.ts errorCode: SQLSTATE or masked message, ≤ 500 chars);
// these sentences say what it means for the team and whether a retry is likely to help.

const KIND_LABELS: Record<string, string> = {
  'comms.dispatch': 'Send a message',
  'comms.reconcile': 'Check a message with the provider',
  'comms.dispatch_stale': 'Recover a message stuck while sending',
  'comms.recording_copy': 'Save a call recording',
  'comms.transcribe': 'Transcribe a call',
  'ownership.offer_expiry': 'Lead offer timer',
  'ownership.first_touch_breach': 'First-touch deadline',
  'ownership.auto_release': 'Auto-release to the pond',
  'ownership.inactivity': 'Inactivity check',
  'ownership.followup': 'Lead routing follow-up',
  'ownership.drift_check': 'Lead ownership consistency check',
  'consent.drift_check': 'Opt-out consistency check',
  'notify.deliver': 'Deliver a notification',
  'playbook.step': 'Playbook step',
  'storage.blob_delete': 'Delete stored files',
};

export function kindLabel(kind: string): string {
  const known = KIND_LABELS[kind];
  if (known) return known;
  const area = kind.split('.')[0] ?? kind;
  if (area === 'assistant') return 'Assistant work';
  if (area === 'imports' || area === 'import') return 'Import';
  if (area === 'exceptions') return 'Team exceptions update';
  return kind;
}

export interface JobReason {
  /** a short stable code for support (never PII: derived from the scrubbed error) */
  code: string;
  sentence: string;
  /** whether a retry is likely to help on its own */
  retryHelps: boolean;
}

export function explainJobError(lastError: string | null): JobReason {
  const e = lastError ?? '';
  const sqlstate = /(?:^|[\s:])([0-9A-Z]{5})(?:\s|$)/.exec(e)?.[1] ?? null;
  if (e === '') return { code: 'NONE', sentence: 'No error was recorded for this job.', retryHelps: true };
  if (e.startsWith('LEASE_EXPIRED')) return { code: 'LEASE_EXPIRED', sentence: 'The worker stopped before finishing this job (a restart or a crash). Retrying is safe.', retryHelps: true };
  if (e.startsWith('NO_HANDLER')) return { code: 'NO_HANDLER', sentence: 'This version of the system does not know how to run this kind of job. It needs a software update, not a retry.', retryHelps: false };
  if (e.startsWith('PAYLOAD_INVALID')) return { code: 'PAYLOAD_INVALID', sentence: 'The job’s stored details did not pass their safety check, so it was stopped. A retry will fail the same way; contact support.', retryHelps: false };
  if (e.startsWith('NO_TENANT')) return { code: 'NO_TENANT', sentence: 'The job is not tied to a team, so it cannot run.', retryHelps: false };
  if (sqlstate === '40001' || sqlstate === '40P01') return { code: `DB_${sqlstate}`, sentence: 'The database was busy with a conflicting change at the same moment. Retrying usually works.', retryHelps: true };
  if (sqlstate === '57014') return { code: 'DB_TIMEOUT', sentence: 'The database took too long to answer. Retry; if it keeps happening, the database needs attention.', retryHelps: true };
  if (sqlstate?.startsWith('08') || /ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|TimeoutError|socket hang up/i.test(e)) {
    return { code: 'CONNECTION', sentence: 'A connection to the database or a provider failed. Retry once the connection is back.', retryHelps: true };
  }
  if (sqlstate?.startsWith('23') || sqlstate === 'P0001') return { code: sqlstate ? `DB_${sqlstate}` : 'DB_RULE', sentence: 'A safety rule in the database refused this change (the data moved on, or the action is not allowed). A retry only helps if the cause was temporary.', retryHelps: false };
  if (/twilio|smtp|provider|mailgun|sendgrid|postmark|ses\b|s3/i.test(e)) return { code: 'PROVIDER', sentence: 'A provider (messaging, email or storage) refused the request or did not answer.', retryHelps: true };
  return { code: 'UNEXPECTED', sentence: 'The job failed with an unexpected error. The technical detail below helps support.', retryHelps: true };
}

export type ReconcileState = 'sending' | 'awaiting_recovery' | 'checking_provider' | 'unresolved';

/** Where a message in dispatching / dispatch_unknown is in the recovery path (R-GATE-8; never resent). */
export function reconcileState(status: 'dispatching' | 'dispatch_unknown', dispatchedAt: Date | null, now: Date): { state: ReconcileState; sentence: string; nextStepAt: string | null } {
  const at = dispatchedAt?.getTime() ?? now.getTime();
  const age = now.getTime() - at;
  const iso = (ms: number) => new Date(ms).toISOString();
  if (status === 'dispatching') {
    if (age < 20 * 60_000) return { state: 'sending', sentence: 'Sending now. If the sender stopped part-way, this is checked automatically 20 minutes after sending started.', nextStepAt: iso(at + 20 * 60_000) };
    return { state: 'awaiting_recovery', sentence: 'The sender stopped part-way. The next sweep marks it unknown and asks the provider whether it left. It is never sent twice automatically.', nextStepAt: null };
  }
  if (age < 10 * 60_000) return { state: 'checking_provider', sentence: 'We do not know yet whether it left. We are asking the provider; it is never sent twice automatically.', nextStepAt: iso(at + 10 * 60_000) };
  return { state: 'unresolved', sentence: 'The provider has no record of it. It will be marked failed so someone can decide to send it again by hand.', nextStepAt: null };
}
