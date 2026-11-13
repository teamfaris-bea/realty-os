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
//
// D9 (R-CMA-1; SECURITY NOTE, ARCHITECTURE §21.8b):
//   - The upsert also writes the sale and property facts, listings.address_key (core addressKey over the structured
//     RESO parts, computed here so core/listings never imports predict) and mls_normalize_version. The update
//     condition stays strictly-newer modification, so RETURNING's `TRUE AS changed` stays right with no pre-read.
//   - PER-RECORD SAVEPOINT (F3): each record's database work (the nurture pre-read, the upsert, the backfill fill)
//     runs under a SAVEPOINT. A data exception or an integrity violation (SQLSTATE classes 22 and 23) rolls back to it
//     and counts the record as skippedInvalid with MLS_RECORD_REFUSED_BY_DB (the code only, never the message); the
//     batch goes on. Every other error re-throws, so 40001 / 40P01 still retry the whole transaction (tenantTx).
//   - BACKFILL PASS (F14): rows stored before these facts existed (version 1) are filled by a separate pass. Each run
//     reads its incremental page first, unchanged; only when that page is not full and a backfill is pending does it
//     read one backfill page (records(mls_backfill_cursor, SYNC_BATCH), outside any transaction). The fenced write
//     also checks that mls_backfill_cursor is unchanged. A backfill record is written by a FILL-ONLY update: it never
//     inserts, sets only the new columns (and sqft with its size_source, R-MLS-7) of the row with the same connection,
//     MLS number and modification time whose version is older, so it writes no price history, is never fed to
//     saved-search matching (R-MLS-6: no alert for an old listing) or to nurture, and never moves sync_cursor or
//     last_synced_at (R-MLS-3: freshness is the incremental feed's). While a backfill is pending the next run is due
//     at once; a backfill page with `more` false ends it. A record modified since is left to the incremental read (its
//     modification no longer matches).
import { type FieldMapping, type Issue, type ListingFacts, type MlsConnectionId, NORMALIZE_VERSION, type ResoLike, addressKey, normalizeMlsListing, resoAddressParts } from '@realty/core/listings';
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
import { type ListingBefore, mlsListingBefore, mlsListingChangedInTx } from '../nurture/detect.js';
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
  /** records core could not normalize, the feed could not place on the cursor, or the database refused (MLS_RECORD_REFUSED_BY_DB) */
  skippedInvalid: number;
  matched: number;
  /** backfill: version-1 rows filled with the sale and property facts (never alerts, never price history) */
  filled: number;
  code: string | null;
}

/** SQLSTATE classes a per-record savepoint absorbs: data exceptions (22) and integrity violations (23). */
const RECORD_REFUSED_CLASSES = new Set(['22', '23']);

function sqlState(e: unknown): string | null {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code) ? code : null;
}

/**
 * Runs one record's database work under a savepoint (F3). Returns the work's value, or 'refused' when the database
 * refused the record with a data exception or an integrity violation; anything else re-throws.
 */
export async function underSavepoint<T>(tx: Tx, work: () => Promise<T>): Promise<T | 'refused'> {
  await sql`SAVEPOINT mls_record`.execute(tx);
  try {
    const v = await work();
    await sql`RELEASE SAVEPOINT mls_record`.execute(tx);
    return v;
  } catch (e) {
    const state = sqlState(e);
    if (state === null || !RECORD_REFUSED_CLASSES.has(state.slice(0, 2))) throw e;
    await sql`ROLLBACK TO SAVEPOINT mls_record`.execute(tx);
    await sql`RELEASE SAVEPOINT mls_record`.execute(tx);
    return 'refused';
  }
}

/** listings.address_key of a record (core addressKey over the structured RESO parts when present). */
export function addressKeyOf(f: ListingFacts, raw: ResoLike, mapping: FieldMapping): string | null {
  return addressKey({ line1: f.addressLine1, line2: f.addressLine2, city: f.city, region: f.region, postalCode: f.postalCode, parts: resoAddressParts(raw, mapping) });
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

type Claimed = { cursor: string | null; backfillPending: boolean; backfillCursor: string | null };

/** Step 1: lease a due connection; null when it is no longer due (another run claimed it) or not live. */
async function claim(tx: Tx, connectionId: string, now: Instant): Promise<Claimed | null> {
  const r = await sql<{ sync_cursor: string | null; mls_backfill_pending: boolean; mls_backfill_cursor: string | null }>`
    UPDATE integration_connections SET next_sync_at = ${iso(now + SYNC_LEASE_MS)}::timestamptz
     WHERE tenant_id = app.tenant_id() AND id = ${connectionId} AND kind = 'mls_feed' AND status IN ('connected','degraded')
       AND (next_sync_at IS NULL OR next_sync_at <= ${iso(now)}::timestamptz)
    RETURNING sync_cursor, mls_backfill_pending, mls_backfill_cursor`.execute(tx);
  const c = r.rows[0];
  return c ? { cursor: c.sync_cursor, backfillPending: c.mls_backfill_pending, backfillCursor: c.mls_backfill_cursor } : null;
}

/** The new columns' values for a record (the fill-only update and the upsert share them). */
function valuationParams(f: ListingFacts, key: string | null) {
  const v = f.valuation;
  return {
    close_price_cents: v.closePriceCents,
    close_date: v.closeDate,
    purchase_contract_date: v.contractDate,
    original_list_price_cents: v.originalListPriceCents,
    concessions_cents: v.concessionsCents,
    sale_conditions: [...v.saleConditions],
    days_on_market: v.daysOnMarket,
    latitude_e6: v.latitudeE6,
    longitude_e6: v.longitudeE6,
    year_built: v.yearBuilt,
    lot_sqft: v.lotSqft,
    subdivision_name: v.subdivisionName,
    garage_spaces_x10: v.garageSpacesX10,
    stories_x10: v.storiesX10,
    pool_private: v.poolPrivate,
    size_source: v.sizeSource,
    is_lease: v.isLease,
    avm_display_allowed: v.avmDisplayAllowed,
    address_key: key,
  };
}

/**
 * Backfill (F14): fills the new columns of the stored version-1 row with this record's connection, MLS number and
 * modification time. Never inserts, never alerts, never writes price history. The one existing column it writes is
 * sqft, together with size_source (R-MLS-7): a size is stored only with the field it was read from, so a version-1 size
 * read under an earlier mapping (Spark's read BuildingAreaTotal) is replaced by this read's, null when the current
 * mapping reads no size; for an unchanged mapping it is the same value. Returns whether a row was filled.
 */
export async function fillMlsListing(tx: Tx, f: ListingFacts, key: string | null): Promise<boolean> {
  const p = valuationParams(f, key);
  const r = await sql`
    UPDATE listings SET close_price_cents = ${p.close_price_cents}, close_date = ${p.close_date}::date, purchase_contract_date = ${p.purchase_contract_date}::date,
           original_list_price_cents = ${p.original_list_price_cents}, concessions_cents = ${p.concessions_cents}, sale_conditions = ${p.sale_conditions}::text[],
           days_on_market = ${p.days_on_market}, latitude_e6 = ${p.latitude_e6}, longitude_e6 = ${p.longitude_e6}, year_built = ${p.year_built},
           lot_sqft = ${p.lot_sqft}, subdivision_name = ${p.subdivision_name}, garage_spaces_x10 = ${p.garage_spaces_x10}, stories_x10 = ${p.stories_x10},
           pool_private = ${p.pool_private}, sqft = ${f.sqft}, size_source = ${p.size_source}, is_lease = ${p.is_lease}, avm_display_allowed = ${p.avm_display_allowed},
           address_key = ${p.address_key}, mls_normalize_version = ${NORMALIZE_VERSION}
     WHERE tenant_id = app.tenant_id() AND source = 'mls' AND mls_connection_id = ${f.mlsConnectionId} AND mls_number = ${f.mlsNumber}
       AND mls_modified_at = ${iso(f.mlsModifiedAt!)}::timestamptz AND mls_normalize_version < ${NORMALIZE_VERSION}`.execute(tx);
  return Number(r.numAffectedRows ?? 0) > 0;
}

type Upserted = { id: string; inserted: boolean; changed: boolean };

/** One normalized record → listings (system actor). Null: not newer than the stored row (E141) or another connection's number. */
export async function upsertMlsListing(tx: Tx, ids: AssistantDeps['ids'], f: ListingFacts, now: Instant, key: string | null = null): Promise<Upserted | null> {
  const id = ids.next<'ListingId'>();
  const p = valuationParams(f, key);
  const attributes = { mls: { listing_key: f.listingKey, address_display: f.addressDisplayAllowed, photo_urls: f.photoUrls.slice(0, 100), photos_count: f.photosCount } };
  const offMarket = f.status === 'sold' || f.status === 'withdrawn' || f.status === 'expired';
  const r = await sql<{ id: string; inserted: boolean; changed: boolean }>`
    INSERT INTO listings AS l (tenant_id, id, source, mls_number, status, address_line1, address_line2, city, region, postal_code, list_price_cents,
                               beds, baths_x10, sqft, property_type, description, list_date, attributes, mls_connection_id, mls_modified_at,
                               listing_brokerage_name, display_allowed, last_seen_in_feed_at, off_market_at, team_listing_id,
                               close_price_cents, close_date, purchase_contract_date, original_list_price_cents, concessions_cents, sale_conditions,
                               days_on_market, latitude_e6, longitude_e6, year_built, lot_sqft, subdivision_name, garage_spaces_x10, stories_x10,
                               pool_private, size_source, is_lease, avm_display_allowed, address_key, mls_normalize_version)
    VALUES (app.tenant_id(), ${id}, 'mls', ${f.mlsNumber}, ${f.status}, ${f.addressLine1}, ${f.addressLine2}, ${f.city}, ${f.region}, ${f.postalCode},
            ${f.listPriceCents}, ${f.beds}, ${f.bathsX10}, ${f.sqft}, ${f.propertyType}, ${f.description}, ${f.listDate}::date,
            ${JSON.stringify(attributes)}::jsonb, ${f.mlsConnectionId}, ${iso(f.mlsModifiedAt!)}::timestamptz, ${f.listingBrokerageName},
            ${f.displayAllowed}, ${iso(now)}::timestamptz, ${offMarket ? iso(now) : null}::timestamptz,
            (SELECT t.id FROM listings t WHERE t.tenant_id = app.tenant_id() AND t.source = 'team' AND t.mls_number = ${f.mlsNumber}),
            ${p.close_price_cents}, ${p.close_date}::date, ${p.purchase_contract_date}::date, ${p.original_list_price_cents}, ${p.concessions_cents},
            ${p.sale_conditions}::text[], ${p.days_on_market}, ${p.latitude_e6}, ${p.longitude_e6}, ${p.year_built}, ${p.lot_sqft}, ${p.subdivision_name},
            ${p.garage_spaces_x10}, ${p.stories_x10}, ${p.pool_private}, ${p.size_source}, ${p.is_lease}, ${p.avm_display_allowed}, ${p.address_key},
            ${NORMALIZE_VERSION})
    ON CONFLICT (tenant_id, source, mls_number) WHERE mls_number IS NOT NULL DO UPDATE SET
      status = EXCLUDED.status, address_line1 = EXCLUDED.address_line1, address_line2 = EXCLUDED.address_line2, city = EXCLUDED.city,
      region = EXCLUDED.region, postal_code = EXCLUDED.postal_code, list_price_cents = EXCLUDED.list_price_cents, beds = EXCLUDED.beds,
      baths_x10 = EXCLUDED.baths_x10, sqft = EXCLUDED.sqft, property_type = EXCLUDED.property_type, description = EXCLUDED.description,
      list_date = EXCLUDED.list_date, attributes = l.attributes || EXCLUDED.attributes, mls_modified_at = EXCLUDED.mls_modified_at,
      listing_brokerage_name = EXCLUDED.listing_brokerage_name, display_allowed = EXCLUDED.display_allowed,
      last_seen_in_feed_at = EXCLUDED.last_seen_in_feed_at,
      off_market_at = CASE WHEN EXCLUDED.off_market_at IS NULL THEN NULL ELSE COALESCE(l.off_market_at, EXCLUDED.off_market_at) END,
      team_listing_id = COALESCE(l.team_listing_id, EXCLUDED.team_listing_id),
      close_price_cents = EXCLUDED.close_price_cents, close_date = EXCLUDED.close_date, purchase_contract_date = EXCLUDED.purchase_contract_date,
      original_list_price_cents = EXCLUDED.original_list_price_cents, concessions_cents = EXCLUDED.concessions_cents,
      sale_conditions = EXCLUDED.sale_conditions, days_on_market = EXCLUDED.days_on_market, latitude_e6 = EXCLUDED.latitude_e6,
      longitude_e6 = EXCLUDED.longitude_e6, year_built = EXCLUDED.year_built, lot_sqft = EXCLUDED.lot_sqft, subdivision_name = EXCLUDED.subdivision_name,
      garage_spaces_x10 = EXCLUDED.garage_spaces_x10, stories_x10 = EXCLUDED.stories_x10, pool_private = EXCLUDED.pool_private,
      size_source = EXCLUDED.size_source, is_lease = EXCLUDED.is_lease, avm_display_allowed = EXCLUDED.avm_display_allowed,
      address_key = EXCLUDED.address_key, mls_normalize_version = EXCLUDED.mls_normalize_version
     WHERE l.mls_modified_at < EXCLUDED.mls_modified_at AND l.mls_connection_id = EXCLUDED.mls_connection_id
    RETURNING l.id, (xmax = 0) AS inserted, TRUE AS changed`.execute(tx);
  return r.rows[0] ?? null;
}

/** Runs one connection (steps 1-3). Every transaction is the tenant's system actor. */
export async function syncConnection(deps: MlsDeps, tenantId: TenantId, connectionId: string, log?: Logger): Promise<SyncResult> {
  const res: SyncResult = { connectionId, outcome: 'synced', inserted: 0, updated: 0, skippedStale: 0, skippedInvalid: 0, matched: 0, filled: 0, code: null };
  const sys = systemActor(tenantId, 'provider');
  const opts = { db: deps.db, retries: 2 };

  // 1. claim and open the feed
  const claimed = await withTenantTx(
    sys,
    async (tx, now) => {
      const c = await claim(tx, connectionId, now);
      if (!c) return null;
      const feed = deps.recordFeed ? deps.recordFeed(connectionId) : await openRecordFeed(sparkDepsOf(deps), tx, tenantId, connectionId, deps.providers.integrations);
      return { ...c, feed };
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

  // 2b. backfill (F14): one page, only after a not-full incremental page, outside any transaction. A failed backfill
  // read never fails the run (the incremental page is still written); it is tried again on the next run.
  let backfill: Awaited<ReturnType<MlsRecordFeed['records']>> | null = null;
  let backfillFailed = false;
  if (claimed.backfillPending && !page.more) {
    try {
      backfill = await claimed.feed.records(claimed.backfillCursor, SYNC_BATCH);
    } catch (e) {
      backfillFailed = true;
      log?.warn('mls.backfill read failed', { code: e instanceof SparkError ? e.code : 'UNREACHABLE' });
    }
  }

  // 3. write behind the cursor fence
  return withTenantTx(
    sys,
    async (tx, now) => {
      const row = await connections.getConnection(tx, connectionId, { forUpdate: true });
      const cur = await sql<{ sync_cursor: string | null; mls_backfill_pending: boolean; mls_backfill_cursor: string | null }>`
        SELECT sync_cursor, mls_backfill_pending, mls_backfill_cursor FROM integration_connections WHERE tenant_id = app.tenant_id() AND id = ${connectionId}`.execute(tx);
      const c0 = cur.rows[0];
      if (!row || !c0 || (row.status !== 'connected' && row.status !== 'degraded') || c0.sync_cursor !== claimed.cursor
          || (backfill !== null && (!c0.mls_backfill_pending || c0.mls_backfill_cursor !== claimed.backfillCursor))) {
        return { ...res, outcome: 'fenced' as const };
      }
      // a retried attempt (40001 / 40P01) starts its counts again: nothing of the rolled-back attempt is reported
      Object.assign(res, { inserted: 0, updated: 0, skippedStale: 0, skippedInvalid: 0, matched: 0, filled: 0 });
      const mapping: FieldMapping = { connectionId: connectionId as MlsConnectionId, fields: claimed.feed!.fields };
      res.skippedInvalid += page.unpositioned;
      const changed: string[] = [];
      const priorOf = new Map<string, ListingBefore>();
      const issueCodes = new Map<string, number>();
      for (const raw of page.records) {
        const f = normalizeMlsListing(raw, mapping);
        if (Array.isArray(f)) {
          res.skippedInvalid += 1;
          for (const i of f as Issue[]) issueCodes.set(i.code, (issueCodes.get(i.code) ?? 0) + 1);
          continue;
        }
        const key = addressKeyOf(f, raw, mapping);
        const done = await underSavepoint(tx, async () => {
          const before = await mlsListingBefore(tx, f.mlsNumber!, f.mlsConnectionId!); // module 26 (flagged): price/status before
          return { before, u: await upsertMlsListing(tx, deps.ids, f, now, key) };
        });
        if (done === 'refused') {
          res.skippedInvalid += 1;
          issueCodes.set('MLS_RECORD_REFUSED_BY_DB', (issueCodes.get('MLS_RECORD_REFUSED_BY_DB') ?? 0) + 1);
          continue;
        }
        const { before, u } = done;
        if (!u) {
          res.skippedStale += 1;
          continue;
        }
        if (u.inserted) res.inserted += 1;
        else res.updated += 1;
        changed.push(u.id);
        if (before && !u.inserted) priorOf.set(u.id, before);
      }
      // backfill (F14): fill-only, never inserted, never matched, never a nurture firing
      if (backfill !== null) {
        res.skippedInvalid += backfill.unpositioned;
        for (const raw of backfill.records) {
          const f = normalizeMlsListing(raw, mapping);
          if (Array.isArray(f)) {
            res.skippedInvalid += 1;
            for (const i of f as Issue[]) issueCodes.set(i.code, (issueCodes.get(i.code) ?? 0) + 1);
            continue;
          }
          const key = addressKeyOf(f, raw, mapping);
          const filled = await underSavepoint(tx, () => fillMlsListing(tx, f, key));
          if (filled === 'refused') {
            res.skippedInvalid += 1;
            issueCodes.set('MLS_RECORD_REFUSED_BY_DB', (issueCodes.get('MLS_RECORD_REFUSED_BY_DB') ?? 0) + 1);
          } else if (filled) res.filled += 1;
        }
        const ended = !backfill.more;
        await sql`
          UPDATE integration_connections SET mls_backfill_pending = ${!ended}, mls_backfill_cursor = ${ended ? null : backfill.cursor}
           WHERE tenant_id = app.tenant_id() AND id = ${connectionId}`.execute(tx);
      }
      // a failed backfill read waits for the normal interval (never a tight retry loop)
      const backfillStillPending = claimed.backfillPending && !backfillFailed && (backfill === null || backfill.more);
      // the connection: cursor, freshness, recovery, next run (at once after a full page or while a backfill is pending)
      await sql`
        UPDATE integration_connections SET sync_cursor = ${page.cursor}, last_synced_at = ${iso(now)}::timestamptz, last_error_code = NULL,
               next_sync_at = ${iso(page.more || backfillStillPending ? now : now + SYNC_INTERVAL_MS)}::timestamptz
         WHERE tenant_id = app.tenant_id() AND id = ${connectionId}`.execute(tx);
      if (row.status === 'degraded') {
        const next = transitionConnection(rowOf(row), { type: 'health_ok' });
        await sql`UPDATE integration_connections SET status = ${next.status}, status_reason = NULL WHERE tenant_id = app.tenant_id() AND id = ${connectionId}`.execute(tx);
        await audit(tx, sys, { action: 'integration.changed', entity: { type: 'integration_connection', id: connectionId }, changes: redactDiff({ status: row.status }, { status: next.status }), reason: 'MLS_SYNC_RECOVERED' });
      }
      // R-MLS-6: every new or changed MLS row goes through the Phase 1 saved-search path (deduped per match)
      for (const id of changed) res.matched += await matchListingInTx(tx, deps, tenantId, id, now);
      // module 26 (flagged): price drops and returns to market on followed homes become trigger firings (facts only)
      for (const [id, before] of priorOf) await mlsListingChangedInTx(tx, deps, id, before, now);
      await cancelIneligibleMlsAlertsInTx(tx, now);
      log?.info('mls.sync', { inserted: res.inserted, updated: res.updated, skippedStale: res.skippedStale, skippedInvalid: res.skippedInvalid, matched: res.matched, filled: res.filled, issues: Object.fromEntries(issueCodes) });
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
      // status, reason, code and capabilities through module 21's one writer (R-INT-3); then only the timer
      await connections.applyKeyValidation(tx, connectionId, { status: next.status, statusReason: next.statusReason, capabilities: next.capabilities, lastErrorCode: code, connected: false });
      await sql`UPDATE integration_connections SET next_sync_at = ${iso(now + SYNC_INTERVAL_MS)}::timestamptz WHERE tenant_id = app.tenant_id() AND id = ${connectionId}`.execute(tx);
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
