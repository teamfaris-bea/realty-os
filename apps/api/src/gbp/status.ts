// GET /gbp/status in words (module 53; R-GBP-3, R-INT-2): why Google Business Profile is off, or when each location's
// reviews were last read. Pure over what the repository and the adapter report; nothing claims to work when it does not.
import type { LocationRow, PackState } from './repos/gbp.js';

export type GbpState = 'not_cleared' | 'not_set_up' | 'not_connected' | 'connected';

export interface GbpLocationStatus {
  connectionId: string;
  displayName: string;
  sentence: string;
}

export interface GbpStatus {
  state: GbpState;
  sentence: string;
  locations: GbpLocationStatus[];
}

const when = (d: Date, zone: string) =>
  new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: zone }).format(d);

export function notClearedSentence(version: string | null): string {
  return `Google Business Profile stays off until counsel reviews it (pack platform:gbp ${version ?? 'not installed'}). Nothing is read from or posted to Google.`;
}

export function locationSentence(l: Pick<LocationRow, 'last_synced_at' | 'last_error_code'>, zone: string): string {
  if (l.last_error_code) return `Last check failed (${l.last_error_code}); we will try again.`;
  if (l.last_synced_at) return `Reviews last checked ${when(l.last_synced_at, zone)}`;
  return 'Not checked yet';
}

export function gbpStatus(pack: PackState, adapter: { configured: boolean; statusText: string } | undefined, locations: readonly LocationRow[], zone: string): GbpStatus {
  if (!pack.cleared) return { state: 'not_cleared', sentence: notClearedSentence(pack.version), locations: [] };
  if (!adapter?.configured) return { state: 'not_set_up', sentence: `${adapter?.statusText ?? 'Google Business Profile is not set up on this platform yet'}. Export posts and copy them to your Business Profile yourself.`, locations: [] };
  const live = locations.filter((l) => l.status === 'connected' || l.status === 'degraded');
  if (live.length === 0) return { state: 'not_connected', sentence: 'No Business Profile location is connected.', locations: [] };
  return {
    state: 'connected',
    sentence: live.length === 1 ? 'One Business Profile location is connected.' : `${live.length} Business Profile locations are connected.`,
    locations: live.map((l) => ({ connectionId: l.id, displayName: l.display_name, sentence: locationSentence(l, zone) })),
  };
}
