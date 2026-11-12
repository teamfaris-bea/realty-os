// Pure words for the Lead sources surface: every fact the page shows is said here from what the overview reports,
// never guessed. No clock is read here; callers pass `now` (ms). Nothing returns a code: kinds, states and inquiry
// types are words.
import { formatStamp, plural } from '../admin/lib/format.js';
import type { InquiryType, PathState, SourceOverview } from './types.js';

export const KINDS = [
  { value: 'portal', label: 'Portal' },
  { value: 'website', label: 'Website' },
  { value: 'ads', label: 'Ads' },
  { value: 'sign_call', label: 'Sign or ad calls' },
  { value: 'referral', label: 'Referral' },
  { value: 'sphere', label: 'Sphere (people you know)' },
  { value: 'open_house', label: 'Open house' },
  { value: 'manual', label: 'Typed in or imported' },
  { value: 'other', label: 'Other' },
] as const;
export type Kind = (typeof KINDS)[number]['value'];

export function kindWords(kind: string): string {
  return KINDS.find((k) => k.value === kind)?.label ?? 'Other';
}

export const INQUIRY_TYPES: readonly { value: InquiryType; label: string }[] = [
  { value: 'buy', label: 'Buying' },
  { value: 'sell', label: 'Selling' },
  { value: 'rent', label: 'Renting' },
  { value: 'value', label: 'Home value' },
  { value: 'general', label: 'General' },
];

export function inquiryWords(t: string | null | undefined): string {
  return INQUIRY_TYPES.find((x) => x.value === t)?.label ?? 'General';
}

/** "just now", "1 minute ago", "2 hours ago", "3 days ago" (future instants read "just now"). */
export function ago(iso: string, now: number): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 'at an unknown time';
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${plural(m, 'minute')} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${plural(h, 'hour')} ago`;
  return `${plural(Math.floor(h / 24), 'day')} ago`;
}

/** The one status sentence of a source, from the overview's facts only. */
export function statusSentence(s: Pick<SourceOverview, 'active' | 'offSince' | 'lastLeadAt' | 'leadsLast30Days'>, now: number): string {
  if (!s.active) return `Off since ${s.offSince ? formatStamp(s.offSince) : 'it was turned off'}: leads sent to it are not received`;
  if (!s.lastLeadAt) return 'No leads yet';
  return `Last lead ${ago(s.lastLeadAt, now)} · ${s.leadsLast30Days} in the last 30 days`;
}

/** "2 emails wait in Needs review", "1 forwarding confirmation waits in Needs review", or both; null when none. */
export function waitingSentence(s: Pick<SourceOverview, 'heldEmails' | 'forwardingConfirmations'>): string | null {
  const parts: string[] = [];
  if (s.heldEmails > 0) parts.push(`${plural(s.heldEmails, 'email')} ${s.heldEmails === 1 ? 'waits' : 'wait'}`);
  if (s.forwardingConfirmations > 0) parts.push(`${plural(s.forwardingConfirmations, 'forwarding confirmation')} ${s.forwardingConfirmations === 1 ? 'waits' : 'wait'}`);
  if (parts.length === 0) return null;
  return `${parts.join(' and ')} in Needs review`;
}

export type ChipState = 'On' | 'Off' | 'Not set up' | 'Not available on this deployment' | 'Needs partner access';
export interface PathChip {
  path: PathKey;
  label: string;
  state: ChipState;
}
export type PathKey = 'email' | 'google' | 'phone' | 'webhook' | 'partner' | 'chat' | 'typed' | 'forward';

function stateOf(on: boolean, active: boolean, available = true): ChipState {
  if (!available) return 'Not available on this deployment';
  if (!on) return 'Not set up';
  return active ? 'On' : 'Off';
}

const asState = (s: PathState) => ({ on: s === 'on', available: s !== 'not_available' });

/** The path chips of a source card: the four everyday paths always, partner feeds and chats only where they exist. */
export function pathChips(s: SourceOverview): PathChip[] {
  const e = asState(s.paths.email.state);
  const g = asState(s.paths.googleLeadForm.state);
  const chips: PathChip[] = [
    { path: 'email', label: 'Lead email', state: stateOf(e.on, s.active, e.available) },
    { path: 'google', label: 'Google Ads lead form', state: stateOf(g.on, s.active, g.available) },
    { path: 'phone', label: 'Tracking number', state: stateOf(s.paths.trackingNumbers.length > 0, s.active) },
    { path: 'webhook', label: 'Webhook', state: stateOf(s.paths.webhook.ownSecret, s.active) },
  ];
  // a partner feed is never said to be connected: it needs the partner's access first
  if (s.paths.partnerFeeds.length > 0) chips.push({ path: 'partner', label: 'Partner feed', state: 'Needs partner access' });
  if (s.paths.webChats.length > 0) chips.push({ path: 'chat', label: 'Website chat', state: stateOf(s.paths.webChats.some((c) => c.status === 'connected'), s.active) });
  return chips;
}

export function chipTone(state: ChipState): 'ok' | 'warn' | 'neutral' {
  return state === 'On' ? 'ok' : state === 'Off' || state === 'Needs partner access' ? 'warn' : 'neutral';
}

/**
 * Every path that stops when the source is turned off, in the server's words (apps/api/src/leads/sources.ts
 * pathWords), from the overview facts.
 */
export function stoppingPaths(s: SourceOverview): string[] {
  const out: string[] = [];
  if (s.paths.email.state === 'on') out.push('Lead emails sent to its address');
  if (s.paths.webhook.hasToken) out.push('Leads your website or system posts to its webhook address');
  if (s.paths.googleLeadForm.state === 'on') out.push('Google Ads lead form leads');
  const n = s.paths.trackingNumbers.length;
  if (n > 0) out.push(n === 1 ? 'New callers and texters on its tracking number (calls still ring, as unknown callers)' : `New callers and texters on its ${n} tracking numbers (calls still ring, as unknown callers)`);
  if (s.paths.partnerFeeds.length > 0) out.push('Partner feed leads');
  if (s.paths.webChats.length > 0) out.push('Website chat');
  return out;
}

export const OFF_SENTENCE =
  "What is sent to it while it's off is not received. Google does not resend; its leads stay downloadable in Google Ads for 30 days. Tracked calls still ring, as unknown callers. Website chat stops.";

export const TRACKING_SENTENCE =
  "New callers and texters become leads credited to this source and are offered by its routing rule. The call itself still rings the team's on-duty person (the first catch-all rule), who may not be the person the lead is offered to. People you already know are threaded as before; someone in a pond or unassigned is routed like a returning lead. Recording is unchanged. Texting back from this number needs its registration.";

/** apps/api/src/leadEmail/trust.ts READABLE_FORMATS_SENTENCE */
export const READABLE_FORMATS_SENTENCE = "We read emails that label the name, email and phone. If a portal's emails wait in Needs review, send us one so we can read that portal.";

export const GOOGLE_NOT_AVAILABLE = "This deployment has no public https address, so Google can't reach it.";
export const GOOGLE_TEST_UNRELIABLE = "Google's test button may not reach us. A real lead from your own form is the check.";

export function googleTestLine(lastTestAt: string | null): string {
  return lastTestAt ? `Test lead received ${formatStamp(lastTestAt)} (no one was added)` : GOOGLE_TEST_UNRELIABLE;
}

export function googleUnreadableLine(count: number, lastAt: string | null): string | null {
  if (count <= 0) return null;
  return `Google sent ${plural(count, 'lead')} we couldn't read${lastAt ? ` (last ${formatStamp(lastAt)})` : ''}: download them from Google Ads`;
}

// ---- portals ---------------------------------------------------------------------------------------------------

export type PortalId = 'zillow' | 'realtor' | 'redfin' | 'homes' | 'trulia' | 'opcity';
export interface CatalogEntry {
  portal: PortalId;
  domain: string;
  label: string;
  preTicked: boolean;
}

/**
 * A copy of apps/api/src/leadEmail/trust.ts PORTAL_CATALOG for the agent-forwarding guide, which picks portals
 * before the source (and so its inbox, whose response carries the catalog) exists. Once the inbox is on, the
 * server's catalog is the one shown. VERIFY with each portal which domain signs its lead emails.
 */
export const PORTAL_CATALOG: readonly CatalogEntry[] = [
  { portal: 'zillow', domain: 'zillow.com', label: 'Zillow', preTicked: true }, // VERIFY
  { portal: 'realtor', domain: 'realtor.com', label: 'Realtor.com', preTicked: true }, // VERIFY
  { portal: 'redfin', domain: 'redfin.com', label: 'Redfin', preTicked: false }, // VERIFY
  { portal: 'homes', domain: 'homes.com', label: 'Homes.com', preTicked: false }, // VERIFY
  { portal: 'homes', domain: 'homesnap.com', label: 'Homes.com', preTicked: false }, // VERIFY
  { portal: 'trulia', domain: 'trulia.com', label: 'Trulia', preTicked: false }, // VERIFY
  { portal: 'opcity', domain: 'opcity.com', label: 'Opcity', preTicked: false }, // VERIFY
];

/** One row per portal (Homes.com has two domains). */
export function portalsOf(catalog: readonly CatalogEntry[]): { portal: PortalId; label: string; domains: string[]; preTicked: boolean }[] {
  const out: { portal: PortalId; label: string; domains: string[]; preTicked: boolean }[] = [];
  for (const c of catalog) {
    const row = out.find((r) => r.portal === c.portal);
    if (row) row.domains.push(c.domain);
    else out.push({ portal: c.portal, label: c.label, domains: [c.domain], preTicked: c.preTicked });
  }
  return out;
}

/**
 * Where this address goes in each portal. VERIFY each portal's menu names against the portal itself before relying
 * on them; they change without notice. The generic line is used for every portal we have no specific steps for.
 */
export function portalStep(portal: PortalId, label: string): string {
  switch (portal) {
    case 'homes':
      // VERIFY: Homes.com's CRM lead-parsing setting (Account Settings → Lead Management → Lead Parsing Email for CRM)
      return 'Homes.com: Account Settings → Lead Management → Lead Parsing Email for CRM, and enter this address.';
    case 'opcity':
      // VERIFY: Opcity sends its lead emails to the account's main email address
      return "Opcity: set Opcity's main email to this address.";
    default:
      // VERIFY: Zillow, Realtor.com, Redfin and Trulia each have a lead-notification (or CC) email setting
      return `${label}: put this address in the lead-notification or CC field. If there is none, add this address where ${label} sends new-lead emails.`;
  }
}

export const BEST_STEP = "Best: put this address in each portal's lead-notification or CC field, so the portal sends its own email straight here.";
export const HAND_FORWARD_LINE = 'Leads forwarded by hand wait for review.';

/** The Gmail filter's From line: the selected domains joined by OR. */
export function gmailFrom(domains: readonly string[]): string {
  return domains.join(' OR ');
}

/** The agent's steps, in order (agent forwarding, step 4). */
export function agentSteps(address: string, portals: { portal: PortalId; label: string }[], domains: readonly string[]): { title: string; lines: string[] }[] {
  return [
    { title: 'Best: send it from the portal', lines: [BEST_STEP, ...portals.map((p) => portalStep(p.portal, p.label))] },
    {
      title: 'Gmail',
      lines: [
        `Settings → Forwarding → Add a forwarding address: ${address}.`,
        'Gmail emails a code to this address; your Owner, Admin or Team Lead sees it in Needs review, so ask them for it.',
        `Then make a filter From: ${gmailFrom(domains)} → Forward it to ${address}.`,
      ],
    },
    {
      title: 'Outlook or Microsoft 365',
      lines: [`Make a rule with "Redirect to" ${address}, not "Forward to" (Forward makes the email look like it came from you).`, 'Your mail admin may block it.'],
    },
    { title: 'One at a time', lines: ['Forwarding one at a time works, but each one waits for review.'] },
  ];
}

// ---- adding a source -------------------------------------------------------------------------------------------

export interface Arrival {
  value: PathKey;
  label: string;
  kind: Kind;
  hint?: string;
}

/** "How do leads arrive?" Each choice defaults the kind (which can be changed) and opens that path's setup. */
export const ARRIVALS: readonly Arrival[] = [
  { value: 'email', label: 'Portal or website emails', kind: 'portal' },
  { value: 'google', label: 'Google Ads lead form', kind: 'ads' },
  { value: 'phone', label: 'A tracking phone number', kind: 'sign_call' },
  { value: 'webhook', label: 'A website or system that posts leads', kind: 'website', hint: 'For developers' },
  { value: 'partner', label: 'A Zillow or Realtor.com partner feed', kind: 'portal', hint: 'Needs partner access from them' },
  { value: 'chat', label: 'A chat on your website', kind: 'website' },
  { value: 'forward', label: "An agent's forwarded email", kind: 'portal', hint: 'A guided setup for one agent' },
  { value: 'typed', label: 'Typed in or imported', kind: 'manual' },
];

export const PAGES = {
  needsReview: '/team/lead-email',
  integrations: '/admin/integrations',
  webChat: '/admin/web-chat',
  addPerson: '/people/new',
  imports: '/imports',
  numbers: '/admin/numbers',
  routing: '/admin/routing',
} as const;

export const detailPath = (id: string, setup?: PathKey) => `/admin/lead-sources/${id}${setup ? `?setup=${setup}` : ''}`;
