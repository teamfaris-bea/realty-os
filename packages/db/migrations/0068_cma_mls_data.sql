-- D9 lane V1-A (modules 23/24): indexes for MLS sold data and the one-time backfill flag. Placeholder number: the
-- orchestrator renumbers it at merge, after the CMA S0 migration; nothing in code or tests names this file. It ships
-- with lane V1-A's sync code, never alone (the backfill flag needs the backfill pass).
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4): indexes and one data UPDATE only. No table, column, policy, grant, trigger
-- or function is added or changed.
--
-- 1. Comparable-sale candidates (apps/api/src/mls/comps.ts soldCandidates). Each tier query reads
--      source = 'mls' AND status = 'sold' AND NOT is_lease AND close_date IS NOT NULL AND close_date BETWEEN …
--    ORDER BY close_date DESC, id LIMIT n, with one plain-column equality per postal code, subdivision spelling,
--    city spelling or geo cell. Plain int4 / text / date comparisons only: they are leakproof on PG16, so under
--    FORCE RLS they stay index conditions (the 0039 and 0042 headers). The partial predicate drops leases, unsold
--    rows and rows not yet filled by the backfill (close_date NULL sorts first under DESC and would fill every limit).
CREATE INDEX listings_mls_sold_postal_idx ON listings (tenant_id, postal_code, close_date DESC)
  WHERE source = 'mls' AND status = 'sold' AND NOT is_lease AND close_date IS NOT NULL;
CREATE INDEX listings_mls_sold_subdivision_idx ON listings (tenant_id, subdivision_name, close_date DESC)
  WHERE source = 'mls' AND status = 'sold' AND NOT is_lease AND close_date IS NOT NULL AND subdivision_name IS NOT NULL;
CREATE INDEX listings_mls_sold_cell_idx ON listings (tenant_id, geo_cell, close_date DESC)
  WHERE source = 'mls' AND status = 'sold' AND NOT is_lease AND close_date IS NOT NULL AND geo_cell IS NOT NULL;
CREATE INDEX listings_mls_sold_city_idx ON listings (tenant_id, city, region, close_date DESC)
  WHERE source = 'mls' AND status = 'sold' AND NOT is_lease AND close_date IS NOT NULL;
-- the subject's own sale history and live listings at one address (comps.ts mlsRowsAtAddress, any status)
CREATE INDEX listings_mls_address_key_idx ON listings (tenant_id, address_key)
  WHERE source = 'mls' AND address_key IS NOT NULL;

-- 2. The backfill (F14): rows stored before the sale facts existed (mls_normalize_version 1) are re-read once by a
--    separate fill-only pass (sync.ts), after each run's incremental page. sync_cursor is never touched. Runs as the
--    migration owner (the table owner), which S0's integration_connections_backfill_guard lets through; no
--    application path can.
UPDATE integration_connections SET mls_backfill_pending = true, mls_backfill_cursor = NULL WHERE kind = 'mls_feed';
