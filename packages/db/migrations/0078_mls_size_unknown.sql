-- =============================================================================
-- MLS size: finished living area only when the MLS confirms its field (task 55; DATA_MODEL R-MLS-7, E600). Placeholder
-- number: the orchestrator renumbers at merge (batch 12 takes 0078-0080), and nothing in code or tests names this file
-- (packages/db/test/mls_size_unknown.test.ts finds it by its *_mls_size_unknown suffix). No earlier migration is edited.
--
-- The defect. The Spark mapping read listings.sqft from BuildingAreaTotal, the total building area, where the product
-- means finished living area (the CMA and valuation, home values, the homeowner profile and the ISA's listing facts all
-- read listings.sqft). The code now reads no Spark size until the MLS confirms which field carries finished living area
-- (SPARK_FIELD_MAPPING sqft null), and core normalize never reads BuildingAreaTotal (SIZE_FIELDS_NEVER_USED). But the
-- sync rewrites a row only for a strictly newer modification, so a size it already stored would stay. This migration
-- clears those sizes, with their source, where the rows can be told apart:
--   1. listings.size_source names a field that is never finished living area (core SIZE_FIELDS_NEVER_USED: the sync
--      records the field it read sqft from), on any connection: that size came from total, unfinished or below-grade
--      area. Compared in any letter case, as core does.
--   2. Every MLS row of a Spark connection: integration_connections kind 'mls_feed' whose external_account_id is
--      'spark:<id>' (mls/spark/service.ts saveSparkCredential sets it with the key, before any sync can run, and nothing
--      resets it). The Spark mapping read BuildingAreaTotal from its first commit, so a Spark row stored before
--      size_source existed (mls_normalize_version 1, no source) has a total-area size too, and until the MLS answers a
--      Spark size is unknown whatever its field, LivingArea included.
-- Never touched: team listings (source 'team': agent-entered sizes; they never carry a size_source), MLS rows of any
-- other connection whose source is another field or none (the deterministic fake's LivingArea, a pre-0061 row whose
-- field cannot be told), lot sizes and every other column. Only sqft and size_source change, and only on rows that had
-- one of them. listing_price_history fires on list_price_cents only; listings_mls_monotonic sees an unchanged
-- mls_modified_at; listings_valuation_facts_guard admits the table owner (this migration). A Spark row of version 1
-- keeps its version: the backfill still re-reads it, and the fill now writes sqft with its source (apps/api
-- mls/sync.ts fillMlsListing), null under the Spark mapping. Nothing is kept to restore: the cleared values were total
-- area, never finished area; an owner-approved flip of the Spark size field reads sizes again from the MLS, with its
-- own migration that has the backfill re-read every Spark record (docs/ARCHITECTURE §21.38, E613).
--
-- Then a CHECK keeps a never-used field out of size_source for good (listings_size_source_not_total), the database part
-- of R-MLS-7: a regression that maps BuildingAreaTotal again has its records refused (MLS_RECORD_REFUSED_BY_DB, the
-- record skipped and counted) instead of stored with a total-area size. The list mirrors core SIZE_FIELDS_NEVER_USED,
-- which the test checks against this constraint.
--
-- Stored CMAs (cma_reports.subject / result) are not rewritten: they are records of what an agent was shown (R-CMA-8;
-- a shared or superseded one never changes), and each names the field its sizes came from. No live Spark sync has run
-- (MLS_LIVE_CALLS has been false; the one read-only live check stored no listing, docs/SECURITY.md §5.3), so none should
-- hold a Spark size; if one does, its view leads with "not finished living area ... Prepare a new CMA." and readiness
-- blocks it (SIZE_NOT_LIVING_AREA, apps/api cma/gates.ts; E612).
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4): one data UPDATE on listings as the migration owner, and one CHECK constraint.
-- No table, column, policy, grant, trigger or function is added or changed.
-- =============================================================================

UPDATE listings l
   SET sqft = NULL, size_source = NULL
 WHERE l.source = 'mls'
   AND (l.sqft IS NOT NULL OR l.size_source IS NOT NULL)
   AND (lower(l.size_source) = ANY (ARRAY['buildingareatotal', 'abovegradeunfinishedarea', 'belowgradefinishedarea', 'belowgradeunfinishedarea'])
        OR EXISTS (SELECT 1 FROM integration_connections c
                    WHERE c.tenant_id = l.tenant_id AND c.id = l.mls_connection_id
                      AND c.kind = 'mls_feed' AND c.external_account_id LIKE 'spark:%'));

ALTER TABLE listings ADD CONSTRAINT listings_size_source_not_total CHECK (
  size_source IS NULL
  OR lower(size_source) <> ALL (ARRAY['buildingareatotal', 'abovegradeunfinishedarea', 'belowgradefinishedarea', 'belowgradeunfinishedarea']));

-- Self-check: no MLS row of a Spark connection keeps a size or a size source, and the constraint is validated.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM listings l JOIN integration_connections c ON c.tenant_id = l.tenant_id AND c.id = l.mls_connection_id
              WHERE l.source = 'mls' AND c.kind = 'mls_feed' AND c.external_account_id LIKE 'spark:%'
                AND (l.sqft IS NOT NULL OR l.size_source IS NOT NULL)) THEN
    RAISE EXCEPTION '0078 self-check failed: a Spark MLS row still has a size';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.listings'::regclass AND conname = 'listings_size_source_not_total' AND convalidated) THEN
    RAISE EXCEPTION '0078 self-check failed: listings_size_source_not_total is missing or not validated';
  END IF;
END $$;
