-- Batch 18 round 3 item 1 (owner boundary B18S-5): "No automated contact for leads from this source" covers the people an
-- import brought in. Security notes: docs/ARCHITECTURE.md §21.66.
--
--   A Follow Up Boss or CSV import keeps a person's source only as a label: original_source_detail.import_source on a
--   person it created (imports/commit.ts, the first 120 characters) and normalized.leadSourceLabel on every import record
--   (a person it created and a person already here that it matched). Nothing links that label to a lead_sources row, so
--   0096's app.person_no_ai_care_source never saw these people, and a referral partner's people migrated from FUB stayed
--   open to plans, triggers, bulk sends and AI care.
--   * lead_sources.import_labels (text[], default empty: every existing source and person is unchanged): the imported
--     source labels, exactly as the import stored them, that mean this source. Only an Owner, as themselves, changes it
--     (app.lead_sources_import_labels_guard, an invoker trigger beside 0094's guard; the API route is Owner-only too,
--     core lead_source.ai_care). The API keeps one label on one source (a move takes it off the other); were two sources
--     ever to hold one label, either one's setting counts (the conservative reading).
--   * app.person_from_lead_source(tenant, contact, source) (SECURITY DEFINER, owned by app_definer, search_path pinned,
--     tenant_id = app.tenant_id() explicit, returns one boolean): whether the source sent the person (any record of the
--     merge tree, app.contact_person_ids, read past the caller's RLS): a record's original source, any inquiry of it
--     (0096), or an imported label the source holds, on a record the import created, on any import record that
--     targeted a record of the person, or on any import record the import matched to one (a person already here, by
--     phone or email, whose record waits in review or was left out: the other system still says the source sent them). Used by the definer below and by leads/sources.ts to count only this source's
--     people when the setting is turned on or a label is mapped (round 3 item 4).
--   * app.person_no_ai_care_source(tenant, contact) is replaced (same signature, owner, pinned path, tenant check, one
--     boolean): true when any source marked no_ai_care sent the person (app.person_from_lead_source). Its callers (every
--     automated path, dispatch TX1, 0094's and 0098's guards) pick up imported people without a change of their own.
--   * import_records_target_contact and import_records_match_contact: indexes on the import records that targeted or
--     matched a contact, for the lookups above.
--   No table, policy, grant or retention change; no existing record is touched. The definer's owner, REVOKE and GRANT
--   are restated, and the self-check asserts both definers and the guard.

ALTER TABLE lead_sources ADD COLUMN import_labels text[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(import_labels) <= 200 AND array_position(import_labels, NULL) IS NULL AND NOT ('' = ANY (import_labels)));
COMMENT ON COLUMN lead_sources.import_labels IS
  'b18 round 3 item 1: imported source labels (exactly as a FUB or CSV import stored them) that mean this source (Owner only; app.lead_sources_import_labels_guard). app.person_from_lead_source counts the people they label as sent by this source.';

CREATE INDEX import_records_target_contact ON import_records (tenant_id, target_id) WHERE target_table = 'contacts';
CREATE INDEX import_records_match_contact ON import_records (tenant_id, match_contact_id) WHERE match_contact_id IS NOT NULL;

CREATE FUNCTION app.lead_sources_import_labels_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF app.tenant_id() IS NOT NULL AND NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN RETURN NEW; END IF;   -- RLS rejects
  IF (TG_OP = 'INSERT' AND cardinality(NEW.import_labels) > 0) OR (TG_OP = 'UPDATE' AND NEW.import_labels IS DISTINCT FROM OLD.import_labels) THEN
    IF NOT (app.actor_kind() = 'user' AND app.my_role() = 'owner') THEN
      RAISE EXCEPTION 'LEAD_SOURCE_IMPORT_LABELS_OWNER_ONLY: only the Owner maps an imported source label to a lead source'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.lead_sources_import_labels_guard() FROM PUBLIC;
CREATE TRIGGER lead_sources_import_labels_guard BEFORE INSERT OR UPDATE OF import_labels ON lead_sources
  FOR EACH ROW EXECUTE FUNCTION app.lead_sources_import_labels_guard();

CREATE FUNCTION app.person_from_lead_source(p_tenant uuid, p_contact uuid, p_source uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH person AS (SELECT unnest(app.contact_person_ids(p_tenant, p_contact)) AS id),
       src AS (SELECT s.import_labels AS labels FROM public.lead_sources s WHERE s.tenant_id = p_tenant AND s.id = p_source)
  SELECT COALESCE(p_tenant = app.tenant_id(), false) AND EXISTS (SELECT 1 FROM src) AND (
    EXISTS (SELECT 1 FROM public.contacts c WHERE c.tenant_id = p_tenant AND c.id IN (SELECT id FROM person) AND c.original_lead_source_id = p_source)
    OR EXISTS (SELECT 1 FROM public.lead_inquiries i WHERE i.tenant_id = p_tenant AND i.contact_id IN (SELECT id FROM person) AND i.lead_source_id = p_source)
    OR EXISTS (SELECT 1 FROM src, public.contacts c WHERE cardinality(src.labels) > 0 AND c.tenant_id = p_tenant AND c.id IN (SELECT id FROM person)
                AND (c.original_source_detail ->> 'import_source') = ANY (src.labels))
    OR EXISTS (SELECT 1 FROM src, public.import_records r WHERE cardinality(src.labels) > 0 AND r.tenant_id = p_tenant AND r.target_table = 'contacts'
                AND r.target_id IN (SELECT id FROM person) AND left(r.normalized ->> 'leadSourceLabel', 120) = ANY (src.labels))
    OR EXISTS (SELECT 1 FROM src, public.import_records r WHERE cardinality(src.labels) > 0 AND r.tenant_id = p_tenant
                AND r.match_contact_id IN (SELECT id FROM person) AND left(r.normalized ->> 'leadSourceLabel', 120) = ANY (src.labels)))
$$;
ALTER FUNCTION app.person_from_lead_source(uuid, uuid, uuid) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.person_from_lead_source(uuid, uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.person_from_lead_source(uuid, uuid, uuid) TO app_user;

CREATE OR REPLACE FUNCTION app.person_no_ai_care_source(p_tenant uuid, p_contact uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT COALESCE(p_tenant = app.tenant_id(), false) AND EXISTS (
    SELECT 1 FROM public.lead_sources s WHERE s.tenant_id = p_tenant AND s.no_ai_care AND app.person_from_lead_source(p_tenant, p_contact, s.id))
$$;
ALTER FUNCTION app.person_no_ai_care_source(uuid, uuid) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.person_no_ai_care_source(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.person_no_ai_care_source(uuid, uuid) TO app_user;

-- Self-check: both are definers owned by app_definer with their path pinned, executable by app_user and not by PUBLIC;
-- the guard is an invoker that pins its path; no existing source holds a label.
DO $$
DECLARE f text; p record;
BEGIN
  FOREACH f IN ARRAY ARRAY['app.person_from_lead_source(uuid,uuid,uuid)', 'app.person_no_ai_care_source(uuid,uuid)'] LOOP
    SELECT r.rolname AS owner, x.prosecdef AS definer, x.proconfig AS config, x.proacl AS acl INTO p
      FROM pg_proc x JOIN pg_roles r ON r.oid = x.proowner WHERE x.oid = f::regprocedure;
    IF p.owner <> 'app_definer' OR NOT p.definer OR NOT ('search_path=pg_catalog, public' = ANY (p.config)) THEN
      RAISE EXCEPTION '0099: % must be a definer owned by app_definer with a pinned search_path', f;
    END IF;
    IF NOT has_function_privilege('app_user', f, 'EXECUTE') OR EXISTS (SELECT 1 FROM aclexplode(p.acl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
      RAISE EXCEPTION '0099: % EXECUTE must be app_user only', f;
    END IF;
  END LOOP;
  SELECT prosecdef AS definer, proconfig AS config INTO p FROM pg_proc WHERE oid = 'app.lead_sources_import_labels_guard()'::regprocedure;
  IF p.definer OR NOT ('search_path=pg_catalog, public' = ANY (p.config)) THEN
    RAISE EXCEPTION '0099: app.lead_sources_import_labels_guard must be an invoker that pins its search_path';
  END IF;
  IF EXISTS (SELECT 1 FROM lead_sources WHERE cardinality(import_labels) > 0) THEN RAISE EXCEPTION '0099: an existing source holds a label'; END IF;
END $$;
