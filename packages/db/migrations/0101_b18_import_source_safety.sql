-- Imported sources require an Owner-confirmed exact mapping. See docs/OWNER_SOURCE_SAFETY.md.
-- Retain proven person/source associations independently of editable label mappings.
CREATE TABLE contact_import_sources (
  tenant_id uuid NOT NULL,
  contact_id uuid NOT NULL,
  lead_source_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, contact_id, lead_source_id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, lead_source_id) REFERENCES lead_sources (tenant_id, id)
);
ALTER TABLE contact_import_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_import_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON contact_import_sources AS RESTRICTIVE
  USING (tenant_id = app.tenant_id() AND app.principal_type() = 'staff')
  WITH CHECK (tenant_id = app.tenant_id() AND app.principal_type() = 'staff');
-- No application write grant. Only the reviewed definer captures associations, never removes them.
GRANT SELECT, INSERT ON contact_import_sources TO app_definer;
GRANT SELECT, DELETE ON contact_import_sources TO app_retention;

CREATE FUNCTION app.import_label_key(p_label text) RETURNS text
LANGUAGE sql IMMUTABLE SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN p_label IS NULL OR btrim(p_label, U&'\0009\000a\000b\000c\000d\0020\00a0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200a\2028\2029\202f\205f\3000\feff') = '' THEN '' ELSE p_label END
$$;
ALTER FUNCTION app.import_label_key(text) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.import_label_key(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.import_label_key(text) TO app_user;

CREATE FUNCTION app.person_import_labels(p_tenant uuid, p_contact uuid) RETURNS TABLE(label text)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH person AS (SELECT unnest(app.contact_person_ids(p_tenant, p_contact)) AS id)
  SELECT c.original_source_detail->>'import_source' FROM public.contacts c
   WHERE p_tenant = app.tenant_id() AND c.tenant_id = p_tenant AND c.id IN (SELECT id FROM person)
     AND (c.import_batch_id IS NOT NULL OR c.original_source_detail ? 'import_system')
     -- Prefer the full raw import record over the legacy truncated contact display label.
     AND NOT EXISTS (SELECT 1 FROM public.import_records r WHERE r.tenant_id = p_tenant
       AND r.normalized->>'category' = 'contacts' AND ((r.target_table = 'contacts' AND r.target_id = c.id) OR r.match_contact_id = c.id))
  UNION ALL
  SELECT r.normalized->>'leadSourceLabel' FROM public.import_records r
   WHERE p_tenant = app.tenant_id() AND r.tenant_id = p_tenant AND r.normalized->>'category' = 'contacts'
     AND ((r.target_table = 'contacts' AND r.target_id IN (SELECT id FROM person)) OR r.match_contact_id IN (SELECT id FROM person))
$$;
ALTER FUNCTION app.person_import_labels(uuid,uuid) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.person_import_labels(uuid,uuid) FROM PUBLIC;
-- This function returns raw labels and is internal only; app_user receives only boolean/code helpers.

CREATE FUNCTION app.capture_import_sources(p_tenant uuid, p_contact uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF p_tenant IS DISTINCT FROM app.tenant_id() THEN RETURN; END IF;
  INSERT INTO public.contact_import_sources (tenant_id, contact_id, lead_source_id)
  SELECT c.tenant_id, c.id, s.id FROM public.contacts c JOIN public.lead_sources s ON s.tenant_id = c.tenant_id
   WHERE c.tenant_id = p_tenant AND (p_contact IS NULL OR c.id = ANY(app.contact_person_ids(p_tenant,p_contact)))
     AND cardinality(s.import_labels) > 0 AND (app.person_from_lead_source(p_tenant,c.id,s.id)
       OR EXISTS (SELECT 1 FROM app.person_import_labels(p_tenant,c.id) l WHERE l.label = ANY(s.import_labels)))
  ON CONFLICT DO NOTHING;
END $$;
ALTER FUNCTION app.capture_import_sources(uuid,uuid) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.capture_import_sources(uuid,uuid) FROM PUBLIC;

CREATE OR REPLACE FUNCTION app.person_from_lead_source(p_tenant uuid, p_contact uuid, p_source uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH person AS (SELECT unnest(app.contact_person_ids(p_tenant, p_contact)) AS id),
       src AS (SELECT s.import_labels AS labels FROM public.lead_sources s WHERE s.tenant_id = p_tenant AND s.id = p_source)
  SELECT COALESCE(p_tenant = app.tenant_id(), false) AND EXISTS (SELECT 1 FROM src) AND (
    EXISTS (SELECT 1 FROM public.contact_import_sources h WHERE h.tenant_id = p_tenant AND h.contact_id IN (SELECT id FROM person) AND h.lead_source_id = p_source) OR
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

-- Prohibitions win over missing classification. The old boolean remains the common safety gate
-- for all existing AI-care, voice, enrollment and bulk paths.
CREATE FUNCTION app.person_source_refusal(p_tenant uuid, p_contact uuid) RETURNS text
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT CASE WHEN p_tenant IS DISTINCT FROM app.tenant_id() THEN NULL
    WHEN EXISTS (SELECT 1 FROM public.lead_sources s WHERE s.tenant_id = p_tenant AND s.no_ai_care
      AND app.person_from_lead_source(p_tenant,p_contact,s.id)) THEN 'SOURCE_NO_AUTOMATED_CONTACT'
    -- ECMAScript trim whitespace only identifies missing evidence; labels are never normalized for matching.
    WHEN EXISTS (SELECT 1 FROM app.person_import_labels(p_tenant,p_contact) l
      WHERE l.label IS NULL OR app.import_label_key(l.label) = '' OR
        (SELECT count(*) FROM public.lead_sources s WHERE s.tenant_id = p_tenant AND l.label = ANY(s.import_labels)) <> 1)
      THEN 'SOURCE_UNCLASSIFIED' ELSE NULL END
$$;
ALTER FUNCTION app.person_source_refusal(uuid,uuid) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.person_source_refusal(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.person_source_refusal(uuid,uuid) TO app_user;
CREATE OR REPLACE FUNCTION app.person_no_ai_care_source(p_tenant uuid,p_contact uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
 SELECT app.person_source_refusal(p_tenant,p_contact) IS NOT NULL
$$;
ALTER FUNCTION app.person_no_ai_care_source(uuid,uuid) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.person_no_ai_care_source(uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.person_no_ai_care_source(uuid,uuid) TO app_user;

-- All stops happen in the transaction changing provenance/mapping, including direct database writes.
CREATE FUNCTION app.stop_import_automation(p_tenant uuid, p_contact uuid DEFAULT NULL) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE ids uuid[]; actions uuid[];
BEGIN
  IF p_tenant IS DISTINCT FROM app.tenant_id() THEN RETURN; END IF;
  SELECT array_agg(c.id) INTO ids FROM public.contacts c WHERE c.tenant_id = p_tenant
    AND (p_contact IS NULL OR c.id = ANY(app.contact_person_ids(p_tenant,p_contact)))
    AND app.person_source_refusal(p_tenant,c.id) IS NOT NULL;
  IF ids IS NULL THEN RETURN; END IF;
  UPDATE public.playbook_enrollments SET state = 'stopped',
    stop_reason = lower(app.person_source_refusal(p_tenant,contact_id)), ended_at = now(),
    next_step_due_at = NULL, paused_at = NULL, pause_reason = NULL
    WHERE tenant_id = p_tenant AND contact_id = ANY(ids) AND state IN ('active','paused');
  UPDATE public.messages m SET status = 'canceled', status_reason = app.person_source_refusal(p_tenant,m.contact_id)
    WHERE m.tenant_id = p_tenant AND m.contact_id = ANY(ids) AND m.status IN ('queued','scheduled')
      AND m.playbook_step_run_id IS NOT NULL;
  UPDATE public.playbook_step_runs r SET status = 'canceled_paused', updated_at = now()
    WHERE r.tenant_id = p_tenant AND r.status = 'scheduled' AND EXISTS (
      SELECT 1 FROM public.playbook_enrollments e WHERE e.tenant_id = r.tenant_id AND e.id = r.enrollment_id
        AND e.contact_id = ANY(ids) AND e.state = 'stopped')
      AND (r.message_id IS NULL OR EXISTS (SELECT 1 FROM public.messages m WHERE m.tenant_id = r.tenant_id AND m.id = r.message_id AND m.status = 'canceled'));
  WITH changed AS (
    UPDATE public.assistant_actions SET status = 'invalidated', payload = coalesce(payload,'{}'::jsonb) ||
      jsonb_build_object('withdrawn',jsonb_build_object('reason',app.person_source_refusal(p_tenant,contact_id),'at',now()))
    WHERE tenant_id = p_tenant AND contact_id = ANY(ids) AND status = 'proposed' AND autonomy = 'requires_approval'
      AND trigger_ref->>'kind' IN ('playbook_step','trigger_run') RETURNING id
  ) SELECT array_agg(id) INTO actions FROM changed;
  UPDATE public.priority_feed_items SET state = 'done', resolved_at = now(), snoozed_until = NULL, updated_at = now()
    WHERE tenant_id = p_tenant AND assistant_action_id = ANY(actions) AND state IN ('open','snoozed');
  UPDATE public.playbook_step_runs r SET status = 'skipped_ineligible', updated_at = now(),
    trigger_ref = coalesce(r.trigger_ref,'{}'::jsonb) || jsonb_build_object('skip',jsonb_build_object('reason',a.payload->'withdrawn'->>'reason','text','Source policy blocks automated contact; draft withdrawn.'))
    FROM public.assistant_actions a
    WHERE r.tenant_id = p_tenant AND a.tenant_id = r.tenant_id AND a.id = r.assistant_action_id
      AND r.assistant_action_id = ANY(actions) AND r.enrollment_id IS NULL AND r.status = 'converted_to_draft';
END $$;
ALTER FUNCTION app.stop_import_automation(uuid,uuid) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.stop_import_automation(uuid,uuid) FROM PUBLIC;
GRANT UPDATE ON playbook_enrollments, assistant_actions, priority_feed_items, playbook_step_runs, messages TO app_definer;

CREATE FUNCTION app.import_sources_changed() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE cid uuid;
BEGIN
  IF NEW.tenant_id IS DISTINCT FROM app.tenant_id() THEN
    RAISE EXCEPTION 'SOURCE_TENANT_CONTEXT_REQUIRED' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- A new manual contact has no prior import provenance to capture or review.
  -- Avoid serializing unrelated manual creates through the import policy gate.
  IF TG_TABLE_NAME = 'contacts' AND TG_OP = 'INSERT' THEN
    IF NEW.import_batch_id IS NULL AND NOT coalesce(NEW.original_source_detail ? 'import_system',false) THEN RETURN NEW; END IF;
  END IF;
  -- A row-trigger caller may already hold a row/contact lock. Never wait here:
  -- release those locks by aborting the transaction, then retry from its boundary.
  IF NOT pg_try_advisory_xact_lock(hashtextextended(NEW.tenant_id::text || ':import-source-mapping',0)) THEN
    RAISE EXCEPTION 'SOURCE_POLICY_RETRY: acquire the source policy lock before row locks' USING ERRCODE = 'serialization_failure';
  END IF;
  IF TG_TABLE_NAME = 'lead_sources' THEN
    PERFORM app.capture_import_sources(NEW.tenant_id,NULL);
    IF TG_WHEN = 'AFTER' THEN PERFORM app.stop_import_automation(NEW.tenant_id,NULL); END IF;
  ELSIF TG_TABLE_NAME = 'contacts' THEN
    PERFORM app.capture_import_sources(NEW.tenant_id,NEW.id);
    IF TG_WHEN = 'AFTER' THEN PERFORM app.stop_import_automation(NEW.tenant_id,NEW.id); END IF;
  ELSE
    FOR cid IN SELECT DISTINCT x FROM unnest(ARRAY[CASE WHEN NEW.target_table = 'contacts' THEN NEW.target_id END,NEW.match_contact_id]) x WHERE x IS NOT NULL LOOP
      PERFORM app.capture_import_sources(NEW.tenant_id,cid);
      IF TG_WHEN = 'AFTER' THEN PERFORM app.stop_import_automation(NEW.tenant_id,cid); END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
ALTER FUNCTION app.import_sources_changed() OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.import_sources_changed() FROM PUBLIC;
CREATE TRIGGER zz_import_sources_before BEFORE UPDATE OF import_labels ON lead_sources
 FOR EACH ROW EXECUTE FUNCTION app.import_sources_changed();
CREATE TRIGGER zz_import_sources_after AFTER INSERT OR UPDATE OF import_labels ON lead_sources
 FOR EACH ROW EXECUTE FUNCTION app.import_sources_changed();
CREATE TRIGGER zz_import_contacts_before BEFORE INSERT OR UPDATE OF original_source_detail ON contacts
 FOR EACH ROW EXECUTE FUNCTION app.import_sources_changed();
CREATE TRIGGER zz_import_contacts_after AFTER INSERT OR UPDATE OF original_source_detail ON contacts
 FOR EACH ROW EXECUTE FUNCTION app.import_sources_changed();
CREATE TRIGGER zz_import_records_before BEFORE INSERT OR UPDATE OF normalized, target_id, match_contact_id ON import_records
 FOR EACH ROW EXECUTE FUNCTION app.import_sources_changed();
CREATE TRIGGER zz_import_records_after AFTER INSERT OR UPDATE OF normalized, target_id, match_contact_id ON import_records
 FOR EACH ROW EXECUTE FUNCTION app.import_sources_changed();
CREATE OR REPLACE FUNCTION app.playbook_enrollments_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE refusal text;
BEGIN
  IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'SOURCE_TENANT_CONTEXT_REQUIRED' USING ERRCODE = 'insufficient_privilege'; END IF;
  -- The API takes a shared source lock before row locks. Legacy/direct row-first
  -- writers must retry rather than wait behind a mapper that needs their row.
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended(NEW.tenant_id::text || ':import-source-mapping',0)) THEN
    RAISE EXCEPTION 'SOURCE_POLICY_RETRY: acquire the source policy lock before row locks' USING ERRCODE = 'serialization_failure';
  END IF;
  refusal := app.person_source_refusal(NEW.tenant_id,NEW.contact_id);   -- RLS refuses another tenant's row
  IF NEW.state = 'active' AND (TG_OP = 'INSERT' OR OLD.state IS DISTINCT FROM 'active')
     AND refusal IS NOT NULL THEN
    RAISE EXCEPTION '%: automated contact blocked by source review', refusal
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.messages_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE refusal text;
BEGIN
  IF NEW.status <> 'dispatching' THEN RETURN NEW; END IF;
  IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'SOURCE_TENANT_CONTEXT_REQUIRED' USING ERRCODE = 'insufficient_privilege'; END IF;
  -- The API takes a shared source lock before row locks. Legacy/direct row-first
  -- writers must retry rather than wait behind a mapper that needs their row.
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended(NEW.tenant_id::text || ':import-source-mapping',0)) THEN
    RAISE EXCEPTION 'SOURCE_POLICY_RETRY: acquire the source policy lock before row locks' USING ERRCODE = 'serialization_failure';
  END IF;
  refusal := app.person_source_refusal(NEW.tenant_id,NEW.contact_id);   -- RLS refuses another tenant's row
  IF NEW.status = 'dispatching' AND NEW.direction = 'outbound' AND NOT NEW.imported
     AND ((NEW.initiator = 'human' AND (NEW.bulk_action_id IS NOT NULL OR NEW.marketing_piece_id IS NOT NULL))
          OR (NEW.initiator = 'system' AND NEW.action_category NOT IN ('opt_out_confirmation', 'help_reply', 'portal_login_link'))
          OR (NEW.initiator = 'assistant' AND NOT EXISTS (SELECT 1 FROM public.assistant_actions a
                WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.assistant_action_id AND a.autonomy = 'requires_approval'
                  AND COALESCE(a.trigger_ref ->> 'kind', '') NOT IN ('playbook_step', 'trigger_run'))))
     AND refusal IS NOT NULL THEN
    RAISE EXCEPTION '%: automated contact blocked by source review', refusal
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION app.calls_source_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE refusal text;
BEGIN
  IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'SOURCE_TENANT_CONTEXT_REQUIRED' USING ERRCODE = 'insufficient_privilege'; END IF;
  -- The API takes a shared source lock before row locks. Legacy/direct row-first
  -- writers must retry rather than wait behind a mapper that needs their row.
  IF NOT pg_try_advisory_xact_lock_shared(hashtextextended(NEW.tenant_id::text || ':import-source-mapping',0)) THEN
    RAISE EXCEPTION 'SOURCE_POLICY_RETRY: acquire the source policy lock before row locks' USING ERRCODE = 'serialization_failure';
  END IF;
  refusal := app.person_source_refusal(NEW.tenant_id,NEW.contact_id);   -- RLS refuses another tenant's row
  IF NEW.handled_by = 'assistant' AND (TG_OP = 'INSERT' OR OLD.handled_by IS DISTINCT FROM 'assistant')
     AND refusal IS NOT NULL THEN
    RAISE EXCEPTION '%: automated contact blocked by source review', refusal
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;

-- Cover INSERT directly into dispatching as well as UPDATE; human one-to-one exemptions remain.
DROP TRIGGER messages_source_guard ON messages;
CREATE TRIGGER messages_source_guard BEFORE INSERT OR UPDATE OF status ON messages
 FOR EACH ROW EXECUTE FUNCTION app.messages_source_guard();
-- Backfill existing associations and immediately stop existing unclassified imported contacts.
DO $$
DECLARE t uuid;
BEGIN
 FOR t IN SELECT id FROM tenants LOOP
   PERFORM set_config('app.tenant_id',t::text,true);
   PERFORM app.capture_import_sources(t,NULL);
   PERFORM app.stop_import_automation(t,NULL);
 END LOOP;
 PERFORM set_config('app.tenant_id','',true);
END $$;
CREATE OR REPLACE FUNCTION app.lead_sources_import_labels_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND cardinality(NEW.import_labels) > 0) OR
     (TG_OP = 'UPDATE' AND NEW.import_labels IS DISTINCT FROM OLD.import_labels) THEN
    IF NEW.tenant_id IS DISTINCT FROM app.tenant_id() OR
       (app.actor_kind() = 'user' AND app.my_role() = 'owner') IS NOT TRUE THEN
      RAISE EXCEPTION 'LEAD_SOURCE_IMPORT_LABELS_OWNER_ONLY: only the Owner confirms exact imported labels'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.lead_sources_import_labels_guard() FROM PUBLIC;
-- The schema requires a permissive policy as well as tenant isolation. Only the internal
-- definer role can use this policy; app_user still has no table grant or applicable policy.
CREATE POLICY internal_capture ON contact_import_sources FOR ALL TO app_definer
 USING (true) WITH CHECK (true);
