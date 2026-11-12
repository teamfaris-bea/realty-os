// The weekly proposal of api/ads (module 52; job ads.propose: an hourly wake that acts on the tenant's local Monday, once
// per ISO week, dedupe `ads_proposal:<isoWeek>`; R-ADS-2, R-ADS-6, R-ADS-10; D-ADS; E123).
//
// Runs only while platform:ads is cleared, a cap is in force and a live ads_google connection has a lead source.
// Inputs: every campaign with its latest ledger event; 90 days of daily Google Ads spend (read OUTSIDE any transaction);
// the agreements (agreement_signed_at) and closings (closed_at) of deals carrying each campaign's `gads:<id>` ref; and
// core/ads DEFAULT_ALLOC_RULES, unchanged. core/ads proposeReallocation decides.
//
// A proposal is stored as an ownerless, contactless `ad_reallocation` (money, requires approval, proposed): Owner, Admin,
// the system and a support session (read-only) can read it; Team Leads and agents cannot (actions_select); the generic
// assistant approve/reject routes 404 for it (they need owner_user_id = the caller). Only POST /ads/proposals/:id/approve
// (ads/dispatch.ts) plans it. A hold is the same kind with status `blocked` and its counts; the cap check reads only
// approved or executed actions, so a hold is never planned. Either result supersedes the pending proposal.
import { DEFAULT_ALLOC_RULES, type AllocRules, type Hold, type Proposal, proposeReallocation } from '@realty/core/ads';
import { DAY_MS, type TenantId, ianaZone, instant, localDateOf, toIso } from '@realty/core/foundation';
import { addDaysLocal, isoWeekOf, isoWeekday, tenantZone } from '../insights/common.js';
import type { AdsSpendRow } from './provider.js';
import * as repo from './repo.js';
import { type AdsDeps, account, asSystem, clockOf } from './runtime.js';
import { MANAGED_CURRENCY, PROPOSAL_WEEKDAY, dollars } from './settings.js';

export const proposalKey = (isoWeek: string): string => `ads_proposal:${isoWeek}`;

export type ProposeOutcome =
  | 'not_proposal_day'
  | 'exists'
  | 'not_cleared'
  | 'no_cap'
  | 'no_connection'
  | 'currency_unsupported'
  | 'provider_failed'
  | 'proposed'
  | 'held';

export interface ProposeReport {
  outcome: ProposeOutcome;
  week: string | null;
  actionId: string | null;
  superseded: number;
}

const HOLD_WORDS: Record<Hold['hold'], string> = {
  ADS_BELOW_MINIMUM_SAMPLE: 'fewer than two campaigns have enough agreements to compare',
  ADS_NO_PLAN_FITS: 'no change fits the daily ceiling',
  ADS_NOTHING_TO_MOVE: 'the campaigns compared cost about the same per outcome',
};

/** The one-line "why" of a proposal (≤ 300 characters), with its denominators. */
export function proposalExplanation(p: Proposal, rules: AllocRules): string {
  const compared = p.counts.campaigns.filter((c) => c.agreements >= rules.minAgreements && c.spendCents > 0);
  const outcomes = compared.reduce((s, c) => s + (rules.leadingOutcome === 'agreements' ? c.agreements : c.closings), 0);
  const spent = compared.reduce((s, c) => s + c.spendCents, 0);
  const word = rules.leadingOutcome === 'agreements' ? 'agreements' : 'closings';
  const text = `Move daily budget toward lower cost per ${word.slice(0, -1)}: ${p.changes.length} of ${p.rows.length} campaigns change, ${dollars(p.totals.currentDailyCents)} to ${dollars(p.totals.proposedDailyCents)} a day (ceiling ${dollars(p.totals.ceilingDailyCents)}); ${outcomes} ${word} on ${dollars(spent)} across campaigns with ${rules.minAgreements} or more agreements in ${rules.windowDays} days.`;
  return text.slice(0, 300);
}

/** The one-line "why" of a hold (≤ 300 characters), with its counts (R-ADS-6). */
export function holdExplanation(h: Hold, rules: AllocRules): string {
  const enough = h.counts.campaigns.filter((c) => c.agreements >= rules.minAgreements).length;
  return `No budget change this week: ${HOLD_WORDS[h.hold]}. ${enough} of ${h.counts.campaigns.length} campaigns had ${rules.minAgreements} or more agreements in ${rules.windowDays} days.`.slice(0, 300);
}

/** One hourly wake for one tenant: builds this ISO week's proposal or hold on the local Monday, once. */
export async function runWeeklyProposal(d: AdsDeps, tenantId: TenantId | string, rules: AllocRules = DEFAULT_ALLOC_RULES): Promise<ProposeReport> {
  const now = clockOf(d);
  const pre = await asSystem(d, tenantId, async (tx) => {
    const zone = await tenantZone(tx);
    const today = localDateOf(now, zone);
    if (isoWeekday(today) !== PROPOSAL_WEEKDAY) return { outcome: 'not_proposal_day' as const, week: null };
    const week = isoWeekOf(today);
    if (await repo.reallocationByDedupe(tx, proposalKey(week))) return { outcome: 'exists' as const, week };
    if (!(await repo.packCleared(tx))) return { outcome: 'not_cleared' as const, week };
    const cap = await repo.capInForce(tx);
    if (!cap) return { outcome: 'no_cap' as const, week };
    const conn = (await repo.adsConnections(tx)).find((c) => (c.status === 'connected' || c.status === 'degraded') && c.leadSourceId !== null);
    if (!conn) return { outcome: 'no_connection' as const, week };
    return { outcome: 'go' as const, week, conn };
  });
  if (pre.outcome !== 'go') return { outcome: pre.outcome, week: pre.week, actionId: null, superseded: 0 };
  const { week, conn } = pre;

  // 90 days of daily spend, outside any transaction
  const acct = await account(d, tenantId, conn);
  if (!acct) return { outcome: 'provider_failed', week, actionId: null, superseded: 0 };
  let rows: AdsSpendRow[];
  let window: { days: number; from: string; to: string; zone: string };
  try {
    const info = await d.ads.accountInfo(acct);
    const zone = ianaZone(info.timeZone);
    if (info.currency !== MANAGED_CURRENCY || !zone) return { outcome: 'currency_unsupported', week, actionId: null, superseded: 0 };
    const today = localDateOf(now, zone);
    window = { days: rules.windowDays, from: addDaysLocal(today, -rules.windowDays), to: addDaysLocal(today, -1), zone: info.timeZone };
    rows = await d.ads.spend(acct, { from: window.from, to: window.to, granularity: 'day' });
  } catch {
    return { outcome: 'provider_failed', week, actionId: null, superseded: 0 };
  }

  return asSystem(d, tenantId, async (tx) => {
    // another wake built it meanwhile: the dedupe key holds one per week
    if (await repo.reallocationByDedupe(tx, proposalKey(week))) return { outcome: 'exists' as const, week, actionId: null, superseded: 0 };
    const cap = await repo.capInForce(tx);
    if (!cap || !(await repo.packCleared(tx))) return { outcome: (cap ? 'not_cleared' : 'no_cap') as ProposeOutcome, week, actionId: null, superseded: 0 };
    const campaigns = await repo.campaignRows(tx);
    const ofConn = campaigns.filter((c) => c.connectionId === conn.id);
    const spendBy = new Map<string, number>();
    for (const r of rows) spendBy.set(r.externalCampaignId, (spendBy.get(r.externalCampaignId) ?? 0) + r.spendCents);
    const since = toIso(instant(now - rules.windowDays * DAY_MS));
    const outcomes = await repo.dealOutcomes(tx, campaigns.map((c) => c.campaignRef), since);
    const result = proposeReallocation(
      campaigns.map(repo.toCoreCampaign),
      ofConn.map((c) => ({ campaignId: c.id as never, spendCents: spendBy.get(c.externalCampaignId) ?? 0, windowDays: rules.windowDays })),
      { windowDays: rules.windowDays, campaigns: campaigns.map((c) => ({ campaignId: c.id as never, agreements: outcomes.get(c.campaignRef)?.agreements ?? 0, closings: outcomes.get(c.campaignRef)?.closings ?? 0 })) },
      { id: cap.id, versionNo: cap.versionNo, monthlyCapCents: cap.monthlyCapCents, dailyCeilingCents: cap.dailyCeilingCents, effectiveFrom: instant(Date.parse(cap.effectiveFrom)) },
      rules,
    );
    const id = d.ids.next<'AssistantActionId'>();
    const builtAt = toIso(now);
    let inserted: boolean;
    let outcome: ProposeOutcome;
    if ('changes' in result) {
      outcome = 'proposed';
      inserted = await repo.insertReallocation(tx, {
        id, status: 'proposed', explanation: proposalExplanation(result, rules), dedupeKey: proposalKey(week),
        payload: {
          v: 1, kind: 'weekly', connection_id: conn.id, cap_version_id: cap.id, cap_version_no: cap.versionNo, window, leading_outcome: rules.leadingOutcome,
          changes: result.changes, rows: result.rows, totals: result.totals, counts: result.counts, built_at: builtAt,
        },
      });
    } else {
      outcome = 'held';
      inserted = await repo.insertReallocation(tx, {
        id, status: 'blocked', explanation: holdExplanation(result, rules), dedupeKey: proposalKey(week),
        payload: { v: 1, hold: result.hold, counts: result.counts, window, connection_id: conn.id, built_at: builtAt },
      });
    }
    if (!inserted) return { outcome: 'exists' as const, week, actionId: null, superseded: 0 };
    const superseded = await repo.supersedePending(tx, id);
    return { outcome, week, actionId: id, superseded };
  });
}
