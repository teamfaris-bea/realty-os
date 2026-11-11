-- Module 24 (api/mls): indexes for MLS listings at volume (PHASE2_3_PLAN §6: 500k MLS rows per tenant;
-- saved-search matching of a 1,000-row MLS delta < 60 s). Indexes only: no table, policy, grant or definer.
--
-- Saved-search MLS candidates and competing sets narrow MLS rows by postal code or city, and client-eligible
-- rows by connection. Plain columns only: under FORCE RLS the planner keeps a qual with a non-leakproof
-- function on row data (left(), lower()) out of index conditions, so the queries compare the stored values
-- with texteq (leakproof) and these partial indexes cover only source = 'mls' rows.
CREATE INDEX listings_mls_postal_idx ON listings (tenant_id, postal_code, status) WHERE source = 'mls';
CREATE INDEX listings_mls_city_idx ON listings (tenant_id, city, region, status) WHERE source = 'mls';
CREATE INDEX listings_mls_connection_idx ON listings (tenant_id, mls_connection_id, mls_modified_at DESC) WHERE source = 'mls';
-- mirrors (E81): an mls row whose number is a team listing's; the sync and the sweep link them
CREATE INDEX listings_team_mls_number_idx ON listings (tenant_id, mls_number) WHERE source = 'team' AND mls_number IS NOT NULL;
