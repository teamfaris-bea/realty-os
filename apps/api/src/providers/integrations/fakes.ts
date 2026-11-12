// Deterministic fakes for every Phase 2-3 adapter (R-INT-1). No clock, no randomness, no network:
// the same calls in the same order give the same results. Tests drive the "provider side" through the
// helpers (`FakeOAuth.issueCode`), never through real vendors. D2: there is no Meta webhook to fake.
import { createHash } from 'node:crypto';
import type { Clock } from '@realty/core/foundation';
import { ProviderError } from '../types.js';
import type {
  AddressFacts,
  AvmEstimate,
  AvmProvider,
  AvmUnavailable,
  Busy,
  CalendarAuth,
  CalendarEvent,
  CalendarProvider,
  Capabilities,
  ConnectionKind,
  DocumentRenderer,
  FeedLead,
  IntegrationAdapters,
  LeadFeedPage,
  LeadFeedProvider,
  LicensePack,
  ManagedAccount,
  MediaRef,
  MlsFeed,
  MlsPage,
  OAuthConnector,
  OAuthProviderName,
  OAuthToken,
  DeleteRequest,
  DeleteResult,
  LookupRequest,
  LookupResult,
  PublishRequest,
  PublishResult,
  PushResult,
  RenderedPdf,
  ResoListing,
  ShowingRecord,
  ShowingServiceProvider,
  SocialPublisher,
} from './types.js';

const b64url = (b: Buffer) => b.toString('base64url');
export const pkceChallenge = (verifier: string): string => b64url(createHash('sha256').update(verifier, 'ascii').digest());

/**
 * What the fake platform reports per kind (the real adapter must report from the vendor instead).
 * D2: a Facebook Page (`facebook_page`) or Instagram business account (`instagram_business`) connection is for
 * content publishing only; nothing here receives or sends messages, and the out-of-scope kinds (Messenger,
 * Instagram DMs, Meta Lead Ads, Meta ads) report nothing.
 */
export const FAKE_CAPABILITIES: Partial<Record<ConnectionKind, Capabilities>> = {
  facebook_page: { publish_posts: true },
  instagram_business: { publish_posts: true },
  ads_google: { read_spend: true, change_budget: true },
  gbp_location: { publish_posts: true, read_reviews: true, reply_reviews: true },
};

export interface FakeGrantAccount {
  id: string;
  name?: string;
  /** the fake platform still reviews this account (the connection ends in pending_review) */
  reviewPending?: boolean;
}

/** Module 34 (additive): the token the fake provider issues for a code (defaults keep the module 21 shape). */
export interface FakeTokenShape {
  /** the scopes the person granted (default ['fake.scope']) */
  scopes?: string[];
  /** issue a refresh token (default false) */
  refresh?: boolean;
  /** access-token expiry as an ISO instant (default null, long-lived) */
  expiresAt?: string | null;
}

interface Grant {
  challenge: string;
  accounts: FakeGrantAccount[];
  used: boolean;
  token: FakeTokenShape;
}

/** Fake OAuth provider: codes are single-use, PKCE (S256) is checked, tokens map to managed accounts. */
export class FakeOAuth implements OAuthConnector {
  readonly configured = true;
  readonly #grants = new Map<string, Grant>();
  readonly #tokens = new Map<string, FakeGrantAccount[]>();
  readonly revoked: string[] = [];
  /** set to make the next exchange fail (provider outage) */
  failNextExchange: ProviderError | null = null;
  /** module 34: refresh token → the access tokens it produced; access tokens the provider no longer accepts */
  readonly #byRefresh = new Map<string, string[]>();
  readonly #dead = new Set<string>();
  readonly #revokedGrants = new Set<string>();
  readonly #refreshScopes = new Map<string, string[]>();
  /** module 34: expiry given to refreshed access tokens (ISO; default null) */
  refreshExpiresAt: string | null = null;
  /** module 34: every refresh the fake served, in order (refresh tokens only) */
  readonly refreshes: string[] = [];
  #n = 0;

  constructor(readonly provider: OAuthProviderName) {}

  authorizeUrl(i: { kind?: ConnectionKind; state: string; codeChallenge: string; redirectUri: string; scopes: readonly string[] }): string {
    const u = new URL(`https://oauth.fake.invalid/${this.provider}/authorize`);
    u.searchParams.set('response_type', 'code');
    if (i.kind !== undefined) u.searchParams.set('kind', i.kind);
    u.searchParams.set('state', i.state);
    u.searchParams.set('code_challenge', i.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('redirect_uri', i.redirectUri);
    u.searchParams.set('scope', i.scopes.join(' '));
    return u.toString();
  }

  /** The "person approved in the provider dialog" step: returns the code the provider would redirect with. */
  issueCode(i: { codeChallenge: string; accounts: FakeGrantAccount[]; token?: FakeTokenShape }): string {
    this.#n += 1;
    const code = `fake-code-${this.provider}-${this.#n}`;
    this.#grants.set(code, { challenge: i.codeChallenge, accounts: i.accounts.map((a) => ({ ...a })), used: false, token: { ...(i.token ?? {}) } });
    return code;
  }

  async exchangeCode(i: { code: string; codeVerifier: string; redirectUri: string }): Promise<OAuthToken> {
    if (this.failNextExchange) {
      const e = this.failNextExchange;
      this.failNextExchange = null;
      throw e;
    }
    const g = this.#grants.get(i.code);
    if (!g || g.used) throw new ProviderError('rejected', 'INVALID_GRANT');
    g.used = true;
    if (pkceChallenge(i.codeVerifier) !== g.challenge) throw new ProviderError('rejected', 'PKCE_MISMATCH');
    const accessToken = `fake-token-${this.provider}-${createHash('sha256').update(i.code).digest('hex').slice(0, 16)}`;
    this.#tokens.set(accessToken, g.accounts);
    const refreshToken = g.token.refresh ? `fake-refresh-${this.provider}-${createHash('sha256').update(`r:${i.code}`).digest('hex').slice(0, 16)}` : null;
    const scopes = g.token.scopes ? [...g.token.scopes] : ['fake.scope'];
    if (refreshToken) {
      this.#byRefresh.set(refreshToken, [accessToken]);
      this.#refreshScopes.set(refreshToken, scopes);
    }
    return { accessToken, refreshToken, expiresAt: g.token.expiresAt ?? null, scopes };
  }

  async refresh(refreshToken: string): Promise<OAuthToken> {
    const issued = this.#byRefresh.get(refreshToken);
    if (!issued || this.#revokedGrants.has(refreshToken)) throw new ProviderError('rejected', 'INVALID_GRANT');
    this.refreshes.push(refreshToken);
    const accessToken = `${issued[0]}-r${issued.length}`;
    issued.push(accessToken);
    this.#tokens.set(accessToken, this.#tokens.get(issued[0]!) ?? []);
    return { accessToken, refreshToken, expiresAt: this.refreshExpiresAt, scopes: [...(this.#refreshScopes.get(refreshToken) ?? [])] };
  }

  /** test helper (E102): the person removed the app in the provider's security settings */
  revokeGrantAtProvider(refreshToken: string): void {
    this.#revokedGrants.add(refreshToken);
    for (const t of this.#byRefresh.get(refreshToken) ?? []) this.#dead.add(t);
  }

  /** test helper: the provider stops accepting this access token early (it "expired") */
  expireAccessToken(accessToken: string): void {
    this.#dead.add(accessToken);
  }

  /** whether the provider would refuse this access token (revoked, grant removed, expired early) */
  isDead(accessToken: string): boolean {
    return this.#dead.has(accessToken) || this.revoked.includes(accessToken);
  }

  async listManagedAccounts(token: OAuthToken, kind: ConnectionKind): Promise<ManagedAccount[]> {
    const accounts = this.#tokens.get(token.accessToken);
    if (!accounts || this.revoked.includes(token.accessToken)) throw new ProviderError('rejected', 'TOKEN_INVALID');
    const caps = FAKE_CAPABILITIES[kind] ?? {};
    return accounts.map((a) => ({ externalAccountId: a.id, displayName: a.name ?? `Account ${a.id}`, capabilities: { ...caps }, reviewPending: a.reviewPending === true }));
  }

  async revoke(token: OAuthToken): Promise<void> {
    if (!this.revoked.includes(token.accessToken)) this.revoked.push(token.accessToken);
    if (token.refreshToken) this.revokeGrantAtProvider(token.refreshToken);
  }

  /** test helper: account ids a live token manages */
  managedBy(accessToken: string): string[] {
    return (this.#tokens.get(accessToken) ?? []).map((a) => a.id);
  }
}

export class FakeLeadFeed implements LeadFeedProvider {
  readonly access = 'available' as const;
  readonly leads: FeedLead[] = [];
  constructor(readonly source: 'zillow' | 'realtor') {}
  async poll(i: { externalAccountId: string; accessToken: string; cursor: string | null }): Promise<LeadFeedPage> {
    const from = i.cursor === null ? 0 : Number(i.cursor);
    const page = this.leads.slice(from, from + 50);
    return { leads: page.map((l) => ({ ...l })), cursor: page.length === 0 ? i.cursor : String(from + page.length) };
  }
}

export const FAKE_RESO_LISTINGS: readonly ResoListing[] = [
  {
    listingKey: 'FAKE-MLS-1001',
    listingId: '1001',
    standardStatus: 'Active',
    listPriceCents: 52_500_000,
    unparsedAddress: '12 Harbor Way',
    city: 'Charleston',
    stateOrProvince: 'SC',
    postalCode: '29401',
    bedroomsTotal: 3,
    bathroomsTotalX10: 25,
    livingAreaSqft: 1850,
    propertyType: 'Residential',
    listOfficeName: 'Fake Brokerage LLC',
    modificationTimestamp: '2026-11-01T12:00:00.000Z',
  },
  {
    listingKey: 'FAKE-MLS-1002',
    listingId: '1002',
    standardStatus: 'Pending',
    listPriceCents: 38_900_000,
    unparsedAddress: '40 Marsh Lane',
    city: 'Mount Pleasant',
    stateOrProvince: 'SC',
    postalCode: '29464',
    bedroomsTotal: 2,
    bathroomsTotalX10: 20,
    livingAreaSqft: 1200,
    propertyType: 'Residential',
    listOfficeName: 'Another Fake Realty',
    modificationTimestamp: '2026-11-02T12:00:00.000Z',
  },
];

export class FakeResoMls implements MlsFeed {
  readonly access = 'available' as const;
  listings: ResoListing[] = FAKE_RESO_LISTINGS.map((l) => ({ ...l }));
  async changes(cursor: string | null, limit: number): Promise<MlsPage> {
    const sorted = [...this.listings].sort((a, b) => (a.modificationTimestamp + a.listingKey < b.modificationTimestamp + b.listingKey ? -1 : 1));
    const after = cursor === null ? sorted : sorted.filter((l) => l.modificationTimestamp + l.listingKey > cursor);
    const page = after.slice(0, Math.max(0, limit));
    const last = page.at(-1);
    return { listings: page.map((l) => ({ ...l })), cursor: last ? last.modificationTimestamp + last.listingKey : cursor };
  }
  async media(listingKey: string): Promise<MediaRef[]> {
    return [1, 2].map((order) => ({ order, url: `https://media.fake.invalid/${encodeURIComponent(listingKey)}/${order}.jpg`, contentType: 'image/jpeg' }));
  }
  describeLicense(): LicensePack {
    // Strictest default: nothing is displayable until a real licence pack is entered (VERIFY per MLS).
    return { mls: 'fake', version: 'fake/1', reviewed: false, rules: { displayToPublic: false, displayToClients: false, requireAttribution: true, maxPhotos: null } };
  }
}

/** A settable fake AVM answer for one address: an estimate (fields override the deterministic ones), none, or a vendor error. */
export type FakeAvmAnswer = { kind: 'estimate'; estimate: Partial<Omit<AvmEstimate, 'available'>> } | { kind: 'unavailable' } | { kind: 'error' } | { kind: 'raw'; answer: unknown };

/** The fixture source name (synthetic; no real vendor or MLS is named anywhere). */
export const FAKE_AVM_PROVIDER = 'Example Home Values (test data)';

/**
 * Deterministic AVM: a value derived from the address, a ±8 % range, and "a postal code ending in 0 has no
 * estimate". asOf defaults to the first day of the current UTC month of the clock it is given (an optional clock,
 * the wall clock by default), so a fresh estimate stays fresh under platform:avm's max_age_days. displayAllowed is
 * this fixture's stated licence answer (true), not a default. Tests set per-address answers (`answers`) to produce
 * every avmSendable reason, a vendor error, a fixed or old asOf, a refused display permission or a 30 % drop (E98).
 */
export class FakeAvmP2 implements AvmProvider {
  readonly configured = true;
  /** per-address answers, keyed by FakeAvmP2.key(address) */
  readonly answers = new Map<string, FakeAvmAnswer>();
  /** every request, in order (tests count vendor calls) */
  readonly calls: AddressFacts[] = [];
  /** test hook run at the start of every request (e.g. to prove no transaction is open) */
  onEstimate: ((a: AddressFacts) => Promise<void>) | null = null;
  constructor(private readonly clock: Clock | null = null) {}
  static key(a: Pick<AddressFacts, 'line1' | 'postalCode'>): string {
    return `${a.line1}|${a.postalCode}`;
  }
  async estimate(a: AddressFacts): Promise<AvmUnavailable | AvmEstimate> {
    this.calls.push({ ...a });
    if (this.onEstimate) await this.onEstimate(a);
    const set = this.answers.get(FakeAvmP2.key(a));
    if (set?.kind === 'error') throw new ProviderError('unavailable', 'FAKE_AVM_ERROR');
    if (set?.kind === 'raw') return set.answer as AvmEstimate;
    if (set?.kind === 'unavailable' || (set === undefined && a.postalCode.endsWith('0'))) return { available: false, provider: FAKE_AVM_PROVIDER };
    const n = Number.parseInt(createHash('sha256').update(`${a.line1}|${a.postalCode}`).digest('hex').slice(0, 6), 16);
    const valueCents = (250_000 + (n % 500_000)) * 100;
    const now = new Date(this.clock ? this.clock.now() : Date.now());
    const asOf = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
    const comparables = [1, 2, 3].map((k) => ({ address: `${10 * k + (n % 7)} Comparable Ct`, soldOn: `${asOf.slice(0, 7)}-01`, priceCents: Math.round(valueCents * (0.96 + 0.02 * k)), listingId: null }));
    const base: AvmEstimate = { available: true, valueCents, lowCents: Math.round(valueCents * 0.92), highCents: Math.round(valueCents * 1.08), asOf, method: 'comparable sales', comparables, provider: FAKE_AVM_PROVIDER, displayAllowed: true };
    return set?.kind === 'estimate' ? { ...base, ...set.estimate, available: true } : base;
  }
}

export interface FakeCalendarEvent extends CalendarEvent {
  syncVersion: number;
  calendarRef: string;
  /** true once the person edited the event in their calendar (test helper editExternally) */
  editedExternally: boolean;
}

/**
 * Fake Google/Microsoft calendar (module 21 shape, extended by module 34). Events are keyed by appointment id.
 * The provider-side fence (`stale`) stays as module 21 built it. Module 34 adds the conditional update: a push
 * whose etag no longer matches (the person edited the event) or whose event is gone (deleted in the calendar)
 * is `detached`, and the event is left exactly as the person made it. An access token the fake OAuth provider
 * refuses (`isDead`) throws ProviderError('rejected', 'UNAUTHENTICATED').
 */
export class FakeCalendar implements CalendarProvider {
  readonly events = new Map<string, FakeCalendarEvent>();
  readonly #deleted = new Set<string>();
  busy: Busy[] = [];
  /** every push and free/busy call the fake served (appointment id or 'freebusy'), in order */
  readonly calls: string[] = [];
  constructor(
    readonly provider: 'google' | 'microsoft',
    private readonly isDead: (accessToken: string) => boolean = () => false,
  ) {}
  #auth(auth: CalendarAuth): void {
    if (this.isDead(auth.accessToken)) throw new ProviderError('rejected', 'UNAUTHENTICATED');
  }
  async pushEvent(auth: CalendarAuth, e: CalendarEvent, fence: { syncVersion: number }): Promise<PushResult> {
    this.#auth(auth);
    this.calls.push(e.appointmentId);
    const cur = this.events.get(e.appointmentId);
    if (cur && cur.syncVersion > fence.syncVersion) return { kind: 'stale', syncVersion: cur.syncVersion };
    if (e.externalEventRef !== null) {
      if (this.#deleted.has(e.externalEventRef) || !cur || cur.externalEventRef !== e.externalEventRef) return { kind: 'detached' };
      if (cur.externalEtag !== e.externalEtag) {
        // the calendar already holds exactly what we would write (our own earlier write whose acknowledgement
        // was lost, e.g. the push's transaction rolled back): adopt it instead of detaching
        if (cur.startsAt === e.startsAt && cur.endsAt === e.endsAt && cur.title === e.title && (cur.status ?? 'confirmed') === (e.status ?? 'confirmed')) {
          this.events.set(e.appointmentId, { ...cur, syncVersion: Math.max(cur.syncVersion, fence.syncVersion) });
          return { kind: 'pushed', externalEventRef: cur.externalEventRef!, externalEtag: cur.externalEtag!, syncVersion: fence.syncVersion };
        }
        return { kind: 'detached' };
      }
    }
    const ref = cur?.externalEventRef ?? `fake-${this.provider}-event-${e.appointmentId}`;
    const etag = `etag-${fence.syncVersion}`;
    this.events.set(e.appointmentId, { ...e, externalEventRef: ref, externalEtag: etag, syncVersion: fence.syncVersion, calendarRef: auth.calendarRef, editedExternally: false });
    return { kind: 'pushed', externalEventRef: ref, externalEtag: etag, syncVersion: fence.syncVersion };
  }
  async freeBusy(auth: CalendarAuth, range: { start: string; end: string }): Promise<Busy[]> {
    this.#auth(auth);
    this.calls.push('freebusy');
    return this.busy.filter((b) => b.end > range.start && b.start < range.end).map((b) => ({ ...b }));
  }
  /** test helper (E103): the person edits the pushed event in their calendar (a new etag) */
  editExternally(appointmentId: string, patch: Partial<Pick<CalendarEvent, 'startsAt' | 'endsAt' | 'title'>> = {}): void {
    const cur = this.events.get(appointmentId);
    if (!cur) throw new Error(`no fake event for ${appointmentId}`);
    this.events.set(appointmentId, { ...cur, ...patch, externalEtag: `${cur.externalEtag}-edited`, editedExternally: true });
  }
  /** test helper: the person deletes the pushed event in their calendar */
  deleteExternally(appointmentId: string): void {
    const cur = this.events.get(appointmentId);
    if (!cur?.externalEventRef) throw new Error(`no fake event for ${appointmentId}`);
    this.#deleted.add(cur.externalEventRef);
    this.events.delete(appointmentId);
  }
}

/**
 * The fake Page / Instagram account. Deterministic; tests choose the provider's behaviour (module 29):
 *   nextOutcome   'published' (default), 'rejected', or 'timeout' (the post IS made, but the answer is lost:
 *                 the publish throws ProviderError('timeout'), E227)
 *   lookup        'supported' (finds a timed-out post by piece + content hash) or 'unsupported' (VERIFY)
 *   deletion      per target: 'supported' or 'unsupported' (VERIFY: Instagram)
 * `posts` is what the provider holds live; `published` every publish call it received.
 */
export class FakeSocialPublisher implements SocialPublisher {
  readonly published: PublishRequest[] = [];
  readonly posts = new Map<string, { externalAccountId: string; target: PublishRequest['target']; pieceId: string; contentSha256: string }>();
  readonly lookups: LookupRequest[] = [];
  readonly deletions: DeleteRequest[] = [];
  nextOutcome: 'published' | 'rejected' | 'timeout' = 'published';
  rejectCode = 'POST_REJECTED';
  lookup: 'supported' | 'unsupported' = 'supported';
  deletion: Record<PublishRequest['target'], 'supported' | 'unsupported'> = { facebook_page: 'supported', instagram_business: 'supported', gbp_location: 'supported' };
  /** tests: runs inside the provider call, before the post is made (e.g. a pack change between TX1 and TX2) */
  beforePublish: (() => Promise<void>) | null = null;
  /** tests: runs inside the provider call after the provider decided (a deleted post is already gone), before it answers */
  afterDelete: ((p: DeleteRequest, r: DeleteResult) => Promise<void>) | null = null;
  async publishPost(p: PublishRequest): Promise<PublishResult> {
    if (this.beforePublish) await this.beforePublish();
    this.published.push({ ...p, imageUrls: [...p.imageUrls] });
    const outcome = this.nextOutcome;
    this.nextOutcome = 'published';
    if (outcome === 'rejected') return { kind: 'rejected', code: this.rejectCode };
    const providerRef = `fake-post-${this.published.length}`;
    this.posts.set(providerRef, { externalAccountId: p.externalAccountId, target: p.target, pieceId: p.pieceId, contentSha256: p.contentSha256 });
    if (outcome === 'timeout') throw new ProviderError('timeout', 'PUBLISH_TIMEOUT');
    return { kind: 'published', providerRef, url: null };
  }
  async lookupPost(p: LookupRequest): Promise<LookupResult> {
    this.lookups.push({ ...p });
    if (this.lookup === 'unsupported') return { kind: 'unsupported' };
    for (const [ref, post] of this.posts) {
      if (post.externalAccountId === p.externalAccountId && post.target === p.target && post.pieceId === p.pieceId && post.contentSha256 === p.contentSha256) return { kind: 'found', providerRef: ref };
    }
    return { kind: 'not_found' };
  }
  async deletePost(p: DeleteRequest): Promise<DeleteResult> {
    this.deletions.push({ ...p });
    const r = this.#delete(p);
    if (this.afterDelete) await this.afterDelete({ ...p }, r);
    return r;
  }
  #delete(p: DeleteRequest): DeleteResult {
    if (this.deletion[p.target] === 'unsupported') return { kind: 'unsupported' };
    const post = this.posts.get(p.providerRef);
    if (!post || post.externalAccountId !== p.externalAccountId) return { kind: 'failed', code: 'POST_NOT_FOUND' };
    this.posts.delete(p.providerRef);
    return { kind: 'deleted' };
  }
  /** Postings on the fake account (what a person would see on the Page). */
  livePosts(externalAccountId: string): string[] {
    return [...this.posts.entries()].filter(([, v]) => v.externalAccountId === externalAccountId).map(([k]) => k);
  }
}

export class FakeShowingService implements ShowingServiceProvider {
  readonly access = 'available' as const;
  readonly showings: ShowingRecord[] = [];
  async changes(i: { externalAccountId: string; accessToken: string; cursor: string | null }): Promise<{ showings: ShowingRecord[]; cursor: string | null }> {
    const from = i.cursor === null ? 0 : Number(i.cursor);
    const page = this.showings.slice(from, from + 100);
    return { showings: page.map((s) => ({ ...s })), cursor: page.length === 0 ? i.cursor : String(from + page.length) };
  }
}

/** A minimal, valid-looking one-page PDF whose bytes depend only on the input. */
export class FakeRenderer implements DocumentRenderer {
  async renderPdf(i: { templateKey: string; fields: Record<string, string>; imageCount: number }): Promise<RenderedPdf> {
    const keys = Object.keys(i.fields).sort();
    const text = `${i.templateKey}|${keys.map((k) => `${k}=${i.fields[k]}`).join('|')}|images=${i.imageCount}`;
    const bytes = new Uint8Array(Buffer.from(`%PDF-1.4\n% fake render\n% ${createHash('sha256').update(text).digest('hex')}\n%%EOF\n`, 'ascii'));
    return { bytes, contentType: 'application/pdf', sha256: createHash('sha256').update(bytes).digest('hex') };
  }
}

export interface FakeIntegrationAdapters extends IntegrationAdapters {
  readonly mode: 'fake';
  oauth: { meta: FakeOAuth; google: FakeOAuth; microsoft: FakeOAuth };
  leadFeeds: { zillow: FakeLeadFeed; realtor: FakeLeadFeed };
  mlsFeed: FakeResoMls;
  avm: FakeAvmP2;
  calendar: { google: FakeCalendar; microsoft: FakeCalendar };
  social: FakeSocialPublisher;
  showing: FakeShowingService;
  renderer: FakeRenderer;
}

export function createFakeIntegrations(opts: { clock?: Clock } = {}): FakeIntegrationAdapters {
  const oauth = { meta: new FakeOAuth('meta'), google: new FakeOAuth('google'), microsoft: new FakeOAuth('microsoft') };
  return {
    mode: 'fake',
    oauth,
    leadFeeds: { zillow: new FakeLeadFeed('zillow'), realtor: new FakeLeadFeed('realtor') },
    mlsFeed: new FakeResoMls(),
    avm: new FakeAvmP2(opts.clock ?? null),
    calendar: { google: new FakeCalendar('google', (t) => oauth.google.isDead(t)), microsoft: new FakeCalendar('microsoft', (t) => oauth.microsoft.isDead(t)) },
    social: new FakeSocialPublisher(),
    showing: new FakeShowingService(),
    renderer: new FakeRenderer(),
  };
}
