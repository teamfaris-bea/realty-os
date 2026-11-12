// The tenant-wide daily total, counted term by term as app.ad_allocation_cap_check() (0018 §15) counts it:
//
//   SUM(CASE WHEN l.run_id = NEW.run_id AND l.event_kind = 'planned' THEN l.to_daily_cents   -- in this proposal
//            WHEN c.status <> 'active'                         THEN 0
//            WHEN l.event_kind IN ('planned','applied')        THEN GREATEST(l.to_daily_cents, c.daily_budget_cents)
//            WHEN l.event_kind = 'paused'                      THEN 0
//            ELSE c.daily_budget_cents END)
//   over every campaign of the tenant, whatever its connection kind.
//
// Module 52 uses it to re-check an edited change set and in its "the DB trigger and proposeReallocation
// agree" property test.
import type { AllocationChange, Campaign } from './types.js';
import { cents, checkCampaigns, safeSum, uuid } from './validate.js';

/** What the cap check counts for one campaign; `proposed` is its amount in this proposal, if any. */
export function countedDailyCents(c: Campaign, proposed?: number): number {
  if (proposed !== undefined) return proposed;
  if (c.status !== 'active') return 0;
  const l = c.latestEvent;
  if (l !== null && (l.kind === 'planned' || l.kind === 'applied')) return Math.max(l.toDailyCents, c.dailyBudgetCents);
  if (l !== null && l.kind === 'paused') return 0;
  return c.dailyBudgetCents;
}

/** Changes as a map; throws RangeError on an unknown campaign (the trigger's AD_CAMPAIGN_UNKNOWN), a duplicate or bad cents. */
export function changesById(campaigns: readonly Campaign[], changes: readonly AllocationChange[]): Map<string, number> {
  const known = new Set(campaigns.map((c) => c.id as string));
  const m = new Map<string, number>();
  for (const ch of changes) {
    const id = uuid(ch.campaign_id, 'change.campaign_id');
    if (!known.has(id)) throw new RangeError(`change: unknown campaign ${id} (AD_CAMPAIGN_UNKNOWN)`);
    if (m.has(id)) throw new RangeError(`change: campaign ${id} named twice`);
    m.set(id, cents(ch.to_daily_cents, 'change.to_daily_cents'));
  }
  return m;
}

/** The tenant-wide daily total after `changes`, counted as the cap trigger counts it. */
export function tenantDailyTotal(campaigns: readonly Campaign[], changes: readonly AllocationChange[] = []): number {
  checkCampaigns(campaigns);
  const m = changesById(campaigns, changes);
  return safeSum(campaigns.map((c) => countedDailyCents(c, m.get(c.id))), 'tenantDailyTotal');
}
