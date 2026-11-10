-- 0010 (BUILD_PLAN module 16, api/imports): correction of the SECURITY DEFINER app.import_revert_delete (0009).
--
-- SECURITY REVIEW ITEM (CONVENTIONS §4): replaces the body of an existing SECURITY DEFINER function; owner,
-- search_path, grants and signature are unchanged.
--
-- Defect fixed: for p_table = 'calls' the 0009 body marked a call's recording object deleted BEFORE checking
-- that the call was written by an import record of the reverting stage. Called with the id of any imported
-- call (another stage's, another batch's), it deleted nothing but still sent that call's recording to the
-- blob-delete job: a recording lost without a revert. Now the recording objects are collected first, the
-- call is deleted under the stage check, and only a call that was actually deleted takes its recordings'
-- objects with it.

CREATE OR REPLACE FUNCTION app.import_revert_delete(p_stage_id uuid, p_table text, p_ids uuid[])
RETURNS SETOF uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_batch uuid;
  v_status text;
  v_id uuid;
  v_n integer;
  v_objects uuid[];
BEGIN
  IF app.tenant_id() IS NULL OR NOT app.is_tenant_wide() OR app.actor_kind() NOT IN ('user','system') THEN
    RAISE EXCEPTION 'IMPORT_REVERT_FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT s.batch_id, s.status INTO v_batch, v_status
    FROM public.import_stages s WHERE s.tenant_id = app.tenant_id() AND s.id = p_stage_id;
  IF v_batch IS NULL OR v_status <> 'reverting' THEN
    RAISE EXCEPTION 'IMPORT_STAGE_NOT_REVERTING' USING ERRCODE = 'check_violation';
  END IF;
  IF p_table NOT IN ('notes','messages','calls','contact_points','contact_addresses') THEN
    RAISE EXCEPTION 'IMPORT_REVERT_TABLE' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  FOREACH v_id IN ARRAY COALESCE(p_ids, ARRAY[]::uuid[]) LOOP
    BEGIN
      IF p_table = 'notes' THEN
        DELETE FROM public.notes t WHERE t.tenant_id = app.tenant_id() AND t.id = v_id AND t.imported
           AND EXISTS (SELECT 1 FROM public.import_records r WHERE r.tenant_id = t.tenant_id AND r.id = t.import_record_id AND r.stage_id = p_stage_id);
      ELSIF p_table = 'messages' THEN
        DELETE FROM public.messages t WHERE t.tenant_id = app.tenant_id() AND t.id = v_id AND t.imported
           AND EXISTS (SELECT 1 FROM public.import_records r WHERE r.tenant_id = t.tenant_id AND r.id = t.import_record_id AND r.stage_id = p_stage_id);
      ELSIF p_table = 'calls' THEN
        SELECT array_agg(rc.object_id) INTO v_objects
          FROM public.recordings rc
         WHERE rc.tenant_id = app.tenant_id() AND rc.call_id = v_id AND rc.source = 'import_fub';
        DELETE FROM public.calls t WHERE t.tenant_id = app.tenant_id() AND t.id = v_id AND t.imported
           AND EXISTS (SELECT 1 FROM public.import_records r WHERE r.tenant_id = t.tenant_id AND r.id = t.import_record_id AND r.stage_id = p_stage_id);
      ELSIF p_table = 'contact_points' THEN
        DELETE FROM public.contact_points t WHERE t.tenant_id = app.tenant_id() AND t.id = v_id AND t.import_batch_id = v_batch;
      ELSE
        DELETE FROM public.contact_addresses t WHERE t.tenant_id = app.tenant_id() AND t.id = v_id AND t.import_batch_id = v_batch;
      END IF;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n = 1 THEN
        IF p_table = 'calls' AND v_objects IS NOT NULL THEN
          UPDATE public.stored_objects o SET deleted_at = COALESCE(o.deleted_at, now())
           WHERE o.tenant_id = app.tenant_id() AND o.id = ANY (v_objects);
        END IF;
        RETURN NEXT v_id;
      END IF;
    EXCEPTION WHEN foreign_key_violation THEN
      -- something now references the row (evidence, a claim, a reply): it stays for a human decision
      NULL;
    END;
  END LOOP;
  RETURN;
END $$;
ALTER FUNCTION app.import_revert_delete(uuid, text, uuid[]) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.import_revert_delete(uuid, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.import_revert_delete(uuid, text, uuid[]) TO app_user;
