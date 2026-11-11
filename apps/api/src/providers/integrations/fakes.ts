// Deterministic fakes for every Phase 2-3 adapter (R-INT-1). No clock, no randomness, no network:
// the same calls in the same order give the same results. Tests drive the "provider side" through the
// helpers (`FakeOAuth.issueCode`, `FakeMeta.signedWebhook`), never through real vendors.
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { ProviderError } from '../types.js';
import type {
  AddressFacts,
  AvmEstimate,
  AvmProvider,
  Busy,
  CalendarAuth,
  CalendarEvent,
  CalendarProvider,
  Capabilities,
  ConnectionKind,
  DmSend,
  DocumentRenderer,
  FeedLead,
  IntegrationAdapters,
  LeadFeedPage,
  LeadFeedProvider,
  LicensePack,
  ManagedAccount,
  MediaRef,
  MetaEvent,
  MetaMessagingProvider,
  MlsFeed,
  MlsPage,
  OAuthConnector,
  OAuthProviderName,
  OAuthToken,
  ProviderResult,
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

/** What the fake platform reports per kind (the real adapter must report from the vendor instead). */
export const FAKE_CAPABILITIES: Partial<Record<ConnectionKind, Capabilities>> = {
  messenger_page: { receive_messages: true, send_messages: true },
  instagram_account: { receive_messages: true, send_messages: true },
  meta_lead_ads: { receive_leads: true },
  ads_meta: { read_spend: true, change_budget: true },
  ads_google: { read_spend: true, change_budget: true },
  gbp_location: { publish_posts: true, read_reviews: true, reply_reviews: true },
};

export interface FakeGrantAccount {
  id: string;
  name?: string;
  /** the fake platform still reviews this account (the connection ends in pending_review) */
  reviewPending?: boolean;
}

interface Grant {
  challenge: string;
  accounts: FakeGrantAccount[];
  used: boolean;
}

/** Fake OAuth provider: codes are single-use, PKCE (S256) is checked, tokens map to managed accounts. */
export class FakeOAuth implements OAuthConnector {
  readonly configured = true;
  readonly #grants = new Map<string, Grant>();
  readonly #tokens = new Map<string, FakeGrantAccount[]>();
  readonly revoked: string[] = [];
  /** set to make the next exchange fail (provider outage) */
  failNextExchange: ProviderError | null = null;
  #n = 0;

  constructor(readonly provider: OAuthProviderName) {}

  authorizeUrl(i: { kind: ConnectionKind; state: string; codeChallenge: string; redirectUri: string }): string {
    const u = new URL(`https://oauth.fake.invalid/${this.provider}/authorize`);
    u.searchParams.set('response_type', 'code');
    u.searchParams.set('kind', i.kind);
    u.searchParams.set('state', i.state);
    u.searchParams.set('code_challenge', i.codeChallenge);
    u.searchParams.set('code_challenge_method', 'S256');
    u.searchParams.set('redirect_uri', i.redirectUri);
    return u.toString();
  }

  /** The "person approved in the provider dialog" step: returns the code the provider would redirect with. */
  issueCode(i: { codeChallenge: string; accounts: FakeGrantAccount[] }): string {
    this.#n += 1;
    const code = `fake-code-${this.provider}-${this.#n}`;
    this.#grants.set(code, { challenge: i.codeChallenge, accounts: i.accounts.map((a) => ({ ...a })), used: false });
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
    return { accessToken, refreshToken: null, expiresAt: null, scopes: ['fake.scope'] };
  }

  async listManagedAccounts(token: OAuthToken, kind: ConnectionKind): Promise<ManagedAccount[]> {
    const accounts = this.#tokens.get(token.accessToken);
    if (!accounts || this.revoked.includes(token.accessToken)) throw new ProviderError('rejected', 'TOKEN_INVALID');
    const caps = FAKE_CAPABILITIES[kind] ?? {};
    return accounts.map((a) => ({ externalAccountId: a.id, displayName: a.name ?? `Account ${a.id}`, capabilities: { ...caps }, reviewPending: a.reviewPending === true }));
  }

  async revoke(token: OAuthToken): Promise<void> {
    if (!this.revoked.includes(token.accessToken)) this.revoked.push(token.accessToken);
  }

  /** test helper: account ids a live token manages */
  managedBy(accessToken: string): string[] {
    return (this.#tokens.get(accessToken) ?? []).map((a) => a.id);
  }
}

export const FAKE_META_APP_SECRET = 'fake-meta-app-secret';

export class FakeMeta implements MetaMessagingProvider {
  readonly outbox: DmSend[] = [];
  constructor(private readonly oauth: FakeOAuth) {}

  async sendDirectMessage(i: DmSend): Promise<ProviderResult> {
    const prior = this.outbox.findIndex((m) => m.idempotencyKey === i.idempotencyKey);
    if (prior >= 0) return { providerRef: `fake-mid-${prior + 1}`, status: 'sent' };
    this.outbox.push({ ...i });
    return { providerRef: `fake-mid-${this.outbox.length}`, status: 'sent' };
  }

  /** The header a real Meta delivery would carry for `raw` (test helper). */
  static sign(raw: Buffer): string {
    return `sha256=${createHmac('sha256', FAKE_META_APP_SECRET).update(raw).digest('hex')}`;
  }

  verifyWebhook(raw: Buffer, signatureHeader: string): boolean {
    return verifyHubSignature(FAKE_META_APP_SECRET, raw, signatureHeader);
  }

  parseWebhook(raw: Buffer): MetaEvent[] {
    return parseMetaWebhook(raw);
  }

  async listManagedAccounts(token: OAuthToken): Promise<string[]> {
    return (await this.oauth.listManagedAccounts(token, 'messenger_page')).map((a) => a.externalAccountId);
  }
}

/** X-Hub-Signature-256 check, constant time. Shared by the fake and the real adapter. */
export function verifyHubSignature(appSecret: string, raw: Buffer, header: string): boolean {
  const m = /^sha256=([0-9a-f]{64})$/.exec(header.trim());
  if (!m) return false;
  const expected = createHmac('sha256', appSecret).update(raw).digest();
  const got = Buffer.from(m[1]!, 'hex');
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** Meta-shaped webhook body → events. VERIFY against the current Graph webhook reference. */
export function parseMetaWebhook(raw: Buffer): MetaEvent[] {
  let body: unknown;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    return [];
  }
  const b = body as { object?: unknown; entry?: unknown };
  const platform = b.object === 'instagram' ? 'instagram' : b.object === 'page' ? 'messenger' : null;
  if (!platform || !Array.isArray(b.entry)) return [];
  const out: MetaEvent[] = [];
  for (const e of b.entry as { id?: unknown; messaging?: unknown; changes?: unknown }[]) {
    const accountId = typeof e?.id === 'string' ? e.id : null;
    if (!accountId) {
      out.push({ kind: 'unsupported', externalAccountId: null });
      continue;
    }
    for (const m of Array.isArray(e.messaging) ? (e.messaging as Record<string, unknown>[]) : []) {
      const sender = (m.sender as { id?: unknown } | undefined)?.id;
      const msg = m.message as { mid?: unknown; text?: unknown; is_echo?: unknown } | undefined;
      const ts = typeof m.timestamp === 'number' ? m.timestamp : null;
      if (typeof sender === 'string' && msg && typeof msg.mid === 'string' && typeof msg.text === 'string' && msg.is_echo !== true && ts !== null) {
        out.push({ kind: 'message', platform, externalAccountId: accountId, senderScopedId: sender, providerMessageId: msg.mid, text: msg.text, at: new Date(ts).toISOString() });
      } else out.push({ kind: 'unsupported', externalAccountId: accountId });
    }
    for (const c of Array.isArray(e.changes) ? (e.changes as { field?: unknown; value?: Record<string, unknown> }[]) : []) {
      const v = c.value ?? {};
      if (c.field === 'leadgen' && typeof v.leadgen_id === 'string') {
        const t = typeof v.created_time === 'number' ? new Date(v.created_time * 1000).toISOString() : new Date(0).toISOString();
        out.push({ kind: 'leadgen', externalAccountId: accountId, leadgenId: v.leadgen_id, formId: typeof v.form_id === 'string' ? v.form_id : null, at: t });
      } else out.push({ kind: 'unsupported', externalAccountId: accountId });
    }
  }
  return out;
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

/** Deterministic AVM: a value derived from the postal code; addresses ending in "0" have no estimate. */
export class FakeAvmP2 implements AvmProvider {
  async estimate(a: AddressFacts): Promise<{ available: false } | AvmEstimate> {
    if (a.postalCode.endsWith('0')) return { available: false };
    const n = Number.parseInt(createHash('sha256').update(`${a.line1}|${a.postalCode}`).digest('hex').slice(0, 6), 16);
    const valueCents = (250_000 + (n % 500_000)) * 100;
    return { available: true, valueCents, lowCents: Math.round(valueCents * 0.92), highCents: Math.round(valueCents * 1.08), asOf: '2026-11-01', providerRef: `fake-avm-${n.toString(16)}` };
  }
}

export class FakeCalendar implements CalendarProvider {
  readonly events = new Map<string, CalendarEvent & { syncVersion: number }>();
  busy: Busy[] = [];
  constructor(readonly provider: 'google' | 'microsoft') {}
  async pushEvent(_auth: CalendarAuth, e: CalendarEvent, fence: { syncVersion: number }): Promise<PushResult> {
    const cur = this.events.get(e.appointmentId);
    if (cur && cur.syncVersion > fence.syncVersion) return { kind: 'stale', syncVersion: cur.syncVersion };
    const ref = cur?.externalEventRef ?? `fake-${this.provider}-event-${e.appointmentId}`;
    const etag = `etag-${fence.syncVersion}`;
    this.events.set(e.appointmentId, { ...e, externalEventRef: ref, externalEtag: etag, syncVersion: fence.syncVersion });
    return { kind: 'pushed', externalEventRef: ref, externalEtag: etag, syncVersion: fence.syncVersion };
  }
  async freeBusy(_auth: CalendarAuth, range: { start: string; end: string }): Promise<Busy[]> {
    return this.busy.filter((b) => b.end > range.start && b.start < range.end).map((b) => ({ ...b }));
  }
}

export class FakeSocialPublisher implements SocialPublisher {
  readonly published: PublishRequest[] = [];
  async publishPost(p: PublishRequest): Promise<PublishResult> {
    this.published.push({ ...p, imageUrls: [...p.imageUrls] });
    return { kind: 'published', providerRef: `fake-post-${this.published.length}`, url: null };
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
  oauth: { meta: FakeOAuth; google: FakeOAuth };
  meta: FakeMeta;
  leadFeeds: { zillow: FakeLeadFeed; realtor: FakeLeadFeed };
  mlsFeed: FakeResoMls;
  avm: FakeAvmP2;
  calendar: { google: FakeCalendar; microsoft: FakeCalendar };
  social: FakeSocialPublisher;
  showing: FakeShowingService;
  renderer: FakeRenderer;
}

export function createFakeIntegrations(): FakeIntegrationAdapters {
  const meta = new FakeOAuth('meta');
  return {
    mode: 'fake',
    oauth: { meta, google: new FakeOAuth('google') },
    meta: new FakeMeta(meta),
    leadFeeds: { zillow: new FakeLeadFeed('zillow'), realtor: new FakeLeadFeed('realtor') },
    mlsFeed: new FakeResoMls(),
    avm: new FakeAvmP2(),
    calendar: { google: new FakeCalendar('google'), microsoft: new FakeCalendar('microsoft') },
    social: new FakeSocialPublisher(),
    showing: new FakeShowingService(),
    renderer: new FakeRenderer(),
  };
}
