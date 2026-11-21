-- 0124: Follow Up Boss deals and appointments are imported (owner reversal of B7, 2026-11-21).
-- Tasks stay count-only. Appointments and deals become import stages 7 and 8, after consent,
-- so a revert removes appointments before the deals they could name.
--
-- An imported appointment is live on the calendar but reminders_enabled is false until cutover
-- (nothing here sends a reminder; the flag is what a later sender must honor).
--
-- Commission rows are written by the import system. Humans still own every read and every later
-- edit (R-PERM-10): the new policy is INSERT-only for the tenant-wide system actor.

ALTER TABLE import_stages DROP CONSTRAINT import_stages_category_check;
ALTER TABLE import_stages ADD CONSTRAINT import_stages_category_check
  CHECK (category IN ('contacts','ownership','notes','messages','call_recordings','consent','deals','appointments'));

DO $$
DECLARE c name;
BEGIN
  SELECT con.conname INTO c
    FROM pg_constraint con
   WHERE con.conrelid = 'public.import_stages'::regclass
     AND pg_get_constraintdef(con.oid) LIKE '%consent%THEN 6%';
  IF c IS NULL THEN
    RAISE EXCEPTION 'import_stages seq check not found';
  END IF;
  EXECUTE format('ALTER TABLE public.import_stages DROP CONSTRAINT %I', c);
END $$;

ALTER TABLE import_stages ADD CONSTRAINT import_stages_seq_check
  CHECK (seq = CASE category
    WHEN 'contacts' THEN 1 WHEN 'ownership' THEN 2 WHEN 'notes' THEN 3
    WHEN 'messages' THEN 4 WHEN 'call_recordings' THEN 5 WHEN 'consent' THEN 6
    WHEN 'deals' THEN 7 WHEN 'appointments' THEN 8 END);

ALTER TABLE external_refs DROP CONSTRAINT external_refs_entity_type_check;
ALTER TABLE external_refs ADD CONSTRAINT external_refs_entity_type_check
  CHECK (entity_type IN ('contact','note','message','call','recording','user','deal','appointment'));

ALTER TABLE appointments ADD COLUMN reminders_enabled boolean NOT NULL DEFAULT true;

-- R-PERM-10 stays: a human Owner, Admin, the deal's agent, or their Team Lead can read and edit.
-- The import (system, tenant-wide, app.actor_via = import) may insert the row it just created
-- and cannot select it back. An assistant or any other system via cannot.
CREATE POLICY financials_import_insert ON deal_financials FOR INSERT
  WITH CHECK (
    (SELECT app.actor_kind()) = 'system'
    AND (SELECT app.is_tenant_wide())
    AND current_setting('app.actor_via', true) = 'import'
  );

-- deal_stage_history is append-only (app.reject_mutation). An imported deal's one history row was written by
-- the stage trigger, and the deal cannot be removed while it remains (no ON DELETE CASCADE). The revert
-- definer may delete those rows and no other append-only table.
CREATE OR REPLACE FUNCTION app.reject_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_user = 'app_retention' THEN
    RETURN OLD;
  END IF;
  IF TG_OP = 'DELETE' AND current_user = 'app_definer' AND TG_TABLE_NAME = 'deal_stage_history' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'APPEND_ONLY: % on % rejected', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END $$;

-- SECURITY REVIEW ITEM (CONVENTIONS §4): replaces the body of app.import_revert_delete. Owner,
-- search_path, grants and signature are unchanged. Adds appointments and deals, deleted only when
-- an imported record of the reverting stage points at the row and the external ref is this batch's.
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
  IF p_table NOT IN ('notes','messages','calls','contact_points','contact_addresses','appointments','deals') THEN
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
      ELSIF p_table = 'contact_addresses' THEN
        DELETE FROM public.contact_addresses t WHERE t.tenant_id = app.tenant_id() AND t.id = v_id AND t.import_batch_id = v_batch;
      ELSIF p_table = 'appointments' THEN
        DELETE FROM public.appointments t
         WHERE t.tenant_id = app.tenant_id() AND t.id = v_id AND t.created_by_kind = 'import'
           AND EXISTS (SELECT 1 FROM public.import_records r WHERE r.tenant_id = t.tenant_id AND r.stage_id = p_stage_id AND r.target_id = t.id)
           AND EXISTS (SELECT 1 FROM public.external_refs er WHERE er.tenant_id = t.tenant_id AND er.entity_type = 'appointment'
                          AND er.entity_id = t.id AND er.import_batch_id = v_batch);
      ELSE
        -- stage history does not cascade; the rest does, but delete them explicitly so a later
        -- restrict on one child cannot leave the others behind.
        v_n := 0;
        IF EXISTS (
          SELECT 1 FROM public.deals d
           WHERE d.tenant_id = app.tenant_id() AND d.id = v_id
             AND EXISTS (SELECT 1 FROM public.import_records r WHERE r.tenant_id = d.tenant_id AND r.stage_id = p_stage_id AND r.target_id = d.id)
             AND EXISTS (SELECT 1 FROM public.external_refs er WHERE er.tenant_id = d.tenant_id AND er.entity_type = 'deal'
                            AND er.entity_id = d.id AND er.import_batch_id = v_batch)
        ) THEN
          DELETE FROM public.deal_stage_history h WHERE h.tenant_id = app.tenant_id() AND h.deal_id = v_id;
          DELETE FROM public.deal_dates x WHERE x.tenant_id = app.tenant_id() AND x.deal_id = v_id;
          DELETE FROM public.deal_contacts x WHERE x.tenant_id = app.tenant_id() AND x.deal_id = v_id;
          DELETE FROM public.deal_members x WHERE x.tenant_id = app.tenant_id() AND x.deal_id = v_id;
          DELETE FROM public.deal_financials x WHERE x.tenant_id = app.tenant_id() AND x.deal_id = v_id;
          DELETE FROM public.deals d WHERE d.tenant_id = app.tenant_id() AND d.id = v_id;
          GET DIAGNOSTICS v_n = ROW_COUNT;
        END IF;
      END IF;
      IF p_table <> 'deals' THEN
        GET DIAGNOSTICS v_n = ROW_COUNT;
      END IF;
      IF v_n = 1 THEN
        IF p_table = 'calls' AND v_objects IS NOT NULL THEN
          UPDATE public.stored_objects o SET deleted_at = COALESCE(o.deleted_at, now())
           WHERE o.tenant_id = app.tenant_id() AND o.id = ANY (v_objects);
        END IF;
        RETURN NEXT v_id;
      END IF;
    EXCEPTION WHEN foreign_key_violation THEN
      -- something now references the row: it stays for a human decision
      NULL;
    END;
  END LOOP;
  RETURN;
END $$;

ALTER FUNCTION app.import_revert_delete(uuid, text, uuid[]) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.import_revert_delete(uuid, text, uuid[]) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.import_revert_delete(uuid, text, uuid[]) TO app_user;
GRANT DELETE ON appointments, deals, deal_stage_history, deal_dates, deal_contacts, deal_members, deal_financials TO app_definer;
