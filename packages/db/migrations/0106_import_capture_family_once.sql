-- Compute the targeted person family once per capture statement, including generic plans.
-- Preserve tenant/source predicates, association history, privileges and all trigger backstops.
CREATE OR REPLACE FUNCTION app.capture_import_sources(p_tenant uuid, p_contact uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_tenant IS DISTINCT FROM app.tenant_id() THEN RETURN; END IF;
  INSERT INTO public.contact_import_sources (tenant_id, contact_id, lead_source_id)
  SELECT c.tenant_id, c.id, s.id FROM public.contacts c JOIN public.lead_sources s ON s.tenant_id = c.tenant_id
   WHERE c.tenant_id = p_tenant AND (p_contact IS NULL OR c.id = ANY((SELECT app.contact_person_ids(p_tenant,p_contact))::uuid[]))
     AND cardinality(s.import_labels) > 0 AND (app.person_from_lead_source(p_tenant,c.id,s.id)
       OR EXISTS (SELECT 1 FROM app.person_import_labels(p_tenant,c.id) l WHERE l.label = ANY(s.import_labels)))
  ON CONFLICT DO NOTHING;
END $$;
ALTER FUNCTION app.capture_import_sources(uuid,uuid) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.capture_import_sources(uuid,uuid) FROM PUBLIC;

