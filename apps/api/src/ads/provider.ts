// The Google Ads adapter of module 52 (PHASE2_3_PLAN §5.4 "51. core/ads and 52. api/ads"; owner decision D2: Google Ads
// only; R-ADS-3, R-INT-1, R-INT-4, N14).
//
// The adapter receives NO tenant context: every call names the account (its external id and the access token the caller
// decrypted as the system actor, R-INT-4). Money is integer cents of the account's currency; module 52 manages only
// accounts reporting 'USD'. Dates and hours are the ACCOUNT's reporting zone (accountInfo().timeZone).
//
// Reserved outbound names (R-GATE-15, lint realty/no-provider-outbound): `applyBudgetChange` and `pauseCampaign` are
// called only from apps/api/src/ads/dispatch.ts; ads/architecture.test.ts proves no other file calls them.
//
// This build ships the interface, a deterministic fake (dev and every test) and an unconfigured stand-in that production
// gets unless ALLOW_FAKE_PROVIDERS: it reads and changes nothing and says "Google Ads is not set up on this platform".
// There is no real adapter, developer token, OAuth client or account id here.
//
// VERIFY (Google Ads API, N14; developers.google.com was unreachable when this was built, so every Google fact here is
// unverified; a real adapter must settle each before platform:ads gets its vendor_ready_at):
//   - the API access level and its limits: the owner-reported Explorer level of about 2,880 operations a day, whether
//     reads count against it, and whether Explorer may mutate production accounts; that access is said to sit on the
//     Cloud project (with the API turned on), not on a developer token;
//   - the OAuth scope (integrations/catalog.ts GOOGLE_ADS_SCOPES, believed https://www.googleapis.com/auth/adwords), token
//     refresh and expiry, and how a revoked grant is reported (TOKEN_REVOKED / INVALID_GRANT);
//   - proof of control through the accessible-customers list, manager accounts and the login-customer header;
//   - budgets are micros of the account currency; the adapter converts to whole cents and back (rounding); the minimum
//     daily budget and its increment (core minDailyCents is 0);
//   - a campaign's daily budget may be shared between campaigns (a shared budget is never managed here);
//   - the housing special ad category declaration and how a campaign reports it ('unknown' when not reported); if the
//     API does not expose it, nothing is managed;
//   - campaign status values (enabled / paused / removed), serving issues / disapprovals and the policy reason codes;
//   - how radius targeting and its centre are reported (mirror.ts mapTargeting);
//   - how far a campaign may spend over its daily budget on a given day (module 52 pauses only at the monthly cap);
//   - the account-zone field, how late hourly cost arrives, month finality and invalid-click credits (the reconcile
//     recomputes the current and the previous month only), and the quota and error shapes (QUOTA, TOKEN_REVOKED);
//   - whether a mutate can carry an idempotency key or is absolute (the fake honours one; absolute amounts are idempotent
//     by value).
import { type Clock, DAY_MS, HOUR_MS, ianaZone, localDateOf, wallMs } from '@realty/core/foundation';
import { ProviderError } from '../providers/types.js';

/** One Google Ads account as the caller names it (never tenant context). */
export interface AdsAccount {
  externalAccountId: string;
  accessToken: string;
}

export interface AdsAccountInfo {
  /** ISO 4217 code the account reports in; module 52 manages only 'USD' (ADS_CURRENCY_UNSUPPORTED otherwise) */
  currency: string;
  /** the account's reporting zone (IANA) */
  timeZone: string;
}

export type PlatformStatus = 'enabled' | 'paused' | 'removed' | 'unknown';

export interface AdsCampaignReport {
  externalCampaignId: string;
  name: string;
  platformStatus: PlatformStatus;
  /** a disapproval or other serving issue (an UPPER_SNAKE code), or null */
  servingIssue: string | null;
  /** the campaign's own daily budget in cents; null when the budget is shared or not reported */
  dailyBudgetCents: number | null;
  sharedBudget: boolean;
  /** whether the platform reports the housing special ad category declared */
  housingDeclared: true | false | 'unknown';
  /** the platform's targeting, as reported (mapped to a TargetingSpec where possible, VERIFY) */
  targeting: unknown;
}

export interface SpendQuery {
  /** account-zone dates, YYYY-MM-DD, inclusive */
  from: string;
  to: string;
  granularity: 'day' | 'hour';
}

export interface AdsSpendRow {
  externalCampaignId: string;
  /** YYYY-MM-DD in the account zone */
  date: string;
  /** 0..23 in the account zone; null for a daily row */
  hour: number | null;
  spendCents: number;
}

export type AdsChangeResult =
  | { outcome: 'applied'; providerRef: string; dailyBudgetCents: number }
  | { outcome: 'rejected'; code: string }
  | { outcome: 'unknown' };

export interface BudgetChange {
  account: AdsAccount;
  externalCampaignId: string;
  toDailyCents: number;
  /** also enable a paused campaign (a resume tap) */
  resume: boolean;
  /** the planned ledger event id: the same key never changes the budget twice */
  idempotencyKey: string;
}

export interface PauseRequest {
  account: AdsAccount;
  externalCampaignId: string;
  idempotencyKey: string;
}

export interface AdsProvider {
  /** false in production until a real, checked Google Ads adapter exists (N14) */
  readonly configured: boolean;
  /** shown wherever the platform reports the adapter's state */
  readonly statusText: string;
  accountInfo(a: AdsAccount): Promise<AdsAccountInfo>;
  listCampaigns(a: AdsAccount): Promise<AdsCampaignReport[]>;
  spend(a: AdsAccount, q: SpendQuery): Promise<AdsSpendRow[]>;
  /** RESERVED (R-GATE-15): only ads/dispatch.ts calls it, for a planned ledger row */
  applyBudgetChange(c: BudgetChange): Promise<AdsChangeResult>;
  /** RESERVED (R-GATE-15): only ads/dispatch.ts calls it, for the monthly-cap safety pause */
  pauseCampaign(p: PauseRequest): Promise<AdsChangeResult>;
}

export const ADS_NOT_SET_UP = 'Google Ads is not set up on this platform';

/** Production without ALLOW_FAKE_PROVIDERS: reads and changes nothing (R-INT-1, N14). */
export class UnconfiguredAds implements AdsProvider {
  readonly configured = false;
  readonly statusText = ADS_NOT_SET_UP;
  async accountInfo(): Promise<never> {
    throw new ProviderError('not_configured', 'ADS_NOT_CONFIGURED');
  }
  async listCampaigns(): Promise<never> {
    throw new ProviderError('not_configured', 'ADS_NOT_CONFIGURED');
  }
  async spend(): Promise<never> {
    throw new ProviderError('not_configured', 'ADS_NOT_CONFIGURED');
  }
  async applyBudgetChange(): Promise<never> {
    throw new ProviderError('not_configured', 'ADS_NOT_CONFIGURED');
  }
  async pauseCampaign(): Promise<never> {
    throw new ProviderError('not_configured', 'ADS_NOT_CONFIGURED');
  }
}

// ---- the deterministic fake ----------------------------------------------------------------------------------------

export type FakeAdsOp = 'accountInfo' | 'listCampaigns' | 'spend' | 'applyBudgetChange' | 'pauseCampaign';

/** An injected failure for the next call of one operation. */
export type FakeAdsFailure =
  | { kind: 'rejected'; code: string }
  /** the call times out: `applied` says whether the platform made the change anyway (the answer is lost) */
  | { kind: 'timeout'; applied: boolean }
  /** the call never answers (the dispatcher's own bound turns it into "unknown"); `applied` as for timeout */
  | { kind: 'hang'; applied: boolean }
  | { kind: 'quota' }
  | { kind: 'revoked' };

export interface FakeCampaignInput {
  externalCampaignId: string;
  name?: string;
  platformStatus?: PlatformStatus;
  servingIssue?: string | null;
  dailyBudgetCents?: number | null;
  sharedBudget?: boolean;
  housingDeclared?: true | false | 'unknown';
  targeting?: unknown;
}

interface FakeCampaign {
  externalCampaignId: string;
  name: string;
  platformStatus: PlatformStatus;
  servingIssue: string | null;
  dailyBudgetCents: number | null;
  sharedBudget: boolean;
  housingDeclared: true | false | 'unknown';
  targeting: unknown;
}

interface FakeAccount {
  id: string;
  currency: string;
  timeZone: string;
  revoked: boolean;
  /** spend per hour = budget / 24 × overdelivery (1 = never over; VERIFY the platform's daily over-delivery) */
  overdelivery: number;
  campaigns: Map<string, FakeCampaign>;
  /** externalCampaignId → hour start (ms) → cents */
  spend: Map<string, Map<number, number>>;
  /** spend is accrued for every whole hour before this instant */
  accruedUntil: number;
}

export interface FakeAdsCall {
  op: FakeAdsOp;
  externalAccountId: string;
  externalCampaignId: string | null;
  idempotencyKey: string | null;
  toDailyCents: number | null;
}

/**
 * The targeting the fake reports by default: one proximity (radius) criterion, the platform-side shape the mirror maps to
 * core/fairhousing's TargetingSpec `{ geo: 'radius_of_listing', radiusMiles }` (mirror.ts mapTargeting). VERIFY: the
 * Google Ads proximity criterion and that its centre is the listing.
 */
export const FAKE_TARGETING = Object.freeze({ proximity: Object.freeze({ radiusMiles: 15 }) });

const hourOf = (ms: number) => Math.floor(ms / HOUR_MS) * HOUR_MS;

export class FakeAds implements AdsProvider {
  readonly configured = true;
  readonly statusText = 'Test adapter: simulated Google Ads accounts only';
  /** every call, in order (ids, keys and amounts only; never a token) */
  readonly calls: FakeAdsCall[] = [];
  /** changes that took effect on the simulated platform (a repeated idempotency key is not repeated here) */
  readonly applied: { op: 'budget' | 'pause'; externalAccountId: string; externalCampaignId: string; toDailyCents: number; resume: boolean; idempotencyKey: string }[] = [];
  /** test hook: awaited after each budget change or pause answers (e.g. to withdraw the pack mid-pass) */
  afterChange: ((op: 'applyBudgetChange' | 'pauseCampaign') => Promise<void>) | null = null;
  readonly #accounts = new Map<string, FakeAccount>();
  readonly #failures = new Map<FakeAdsOp, FakeAdsFailure[]>();
  readonly #byKey = new Map<string, AdsChangeResult>();
  #seq = 0;

  constructor(readonly clock: Clock = { now: () => Date.now() as never }) {}

  // ---- test helpers (the simulated platform) ----

  addAccount(id: string, o: { currency?: string; timeZone?: string; overdelivery?: number } = {}): void {
    this.#accounts.set(id, {
      id,
      currency: o.currency ?? 'USD',
      timeZone: o.timeZone ?? 'America/New_York',
      revoked: false,
      overdelivery: o.overdelivery ?? 1,
      campaigns: new Map(),
      spend: new Map(),
      accruedUntil: hourOf(this.clock.now()),
    });
  }

  addCampaign(accountId: string, c: FakeCampaignInput): void {
    const a = this.#account(accountId);
    this.#accrue(a);
    a.campaigns.set(c.externalCampaignId, {
      externalCampaignId: c.externalCampaignId,
      name: c.name ?? `Campaign ${c.externalCampaignId}`,
      platformStatus: c.platformStatus ?? 'enabled',
      servingIssue: c.servingIssue ?? null,
      dailyBudgetCents: c.dailyBudgetCents === undefined ? 1000 : c.dailyBudgetCents,
      sharedBudget: c.sharedBudget ?? false,
      housingDeclared: c.housingDeclared ?? true,
      targeting: c.targeting === undefined ? FAKE_TARGETING : c.targeting,
    });
  }

  /** someone changed the budget in the Google Ads interface */
  setBudget(accountId: string, externalCampaignId: string, cents: number | null): void {
    const a = this.#account(accountId);
    this.#accrue(a);
    this.#campaign(a, externalCampaignId).dailyBudgetCents = cents;
  }

  setStatus(accountId: string, externalCampaignId: string, s: PlatformStatus): void {
    const a = this.#account(accountId);
    this.#accrue(a);
    this.#campaign(a, externalCampaignId).platformStatus = s;
  }

  /** the platform disapproved the campaign (E146) */
  disapprove(accountId: string, externalCampaignId: string, issue = 'HOUSING_POLICY_DISAPPROVED'): void {
    const a = this.#account(accountId);
    this.#accrue(a);
    this.#campaign(a, externalCampaignId).servingIssue = issue;
  }

  update(accountId: string, externalCampaignId: string, patch: Partial<Omit<FakeCampaignInput, 'externalCampaignId'>>): void {
    const a = this.#account(accountId);
    this.#accrue(a);
    Object.assign(this.#campaign(a, externalCampaignId), patch);
  }

  setOverdelivery(accountId: string, factor: number): void {
    const a = this.#account(accountId);
    this.#accrue(a);
    a.overdelivery = factor;
  }

  /** past spend for one hour (history before the fake's clock, e.g. the 90-day window) */
  addSpend(accountId: string, externalCampaignId: string, hourStartMs: number, cents: number): void {
    const a = this.#account(accountId);
    const m = a.spend.get(externalCampaignId) ?? new Map<number, number>();
    m.set(hourOf(hourStartMs), (m.get(hourOf(hourStartMs)) ?? 0) + cents);
    a.spend.set(externalCampaignId, m);
  }

  /** the person removed the app's access in Google (E454) */
  revoke(accountId: string): void {
    this.#account(accountId).revoked = true;
  }

  failNext(op: FakeAdsOp, f: FakeAdsFailure): void {
    this.#failures.set(op, [...(this.#failures.get(op) ?? []), f]);
  }

  budgetOf(accountId: string, externalCampaignId: string): number | null {
    return this.#campaign(this.#account(accountId), externalCampaignId).dailyBudgetCents;
  }

  statusOf(accountId: string, externalCampaignId: string): PlatformStatus {
    return this.#campaign(this.#account(accountId), externalCampaignId).platformStatus;
  }

  /** month-to-date style total over [fromMs, toMs) of every campaign of the account */
  totalSpend(accountId: string, fromMs = 0, toMs = Number.MAX_SAFE_INTEGER): number {
    const a = this.#account(accountId);
    this.#accrue(a);
    let t = 0;
    for (const m of a.spend.values()) for (const [h, c] of m) if (h >= fromMs && h < toMs) t += c;
    return t;
  }

  // ---- AdsProvider ----

  async accountInfo(acct: AdsAccount): Promise<AdsAccountInfo> {
    const a = this.#enter('accountInfo', acct, null);
    await this.#maybeFail('accountInfo', a);
    return { currency: a.currency, timeZone: a.timeZone };
  }

  async listCampaigns(acct: AdsAccount): Promise<AdsCampaignReport[]> {
    const a = this.#enter('listCampaigns', acct, null);
    await this.#maybeFail('listCampaigns', a);
    this.#accrue(a);
    return [...a.campaigns.values()]
      .sort((x, y) => (x.externalCampaignId < y.externalCampaignId ? -1 : 1))
      .map((c) => ({
        externalCampaignId: c.externalCampaignId,
        name: c.name,
        platformStatus: c.platformStatus,
        servingIssue: c.servingIssue,
        dailyBudgetCents: c.sharedBudget ? null : c.dailyBudgetCents,
        sharedBudget: c.sharedBudget,
        housingDeclared: c.housingDeclared,
        targeting: structuredClone(c.targeting),
      }));
  }

  async spend(acct: AdsAccount, q: SpendQuery): Promise<AdsSpendRow[]> {
    const a = this.#enter('spend', acct, null);
    await this.#maybeFail('spend', a);
    this.#accrue(a);
    const zone = ianaZone(a.timeZone);
    if (!zone) throw new ProviderError('rejected', 'ACCOUNT_ZONE_INVALID');
    const rows = new Map<string, AdsSpendRow>();
    for (const [ext, m] of a.spend) {
      for (const [h, cents] of m) {
        const date = localDateOf(h as never, zone) as string;
        if (date < q.from || date > q.to) continue;
        const hour = q.granularity === 'hour' ? Math.floor((((wallMs(h as never, zone) % DAY_MS) + DAY_MS) % DAY_MS) / HOUR_MS) : null;
        const key = `${ext}|${date}|${hour ?? ''}`;
        const r = rows.get(key) ?? { externalCampaignId: ext, date, hour, spendCents: 0 };
        r.spendCents += cents;
        rows.set(key, r);
      }
    }
    return [...rows.values()].sort((x, y) => (x.externalCampaignId + x.date + String(x.hour ?? '').padStart(2, '0') < y.externalCampaignId + y.date + String(y.hour ?? '').padStart(2, '0') ? -1 : 1));
  }

  async applyBudgetChange(c: BudgetChange): Promise<AdsChangeResult> {
    const a = this.#enter('applyBudgetChange', c.account, c.externalCampaignId, c.idempotencyKey, c.toDailyCents);
    return this.#after('applyBudgetChange', this.#change('applyBudgetChange', a, c.externalCampaignId, c.idempotencyKey, (camp) => {
      if (camp.sharedBudget) return { outcome: 'rejected', code: 'SHARED_BUDGET' };
      camp.dailyBudgetCents = c.toDailyCents;
      if (c.resume) camp.platformStatus = 'enabled';
      this.applied.push({ op: 'budget', externalAccountId: a.id, externalCampaignId: camp.externalCampaignId, toDailyCents: c.toDailyCents, resume: c.resume, idempotencyKey: c.idempotencyKey });
      return { outcome: 'applied', providerRef: `fake-ads-op-${++this.#seq}`, dailyBudgetCents: c.toDailyCents };
    }));
  }

  async pauseCampaign(p: PauseRequest): Promise<AdsChangeResult> {
    const a = this.#enter('pauseCampaign', p.account, p.externalCampaignId, p.idempotencyKey);
    return this.#after('pauseCampaign', this.#change('pauseCampaign', a, p.externalCampaignId, p.idempotencyKey, (camp) => {
      camp.platformStatus = 'paused';
      this.applied.push({ op: 'pause', externalAccountId: a.id, externalCampaignId: camp.externalCampaignId, toDailyCents: 0, resume: false, idempotencyKey: p.idempotencyKey });
      return { outcome: 'applied', providerRef: `fake-ads-op-${++this.#seq}`, dailyBudgetCents: camp.dailyBudgetCents ?? 0 };
    }));
  }

  // ---- internals ----

  async #after(op: 'applyBudgetChange' | 'pauseCampaign', r: Promise<AdsChangeResult>): Promise<AdsChangeResult> {
    const out = await r;
    if (this.afterChange) await this.afterChange(op);
    return out;
  }

  #account(id: string): FakeAccount {
    const a = this.#accounts.get(id);
    if (!a) throw new Error(`FakeAds: no account ${id}`);
    return a;
  }

  #campaign(a: FakeAccount, ext: string): FakeCampaign {
    const c = a.campaigns.get(ext);
    if (!c) throw new Error(`FakeAds: no campaign ${ext}`);
    return c;
  }

  #enter(op: FakeAdsOp, acct: AdsAccount, ext: string | null, key: string | null = null, to: number | null = null): FakeAccount {
    this.calls.push({ op, externalAccountId: acct.externalAccountId, externalCampaignId: ext, idempotencyKey: key, toDailyCents: to });
    if (typeof acct.accessToken !== 'string' || acct.accessToken.length === 0) throw new ProviderError('rejected', 'TOKEN_INVALID');
    const a = this.#accounts.get(acct.externalAccountId);
    if (!a) throw new ProviderError('rejected', 'ACCOUNT_NOT_FOUND');
    if (a.revoked) throw new ProviderError('rejected', 'TOKEN_REVOKED');
    return a;
  }

  async #maybeFail(op: FakeAdsOp, a: FakeAccount): Promise<void> {
    const f = this.#failures.get(op)?.shift();
    if (!f) return;
    if (f.kind === 'quota') throw new ProviderError('unavailable', 'QUOTA');
    if (f.kind === 'revoked') {
      a.revoked = true;
      throw new ProviderError('rejected', 'TOKEN_REVOKED');
    }
    if (f.kind === 'rejected') throw new ProviderError('rejected', f.code);
    if (f.kind === 'timeout') throw new ProviderError('timeout', 'ADS_TIMEOUT');
    await new Promise<never>(() => {});
  }

  async #change(op: FakeAdsOp, a: FakeAccount, ext: string, key: string, apply: (c: FakeCampaign) => AdsChangeResult): Promise<AdsChangeResult> {
    this.#accrue(a);
    const f = this.#failures.get(op)?.shift();
    if (f?.kind === 'quota') throw new ProviderError('unavailable', 'QUOTA');
    if (f?.kind === 'revoked') {
      a.revoked = true;
      throw new ProviderError('rejected', 'TOKEN_REVOKED');
    }
    if (f?.kind === 'rejected') return { outcome: 'rejected', code: f.code };
    const prior = this.#byKey.get(key);
    const run = (): AdsChangeResult => {
      if (prior) return prior;
      const camp = a.campaigns.get(ext);
      const r: AdsChangeResult = !camp ? { outcome: 'rejected', code: 'CAMPAIGN_NOT_FOUND' } : camp.platformStatus === 'removed' ? { outcome: 'rejected', code: 'CAMPAIGN_REMOVED' } : apply(camp);
      if (r.outcome === 'applied') this.#byKey.set(key, r);
      return r;
    };
    if (f?.kind === 'timeout') {
      if (f.applied) run();
      return { outcome: 'unknown' };
    }
    if (f?.kind === 'hang') {
      if (f.applied) run();
      return new Promise<never>(() => {});
    }
    return run();
  }

  /** every whole hour since the last accrual, at the campaigns' current state (deterministic on the clock) */
  #accrue(a: FakeAccount): void {
    const until = hourOf(this.clock.now());
    for (let h = a.accruedUntil; h < until; h += HOUR_MS) {
      for (const c of a.campaigns.values()) {
        if (c.platformStatus !== 'enabled' || c.servingIssue !== null || !c.dailyBudgetCents) continue;
        const cents = Math.round((c.dailyBudgetCents * a.overdelivery) / 24);
        if (cents <= 0) continue;
        const m = a.spend.get(c.externalCampaignId) ?? new Map<number, number>();
        m.set(h, (m.get(h) ?? 0) + cents);
        a.spend.set(c.externalCampaignId, m);
      }
    }
    if (until > a.accruedUntil) a.accruedUntil = until;
  }
}
