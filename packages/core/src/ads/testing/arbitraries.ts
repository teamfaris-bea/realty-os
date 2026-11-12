// fast-check arbitraries for core/ads: campaign sets with random ledgers, caps and outcomes. Each
// campaign's latestEvent is derived from a generated ledger the same way the trigger picks "latest".
import fc from 'fast-check';
import { instant } from '../../foundation/index.js';
import { PIECE_STATUSES } from '../../marketing/index.js';
import { CAMPAIGN_STATUSES, CONNECTION_STATUSES, type Campaign, type CampaignId, type Cap, type CapVersionId, type Outcomes, type Spend } from '../types.js';
import { cid, lid, pid, uid } from './fixtures.js';
import { latestOf, type LedgerRow } from './trigger.js';

const centsArb = fc.oneof(fc.integer({ min: 0, max: 50_000 }), fc.integer({ min: 0, max: 5_000_000 }));
const goodTargeting = { geo: 'radius_of_listing', radiusMiles: 25 };

export interface World { campaigns: Campaign[]; ledger: LedgerRow[]; spend: Spend[]; outcomes: Outcomes; cap: Cap }

const campaignArb = (n: number): fc.Arbitrary<{ c: Omit<Campaign, 'latestEvent'>; events: Omit<LedgerRow, 'campaign_id'>[] }> => fc.record({
  eligible: fc.boolean(),
  kind: fc.constantFrom('ads_google', 'ads_google', 'ads_google', 'ads_meta', 'ADS_GOOGLE', 'ads_google '),
  connectionStatus: fc.constantFrom('connected', 'connected', 'degraded', ...CONNECTION_STATUSES),
  status: fc.constantFrom('active', 'active', 'active', ...CAMPAIGN_STATUSES),
  housing: fc.constantFrom('housing', 'housing', 'housing', 'none'),
  targeting: fc.constantFrom<unknown>(goodTargeting, goodTargeting, { ...goodTargeting, zips: ['00000'] }, { geo: 'radius_of_listing', radiusMiles: 2 }, {}),
  creativeStatus: fc.constantFrom('approved', 'published', ...PIECE_STATUSES),
  ownListing: fc.boolean(),
  budget: centsArb,
  events: fc.array(fc.record({ kind: fc.constantFrom('planned', 'applied', 'failed', 'paused' as const), to: centsArb, at: fc.integer({ min: 0, max: 50 }) }), { maxLength: 4 }),
}).map((x) => {
  const eligible = x.eligible;
  const c: Omit<Campaign, 'latestEvent'> = {
    id: cid(n), connectionKind: eligible ? 'ads_google' : x.kind, connectionStatus: eligible ? 'connected' : x.connectionStatus,
    status: eligible ? 'active' : x.status, specialCategory: eligible ? 'housing' : x.housing, targeting: eligible ? goodTargeting : x.targeting,
    listingId: lid(n), creative: { pieceId: pid(n), status: eligible ? 'approved' : x.creativeStatus, listingId: eligible || x.ownListing ? lid(n) : lid(n + 100) },
    dailyBudgetCents: x.budget,
  };
  const events = (eligible ? x.events.filter((e) => e.kind === 'applied' || e.kind === 'failed') : x.events)
    .map((e, i) => ({ id: uid(0x5000 + n * 16 + i), run_id: uid(0x6000 + i), event_kind: e.kind, to_daily_cents: e.kind === 'paused' ? 0 : e.to, occurred_at: e.at }));
  return { c, events };
});

export const worldArb: fc.Arbitrary<World> = fc.integer({ min: 0, max: 8 }).chain((k) => fc.tuple(
  fc.tuple(...Array.from({ length: k }, (_, i) => campaignArb(i + 1))),
  fc.array(fc.tuple(fc.integer({ min: 0, max: 30 }), fc.integer({ min: 0, max: 6 }), centsArb), { minLength: k, maxLength: k }),
  fc.integer({ min: 0, max: 400_000 }),
  fc.constantFrom<number>(0, 1, 2),
)).map(([cs, oc, ceiling, extra]) => {
  const ledger: LedgerRow[] = cs.flatMap(({ c, events }) => events.map((e) => ({ ...e, campaign_id: c.id })));
  const campaigns: Campaign[] = cs.map(({ c }) => {
    const l = latestOf(ledger, c.id, null);
    return { ...c, latestEvent: l === undefined ? null : { kind: l.event_kind, toDailyCents: l.to_daily_cents } };
  });
  return {
    campaigns, ledger,
    spend: campaigns.map((c, i) => ({ campaignId: c.id, spendCents: oc[i]![2] + (i % 3 === 0 ? 0 : 1), windowDays: 90 })),
    outcomes: { windowDays: 90, campaigns: campaigns.map((c, i) => ({ campaignId: c.id, agreements: oc[i]![0], closings: oc[i]![1] })) },
    cap: { id: uid(0x900 + extra) as CapVersionId, versionNo: 1 + extra, monthlyCapCents: ceiling * 31, dailyCeilingCents: ceiling, effectiveFrom: instant(0) },
  };
});

export const ids = (cs: readonly Campaign[]): CampaignId[] => cs.map((c) => c.id);
