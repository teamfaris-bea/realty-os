// Plain words for the System page: stored statuses and kinds said as sentences a team admin reads.
// Pure functions (no clock): the page passes what the API sent.
import { plural } from '../lib/format.js';
import type { SystemOverview } from './types.js';

export type Tone = 'neutral' | 'ok' | 'warn' | 'danger';

const CHANNELS: Record<string, string> = {
  sms: 'Text messages',
  mms: 'Picture messages',
  email: 'Email',
  voice: 'Calls',
};

export function channelWords(channel: string): string {
  return CHANNELS[channel] ?? 'Other messages';
}

export function stuckStatusWords(status: string): string {
  return status === 'dispatching' ? 'Sending, not confirmed yet' : 'Not known yet whether it left';
}

const CONNECTION_KINDS: Record<string, string> = {
  messenger_page: 'Facebook Messenger page',
  instagram_account: 'Instagram account',
  web_chat_widget: 'Website chat',
  lead_email: 'Lead email inbox',
  zillow_feed: 'Zillow leads',
  realtor_feed: 'Realtor.com leads',
  meta_lead_ads: 'Meta lead ads',
  mls_feed: 'MLS feed',
  showing_service: 'Showing service',
  ads_meta: 'Meta ads',
  ads_google: 'Google ads',
  gbp_location: 'Google Business Profile',
};

export function connectionKindWords(kind: string): string {
  return CONNECTION_KINDS[kind] ?? 'Integration';
}

export function connectionStatusWords(status: string): { text: string; tone: Tone } {
  switch (status) {
    case 'connected':
      return { text: 'Connected', tone: 'ok' };
    case 'degraded':
      return { text: 'Connected, but having problems', tone: 'warn' };
    case 'pending_review':
      return { text: 'Waiting for the provider to review it', tone: 'warn' };
    case 'needs_partner_access':
      return { text: 'Waiting for partner access', tone: 'warn' };
    case 'revoked':
      return { text: 'Access was taken away at the provider', tone: 'danger' };
    case 'disconnected':
      return { text: 'Disconnected', tone: 'neutral' };
    default:
      return { text: 'Status not known', tone: 'neutral' };
  }
}

export function registrationKindWords(kind: string): string {
  return kind === 'toll_free_verification' ? 'Toll-free number verification' : 'Local numbers (A2P 10DLC campaign)';
}

/** The one-line summary at the top. "All clear" only when nothing at all needs a look. */
export function summaryWords(o: SystemOverview): { text: string; clear: boolean } {
  const parts: string[] = [];
  if (o.jobs.counts.dead > 0) parts.push(`${plural(o.jobs.counts.dead, 'job')} stopped retrying`);
  if (o.jobs.counts.retrying > 0) parts.push(`${plural(o.jobs.counts.retrying, 'job')} waiting to try again`);
  if (o.messages.length > 0) parts.push(`${plural(o.messages.length, 'message')} stuck while sending`);
  if (o.timers.lateCount > 0) parts.push(`${plural(o.timers.lateCount, 'timer')} fired late`);
  if (parts.length === 0) return { text: 'All clear: no jobs need attention, no messages are stuck and no timers fired late.', clear: true };
  const list = parts.length === 1 ? parts[0]! : `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]!}`;
  return { text: `Needs a look: ${list}.`, clear: false };
}
