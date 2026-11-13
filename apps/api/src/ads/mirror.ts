// The hourly reconcile of api/ads (module 52; job ads.reconcile): the campaign mirror, the spend sync into the owner
// view's ads_sync costs, the readback of unresolved plans and the monthly-cap overspend check (R-ADS-4, R-ADS-5,
// R-ADS-11, R-ADS-12, R-ADS-13, R-INT-2, R-OWNER-5; Q-ADS-1, Q-ADS-3; E124, E146, E449-E456, E458).
//
// Reads run while dark (Q-ADS-1, settings READS_WHILE_DARK): with that default off, a pass while platform:ads is not
// cleared reads nothing, writes nothing and alerts nothing, and GET /ads says why.
// Per pass, for every connected/degraded ads_google connection, as the system of the job's tenant:
//   1. the token is decrypted in a short transaction (R-INT-4);
//   2. accountInfo, listCampaigns and spend are called OUTSIDE any transaction (4 reads per connection-hour:
//      accountInfo, listCampaigns, daily and hourly spend; VERIFY against the Google Ads access level's daily limit);
//   3. one transaction mirrors the campaigns (new rows take the connection's lead source and campaign_ref
//      'gads:<id>'; names clipped to the 200-character CHECK; a null budget is stored as 0; targeting mapped to a
//      TargetingSpec where possible, else {} which the validator refuses), recomputes every status, records the
//      connection's health (module 21's status machine) and, after a successful spend check, last_synced_at. Without
//      a lead source no row is added, but rows already mirrored keep being updated (each keeps its own lead source);
//   4. unresolved plans are resolved by readback (ads/dispatch.ts resolveOpenPlans);
//   5. month-to-date spend of EVERY campaign of the account (Q-ADS-3, settings CAP_COUNTS_EVERY_CAMPAIGN) against the
//      cap in force: cleared ⇒ the mirrored campaigns Google Ads reports serving are paused (ads/dispatch.ts
//      pauseForMonthlyCap, which re-checks the pack before each call), whatever the connection's lead source
//      (b11 sends-gates/F2); dark ⇒ alert only; a serving campaign never mirrored (no lead source) ⇒ alert to pause it
//      in Google Ads. VERIFY WITH COUNSEL (C3): auto-pausing at the cap, unmanaged campaigns included.
// Then one transaction writes the ads_sync costs (one row per lead source and account-zone month, current and previous;
// never deleted; manual rows untouched) and the "not checked for 2 hours" alerts (live, revoked or disconnected
// connections that still have mirrored campaigns, unless the account is connected again; unchecked.ts; R-ADS-13, E453,
// E454).
// Nothing is written back to Google Ads except through ads/dispatch.ts: no targeting, name or status.
import { overspend, type CampaignId, type CampaignStatus, type HourlySpend } from '@realty/core/ads';
import { type Instant, type TenantId, ianaZone, instant, localDateOf, resolveWall, toIso } from '@realty/core/foundation';
import { createHash } from 'node:crypto';
import { audit, redactDiff } from '../audit.js';
import { ProviderError } from '../providers/types.js';
import { transitionConnection, type ConnectionRow } from '../integrations/status.js';
import { systemActor } from '../worker/systemActor.js';
import { pauseForMonthlyCap, resolveOpenPlans, type PauseReport, type ResolveReport } from './dispatch.js';
import type { AdsAccount, AdsAccountInfo, AdsCampaignReport, AdsSpendRow } from './provider.js';
import * as repo from './repo.js';
import { type AdsDeps, account, asSystem, clockOf, safeCode } from './runtime.js';
import { CAP_COUNTS_EVERY_CAMPAIGN, MANAGED_CURRENCY, READS_WHILE_DARK, campaignRefOf, dollars } from './settings.js';
import { uncheckedConnections, uncheckedText } from './unchecked.js';

// ---- pure mapping ---------------------------------------------------------------------------------------------------

/** A campaign name inside the 0018 CHECK (1..200 characters after trimming); an empty one becomes "Campaign <id>". */
export function campaignName(name: string, externalCampaignId: string): string {
  const clean = (s: string) => s.replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
  const n = clean(name).slice(0, 200).trim();
  return n.length > 0 ? n : clean(`Campaign ${externalCampaignId}`).slice(0, 200).trim();
}

/**
 * The platform's targeting as core/fairhousing's TargetingSpec where it maps exactly (one proximity criterion with a
 * radius in miles, VERIFY: its centre is the listing), else {} (refused by validateTargeting: never moved, E458).
 */
export function mapTargeting(t: unknown): Record<string, unknown> {
  const obj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (obj(t) && Object.keys(t).length === 1 && obj(t.proximity) && Object.keys(t.proximity).length === 1) {
    const r = t.proximity.radiusMiles;
    if (typeof r === 'number' && Number.isFinite(r)) return { geo: 'radius_of_listing', radiusMiles: r };
  }
  return {};
}

/**
 * The mirrored status, recomputed every pass: removed ⇒ ended; a serving issue ⇒ rejected (E146); paused ⇒ paused;
 * enabled ⇒ active only when linked (a listing plus a currently approved or published creative of it), declared housing,
 * its own budget and the managed currency; otherwise draft ("not managed here", E449).
 */
export function mirrorStatus(r: AdsCampaignReport, o: { linked: boolean; currencyOk: boolean }): CampaignStatus {
  if (r.platformStatus === 'removed') return 'ended';
  if (r.servingIssue !== null) return 'rejected';
  if (r.platformStatus === 'paused') return 'paused';
  if (r.platformStatus === 'enabled' && o.linked && r.housingDeclared === true && !r.sharedBudget && r.dailyBudgetCents !== null && o.currencyOk) return 'active';
  return 'draft';
}

const isLinked = (c: repo.CampaignRow): boolean =>
  c.listingId !== null && c.creativePieceId !== null && (c.creativeStatus === 'approved' || c.creativeStatus === 'published') && c.creativeListingId === c.listingId;

/** First day of the month of an account-zone date, and of the previous month. */
export function monthsOf(today: string): { current: string; previous: string } {
  const y = Number(today.slice(0, 4));
  const m = Number(today.slice(5, 7));
  const pad = (x: number) => String(x).padStart(2, '0');
  return { current: `${today.slice(0, 7)}-01`, previous: m === 1 ? `${y - 1}-12-01` : `${y}-${pad(m - 1)}-01` };
}

/** A stable lower-case UUID for a campaign the mirror does not hold (core's overspend takes UUIDs; Q-ADS-3 counts it). */
function syntheticId(connectionId: string, ext: string): CampaignId {
  const h = createHash('sha256').update(`${connectionId}:${ext}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}` as CampaignId;
}

/** Hourly provider rows as core's HourlySpend (instants in the account zone; rows of one instant summed). */
export function hourlyOf(rows: readonly AdsSpendRow[], zone: string, idOf: (ext: string) => CampaignId): HourlySpend[] {
  const z = ianaZone(zone);
  if (!z) return [];
  const sum = new Map<string, HourlySpend>();
  for (const r of rows) {
    if (r.hour === null || !Number.isSafeInteger(r.spendCents) || r.spendCents < 0) continue;
    const [y, m, d] = r.date.split('-').map(Number) as [number, number, number];
    const at = resolveWall(Date.UTC(y, m - 1, d, r.hour), z, 'earlier');
    const id = idOf(r.externalCampaignId);
    const key = `${id}@${at}`;
    const prev = sum.get(key);
    sum.set(key, { campaignId: id, hourStart: at, spendCents: (prev?.spendCents ?? 0) + r.spendCents });
  }
  return [...sum.values()];
}

// ---- the pass -------------------------------------------------------------------------------------------------------

export interface ConnectionPass {
  connectionId: string;
  outcome: 'synced' | 'currency_unsupported' | 'quota' | 'revoked' | 'failed' | 'no_token';
  mirrored: number;
  inserted: number;
  noLeadSource: boolean;
  monthToDateCents: number | null;
  capReached: boolean;
  plans: ResolveReport | null;
  pause: PauseReport | null;
  alerted: number;
}

export interface ReconcileReport {
  cleared: boolean;
  /** Q-ADS-1 answered "no": the pass read nothing because platform:ads is not cleared */
  readsSkipped: boolean;
  connections: ConnectionPass[];
  costsWritten: number;
  uncheckedAlerts: number;
}

interface Fetched {
  info: AdsAccountInfo;
  campaigns: AdsCampaignReport[];
  daily: AdsSpendRow[];
  hourly: AdsSpendRow[];
  today: string;
}

const rowOf = (c: repo.AdsConnection): ConnectionRow => ({
  kind: 'ads_google', status: c.status, statusReason: c.statusReason, externalAccountId: c.externalAccountId, credentialId: c.credentialId,
  capabilities: {}, connectedAt: c.connectedAt, disconnectedAt: null, lastErrorCode: c.lastErrorCode,
});

/** Records the connection's health through module 21's status machine (and the sync time on a successful spend check). */
async function recordHealth(d: AdsDeps, tenantId: string, c: repo.AdsConnection, e: { type: 'health_ok' } | { type: 'health_degraded'; code: string } | { type: 'token_revoked'; code: string }, synced?: { at: string; snapshot: repo.SyncSnapshot }): Promise<void> {
  await asSystem(d, tenantId, async (tx) => {
    const now = (await repo.adsConnections(tx, { forUpdate: true })).find((x) => x.id === c.id);
    if (!now || (now.status !== 'connected' && now.status !== 'degraded')) return;
    const before = rowOf(now);
    const next =
      e.type === 'health_ok'
        ? before.status === 'degraded' ? transitionConnection(before, e) : { ...before, lastErrorCode: null }
        : e.type === 'health_degraded'
          ? before.status === 'degraded' ? { ...before, statusReason: e.code, lastErrorCode: e.code } : transitionConnection(before, e)
          : transitionConnection(before, e);
    await repo.recordConnectionSync(tx, c.id, { status: next.status, statusReason: next.statusReason, lastErrorCode: next.lastErrorCode, ...(synced ? { synced } : {}) });
    if (next.status !== now.status) {
      await audit(tx, systemActor(tenantId, 'provider'), { action: 'integration.changed', entity: { type: 'integration_connection', id: c.id }, changes: redactDiff({ status: now.status }, { status: next.status }), reason: next.statusReason ?? 'HEALTH_OK' });
    }
  });
}

async function fetchAccount(d: AdsDeps, acct: AdsAccount, now: Instant): Promise<Fetched> {
  const info = await d.ads.accountInfo(acct);
  const campaigns = await d.ads.listCampaigns(acct);
  const zone = ianaZone(info.timeZone);
  if (!zone) throw new ProviderError('rejected', 'ACCOUNT_ZONE_INVALID');
  const today = localDateOf(now, zone) as string;
  const months = monthsOf(today);
  if (info.currency !== MANAGED_CURRENCY) return { info, campaigns, daily: [], hourly: [], today };
  const daily = await d.ads.spend(acct, { from: months.previous, to: today, granularity: 'day' });
  const hourly = await d.ads.spend(acct, { from: months.current, to: today, granularity: 'hour' });
  return { info, campaigns, daily, hourly, today };
}

function failureOf(e: unknown): { outcome: ConnectionPass['outcome']; event: { type: 'health_degraded'; code: string } | { type: 'token_revoked'; code: string } } {
  if (e instanceof ProviderError) {
    if (e.kind === 'rejected' && (e.providerCode === 'TOKEN_REVOKED' || e.providerCode === 'TOKEN_INVALID' || e.providerCode === 'INVALID_GRANT')) {
      return { outcome: 'revoked', event: { type: 'token_revoked', code: 'TOKEN_REVOKED' } };
    }
    if (e.kind === 'unavailable' && e.providerCode === 'QUOTA') return { outcome: 'quota', event: { type: 'health_degraded', code: 'ADS_QUOTA' } };
    if (e.kind === 'not_configured') return { outcome: 'failed', event: { type: 'health_degraded', code: 'ADS_NOT_CONFIGURED' } };
    return { outcome: 'failed', event: { type: 'health_degraded', code: safeCode(e.providerCode ? `ADS_${e.providerCode}` : undefined, 'ADS_SYNC_FAILED') } };
  }
  return { outcome: 'failed', event: { type: 'health_degraded', code: 'ADS_SYNC_FAILED' } };
}

/** The overspend alert texts (title ≤ 120, body ≤ 240; amounts and counts only, R-TEN-7). VERIFY WITH COUNSEL (C3) the copy. */
export function overspendText(o: { kind: 'paused'; paused: number; capCents: number } | { kind: 'dark'; capCents: number } | { kind: 'no_lead_source'; capCents: number }): { title: string; body: string } {
  if (o.kind === 'paused') {
    return { title: 'Google Ads paused at your monthly cap', body: `Paused ${o.paused} ${o.paused === 1 ? 'campaign' : 'campaigns'}: month-to-date spend reached your ${dollars(o.capCents)} cap.` };
  }
  if (o.kind === 'dark') {
    return {
      title: 'Google Ads spend reached your monthly cap',
      body: `Month-to-date spend reached your ${dollars(o.capCents)} cap. Realty OS cannot pause campaigns until counsel review and the Google Ads check are complete: pause them in Google Ads.`,
    };
  }
  return {
    title: 'Google Ads spend reached your monthly cap',
    body: `Month-to-date spend reached your ${dollars(o.capCents)} cap. The Google Ads account has no lead source, so Realty OS has no record of some running campaigns and cannot pause them: pause them in Google Ads.`,
  };
}

export { uncheckedText };

async function notifyAll(d: AdsDeps, tenantId: string, connectionId: string, text: { title: string; body: string }, dedupeKey: string): Promise<number> {
  return asSystem(d, tenantId, async (tx) => {
    let sent = 0;
    for (const userId of await repo.ownersAndAdmins(tx)) {
      if (await repo.notifyOverspend(tx, d.ids, { userId, title: text.title, body: text.body, connectionId, dedupeKey })) sent += 1;
    }
    return sent;
  });
}

/** The owner-question defaults a pass follows (settings.ts); a test passes the other answer. */
export interface ReconcileOptions {
  /** Q-ADS-1: read the account (mirror and spend sync) while platform:ads is not cleared */
  readsWhileDark?: boolean;
  /** Q-ADS-3: the monthly cap counts (and the pause covers) every campaign of the account, not only those linked here */
  capCountsEveryCampaign?: boolean;
}

/** One hourly pass for one tenant (job ads.reconcile). */
export async function runReconcile(d: AdsDeps, tenantId: TenantId | string, o: ReconcileOptions = {}): Promise<ReconcileReport> {
  const readsWhileDark = o.readsWhileDark ?? READS_WHILE_DARK;
  const countEvery = o.capCountsEveryCampaign ?? CAP_COUNTS_EVERY_CAMPAIGN;
  const now = clockOf(d);
  const start = await asSystem(d, tenantId, async (tx) => ({ conns: await repo.adsConnections(tx), cap: await repo.capInForce(tx), cleared: await repo.packCleared(tx) }));
  const report: ReconcileReport = { cleared: start.cleared, readsSkipped: false, connections: [], costsWritten: 0, uncheckedAlerts: 0 };
  // Q-ADS-1 answered "no": while dark nothing is read, so nothing is mirrored, costed, checked or alerted
  if (!start.cleared && !readsWhileDark) {
    report.readsSkipped = true;
    return report;
  }
  /** lead source → account-zone month → cents, from connections whose spend was read in full this pass */
  const costs = new Map<string, Map<string, { cents: number; zones: Set<string> }>>();
  const unknownSources = new Set<string>();

  for (const c of start.conns) {
    if (c.status !== 'connected' && c.status !== 'degraded') continue;
    const pass: ConnectionPass = { connectionId: c.id, outcome: 'synced', mirrored: 0, inserted: 0, noLeadSource: c.leadSourceId === null, monthToDateCents: null, capReached: false, plans: null, pause: null, alerted: 0 };
    report.connections.push(pass);
    const acct = await account(d, tenantId, c);
    if (!acct) {
      pass.outcome = 'no_token';
      await recordHealth(d, tenantId, c, { type: 'health_degraded', code: 'ADS_CREDENTIAL_UNAVAILABLE' });
      continue;
    }
    let f: Fetched;
    try {
      f = await fetchAccount(d, acct, now);
    } catch (e) {
      const fail = failureOf(e);
      pass.outcome = fail.outcome;
      await recordHealth(d, tenantId, c, fail.event);
      const known = await asSystem(d, tenantId, (tx) => repo.campaignRows(tx));
      for (const k of known) if (k.connectionId === c.id) unknownSources.add(k.leadSourceId);
      continue;
    }
    const currencyOk = f.info.currency === MANAGED_CURRENCY;
    if (!currencyOk) pass.outcome = 'currency_unsupported';

    // 3. mirror (a new row needs the connection's lead source: without one nothing is added or costed, but rows already
    //    mirrored keep their own lead source and are still updated, so the cap pause sees what Google Ads reports)
    const mirrored = await asSystem(d, tenantId, async (tx) => {
      const existing = (await repo.campaignRows(tx)).filter((x) => x.connectionId === c.id);
      for (const r of f.campaigns) {
        const row = existing.find((x) => x.externalCampaignId === r.externalCampaignId);
        if (!row && c.leadSourceId === null) continue;
        const name = campaignName(r.name, r.externalCampaignId);
        const targeting = mapTargeting(r.targeting);
        const budget = r.sharedBudget || r.dailyBudgetCents === null || !Number.isSafeInteger(r.dailyBudgetCents) || r.dailyBudgetCents < 0 ? 0 : r.dailyBudgetCents;
        if (!row && c.leadSourceId !== null) {
          await repo.insertCampaign(tx, { id: d.ids.next<'AdCampaignId'>(), connectionId: c.id, externalCampaignId: r.externalCampaignId, name, leadSourceId: c.leadSourceId,
            campaignRef: campaignRefOf(r.externalCampaignId), targeting, status: mirrorStatus(r, { linked: false, currencyOk }), dailyBudgetCents: budget });
          pass.inserted += 1;
        } else if (row) {
          await repo.updateMirroredCampaign(tx, row.id, { name, targeting, status: mirrorStatus(r, { linked: isLinked(row), currencyOk }), dailyBudgetCents: budget });
        }
        pass.mirrored += 1;
      }
      return (await repo.campaignRows(tx)).filter((x) => x.connectionId === c.id);
    });

    // health and the sync snapshot (a successful spend check only with the managed currency)
    const snapshot: repo.SyncSnapshot = {
      v: 1, at: toIso(now), currency: f.info.currency, zone: f.info.timeZone,
      campaigns: Object.fromEntries(f.campaigns.map((r) => [r.externalCampaignId, {
        budget: r.sharedBudget ? 'shared' : r.dailyBudgetCents === null ? 'not_reported' : 'own',
        housing: r.housingDeclared === true ? 'declared' : r.housingDeclared === false ? 'not_declared' : 'unknown',
        issue: r.servingIssue === null ? null : safeCode(r.servingIssue, 'SERVING_ISSUE'),
      }])),
    };
    if (currencyOk) await recordHealth(d, tenantId, c, { type: 'health_ok' }, { at: toIso(now), snapshot });
    else await recordHealth(d, tenantId, c, { type: 'health_degraded', code: 'ADS_CURRENCY_UNSUPPORTED' });

    // 4. readback of plans the apply path could not finish
    pass.plans = await resolveOpenPlans(d, tenantId, c.id, acct, f.campaigns);

    if (!currencyOk) continue; // nothing managed or costed; overspend unchecked (the "not checked" alert below fires)

    // costs: each mirrored campaign's daily spend under its lead source, per account-zone month
    const months = monthsOf(f.today);
    if (c.leadSourceId !== null) {
      const sourceOf = new Map(mirrored.map((m) => [m.externalCampaignId, m.leadSourceId]));
      for (const m of mirrored) {
        const byMonth = costs.get(m.leadSourceId) ?? new Map<string, { cents: number; zones: Set<string> }>();
        for (const month of [months.previous, months.current]) {
          const e = byMonth.get(month) ?? { cents: 0, zones: new Set<string>() };
          e.zones.add(f.info.timeZone);
          byMonth.set(month, e);
        }
        costs.set(m.leadSourceId, byMonth);
      }
      for (const r of f.daily) {
        const src = sourceOf.get(r.externalCampaignId);
        if (!src) continue;
        const month = `${r.date.slice(0, 7)}-01`;
        const e = costs.get(src)?.get(month);
        if (e) e.cents += r.spendCents;
      }
    }

    // 5. overspend: month-to-date spend against the cap in force. Q-ADS-3 default: every campaign of the account, mirrored
    //    or not, managed or not (a campaign never mirrored is counted under a synthetic id); otherwise only campaigns
    //    linked here (a person chose to manage them, R-ADS-12), whatever their status now.
    if (!start.cap) continue;
    const counted = countEvery ? mirrored : mirrored.filter(isLinked);
    const countedIds = new Set(counted.map((m) => m.id));
    const idOf = (ext: string): CampaignId => (mirrored.find((m) => m.externalCampaignId === ext)?.id as CampaignId | undefined) ?? syntheticId(c.id, ext);
    const hourly = hourlyOf(f.hourly, f.info.timeZone, idOf).filter((h) => countEvery || countedIds.has(h.campaignId));
    for (const m of counted) if (!hourly.some((h) => h.campaignId === m.id)) hourly.push({ campaignId: m.id as CampaignId, hourStart: instant(Date.parse(`${months.current}T00:00:00Z`)), spendCents: 0 });
    pass.monthToDateCents = hourly.reduce((s, h) => s + h.spendCents, 0);
    const over = new Set<string>(overspend(hourly, { id: start.cap.id, versionNo: start.cap.versionNo, monthlyCapCents: start.cap.monthlyCapCents, dailyCeilingCents: start.cap.dailyCeilingCents, effectiveFrom: instant(Date.parse(start.cap.effectiveFrom)) }));
    pass.capReached = over.size > 0;
    if (!pass.capReached) continue;
    const month = months.current.slice(0, 7);
    // one alert of each kind per connection and month (a month that went dark after a pause still gets its alert)
    const dedupe = (kind: 'paused' | 'dark' | 'no_lead_source') => (kind === 'paused' ? `ad_overspend:${c.id}:${month}` : `ad_overspend:${c.id}:${month}:${kind}`);
    if (!start.cleared) {
      pass.alerted = await notifyAll(d, tenantId, c.id, overspendText({ kind: 'dark', capCents: start.cap.monthlyCapCents }), dedupe('dark'));
      continue;
    }
    // every mirrored campaign Google Ads reports serving (active or draft this pass), even one re-enabled there after a
    // pause, with or without the connection's lead source (b11 sends-gates/F2); with Q-ADS-3 "no", managed ones only
    const toPause = mirrored.filter((m) => over.has(m.id) && (m.status === 'active' || (countEvery && m.status === 'draft')));
    if (toPause.length > 0) {
      pass.pause = await pauseForMonthlyCap(d, tenantId, acct, toPause, start.cap);
      if (pass.pause.paused > 0) pass.alerted += await notifyAll(d, tenantId, c.id, overspendText({ kind: 'paused', paused: pass.pause.paused, capCents: start.cap.monthlyCapCents }), dedupe('paused'));
      // R-ADS-7 (b11 ads-16): the pack was withdrawn during the pass: the rest were not paused
      if (pass.pause.withdrawn > 0) pass.alerted += await notifyAll(d, tenantId, c.id, overspendText({ kind: 'dark', capCents: start.cap.monthlyCapCents }), dedupe('dark'));
    }
    // a campaign Google Ads reports serving that was never mirrored (no lead source to record it under) cannot be paused here
    const unrecorded = countEvery && f.campaigns.some((r) => r.platformStatus === 'enabled' && !mirrored.some((m) => m.externalCampaignId === r.externalCampaignId));
    if (unrecorded) pass.alerted += await notifyAll(d, tenantId, c.id, overspendText({ kind: 'no_lead_source', capCents: start.cap.monthlyCapCents }), dedupe('no_lead_source'));
  }

  // the costs (R-ADS-11): one ads_sync row per lead source and month, skipping a source whose spend is unknown this pass
  report.costsWritten = await asSystem(d, tenantId, async (tx) => {
    let n = 0;
    for (const [src, byMonth] of costs) {
      if (unknownSources.has(src)) continue;
      for (const [month, e] of byMonth) {
        const zones = [...e.zones].sort().join(', ');
        await repo.upsertAdsSyncCost(tx, d.ids, { leadSourceId: src, month, amountCents: e.cents, note: `Google Ads spend for ${month.slice(0, 7)} in the account zone (${zones}), as reported at ${toIso(now)}.` });
        n += 1;
      }
    }
    return n;
  });

  // "not checked" for 2 hours (E453, E454; unchecked.ts): every live connection, and every revoked or disconnected one
  // that still has mirrored campaigns (they may still be spending) unless its account is connected again as a live
  // connection (b11 ads-5), once per connection and day
  const after = await asSystem(d, tenantId, async (tx) => ({ conns: await repo.adsConnections(tx, { withDisconnected: true }), campaigns: await repo.campaignRows(tx) }));
  for (const c of uncheckedConnections(after.conns, after.campaigns, now)) {
    const day = new Date(now).toISOString().slice(0, 10);
    report.uncheckedAlerts += await notifyAll(d, tenantId, c.id, uncheckedText(c.lastSyncedAt), `ad_unchecked:${c.id}:${day}`);
  }
  return report;
}

