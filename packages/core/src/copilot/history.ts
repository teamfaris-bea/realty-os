// Reading a lead's activity log: which entries are human touches, inbound replies and signals (CP-2).
//
// A "touch" is a human agent reaching the lead: an outbound call, text or email logged by a person, or an
// appointment a person set. Automations, drips, action-plan steps and notes are NOT touches (a note is
// work about the lead, not contact with them). This is the definition the sales manager's daily audit uses.
import type { Instant } from '../foundation/index.js';
import type { CopilotActivity } from './types.js';

export function isHumanTouch(a: CopilotActivity): boolean {
  if (!a.byHuman) return false;
  if (a.kind === 'appointment') return true;
  return (a.kind === 'call' || a.kind === 'text' || a.kind === 'email') && a.direction === 'outbound';
}

/** The lead reaching out: an inbound call, text or email. */
export function isInboundReply(a: CopilotActivity): boolean {
  return (a.kind === 'call' || a.kind === 'text' || a.kind === 'email') && a.direction === 'inbound';
}

/** Interest signals from a quiet lead (slipping-lead-recovery: website visit, email open). */
export function isInterestSignal(a: CopilotActivity): boolean {
  return a.kind === 'web_visit' || a.kind === 'email_open';
}

/** Activities sorted oldest first; ties keep input order. Entries at or after `now` are ignored (clock skew). */
export function chronological(activities: readonly CopilotActivity[], now: Instant): CopilotActivity[] {
  return activities
    .map((a, i) => ({ a, i }))
    .filter(({ a }) => a.at <= now)
    .sort((x, y) => x.a.at - y.a.at || x.i - y.i)
    .map(({ a }) => a);
}

export function lastWhere(sorted: readonly CopilotActivity[], pred: (a: CopilotActivity) => boolean): CopilotActivity | null {
  for (let i = sorted.length - 1; i >= 0; i--) {
    const a = sorted[i];
    if (a !== undefined && pred(a)) return a;
  }
  return null;
}
