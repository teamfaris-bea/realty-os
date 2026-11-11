// Test fixtures for core/insights (used only by *.test.ts; excluded from coverage).
import {
  type AgentGoalId,
  type AppointmentId,
  type ContactId,
  DAY_MS,
  type DealId,
  type Instant,
  type LeadSourceId,
  type TaskId,
  type UserId,
  at,
  instant,
  zone,
} from '../../foundation/index.js';

export const NOW: Instant = at('2026-11-11T17:00:00Z');
export const NY = zone('America/New_York');
export const ME = 'u-0001' as UserId;

export const deal = (n: number): DealId => `d-${String(n).padStart(4, '0')}` as DealId;
export const src = (n: number): LeadSourceId => `s-${String(n).padStart(4, '0')}` as LeadSourceId;
export const contact = (n: number): ContactId => `c-${String(n).padStart(4, '0')}` as ContactId;
export const task = (n: number): TaskId => `t-${String(n).padStart(4, '0')}` as TaskId;
export const appt = (n: number): AppointmentId => `a-${String(n).padStart(4, '0')}` as AppointmentId;
export const goalId = (n: number): AgentGoalId => `g-${String(n).padStart(4, '0')}` as AgentGoalId;

/** NOW minus `d` days. */
export const daysAgo = (d: number): Instant => instant(NOW - d * DAY_MS);
export const daysFromNow = (d: number): Instant => instant(NOW + d * DAY_MS);

/** Recursively collects every object key in a value. */
export function allKeys(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) for (const x of v) allKeys(x, out);
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      allKeys(x, out);
    }
  }
  return out;
}
