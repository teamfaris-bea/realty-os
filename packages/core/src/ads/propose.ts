// proposeReallocation(c, spend, outcomes, cap, rules): a proposal to move daily budget between
// campaigns toward more attributed outcomes per dollar, or a hold with the counts (R-ADS-6). Nothing
// is applied: every shift is an Owner's or Admin's tap (D-ADS), and module 52 writes the ledger.
//
// Method (deterministic; campaigns are taken in id order, so input order never matters, E145's core half):
//   1. Eligible to move (R-ADS-4, R-FH-4, R-INT-2, D2): connection kind exactly 'ads_google' on a
//      connected or degraded connection; status active and its latest event neither paused (resuming
//      is a tap) nor planned (a change in flight); special category 'housing'; targeting passes
//      validateTargeting with DEFAULT_TARGETING_LIMITS; creative an approved or published piece of the
//      campaign's own listing. Every other campaign keeps what the cap check counts for it.
//   2. Compared (R-ADS-6): eligible campaigns with ≥ rules.minAgreements agreements in the window and
//      some spend (cost per outcome is never measured on zero spend). A thin campaign keeps its budget
//      and stays out of the moves. Fewer than two compared ⇒ hold ADS_BELOW_MINIMUM_SAMPLE.
//   3. Budget: B = min(S, ceiling − F), S = the compared campaigns' counted total, F = everyone else's
//      counted total (tenantDailyTotal's terms). B < 0 ⇒ hold ADS_NO_PLAN_FITS. A proposal never adds
//      spend: the total never rises above the current total, and over the ceiling it is lowered to fit.
//   4. Move: against the pooled cost per outcome of the compared campaigns (Σ spend / Σ outcomes,
//      compared exactly by cross-multiplication), each costlier campaign gives
//      divRoundHalfUp(budget × maxShiftBps, 10000), never below minDailyCents; the pool goes to the
//      cheaper campaigns in proportion to their outcomes (whole cents; leftover cents best-first).
//   5. Fit: if the total must come down, lower the costliest first, never below minDailyCents; if that
//      cannot reach B ⇒ hold ADS_NO_PLAN_FITS. Nothing changes ⇒ hold ADS_NOTHING_TO_MOVE.
import { validateTargeting, DEFAULT_TARGETING_LIMITS } from '../fairhousing/index.js';
import { divRoundHalfUp, formatCents } from '../insights/index.js';
import { countedDailyCents } from './total.js';
import type {
  AllocRules, AllocationChange, Campaign, CampaignCounts, Cap, Counts, EligibilityCode, Hold, Outcomes, Proposal, ProposalReasonCode, ProposalRow, Spend,
} from './types.js';
import { cents, checkCampaigns, checkCap, checkRules, count, safeSum, uuid } from './validate.js';

export const DEFAULT_ALLOC_RULES: AllocRules = Object.freeze({ windowDays: 90, minAgreements: 5, leadingOutcome: 'agreements', maxShiftBps: 2000, minDailyCents: 0 });

const BLOCKER_WORDS: Readonly<Record<EligibilityCode, string>> = {
  NOT_GOOGLE_ADS: 'not a Google Ads campaign',
  CONNECTION_NOT_LIVE: 'its ad account is not connected',
  NOT_ACTIVE: 'not active',
  PAUSED: 'paused, and resuming is a tap',
  REJECTED: 'rejected by the platform',
  NOT_HOUSING_CATEGORY: 'not in the housing special ad category',
  TARGETING_REFUSED: 'its targeting is refused',
  CREATIVE_NOT_APPROVED: 'no approved creative of its own listing',
  CHANGE_IN_FLIGHT: 'a budget change is still being applied',
};

/** Why a campaign may not be moved (empty: it may). */
export function eligibility(c: Campaign): { blockers: EligibilityCode[]; targetingIssues: string[] } {
  const blockers: EligibilityCode[] = [];
  let targetingIssues: string[] = [];
  if (c.connectionKind !== 'ads_google') blockers.push('NOT_GOOGLE_ADS');
  if (c.connectionStatus !== 'connected' && c.connectionStatus !== 'degraded') blockers.push('CONNECTION_NOT_LIVE');
  if (c.status === 'paused' || (c.status === 'active' && c.latestEvent?.kind === 'paused')) blockers.push('PAUSED');
  else if (c.status === 'rejected') blockers.push('REJECTED');
  else if (c.status !== 'active') blockers.push('NOT_ACTIVE');
  if (c.specialCategory !== 'housing') blockers.push('NOT_HOUSING_CATEGORY');
  const t = validateTargeting(c.targeting, DEFAULT_TARGETING_LIMITS);
  if (!t.ok) {
    blockers.push('TARGETING_REFUSED');
    targetingIssues = t.issues;
  }
  const cr = c.creative;
  if (cr === null || (cr.status !== 'approved' && cr.status !== 'published') || c.listingId === null || cr.listingId !== c.listingId) blockers.push('CREATIVE_NOT_APPROVED');
  if (c.latestEvent?.kind === 'planned') blockers.push('CHANGE_IN_FLIGHT');
  return { blockers, targetingIssues };
}

interface Row {
  c: Campaign;
  counts: CampaignCounts;
  outcome: number;
  blockers: EligibilityCode[];
  targetingIssues: string[];
  from: number;
  to: number;
  fit: number;
}

const big = BigInt;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

export function proposeReallocation(c: Campaign[], spend: Spend[], outcomes: Outcomes, cap: Cap, rules: AllocRules): Proposal | Hold {
  checkRules(rules);
  checkCap(cap);
  checkCampaigns(c);
  if (outcomes.windowDays !== rules.windowDays) throw new RangeError(`outcomes: window ${outcomes.windowDays} d is not the rules' ${rules.windowDays} d`);
  const spendBy = new Map<string, number>();
  for (const s of spend) {
    const id = uuid(s.campaignId, 'spend.campaignId');
    if (s.windowDays !== rules.windowDays) throw new RangeError(`spend: window ${s.windowDays} d is not the rules' ${rules.windowDays} d`);
    if (spendBy.has(id)) throw new RangeError(`spend: duplicate row for ${id}`);
    spendBy.set(id, cents(s.spendCents, 'spend.spendCents'));
  }
  const outBy = new Map<string, { agreements: number; closings: number }>();
  for (const o of outcomes.campaigns) {
    const id = uuid(o.campaignId, 'outcomes.campaignId');
    if (outBy.has(id)) throw new RangeError(`outcomes: duplicate row for ${id}`);
    outBy.set(id, { agreements: count(o.agreements, 'outcomes.agreements'), closings: count(o.closings, 'outcomes.closings') });
  }
  // Rows for unknown campaigns are ignored: they name nothing this tenant can move.

  const rows: Row[] = [...c].sort((a, b) => (a.id < b.id ? -1 : 1)).map((x) => {
    const o = outBy.get(x.id) ?? { agreements: 0, closings: 0 };
    const e = eligibility(x);
    const from = countedDailyCents(x);
    return { c: x, counts: { campaignId: x.id, agreements: o.agreements, closings: o.closings, spendCents: spendBy.get(x.id) ?? 0 },
      outcome: rules.leadingOutcome === 'agreements' ? o.agreements : o.closings, blockers: e.blockers, targetingIssues: e.targetingIssues, from, to: from, fit: 0 };
  });
  const counts: Counts = { windowDays: rules.windowDays, minAgreements: rules.minAgreements, leadingOutcome: rules.leadingOutcome, campaigns: rows.map((r) => r.counts) };

  const compared = rows.filter((r) => r.blockers.length === 0 && r.counts.agreements >= rules.minAgreements && r.counts.spendCents > 0);
  if (compared.length < 2) return { hold: 'ADS_BELOW_MINIMUM_SAMPLE', counts };

  const current = safeSum(rows.map((r) => r.from), 'current total');
  const S = safeSum(compared.map((r) => r.from), 'compared total');
  const room = cap.dailyCeilingCents - (current - S);
  if (room < 0) return { hold: 'ADS_NO_PLAN_FITS', counts };
  const target = Math.min(S, room);

  const O = big(safeSum(compared.map((r) => r.outcome), 'outcomes'));
  const SP = big(safeSum(compared.map((r) => r.counts.spendCents), 'spend'));
  // > 0: costlier than the pool; < 0: cheaper; 0: the same (or no outcomes at all).
  const vsPool = (r: Row): bigint => big(r.counts.spendCents) * O - SP * big(r.outcome);
  // cost_a > cost_b ⇔ spend_a × outcome_b > spend_b × outcome_a. `compared` is in id order and
  // Array.prototype.sort is stable, so ties stay in id order in both directions.
  const costSign = (a: Row, b: Row): number => {
    const d = big(a.counts.spendCents) * big(b.outcome) - big(b.counts.spendCents) * big(a.outcome);
    return d > 0n ? 1 : d < 0n ? -1 : 0;
  };
  const worstFirst = [...compared].sort((a, b) => -costSign(a, b) || 0);
  const bestFirst = [...compared].sort((a, b) => costSign(a, b));

  // 4. move
  const donors = worstFirst.filter((r) => vsPool(r) > 0n);
  const recipients = bestFirst.filter((r) => vsPool(r) < 0n);
  if (donors.length > 0 && recipients.length > 0) {
    let pool = 0;
    for (const r of donors) {
      const step = Math.min(divRoundHalfUp(r.from * rules.maxShiftBps, 10_000), Math.max(0, r.from - rules.minDailyCents));
      r.to -= step;
      pool += step;
    }
    const recOut = big(safeSum(recipients.map((r) => r.outcome), 'recipient outcomes'));
    let given = 0;
    for (const r of recipients) {
      const share = Number((big(pool) * big(r.outcome)) / recOut);
      r.to += share;
      given += share;
    }
    for (let i = 0; given < pool; i += 1, given += 1) recipients[i % recipients.length]!.to += 1;
  }

  // 5. fit
  let excess = safeSum(compared.map((r) => r.to), 'proposed compared total') - target;
  for (const r of worstFirst) {
    if (excess <= 0) break;
    const cut = Math.min(excess, Math.max(0, r.to - rules.minDailyCents));
    r.to -= cut;
    r.fit += cut;
    excess -= cut;
  }
  if (excess > 0) return { hold: 'ADS_NO_PLAN_FITS', counts };
  if (rows.every((r) => r.to === r.from)) return { hold: 'ADS_NOTHING_TO_MOVE', counts };

  const proposed = safeSum(rows.map((r) => r.to), 'proposed total');
  const words = rules.leadingOutcome === 'agreements' ? ['agreement', 'agreements'] as const : ['closing', 'closings'] as const;
  const W = rules.windowDays;
  const eff = (r: Row): string => (r.outcome > 0
    ? `${plural(r.outcome, words[0], words[1])} on ${formatCents(r.counts.spendCents)} spent in ${W} days (${formatCents(divRoundHalfUp(r.counts.spendCents, r.outcome))} per ${words[0]})`
    : `no ${words[1]} on ${formatCents(r.counts.spendCents)} spent in ${W} days`);
  const pooled = O > 0n
    ? `${formatCents(divRoundHalfUp(Number(SP), Number(O)))} per ${words[0]} across the ${compared.length} campaigns compared (${plural(Number(O), words[0], words[1])} on ${formatCents(Number(SP))})`
    : `the ${compared.length} campaigns compared, none with ${words[1]}`;
  const comparedSet = new Set(compared);

  const out: ProposalRow[] = rows.map((r) => {
    const f = formatCents(r.from);
    const t = formatCents(r.to);
    let reasonCode: ProposalReasonCode;
    let sentence: string;
    if (r.blockers.length > 0) {
      reasonCode = 'KEPT_NOT_ELIGIBLE';
      sentence = `Keep at ${f} a day: not moved, because it is ${r.blockers.map((b) => BLOCKER_WORDS[b]).join('; ')}.`;
    } else if (!comparedSet.has(r)) {
      if (r.counts.agreements < rules.minAgreements) {
        reasonCode = 'KEPT_BELOW_MINIMUM_SAMPLE';
        sentence = `Keep at ${f} a day: ${plural(r.counts.agreements, 'agreement', 'agreements')} in ${W} days, fewer than the ${rules.minAgreements} needed before money moves to or from a campaign.`;
      } else {
        reasonCode = 'KEPT_NO_SPEND';
        sentence = `Keep at ${f} a day: no spend reported in ${W} days, so its cost per ${words[0]} cannot be measured.`;
      }
    } else if (r.fit > 0) {
      reasonCode = 'LOWERED_TO_FIT_CEILING';
      sentence = `Lower from ${f} to ${t} a day so the daily budgets total ${formatCents(proposed)}, within the cap's daily ceiling of ${formatCents(cap.dailyCeilingCents)}: ${eff(r)}.`;
    } else if (r.to < r.from) {
      reasonCode = 'LOWERED_HIGHER_COST_PER_OUTCOME';
      sentence = `Lower from ${f} to ${t} a day: ${eff(r)}, above the ${pooled}.`;
    } else if (r.to > r.from) {
      reasonCode = 'RAISED_LOWER_COST_PER_OUTCOME';
      sentence = `Raise from ${f} to ${t} a day: ${eff(r)}, below the ${pooled}.`;
    } else {
      reasonCode = 'KEPT_UNCHANGED';
      sentence = `Keep at ${f} a day: ${eff(r)}, against the ${pooled}.`;
    }
    return { campaignId: r.c.id, fromDailyCents: r.from, toDailyCents: r.to, changed: r.to !== r.from, reasonCode, sentence, blockers: r.blockers, targetingIssues: r.targetingIssues };
  });
  const changes: AllocationChange[] = out.filter((r) => r.changed).map((r) => ({ campaign_id: r.campaignId, to_daily_cents: r.toDailyCents }));
  return {
    capVersionId: cap.id, capVersionNo: cap.versionNo, changes, rows: out,
    totals: { currentDailyCents: current, proposedDailyCents: proposed, ceilingDailyCents: cap.dailyCeilingCents }, counts,
  };
}
