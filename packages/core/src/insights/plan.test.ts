import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { localDate } from '../foundation/index.js';
import { ME, NY, appt, contact, daysAgo, daysFromNow, deal, goalId, task } from './testing/fixtures.js';
import {
  comparePlanItems,
  dropInvisible,
  planWeek,
  type AgentGoal,
  type ApptFacts,
  type Pace,
  type PlanTaskFacts,
  type PlanWeekInput,
  type PromiseFacts,
  type SlowDealFacts,
} from './index.js';

const promise = (n: number, dueDays: number | null, dnc = false): PromiseFacts => ({
  taskId: task(n),
  contactId: contact(n),
  title: `Send comps ${n}`,
  dueAt: dueDays === null ? null : daysFromNow(dueDays),
  doNotContact: dnc,
});
const taskF = (n: number, dueDays: number | null, kind: PlanTaskFacts['kind'] = 'follow_up', dnc = false): PlanTaskFacts => ({
  taskId: task(n),
  kind,
  contactId: contact(n),
  dealId: null,
  title: `Task ${n}`,
  dueAt: dueDays === null ? null : daysFromNow(dueDays),
  doNotContact: dnc,
});
const apptF = (n: number, dnc = false): ApptFacts => ({ appointmentId: appt(n), contactId: contact(n), startsAt: daysAgo(2), doNotContact: dnc });
const slow = (n: number, stage: SlowDealFacts['stage'] = 'under_contract', dnc = false): SlowDealFacts => ({
  dealId: deal(n),
  contactId: contact(n),
  name: `Deal ${n}`,
  stage,
  dwellDays: 21,
  medianDays: 12,
  sampleSize: 34,
  doNotContact: dnc,
});
const goal = (n: number, metric: AgentGoal['metric']): AgentGoal => ({
  id: goalId(n),
  userId: ME,
  periodKind: 'month',
  periodStart: localDate('2026-11-01'),
  metric,
  target: 10,
});
const pace = (n: number, metric: Pace['metric'], behindBy: number): Pace => ({
  goalId: goalId(n),
  metric,
  periodStart: localDate('2026-11-01'),
  periodEndExclusive: localDate('2026-12-01'),
  actual: 0,
  target: 10,
  expectedByNow: behindBy,
  behindBy,
  remaining: 10,
  daysLeft: 20,
  status: behindBy > 0 ? 'behind' : 'on_track',
  words: '',
});
const input = (p: Partial<PlanWeekInput>): PlanWeekInput => ({
  goals: [],
  pace: [],
  slowDeals: [],
  openPromises: [],
  apptsWithoutOutcome: [],
  tasks: [],
  zone: NY,
  ...p,
});

describe('R-PLAN-1 weekly plan', () => {
  it('R-PLAN-1: 3–5 items, deadline first (soonest first), then by gap to goal (larger first)', () => {
    const plan = planWeek(
      input({
        goals: [goal(1, 'closings'), goal(2, 'appointments_held')],
        pace: [pace(1, 'closings', 1), pace(2, 'appointments_held', 4)],
        openPromises: [promise(1, 3), promise(2, 1)],
        tasks: [taskF(3, 2)],
        slowDeals: [slow(4)],
        apptsWithoutOutcome: [apptF(5)],
      }),
    );
    expect(plan.basis).toBe('goals_and_pipeline');
    expect(plan.items.map((i) => i.evidence[0]?.sourceId)).toEqual([task(2), task(3), task(1), appt(5), deal(4)]);
    expect(plan.items.map((i) => i.gap)).toEqual([0, 0, 0, 4, 1]);
    expect(plan.candidates).toBe(5);
  });

  it('R-PLAN-1: every item has evidence with source type, id and a short human reason', () => {
    const plan = planWeek(
      input({ goals: [goal(1, 'closings')], pace: [pace(1, 'closings', 2)], slowDeals: [slow(4)], apptsWithoutOutcome: [apptF(5)], openPromises: [promise(1, 1)] }),
    );
    for (const it of plan.items) {
      expect(it.evidence.length).toBeGreaterThanOrEqual(1);
      for (const e of it.evidence) expect(e.reason.length).toBeGreaterThan(5);
    }
    const dealItem = plan.items.find((i) => i.kind === 'move_deal');
    expect(dealItem?.evidence).toEqual([
      { sourceType: 'deal', sourceId: deal(4), reason: 'Deal in under_contract for 21 days; median 12 (n=34); 2 closings behind goal pace' },
    ]);
    expect(plan.items.find((i) => i.kind === 'log_outcome')?.evidence[0]?.reason).toBe('Appointment on 2026-11-09 has no outcome logged');
    expect(plan.items.find((i) => i.kind === 'keep_promise')?.evidence[0]?.reason).toBe('Open promise, due 2026-11-12');
  });

  it('R-PLAN-1: never more than 5 items', () => {
    const plan = planWeek(input({ openPromises: [1, 2, 3, 4, 5, 6, 7].map((n) => promise(n, n)) }));
    expect(plan.items).toHaveLength(5);
    expect(plan.candidates).toBe(7);
  });

  it('R-PLAN-1: with fewer than 3 candidates the plan returns what exists and says so (no filler)', () => {
    const plan = planWeek(input({ goals: [goal(1, 'touches')], pace: [pace(1, 'touches', 1)], openPromises: [promise(1, 2)] }));
    expect(plan.items).toHaveLength(1);
    expect(plan.note).toContain('Only 1 item');
    expect(planWeek(input({})).items).toEqual([]);
  });

  it('R-PLAN-1: ties break by source id, deterministically, whatever the input order', () => {
    const a = planWeek(input({ slowDeals: [slow(3), slow(1), slow(2)] }));
    const b = planWeek(input({ slowDeals: [slow(2), slow(3), slow(1)] }));
    expect(a.items.map((i) => i.dealId)).toEqual([deal(1), deal(2), deal(3)]);
    expect(b.items).toEqual(a.items);
  });

  it('R-PLAN-1: a promise that is also in the task list is one item; a slow prospect deal moves agreements_signed', () => {
    const plan = planWeek(input({ openPromises: [promise(1, 1)], tasks: [taskF(1, 1, 'promise')], slowDeals: [slow(2, 'prospect')] }));
    expect(plan.items.filter((i) => i.evidence[0]?.sourceId === task(1))).toHaveLength(1);
    expect(plan.items.find((i) => i.kind === 'move_deal')?.metric).toBe('agreements_signed');
  });

  it('R-PLAN-1 E110: an agent with no goals gets a plan built from the pipeline only, which says so', () => {
    const plan = planWeek(input({ pace: [pace(9, 'closings', 5)], slowDeals: [slow(1)], openPromises: [promise(2, 1)], apptsWithoutOutcome: [apptF(3)] }));
    expect(plan.basis).toBe('pipeline_only');
    expect(plan.note).toContain('no goals set');
    expect(plan.note).toContain('pipeline only');
    expect(plan.items.every((i) => i.gap === 0)).toBe(true); // a stray pace row without its goal is ignored
    expect(plan.items).toHaveLength(3);
  });
});

describe('R-PLAN-3 do-not-contact and visibility', () => {
  it('R-PLAN-3: a person-level do-not-contact contact is never suggested, from any input list', () => {
    const plan = planWeek(
      input({
        openPromises: [promise(1, 1, true), promise(2, 1)],
        tasks: [taskF(3, 1, 'callback', true)],
        apptsWithoutOutcome: [apptF(4, true)],
        slowDeals: [slow(5, 'active', true), slow(6)],
      }),
    );
    expect(plan.items.map((i) => i.contactId)).toEqual([contact(2), contact(6)]);
    expect(plan.droppedDoNotContact).toBe(4);
  });

  it('R-PLAN-3 E111: an item citing a deal reassigned since (no longer visible) is dropped at render', () => {
    const plan = planWeek(input({ slowDeals: [slow(1), slow(2)], openPromises: [promise(3, 1)] }));
    const visible = new Set<string>([deal(2), task(3)]); // deal 1 was reassigned away
    const shown = dropInvisible(plan.items, visible);
    expect(shown.map((i) => i.evidence[0]?.sourceId)).toEqual([task(3), deal(2)]);
  });

  it('R-PLAN-3: an item whose contact became do-not-contact after planning is dropped at render', () => {
    const plan = planWeek(input({ slowDeals: [slow(1), slow(2)] }));
    const shown = dropInvisible(plan.items, new Set([deal(1), deal(2)]), new Set([contact(1)]));
    expect(shown.map((i) => i.dealId)).toEqual([deal(2)]);
  });
});

describe('R-PLAN-1 R-PLAN-3 plan properties', () => {
  const metricArb = fc.constantFrom('appointments_set', 'appointments_held', 'agreements_signed', 'closings', 'touches' as const);
  const inputArb = fc.record({
    goals: fc.array(fc.record({ n: fc.integer({ min: 1, max: 4 }), metric: metricArb }), { maxLength: 4 }),
    behind: fc.array(fc.integer({ min: 0, max: 9 }), { minLength: 5, maxLength: 5 }),
    promises: fc.array(fc.record({ n: fc.integer({ min: 1, max: 30 }), due: fc.option(fc.integer({ min: -5, max: 10 })), dnc: fc.boolean() }), { maxLength: 8 }),
    tasks: fc.array(
      fc.record({
        n: fc.integer({ min: 1, max: 30 }),
        due: fc.option(fc.integer({ min: -5, max: 10 })),
        kind: fc.constantFrom('todo', 'callback', 'promise', 'follow_up', 'document' as const),
        dnc: fc.boolean(),
      }),
      { maxLength: 8 },
    ),
    appts: fc.array(fc.record({ n: fc.integer({ min: 1, max: 30 }), dnc: fc.boolean() }), { maxLength: 5 }),
    deals: fc.array(fc.record({ n: fc.integer({ min: 1, max: 30 }), stage: fc.constantFrom('prospect', 'agreement_signed', 'active', 'under_contract' as const), dnc: fc.boolean() }), {
      maxLength: 5,
    }),
  });

  it('R-PLAN-1 property: at most 5 items (min(5, candidates)), sorted per the ranking, deadlines before undated items', () => {
    fc.assert(
      fc.property(inputArb, (r) => {
        const goals = r.goals.map((g) => goal(g.n, g.metric));
        const paces = r.goals.map((g, i) => pace(g.n, g.metric, r.behind[i] ?? 0));
        const plan = planWeek(
          input({
            goals,
            pace: paces,
            openPromises: r.promises.map((p) => promise(p.n, p.due, p.dnc)),
            tasks: r.tasks.map((t) => taskF(t.n, t.due, t.kind, t.dnc)),
            apptsWithoutOutcome: r.appts.map((a) => apptF(a.n, a.dnc)),
            slowDeals: r.deals.map((d) => slow(d.n, d.stage, d.dnc)),
          }),
        );
        expect(plan.items.length).toBeLessThanOrEqual(5);
        expect(plan.items.length).toBe(Math.min(5, plan.candidates));
        for (let i = 1; i < plan.items.length; i++) {
          const prev = plan.items[i - 1];
          const cur = plan.items[i];
          if (prev && cur) expect(comparePlanItems(prev, cur)).toBeLessThan(0);
        }
        const deadlines = plan.items.map((i) => i.deadline);
        const firstNull = deadlines.indexOf(null);
        if (firstNull >= 0) expect(deadlines.slice(firstNull).every((d) => d === null)).toBe(true);
      }),
    );
  });

  it('R-PLAN-3 property: when the input flags a contact do-not-contact everywhere, no item names that contact', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 1, max: 12 }), { maxLength: 20 }), fc.array(fc.integer({ min: 1, max: 12 }), { maxLength: 6 }), (ns, flagged) => {
        const dnc = new Set(flagged);
        const plan = planWeek(
          input({
            openPromises: ns.map((n) => promise(n, n % 5, dnc.has(n))),
            slowDeals: ns.map((n) => slow(n, 'active', dnc.has(n))),
            apptsWithoutOutcome: ns.map((n) => apptF(n, dnc.has(n))),
            tasks: ns.map((n) => taskF(n + 100, null, 'callback', dnc.has(n))).map((t, i) => ({ ...t, contactId: contact(ns[i] ?? 0) })),
          }),
        );
        for (const it of plan.items) expect(flagged.map((n) => contact(n))).not.toContain(it.contactId);
        expect(plan.items.length).toBeLessThanOrEqual(5);
      }),
    );
  });
});

