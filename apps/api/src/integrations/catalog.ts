// What the Integrations page shows for every service, in words (R-INT-2, R-INT-6; PHASE2_3_PLAN §5.4 #21
// "Accept when"). Pure: the API passes in the adapter mode, the platform packs and the rows.
//
// Rules:
//  - A capability is offered only if the adapter REPORTED it (`capabilities`, written by the system) AND
//    the connection is live (connected/degraded) AND its platform clearance pack (if any) is
//    counsel-reviewed; otherwise it is listed as unavailable with the reason in words.
//  - Partner feeds without an agreement say "needs partner access"; production without a platform app says
//    "not set up on this platform yet"; nothing claims to work when it does not.
//  - Owner decision D2: what the owner took out of scope is listed as "Not offered", can never be connected and
//    offers no capability.
import type { Capabilities, ConnectionKind, ConnectionStatus, IntegrationAdapters, OAuthProviderName } from '../providers/integrations/types.js';

export type ConnectMethod = 'oauth' | 'partner' | 'keyed' | 'later' | 'out_of_scope';

export interface ServiceDef {
  kind: ConnectionKind;
  name: string;
  connect: ConnectMethod;
  oauthProvider?: OAuthProviderName;
  /** connected inbound channels need a lead source (0018 CHECK) */
  needsLeadSource: boolean;
  /** which module turns this connection into product work */
  usedBy: string;
  /** OAuth scopes requested (least privilege). VERIFY every scope name against the vendor's current docs. */
  scopes?: readonly string[];
}

/**
 * D2 (owner scope change): Meta is connected ONLY to publish to a Facebook Page (`facebook_page`) or an
 * Instagram business account (`instagram_business`). These are the publishing-only scopes we believe Meta
 * requires. VERIFY the exact names with Meta's current permission reference and app review. Messaging
 * (pages_messaging, instagram_manage_messages) and Lead Ads (leads_retrieval) scopes are never requested (a test
 * checks this).
 */
export const META_PUBLISH_SCOPES = {
  facebook_page: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
  instagram_business: ['instagram_basic', 'instagram_content_publish', 'pages_show_list'],
} as const;
/** Google Business Profile management scope. VERIFY. */
export const GOOGLE_GBP_SCOPES = ['https://www.googleapis.com/auth/business.manage'] as const;
/** Scopes that must never appear in any connect request (D2: no DMs, no Lead Ads retrieval). */
export const FORBIDDEN_SCOPES = ['pages_messaging', 'instagram_manage_messages', 'leads_retrieval', 'pages_manage_metadata'] as const;

export const SERVICES: readonly ServiceDef[] = [
  // D2 (0025): Meta is for content publishing only, through the publishing kinds `facebook_page` and
  // `instagram_business`. They are never an inbound channel, so they never carry a lead source (CHECK
  // integration_connections_publishing_no_source; the API refuses one first, see PUBLISHING_KINDS).
  { kind: 'facebook_page', name: 'Facebook Page (publishing)', connect: 'oauth', oauthProvider: 'meta', needsLeadSource: false, usedBy: 'marketing publishing', scopes: META_PUBLISH_SCOPES.facebook_page },
  { kind: 'instagram_business', name: 'Instagram business account (publishing)', connect: 'oauth', oauthProvider: 'meta', needsLeadSource: false, usedBy: 'marketing publishing', scopes: META_PUBLISH_SCOPES.instagram_business },
  { kind: 'web_chat_widget', name: 'Website chat', connect: 'keyed', needsLeadSource: true, usedBy: 'the unified inbox' },
  { kind: 'lead_email', name: 'Lead email inbox', connect: 'keyed', needsLeadSource: true, usedBy: 'lead intake' },
  { kind: 'zillow_feed', name: 'Zillow lead feed', connect: 'partner', needsLeadSource: true, usedBy: 'lead intake' },
  { kind: 'realtor_feed', name: 'realtor.com lead feed', connect: 'partner', needsLeadSource: true, usedBy: 'lead intake' },
  { kind: 'mls_feed', name: 'MLS / IDX feed', connect: 'partner', needsLeadSource: false, usedBy: 'MLS search and alerts' },
  { kind: 'showing_service', name: 'Showing service', connect: 'partner', needsLeadSource: false, usedBy: 'seller updates' },
  { kind: 'ads_google', name: 'Google Ads account', connect: 'later', oauthProvider: 'google', needsLeadSource: false, usedBy: 'ads (Phase 3)' },
  { kind: 'gbp_location', name: 'Google Business Profile', connect: 'oauth', oauthProvider: 'google', needsLeadSource: false, usedBy: 'Google Business Profile', scopes: GOOGLE_GBP_SCOPES },
  // D2: out of scope (Messenger and Instagram DMs, Meta Lead Ads, Meta ads). These 0018 kinds stay in the kind
  // CHECK until the cleanup migration (PHASE2_3_PLAN §3). They are listed only so that a row made before D2 stays
  // visible and can be disconnected; nothing offers them: no OAuth start, no callback, no connect through the
  // status machine (OUT_OF_SCOPE_KINDS). The lead-source flags still mirror the 0018 CHECK.
  { kind: 'messenger_page', name: 'Facebook Messenger', connect: 'out_of_scope', needsLeadSource: true, usedBy: 'nothing (out of scope)' },
  { kind: 'instagram_account', name: 'Instagram direct messages', connect: 'out_of_scope', needsLeadSource: true, usedBy: 'nothing (out of scope)' },
  { kind: 'meta_lead_ads', name: 'Meta Lead Ads', connect: 'out_of_scope', needsLeadSource: true, usedBy: 'nothing (out of scope)' },
  { kind: 'ads_meta', name: 'Meta ads account', connect: 'out_of_scope', needsLeadSource: false, usedBy: 'nothing (out of scope)' },
];

export function serviceOf(kind: string): ServiceDef | undefined {
  return SERVICES.find((s) => s.kind === kind);
}

/** D2: the kinds module 21 never offers or connects (`messenger_page`, `instagram_account`, `meta_lead_ads`, `ads_meta`). */
export const OUT_OF_SCOPE_KINDS: readonly ConnectionKind[] = SERVICES.filter((s) => s.connect === 'out_of_scope').map((s) => s.kind);

/** D2 (0025): publishing-only kinds. Never an inbound channel, so never a lead source (CHECK integration_connections_publishing_no_source). */
export const PUBLISHING_KINDS: readonly ConnectionKind[] = ['facebook_page', 'instagram_business'];

export interface PlatformPack {
  key: string;
  version: string;
  reviewedByCounselAt: string | null;
}

/** platform:* pack → what waits on it, in words (R-INT-6). */
export const PACK_GATES: Record<string, string> = {
  // D2: platform:meta gates only 0018's DM guard branch, which no product path writes (its 0025 notes say so)
  'platform:meta': 'Meta messaging (out of scope, owner decision D2; nothing waits on this pack)',
  'platform:fair_housing': 'Publishing marketing',
  'platform:avm': 'Home-value notes',
  'platform:review_requests': 'Review requests',
  'platform:coaching': 'Call reviews',
  'platform:voice': 'Voice answering',
  'platform:portal': 'Client portal sign-in',
  'platform:gmail': 'Gmail inbox sync',
};

/** A capability that also waits on a platform clearance pack. */
const CAPABILITY_PACK: Partial<Record<ConnectionKind, Record<string, string>>> = {
  facebook_page: { publish_posts: 'platform:fair_housing' },
  instagram_business: { publish_posts: 'platform:fair_housing' },
  gbp_location: { publish_posts: 'platform:fair_housing' },
};

/**
 * Per-person connections (user_calendar_links: self and system only; Owners/Admins never see tokens). The
 * Integrations page names them so nobody looks for them there; each person connects in their own settings
 * (module 34 builds that flow on `Providers.integrations.oauth.google/microsoft` and `calendar.*`).
 */
export const PER_USER_SERVICES = [
  { key: 'google_calendar', name: 'Google Calendar', sentence: 'Each person connects their own calendar from their settings: appointments are pushed one way and free/busy is read live. Nobody else sees their calendar or token.' },
  { key: 'microsoft_calendar', name: 'Microsoft calendar', sentence: 'Each person connects their own calendar from their settings: appointments are pushed one way and free/busy is read live. Nobody else sees their calendar or token.' },
] as const;

export function packSentence(p: PlatformPack): string {
  const what = PACK_GATES[p.key] ?? 'This capability';
  if (p.reviewedByCounselAt) return `${what}: cleared by counsel on ${p.reviewedByCounselAt.slice(0, 10)} (pack ${p.version}).`;
  return `${what} stays off: awaiting counsel review (pack ${p.version}, not yet reviewed).`;
}

export function statusSentence(s: ConnectionStatus, reason: string | null, service: ServiceDef, at: { disconnectedAt: string | null }): string {
  switch (s) {
    case 'not_configured':
      return 'Not connected yet. Nothing is sent or received.';
    case 'needs_partner_access':
      return `Needs partner access: ${service.name} has not granted this platform API access yet. Nothing is received.`;
    case 'pending_review':
      return 'Waiting for the platform to finish its review. The account is reserved for your team; nothing is sent or received yet.';
    case 'connected':
      return 'Connected.';
    case 'degraded':
      return `Connected with problems (${reason ?? 'PROVIDER_ERRORS'}). Some messages may be delayed.`;
    case 'revoked':
      return 'Access was revoked at the provider. Nothing is sent or received until someone reconnects it.';
    case 'disconnected':
      return `Disconnected${at.disconnectedAt ? ` on ${at.disconnectedAt.slice(0, 10)}` : ''}. Nothing is sent or received.`;
  }
}

const NOT_OFFERED = 'Not offered: the owner has taken this out of scope.';

export function serviceSentence(service: ServiceDef, adapters: Pick<IntegrationAdapters, 'mode' | 'oauth' | 'leadFeeds' | 'mlsFeed' | 'showing'>): string {
  switch (service.connect) {
    case 'out_of_scope':
      return NOT_OFFERED;
    case 'later':
      return `Arrives with ${service.usedBy}; it cannot be connected yet.`;
    case 'keyed':
      return `Set up from the inbox settings; it has no outside account to connect.`;
    case 'partner': {
      const access =
        service.kind === 'zillow_feed'
          ? adapters.leadFeeds.zillow.access
          : service.kind === 'realtor_feed'
            ? adapters.leadFeeds.realtor.access
            : service.kind === 'mls_feed'
              ? adapters.mlsFeed.access
              : adapters.showing.access;
      if (access === 'needs_partner_access') return `Needs partner access: ${service.name} has not granted this platform API access yet. Leads still arrive by email forwarding where the service offers it.`;
      return adapters.mode === 'fake' ? 'Demo data only (test adapter); no real partner account is connected.' : 'Available.';
    }
    case 'oauth': {
      const c = adapters.oauth[service.oauthProvider!];
      if (!c.configured) return 'Not set up on this platform yet: no platform app is configured, so it cannot be connected.';
      const who = service.oauthProvider === 'meta' ? 'Meta' : service.oauthProvider === 'google' ? 'Google' : 'Microsoft';
      return adapters.mode === 'fake' ? 'Test adapter: connects to a simulated account only.' : `Connect with your ${who} login; we check that you manage the account first.`;
    }
  }
}

export interface CapabilityView {
  name: string;
  available: boolean;
  /** why not, in words (null when available) */
  reason: string | null;
}

/**
 * Only what the adapter reported is listed; each says whether it is usable now and why not. D2: a row of an
 * out-of-scope kind (made before D2) offers nothing, whatever the adapter reported then.
 */
export function capabilityViews(kind: ConnectionKind, status: ConnectionStatus, reported: Capabilities, packs: readonly PlatformPack[]): CapabilityView[] {
  const out: CapabilityView[] = [];
  const offered = !OUT_OF_SCOPE_KINDS.includes(kind);
  for (const name of Object.keys(reported).sort()) {
    if (reported[name] !== true) continue;
    const live = status === 'connected' || status === 'degraded';
    const packKey = CAPABILITY_PACK[kind]?.[name];
    const pack = packKey ? packs.find((p) => p.key === packKey) : undefined;
    const cleared = !packKey || (pack !== undefined && pack.reviewedByCounselAt !== null);
    const reason = !offered ? NOT_OFFERED : !live ? 'The connection is not live.' : !cleared ? `Waits for counsel review of ${packKey}.` : null;
    out.push({ name, available: reason === null, reason });
  }
  return out;
}
