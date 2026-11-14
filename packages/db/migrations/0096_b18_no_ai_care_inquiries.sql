-- Batch 18 review B18S-1 (owner product boundary 2026-11-14; item f follow-up): "No AI care for leads from this source"
-- also covers a person who is already in the CRM when the source sends them. Security notes: docs/ARCHITECTURE.md §21.63.
--
--   0094's app.person_no_ai_care_source asked only which source first created each record of the person
--   (contacts.original_lead_source_id, fixed once set: ATTRIBUTION_IMMUTABLE, 0071). An inquiry from a marked source
--   that the intake attached to an existing person (a past web lead, sphere, an import, a person entered by hand; outcome
--   'attached' or 'reinquiry') never changes that column, so the start refusal, Continue, chain link 11 and 0094's
--   ai_isa_assignments_source_guard all let AI care start, continue or resume for a lead the source sent.
--   * app.person_no_ai_care_source(tenant, contact) is replaced (same signature, same owner app_definer, same pinned
--     search_path, same explicit tenant check, still one boolean): it is also true when any lead_inquiries row of any
--     record of the person (app.contact_person_ids, read past the caller's RLS) has a lead_source_id marked no_ai_care.
--     Every outcome counts, duplicate_ignored included (that row is the source sending the person again). Its callers
--     (isa/controls.ts startRefusal, isa/repo.ts chain link 11, leads/sources.ts when the setting is turned on, and
--     0094's trigger for an insert and a resume) pick the change up without any change of their own.
--   No table, column, policy, grant or retention change; no existing record is touched. The function body is replaced
--   in place (CREATE OR REPLACE keeps its owner and grants); the owner, the REVOKE and the GRANT are restated anyway, and
--   the self-check asserts them.

CREATE OR REPLACE FUNCTION app.person_no_ai_care_source(p_tenant uuid, p_contact uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH person AS (SELECT unnest(app.contact_person_ids(p_tenant, p_contact)) AS id)
  SELECT COALESCE(p_tenant = app.tenant_id(), false) AND (
    EXISTS (SELECT 1 FROM public.contacts c JOIN public.lead_sources s ON s.tenant_id = c.tenant_id AND s.id = c.original_lead_source_id
             WHERE c.tenant_id = p_tenant AND c.id IN (SELECT id FROM person) AND s.no_ai_care)
    OR EXISTS (SELECT 1 FROM public.lead_inquiries i JOIN public.lead_sources s ON s.tenant_id = i.tenant_id AND s.id = i.lead_source_id
                WHERE i.tenant_id = p_tenant AND i.contact_id IN (SELECT id FROM person) AND s.no_ai_care))
$$;
ALTER FUNCTION app.person_no_ai_care_source(uuid, uuid) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.person_no_ai_care_source(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.person_no_ai_care_source(uuid, uuid) TO app_user;

-- Self-check: still a definer owned by app_definer with its path pinned, executable by app_user and not by PUBLIC.
DO $$
DECLARE p record;
BEGIN
  SELECT r.rolname AS owner, f.prosecdef AS definer, f.proconfig AS config, f.proacl AS acl INTO p
    FROM pg_proc f JOIN pg_roles r ON r.oid = f.proowner WHERE f.oid = 'app.person_no_ai_care_source(uuid,uuid)'::regprocedure;
  IF p.owner <> 'app_definer' OR NOT p.definer OR NOT ('search_path=pg_catalog, public' = ANY (p.config)) THEN
    RAISE EXCEPTION '0096: app.person_no_ai_care_source must stay a definer owned by app_definer with a pinned search_path';
  END IF;
  IF NOT has_function_privilege('app_user', 'app.person_no_ai_care_source(uuid,uuid)', 'EXECUTE')
     OR EXISTS (SELECT 1 FROM aclexplode(p.acl) a WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') THEN
    RAISE EXCEPTION '0096: app.person_no_ai_care_source EXECUTE must be app_user only';
  END IF;
END $$;
