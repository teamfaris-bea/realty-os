// Input checks for core/ads. Malformed input throws RangeError (as core/insights does): bad cents,
// duplicate ids, an unknown status, a cap whose daily ceiling exceeds its monthly cap, or a window
// other than the rules' window. Ids must be canonical lower-case UUIDs, as the cap trigger compares
// payload text with campaign_id::text.
import { CAMPAIGN_STATUSES, CONNECTION_STATUSES, LEDGER_EVENT_KINDS, type AllocRules, type Campaign, type Cap } from './types.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function cents(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new RangeError(`${what}: expected integer cents >= 0, got ${String(v)}`);
  return v;
}

export function count(v: unknown, what: string): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) throw new RangeError(`${what}: expected a count >= 0, got ${String(v)}`);
  return v;
}

export function uuid(v: unknown, what: string): string {
  if (typeof v !== 'string' || !UUID.test(v)) throw new RangeError(`${what}: expected a lower-case UUID, got ${JSON.stringify(v)}`);
  return v;
}

/** A sum that stays a safe integer. */
export function safeSum(xs: readonly number[], what: string): number {
  let t = 0;
  for (const x of xs) {
    t += x;
    if (!Number.isSafeInteger(t)) throw new RangeError(`${what}: the total is not a safe integer`);
  }
  return t;
}

const oneOf = <T extends string>(v: unknown, xs: readonly T[], what: string): T => {
  if (typeof v !== 'string' || !(xs as readonly string[]).includes(v)) throw new RangeError(`${what}: unknown value ${JSON.stringify(v)}`);
  return v as T;
};

export function checkCampaigns(cs: readonly Campaign[]): void {
  if (!Array.isArray(cs)) throw new RangeError('campaigns: expected an array');
  const seen = new Set<string>();
  for (const c of cs) {
    const id = uuid(c.id, 'campaign.id');
    if (seen.has(id)) throw new RangeError(`campaigns: duplicate id ${id}`);
    seen.add(id);
    if (typeof c.connectionKind !== 'string') throw new RangeError('campaign.connectionKind: expected a string');
    oneOf(c.connectionStatus, CONNECTION_STATUSES, 'campaign.connectionStatus');
    oneOf(c.status, CAMPAIGN_STATUSES, 'campaign.status');
    if (typeof c.specialCategory !== 'string') throw new RangeError('campaign.specialCategory: expected a string');
    if (c.listingId !== null) uuid(c.listingId, 'campaign.listingId');
    if (c.creative !== null) {
      uuid(c.creative.pieceId, 'campaign.creative.pieceId');
      uuid(c.creative.listingId, 'campaign.creative.listingId');
      if (typeof c.creative.status !== 'string') throw new RangeError('campaign.creative.status: expected a string');
    }
    cents(c.dailyBudgetCents, 'campaign.dailyBudgetCents');
    if (c.latestEvent !== null) {
      oneOf(c.latestEvent.kind, LEDGER_EVENT_KINDS, 'campaign.latestEvent.kind');
      cents(c.latestEvent.toDailyCents, 'campaign.latestEvent.toDailyCents');
      if (c.latestEvent.kind === 'paused' && c.latestEvent.toDailyCents !== 0) throw new RangeError('campaign.latestEvent: a paused event is to 0 (ledger CHECK)');
    }
  }
}

export function checkCap(cap: Cap): void {
  uuid(cap.id, 'cap.id');
  if (!Number.isSafeInteger(cap.versionNo) || cap.versionNo < 1) throw new RangeError('cap.versionNo: expected an integer >= 1');
  cents(cap.monthlyCapCents, 'cap.monthlyCapCents');
  cents(cap.dailyCeilingCents, 'cap.dailyCeilingCents');
  if (cap.dailyCeilingCents > cap.monthlyCapCents) throw new RangeError('cap: the daily ceiling exceeds the monthly cap (ad_budget_caps CHECK)');
  if (!Number.isSafeInteger(cap.effectiveFrom)) throw new RangeError('cap.effectiveFrom: expected an instant');
}

export function checkRules(r: AllocRules): void {
  if (!Number.isSafeInteger(r.windowDays) || r.windowDays < 1) throw new RangeError('rules.windowDays: expected an integer >= 1');
  if (!Number.isSafeInteger(r.minAgreements) || r.minAgreements < 1) throw new RangeError('rules.minAgreements: expected an integer >= 1');
  oneOf(r.leadingOutcome, ['agreements', 'closings'] as const, 'rules.leadingOutcome');
  if (!Number.isSafeInteger(r.maxShiftBps) || r.maxShiftBps < 0 || r.maxShiftBps > 10_000) throw new RangeError('rules.maxShiftBps: expected 0..10000');
  cents(r.minDailyCents, 'rules.minDailyCents');
}
