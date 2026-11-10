-- 0011 (BUILD_PLAN module 14, api/workspace): who closed a Priority Feed card, and search keys RLS can index.
--
-- No SECURITY DEFINER function, no new table, no policy change. Additive columns and indexes only.
--
-- The feed is recomputed from source rows (core.scoreFeed over the caller's RLS-visible inputs). A card
-- closes for two different reasons that the feed must tell apart:
--   'user'       the agent tapped Done / Dismiss: final for that dedupe key, a recompute never reopens it;
--   'condition'  the recompute no longer produces the card (the client was answered, the draft was folded
--                into a waiting-client card, the task moved past its window ...): the card reopens if the
--                same occurrence becomes due again.
-- NULL keeps the meaning other writers already give a closed row (the subject was handled: an approved
-- draft, an accepted offer); like 'user' it is final. Open and snoozed rows carry NULL.
ALTER TABLE priority_feed_items
  ADD COLUMN resolved_by text CHECK (resolved_by IN ('user','condition'));

-- The recompute looks rows up per (user, dedupe key) in every state, not only open ones.
CREATE INDEX feed_items_key_idx ON priority_feed_items (tenant_id, user_id, dedupe_key);

-- ---------------------------------------------------------------------------------------------------------
-- Search keys that RLS lets an index use (ARCHITECTURE §14; A1 "Find a contact" < 300 ms p95).
--
-- Under RLS, Postgres may evaluate a caller's predicate before the row-security quals (and so through an
-- index) only when every function in it is LEAKPROOF. LIKE / ILIKE, pg_trgm `%`, tsvector `@@`, lower()
-- and right() are not, so the 0001 GIN / trigram indexes are never used for an agent's search: each query
-- would scan every contact (and every contact point, calling the per-row visibility check) of the tenant.
-- These generated keys are compared only with btree `=`, `>=` and `<` on "C"-collated text (text_eq /
-- text_ge / text_lt are leakproof), so the index finds the few candidates first and RLS then filters them.
-- No new data: every key is derived from a column the row already has. No policy or definer change.
ALTER TABLE contacts
  ADD COLUMN search_name text COLLATE "C" GENERATED ALWAYS AS (lower(display_name)) STORED,
  ADD COLUMN search_last text COLLATE "C" GENERATED ALWAYS AS (lower(last_name)) STORED;
CREATE INDEX contacts_search_name_idx ON contacts (tenant_id, search_name) WHERE deleted_at IS NULL;
CREATE INDEX contacts_search_last_idx ON contacts (tenant_id, search_last) WHERE deleted_at IS NULL AND search_last IS NOT NULL;

-- phone digits: the last 7 digits of an E.164 number (the query's last 7–10 digits are then checked exactly)
ALTER TABLE contact_points
  ADD COLUMN phone_suffix7 text COLLATE "C" GENERATED ALWAYS AS (CASE WHEN kind = 'phone' THEN right(address, 7) END) STORED;
CREATE INDEX contact_points_phone_suffix7_idx ON contact_points (tenant_id, phone_suffix7) WHERE phone_suffix7 IS NOT NULL AND removed_at IS NULL;
-- email prefix (addresses are stored lower-case, DB CHECK)
CREATE INDEX contact_points_email_c_idx ON contact_points (tenant_id, (address COLLATE "C")) WHERE kind = 'email' AND removed_at IS NULL;

ALTER TABLE contact_addresses
  ADD COLUMN search_line1 text COLLATE "C" GENERATED ALWAYS AS (lower(line1)) STORED;
CREATE INDEX contact_addresses_search_line1_idx ON contact_addresses (tenant_id, search_line1) WHERE search_line1 IS NOT NULL;
