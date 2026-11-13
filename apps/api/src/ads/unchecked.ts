// Which Google Ads connections are "not checked" (module 52; R-ADS-13, E453, E454): the one rule the hourly
// reconcile's daily alert (mirror.ts) and GET /ads's uncheckedSentence (overview.ts) both read, so the page says what
// the alert says. Pure: stored facts only, no provider call.
//
// A connection counts when it is live (connected or degraded), or when it is revoked or disconnected and still has
// mirrored campaigns (they may still be spending), unless (b11 ads-5) a live connection of the tenant holds the same
// Google Ads account: module 21 cannot reconnect a disconnected row in place, so the Owner's reconnect is a new row,
// and that one reads the account every hour (and alerts on its own when it cannot). It is "not checked" when its
// last successful spend check (else its connect time) is UNCHECKED_ALERT_MS old, or its currency is not managed.
import type { AdsConnection } from './repo.js';
import { UNCHECKED_ALERT_MS } from './settings.js';

const isLive = (c: Pick<AdsConnection, 'status'>): boolean => c.status === 'connected' || c.status === 'degraded';

/** The connections whose spend has gone unchecked at `now`, in the order given. */
export function uncheckedConnections(conns: readonly AdsConnection[], campaigns: readonly { connectionId: string }[], now: number): AdsConnection[] {
  return conns.filter((c) => {
    if (!isLive(c)) {
      if (c.status !== 'revoked' && c.status !== 'disconnected') return false;
      if (!campaigns.some((x) => x.connectionId === c.id)) return false;
      if (c.externalAccountId !== null && conns.some((x) => x.id !== c.id && isLive(x) && x.externalAccountId === c.externalAccountId)) return false;
    }
    const since = c.lastSyncedAt ?? c.connectedAt;
    if (since === null) return false; // never connected: nothing was ever read or could spend through it
    return c.statusReason === 'ADS_CURRENCY_UNSUPPORTED' || now - Date.parse(since) >= UNCHECKED_ALERT_MS;
  });
}

/** "Google Ads spend has not been checked since <time>" (UTC, minutes; no account or campaign name). */
export function uncheckedText(sinceIso: string | null): { title: string; body: string } {
  const at = sinceIso ? `${sinceIso.slice(0, 16).replace('T', ' ')} UTC` : 'it was connected';
  return { title: `Google Ads spend has not been checked since ${at}`, body: 'Realty OS could not read Google Ads spend, so it cannot pause campaigns at your monthly cap. Check the Google Ads connection.' };
}
