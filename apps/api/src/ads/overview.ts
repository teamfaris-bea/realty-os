// GET /ads and GET /ads/ledger (module 52; R-ADS-5, R-ADS-6, R-ADS-11, R-ADS-12, R-AST-13; E449-E456). Stored facts only:
// no provider call. Every number carries its denominator; there is no confidence or probability anywhere. The pack key is
// never shown as words to a person by this API: the web turns `packKey` into words (words.ts); `packSentence` is the
// integrations page's own sentence.
import { type CampaignCounts, countedDailyCents, tenantDailyTotal } from '@realty/core/ads';
import type { Instant } from '@realty/core/foundation';
import type { Tx } from '@realty/db';
import { packSentence } from '../integrations/catalog.js';
import { spendMonth } from './caps.js';
import * as repo from './repo.js';
import {
  CAP_COUNTS_EVERY_CAMPAIGN, LEDGER_PER_CAMPAIGN, OVERSPEND_NOTE, OVERSPEND_NOTE_DARK, OVERSPEND_NOTE_MANAGED_ONLY, OVERSPEND_NOTE_NO_LEAD_SOURCE, OVERSPEND_NOTE_NOT_CONNECTED,
  OVERSPEND_NOTE_NOT_READ, READS_WHILE_DARK, dollars,
} from './settings.js';
import { uncheckedConnections, uncheckedText } from './unchecked.js';

export type AdsState = 'not_cleared' | 'no_connection' | 'connection_not_live' | 'no_lead_source' | 'no_cap' | 'ready';

// What is true on this deployment (b11 api-ui/F2): the web app has no Google Ads connect button and no lead-source
// control for a connection yet, so no sentence sends the person to one.
const STATE_SENTENCE: Record<AdsState, string> = {
  not_cleared: 'Budget changes and the pause at your monthly cap stay off until counsel review and the Google Ads check are complete. Spend is still read and shown, and you are alerted at the cap.',
  no_connection: 'No Google Ads account is connected, so there are no campaigns or spend to show.',
  connection_not_live: 'The Google Ads account is no longer connected, so its campaigns and spend are not read and no budget moves.',
  no_lead_source: 'The Google Ads account has no lead source, so its spend is not recorded and no budget moves.',
  no_cap: 'Set a monthly cap and a daily ceiling before any budget can move.',
  ready: 'Budget proposals arrive each Monday; each one waits for an Owner or Admin to approve it.',
};
const NOT_READ = 'Budget changes and the pause at your monthly cap stay off until counsel review and the Google Ads check are complete. Until then Google Ads is not read, so';
/**
 * Q-ADS-1 answered "no" while dark (b11 ads-7): nothing is read, but campaigns and spend read while the pack was cleared
 * (before a withdrawal, an E443 pack bump, or the answer reaching this deployment) stay stored and listed.
 */
function notReadSentence(stored: boolean, lastReadAt: string | null): string {
  if (!stored) return `${NOT_READ} no campaigns or spend are shown.`;
  return lastReadAt
    ? `${NOT_READ} the campaigns and spend shown are as Google Ads reported them at ${lastReadAt.slice(0, 16).replace('T', ' ')} UTC and are not updated.`
    : `${NOT_READ} the campaigns and spend shown are from an earlier read and are not updated.`;
}

export interface LedgerView {
  id: string;
  runId: string;
  campaignId: string;
  kind: string;
  fromDailyCents: number;
  toDailyCents: number;
  reasonCode: string;
  providerRef: string | null;
  occurredAt: string;
}

const ledgerView = (e: repo.LedgerRow): LedgerView => ({
  id: e.id, runId: e.runId, campaignId: e.campaignId, kind: e.eventKind, fromDailyCents: e.fromDailyCents, toDailyCents: e.toDailyCents,
  reasonCode: e.reasonCode, providerRef: e.providerRef, occurredAt: e.occurredAt,
});

/** Why a campaign is or is not managed here, from stored facts (R-ADS-12, E449). */
export function managedWhy(c: repo.CampaignRow, snapshot: repo.SyncSnapshot | null): { managed: boolean; why: string } {
  if (c.status === 'active') return { managed: true, why: 'Managed here: linked to a listing with an approved creative.' };
  if (c.status === 'paused') return { managed: false, why: 'Paused on Google Ads.' };
  if (c.status === 'ended') return { managed: false, why: 'Ended on Google Ads.' };
  if (c.status === 'rejected') {
    const issue = snapshot?.campaigns[c.externalCampaignId]?.issue;
    return { managed: false, why: issue ? `Rejected on Google Ads (${issue.toLowerCase().replaceAll('_', ' ')}).` : 'Rejected on Google Ads.' };
  }
  if (c.listingId === null || c.creativePieceId === null) return { managed: false, why: 'Not linked to a listing and its creative.' };
  if (!(c.creativeStatus === 'approved' || c.creativeStatus === 'published') || c.creativeListingId !== c.listingId) return { managed: false, why: 'Its creative is not an approved piece of the linked listing.' };
  return { managed: false, why: 'Google Ads did not report it as a housing campaign with its own budget in US dollars at the last sync.' };
}

function budgetNote(c: repo.CampaignRow, snapshot: repo.SyncSnapshot | null): string | null {
  const b = snapshot?.campaigns[c.externalCampaignId]?.budget;
  if (b === 'shared') return 'shared budget';
  if (b === 'not_reported' || (c.dailyBudgetCents === 0 && b !== 'own')) return 'budget not reported';
  return null;
}

/** The latest stored proposal or hold of the weekly path (its counts are the per-campaign denominators). */
function countsOf(a: repo.ActionRow | null): { at: string; windowDays: number; byCampaign: Map<string, CampaignCounts> } | null {
  if (!a) return null;
  const counts = a.payload.counts as { windowDays?: number; campaigns?: CampaignCounts[] } | undefined;
  if (!counts || !Array.isArray(counts.campaigns)) return null;
  return { at: a.createdAt, windowDays: counts.windowDays ?? 90, byCampaign: new Map(counts.campaigns.map((c) => [c.campaignId as string, c])) };
}

/** The owner-question defaults the page follows (settings.ts, as the reconcile does); a test passes the other answer. */
export interface OverviewOptions {
  /** Q-ADS-1 */
  readsWhileDark?: boolean;
  /** Q-ADS-3 */
  capCountsEveryCampaign?: boolean;
}

export async function buildOverview(tx: Tx, now: Instant, o: OverviewOptions = {}) {
  const readsWhileDark = o.readsWhileDark ?? READS_WHILE_DARK;
  const countEvery = o.capCountsEveryCampaign ?? CAP_COUNTS_EVERY_CAMPAIGN;
  const pack = await repo.packRow(tx);
  const cleared = await repo.packCleared(tx);
  const all = await repo.adsConnections(tx, { withDisconnected: true });
  const conns = all.filter((c) => c.status !== 'disconnected');
  const live = conns.find((c) => c.status === 'connected' || c.status === 'degraded') ?? null;
  const cap = await repo.capInForce(tx);
  const campaigns = await repo.campaignRows(tx);
  // E454 (b11 api-ui/F4): a disconnected account whose campaigns are still listed is "no longer connected", never "none"
  const anyConnection = conns.length > 0 || all.some((c) => campaigns.some((x) => x.connectionId === c.id));
  const state: AdsState = !cleared
    ? 'not_cleared'
    : live === null
      ? anyConnection ? 'connection_not_live' : 'no_connection'
      : live.leadSourceId === null
        ? 'no_lead_source'
        : cap === null
          ? 'no_cap'
          : 'ready';
  const core = campaigns.map(repo.toCoreCampaign);
  const { month, zone } = await spendMonth(tx, now);
  const costs = await repo.adsSyncCosts(tx, month);
  const spent = costs.reduce((s, c) => s + c.amountCents, 0);
  const pending = await repo.latestReallocation(tx, ['proposed'], { origin: 'weekly' });
  const latestHold = await repo.latestReallocation(tx, ['blocked'], { origin: 'weekly' });
  const latestWeekly = await repo.latestReallocation(tx, ['proposed', 'blocked', 'approved', 'executed', 'rejected', 'superseded'], { origin: 'weekly' });
  const counts = countsOf(latestWeekly);
  const snapshotOf = (connectionId: string) => all.find((c) => c.id === connectionId)?.snapshot ?? null;
  const doubles = await repo.doubleCounted(tx, month);
  const syncedAt = live?.lastSyncedAt ?? null;
  // the reconcile's alert rule (unchecked.ts): a live connection, or a revoked or disconnected one whose campaigns are
  // still mirrored and whose account is not connected again; the live one's sentence first (b11 api-ui/F4, ads-5)
  const uncheckedAll = uncheckedConnections(all, campaigns, now);
  const unchecked = uncheckedAll.find((c) => c.id === live?.id) ?? uncheckedAll[0] ?? null;
  const lastReadAt = all.reduce<string | null>((m, c) => (c.lastSyncedAt !== null && (m === null || Date.parse(c.lastSyncedAt) > Date.parse(m)) ? c.lastSyncedAt : m), null);

  const views = [];
  let unmanagedDaily = 0;
  for (const c of campaigns) {
    const snap = snapshotOf(c.connectionId);
    const m = managedWhy(c, snap);
    if (!m.managed && (c.status === 'draft')) unmanagedDaily += c.dailyBudgetCents;
    const k = counts?.byCampaign.get(c.id) ?? null;
    views.push({
      id: c.id, name: c.name, externalCampaignId: c.externalCampaignId, connectionId: c.connectionId, status: c.status, managed: m.managed, why: m.why,
      dailyBudgetCents: c.dailyBudgetCents, budgetNote: budgetNote(c, snap), countedDailyCents: countedDailyCents(repo.toCoreCampaign(c)),
      listingId: c.listingId, creativePieceId: c.creativePieceId,
      outcomes: k && counts ? { agreements: k.agreements, closings: k.closings, spendCents: k.spendCents, windowDays: counts.windowDays, asOf: counts.at } : null,
      ledger: (await repo.ledgerPage(tx, { limit: LEDGER_PER_CAMPAIGN, campaignId: c.id })).map(ledgerView),
    });
  }
  const managedTotal = tenantDailyTotal(core);
  const shown = (a: repo.ActionRow | null) =>
    a ? { id: a.id, status: a.status, explanation: a.explanation, createdAt: a.createdAt, payload: a.payload } : null;
  return {
    state,
    stateSentence: state === 'not_cleared' && !readsWhileDark ? notReadSentence(campaigns.length > 0 || costs.length > 0, lastReadAt) : STATE_SENTENCE[state],
    packKey: 'platform:ads',
    packSentence: pack ? packSentence(pack) : 'Changing Google Ads budgets stays off: the pack is missing on this deployment.',
    cleared,
    cap: cap ? { id: cap.id, versionNo: cap.versionNo, monthlyCapCents: cap.monthlyCapCents, dailyCeilingCents: cap.dailyCeilingCents, effectiveFrom: cap.effectiveFrom } : null,
    // Q-ADS-3 "no" (b11 ads-7): the stored figure covers every campaign recorded here, the cap only the linked ones
    monthToDate: {
      month: month.slice(0, 7), zone, spentCents: spent, capCents: cap?.monthlyCapCents ?? null,
      sentence: !cap
        ? `${dollars(spent)} spent in ${month.slice(0, 7)}; no monthly cap set.`
        : countEvery
          ? `${dollars(spent)} of your ${dollars(cap.monthlyCapCents)} monthly cap spent in ${month.slice(0, 7)}.`
          : `${dollars(spent)} spent in ${month.slice(0, 7)} on the campaigns recorded here; your ${dollars(cap.monthlyCapCents)} monthly cap counts only the campaigns linked to a listing here.`,
    },
    dailyTotal: { countedCents: managedTotal, ceilingCents: cap?.dailyCeilingCents ?? null, sentence: cap ? `Daily budgets total ${dollars(managedTotal)} against your ${dollars(cap.dailyCeilingCents)} daily ceiling.` : `Daily budgets total ${dollars(managedTotal)}.` },
    // b11 api-ui/F4: the pause runs only while the pack is cleared and a connection is live (the reconcile reads no other),
    // and covers only campaigns it records; Q-ADS-3 "no" (b11 ads-7): only linked campaigns count, only managed ones pause
    overspendNote: !cleared
      ? (readsWhileDark ? OVERSPEND_NOTE_DARK : OVERSPEND_NOTE_NOT_READ)
      : live === null
        ? OVERSPEND_NOTE_NOT_CONNECTED
        : !countEvery
          ? OVERSPEND_NOTE_MANAGED_ONLY
          : live.leadSourceId === null ? OVERSPEND_NOTE_NO_LEAD_SOURCE : OVERSPEND_NOTE,
    asOf: syncedAt ? `as reported by Google Ads at ${syncedAt}` : null,
    lastSyncedAt: syncedAt,
    uncheckedSentence: unchecked ? `${uncheckedText(unchecked.lastSyncedAt).title}.` : null,
    campaigns: views,
    unmanagedDailyCents: unmanagedDaily,
    unmanagedSentence: `${dollars(unmanagedDaily)} a day of budgets on campaigns not managed here.`,
    doubleCount: doubles.length > 0
      ? { leadSourceIds: doubles, sentence: `${doubles.length} ${doubles.length === 1 ? 'lead source has' : 'lead sources have'} both a cost typed in by hand and Google Ads spend for ${month.slice(0, 7)}: the owner view counts both.` }
      : null,
    pendingProposal: shown(pending),
    latestHold: latestHold && (!pending || Date.parse(latestHold.createdAt) > Date.parse(pending.createdAt)) ? shown(latestHold) : null,
  };
}

export async function ledgerPageView(tx: Tx, before: string | undefined, limit: number): Promise<{ events: LedgerView[]; next: string | null }> {
  const rows = await repo.ledgerPage(tx, { before, limit });
  return { events: rows.map(ledgerView), next: rows.length === limit ? rows[rows.length - 1]!.id : null };
}
