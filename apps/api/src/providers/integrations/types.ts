// Phase 2-3 adapter interfaces (PHASE2_3_PLAN §5.4 #21; R-INT-1, R-INT-4). Every external service the
// plan lists is an interface here with a deterministic fake (fakes.ts) and a real adapter that refuses to
// start without its configuration (real.ts). Adapters never receive tenant context: every call takes
// explicit account ids and the credentials the caller decrypted as the system actor.
//
// Owner scope change D2 (overrides PHASE2_3_PLAN): Facebook Messenger and Instagram direct messages are OUT
// of scope, and so are Meta Lead Ads retrieval and Meta ads. There is no Meta messaging adapter, no DM webhook
// parser, no messaging window and no messaging scope here. A Meta connection exists ONLY for content
// publishing (SocialPublisher), on the 0025 kinds `facebook_page` and `instagram_business`.
//
// Reserved outbound name (R-GATE-15, ARCHITECTURE §21.2): `SocialPublisher.publishPost` is callable only
// from apps/api/src/marketing/publish.ts (module 29 extends the lint rule). Nothing in this module calls it.
// No interface has a method that sends to a person or places an AI outbound call.
//
// Names that clash with the Phase 1 bag (providers/types.ts `MlsFeed`, `AvmProvider`) are the Phase 2
// shapes and live only inside `Providers.integrations`, so the Phase 1 fakes keep working unchanged.
//
// VERIFY: every vendor shape below is RESO-/Graph-/OAuth-*shaped*, not a copy of a vendor API. The real
// adapters are wired only once a partner account exists; until then the fakes are the only working
// implementation and production reports "not set up on this platform" instead of using them.

/**
 * integration_connections.kind (0018 CHECK, widened by 0025). D2: `facebook_page` and `instagram_business` are
 * publishing only (never an inbound channel, never a lead source); 0018's `messenger_page`, `instagram_account`,
 * `meta_lead_ads` and `ads_meta` stay in the CHECK until the cleanup migration and module 21 never offers them.
 */
export const CONNECTION_KINDS = [
  'messenger_page',
  'instagram_account',
  'web_chat_widget',
  'lead_email',
  'zillow_feed',
  'realtor_feed',
  'meta_lead_ads',
  'mls_feed',
  'showing_service',
  'ads_meta',
  'ads_google',
  'gbp_location',
  'facebook_page',
  'instagram_business',
] as const;
export type ConnectionKind = (typeof CONNECTION_KINDS)[number];

/** integration_connections.status (0018 CHECK). */
export const CONNECTION_STATUSES = ['not_configured', 'needs_partner_access', 'pending_review', 'connected', 'degraded', 'revoked', 'disconnected'] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

/** What an adapter reports it can do for one account (integration_connections.capabilities). */
export type Capabilities = Record<string, boolean>;

export interface ProviderResult {
  providerRef: string;
  status: 'queued' | 'sent' | 'delivered' | 'failed' | 'unknown';
}

// ---- OAuth (Meta, Google): the only way an external account gets linked (R-INT-3) ---------------

export type OAuthProviderName = 'meta' | 'google' | 'microsoft';

export interface OAuthToken {
  accessToken: string;
  refreshToken: string | null;
  /** ISO instant or null (long-lived) */
  expiresAt: string | null;
  scopes: string[];
}

export interface ManagedAccount {
  externalAccountId: string;
  displayName: string;
  /** what the adapter reports for this account and kind */
  capabilities: Capabilities;
  /** the platform still reviews this account / app for the capability (ends in `pending_review`) */
  reviewPending: boolean;
}

export interface OAuthConnector {
  readonly provider: OAuthProviderName;
  /** false: no platform app is configured; the UI says "not set up on this platform yet" */
  readonly configured: boolean;
  /** Authorization URL with PKCE (S256) and the signed state. */
  /** `scopes` come from the catalog (publishing-only for Meta, D2); the adapter never widens them */
  authorizeUrl(i: { kind: ConnectionKind; state: string; codeChallenge: string; redirectUri: string; scopes: readonly string[] }): string;
  /** Code → token. The code is single-use at the provider; the verifier proves this server started the flow. */
  exchangeCode(i: { code: string; codeVerifier: string; redirectUri: string }): Promise<OAuthToken>;
  /** The accounts this token manages for `kind`: the callback's proof of control (E160). */
  listManagedAccounts(token: OAuthToken, kind: ConnectionKind): Promise<ManagedAccount[]>;
  /** Best effort revocation at the provider (R-INT-5). */
  revoke(token: OAuthToken): Promise<void>;
}

// ---- Partner lead feeds (Zillow, realtor.com): needs_partner_access until access exists ---------

export interface FeedLead {
  externalLeadId: string;
  receivedAt: string;
  name: string | null;
  phone: string | null;
  email: string | null;
  message: string | null;
  listingRef: string | null;
}

export interface LeadFeedPage {
  leads: FeedLead[];
  cursor: string | null;
}

export interface LeadFeedProvider {
  readonly source: 'zillow' | 'realtor';
  /** honest access state: a partner feed we have no agreement for says so */
  readonly access: 'available' | 'needs_partner_access';
  poll(i: { externalAccountId: string; accessToken: string; cursor: string | null }): Promise<LeadFeedPage>;
}

// ---- MLS (RESO-shaped; per-MLS licence pack) -------------------------------------------------------

export interface ResoListing {
  listingKey: string;
  listingId: string;
  standardStatus: 'Active' | 'Pending' | 'Closed' | 'Withdrawn' | 'Expired' | 'Canceled' | 'ComingSoon';
  listPriceCents: number;
  unparsedAddress: string;
  city: string;
  stateOrProvince: string;
  postalCode: string;
  bedroomsTotal: number | null;
  bathroomsTotalX10: number | null;
  livingAreaSqft: number | null;
  propertyType: string;
  listOfficeName: string;
  modificationTimestamp: string;
}

export interface MlsPage {
  listings: ResoListing[];
  cursor: string | null;
}

export interface MediaRef {
  order: number;
  url: string;
  contentType: string;
}

/** Display rules per audience. VERIFY per MLS: this shape is a placeholder until a licence is signed. */
export interface LicensePack {
  mls: string;
  version: string;
  reviewed: false;
  rules: { displayToPublic: boolean; displayToClients: boolean; requireAttribution: boolean; maxPhotos: number | null };
}

export interface MlsFeed {
  readonly access: 'available' | 'needs_partner_access';
  changes(cursor: string | null, limit: number): Promise<MlsPage>;
  media(listingKey: string): Promise<MediaRef[]>;
  describeLicense(): LicensePack;
}

// ---- AVM (platform configuration, not a tenant connection) ------------------------------------------

export interface AddressFacts {
  line1: string;
  city: string;
  region: string;
  postalCode: string;
}

export interface AvmEstimate {
  available: true;
  valueCents: number;
  lowCents: number;
  highCents: number;
  asOf: string;
  providerRef: string;
}

export interface AvmProvider {
  estimate(a: AddressFacts): Promise<{ available: false } | AvmEstimate>;
}

// ---- Calendar (per-user OAuth link; module 34) ------------------------------------------------------

export interface CalendarAuth {
  provider: 'google' | 'microsoft';
  accessToken: string;
  calendarRef: string;
}

export interface CalendarEvent {
  appointmentId: string;
  startsAt: string;
  endsAt: string;
  /** already reduced to the tenant's calendar_title_detail */
  title: string;
  externalEventRef: string | null;
  externalEtag: string | null;
}

export type PushResult =
  | { kind: 'pushed'; externalEventRef: string; externalEtag: string; syncVersion: number }
  | { kind: 'stale'; syncVersion: number }
  | { kind: 'detached' };

export interface Busy {
  start: string;
  end: string;
}

export interface CalendarProvider {
  pushEvent(auth: CalendarAuth, e: CalendarEvent, fence: { syncVersion: number }): Promise<PushResult>;
  freeBusy(auth: CalendarAuth, range: { start: string; end: string }): Promise<Busy[]>;
}

// ---- Social publishing (module 29) --------------------------------------------------------------------

export interface PublishRequest {
  externalAccountId: string;
  accessToken: string;
  /** the target account's connection kind (0025 marketing_publications_guard: a social post goes to a Page or an Instagram business account, a GBP post to a GBP location) */
  target: 'facebook_page' | 'instagram_business' | 'gbp_location';
  pieceId: string;
  contentSha256: string;
  text: string;
  imageUrls: string[];
}

export type PublishResult = { kind: 'published'; providerRef: string; url: string | null } | { kind: 'rejected'; code: string };

/** Module 29 (additive): find a post whose publish answer was lost (timeout), by the piece and content it carried. */
export interface LookupRequest {
  externalAccountId: string;
  accessToken: string;
  target: PublishRequest['target'];
  pieceId: string;
  contentSha256: string;
}
/** `unsupported`: the provider cannot find a post without its id (VERIFY per provider); 'unknown' then stays unknown. */
export type LookupResult = { kind: 'found'; providerRef: string } | { kind: 'not_found' } | { kind: 'unsupported' };

/** Module 29 (additive): delete a post the provider confirmed. */
export interface DeleteRequest {
  externalAccountId: string;
  accessToken: string;
  target: PublishRequest['target'];
  providerRef: string;
}
/** `unsupported`: the API cannot delete it (VERIFY: Instagram); the agent removes it themselves. */
export type DeleteResult = { kind: 'deleted' } | { kind: 'unsupported' } | { kind: 'failed'; code: string };

export interface SocialPublisher {
  /** RESERVED (R-GATE-15): only marketing/publish.ts calls it. A timeout is thrown as ProviderError('timeout'). */
  publishPost(p: PublishRequest): Promise<PublishResult>;
  /** Only marketing/publish.ts calls it: reconcile an 'unknown' publication by lookup, never by posting again (E227). */
  lookupPost(p: LookupRequest): Promise<LookupResult>;
  /** Only marketing/publish.ts calls it: a retraction is recorded only after this confirmed the deletion. */
  deletePost(p: DeleteRequest): Promise<DeleteResult>;
}

// ---- Showing service (adapter + fake only until partner access, PHASE2_3_PLAN §3) -------------------

export interface ShowingRecord {
  externalShowingId: string;
  listingRef: string;
  startsAt: string;
  status: 'scheduled' | 'completed' | 'canceled';
  feedback: string | null;
}

export interface ShowingServiceProvider {
  readonly access: 'available' | 'needs_partner_access';
  changes(i: { externalAccountId: string; accessToken: string; cursor: string | null }): Promise<{ showings: ShowingRecord[]; cursor: string | null }>;
}

// ---- PDF renderer (flyers, platform configuration) ----------------------------------------------------

export interface RenderedPdf {
  bytes: Uint8Array;
  contentType: 'application/pdf';
  sha256: string;
}

export interface DocumentRenderer {
  /** module 29 (additive): `images` are the piece's image bytes (PNG/JPEG) in order, when the caller has them */
  renderPdf(i: { templateKey: string; fields: Record<string, string>; imageCount: number; images?: Uint8Array[] }): Promise<RenderedPdf>;
}

/** The Phase 2 adapter bag (`Providers.integrations`). */
export interface IntegrationAdapters {
  /** fake: deterministic fakes (dev, tests, an explicit staging demo); unconfigured: production with no partner app */
  readonly mode: 'fake' | 'unconfigured' | 'real';
  oauth: Record<OAuthProviderName, OAuthConnector>;
  leadFeeds: { zillow: LeadFeedProvider; realtor: LeadFeedProvider };
  mlsFeed: MlsFeed;
  avm: AvmProvider;
  calendar: { google: CalendarProvider; microsoft: CalendarProvider };
  social: SocialPublisher;
  showing: ShowingServiceProvider;
  renderer: DocumentRenderer;
  /**
   * Transport of the read-only Spark RESO adapter (spark.ts). Undefined ⇒ the global fetch. Tests install a
   * mock Spark server here; nothing else may. The adapter itself enforces GET-only, allow-lists and the
   * MLS_LIVE_CALLS kill switch whatever transport it is given.
   */
  mlsTransport?: (url: string, init: { method: 'GET'; headers: Record<string, string>; redirect: 'manual'; signal: AbortSignal }) => Promise<Response>;
}
