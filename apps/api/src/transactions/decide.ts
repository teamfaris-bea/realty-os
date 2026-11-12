// Pure decisions of api/transactions (no I/O; the property tests drive these directly).
//
//   reminderFact(date, recipients)  the one deal_date_upcoming fact a due reminder becomes, or why none
//   staleRuns(date, runs)            which scheduled firings of a date no longer match it, with the visible reason
import type { Instant } from '@realty/core/foundation';
import type { Fact } from '@realty/core/nurture';
import { type DealDate, drivesUpdates } from '@realty/core/transactions';
import type { RunSkipReason } from '../nurture/decide.js';
import { KIND_TEXT } from './types.js';

export interface Recipient {
  contactId: string;
  ownerUserId: string | null;
  live: boolean;
  roles: readonly string[];
}

export type ReminderDecision =
  | { fire: true; fact: Extract<Fact, { kind: 'deal_date_upcoming' }>; rels: { contactId: string; ownerUserId: string | null; relation: { kind: 'contact' }; dealRoles: readonly string[] }[] }
  | { fire: false; reason: 'NOT_DRIVING' | 'NO_REMINDER' | 'NOT_DUE' };

/** A due reminder of a date that still drives updates becomes one fact at its stored reminder_at (finding 1). */
export function reminderFact(d: DealDate & { dealId: string }, recipients: readonly Recipient[], now: Instant): ReminderDecision {
  if (!drivesUpdates(d) || d.dueAt === null) return { fire: false, reason: 'NOT_DRIVING' };
  if (d.reminderAt === null) return { fire: false, reason: 'NO_REMINDER' };
  if (d.reminderAt > now) return { fire: false, reason: 'NOT_DUE' };
  const rels = recipients.filter((c) => c.live).map((c) => ({ contactId: c.contactId, ownerUserId: c.ownerUserId, relation: { kind: 'contact' as const }, dealRoles: c.roles }));
  return {
    fire: true,
    fact: { kind: 'deal_date_upcoming', dealId: d.dealId, dealDateId: d.id, dueVersion: d.dueVersion, dueAt: d.dueAt, label: d.label ?? KIND_TEXT[d.kind], contactIds: rels.map((x) => x.contactId), at: d.reminderAt },
    rels,
  };
}

/** The scheduled firings of a date that no longer match it (null date: gone). */
export function staleRuns<R extends { dueVersion: number }>(d: Pick<DealDate, 'status' | 'completedAt' | 'dueAt' | 'dueVersion'> | null, runs: readonly R[]): { run: R; reason: RunSkipReason }[] {
  const reason: RunSkipReason | null = d === null ? 'FACT_GONE' : d.completedAt !== null ? 'DATE_COMPLETED' : d.status !== 'confirmed' ? 'DATE_UNCONFIRMED' : null;
  return runs.flatMap((run): { run: R; reason: RunSkipReason }[] => (reason !== null ? [{ run, reason }] : run.dueVersion !== d!.dueVersion ? [{ run, reason: 'DATE_CHANGED' }] : []));
}
