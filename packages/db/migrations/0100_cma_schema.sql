-- =============================================================================
-- D9 S0: the CMA schema (owner decision D9, 2026-11-12: sellers and past clients get an automated value range and a
-- CMA built from the team's own MLS sold data, never a third-party AVM; an estimate, never an appraisal; behind the MLS
-- licence pack and counsel review). The number is a placeholder: the orchestrator assigns the next free number at
-- merge (before lane V1-A's), and nothing in code or tests names this file. 0001-0053 are not edited.
-- docs/DATA_MODEL.md §6.x "D9 CMA (S0 migration)"; proof: packages/db/test/rls_smoke_cma.sql.
--
-- 1. listings: MLS sale and property facts (R-CMA-1, the storage part). All nullable unless stated, written only by the
--    MLS sync (the system actor; 0001's listings policies already limit MLS rows to it). Coordinates are integer
--    microdegrees with a generated integer geo_cell (about 1 mi of latitude per cell): int4, int8, date and text
--    comparisons are leakproof on PG16 (pg_proc.proleakproof; numeric_lt is not), so the comps predicates can be index
--    conditions under FORCE RLS (the 0039 and 0042 headers). Stories and garage spaces are tenths, like baths_x10. The
--    columns stay out of listings_mls_shape; the price-history trigger (0001) and the monotonic trigger (0018) are
--    unchanged. The generated column rewrites listings once, inside this migration.
-- 2. integration_connections: the MLS backfill state (F14), written only by the system; policies unchanged.
-- 3. jurisdiction_packs: platform:cma (F8), published and unreviewed like 0018's packs. It gates client CMAs and
--    seller-update value ranges; platform:avm keeps gating automated home-value notes.
-- 4. cma_reports: a stored CMA (R-CMA-6 and R-CMA-8, the database parts). Every foreign key is composite. RLS: a CMA is
--    read by its creator, by whoever sees the contact's detail, and by tenant-wide roles; stored by a user actor as
--    themselves; edited by its creator or a tenant-wide role; never deleted except by its contact's deletion (erasure:
--    purge_contact_internal deletes the contact rows and the foreign key cascades). The guard keeps shared and
--    superseded rows unchanged except for links nulled by their target's deletion (F9). Merge moves nothing (the API
--    lists the merged-away records' CMAs on the survivor). No retention is built (C13).
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4):
--   * No SECURITY DEFINER function is added or replaced. No existing policy, grant or function changes.
--   * New tenant table cma_reports: ENABLE and FORCE RLS; the RESTRICTIVE staff-only tenant_isolation policy (a client
--     principal reads nothing); the RESTRICTIVE support_read_only_{ins,upd,del} policies and the 0016 statement trigger
--     (support reads with a grant, never writes); permissive SELECT, INSERT and UPDATE policies; no DELETE policy and no
--     DELETE grant. app_user: SELECT, INSERT, UPDATE.
--   * New invoker trigger function app.cma_reports_guard() (plain plpgsql, no SET clause, EXECUTE revoked from PUBLIC).
--     Its one allowance on a shared or superseded row, a link becoming NULL, holds only while a foreign-key action runs
--     (PostgreSQL runs a referential action as the owner of the referencing table, here cma_reports' owner, a role no
--     application path can assume: every definer is owned by app_definer or app_retention, 0001 §22) and only once the
--     link's target row no longer exists.
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

-- -----------------------------------------------------------------------------
-- 2. integration_connections: the MLS backfill state (F14)
-- -----------------------------------------------------------------------------
ALTER TABLE integration_connections
  ADD COLUMN mls_backfill_pending boolean NOT NULL DEFAULT false,
  ADD COLUMN mls_backfill_cursor  text,
  ADD CONSTRAINT integration_connections_backfill_cursor_pending CHECK (mls_backfill_cursor IS NULL OR mls_backfill_pending);

-- -----------------------------------------------------------------------------
-- 3. The platform:cma clearance pack (F8; R-INT-6). Ships unreviewed, like 0018's packs.
-- -----------------------------------------------------------------------------
INSERT INTO jurisdiction_packs (key, version, status, rules, reviewed_by_counsel_at, notes) VALUES
  ('platform:cma', '2026.11.0', 'published', '{}', NULL,
   'Client CMAs and seller-update value ranges built from the team''s MLS sales (C6 extended, V4, V5). Engineering placeholder. VERIFY WITH COUNSEL.');

-- -----------------------------------------------------------------------------
-- 4. cma_reports: a stored CMA
-- -----------------------------------------------------------------------------
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
  FOREIGN KEY (tenant_id, contact_address_id) REFERENCES contact_addresses (tenant_id, id) ON DELETE SET NULL (contact_address_id),
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

CREATE TRIGGER cma_reports_touch_updated_at BEFORE UPDATE ON cma_reports
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

-- The guard (R-CMA-8). Invoker, not a definer: it reads as the caller (RLS applies), and inside a foreign-key action as
-- the table owner.
--   * A CMA is born a draft without share fields.
--   * created_by_user_id never changes.
--   * Status moves only draft -> shared, draft -> superseded and shared -> superseded. draft -> shared is one UPDATE by a
--     user actor as themselves: shared_by_user_id = app.user_id(), shared_at and shared_message_id set together. The share
--     fields change at no other time.
--   * A shared or superseded row never changes, except: status (shared -> superseded), updated_at, and listing_id,
--     contact_address_id or shared_message_id becoming NULL through their foreign-key action (F9): while the action runs
--     (current_user is cma_reports' owner, as PostgreSQL runs referential actions) and once the target row is gone.
--   * A draft whose address is deleted is superseded by that action (F15): turning it into a no-address draft would
--     collide with the creator's open no-address draft for the contact in cma_reports_one_open_draft, refusing the
--     address's deletion and the contact's erasure.
--   * contact_address_id is an address of contact_id (on insert, and whenever either changes).
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
    -- F15: a draft prepared for an address that no longer exists is no longer open
    IF gone_address AND OLD.status = 'draft' AND NEW.status = 'draft' THEN
      NEW.status := 'superseded';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status
       AND NOT ((OLD.status = 'draft' AND NEW.status IN ('shared','superseded')) OR (OLD.status = 'shared' AND NEW.status = 'superseded')) THEN
      RAISE EXCEPTION 'CMA_STATUS_TRANSITION: % -> % is not allowed (draft -> shared | superseded, shared -> superseded)', OLD.status, NEW.status
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'draft' AND NEW.status = 'shared' THEN
      IF app.actor_kind() IS DISTINCT FROM 'user' OR app.user_id() IS NULL OR NEW.shared_by_user_id IS DISTINCT FROM app.user_id()
         OR NEW.shared_at IS NULL OR NEW.shared_message_id IS NULL THEN
        RAISE EXCEPTION 'CMA_SHARE_AS_SELF: a person shares a CMA as themselves, setting shared_at and the share message in the same update'
          USING ERRCODE = 'insufficient_privilege';
      END IF;
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
-- R-CMA-6: the creator, whoever sees the contact's detail (0031's inlinable app.contact_detail_row), tenant-wide roles
CREATE POLICY cma_reports_select ON cma_reports FOR SELECT USING (
  (SELECT app.is_tenant_wide())
  OR created_by_user_id = (SELECT app.user_id())
  OR (contact_id IS NOT NULL AND EXISTS (SELECT 1 FROM app.contact_detail_row(cma_reports.tenant_id, cma_reports.contact_id))));
-- a person stores a CMA as themselves, for a contact whose detail they see (or none)
CREATE POLICY cma_reports_insert ON cma_reports FOR INSERT WITH CHECK (
  (SELECT app.actor_kind()) = 'user' AND created_by_user_id = (SELECT app.user_id())
  AND (contact_id IS NULL OR app.contact_detail_visible(tenant_id, contact_id)));
-- R-CMA-8: the creator or a tenant-wide role edits (the guard decides what may change); a Team Lead is not tenant-wide
CREATE POLICY cma_reports_update ON cma_reports FOR UPDATE
  USING ((SELECT app.is_tenant_wide()) OR created_by_user_id = (SELECT app.user_id()))
  WITH CHECK ((SELECT app.is_tenant_wide()) OR created_by_user_id = (SELECT app.user_id()));
-- no DELETE policy: a CMA goes only with its contact (the foreign key's cascade)

GRANT SELECT, INSERT, UPDATE ON cma_reports TO app_user;
-- R-PERM-11 (0016): support is read-only on every path
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON cma_reports
  FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write();

-- -----------------------------------------------------------------------------
-- 5. Self-check: cma_reports keeps the staff-only Layer 1, the support trigger and no DELETE path; no definer is added.
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
  IF EXISTS (SELECT 1 FROM pg_proc p WHERE p.oid = 'app.cma_reports_guard()'::regprocedure AND (p.prosecdef OR p.proconfig IS NOT NULL)) THEN
    bad := bad || ' guard_not_invoker';
  END IF;
  IF bad <> '' THEN
    RAISE EXCEPTION 'CMA SCHEMA SELF-CHECK FAILED:%', bad;
  END IF;
END $$;
