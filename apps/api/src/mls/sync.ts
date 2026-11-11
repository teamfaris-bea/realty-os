// mls.sync (PHASE2_3_PLAN §5.4 #24; R-MLS-1, R-MLS-5, R-MLS-6, R-OWN-27; E81, E141).
//
// Woken by its per-tenant reconcile handler (every 60 s) for each live mls_feed connection whose stored
// `next_sync_at` is due (NULL = never synced = due). One connection run, three steps:
//   1. CLAIM (system TX): the due row is leased by moving next_sync_at forward (a second worker's claim
//      finds it not due and skips it); the sync cursor is read and the record feed opened (the Spark key
//      is decrypted here by the system actor, R-INT-4).
//   2. READ (no transaction): up to SYNC_BATCH records after the cursor. Spark retries 429/5xx inside its
//      budget (finding 7); with MLS_LIVE_CALLS=false the adapter refuses before any request.
//   3. WRITE (system TX), behind the CURSOR FENCE: the connection row is locked and its sync_cursor must
//      still be the one read in step 1, else another run already wrote this range and nothing is written.
//      Each record is normalized by core (issues skip the record, codes only logged) and upserted by
//      (tenant, source 'mls', mls_number); the upsert updates only when the incoming modification is
//      strictly newer (E141; the DB trigger listings_mls_monotonic refuses an older one that got past it,
//      MLS_STALE_UPDATE). A row whose mls_number is a team listing's is linked (team_listing_id, E81; the
//      team row is authoritative and counted once). Every inserted or changed row is fed to the Phase 1
//      matchSavedSearches body (R-MLS-6: one sender), the cursor and last_synced_at advance, a degraded
//      connection recovers (health_ok), and alerts queued with MLS data that stopped being eligible are
//      canceled (E86).
// A failed read records its code (degraded; a rejected key is revoked) and the next attempt is the normal
// interval later. Nothing about a record but codes and counts is logged.
import { type FieldMapping, type Issue, type ListingFacts, type MlsConnectionId, normalizeMlsListing } from '@realty/core/listings';
import type { Instant, TenantId } from '@realty/core/foundation';
import { type Tx, withTenantTx } from '@realty/db';
import { sql } from 'kysely';
import { audit, redactDiff } from '../audit.js';
import { cancelIneligibleMlsAlertsInTx, matchListingInTx } from '../assistant/searches.js';
import type { AssistantDeps } from '../assistant/types.js';
import type { Config } from '../config.js';
import { ProviderError } from '../providers/types.js';
import { SparkError } from '../providers/integrations/spark.js';
import type { ConnectionRow } from '../integrations/status.js';
import { transitionConnection } from '../integrations/status.js';
import * as connections from '../integrations/repos/connections.js';
import { systemActor } from '../worker/systemActor.js';
import type { Logger } from '../worker/observability.js';
import { type MlsRecordFeed, openRecordFeed } from './feeds.js';
import type { SparkDeps } from './spark/service.js';

/** Records read per connection run (bounded work per job; a full batch schedules the next run at once). */
export const SYNC_BATCH = 500;
/** The normal interval between runs of one connection. VERIFY WITH MLS: the licence's refresh requirement. */
export const SYNC_INTERVAL_MS = 15 * 60_000;
/** How long a claim holds a connection (a crashed run is retried after it). */
export const SYNC_LEASE_MS = 5 * 60_000;

export interface MlsDeps extends AssistantDeps {
  mls: Config['mls'];
  /** test hook: the record feed for a connection instead of the configured adapter */
  recordFeed?: (connectionId: string) => MlsRecordFeed | null;
}

export interface SyncResult {
  connectionId: string;
  outcome: 'synced' | 'fenced' | 'failed' | 'no_feed';
  inserted: number;
  updated: number;
  /** E141: an incoming modification not newer than the stored one */
  skippedStale: number;
  /** records core could not normalize (or the feed could not place on the cursor) */
  skippedInvalid: number;
  matched: number;
  code: string | null;
}

const iso = (t: number) => new Date(t).toISOString();

function sparkDepsOf(d: MlsDeps): SparkDeps {
  return { db: d.db, envelope: d.envelope, ids: d.ids, mls: d.mls, adapters: d.providers.integrations, now: () => Date.now() };
}

function rowOf(r: connections.ConnectionDbRow): ConnectionRow {
  return { kind: r.kind, status: r.status, statusReason: r.status_reason, externalAccountId: r.external_account_id, credentialId: r.credential_id, capabilities: r.capabilities, connectedAt: r.connected_at?.toISOString() ?? null, disconnectedAt: r.disconnected_at?.toISOString() ?? null, lastErrorCode: r.last_error_code };
}

/** Live mls_feed connections of the tenant that are due now (oldest first). */
export async function dueConnections(tx: Tx, now: Instant, limit = 5): Promise<string[]> {
  const r = await sql<{ id: string }>`
    SELECT id FROM integration_connections
     WHERE tenant_id = app.tenant_id() AND kind = 'mls_feed' AND status IN ('connected','degraded')
       AND (next_sync_at IS NULL OR next_sync_at <= ${iso(now)}::timestamptz)
     ORDER BY next_sync_at NULLS FIRST, id LIMIT ${limit}`.execute(tx);
  return r.rows.map((x) => x.id);
}

/** Step 1: lease a due connection; null when it is no longer due (another run claimed it) or not live. */
async function claim(tx: Tx, connectionId: string, now: Instant): Promise<{ cursor: string | null } | null> {
  const r = await sql<{ sync_cursor: string | null }>`
    UPDATE integration_connections SET next_sync_at = ${iso(now + SYNC_LEASE_MS)}::timestamptz
     WHERE tenant_id = app.tenant_id() AND id = ${connectionId} AND kind = 'mls_feed' AND status IN ('connected','degraded')
       AND (next_sync_at IS NULL OR next_sync_at <= ${iso(now)}::timestamptz)
    RETURNING sync_cursor`.execute(tx);
  return r.rows[0] ? { cursor: r.rows[0].sync_cursor } : null;
}

type Upserted = { id: string; inserted: boolean; changed: boolean };

/** One normalized record → listings (system actor). Null: not newer than the stored row (E141) or another connection's number. */
export async function upsertMlsListing(tx: Tx, ids: AssistantDeps['ids'], f: ListingFacts, now: Instant): Promise<Upserted | null> {
  const id = ids.next<'ListingId'>();
  const attributes = { mls: { listing_key: f.listingKey, address_display: f.addressDisplayAllowed, photo_urls: f.photoUrls.slice(0, 100), photos_count: f.photosCount } };
  const offMarket = f.status === 'sold' || f.status === 'withdrawn' || f.status === 'expired';
  const r = await sql<{ id: string; inserted: boolean; changed: boolean }>`
    INSERT INTO listings AS l (tenant_id, id, source, mls_number, status, address_line1, address_line2, city, region, postal_code, list_price_cents,
                               beds, baths_x10, sqft, property_type, description, list_date, attributes, mls_connection_id, mls_modified_at,
                               listing_brokerage_name, display_allowed, last_seen_in_feed_at, off_market_at, team_listing_id)
    VALUES (app.tenant_id(), ${id}, 'mls', ${f.mlsNumber}, ${f.status}, ${f.addressLine1}, ${f.addressLine2}, ${f.city}, ${f.region}, ${f.postalCode},
            ${f.listPriceCents}, ${f.beds}, ${f.bathsX10}, ${f.sqft}, ${f.propertyType}, ${f.description}, ${f.listDate}::date,
            ${JSON.stringify(attributes)}::jsonb, ${f.mlsConnectionId}, ${iso(f.mlsModifiedAt!)}::timestamptz, ${f.listingBrokerageName},
            ${f.displayAllowed}, ${iso(now)}::timestamptz, ${offMarket ? iso(now) : null}::timestamptz,
            (SELECT t.id FROM listings t WHERE t.tenant_id = app.tenant_id() AND t.source = 'team' AND t.mls_number = ${f.mlsNumber}))
    ON CONFLICT (tenant_id, source, mls_number) WHERE mls_number IS NOT NULL DO UPDATE SET
      status = EXCLUDED.status, address_line1 = EXCLUDED.address_line1, address_line2 = EXCLUDED.address_line2, city = EXCLUDED.city,
      region = EXCLUDED.region, postal_code = EXCLUDED.postal_code, list_price_cents = EXCLUDED.list_price_cents, beds = EXCLUDED.beds,
      baths_x10 = EXCLUDED.baths_x10, sqft = EXCLUDED.sqft, property_type = EXCLUDED.property_type, description = EXCLUDED.description,
      list_date = EXCLUDED.list_date, attributes = l.attributes || EXCLUDED.attributes, mls_modified_at = EXCLUDED.mls_modified_at,
      listing_brokerage_name = EXCLUDED.listing_brokerage_name, display_allowed = EXCLUDED.display_allowed,
      last_seen_in_feed_at = EXCLUDED.last_seen_in_feed_at,
      off_market_at = CASE WHEN EXCLUDED.off_market_at IS NULL THEN NULL ELSE COALESCE(l.off_market_at, EXCLUDED.off_market_at) END,
      team_listing_id = COALESCE(l.team_listing_id, EXCLUDED.team_listing_id)
     WHERE l.mls_modified_at < EXCLUDED.mls_modified_at AND l.mls_connection_id = EXCLUDED.mls_connection_id
    RETURNING l.id, (xmax = 0) AS inserted, TRUE AS changed`.execute(tx);
  return r.rows[0] ?? null;
}

/** Runs one connection (steps 1-3). Every transaction is the tenant's system actor. */
export async function syncConnection(deps: MlsDeps, tenantId: TenantId, connectionId: string, log?: Logger): Promise<SyncResult> {
  const res: SyncResult = { connectionId, outcome: 'synced', inserted: 0, updated: 0, skippedStale: 0, skippedInvalid: 0, matched: 0, code: null };
  const sys = systemActor(tenantId, 'provider');
  const opts = { db: deps.db, retries: 2 };

  // 1. claim and open the feed
  const claimed = await withTenantTx(
    sys,
    async (tx, now) => {
      const c = await claim(tx, connectionId, now);
      if (!c) return null;
      const feed = deps.recordFeed ? deps.recordFeed(connectionId) : await openRecordFeed(sparkDepsOf(deps), tx, tenantId, connectionId, deps.providers.integrations);
      return { cursor: c.cursor, feed };
    },
    opts,
  );
  if (!claimed) return { ...res, outcome: 'fenced' };
  if (!claimed.feed) return { ...res, outcome: 'no_feed' };

  // 2. read, outside any transaction
  let page: Awaited<ReturnType<MlsRecordFeed['records']>>;
  try {
    page = await claimed.feed.records(claimed.cursor, SYNC_BATCH);
  } catch (e) {
    const code = e instanceof SparkError ? e.code : e instanceof ProviderError && /^[A-Z][A-Z0-9_]*$/.test(e.message) ? e.message : 'UNREACHABLE';
    await recordFailure(deps, tenantId, connectionId, code);
    log?.warn('mls.sync failed', { code });
    return { ...res, outcome: 'failed', code };
  }

  // 3. write behind the cursor fence
  return withTenantTx(
    sys,
    async (tx, now) => {
      const row = await connections.getConnection(tx, connectionId, { forUpdate: true });
      const cur = await sql<{ sync_cursor: string | null }>`SELECT sync_cursor FROM integration_connections WHERE tenant_id = app.tenant_id() AND id = ${connectionId}`.execute(tx);
      if (!row || (row.status !== 'connected' && row.status !== 'degraded') || (cur.rows[0]?.sync_cursor ?? null) !== claimed.cursor) {
        return { ...res, outcome: 'fenced' as const };
      }
      const mapping: FieldMapping = { connectionId: connectionId as MlsConnectionId, fields: claimed.feed!.fields };
      res.skippedInvalid += page.unpositioned;
      const changed: string[] = [];
      const issueCodes = new Map<string, number>();
      for (const raw of page.records) {
        const f = normalizeMlsListing(raw, mapping);
        if (Array.isArray(f)) {
          res.skippedInvalid += 1;
          for (const i of f as Issue[]) issueCodes.set(i.code, (issueCodes.get(i.code) ?? 0) + 1);
          continue;
        }
        const u = await upsertMlsListing(tx, deps.ids, f, now);
        if (!u) {
          res.skippedStale += 1;
          continue;
        }
        if (u.inserted) res.inserted += 1;
        else res.updated += 1;
        changed.push(u.id);
      }
      // the connection: cursor, freshness, recovery, next run
      await sql`
        UPDATE integration_connections SET sync_cursor = ${page.cursor}, last_synced_at = ${iso(now)}::timestamptz, last_error_code = NULL,
               next_sync_at = ${iso(page.more ? now : now + SYNC_INTERVAL_MS)}::timestamptz
         WHERE tenant_id = app.tenant_id() AND id = ${connectionId}`.execute(tx);
      if (row.status === 'degraded') {
        const next = transitionConnection(rowOf(row), { type: 'health_ok' });
        await sql`UPDATE integration_connections SET status = ${next.status}, status_reason = NULL WHERE tenant_id = app.tenant_id() AND id = ${connectionId}`.execute(tx);
        await audit(tx, sys, { action: 'integration.changed', entity: { type: 'integration_connection', id: connectionId }, changes: redactDiff({ status: row.status }, { status: next.status }), reason: 'MLS_SYNC_RECOVERED' });
      }
      // R-MLS-6: every new or changed MLS row goes through the Phase 1 saved-search path (deduped per match)
      for (const id of changed) res.matched += await matchListingInTx(tx, deps, tenantId, id, now);
      await cancelIneligibleMlsAlertsInTx(tx, now);
      log?.info('mls.sync', { inserted: res.inserted, updated: res.updated, skippedStale: res.skippedStale, skippedInvalid: res.skippedInvalid, matched: res.matched, issues: Object.fromEntries(issueCodes) });
      return res;
    },
    opts,
  );
}

/** A failed read: degraded (a rejected key revoked), code recorded, next attempt one interval later. */
async function recordFailure(deps: MlsDeps, tenantId: TenantId, connectionId: string, code: string): Promise<void> {
  const sys = systemActor(tenantId, 'provider');
  await withTenantTx(
    sys,
    async (tx, now) => {
      const row = await connections.getConnection(tx, connectionId, { forUpdate: true });
      if (!row || (row.status !== 'connected' && row.status !== 'degraded')) return;
      const before = rowOf(row);
      const next = code === 'INVALID_CREDENTIALS' ? transitionConnection(before, { type: 'key_rejected', code, revoke: true }) : row.status === 'degraded' ? { ...before, statusReason: code, lastErrorCode: code } : transitionConnection(before, { type: 'health_degraded', code });
      await sql`
        UPDATE integration_connections SET status = ${next.status}, status_reason = ${next.statusReason}, last_error_code = ${code},
               capabilities = ${JSON.stringify(next.capabilities)}::jsonb, next_sync_at = ${iso(now + SYNC_INTERVAL_MS)}::timestamptz
         WHERE tenant_id = app.tenant_id() AND id = ${connectionId}`.execute(tx);
      if (next.status !== row.status) {
        await audit(tx, sys, { action: 'integration.changed', entity: { type: 'integration_connection', id: connectionId }, changes: redactDiff({ status: row.status }, { status: next.status }), reason: code });
      }
      // R-MLS-3: if the feed is now stale, queued alerts with its data are canceled
      await cancelIneligibleMlsAlertsInTx(tx, now);
    },
    { db: deps.db, retries: 2 },
  );
}

/** The reconcile pass of one tenant: every due connection, one run each. */
export async function syncDueConnections(deps: MlsDeps, tenantId: TenantId, log?: Logger): Promise<SyncResult[]> {
  const ids = await withTenantTx(systemActor(tenantId, 'provider'), (tx, now) => dueConnections(tx, now), { db: deps.db, retries: 2 });
  const out: SyncResult[] = [];
  for (const id of ids) out.push(await syncConnection(deps, tenantId, id, log));
  return out;
}
