-- 0009 (BUILD_PLAN module 16, api/imports): staged dry-run-first import bookkeeping.
--
-- SECURITY REVIEW ITEM (CONVENTIONS §4): one new SECURITY DEFINER function, app.import_revert_delete.
--
-- 1. Bookkeeping columns the staged import needs and 0001 did not carry:
--    import_batches.options        the CSV column mapping + file label (no PII: header names and targets)
--    import_stages.dry_run_sha256  the dry run's snapshot digest; a commit must present the same digest
--                                  (R-IMPORT-4, E42: FUB changed ⇒ new snapshot + dry run)
--    import_stages.expected_counts the commit plan's counts after reviews (R-IMPORT-5 recount: expected vs DB)
--    import_stages.blockers        stage-level blockers of the dry run (e.g. USER_MAPPING_INCOMPLETE, R-IMPORT-8)
--    import_stages.consent_summary the consent stage's plain counts for the report copy
--    import_stages.revert_report   what a revert removed, compensated, kept and left for a human (ids + codes)
--    import_records.dry_run_outcome the outcome the dry run gave (the review list and the recount keep it
--                                  after the commit moves `outcome` to imported)
--    import_records.plan           the planned action of the dry run: the commit applies exactly this
--    import_records.created_rows   every row the commit wrote for the record ([{table, id}]), for revert
--    contact_addresses.import_batch_id  like contact_points.import_batch_id: an address an import added
-- 2. Approval and verification are by a human Owner/Admin acting as themselves (R-IMPORT-2, R-IMPORT-5):
--    a plain (invoker) trigger; memberships are readable by every member.
-- 3. app.import_revert_delete: R-IMPORT-10 deletes untouched imported history rows, but app_user has no
--    DELETE on notes/messages/calls/contact_points/contact_addresses (and must not get one). The function
--    deletes ONLY rows that an import record of the given stage wrote (imported = true and
--    import_record_id in that stage; points/addresses: import_batch_id of the stage's batch), only for a
--    tenant-wide, non-support caller in its own tenant, only while the stage is `reverting`, row by row so
--    a row that something else now references is kept (returned as not deleted: a human decides).
--    Imported recordings go with their call (FK cascade); their stored objects are marked deleted for the
--    blob-delete job. Returns the ids it deleted, nothing else.

ALTER TABLE import_batches ADD COLUMN options jsonb NOT NULL DEFAULT '{}' CHECK (jsonb_typeof(options) = 'object');

ALTER TABLE import_stages
  ADD COLUMN dry_run_sha256 text CHECK (dry_run_sha256 IS NULL OR dry_run_sha256 ~ '^[0-9a-f]{64}$'),
  ADD COLUMN expected_counts jsonb CHECK (expected_counts IS NULL OR jsonb_typeof(expected_counts) = 'object'),
  ADD COLUMN blockers jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(blockers) = 'array'),
  ADD COLUMN consent_summary jsonb CHECK (consent_summary IS NULL OR jsonb_typeof(consent_summary) = 'object'),
  ADD COLUMN revert_report jsonb CHECK (revert_report IS NULL OR jsonb_typeof(revert_report) = 'object');
ALTER TABLE import_stages ADD CONSTRAINT import_stages_dry_run_digest
  CHECK (dry_run_completed_at IS NULL OR dry_run_sha256 IS NOT NULL);
ALTER TABLE import_stages ADD CONSTRAINT import_stages_commit_expected
  CHECK (status NOT IN ('committing','committed','verified') OR expected_counts IS NOT NULL);

ALTER TABLE import_records
  ADD COLUMN dry_run_outcome text CHECK (dry_run_outcome IN ('will_import','needs_review','rejected','duplicate')),
  ADD COLUMN plan jsonb CHECK (plan IS NULL OR jsonb_typeof(plan) = 'object'),
  ADD COLUMN created_rows jsonb NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(created_rows) = 'array');
CREATE INDEX import_records_dry_run ON import_records (tenant_id, stage_id, dry_run_outcome);

ALTER TABLE contact_addresses ADD COLUMN import_batch_id uuid;
ALTER TABLE contact_addresses ADD CONSTRAINT contact_addresses_import_batch_fk
  FOREIGN KEY (tenant_id, import_batch_id) REFERENCES import_batches (tenant_id, id);

-- R-IMPORT-2 / R-IMPORT-5: approver and verifier are the acting Owner/Admin user.
CREATE FUNCTION app.import_stage_actor_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF NEW.approved_at IS NOT NULL AND (NEW.approved_at, NEW.approved_by_user_id) IS DISTINCT FROM (OLD.approved_at, OLD.approved_by_user_id) THEN
    IF app.actor_kind() <> 'user' OR NEW.approved_by_user_id IS DISTINCT FROM app.user_id()
       OR NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.approved_by_user_id
                        AND m.status = 'active' AND m.role IN ('owner','admin')) THEN
      RAISE EXCEPTION 'IMPORT_APPROVER_INVALID: an active Owner/Admin approves as themselves' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW.verified_at IS NOT NULL AND (NEW.verified_at, NEW.verified_by_user_id) IS DISTINCT FROM (OLD.verified_at, OLD.verified_by_user_id) THEN
    IF app.actor_kind() <> 'user' OR NEW.verified_by_user_id IS DISTINCT FROM app.user_id()
       OR NOT EXISTS (SELECT 1 FROM public.memberships m WHERE m.tenant_id = NEW.tenant_id AND m.user_id = NEW.verified_by_user_id
                        AND m.status = 'active' AND m.role IN ('owner','admin')) THEN
      RAISE EXCEPTION 'IMPORT_VERIFIER_INVALID: an active Owner/Admin verifies as themselves' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER import_stage_actor_guard BEFORE UPDATE ON import_stages
  FOR EACH ROW EXECUTE FUNCTION app.import_stage_actor_guard();

CREATE FUNCTION app.import_revert_delete(p_stage_id uuid, p_table text, p_ids uuid[])
RETURNS SETOF uuid LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  v_batch uuid;
  v_status text;
  v_id uuid;
  v_n integer;
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
        UPDATE public.stored_objects o SET deleted_at = COALESCE(o.deleted_at, now())
          FROM public.recordings rc JOIN public.calls c ON c.tenant_id = rc.tenant_id AND c.id = rc.call_id
         WHERE o.tenant_id = app.tenant_id() AND rc.tenant_id = o.tenant_id AND rc.object_id = o.id
           AND c.id = v_id AND c.imported AND rc.source = 'import_fub';
        DELETE FROM public.calls t WHERE t.tenant_id = app.tenant_id() AND t.id = v_id AND t.imported
           AND EXISTS (SELECT 1 FROM public.import_records r WHERE r.tenant_id = t.tenant_id AND r.id = t.import_record_id AND r.stage_id = p_stage_id);
      ELSIF p_table = 'contact_points' THEN
        DELETE FROM public.contact_points t WHERE t.tenant_id = app.tenant_id() AND t.id = v_id AND t.import_batch_id = v_batch;
      ELSE
        DELETE FROM public.contact_addresses t WHERE t.tenant_id = app.tenant_id() AND t.id = v_id AND t.import_batch_id = v_batch;
      END IF;
      GET DIAGNOSTICS v_n = ROW_COUNT;
      IF v_n = 1 THEN RETURN NEXT v_id; END IF;
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
GRANT DELETE ON notes, messages, calls, contact_points, contact_addresses TO app_definer;
GRANT UPDATE (deleted_at) ON stored_objects TO app_definer;
