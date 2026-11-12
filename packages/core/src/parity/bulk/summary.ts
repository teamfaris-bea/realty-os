// Counts and the bulk_finished sentence (PARITY_PLAN module 62; R-PAR-41).
//
// "Emailed 398 of 412: 9 unsubscribed, 5 no email". Every number shows its denominator; every skipped
// person is counted under a reason, never hidden. Text only from codes and counts: no names, no
// addresses (the notification never carries PII).
import type { BulkKind } from './caps.js';
import type { SkipReason } from './preflight.js';

export type ItemStatus = 'pending' | 'done' | 'skipped' | 'blocked' | 'failed' | 'canceled';

/** `bulk_actions.counts`: done / skipped / blocked / failed / canceled, and skips by reason. */
export interface BulkCounts {
  /** people selected, before preflight (the denominator) */
  selected: number;
  done: number;
  skipped: number;
  blocked: number;
  failed: number;
  canceled: number;
  pending: number;
  /** reason code → number of people (preflight skips included) */
  byReason: Record<string, number>;
}

export function emptyCounts(selected: number): BulkCounts {
  return { selected, done: 0, skipped: 0, blocked: 0, failed: 0, canceled: 0, pending: 0, byReason: {} };
}

/** Folds item outcomes (and preflight skips) into counts. Pure; order-independent. */
export function tally(selected: number, preflightSkips: Readonly<Record<string, number>>, items: readonly { status: ItemStatus; reasonCode: string | null }[]): BulkCounts {
  const c = emptyCounts(selected);
  for (const [r, n] of Object.entries(preflightSkips)) {
    if (!Number.isInteger(n) || n <= 0) continue;
    c.skipped += n;
    c.byReason[r] = (c.byReason[r] ?? 0) + n;
  }
  for (const it of items) {
    c[it.status] += 1;
    if (it.status !== 'done' && it.status !== 'pending' && it.reasonCode) c.byReason[it.reasonCode] = (c.byReason[it.reasonCode] ?? 0) + 1;
  }
  return c;
}

const VERB: Readonly<Record<BulkKind, string>> = Object.freeze({
  tag: 'Tagged',
  untag: 'Untagged',
  stage: 'Moved',
  assign: 'Assigned',
  enroll: 'Enrolled',
  email: 'Emailed',
  text: 'Texted',
});

/** Short, plain phrases for each reason, as they read after a count ("9 unsubscribed"). */
export const REASON_PHRASES: Readonly<Record<SkipReason, string>> = Object.freeze({
  NOT_VISIBLE: 'no longer yours to reach',
  MERGED: 'merged',
  DELETED: 'deleted',
  NOT_PERMITTED: 'not allowed for your role',
  NO_ADDRESS: 'no address',
  SHARED_ADDRESS: 'share an address with someone already included',
  RECIPIENT_OPTED_OUT: 'opted out',
  RECIPIENT_SUPPRESSED: 'suppressed (bounce or complaint)',
  PERSON_DO_NOT_CONTACT: 'do not contact',
  RECENT_INBOUND: 'wrote in the last 24 hours',
  MERGE_FIELD_EMPTY: 'missing a merge field',
  ALREADY_TAGGED: 'already tagged',
  NOT_TAGGED: 'not tagged',
  TAG_LIMIT: 'at the tag limit',
  ALREADY_IN_STAGE: 'already in that stage',
  STAGE_NEEDS_CONTACT: 'not reached yet',
  ALREADY_OWNER: 'already theirs',
  CLOSED: 'closed (reopen to assign)',
  ALREADY_ENROLLED: 'already enrolled',
  UNREACHABLE: 'unreachable',
  CLIENT_REPLIED: 'replied before sending',
  BATCH_TEXT_DISABLED: 'batch text turned off',
  CANCELED: 'canceled',
  CREATOR_INACTIVE: 'stopped (account inactive)',
  SEND_BLOCKED: 'blocked at send',
});

/** A reason code the creator may not have a phrase for (an engine rejection code) reads as itself. */
export function reasonPhrase(code: string): string {
  return (REASON_PHRASES as Record<string, string>)[code] ?? code.toLowerCase().replace(/_/g, ' ');
}

/**
 * The bulk_finished title, e.g. "Emailed 398 of 412: 9 opted out, 5 no address". Reasons are listed
 * largest first (ties by code), at most five, then "and N more".
 */
export function finishedSentence(kind: BulkKind, c: BulkCounts, outcome: 'completed' | 'canceled' | 'failed' = 'completed'): string {
  const head = `${VERB[kind]} ${c.done} of ${c.selected}`;
  const reasons = Object.entries(c.byReason)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
  const shown = reasons.slice(0, 5).map(([r, n]) => `${n} ${reasonPhrase(r)}`);
  const more = reasons.length > 5 ? reasons.slice(5).reduce((s, [, n]) => s + n, 0) : 0;
  const tail = shown.length > 0 ? `: ${shown.join(', ')}${more > 0 ? `, and ${more} more` : ''}` : '';
  const prefix = outcome === 'canceled' ? 'Canceled. ' : outcome === 'failed' ? 'Stopped. ' : '';
  return `${prefix}${head}${tail}`.slice(0, 200);
}
