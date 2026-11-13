// Fixtures for the module 55 ads tests (imported by *.test.tsx only). Shapes follow apps/api/src/ads/schemas.ts; every
// answer goes through StaffFake, which fails a test whose fixture the API could never send. Synthetic names only.
import { renderApp, sessionFixture, tableWith } from '../../shell/testing/fakeApi.js';
import { StaffFake, staffError } from '../../test/staffContract.js';
import { AGENT_SURFACES } from '../feed/lib/testing.js';
import { surface as adsSurface } from './index.js';
import type { CampaignView, LedgerEventView, OverviewResponse, RunResponse, ShownAction } from './types.js';

export type Role = 'owner' | 'admin' | 'team_lead' | 'agent' | 'isa' | 'tc';
export const ROLES_WITHOUT_ADS: readonly Role[] = ['team_lead', 'agent', 'isa', 'tc'];

export const ADS_IDS = {
  north: '01900000-0000-7000-8000-0000000ad001',
  south: '01900000-0000-7000-8000-0000000ad002',
  paused: '01900000-0000-7000-8000-0000000ad003',
  conn: '01900000-0000-7000-8000-0000000ad0c1',
  cap: '01900000-0000-7000-8000-0000000ad0ca',
  proposal: '01900000-0000-7000-8000-0000000ad0a1',
  newer: '01900000-0000-7000-8000-0000000ad0a2',
  hold: '01900000-0000-7000-8000-0000000ad0b1',
  run: '01900000-0000-7000-8000-0000000ad0e0',
  listing: '01900000-0000-7000-8000-0000000ad0f1',
  piece: '01900000-0000-7000-8000-0000000ad0f2',
};

export const ev = (n: number, over: Partial<LedgerEventView> = {}): LedgerEventView => ({
  id: `01900000-0000-7000-8000-0000000ae${String(n).padStart(3, '0')}`,
  runId: ADS_IDS.run,
  campaignId: ADS_IDS.north,
  kind: 'applied',
  fromDailyCents: 4_000,
  toDailyCents: 5_000,
  reasonCode: 'APPLIED',
  providerRef: 'fake-ads-ref',
  occurredAt: '2026-11-09T15:00:00.000Z',
  ...over,
});

export function campaign(over: Partial<CampaignView> = {}): CampaignView {
  return {
    id: ADS_IDS.north,
    name: 'North Shore homes',
    externalCampaignId: 'fake-ads-1',
    connectionId: ADS_IDS.conn,
    status: 'active',
    managed: true,
    why: 'Managed here: linked to a listing with an approved creative.',
    dailyBudgetCents: 5_000,
    budgetNote: null,
    countedDailyCents: 5_000,
    listingId: ADS_IDS.listing,
    creativePieceId: ADS_IDS.piece,
    outcomes: { agreements: 6, closings: 2, spendCents: 270_000, windowDays: 90, asOf: '2026-11-09T15:00:00.000Z' },
    ledger: [ev(1)],
    ...over,
  };
}

export const proposalPayload = () => ({
  v: 1,
  kind: 'weekly',
  connection_id: ADS_IDS.conn,
  cap_version_id: ADS_IDS.cap,
  cap_version_no: 1,
  changes: [
    { campaign_id: ADS_IDS.north, to_daily_cents: 6_000 },
    { campaign_id: ADS_IDS.south, to_daily_cents: 3_000 },
  ],
  rows: [
    { campaignId: ADS_IDS.north, fromDailyCents: 5_000, toDailyCents: 6_000, changed: true, reasonCode: 'RAISED_LOWER_COST_PER_OUTCOME', sentence: 'Raise from $50.00 to $60.00 a day: $450.00 per agreement (6 agreements), below the $600.00 pooled cost per agreement.', blockers: [], targetingIssues: [] },
    { campaignId: ADS_IDS.south, fromDailyCents: 4_000, toDailyCents: 3_000, changed: true, reasonCode: 'LOWERED_HIGHER_COST_PER_OUTCOME', sentence: 'Lower from $40.00 to $30.00 a day: $900.00 per agreement (5 agreements), above the $600.00 pooled cost per agreement.', blockers: [], targetingIssues: [] },
  ],
  totals: { currentDailyCents: 9_000, proposedDailyCents: 9_000, ceilingDailyCents: 12_000 },
  counts: { windowDays: 90, minAgreements: 5, leadingOutcome: 'agreements', campaigns: [] },
  built_at: '2026-11-09T15:00:00.000Z',
});

export const proposal = (over: Partial<ShownAction> = {}): ShownAction => ({
  id: ADS_IDS.proposal,
  status: 'proposed',
  explanation: 'Move daily budget toward lower cost per agreement: 2 of 2 campaigns change, $90.00 to $90.00 a day (ceiling $120.00); 11 agreements on $6,300.00 across campaigns with 5 or more agreements in 90 days.',
  createdAt: '2026-11-09T15:00:00.000Z',
  payload: proposalPayload(),
  ...over,
});

export const hold = (): ShownAction => ({
  id: ADS_IDS.hold,
  status: 'blocked',
  explanation: 'No budget change this week: fewer than two campaigns have enough agreements to compare. 1 of 2 campaigns had 5 or more agreements in 90 days.',
  createdAt: '2026-11-09T15:00:00.000Z',
  payload: {
    v: 1,
    hold: 'ADS_BELOW_MINIMUM_SAMPLE',
    counts: { windowDays: 90, minAgreements: 5, leadingOutcome: 'agreements', campaigns: [{ campaignId: ADS_IDS.north, agreements: 6, closings: 2, spendCents: 270_000 }, { campaignId: ADS_IDS.south, agreements: 1, closings: 0, spendCents: 90_000 }] },
    window: { days: 90, from: '2026-08-11', to: '2026-11-08', zone: 'Etc/UTC' },
    connection_id: ADS_IDS.conn,
    built_at: '2026-11-09T15:00:00.000Z',
  },
});

export const NOT_CLEARED_SENTENCE =
  'Budget changes and the pause at your monthly cap stay off until counsel review and the Google Ads check are complete. Spend is still read and shown, and you are alerted at the cap.';

export function overview(over: Partial<OverviewResponse> = {}): OverviewResponse {
  return {
    state: 'ready',
    stateSentence: 'Budget proposals arrive each Monday; each one waits for an Owner or Admin to approve it.',
    packKey: 'platform:ads',
    packSentence: 'Changing Google Ads budgets: counsel reviewed the pack on 2026-11-01 and the vendor check is done (pack 1.0.0).',
    cleared: true,
    cap: { id: ADS_IDS.cap, versionNo: 1, monthlyCapCents: 300_000, dailyCeilingCents: 12_000, effectiveFrom: '2026-11-01T00:00:00.000Z' },
    monthToDate: { month: '2026-11', zone: 'Etc/UTC', spentCents: 123_456, capCents: 300_000, sentence: '$1,234.56 of your $3,000.00 monthly cap spent in 2026-11.' },
    dailyTotal: { countedCents: 9_000, ceilingCents: 12_000, sentence: 'Daily budgets total $90.00 against your $120.00 daily ceiling.' },
    overspendNote: 'Google Ads may spend more than a daily budget on a given day; Realty OS pauses every campaign once month-to-date spend reaches your monthly cap.',
    asOf: 'as reported by Google Ads at 2026-11-13T10:00:00.000Z',
    lastSyncedAt: '2026-11-13T10:00:00.000Z',
    uncheckedSentence: null,
    campaigns: [
      campaign(),
      campaign({ id: ADS_IDS.south, name: 'South Bay condos', externalCampaignId: 'fake-ads-2', dailyBudgetCents: 4_000, countedDailyCents: 4_000, ledger: [] }),
      campaign({ id: ADS_IDS.paused, name: 'Lakeside open houses', externalCampaignId: 'fake-ads-3', status: 'paused', managed: false, why: 'Paused on Google Ads.', dailyBudgetCents: 2_500, countedDailyCents: 0, budgetNote: 'shared budget', outcomes: null, ledger: [ev(2, { campaignId: ADS_IDS.paused, kind: 'paused', fromDailyCents: 2_500, toDailyCents: 0, reasonCode: 'MONTHLY_CAP_REACHED', providerRef: null })] }),
    ],
    unmanagedDailyCents: 0,
    unmanagedSentence: '$0.00 a day of budgets on campaigns not managed here.',
    doubleCount: null,
    pendingProposal: proposal(),
    latestHold: null,
    ...over,
  };
}

/** GET /ads while platform:ads is uncleared, reads on (Q-ADS-1 default): stored spend and campaigns, read-only. */
export const darkOverview = (over: Partial<OverviewResponse> = {}): OverviewResponse =>
  overview({
    state: 'not_cleared',
    stateSentence: NOT_CLEARED_SENTENCE,
    packSentence: 'Changing Google Ads budgets stays off: awaiting counsel review and the vendor check (pack 1.0.0, not yet reviewed).',
    cleared: false,
    overspendNote: 'Google Ads may spend more than a daily budget on a given day. Until counsel review and the Google Ads check are complete, Realty OS reads spend and alerts you at your monthly cap but cannot pause campaigns: pause them in Google Ads.',
    ...over,
  });

export const run = (outcome: 'applied' | 'pending' | 'failed' = 'applied', id = ADS_IDS.proposal): RunResponse => ({
  actionId: id,
  status: outcome === 'pending' ? 'approved' : 'executed',
  runId: ADS_IDS.run,
  rows: [
    { campaignId: ADS_IDS.north, fromDailyCents: 5_000, toDailyCents: 6_000, reasonCode: 'RAISED_LOWER_COST_PER_OUTCOME', outcome, outcomeCode: outcome === 'failed' ? 'SHARED_BUDGET' : outcome === 'applied' ? 'APPLIED' : null, providerRef: null },
    { campaignId: ADS_IDS.south, fromDailyCents: 4_000, toDailyCents: 3_000, reasonCode: 'LOWERED_HIGHER_COST_PER_OUTCOME', outcome: 'applied', outcomeCode: 'APPLIED', providerRef: 'fake-ads-ref' },
  ],
});

export function adsFake(o: OverviewResponse | ((n: number) => OverviewResponse) = overview()): StaffFake {
  return new StaffFake()
    .on('GET /ads', (_c, n) => ({ status: 200, body: typeof o === 'function' ? o(n) : o }))
    .on('GET /ads/ledger', { status: 200, body: { events: [ev(1), ev(2, { campaignId: ADS_IDS.paused, kind: 'paused', fromDailyCents: 2_500, toDailyCents: 0, reasonCode: 'MONTHLY_CAP_REACHED', providerRef: null })], next: null } });
}

export const adsTable = () => tableWith(...AGENT_SURFACES, adsSurface);

export function adsApp(fake: StaffFake, path = '/ads', role: Role = 'owner', o: { reauthenticatedAt?: string | null } = {}) {
  const s = sessionFixture({ reauthenticatedAt: o.reauthenticatedAt ?? null });
  const tenant = { ...s.tenant!, role };
  fake.on('GET /auth/session', { status: 200, body: { ...s, tenant, tenants: [tenant] } });
  return renderApp({ fake, path, table: adsTable() });
}

/** No rendered text may carry a raw code, a pack key, a provider note or an ISO time (CONVENTIONS.md:198). */
export const RAW = /\b[A-Z]{2,}_[A-Z_]+\b|platform:[a-z_]+|\(N\d+\)|\d{4}-\d\d-\d\dT/;

export { StaffFake, staffError };
