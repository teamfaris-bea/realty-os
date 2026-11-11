// Annual-date reminder tasks (PARITY_PLAN module 67; R-PAR-20, E176).
//
// For every live, owned person with a value in an `annual` date field (birthday, home anniversary), when
// the next occurrence (core nextAnnualOccurrence, in the TENANT's timezone; 29 February falls on 28 February
// in non-leap years) is within ANNUAL_REMINDER_LEAD_DAYS, one task "<Field label> coming up" is created,
// assigned to the person's owner, due on the occurrence day (all day, the tenant's zone).
//
// Exactly one task per person, field and occurrence: the task id is derived from that triple (ids.ts), so a
// rerun, a second worker or a crash-and-retry inserts nothing new (ON CONFLICT on the primary key). A task
// the owner completed or canceled is never re-created for the same occurrence; next year's occurrence is
// a new key. It never sends anything (R-PAR-20): a send needs a playbook.
//
// People without an owner (pond, offered) get no task: there is nobody to assign it to. VERIFY against FUB.
import { type Instant, type LocalDate, localDate, localDateOf, localTime, plusMs, resolveLocal, zone } from '@realty/core/foundation';
import { DAY_MS } from '@realty/core/foundation';
import { nextAnnualOccurrence } from '@realty/core/parity/people';
import type { Tx } from '@realty/db';
import { annualTaskId } from './ids.js';
import * as R from './repos.js';

/** How many days before the date the reminder appears (VERIFY: FUB's default reminder lead). */
export const ANNUAL_REMINDER_LEAD_DAYS = 7;
const PAGE = 500;

/**
 * The month-days ("MM-DD") whose next occurrence is within [today, today + lead] in `tz`. A stored 29
 * February is included when 28 February is in the window of a non-leap year (it falls on 28 February).
 */
export function monthDaysInWindow(now: Instant, tz: string, leadDays: number): string[] {
  const z = zone(tz);
  const out = new Set<string>();
  // walk local days by noon instants (no DST edge can skip or repeat a local date)
  const startNoon = resolveLocal(localDateOf(now, z), localTime('12:00'), z, 'earlier');
  for (let i = 0; i <= leadDays; i++) {
    const d = localDateOf(plusMs(startNoon, i * DAY_MS), z);
    const md = d.slice(5);
    out.add(md);
    const y = Number(d.slice(0, 4));
    const leap = (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
    if (md === '02-28' && !leap) out.add('02-29');
  }
  return [...out].sort();
}

/** Whole local days from today to `d` (both in `tz`). */
function daysUntil(now: Instant, tz: string, d: LocalDate): number {
  const today = localDateOf(now, zone(tz));
  return Math.round((Date.parse(`${d}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY_MS);
}

export interface AnnualPlan {
  occurrence: LocalDate;
  taskId: string;
  title: string;
  dueAt: Instant;
}

/** Pure: the reminder for one value now, or null when the next occurrence is beyond the lead window. */
export function planAnnualReminder(v: { contactId: string; fieldId: string; label: string; date: string }, tz: string, now: Instant, leadDays = ANNUAL_REMINDER_LEAD_DAYS): AnnualPlan | null {
  const z = zone(tz);
  const occurrence = nextAnnualOccurrence(localDate(v.date), z, now);
  if (daysUntil(now, tz, occurrence) > leadDays) return null;
  return {
    occurrence,
    taskId: annualTaskId(v.contactId, v.fieldId, occurrence),
    title: `${v.label} coming up`.slice(0, 300),
    dueAt: resolveLocal(occurrence, localTime('09:00'), z, 'earlier'),
  };
}

/** One pass for the tenant of `tx` (the system actor). Returns the number of tasks created. */
export async function createAnnualRemindersInTx(tx: Tx, now: Instant, leadDays = ANNUAL_REMINDER_LEAD_DAYS): Promise<number> {
  const tz = await R.tenantTimezone(tx);
  const mds = monthDaysInWindow(now, tz, leadDays);
  let created = 0;
  let after: { contactId: string; fieldId: string } | null = null;
  for (;;) {
    const rows: R.AnnualValueRow[] = await R.annualValues(tx, mds, after, PAGE);
    for (const v of rows) {
      const plan = planAnnualReminder(v, tz, now, leadDays);
      if (!plan) continue;
      if (await R.insertAnnualTask(tx, { id: plan.taskId, assigneeUserId: v.ownerUserId, contactId: v.contactId, title: plan.title, dueAt: plan.dueAt, dueTz: tz })) created++;
    }
    if (rows.length < PAGE) return created;
    const last = rows[rows.length - 1]!;
    after = { contactId: last.contactId, fieldId: last.fieldId };
  }
}
