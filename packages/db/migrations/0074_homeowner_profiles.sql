-- =============================================================================
-- Homeowner profiles from county public records (owner decision D10; modules 77-79; R-HOME-1..R-HOME-10,
-- E560-E589). Placeholder number: the orchestrator renumbers at merge, and no code or test names this file.
--
-- Why new tables and not property_records: property_records is property-only by construction (R-PRED-2; 0018 §
-- "Property facts only"), has no provenance column and is fenced to predict/** (predict/architecture.test.ts). A
-- homeowner profile carries person-level public-record data (the owner's mailing address for tax bills) about a
-- RECOGNISED seller or homeowner, every value with its source and as-of date, for agents only (R-HOME-1, R-HOME-4).
--
-- homeowner_profiles: one row per subject address (a contact_addresses row), written only by the system's nightly
--   homeowner.refresh job. The county mailing address is never copied to the contact (R-HOME-7).
-- homeowner_profile_facts: one row per kept value, a typed column per field, with source and as-of date. No balance,
--   equity, estimate or score is expressible (R-HOME-4): the field list is closed by CHECK.
--
-- Guards (plain plpgsql, invoker; EXECUTE revoked from PUBLIC, a trigger needs no grant):
--   app.homeowner_profiles_guard: the subject address belongs to the profile's contact; contact_id and
--     contact_address_id never change (merges move no addresses, 0027); a profile leaves 'matched' only once its
--     facts are gone (the job deletes the facts first, E584).
--   app.homeowner_facts_guard: a fact is written only under a 'matched' profile (R-HOME-3).
--
-- RLS: Layer 1 as CONVENTIONS §4 (staff only; the client principal reads nothing, E583), the support_read_only
-- policies and statement trigger; read under the contact's detail visibility (app.contact_detail_row, 0031) and only
-- until retention_until (E587); every write is the system's, tenant-wide. app_user gets SELECT, INSERT, UPDATE and
-- DELETE, but DELETE is reachable only through the system write policy (R-HOME-9).
--
-- SECURITY REVIEW ITEMS: no SECURITY DEFINER function (the system purges in its own transaction through the system
-- write policy, so there is no retention definer). Two invoker trigger functions; two tables with FORCE RLS; the
-- SELECT policies above; FOR ALL system-only write policies; the grants above. One platform pack row,
-- platform:public_records_outreach, shipped unreviewed: it gates nothing (no outreach path exists, R-HOME-10).
-- =============================================================================

CREATE TABLE homeowner_profiles (
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  id                  uuid NOT NULL,
  contact_id          uuid NOT NULL,
  contact_address_id  uuid NOT NULL,
  county_key          text NOT NULL CHECK (county_key ~ '^[a-z]{2}-[a-z_]{1,40}$'),
  status              text NOT NULL CHECK (status IN ('matched','not_matched','not_available','ambiguous','failed')),
  match_detail        text CHECK (match_detail IN ('address_mismatch','owner_name_mismatch','missing_data')),
  recognized_by       text[] NOT NULL CHECK (cardinality(recognized_by) BETWEEN 1 AND 4
                        AND recognized_by <@ ARRAY['seller_intent','seller_inquiry','homeowner_tag','past_buyer']::text[]),
  parcel_ref          text CHECK (parcel_ref ~ '^[A-Za-z0-9._:-]{1,120}$'),
  source              text CHECK (source ~ '^[A-Za-z0-9 .,:()_-]{1,80}$'),
  record_as_of        date,
  checked_at          timestamptz,
  last_failure_at     timestamptz,
  last_failure_code   text CHECK (last_failure_code IN ('unavailable','timeout','rejected','address_invalid')),
  address_updated_at  timestamptz NOT NULL,
  next_refresh_at     timestamptz NOT NULL,
  retention_until     timestamptz NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, contact_address_id),
  FOREIGN KEY (tenant_id, contact_id)         REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, contact_address_id) REFERENCES contact_addresses (tenant_id, id) ON DELETE CASCADE,
  CHECK ((status = 'not_matched') = (match_detail IS NOT NULL)),
  CHECK ((status = 'failed') = (checked_at IS NULL)),
  CHECK ((last_failure_at IS NULL) = (last_failure_code IS NULL)),
  CHECK (status <> 'failed' OR last_failure_at IS NOT NULL),
  -- at most 12 months from the last answered lookup (or the first failure); R-DATA-6, VERIFY WITH COUNSEL
  CHECK (retention_until <= COALESCE(checked_at, last_failure_at) + interval '366 days')
);
CREATE INDEX homeowner_profiles_contact_idx ON homeowner_profiles (tenant_id, contact_id);
CREATE INDEX homeowner_profiles_due_idx ON homeowner_profiles (tenant_id, next_refresh_at);
CREATE TRIGGER homeowner_profiles_touch_updated_at BEFORE UPDATE ON homeowner_profiles
  FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();

CREATE TABLE homeowner_profile_facts (
  tenant_id    uuid NOT NULL,
  profile_id   uuid NOT NULL,
  field        text NOT NULL CHECK (field IN ('last_transfer_date','last_transfer_price_cents','county_market_value_cents',
                 'assessed_value_cents','annual_tax_cents','tax_year','exemption_legal_residence','exemption_homestead',
                 'owner_mailing_address')),
  date_value   date,
  cents_value  bigint CHECK (cents_value >= 0),
  int_value    integer,
  bool_value   boolean,
  text_value   text CHECK (char_length(text_value) <= 300 AND text_value !~ '[[:cntrl:]]'),
  source       text NOT NULL CHECK (source ~ '^[A-Za-z0-9 .,:()_-]{1,80}$'),
  as_of        date,
  PRIMARY KEY (tenant_id, profile_id, field),
  FOREIGN KEY (tenant_id, profile_id) REFERENCES homeowner_profiles (tenant_id, id) ON DELETE CASCADE,
  CHECK (num_nonnulls(date_value, cents_value, int_value, bool_value, text_value) = 1),
  CHECK (CASE field
           WHEN 'last_transfer_date'         THEN date_value IS NOT NULL
           WHEN 'last_transfer_price_cents'  THEN cents_value IS NOT NULL
           WHEN 'county_market_value_cents'  THEN cents_value IS NOT NULL
           WHEN 'assessed_value_cents'       THEN cents_value IS NOT NULL
           WHEN 'annual_tax_cents'           THEN cents_value IS NOT NULL
           WHEN 'tax_year'                   THEN int_value IS NOT NULL AND int_value BETWEEN 1900 AND 2200
           WHEN 'exemption_legal_residence'  THEN bool_value IS NOT NULL
           WHEN 'exemption_homestead'        THEN bool_value IS NOT NULL
           WHEN 'owner_mailing_address'      THEN text_value IS NOT NULL
           ELSE false
         END)
);

-- -----------------------------------------------------------------------------
-- Guards (invoker)
-- -----------------------------------------------------------------------------
CREATE FUNCTION app.homeowner_profiles_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF TG_OP = 'UPDATE' THEN
    IF NEW.contact_id IS DISTINCT FROM OLD.contact_id OR NEW.contact_address_id IS DISTINCT FROM OLD.contact_address_id THEN
      RAISE EXCEPTION 'HOMEOWNER_PROFILE_SUBJECT_FIXED: a profile''s contact and address never change'
        USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.status = 'matched' AND NEW.status <> 'matched' AND EXISTS (
         SELECT 1 FROM public.homeowner_profile_facts f WHERE f.tenant_id = NEW.tenant_id AND f.profile_id = NEW.id) THEN
      RAISE EXCEPTION 'HOMEOWNER_FACTS_REMAIN: delete a profile''s facts before it leaves matched'
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM public.contact_addresses a
                  WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.contact_address_id AND a.contact_id = NEW.contact_id) THEN
    RAISE EXCEPTION 'HOMEOWNER_ADDRESS_NOT_CONTACTS: the subject address belongs to another contact'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.homeowner_profiles_guard() FROM PUBLIC;
CREATE TRIGGER homeowner_profiles_guard BEFORE INSERT OR UPDATE ON homeowner_profiles
  FOR EACH ROW EXECUTE FUNCTION app.homeowner_profiles_guard();

CREATE FUNCTION app.homeowner_facts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF NOT EXISTS (SELECT 1 FROM public.homeowner_profiles p
                  WHERE p.tenant_id = NEW.tenant_id AND p.id = NEW.profile_id AND p.status = 'matched') THEN
    RAISE EXCEPTION 'HOMEOWNER_FACT_NOT_MATCHED: facts are kept only for a matched profile'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.homeowner_facts_guard() FROM PUBLIC;
CREATE TRIGGER homeowner_facts_guard BEFORE INSERT OR UPDATE ON homeowner_profile_facts
  FOR EACH ROW EXECUTE FUNCTION app.homeowner_facts_guard();

-- -----------------------------------------------------------------------------
-- Row-level security (Layer 1 as CONVENTIONS §4), policies and grants
-- -----------------------------------------------------------------------------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['homeowner_profiles','homeowner_profile_facts'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON public.%I AS RESTRICTIVE FOR ALL
      USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')
      WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_ins ON public.%I AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> 'support')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_upd ON public.%I AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> 'support')$p$, t);
    EXECUTE format($p$CREATE POLICY support_read_only_del ON public.%I AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> 'support')$p$, t);
    EXECUTE format($p$CREATE POLICY %I ON public.%I FOR ALL
      USING ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()))
      WITH CHECK ((SELECT app.actor_kind()) = 'system' AND (SELECT app.is_tenant_wide()))$p$,
      CASE t WHEN 'homeowner_profiles' THEN 'profiles_write' ELSE 'facts_write' END, t);
    EXECUTE format('CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON public.%I '
                   'FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write()', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO app_user', t);
  END LOOP;
END $$;

-- agents read a profile exactly when they see the contact's detail, and only until it expires (E587)
CREATE POLICY profiles_select ON homeowner_profiles FOR SELECT USING (
  retention_until > now() AND EXISTS (SELECT 1 FROM app.contact_detail_row(tenant_id, contact_id)));
CREATE POLICY facts_select ON homeowner_profile_facts FOR SELECT USING (EXISTS (
  SELECT 1 FROM homeowner_profiles p WHERE p.tenant_id = homeowner_profile_facts.tenant_id AND p.id = homeowner_profile_facts.profile_id));

-- -----------------------------------------------------------------------------
-- The outreach clearance pack (D10, D11): shipped unreviewed, gates nothing (no outreach path exists).
-- -----------------------------------------------------------------------------
INSERT INTO jurisdiction_packs (key, version, status, rules, reviewed_by_counsel_at, notes) VALUES
  ('platform:public_records_outreach', '2026.11.0', 'published', '{"states":["SC"]}', NULL,
   'Outreach using personal information from county public records (D10, D11). Gates nothing in this build: no outreach path exists. South Carolina only; other states VERIFY WITH COUNSEL. Engineering placeholder. VERIFY WITH COUNSEL.');

-- -----------------------------------------------------------------------------
-- Self-check
-- -----------------------------------------------------------------------------
DO $$
DECLARE t text; bad text := '';
BEGIN
  FOREACH t IN ARRAY ARRAY['homeowner_profiles','homeowner_profile_facts'] LOOP
    IF NOT (SELECT c.relrowsecurity AND c.relforcerowsecurity FROM pg_class c WHERE c.oid = ('public.' || t)::regclass) THEN
      bad := bad || ' ' || t || ':force_rls';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = t
                    AND p.policyname = 'tenant_isolation' AND p.permissive = 'RESTRICTIVE') THEN
      bad := bad || ' ' || t || ':tenant_isolation';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger g WHERE g.tgrelid = ('public.' || t)::regclass AND g.tgname = 'support_read_only') THEN
      bad := bad || ' ' || t || ':support_trigger';
    END IF;
  END LOOP;
  IF EXISTS (SELECT 1 FROM jurisdiction_packs WHERE key = 'platform:public_records_outreach' AND reviewed_by_counsel_at IS NOT NULL) THEN
    bad := bad || ' pack_reviewed';
  END IF;
  IF bad <> '' THEN RAISE EXCEPTION 'homeowner_profiles self-check failed:%', bad; END IF;
END $$;
