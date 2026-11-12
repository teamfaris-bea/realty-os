-- =============================================================================
-- D9 S0: the CMA schema (owner decision D9, 2026-11-12: sellers and past clients get an automated value range and a
-- CMA built from the team's own MLS sold data, never a third-party AVM; an estimate, never an appraisal; behind the MLS
-- licence pack and counsel review). Numbered 0061 at the CMA base (after batch 8's 0055-0060), before lane V1-A's;
-- nothing in code or tests names this file. 0001-0060 are not edited.
-- docs/DATA_MODEL.md §6.x "D9 CMA (S0 migration)"; proof: packages/db/test/rls_smoke_cma.sql.
--
-- 1. listings: MLS sale and property facts (R-CMA-1, the storage part). All nullable unless stated, written only by the
--    MLS sync (the system actor): 0001's listings policies do not keep a person off them (a team listing is its agent's,
--    and a Team Lead or tenant-wide role could relabel an MLS row as a team one), so the invoker guard
--    listings_valuation_facts_guard does. Coordinates are integer microdegrees with a generated integer geo_cell (about
--    1 mi of latitude per cell): int4, int8, date and text comparisons are leakproof on PG16 (pg_proc.proleakproof;
--    numeric_lt is not), so the comps predicates can be index conditions under FORCE RLS (the 0039 and 0042 headers).
--    Stories and garage spaces are tenths, like baths_x10. The columns stay out of listings_mls_shape; the price-history
--    trigger (0001) and the monotonic trigger (0018) are unchanged. The generated column rewrites listings once, inside
--    this migration.
-- 2. integration_connections: the MLS backfill state (F14), written only by the system (the invoker guard
--    integration_connections_backfill_guard); policies and 0018's guard unchanged.
-- 3. jurisdiction_packs: platform:cma (F8), published and unreviewed like 0018's packs. It gates client CMAs and
--    seller-update value ranges; platform:avm keeps gating automated home-value notes.
-- 4. cma_reports: a stored CMA (R-CMA-6 and R-CMA-8, the database parts). Every foreign key is composite; the address
--    one carries the contact (a new unique index on contact_addresses is its target). RLS: a CMA is read by its creator
--    (an active member), by whoever sees the contact's detail, and by tenant-wide roles; stored by a user actor as
--    themselves; edited by its creator or a tenant-wide role; never deleted except by its contact's deletion (erasure:
--    purge_contact_internal deletes the contact rows and the foreign key cascades). The guard keeps a CMA's contact, and
--    shared and superseded rows unchanged except for links nulled by their target's deletion (F9). Each SET NULL link has
--    an index. Merge moves nothing (the API lists the merged-away records' CMAs on the survivor). No retention is built
--    (C13).
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4):
--   * No SECURITY DEFINER function is added or replaced. No existing policy, grant or function changes. Existing tables
--     gain: listings and integration_connections a guard trigger each (above), contact_addresses one unique index.
--   * New tenant table cma_reports: ENABLE and FORCE RLS; the RESTRICTIVE staff-only tenant_isolation policy (a client
--     principal reads nothing); the RESTRICTIVE support_read_only_{ins,upd,del} policies and the 0016 statement trigger
--     (support reads with a grant, never writes); permissive SELECT, INSERT and UPDATE policies; no DELETE policy and no
--     DELETE grant. app_user: SELECT, INSERT, UPDATE.
--   * New invoker trigger functions app.cma_reports_guard(), app.listings_valuation_facts_guard() and
--     app.integration_connections_backfill_guard() (plain plpgsql, no SET clause, EXECUTE revoked from PUBLIC). The
--     cma_reports guard's one allowance on a shared or superseded row, a link becoming NULL, holds only while a
--     foreign-key action runs (PostgreSQL runs a referential action as the owner of the referencing table, here
--     cma_reports' owner, a role no application path can assume: every definer is owned by app_definer or
--     app_retention, 0001 §22) and only once the link's target row no longer exists. The two column guards let through
--     the system actor, app_definer, app_retention and the table owner (migrations), as 0018's
--     integration_connections_guard does for the first three.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 1. listings: MLS sale and property facts (one ALTER TABLE, one rewrite)
-- -----------------------------------------------------------------------------
ALTER TABLE listings
  ADD COLUMN close_price_cents         bigint CHECK (close_price_cents >= 0),
  ADD COLUMN close_date                date,
  ADD COLUMN purchase_contract_date    date,
  ADD COLUMN original_list_price_cents bigint CHECK (original_list_price_cents >= 0),
  ADD COLUMN concessions_cents         bigint CHECK (concessions_cents >= 0),
  ADD COLUMN sale_conditions           text[] NOT NULL DEFAULT '{}'
                                       CHECK (sale_conditions <@ ARRAY['standard','short_sale','reo','auction','probate','other']::text[]),
  ADD COLUMN days_on_market            integer CHECK (days_on_market >= 0),
  ADD COLUMN latitude_e6               integer CHECK (latitude_e6 BETWEEN -90000000 AND 90000000),
  ADD COLUMN longitude_e6              integer CHECK (longitude_e6 BETWEEN -180000000 AND 180000000),
  -- numeric division on purpose: integer division truncates toward zero and would double the cells at 0.
  -- Range 2,250,080 .. 312,749,919 (fits int4). core/listings geoCell() mirrors it (lane V1-A; parity tests).
  ADD COLUMN geo_cell                  integer GENERATED ALWAYS AS (
                                         ((floor(latitude_e6 / 14493.0) + 6300) * 25000 + (floor(longitude_e6 / 14493.0) + 12500))::integer) STORED,
  ADD COLUMN year_built                smallint CHECK (year_built BETWEEN 1600 AND 2100),
  ADD COLUMN lot_sqft                  bigint CHECK (lot_sqft >= 0),
  ADD COLUMN subdivision_name          text,
  ADD COLUMN garage_spaces_x10         smallint CHECK (garage_spaces_x10 >= 0),   -- tenths: 2.5 spaces is 25
  ADD COLUMN stories_x10               smallint CHECK (stories_x10 >= 0),         -- tenths: 1.5 stories is 15
  ADD COLUMN pool_private              boolean,
  ADD COLUMN size_source               text,                                      -- the RESO field sqft was read from
  ADD COLUMN is_lease                  boolean NOT NULL DEFAULT false,
  ADD COLUMN avm_display_allowed       boolean NOT NULL DEFAULT false,            -- InternetAutomatedValuationDisplayYN; never defaulted to allowed
  ADD COLUMN address_key               text,
  ADD COLUMN mls_normalize_version     smallint NOT NULL DEFAULT 1,
  ADD CONSTRAINT listings_coordinates_pair CHECK ((latitude_e6 IS NULL) = (longitude_e6 IS NULL));

-- The facts above are the MLS sync's (the system actor's). 0001's policies do not keep a person off them: a team listing
-- is its agent's to write, and listings_update admits the Team Lead and tenant-wide roles on an MLS row with a WITH CHECK
-- of only source = 'team', so a person could relabel an MLS row as a team listing and take it (with its
-- avm_display_allowed) out of every source = 'mls' read. This invoker guard refuses both for anyone but the system actor,
-- the reviewed definer and retention roles, and the table owner (migrations; no application path runs as it). Lane V1-A
-- gives team rows the empty valuation facts, so no person writes these columns. The other listing columns are unchanged.
CREATE FUNCTION app.listings_valuation_facts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE(app.actor_kind() = 'system', false) OR current_user IN ('app_definer','app_retention')
     OR current_user = (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID) THEN
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.source = 'mls' AND NEW.source IS DISTINCT FROM 'mls' THEN
    RAISE EXCEPTION 'LISTING_MLS_ROW_SYSTEM_ONLY: an MLS listing stays an MLS listing; only the MLS sync writes it'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF (TG_OP = 'INSERT' AND (NEW.close_price_cents IS NOT NULL OR NEW.close_date IS NOT NULL OR NEW.purchase_contract_date IS NOT NULL
        OR NEW.original_list_price_cents IS NOT NULL OR NEW.concessions_cents IS NOT NULL OR NEW.sale_conditions IS DISTINCT FROM '{}'::text[]
        OR NEW.days_on_market IS NOT NULL OR NEW.latitude_e6 IS NOT NULL OR NEW.longitude_e6 IS NOT NULL OR NEW.year_built IS NOT NULL
        OR NEW.lot_sqft IS NOT NULL OR NEW.subdivision_name IS NOT NULL OR NEW.garage_spaces_x10 IS NOT NULL OR NEW.stories_x10 IS NOT NULL
        OR NEW.pool_private IS NOT NULL OR NEW.size_source IS NOT NULL OR NEW.is_lease IS DISTINCT FROM false
        OR NEW.avm_display_allowed IS DISTINCT FROM false OR NEW.address_key IS NOT NULL OR NEW.mls_normalize_version IS DISTINCT FROM 1))
     OR (TG_OP = 'UPDATE' AND (NEW.close_price_cents, NEW.close_date, NEW.purchase_contract_date, NEW.original_list_price_cents,
           NEW.concessions_cents, NEW.sale_conditions, NEW.days_on_market, NEW.latitude_e6, NEW.longitude_e6, NEW.year_built, NEW.lot_sqft,
           NEW.subdivision_name, NEW.garage_spaces_x10, NEW.stories_x10, NEW.pool_private, NEW.size_source, NEW.is_lease,
           NEW.avm_display_allowed, NEW.address_key, NEW.mls_normalize_version)
         IS DISTINCT FROM (OLD.close_price_cents, OLD.close_date, OLD.purchase_contract_date, OLD.original_list_price_cents,
           OLD.concessions_cents, OLD.sale_conditions, OLD.days_on_market, OLD.latitude_e6, OLD.longitude_e6, OLD.year_built, OLD.lot_sqft,
           OLD.subdivision_name, OLD.garage_spaces_x10, OLD.stories_x10, OLD.pool_private, OLD.size_source, OLD.is_lease,
           OLD.avm_display_allowed, OLD.address_key, OLD.mls_normalize_version)) THEN
    RAISE EXCEPTION 'LISTING_VALUATION_FACTS_SYSTEM: the MLS sale and property facts are written by the MLS sync only'
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.listings_valuation_facts_guard() FROM PUBLIC;
CREATE TRIGGER listings_valuation_facts_guard BEFORE INSERT OR UPDATE ON listings
  FOR EACH ROW EXECUTE FUNCTION app.listings_valuation_facts_guard();

-- -----------------------------------------------------------------------------
-- 2. integration_connections: the MLS backfill state (F14)
-- -----------------------------------------------------------------------------
ALTER TABLE integration_connections
  ADD COLUMN mls_backfill_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN mls_backfill_cursor  text,
  ADD CONSTRAINT integration_connections_backfill_cursor_pending CHECK (mls_backfill_cursor IS NULL OR mls_backfill_pending);

-- The backfill state is the MLS sync's: Owner/Admin write integration_connections (0018's policies, unchanged) but never
-- these two columns. Same exemptions as above (the table owner covers lane V1-A's one-time migration that starts the
-- backfill); 0018's integration_connections_guard is unchanged.
CREATE FUNCTION app.integration_connections_backfill_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF COALESCE(app.actor_kind() = 'system', false) OR current_user IN ('app_definer','app_retention')
     OR current_user = (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID) THEN
    RETURN NEW;
  END IF;
  IF (TG_OP = 'INSERT' AND (NEW.mls_backfill_pending IS DISTINCT FROM false OR NEW.mls_backfill_cursor IS NOT NULL))
     OR (TG_OP = 'UPDATE' AND (NEW.mls_backfill_pending, NEW.mls_backfill_cursor) IS DISTINCT FROM (OLD.mls_backfill_pending, OLD.mls_backfill_cursor)) THEN
    RAISE EXCEPTION 'CONNECTION_BACKFILL_SYSTEM: the MLS backfill state is written by the MLS sync only' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.integration_connections_backfill_guard() FROM PUBLIC;
CREATE TRIGGER integration_connections_backfill_guard BEFORE INSERT OR UPDATE ON integration_connections
  FOR EACH ROW EXECUTE FUNCTION app.integration_connections_backfill_guard();

-- -----------------------------------------------------------------------------
-- 3. The platform:cma clearance pack (F8; R-INT-6). Ships unreviewed, like 0018's packs.
-- -----------------------------------------------------------------------------
INSERT INTO jurisdiction_packs (key, version, status, rules, reviewed_by_counsel_at, notes) VALUES
  ('platform:cma', '2026.11.0', 'published', '{}', NULL,
   'Client CMAs and seller-update value ranges built from the team''s MLS sales (C6 extended, V4, V5). Engineering placeholder. VERIFY WITH COUNSEL.');

-- -----------------------------------------------------------------------------
-- 4. cma_reports: a stored CMA
-- -----------------------------------------------------------------------------
-- The target of cma_reports' address foreign key, which carries the contact: an address a CMA names stays that contact's
-- (no path re-parents an address today; contact_detail's FOR ALL policy would let anyone who sees both contacts do it).
CREATE UNIQUE INDEX contact_addresses_tenant_contact_id_uq ON contact_addresses (tenant_id, contact_id, id);

CREATE TABLE cma_reports (
  tenant_id           uuid NOT NULL,
  id                  uuid NOT NULL,
  contact_id          uuid,                     -- NULL: a research CMA
  contact_address_id  uuid,
  listing_id          uuid,                     -- the subject's listing, when it has one
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','shared','superseded')),
  purpose             text NOT NULL CHECK (purpose IN ('listing_price','buyer_offer','other')),
  inspection          text NOT NULL DEFAULT 'none' CHECK (inspection IN ('none','exterior','interior_and_exterior')),
  inspected_on        date,
  -- the USPAP SoP 11-1 items a purpose of 'other' records (F7b); VERIFY V5/V7
  intended_users      text CHECK (char_length(intended_users) <= 2000),
  agent_interest      text CHECK (char_length(agent_interest) <= 2000),
  conflicts           text CHECK (char_length(conflicts) <= 2000),
  value_definition    text CHECK (char_length(value_definition) <= 2000),
  limiting_conditions text CHECK (char_length(limiting_conditions) <= 2000),
  method_version      text NOT NULL,
  valuation_date      date NOT NULL,
  mls_data_as_of      timestamptz,
  subject             jsonb NOT NULL CHECK (jsonb_typeof(subject) = 'object'),
  result              jsonb NOT NULL CHECK (jsonb_typeof(result) = 'object'),
  value_cents         bigint CHECK (value_cents >= 0),
  low_cents           bigint CHECK (low_cents >= 0),
  high_cents          bigint CHECK (high_cents >= 0),
  agent_notes         text CHECK (char_length(agent_notes) <= 4000),
  content_sha256      text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  created_by_user_id  uuid NOT NULL,
  shared_by_user_id   uuid,
  shared_at           timestamptz,
  shared_message_id   uuid,                     -- the queued share message: the compliance sweep's link (F1)
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id)         REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  -- the address is one of this contact's, from either side (MATCH SIMPLE: a CMA without an address is not checked)
  FOREIGN KEY (tenant_id, contact_id, contact_address_id) REFERENCES contact_addresses (tenant_id, contact_id, id)
    ON DELETE SET NULL (contact_address_id),
  -- a future MLS purge never fails on a subject listing (F9)
  FOREIGN KEY (tenant_id, listing_id)         REFERENCES listings (tenant_id, id) ON DELETE SET NULL (listing_id),
  FOREIGN KEY (tenant_id, created_by_user_id) REFERENCES memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, shared_by_user_id)  REFERENCES memberships (tenant_id, user_id),
  FOREIGN KEY (tenant_id, shared_message_id)  REFERENCES messages (tenant_id, id) ON DELETE SET NULL (shared_message_id),
  CONSTRAINT cma_reports_inspected_on CHECK (inspection <> 'none' OR inspected_on IS NULL),
  CONSTRAINT cma_reports_value_range CHECK ((value_cents IS NULL) = (low_cents IS NULL) AND (value_cents IS NULL) = (high_cents IS NULL)
                                            AND (value_cents IS NULL OR (low_cents <= value_cents AND value_cents <= high_cents))),
  CONSTRAINT cma_reports_address_needs_contact CHECK (contact_address_id IS NULL OR contact_id IS NOT NULL),
  CONSTRAINT cma_reports_shared_state CHECK (status <> 'shared' OR (shared_at IS NOT NULL AND shared_by_user_id IS NOT NULL))
);
CREATE INDEX cma_reports_contact_idx ON cma_reports (tenant_id, contact_id, created_at DESC) WHERE contact_id IS NOT NULL;
CREATE INDEX cma_reports_creator_idx ON cma_reports (tenant_id, created_by_user_id, created_at DESC);
-- F15: one open draft per (creator, contact, address); a NULL address is one value (NULLS NOT DISTINCT, PG15+)
CREATE UNIQUE INDEX cma_reports_one_open_draft ON cma_reports (tenant_id, created_by_user_id, contact_id, contact_address_id)
  NULLS NOT DISTINCT WHERE status = 'draft' AND contact_id IS NOT NULL;
-- F9: each SET NULL link has its own index, so deleting a listing, an address or a message (an MLS purge, an import revert,
-- a contact's erasure) finds its CMAs without scanning the tenant's. A share email backs one CMA (the sweep's link, F1).
CREATE UNIQUE INDEX cma_reports_share_message ON cma_reports (tenant_id, shared_message_id) WHERE shared_message_id IS NOT NULL;
CREATE INDEX cma_reports_address_idx ON cma_reports (tenant_id, contact_address_id) WHERE contact_address_id IS NOT NULL;
CREATE INDEX cma_reports_listing_idx ON cma_reports (tenant_id, listing_id) WHERE listing_id IS NOT NULL;

CREATE TRIGGER cma_reports_touch_updated_at BEFORE UPDATE ON cma_reports
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- The guard (R-CMA-8). Invoker, not a definer: it reads as the caller (RLS applies), and inside a foreign-key action as
-- the table owner.
--   * A CMA is born a draft without share fields.
--   * created_by_user_id and contact_id never change: a CMA stays with the contact it was prepared for, whose detail the
--     insert policy checked (no update moves it onto a contact the caller does not see; no lane moves one).
--   * Status moves only draft -> shared, draft -> superseded and shared -> superseded. draft -> shared is one UPDATE by a
--     user actor as themselves: shared_by_user_id = app.user_id() and shared_message_id set together, and the database
--     stamps shared_at. The share message is an outbound email the sharer sees (RLS applies: never another person's
--     hidden message, never an inbound one); cma_reports_share_message keeps it to one CMA. The share fields change at no
--     other time.
--   * A shared or superseded row never changes, except: status (shared -> superseded), updated_at, and listing_id,
--     contact_address_id or shared_message_id becoming NULL through their foreign-key action (F9): while the action runs
--     (current_user is cma_reports' owner, as PostgreSQL runs referential actions) and once the target row is gone.
--   * A draft whose address is deleted becomes a no-address draft, unless its creator already holds an open no-address
--     draft for the contact: then it is superseded by that action (F15), since the collision in cma_reports_one_open_draft
--     would refuse the address's deletion and the contact's erasure.
--   * contact_address_id is an address of contact_id (on insert, and whenever it changes); the address foreign key, which
--     carries the contact, holds it from the address side.
CREATE FUNCTION app.cma_reports_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  fk_action    boolean := false;
  gone_listing boolean := false;
  gone_address boolean := false;
  gone_message boolean := false;
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'draft' OR NEW.shared_by_user_id IS NOT NULL OR NEW.shared_at IS NOT NULL OR NEW.shared_message_id IS NOT NULL THEN
      RAISE EXCEPTION 'CMA_BORN_DRAFT: a CMA is stored as a draft and shared by a later update' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id THEN
      RAISE EXCEPTION 'CMA_CREATOR_IMMUTABLE: a CMA stays its creator''s' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW.contact_id IS DISTINCT FROM OLD.contact_id THEN
      RAISE EXCEPTION 'CMA_CONTACT_IMMUTABLE: a CMA stays with the contact it was prepared for; prepare a new one' USING ERRCODE = 'check_violation';
    END IF;
    -- a link nulled by its target's deletion: only inside the foreign-key action, which runs as the table owner
    IF (OLD.listing_id IS NOT NULL AND NEW.listing_id IS NULL) OR (OLD.contact_address_id IS NOT NULL AND NEW.contact_address_id IS NULL)
       OR (OLD.shared_message_id IS NOT NULL AND NEW.shared_message_id IS NULL) THEN
      fk_action := current_user = (SELECT pg_catalog.pg_get_userbyid(c.relowner) FROM pg_catalog.pg_class c WHERE c.oid = TG_RELID);
    END IF;
    IF fk_action THEN
      gone_listing := OLD.listing_id IS NOT NULL AND NEW.listing_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.listings l WHERE l.tenant_id = OLD.tenant_id AND l.id = OLD.listing_id);
      gone_address := OLD.contact_address_id IS NOT NULL AND NEW.contact_address_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.contact_addresses a WHERE a.tenant_id = OLD.tenant_id AND a.id = OLD.contact_address_id);
      gone_message := OLD.shared_message_id IS NOT NULL AND NEW.shared_message_id IS NULL
        AND NOT EXISTS (SELECT 1 FROM public.messages m WHERE m.tenant_id = OLD.tenant_id AND m.id = OLD.shared_message_id);
    END IF;
    -- F15: a draft whose address is gone stays open with no address, unless its creator already holds an open no-address
    -- draft for the contact (cma_reports_one_open_draft would refuse the deletion): then it is superseded. This runs inside
    -- the foreign-key action, as the table owner, so no row is hidden from the check.
    IF gone_address AND OLD.status = 'draft' AND NEW.status = 'draft'
       AND EXISTS (SELECT 1 FROM public.cma_reports o
                    WHERE o.tenant_id = NEW.tenant_id AND o.created_by_user_id = NEW.created_by_user_id AND o.contact_id = NEW.contact_id
                      AND o.contact_address_id IS NULL AND o.status = 'draft' AND o.id <> NEW.id) THEN
      NEW.status := 'superseded';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT ((OLD.status = 'draft' AND NEW.status IN ('shared','superseded')) OR (OLD.status = 'shared' AND NEW.status = 'superseded')) THEN
      RAISE EXCEPTION 'CMA_STATUS_TRANSITION: % -> % is not allowed (draft -> shared | superseded, shared -> superseded)', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'draft' AND NEW.status = 'shared' THEN
      IF app.actor_kind() IS DISTINCT FROM 'user' OR app.user_id() IS NULL OR NEW.shared_by_user_id IS DISTINCT FROM app.user_id()
         OR NEW.shared_message_id IS NULL THEN
        RAISE EXCEPTION 'CMA_SHARE_AS_SELF: a person shares a CMA as themselves, linking the share message in the same update'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
      -- as the caller (RLS applies): the share email must be one the sharer sees
      IF NOT EXISTS (SELECT 1 FROM public.messages m
                      WHERE m.tenant_id = NEW.tenant_id AND m.id = NEW.shared_message_id AND m.direction = 'outbound' AND m.channel = 'email') THEN
        RAISE EXCEPTION 'CMA_SHARE_MESSAGE: a CMA is shared through an outbound email the sharer can see' USING ERRCODE = 'check_violation';
      END IF;
      NEW.shared_at := now();
    ELSIF (NEW.shared_by_user_id, NEW.shared_at) IS DISTINCT FROM (OLD.shared_by_user_id, OLD.shared_at)
          OR (NEW.shared_message_id IS DISTINCT FROM OLD.shared_message_id AND NOT gone_message) THEN
      RAISE EXCEPTION 'CMA_SHARE_FIELDS: the share fields are set only when a draft is shared' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status <> 'draft' THEN
      IF (to_jsonb(NEW) - ARRAY['status','updated_at','listing_id','contact_address_id','shared_message_id'])
           IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status','updated_at','listing_id','contact_address_id','shared_message_id'])
         OR (NEW.listing_id IS DISTINCT FROM OLD.listing_id AND NOT gone_listing)
         OR (NEW.contact_address_id IS DISTINCT FROM OLD.contact_address_id AND NOT gone_address)
         OR (NEW.shared_message_id IS DISTINCT FROM OLD.shared_message_id AND NOT gone_message) THEN
        RAISE EXCEPTION 'CMA_NOT_DRAFT: a % CMA never changes; prepare a new draft', OLD.status USING ERRCODE = 'check_violation';
      END IF;
    END IF;
  END IF;
  IF NEW.contact_address_id IS NOT NULL AND NEW.contact_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR (NEW.contact_id, NEW.contact_address_id) IS DISTINCT FROM (OLD.contact_id, OLD.contact_address_id))
     AND NOT EXISTS (SELECT 1 FROM public.contact_addresses a
                      WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.contact_address_id AND a.contact_id = NEW.contact_id) THEN
    RAISE EXCEPTION 'CMA_ADDRESS_NOT_OF_CONTACT: the address is not one of this contact''s' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.cma_reports_guard() FROM PUBLIC;
CREATE TRIGGER cma_reports_guard BEFORE INSERT OR UPDATE ON cma_reports
  FOR EACH ROW EXECUTE FUNCTION app.cma_reports_guard();

-- Row-level security. Layer 1, staff only: the policy text 0001 generated (a client principal reads none of this).
ALTER TABLE cma_reports ENABLE ROW LEVEL SECURITY;
ALTER TABLE cma_reports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON cma_reports AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')
  WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff');
CREATE POLICY support_read_only_ins ON cma_reports AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_upd ON cma_reports AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_del ON cma_reports AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> 'support');
-- R-CMA-6: the creator, whoever sees the contact's detail (0031's inlinable app.contact_detail_row), tenant-wide roles.
-- The creator branches need an active membership as a user actor (app.my_role() IS NOT NULL), like contacts_select: a
-- suspended member, or a context with a user id and no actor kind, reads and writes nothing.
CREATE POLICY cma_reports_select ON cma_reports FOR SELECT USING (
  (SELECT app.is_tenant_wide())
  OR (created_by_user_id = (SELECT app.user_id()) AND (SELECT app.my_role()) IS NOT NULL)
  OR (contact_id IS NOT NULL AND EXISTS (SELECT 1 FROM app.contact_detail_row(cma_reports.tenant_id, cma_reports.contact_id))));
-- a person stores a CMA as themselves, for a contact whose detail they see (or none)
CREATE POLICY cma_reports_insert ON cma_reports FOR INSERT WITH CHECK (
  (SELECT app.actor_kind()) = 'user' AND (SELECT app.my_role()) IS NOT NULL AND created_by_user_id = (SELECT app.user_id())
  AND (contact_id IS NULL OR app.contact_detail_visible(tenant_id, contact_id)));
-- R-CMA-8: the creator or a tenant-wide role edits (the guard decides what may change); a Team Lead is not tenant-wide
CREATE POLICY cma_reports_update ON cma_reports FOR UPDATE
  USING ((SELECT app.is_tenant_wide()) OR (created_by_user_id = (SELECT app.user_id()) AND (SELECT app.my_role()) IS NOT NULL))
  WITH CHECK ((SELECT app.is_tenant_wide()) OR (created_by_user_id = (SELECT app.user_id()) AND (SELECT app.my_role()) IS NOT NULL));
-- no DELETE policy: a CMA goes only with its contact (the foreign key's cascade)

GRANT SELECT, INSERT, UPDATE ON cma_reports TO app_user;
-- R-PERM-11 (0016): support is read-only on every path
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON cma_reports
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write();

-- -----------------------------------------------------------------------------
-- 5. Self-check: cma_reports keeps the staff-only Layer 1, the support trigger and no DELETE path, and its address foreign
--    key carries the contact; the three guards are invokers; no definer is added.
-- -----------------------------------------------------------------------------
DO $$
DECLARE bad text := '';
BEGIN
  IF NOT (SELECT c.relrowsecurity AND c.relforcerowsecurity FROM pg_class c WHERE c.oid = 'public.cma_reports'::regclass) THEN
    bad := bad || ' rls';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid = 'public.cma_reports'::regclass AND p.polname = 'tenant_isolation'
                    AND NOT p.polpermissive AND pg_get_expr(p.polqual, p.polrelid) LIKE '%''staff''%') THEN
    bad := bad || ' tenant_isolation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = 'public.cma_reports'::regclass AND t.tgname = 'support_read_only') THEN
    bad := bad || ' support_read_only';
  END IF;
  IF has_table_privilege('app_user', 'public.cma_reports', 'DELETE') THEN bad := bad || ' delete_grant'; END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid IN ('app.cma_reports_guard()'::regprocedure, 'app.listings_valuation_facts_guard()'::regprocedure,
                                                     'app.integration_connections_backfill_guard()'::regprocedure)
                AND (p.prosecdef OR p.proconfig IS NOT NULL)) THEN
    bad := bad || ' guard_not_invoker';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conrelid = 'public.cma_reports'::regclass AND c.contype = 'f'
                    AND c.confrelid = 'public.contact_addresses'::regclass AND cardinality(c.conkey) = 3) THEN
    bad := bad || ' address_fk_without_contact';
  END IF;
  IF bad <> '' THEN
    RAISE EXCEPTION 'CMA SCHEMA SELF-CHECK FAILED:%', bad;
  END IF;
END $$;
