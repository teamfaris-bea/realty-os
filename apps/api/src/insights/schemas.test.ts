// R-OWNER-4 / R-AST-13 / R-TEN-3 response shapes of api/insights, R-OWNER-1 denominators and methods, and property
// tests of the calendar decisions the module makes (ISO weeks, goal period starts, the closed-month rule).
import { type LocalDate, localDate } from '@realty/core/foundation';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { addDaysLocal, addMonthsYm, isoWeekOf, isoWeekday, mondayOf, mondayOfIsoWeek, monthsBetween, nextMonthStart } from './common.js';
import { validPeriodStart } from './goals.js';
import { ForecastResponse, INSIGHTS_RESPONSE_SCHEMAS, SourcesResponse, VelocityResponse } from './schemas.js';

describe('R-OWNER-4 R-AST-13 R-TEN-3 response schemas', () => {
  it('R-OWNER-4 R-AST-13 R-TEN-3: no insights response has a confidence, probability or score field, and none carries a tenant id (snapshot)', () => {
    const shapes: Record<string, unknown> = {};
    for (const [name, schema] of Object.entries(INSIGHTS_RESPONSE_SCHEMAS)) {
      const json = z.toJSONSchema(schema);
      const text = JSON.stringify(json);
      expect(text, name).not.toMatch(/confiden|probabil|"score|grade/i);
      expect(text, name).not.toMatch(/"tenant_id"|"tenantId"/);
      shapes[name] = json;
    }
    expect(shapes).toMatchSnapshot();
  });

  it('R-OWNER-1: every owner-view number travels with its denominator and the section carries its method sentence', () => {
    const props = (s: z.ZodType, path: string[]) => {
      let j = z.toJSONSchema(s) as { properties?: Record<string, unknown>; items?: unknown };
      for (const p of path) j = (j.properties?.[p] ?? (j as { items?: unknown }).items) as typeof j;
      if ((j as { items?: unknown }).items) j = (j as { items: typeof j }).items;
      return Object.keys(j.properties ?? {});
    };
    expect(props(SourcesResponse, [])).toEqual(expect.arrayContaining(['method', 'closedInPeriod', 'excluded']));
    // each money figure has its count: commission ← closings + dealsWithCommission; cost ← costRows; cost per closing ← closings + words
    expect(props(SourcesResponse, ['rows'])).toEqual(expect.arrayContaining(['commissionCents', 'closings', 'dealsWithCommission', 'missingCommission', 'commissionWords', 'costCents', 'costRows', 'costWords', 'costPerClosingCents', 'costPerClosingWords']));
    expect(props(VelocityResponse, [])).toEqual(expect.arrayContaining(['method', 'minSample', 'excluded']));
    expect(props(VelocityResponse, ['rows'])).toEqual(expect.arrayContaining(['medianDays', 'sampleSize', 'words']));
    expect(props(ForecastResponse, ['closings'])).toEqual(expect.arrayContaining(['low', 'high', 'method', 'samples', 'countedDeals', 'excluded', 'horizonDays']));
    expect(props(ForecastResponse, ['closings', 'samples'])).toEqual(['stage', 'n', 'k']);
    expect(props(ForecastResponse, ['closings', 'excluded'])).toEqual(expect.arrayContaining(['thinStages', 'thinStageDeals', 'noCommission', 'noSource']));
  });
});

const day = fc.date({ min: new Date('1990-01-01T00:00:00Z'), max: new Date('2090-12-31T00:00:00Z'), noInvalidDate: true }).map((d) => localDate(d.toISOString().slice(0, 10)));

describe('R-PLAN-1 the plan week (property)', () => {
  it('R-PLAN-1: every local date belongs to exactly the ISO week whose Monday is its Monday; the label round-trips; consecutive Mondays are consecutive weeks', () => {
    fc.assert(
      fc.property(day, (d: LocalDate) => {
        const wk = isoWeekOf(d);
        expect(wk).toMatch(/^\d{4}-W\d{2}$/);
        expect(mondayOfIsoWeek(wk)).toBe(mondayOf(d));
        expect(isoWeekday(mondayOf(d))).toBe(1);
        for (let i = 0; i < 7; i++) expect(isoWeekOf(addDaysLocal(mondayOf(d), i))).toBe(wk);
        expect(isoWeekOf(addDaysLocal(mondayOf(d), 7))).not.toBe(wk);
      }),
      { numRuns: 400 },
    );
    expect(isoWeekOf(localDate('2026-11-11'))).toBe('2026-W46');
    expect(isoWeekOf(localDate('2021-01-03'))).toBe('2020-W53');
    expect(mondayOfIsoWeek('2025-W53')).toBeNull(); // 2025 has 52 ISO weeks: a week that is not real is refused
    expect(mondayOfIsoWeek('2026-W53')).toBe('2026-12-28');
    expect(mondayOfIsoWeek('2020-W53')).toBe('2020-12-28');
  });
});

describe('R-PLAN-2 goal periods (property)', () => {
  it('R-PLAN-2: a goal period starts only where its kind starts', () => {
    fc.assert(
      fc.property(day, (d: LocalDate) => {
        const [, m, dd] = d.split('-').map(Number) as [number, number, number];
        expect(validPeriodStart('week', d)).toBe(isoWeekday(d) === 1);
        expect(validPeriodStart('month', d)).toBe(dd === 1);
        expect(validPeriodStart('quarter', d)).toBe(dd === 1 && [1, 4, 7, 10].includes(m));
        expect(validPeriodStart('year', d)).toBe(dd === 1 && m === 1);
      }),
      { numRuns: 400 },
    );
  });

  it('R-OWNER-2: month arithmetic of the owner-view period is consistent (shift, span and the next month’s first day)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1990, max: 2090 }), fc.integer({ min: 1, max: 12 }), fc.integer({ min: -30, max: 30 }), (y, m, n) => {
        const ym = `${y}-${String(m).padStart(2, '0')}`;
        const shifted = addMonthsYm(ym, n);
        expect(monthsBetween(n >= 0 ? ym : shifted, n >= 0 ? shifted : ym)).toBe(Math.abs(n) + 1);
        expect(nextMonthStart(ym)).toBe(`${addMonthsYm(ym, 1)}-01`);
      }),
    );
  });
});
