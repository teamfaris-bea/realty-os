// Bulk action kinds and caps (PARITY_PLAN module 62; Q-PAR-5, Q-PAR-7; R-PAR-33, R-PAR-40).
//
// Owner question Q-PAR-7 (default in force until decided): tag/untag 10,000; stage, enroll, email and
// assign 2,000; batch text 200 (also the DB ceiling, R-PAR-40); and a per-tenant daily bulk-email cap
// of 2,000 recipients. The caps apply to the number of people SELECTED, before anyone is skipped, so a
// cap is never dodged by a large selection that happens to skip most people.
import { type Result, fail, ok } from '../../foundation/index.js';

export const BULK_KINDS = ['tag', 'untag', 'stage', 'assign', 'enroll', 'email', 'text'] as const;
export type BulkKind = (typeof BULK_KINDS)[number];

export function isBulkKind(s: string): s is BulkKind {
  return (BULK_KINDS as readonly string[]).includes(s);
}

/** Sends: one `messages` row per person through dispatchOutbound (R-PAR-36). */
export function isSendKind(k: BulkKind): k is 'email' | 'text' {
  return k === 'email' || k === 'text';
}

export const BULK_CAPS: Readonly<Record<BulkKind, number>> = Object.freeze({
  tag: 10_000,
  untag: 10_000,
  stage: 2_000,
  assign: 2_000,
  enroll: 2_000,
  email: 2_000,
  text: 200,
});

/** Per tenant, per local calendar day, recipients of confirmed bulk emails (Q-PAR-7). */
export const DAILY_BULK_EMAIL_CAP = 2_000;

export type CapErrorCode = 'BULK_EMPTY' | 'BULK_TOO_LARGE' | 'BULK_DAILY_EMAIL_CAP';

/** The size of a selection for a kind (`selected` = people chosen, before skips). */
export function checkBulkSize(kind: BulkKind, selected: number): Result<object, CapErrorCode, { cap?: number }> {
  if (!Number.isInteger(selected) || selected <= 0) return fail('BULK_EMPTY');
  const cap = BULK_CAPS[kind];
  if (selected > cap) return fail('BULK_TOO_LARGE', { cap });
  return ok();
}

/**
 * The tenant's daily bulk-email cap: `alreadyToday` recipients were confirmed today (any creator), and
 * this action would add `adding`. Fails closed on nonsense input.
 */
export function checkDailyEmailCap(alreadyToday: number, adding: number): Result<object, CapErrorCode, { cap?: number; remaining?: number }> {
  if (!Number.isInteger(alreadyToday) || !Number.isInteger(adding) || alreadyToday < 0 || adding < 0) return fail('BULK_DAILY_EMAIL_CAP', { cap: DAILY_BULK_EMAIL_CAP, remaining: 0 });
  if (alreadyToday + adding > DAILY_BULK_EMAIL_CAP) return fail('BULK_DAILY_EMAIL_CAP', { cap: DAILY_BULK_EMAIL_CAP, remaining: Math.max(0, DAILY_BULK_EMAIL_CAP - alreadyToday) });
  return ok();
}
