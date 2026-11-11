import { describe, expect, it } from 'vitest';
import { localDate } from '../foundation/index.js';
import { addBusinessDays, addCalendarDays, businessDayCalendar, daysBetween, nonBusinessDay, weekdayOfDate } from './dates.js';
import { parseMilestoneTemplates, planMilestones, templatesFor } from './plan.js';
import type { MilestoneTemplate } from './types.js';

const cal = businessDayCalendar({ holidays: { '2026-07-03': 'Independence Day (observed)', '2026-12-25': 'Christmas Day' }, source: 'tenant_settings' });

const buyTemplate: MilestoneTemplate = {
  id: 'tx-buy',
  version: 3,
  name: 'Buyer resale (example)',
  side: 'buy',
  jurisdiction: 'US-TX',
  reviewed: false,
  rules: [
    { key: 'closing', kind: 'closing', offsetDays: 30, dayCount: 'calendar', responsible: 'title', reminderDaysBefore: 3 },
    { key: 'inspection', kind: 'inspection', offsetDays: 7, dayCount: 'business', responsible: 'buyer', reminderDaysBefore: 1 },
    { key: 'appraisal', kind: 'appraisal', offsetDays: 14, dayCount: 'calendar' },
    { key: 'walkthrough', kind: 'custom', label: 'Final walkthrough', offsetDays: 29, dayCount: 'calendar' },
  ],
};

describe('local-date arithmetic', () => {
  it('adds calendar days across month, year and leap boundaries', () => {
    expect(addCalendarDays(localDate('2026-01-31'), 1)).toBe('2026-02-01');
    expect(addCalendarDays(localDate('2028-02-28'), 1)).toBe('2028-02-29');
    expect(addCalendarDays(localDate('2026-12-31'), 1)).toBe('2027-01-01');
    expect(addCalendarDays(localDate('2026-03-01'), -1)).toBe('2026-02-28');
    expect(daysBetween(localDate('2026-03-01'), localDate('2026-04-01'))).toBe(31);
  });

  it('local dates never shift across a DST change (dates have no zone)', () => {
    // 2026-03-08 is the US spring-forward day; 2026-11-01 the fall-back day.
    expect(addCalendarDays(localDate('2026-03-07'), 2)).toBe('2026-03-09');
    expect(addCalendarDays(localDate('2026-10-31'), 2)).toBe('2026-11-02');
  });

  it('weekday of a date', () => {
    expect(weekdayOfDate(localDate('2026-11-11'))).toBe(3); // Wednesday
    expect(weekdayOfDate(localDate('2026-11-15'))).toBe(7); // Sunday
  });

  it('business days: day 1 is the first business day after the anchor; weekends and holidays are skipped', () => {
    // Wed 2026-07-01 + 2 business days: Thu 07-02 (1), Fri 07-03 holiday, Sat, Sun, Mon 07-06 (2)
    expect(addBusinessDays(localDate('2026-07-01'), 2, cal)).toBe('2026-07-06');
    expect(addBusinessDays(localDate('2026-07-04'), 0, cal)).toBe('2026-07-04');
    expect(addBusinessDays(localDate('2026-11-13'), 1, cal)).toBe('2026-11-16'); // Fri → Mon
  });

  it('rejects calendar data that has no business day', () => {
    expect(() => businessDayCalendar({ days: [] })).toThrow(RangeError);
    expect(() => addBusinessDays(localDate('2026-01-01'), -1, cal)).toThrow(RangeError);
  });
});

describe('planMilestones', () => {
  it('R-TXN-1: every planned date is a proposal that drives nothing until a person confirms it', () => {
    const r = planMilestones({ kind: 'acceptance', date: localDate('2026-06-01') }, buyTemplate, cal);
    if (!r.ok) throw new Error(r.code);
    expect(r.proposals).toHaveLength(4);
    for (const p of r.proposals) {
      expect(p.status).toBe('proposed');
      expect(p.source).toBe('template');
      expect(p).not.toHaveProperty('dueAt');
      expect(p).not.toHaveProperty('reminderAt');
    }
  });

  it('computes each rule and shows the basis, ordered by due date', () => {
    const r = planMilestones({ kind: 'acceptance', date: localDate('2026-06-01') }, buyTemplate, cal);
    if (!r.ok) throw new Error(r.code);
    expect(r.proposals.map((p) => [p.ruleKey, p.dueOn])).toEqual([
      ['inspection', '2026-06-10'], // Mon + 7 business days
      ['appraisal', '2026-06-15'],
      ['walkthrough', '2026-06-30'],
      ['closing', '2026-07-01'],
    ]);
    const insp = r.proposals[0];
    expect(insp?.basis).toMatchObject({
      kind: 'template',
      templateId: 'tx-buy',
      templateVersion: 3,
      ruleKey: 'inspection',
      rule: '7 business days after acceptance (2026-06-01)',
      calendarSource: 'tenant_settings',
      calendarReviewed: false,
    });
    expect(r.proposals[2]?.label).toBe('Final walkthrough');
    expect(r.proposals[3]?.responsible).toBe('title');
    expect(r.proposals[3]?.reminderDaysBefore).toBe(3);
  });

  it('E95 R-TXN-6: a template date on a holiday is shown with its rule and a note, never silently moved', () => {
    const t: MilestoneTemplate = { ...buyTemplate, rules: [{ key: 'inspection', kind: 'inspection', offsetDays: 2, dayCount: 'calendar' }] };
    const r = planMilestones({ kind: 'acceptance', date: localDate('2026-07-01') }, t, cal);
    if (!r.ok) throw new Error(r.code);
    const p = r.proposals[0];
    expect(p?.dueOn).toBe('2026-07-03');
    expect(p?.nonBusinessDay).toMatchObject({ reason: 'holiday', holiday: 'Independence Day (observed)' });
    expect(p?.nonBusinessDay?.note).toContain('not moved');
    expect(p?.basis.rule).toBe('2 days after acceptance (2026-07-01)');
  });

  it('E95: a calendar-day date on a weekend is flagged, not rolled', () => {
    const t: MilestoneTemplate = { ...buyTemplate, rules: [{ key: 'option', kind: 'custom', label: 'Option period ends', offsetDays: 5, dayCount: 'calendar' }] };
    const r = planMilestones({ kind: 'acceptance', date: localDate('2026-11-09') }, t, cal);
    if (!r.ok) throw new Error(r.code);
    expect(r.proposals[0]?.dueOn).toBe('2026-11-14');
    expect(r.proposals[0]?.nonBusinessDay?.reason).toBe('weekend');
  });

  it('R-TXN-6: templates are tenant data, unreviewed unless review is recorded', () => {
    const { templates, invalid } = parseMilestoneTemplates([{ ...buyTemplate, reviewed: undefined }]);
    expect(invalid).toEqual([]);
    expect(templates[0]?.reviewed).toBe(false);
    const r = planMilestones({ kind: 'acceptance', date: localDate('2026-06-01') }, templates[0] as MilestoneTemplate, cal);
    if (!r.ok) throw new Error(r.code);
    expect(r.proposals.every((p) => p.basis.templateReviewed === false)).toBe(true);
  });

  it('R-TXN-6: an empty template list yields no plan (no state defaults are hard-coded)', () => {
    expect(parseMilestoneTemplates([])).toEqual({ templates: [], invalid: [] });
    expect(templatesFor([], 'buy', 'US-TX')).toEqual([]);
  });

  it('reports invalid templates instead of dropping them silently', () => {
    const { templates, invalid } = parseMilestoneTemplates([
      buyTemplate,
      { ...buyTemplate, id: 'dupe', rules: [buyTemplate.rules[0], buyTemplate.rules[0]] },
      { ...buyTemplate, id: 'custom-no-label', rules: [{ key: 'x', kind: 'custom', offsetDays: 1, dayCount: 'calendar' }] },
      { ...buyTemplate, id: 'anchor-rule', rules: [{ key: 'acc', kind: 'acceptance', offsetDays: 0, dayCount: 'calendar' }] },
      { ...buyTemplate, id: 'extra', extra: true },
      { ...buyTemplate, id: 'neg', rules: [{ key: 'x', kind: 'closing', offsetDays: -1, dayCount: 'calendar' }] },
    ]);
    expect(templates.map((t) => t.id)).toEqual(['tx-buy']);
    expect(invalid.map((i) => i.index)).toEqual([1, 2, 3, 4, 5]);
    expect(parseMilestoneTemplates({}).invalid).toHaveLength(1);
  });

  it('planMilestones refuses an invalid template', () => {
    const bad = { ...buyTemplate, rules: [] } as MilestoneTemplate;
    const r = planMilestones({ kind: 'acceptance', date: localDate('2026-06-01') }, bad, cal);
    expect(r).toMatchObject({ ok: false, code: 'TEMPLATE_INVALID' });
  });

  it('templatesFor matches side and jurisdiction exactly; dual sees buy and sell', () => {
    const sell = { ...buyTemplate, id: 'tx-sell', side: 'sell' as const };
    const other = { ...buyTemplate, id: 'ok-buy', jurisdiction: 'US-OK' };
    expect(templatesFor([buyTemplate, sell, other], 'buy', 'US-TX').map((t) => t.id)).toEqual(['tx-buy']);
    expect(templatesFor([buyTemplate, sell, other], 'dual', 'US-TX').map((t) => t.id)).toEqual(['tx-buy', 'tx-sell']);
    expect(templatesFor([buyTemplate], 'buy', 'us-tx')).toEqual([]);
  });

  it('nonBusinessDay is null on a business day', () => {
    expect(nonBusinessDay(localDate('2026-11-11'), cal)).toBeNull();
  });
});
