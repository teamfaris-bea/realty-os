// Feed staleness and modification order (R-MLS-3, E85; R-MLS-1 core side, E141).
//
// - R-MLS-3: when the feed's last sync is older than the pack's `max_staleness_hours`, saved-search
//   alerts on MLS rows, price-drop / back-on-market firings on MLS rows and competing sets pause, and
//   the UI says "MLS data as of …" (`staleNotice`). Exactly at the limit is still fresh. A feed that
//   never synced, or a pack without a limit, is stale (strictest). VERIFY WITH COUNSEL / MLS: the
//   limit itself (many IDX rules require refreshing at least every N hours).
// - R-MLS-1 / E141: an incoming modification replaces the stored row only when strictly newer. The
//   sync skips older and equal ones; the DB trigger `listings_mls_monotonic` raises
//   `MLS_STALE_UPDATE` for an older one that gets through.
import { DateTime } from 'luxon';
import { HOUR_MS, type IanaZone, type Instant } from '../foundation/index.js';
import type { LicensePack } from './types.js';

export function feedStale(lastSyncedAt: Instant | null, now: Instant, pack: LicensePack): boolean {
  if (lastSyncedAt === null || pack.maxStalenessHours === null) return true;
  return now - lastSyncedAt > pack.maxStalenessHours * HOUR_MS;
}

/** "MLS data as of Nov 8, 2026, 9:00 AM CST" in the given zone (en-US). */
export function staleNotice(lastSyncedAt: Instant | null, zone: IanaZone): string {
  if (lastSyncedAt === null) return 'MLS data not received yet';
  const t = DateTime.fromMillis(lastSyncedAt, { zone, locale: 'en-US' });
  return `MLS data as of ${t.toFormat('LLL d, yyyy, h:mm a ZZZZ')}`;
}

/** Whether `incoming` may replace `stored` (strictly newer). A first modification always may. */
export function isNewerModification(stored: Instant | null, incoming: Instant): boolean {
  return stored === null || incoming > stored;
}
