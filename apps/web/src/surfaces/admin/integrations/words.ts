// Plain words for the Integrations page. Pure functions over what the API sent; nothing here claims a
// capability works: the server's sentences say what works, and the page adds only names and links.
import type { AdapterMode, Capability, Connection } from './types.js';

export const PAGE_PATH = '/admin/integrations';
export const MLS_PAGE_PATH = '/admin/integrations/mls';
export const WEBCHAT_PAGE_PATH = '/admin/web-chat';
export const LEAD_SOURCES_PAGE_PATH = '/admin/lead-sources';

/** platform:* review pack → what waits on it (mirrors the API catalog's PACK_GATES; unknown keys get a generic name). */
const PACK_NAMES: Record<string, string> = {
  'platform:fair_housing': 'Publishing marketing (fair-housing rules)',
  'platform:avm': 'Home-value notes',
  'platform:review_requests': 'Review requests',
  'platform:coaching': 'Call reviews',
  'platform:voice': 'Voice answering',
  'platform:portal': 'Client portal sign-in',
  'platform:gmail': 'Gmail inbox sync',
};

export function packName(key: string): string {
  return PACK_NAMES[key] ?? 'Another feature';
}

const CAPABILITY_NAMES: Record<string, string> = {
  publish_posts: 'Publish posts',
  receive_leads: 'Receive leads',
  read_listings: 'Read listings',
  send_messages: 'Send messages',
  receive_messages: 'Receive messages',
};

export function capabilityName(name: string): string {
  if (Object.hasOwn(CAPABILITY_NAMES, name)) return CAPABILITY_NAMES[name]!;
  const words = name.replace(/[_-]+/g, ' ').trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Unnamed capability';
}

/** The server names a pack by key ("Waits for counsel review of platform:fair_housing."); say its name instead. */
export function capabilityReason(c: Capability): string {
  if (c.available) return 'Works now.';
  const r = (c.reason ?? '').replace(/platform:[a-z_]+/g, (k) => `the ${packName(k).toLowerCase()} rules`);
  return r || 'Not available yet.';
}

/** A status sentence with any raw UPPER_SNAKE code in brackets taken out (CONVENTIONS §7: never a raw code). */
export function plainSentence(s: string): string {
  return s
    .replace(/\s*\([A-Z][A-Z0-9_]+\)/g, '')
    .replace(/\b[A-Z]{2,}_[A-Z_]+\b/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

export type Tone = 'ok' | 'warn' | 'danger' | 'neutral';

const STATUS: Record<string, { label: string; tone: Tone }> = {
  connected: { label: 'Connected', tone: 'ok' },
  degraded: { label: 'Connected with problems', tone: 'warn' },
  pending_review: { label: 'Waiting for review', tone: 'warn' },
  needs_partner_access: { label: 'Needs partner access', tone: 'warn' },
  not_configured: { label: 'Not connected', tone: 'neutral' },
  revoked: { label: 'Access revoked', tone: 'danger' },
  disconnected: { label: 'Disconnected', tone: 'neutral' },
};

export function statusLabel(c: Pick<Connection, 'status'>): { label: string; tone: Tone } {
  return STATUS[c.status] ?? { label: 'State unknown', tone: 'warn' };
}

export function adapterModeWords(m: AdapterMode): { tone: 'info' | 'warn'; text: string } | null {
  if (m === 'fake')
    return { tone: 'warn', text: 'This deployment uses test adapters for Meta, Google, Zillow, realtor.com, the showing service and personal calendars: those connections are simulated and reach no real account. The MLS card says what the MLS connection does.' };
  if (m === 'unconfigured') return { tone: 'warn', text: 'No platform apps are set up on this deployment yet, so services that need an outside login cannot be connected.' };
  return null;
}

/** b9 ui/F8: Google Ads lead forms are set up per source on Lead sources; the ads account is a later connection. */
export const GOOGLE_ADS_HINT = 'Google Ads lead forms work now: each lead source sets up its own on Lead sources. The Google Ads account itself is not connected, so nothing about your ads is read.';
/** b9 ui/F8: until a partner grants access, a portal's leads arrive by lead email, set up per source. */
export const PARTNER_FEED_HINT = "Until the partner grants access, set up lead email on the portal's lead source: the portal sends its new-lead emails there.";

/** Where a keyed or key-based service is set up (it has no outside login to connect here), or where its leads arrive meanwhile. */
export function manageLink(kind: string): { to: string; label: string; hint: string } | null {
  if (kind === 'web_chat_widget') return { to: WEBCHAT_PAGE_PATH, label: 'Set up website chat', hint: 'Create a widget, get its embed code and choose the websites it runs on.' };
  if (kind === 'lead_email') return { to: LEAD_SOURCES_PAGE_PATH, label: 'Open Lead sources', hint: 'Each lead source has its own lead-email address on its Lead sources page.' };
  if (kind === 'ads_google') return { to: LEAD_SOURCES_PAGE_PATH, label: 'Open Lead sources', hint: GOOGLE_ADS_HINT };
  if (kind === 'zillow_feed' || kind === 'realtor_feed') return { to: LEAD_SOURCES_PAGE_PATH, label: 'Open Lead sources', hint: PARTNER_FEED_HINT };
  if (kind === 'mls_feed') return { to: MLS_PAGE_PATH, label: 'Open MLS', hint: 'Sync status, the Spark key and the licence pack.' };
  return null;
}

/** The provider callback lands here with ?result=CODE (apps/api integrations oauthCallback). */
const RESULTS: Record<string, { tone: 'ok' | 'warn' | 'error'; text: string }> = {
  CONNECTED: { tone: 'ok', text: 'Connected. We checked that you manage the account.' },
  PENDING_REVIEW: { tone: 'warn', text: 'The account is reserved for your team, but the platform is still reviewing the connection. Nothing is sent or received yet.' },
  CANCELLED: { tone: 'warn', text: 'The connection was cancelled at the provider. Nothing was connected.' },
  STATE_INVALID: { tone: 'error', text: "That sign-in link wasn't valid, so nothing was connected." },
  STATE_EXPIRED: { tone: 'error', text: 'That sign-in took too long and expired, so nothing was connected.' },
  STATE_STALE: { tone: 'error', text: 'The connection changed while you were signing in, so nothing was connected.' },
  NOT_CONNECTABLE: { tone: 'error', text: "This connection can't be connected in its current state. Nothing was changed." },
  STARTER_NOT_AUTHORIZED: { tone: 'error', text: 'Only an Owner or Admin can finish a connection. Nothing was connected.' },
  PROVIDER_REFUSED: { tone: 'error', text: 'The provider refused the sign-in. Nothing was connected.' },
  ACCOUNT_NOT_MANAGED: { tone: 'error', text: "The login you used doesn't manage that account, so nothing was connected." },
  ACCOUNT_LIVE_ELSEWHERE: { tone: 'error', text: 'That account is already connected to another team, so it was not connected here.' },
};

export function callbackResultWords(code: string | null): { tone: 'ok' | 'warn' | 'error'; text: string } | null {
  if (!code) return null;
  return Object.hasOwn(RESULTS, code) ? RESULTS[code]! : { tone: 'warn', text: 'The connection attempt ended in a way this page cannot describe. Check the state below.' };
}

export const ERROR_MESSAGES: Record<string, string> = {
  CONNECTION_NOT_CONNECTABLE: 'This connection is already disconnected. Nothing was changed.',
};
