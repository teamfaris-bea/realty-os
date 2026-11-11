// Milestone risk (R-ACC-6, R-TXN-3): the `milestone_at_risk` exception predicate.
//
// A confirmed date with `completed_at` NULL is at risk when it is overdue (`due_at < now`), or due
// within 48 h (`due_at - now <= 48 h`) with no `responsible` party. Stored fields only; an
// unconfirmed (proposed or waived) date is never a risk; a confirmed date whose `due_at` has not
// been stored yet is not evaluated until the reconcile repair stores it (R-TXN-2). Module 18a calls
// this from `deriveExceptions` and owns the queue; deal-level risks are not flagged.
import { HOUR_MS, type Instant, instant } from '../foundation/index.js';
import { milestoneKey } from './keys.js';
import type { DealDate, MilestoneRisk, RiskPredicate } from './types.js';

export const DUE_SOON_MS = 48 * HOUR_MS;

export type RiskFacts = Pick<DealDate, 'id' | 'status' | 'completedAt' | 'dueAt' | 'dueVersion' | 'responsible'> & { label?: string | null };

export function milestoneRisk(d: RiskFacts, now: Instant): MilestoneRisk | null {
  if (d.status !== 'confirmed' || d.completedAt !== null || d.dueAt === null) return null;
  const predicates: RiskPredicate[] = [];
  if (d.dueAt < now) predicates.push('overdue');
  if (d.dueAt - now <= DUE_SOON_MS && d.responsible === null) predicates.push('due_soon_unassigned');
  const primary = predicates[0];
  if (primary === undefined) return null;
  const name = d.label ?? 'This milestone';
  const evidence =
    primary === 'overdue'
      ? `${name} was due ${new Date(d.dueAt).toISOString()} and is not marked done${predicates.length > 1 ? '; no one is responsible for it' : ''}.`
      : `${name} is due within 48 hours (${new Date(d.dueAt).toISOString()}) and no one is responsible for it.`;
  return {
    key: milestoneKey(d.id, d.dueVersion),
    dealDateId: d.id,
    dueVersion: d.dueVersion,
    predicates,
    // When the condition started holding, from stored fields (recomputing never moves it).
    detectedAt: primary === 'overdue' ? d.dueAt : instant(d.dueAt - DUE_SOON_MS),
    evidence,
  };
}
