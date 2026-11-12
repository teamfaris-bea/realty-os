// Fixtures for the module 40 component tests (imported by *.test.tsx only). Shapes follow api/insights' response
// schemas. The whole app is mounted on a scripted fetch, so routes, nav, re-auth and error sentences are the real ones.
import { FakeFetch, renderApp, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { AGENT_SURFACES } from '../feed/lib/testing.js';
import { LEAD_ADMIN_SURFACES, type TestRole } from '../admin/lib/testing.js';
import { surface as goalsSurface } from '../goals/index.js';
import type { GoalView, GoalsResponse, PlanResponse } from '../goals/types.js';
import { rangeQuery } from './OwnerPage.js';
import { surface as ownerSurface } from './index.js';
import type { CostsResponse, ForecastResponse, SourcesResponse, VelocityResponse } from './types.js';

export const insightsTable = () => tableWith(...AGENT_SURFACES, ...LEAD_ADMIN_SURFACES, ownerSurface, goalsSurface);

export const ZILLOW = '01900000-0000-7000-8000-00000000a001';
export const BILLBOARD = '01900000-0000-7000-8000-00000000a002';
export const DEAL = '01900000-0000-7000-8000-00000000d001';
export const AGENT = '01900000-0000-7000-8000-00000000b001';
export const CONTACT = '01900000-0000-7000-8000-00000000c001';
export const TASK = '01900000-0000-7000-8000-00000000e001';

export function sources(): SourcesResponse {
  const q = rangeQuery('this');
  return {
    period: { from: q.from, to: q.to, zone: 'America/Los_Angeles' },
    method: 'Commission of deals closed in the period, summed by the lead source each deal was created with.',
    closedInPeriod: 4,
    rows: [
      {
        leadSourceId: ZILLOW,
        leadSourceName: 'Zillow',
        closings: 3,
        dealsWithCommission: 2,
        missingCommission: 1,
        commissionCents: 1_500_050,
        commissionWords: '$15,000.50 from 2 of 3 closings with a commission entered',
        costCents: 90_000,
        costManualCents: 90_000,
        costAdsSyncCents: 0,
        costRows: 1,
        costWords: '$900.00 over 1 monthly entry',
        costPerClosingCents: 30_000,
        costPerClosingWords: '$300.00 per closing (3 closings)',
      },
      {
        leadSourceId: BILLBOARD,
        leadSourceName: 'Billboard',
        closings: 0,
        dealsWithCommission: 0,
        missingCommission: 0,
        commissionCents: 0,
        commissionWords: '$0.00 from 0 of 0 closings with a commission entered',
        costCents: 25_000,
        costManualCents: 25_000,
        costAdsSyncCents: 0,
        costRows: 1,
        costWords: '$250.00 over 1 monthly entry',
        costPerClosingCents: null,
        costPerClosingWords: '— (0 closings)',
      },
    ],
    excluded: { missingCommission: { count: 1, deals: [{ dealId: DEAL, name: 'Lee purchase' }] }, noSource: { count: 1, deals: [{ dealId: '01900000-0000-7000-8000-00000000d002', name: 'Walk-in sale' }] } },
  };
}

export const velocity = (): VelocityResponse => ({
  method: 'Median days deals stayed in each stage before moving on, over stage changes in the last 180 days. Stages with fewer than 5 such moves are left out.',
  minSample: 5,
  rows: [{ stage: 'prospect', medianDays: 10, sampleSize: 6, words: 'median 10 days (n=6)' }],
  excluded: { thinStages: [{ stage: 'active', sampleSize: 1 }] },
});

const unit = (u: 'closings' | 'commission_cents') => ({
  unit: u,
  horizonDays: 90 as const,
  low: u === 'closings' ? 7.4 : 600_000,
  expected: u === 'closings' ? 9.6 : 800_000,
  high: u === 'closings' ? 11.1 : 950_000,
  rangeWords: u === 'closings' ? '7.4–11.1 closings' : '$6,000.00–$9,500.00',
  method: 'For each stage we took the share of deals that entered it 90 to 365 days ago that closed within 90 days (k of n) and added it up over 12 open deals with an 80% Wilson range for low and high; left out: 4 open deals in stages with fewer than 10 such entries (not enough history: prospect, agreement_signed, active).',
  countedDeals: u === 'closings' ? 12 : 1,
  notEnoughHistory: false,
  samples: [
    { stage: 'prospect', n: 0, k: 0 },
    { stage: 'agreement_signed', n: 0, k: 0 },
    { stage: 'active', n: 3, k: 0 },
    { stage: 'under_contract', n: 10, k: 8 },
  ],
  excluded: { thinStages: ['prospect', 'agreement_signed', 'active'], thinStageDeals: 4, noCommission: u === 'closings' ? 0 : 11, noSource: 2 },
});
export const forecast = (): ForecastResponse => ({ asOf: '2026-11-11T18:00:00.000Z', minSample: 10, openDeals: 16, closings: unit('closings'), commission: unit('commission_cents') });

export function costs(): CostsResponse {
  const q = rangeQuery('this');
  return {
    sources: [
      { id: BILLBOARD, name: 'Billboard', active: true },
      { id: ZILLOW, name: 'Zillow', active: true },
    ],
    costs: [{ id: '01900000-0000-7000-8000-00000000f001', leadSourceId: ZILLOW, month: q.to, amountCents: 90_000, origin: 'manual', note: 'Premier Agent', enteredByUserId: AGENT, updatedAt: '2026-11-02T10:00:00.000Z' }],
  };
}

export function ownerFake(): FakeFetch {
  const q = rangeQuery('this');
  const qs = `?from=${q.from}&to=${q.to}`;
  return new FakeFetch()
    .on('GET /owner/sources', { status: 200, body: sources() })
    .on('GET /lead-source-costs', { status: 200, body: costs() })
    .on(`GET /owner/sources${qs}`, { status: 200, body: sources() })
    .on(`GET /lead-source-costs${qs}`, { status: 200, body: costs() })
    .on('GET /owner/velocity', { status: 200, body: velocity() })
    .on('GET /owner/forecast', { status: 200, body: forecast() });
}

export function goal(over: Partial<GoalView> = {}): GoalView {
  return {
    id: '01900000-0000-7000-8000-0000000a0001',
    userId: AGENT,
    periodKind: 'month',
    periodStart: '2026-11-01',
    periodEndExclusive: '2026-12-01',
    metric: 'closings',
    target: 4,
    pace: { actual: 1, expectedByNow: 1.3, behindBy: 1, remaining: 3, daysLeft: 20, status: 'on_track', words: '1 of 4 closings; 1.3 expected by now; 3 to go in 20 days', method: 'Counted from the scoreboard for this member over the goal period so far.' },
    ...over,
  };
}

export const goalsBody = (o: Partial<GoalsResponse> = {}): GoalsResponse => ({
  zone: 'America/Los_Angeles',
  members: [
    { userId: AGENT, name: 'Ava Agent', role: 'agent', canManage: true },
    { userId: '01900000-0000-7000-8000-00000000b002', name: 'Ben Agent', role: 'agent', canManage: true },
  ],
  goals: [goal()],
  ...o,
});

export function plan(over: Partial<PlanResponse> = {}): PlanResponse {
  return {
    week: '2026-W46',
    zone: 'America/Los_Angeles',
    exists: true,
    basis: 'pipeline_only',
    note: 'You have no goals set, so this plan is built from your pipeline only (ranked by deadline).',
    builtAt: '2026-11-09T08:05:00.000Z',
    droppedSinceBuilt: 0,
    accepted: null,
    items: [
      { index: 0, accepted: false, item: { kind: 'keep_promise', title: 'Keep your promise: Send Sam the comps', contactId: CONTACT, dealId: null, deadline: '2026-11-10T17:00:00.000Z', metric: 'touches', gap: 0, evidence: [{ sourceType: 'task', sourceId: TASK, reason: 'Open promise, due 2026-11-10' }] } },
      { index: 1, accepted: false, item: { kind: 'log_outcome', title: 'Log the outcome of this appointment', contactId: CONTACT, dealId: null, deadline: null, metric: 'appointments_held', gap: 0, evidence: [{ sourceType: 'appointment', sourceId: '01900000-0000-7000-8000-00000000e002', reason: 'Appointment on 2026-11-08 has no outcome logged' }] } },
      { index: 2, accepted: false, item: { kind: 'move_deal', title: 'Move Ortiz purchase forward', contactId: CONTACT, dealId: DEAL, deadline: null, metric: 'agreements_signed', gap: 0, evidence: [{ sourceType: 'deal', sourceId: DEAL, reason: 'Deal in prospect for 12 days; median 2 (n=5)' }] } },
    ],
    ...over,
  };
}

export function insightsApp(fake: FakeFetch, path: string, role: TestRole = 'owner', o: { reauthenticatedAt?: string | null } = {}) {
  const s = sessionFixture({ reauthenticatedAt: o.reauthenticatedAt ?? null });
  const tenant = { ...s.tenant!, role };
  fake.on('GET /auth/session', { status: 200, body: { ...s, tenant, tenants: [tenant] } });
  return renderApp({ fake, path, table: insightsTable() });
}

export { FakeFetch };
export { err } from '../../shell/testing/fakeApi.js';
