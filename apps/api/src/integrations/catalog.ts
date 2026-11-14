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
import { VALUATION_USE_WHERE } from '../mls/eligibility.js';
import type { Capabilities, ConnectionKind, ConnectionStatus, IntegrationAdapters, OAuthProviderName } from '../providers/integrations/types.js';

export type ConnectMethod = 'oauth' | 'partner' | 'keyed' | 'api_key' | 'later' | 'out_of_scope';

/** Nonsecret MLS deployment settings the sentence depends on (Config['mls'] shape). */
export interface MlsDeployment {
  provider: 'fake' | 'spark';
  liveCalls: boolean;
}

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
 * (pages_messaging, instagram_manage_messages, instagram_business_manage_messages) and Lead Ads (leads_retrieval)
 * scopes are never requested: a test checks FORBIDDEN_SCOPES and refuses any Meta scope whose name mentions
 * messaging, so a messaging permission under a new name fails too.
 */
export const META_PUBLISH_SCOPES = {
  facebook_page: ['pages_show_list', 'pages_read_engagement', 'pages_manage_posts'],
  instagram_business: ['instagram_basic', 'instagram_content_publish', 'pages_show_list'],
} as const;
/** Google Business Profile management scope. VERIFY. */
export const GOOGLE_GBP_SCOPES = ['https://www.googleapis.com/auth/business.manage'] as const;
/**
 * Module 52 (R-ADS-13): the one Google Ads API scope, requested exactly (no other Google scope rides along). VERIFY the
 * name against Google's current OAuth scope list for the Google Ads API.
 */
export const GOOGLE_ADS_SCOPES = ['https://www.googleapis.com/auth/adwords'] as const;
/**
 * Scopes that must never appear in any connect request (D2, R-MKT-12: no DMs, no messaging webhooks, no Lead Ads
 * retrieval): the Facebook Login names, the messaging permission of the Instagram API with Instagram Login
 * (instagram_business_manage_messages) and Messenger's pages_messaging_subscriptions. VERIFY current Meta names.
 */
export const FORBIDDEN_SCOPES = [
  'pages_messaging',
  'pages_messaging_subscriptions',
  'instagram_manage_messages',
  'instagram_business_manage_messages',
  'leads_retrieval',
  'pages_manage_metadata',
] as const;

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
  // Spark RESO Web API, read-only, with the CRM's own API key (mls/spark; never the website's key)
  { kind: 'mls_feed', name: 'MLS listings (Spark, read-only)', connect: 'api_key', needsLeadSource: false, usedBy: 'MLS search and alerts' },
  { kind: 'showing_service', name: 'Showing service', connect: 'partner', needsLeadSource: false, usedBy: 'seller updates' },
  // module 52: the lead source Google Ads spend is recorded under is set at connect or by PATCH connections/:id; it is not
  // required to connect (needsLeadSource mirrors the 0018 CHECK, which does not list ads_google)
  { kind: 'ads_google', name: 'Google Ads account', connect: 'oauth', oauthProvider: 'google', needsLeadSource: false, usedBy: 'Google Ads budget proposals and spend', scopes: GOOGLE_ADS_SCOPES },
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
  /** `rules->>'vendor_ready_at'`: the vendor check a VENDOR_CHECKED_PACKS pack also needs (null = not passed) */
  vendorReadyAt: string | null;
}

/**
 * The packs the database clears only once the vendor check passed too: `app.platform_cleared(key, true)` (0018
 * voice, 0025 Gmail) needs `reviewed_by_counsel_at` AND `rules.vendor_ready_at` (R-INT-6). A test compares this
 * list with the database's own calls.
 */
export const VENDOR_CHECKED_PACKS: readonly string[] = ['platform:voice', 'platform:gmail', 'platform:ads'];

/**
 * D2: packs that are never cleared. platform:meta gates only 0018's DM guard branch, which no product path writes,
 * and its 0025 notes say "Do not clear", so the page never asks for its review.
 */
export const NEVER_CLEARED_PACKS: readonly string[] = ['platform:meta'];

/**
 * Packs whose capability is not built in this version, with why nothing reaches a client. Their line never reads
 * "stays off" or "cleared", so neither the review state nor a recorded clearance reads as the capability being
 * available (batch 10 review api-ui/F3). The web names them in apps/web/src/surfaces/admin/integrations/words.ts
 * PACK_NAMES. platform:cma left this list in batch 13 (b13 audit V2B-1): V2-A builds client CMAs (the share email and
 * its PDF) and V2-B builds seller value ranges and in-house home-value notes, all behind it, so its line says
 * "stays off" until counsel review is recorded and "cleared" after, as any built capability's does.
 * platform:ai_isa_seller_data left it in batch 14 round 2 the same way: ISA-3 (batch 13, apps/api/src/isa/seller/**)
 * builds the assistant's recent-sales emails behind it, so "not built in this version" was false (Honest UI).
 */
export const NOT_BUILT_PACKS: Readonly<Record<string, string>> = {};

/** platform:* pack → what waits on it, in words (R-INT-6). The web mirrors the keys in words.ts PACK_NAMES (words.test.ts). */
export const PACK_GATES: Record<string, string> = {
  'platform:meta': 'Meta messaging',
  'platform:fair_housing': 'Publishing marketing',
  'platform:avm': 'Home-value notes',
  'platform:review_requests': 'Review requests',
  'platform:coaching': 'Call reviews',
  'platform:voice': 'Voice answering',
  'platform:portal': 'Client portal sign-in',
  'platform:gmail': 'Gmail inbox sync',
  'platform:cma': 'Client CMAs, seller value ranges and in-house home-value notes', // module 71 (D9, F8; R-CMA-10: in-house notes need platform:avm too)
  'platform:ads': 'Changing Google Ads budgets',
  'platform:public_records_outreach': 'Outreach using public-record data (not built)',
  // the AI ISA packs (D12 proposed; b12 review ui-1): the page prints this line under the web name, so it names "the
  // assistant" the same way (staff copy never calls it "AI"; words.test.ts)
  'platform:ai_isa': "The assistant's ISA texts and emails",
  'platform:ai_isa_seller_data': "The assistant's recent-sales emails",
  'platform:gbp': 'Google Business Profile',
};

/**
 * b13 audit V2B-1 (R-CMA-10, R-INT-6): in-house home-value notes (production's AvmProvider, InHouseAvm) need both
 * platform:avm and platform:cma, so each pack's line names the other and says whether counsel has reviewed it. Without
 * it, "Home-value notes: cleared" (platform:avm alone) would read as notes going out while InHouseAvm requests nothing.
 */
export const PACK_ALSO_NEEDS: Readonly<Record<string, { pack: string; what: string }>> = {
  'platform:cma': { pack: 'platform:avm', what: 'In-house home-value notes' },
  'platform:avm': { pack: 'platform:cma', what: 'In-house home-value notes from recent MLS sales' },
  // b14 round 2 (R-ISA-18; cma/gates.ts readiness use 'ai_isa' needs both packs): ISA-3's recent-sales emails
  'platform:ai_isa_seller_data': { pack: 'platform:cma', what: 'Recent sales from the assistant' },
};

/**
 * b14 round 2 (R-ISA-18, R-MLS licence pack): a pack whose capability also needs the MLS licence pack's permission,
 * which the Integrations page does not read, so the line names the requirement and where it is recorded, never its
 * state. The assistant's recent-sales emails need `valuation.ai_isa_comps` on every comp's feed (cma/gates.ts
 * 'ai_isa', strict default false), as the readiness sentence says.
 */
export const PACK_ALSO_LICENCE: Readonly<Record<string, string>> = {
  'platform:ai_isa_seller_data': `Your MLS licence pack must also allow sold data in the assistant's emails to seller leads. ${VALUATION_USE_WHERE}`,
};

/**
 * b15 (b14 low g): what else holds a pack's capability back in this version, said without "not built" (the capability
 * is built and held). The assistant's recent-sales emails need V2-A's statement rules, which isa/seller/cmaSeam.ts
 * stubs (STUB(V2-A): every statement refused), so no recent-sales email goes out whatever the packs say. Remove the line
 * when cma/statement.ts is connected there (integrations.test.ts pins both together).
 */
export const PACK_ALSO_HELD: Readonly<Record<string, string>> = {
  'platform:ai_isa_seller_data': 'The emails also wait for the statement rules to be connected, so none is sent in this version.',
};

/**
 * A capability that also waits on platform clearance packs (one, or several that must all be cleared). A pack in
 * VENDOR_CHECKED_PACKS also needs its vendor check (`rules.vendor_ready_at`), exactly as the database clears it:
 * `change_budget` waits for `platform:ads`, which the module 52 gates read with `app.platform_cleared('platform:ads', true)`.
 * The publishing packs need counsel review only, as the 0025 publications guard's
 * `app.platform_cleared('platform:fair_housing')` and module 53's `app.platform_cleared('platform:gbp')` do (VERIFY: platform:gbp
 * counsel-only versus vendor-checked, ARCHITECTURE §21.40). Reading
 * Google Ads spend waits for no pack (module 52, Q-ADS-1).
 */
const CAPABILITY_PACK: Partial<Record<ConnectionKind, Record<string, string | readonly string[]>>> = {
  facebook_page: { publish_posts: 'platform:fair_housing' },
  instagram_business: { publish_posts: 'platform:fair_housing' },
  // module 53: GBP stays dark behind platform:gbp (D7); posts and replies also need platform:fair_housing
  gbp_location: { publish_posts: ['platform:fair_housing', 'platform:gbp'], read_reviews: 'platform:gbp', reply_reviews: ['platform:fair_housing', 'platform:gbp'] },
  ads_google: { change_budget: 'platform:ads' },
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

/**
 * The pack's state in words, matching what the database clears (`app.platform_cleared`, R-INT-6): it says
 * "cleared" only when the pack is, so a vendor-checked pack stays off until `rules.vendor_ready_at` is set even
 * after counsel review, and a never-cleared pack (D2) never reads as awaiting review or as cleared. A pack in
 * PACK_ALSO_NEEDS adds the second pack its capability needs, with that pack's review state when `all` holds it.
 */
export function packSentence(p: PlatformPack, all: readonly PlatformPack[] = []): string {
  const base = packStateSentence(p);
  const licence = (Object.hasOwn(PACK_ALSO_LICENCE, p.key) ? ` ${PACK_ALSO_LICENCE[p.key]!}` : '') + (Object.hasOwn(PACK_ALSO_HELD, p.key) ? ` ${PACK_ALSO_HELD[p.key]!}` : '');
  const also = PACK_ALSO_NEEDS[p.key];
  if (also === undefined) return `${base}${licence}`;
  const other = all.find((x) => x.key === also.pack);
  const otherName = PACK_GATES[also.pack] ?? also.pack;
  const state = other === undefined ? ' reviewed by counsel' : other.reviewedByCounselAt === null ? ' (not reviewed yet)' : `, which counsel reviewed on ${other.reviewedByCounselAt.slice(0, 10)}`;
  return `${base} ${also.what} also need the ${otherName} pack${state}.${licence}`;
}

function packStateSentence(p: PlatformPack): string {
  const what = PACK_GATES[p.key] ?? 'This capability';
  const reviewedOn = p.reviewedByCounselAt === null ? null : p.reviewedByCounselAt.slice(0, 10);
  if (NEVER_CLEARED_PACKS.includes(p.key)) {
    return reviewedOn === null
      ? `${what}: not offered (owner decision D2); nothing waits on this pack and it is never cleared (pack ${p.version}).`
      : `${what}: not offered (owner decision D2); the pack was marked reviewed on ${reviewedOn}, but ${what} stays out of scope (pack ${p.version}).`;
  }
  const notBuilt = NOT_BUILT_PACKS[p.key];
  if (notBuilt !== undefined) {
    return reviewedOn === null
      ? `${what}: not built in this version, so ${notBuilt}; they would also wait for counsel review (pack ${p.version}, not yet reviewed).`
      : `${what}: not built in this version, so ${notBuilt}; counsel reviewed the pack on ${reviewedOn} (pack ${p.version}).`;
  }
  const vendorPending = VENDOR_CHECKED_PACKS.includes(p.key) && p.vendorReadyAt === null;
  if (reviewedOn === null) return `${what} stays off: awaiting counsel review${vendorPending ? ' and the vendor check' : ''} (pack ${p.version}, not yet reviewed).`;
  if (vendorPending) return `${what} stays off: counsel reviewed it on ${reviewedOn}; it also waits for the vendor check (pack ${p.version}).`;
  return `${what}: cleared by counsel on ${reviewedOn} (pack ${p.version}).`;
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

export function serviceSentence(service: ServiceDef, adapters: Pick<IntegrationAdapters, 'mode' | 'oauth' | 'leadFeeds' | 'mlsFeed' | 'showing'>, mls: MlsDeployment = { provider: 'fake', liveCalls: false }): string {
  switch (service.connect) {
    case 'api_key':
      if (mls.provider !== 'spark') {
        if (adapters.mlsFeed.access === 'needs_partner_access') return `Not set up on this platform yet: this deployment has no Spark connection configured, so no MLS data is read.`;
        return 'Demo data only (test adapter); no real MLS account is connected.';
      }
      if (!mls.liveCalls) return "Live MLS calls are turned off on this deployment. An Owner or Admin can save the CRM's own Spark key (never the website's); nothing is read until live calls are on and the key is validated.";
      return "Read-only Spark connection with the CRM's own API key (never the website's). It goes live only after the key is validated.";
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
    const named = CAPABILITY_PACK[kind]?.[name];
    const keys: readonly string[] = named === undefined ? [] : typeof named === 'string' ? [named] : named;
    const packOf = (k: string) => packs.find((p) => p.key === k);
    // "available" only when every named pack is reviewed and, for a VENDOR_CHECKED_PACKS pack, vendor-checked;
    // the reason names the first pack not reviewed, else the first whose vendor check is pending
    const unreviewed = keys.find((k) => (packOf(k)?.reviewedByCounselAt ?? null) === null);
    const vendorPending = keys.find((k) => VENDOR_CHECKED_PACKS.includes(k) && (packOf(k)?.vendorReadyAt ?? null) === null);
    const reason = !offered
      ? NOT_OFFERED
      : !live
        ? 'The connection is not live.'
        : unreviewed !== undefined
          ? `Waits for counsel review of ${unreviewed}.`
          : vendorPending !== undefined
            ? `Waits for the vendor check of ${vendorPending}.`
            : null;
    out.push({ name, available: reason === null, reason });
  }
  return out;
}
