// Adversarial tests of core/transactions (PHASE2_3_PLAN §5: critical modules try to break the
// autonomy and confirmation rules). The money, opt-out and fair-housing rules have no surface in
// this module: it computes dates and never sends, prices or words anything. Tenancy is the API's
// and the database's (RLS); core takes no tenant input it could confuse.
import { describe, expect, it } from 'vitest';
import { type DealDateId, type UserId, at, localDate, zone } from '../foundation/index.js';
import { confirmDate, drivesUpdates, repairInstants } from './confirm.js';
import { businessDayCalendar } from './dates.js';
import { parseMilestoneTemplates, planMilestones } from './plan.js';
import { milestoneRisk } from './risk.js';
import type { DealDate, MilestoneTemplate } from './types.js';

const NY = zone('America/New_York');
const cal = businessDayCalendar({});
const now = at('2026-06-01T12:00:00Z');
const base: MilestoneTemplate = {
  id: 't',
  version: 1,
  name: 'T',
  side: 'buy',
  jurisdiction: 'US-NY',
  reviewed: false,
  rules: [{ key: 'closing', kind: 'closing', offsetDays: 30, dayCount: 'calendar', reminderDaysBefore: 2 }],
};

describe('adversarial: autonomy and confirmation (R-TXN-1)', () => {
  it('R-TXN-1: a template cannot smuggle a confirmed status, instants or a confirmer into a proposal', () => {
    const hostile = { ...base, rules: [{ ...base.rules[0], status: 'confirmed', dueAt: '2026-01-01', confirmedBy: 'u' }] };
    expect(parseMilestoneTemplates([hostile]).templates).toEqual([]);
    const r = planMilestones({ kind: 'acceptance', date: localDate('2026-06-01') }, hostile as unknown as MilestoneTemplate, cal);
    expect(r.ok).toBe(false);
  });

  it('R-TXN-1: a proposal never drives updates or risks, even long overdue', () => {
    const r = planMilestones({ kind: 'acceptance', date: localDate('2020-01-01') }, base, cal);
    if (!r.ok) throw new Error(r.code);
    const p = r.proposals[0];
    if (p === undefined) throw new Error('no proposal');
    const asRow: DealDate = {
      id: 'dd' as DealDateId,
      kind: p.kind,
      label: p.label,
      dueOn: p.dueOn,
      source: 'template',
      status: 'proposed',
      dueVersion: 1,
      dueAt: at('2020-02-01T00:00:00Z'), // even if a writer stored an instant
      reminderAt: null,
      completedAt: null,
      responsible: null,
      basis: p.basis,
    };
    expect(drivesUpdates(asRow)).toBe(false);
    expect(milestoneRisk(asRow, now)).toBeNull();
    expect(repairInstants(asRow, NY, now)).toBeNull();
  });

  it('R-TXN-1: the system (a job, the assistant) cannot confirm or move a date, under any source', () => {
    for (const source of ['manual', 'template', 'document', 'import'] as const) {
      expect(confirmDate(null, { actor: { kind: 'system' }, dueOn: localDate('2026-07-01'), source, now }, NY)).toMatchObject({ ok: false, code: 'DATE_HUMAN_CONFIRMATION' });
    }
    // an actor object pretending to be a user without the user kind is still refused
    const fake = { kind: 'assistant', userId: 'u' as UserId } as unknown as { kind: 'system' };
    expect(confirmDate(null, { actor: fake, dueOn: localDate('2026-07-01'), source: 'manual', now }, NY).ok).toBe(false);
  });

  it('R-TXN-5: the system repair cannot move a date or its version', () => {
    const d: DealDate = {
      id: 'dd' as DealDateId,
      kind: 'closing',
      label: null,
      dueOn: localDate('2026-06-30'),
      source: 'manual',
      status: 'confirmed',
      dueVersion: 7,
      dueAt: null,
      reminderAt: null,
      completedAt: null,
      responsible: null,
      basis: {},
    };
    const r = repairInstants(d, NY, now);
    expect(r).not.toBeNull();
    expect(Object.keys(r ?? {}).sort()).toEqual(['basis', 'dueAt', 'reminderAt']);
  });

  it('R-OWN-27: a hostile stored basis zone does not crash the repair; it falls back to the tenant zone', () => {
    const d: DealDate = {
      id: 'dd' as DealDateId,
      kind: 'closing',
      label: null,
      dueOn: localDate('2026-06-30'),
      source: 'manual',
      status: 'confirmed',
      dueVersion: 1,
      dueAt: null,
      reminderAt: null,
      completedAt: null,
      responsible: null,
      basis: { kind: 'manual', zone: 'Not/AZone', dueRule: 'end_of_local_day', reminderRule: null } as never,
    };
    expect(repairInstants(d, NY, now)?.basis.zone).toBe('America/New_York');
  });

  it('R-TXN-6: a template is unreviewed unless review is recorded; prototype keys are rejected', () => {
    const polluted = JSON.parse('{"id":"p","version":1,"name":"P","side":"buy","jurisdiction":"US-NY","rules":[{"key":"closing","kind":"closing","offsetDays":1,"dayCount":"calendar"}],"__proto__":{"reviewed":true}}') as unknown;
    const { templates, invalid } = parseMilestoneTemplates([polluted]);
    // strict schema: the extra own key is refused rather than merged
    expect(templates.length + invalid.length).toBe(1);
    for (const t of templates) expect(t.reviewed).toBe(false);
    expect(({} as { reviewed?: boolean }).reviewed).toBeUndefined();
  });

  it('a huge offset or a business-day count with no business days cannot hang planning', () => {
    expect(parseMilestoneTemplates([{ ...base, rules: [{ key: 'x', kind: 'closing', offsetDays: 1e9, dayCount: 'business' }] }]).invalid).toHaveLength(1);
    expect(() => businessDayCalendar({ days: [] })).toThrow();
  });
});
