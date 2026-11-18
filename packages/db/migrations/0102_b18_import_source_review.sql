-- Batch 18, owner decision 2026-11-14 on imported sources, the review half (DATA_MODEL R-LSRC-10, E738 to E746).
-- Security notes: docs/ARCHITECTURE.md §21.69.
--
--   The owner decided that every import shows a source review, that the raw label is kept exactly as imported with its
--   provenance (which import, which kind, when first seen, how many people), and that who mapped a label, and when, is
--   recorded. 0099 and 0101 hold the mapping itself (lead_sources.import_labels and import_unlabeled_batches, which the
--   definers of 0101 read: the enforcement is unchanged here). This migration adds the review list's own record.
--
--   * import_source_labels: one row per imported source label per team, and one row per import's no-label group.
--       import_label         the label EXACTLY as imported (core sourceLabel: never trimmed, re-cased or cut); NULL on a
--                            no-label group's row
--       unlabeled_batch_id   the import whose people with no source label this row is; NULL on a label's row
--       first_seen_batch_id, first_seen_kind, first_seen_at
--                            the import that first COMMITTED a person with it (imported or merged), its kind (the
--                            batch's source) and when. NULL while the Owner has mapped a label ahead of any commit. A dry
--                            run writes nothing here: only the contacts commit does (apps/api imports/commit.ts), in
--                            its own chunk's transaction.
--       lead_source_id, mapped_by_user_id, mapped_at
--                            the Owner's last word on it: the source it was mapped to (NULL: the mapping was removed),
--                            who did that and when. A record of the act, for the list and beside the audit row; the
--                            mapping every check reads stays lead_sources.import_labels / import_unlabeled_batches.
--     FORCE row-level security, the restrictive tenant policy, the three support read-only policies and the statement
--     trigger. Read and written only by the tenant-wide (Owner, Admin, system), as import_records is; no DELETE grant.
--     The label is a lead-source name from another system, not a field of a person; a people count is never stored
--     (it is counted from the committed import records when the list is read, so it cannot go stale).
--   * app.import_source_labels_guard (invoker trigger, search_path pinned): the label and the no-label import of a row
--     never change; first-seen is written once, by the system only (the import's commit); the mapping columns are
--     written by the Owner only, as themselves, and name that Owner (nobody can record a mapping in another's name).
--     For a missing or foreign tenant context it returns, as every source guard does: row-level security refuses the
--     row, and no new error is raised.
--   * Existing data: one row is written for every label, and every import's no-label group, that a COMMITTED contacts
--     record already carries (first seen: that record's import). No other table is read for it and nothing else is
--     changed: no plan, message, draft, AI care, import or lead-source row. A label the Owner mapped under 0099 or 0101
--     keeps its mapping (the arrays are untouched); who mapped it was not recorded then, so the row leaves that blank.
--   No SECURITY DEFINER function is added or replaced.

CREATE TABLE import_source_labels (
  tenant_id           uuid NOT NULL REFERENCES tenants(id),
  id                  uuid NOT NULL DEFAULT gen_random_uuid(),
  import_label        text CHECK (import_label <> ''),
  unlabeled_batch_id  uuid,
  first_seen_batch_id uuid,
  first_seen_kind     text CHECK (first_seen_kind IN ('csv','fub_api','fub_export')),
  first_seen_at       timestamptz,
  lead_source_id      uuid,
  mapped_by_user_id   uuid,
  mapped_at           timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, unlabeled_batch_id)  REFERENCES import_batches (tenant_id, id),
  FOREIGN KEY (tenant_id, first_seen_batch_id) REFERENCES import_batches (tenant_id, id),
  FOREIGN KEY (tenant_id, lead_source_id)      REFERENCES lead_sources (tenant_id, id),
  FOREIGN KEY (tenant_id, mapped_by_user_id)   REFERENCES memberships (tenant_id, user_id),
  -- a label's row or a no-label group's row, never both and never neither
  CHECK ((import_label IS NULL) <> (unlabeled_batch_id IS NULL)),
  CHECK ((first_seen_batch_id IS NULL) = (first_seen_at IS NULL) AND (first_seen_batch_id IS NULL) = (first_seen_kind IS NULL)),
  CHECK ((mapped_by_user_id IS NULL) = (mapped_at IS NULL)),
  CHECK (lead_source_id IS NULL OR mapped_at IS NOT NULL)
);
COMMENT ON TABLE import_source_labels IS
  'b18 owner decision 2026-11-14 (R-LSRC-10): the source review list. One row per imported source label per team (import_label, exactly as imported) and one per import''s no-label group (unlabeled_batch_id), with where it was first committed and the Owner''s last mapping of it (who, when). The mapping every check reads is lead_sources.import_labels / import_unlabeled_batches.';
-- one row per label per team: by digest, so a label of any length fits the index and is compared whole
CREATE UNIQUE INDEX import_source_labels_label ON import_source_labels (tenant_id, digest(import_label, 'sha256')) WHERE import_label IS NOT NULL;
CREATE UNIQUE INDEX import_source_labels_unlabeled ON import_source_labels (tenant_id, unlabeled_batch_id) WHERE unlabeled_batch_id IS NOT NULL;

ALTER TABLE import_source_labels ENABLE ROW LEVEL SECURITY;
ALTER TABLE import_source_labels FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON import_source_labels AS RESTRICTIVE FOR ALL
  USING (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff')
  WITH CHECK (tenant_id = (SELECT app.tenant_id()) AND (SELECT app.principal_type()) = 'staff');
CREATE POLICY support_read_only_ins ON import_source_labels AS RESTRICTIVE FOR INSERT WITH CHECK ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_upd ON import_source_labels AS RESTRICTIVE FOR UPDATE USING ((SELECT app.actor_kind()) <> 'support');
CREATE POLICY support_read_only_del ON import_source_labels AS RESTRICTIVE FOR DELETE USING ((SELECT app.actor_kind()) <> 'support');
CREATE TRIGGER support_read_only BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON import_source_labels FOR EACH STATEMENT EXECUTE FUNCTION app.reject_support_write();
-- Owner, Admin and the system only, as import_batches, import_stages and import_records (0001 layer 2 b)
CREATE POLICY admin_all ON import_source_labels FOR ALL USING ((SELECT app.is_tenant_wide())) WITH CHECK ((SELECT app.is_tenant_wide()));
GRANT SELECT, INSERT, UPDATE ON import_source_labels TO app_user;

CREATE FUNCTION app.import_source_labels_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE mapping_changed boolean; seen_changed boolean;
BEGIN
  IF app.tenant_id() IS DISTINCT FROM NEW.tenant_id THEN RETURN NEW; END IF;   -- RLS refuses another tenant's row, and a missing context
  IF TG_OP = 'UPDATE' THEN
    IF NEW.id IS DISTINCT FROM OLD.id OR NEW.import_label IS DISTINCT FROM OLD.import_label OR NEW.unlabeled_batch_id IS DISTINCT FROM OLD.unlabeled_batch_id THEN
      RAISE EXCEPTION 'IMPORT_SOURCE_LABEL_IMMUTABLE: an imported source label is kept exactly as imported' USING ERRCODE = 'check_violation';
    END IF;
    IF OLD.first_seen_batch_id IS NOT NULL AND (NEW.first_seen_batch_id, NEW.first_seen_kind, NEW.first_seen_at) IS DISTINCT FROM (OLD.first_seen_batch_id, OLD.first_seen_kind, OLD.first_seen_at) THEN
      RAISE EXCEPTION 'IMPORT_SOURCE_LABEL_IMMUTABLE: where a label was first seen is written once' USING ERRCODE = 'check_violation';
    END IF;
    seen_changed := NEW.first_seen_batch_id IS DISTINCT FROM OLD.first_seen_batch_id;
    mapping_changed := (NEW.lead_source_id, NEW.mapped_by_user_id, NEW.mapped_at) IS DISTINCT FROM (OLD.lead_source_id, OLD.mapped_by_user_id, OLD.mapped_at);
  ELSE
    seen_changed := NEW.first_seen_batch_id IS NOT NULL;
    mapping_changed := NEW.lead_source_id IS NOT NULL OR NEW.mapped_by_user_id IS NOT NULL OR NEW.mapped_at IS NOT NULL;
  END IF;
  -- first seen: only the system (the import's own commit) says which import committed a label first
  IF seen_changed AND app.actor_kind() IS DISTINCT FROM 'system' THEN
    RAISE EXCEPTION 'IMPORT_SOURCE_LABEL_SEEN_SYSTEM_ONLY: only an import''s commit records where a label was first seen' USING ERRCODE = 'insufficient_privilege';
  END IF;
  -- the mapping record: the Owner only, as themselves, in their own name
  IF mapping_changed AND NOT COALESCE(app.actor_kind() = 'user' AND app.my_role() = 'owner' AND NEW.mapped_by_user_id = app.user_id() AND NEW.mapped_at IS NOT NULL, false) THEN
    RAISE EXCEPTION 'LEAD_SOURCE_IMPORT_LABELS_OWNER_ONLY: only the Owner maps an imported source label to a lead source' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION app.import_source_labels_guard() FROM PUBLIC;
CREATE TRIGGER import_source_labels_guard BEFORE INSERT OR UPDATE ON import_source_labels
  FOR EACH ROW EXECUTE FUNCTION app.import_source_labels_guard();

-- Existing data: the labels and no-label groups that committed contacts records already carry, each with the import of
-- its earliest such record. One pass over import_records; nothing else is read or changed.
INSERT INTO import_source_labels (tenant_id, import_label, first_seen_batch_id, first_seen_kind, first_seen_at)
SELECT DISTINCT ON (r.tenant_id, r.normalized ->> 'leadSourceLabel')
       r.tenant_id, r.normalized ->> 'leadSourceLabel', st.batch_id, b.source, r.updated_at
  FROM import_records r
  JOIN import_stages st ON st.tenant_id = r.tenant_id AND st.id = r.stage_id
  JOIN import_batches b ON b.tenant_id = st.tenant_id AND b.id = st.batch_id
 WHERE r.target_table = 'contacts' AND r.outcome IN ('imported', 'merged') AND (r.normalized ->> 'category') = 'contacts'
   AND btrim(COALESCE(r.normalized ->> 'leadSourceLabel', '')) <> ''
 ORDER BY r.tenant_id, r.normalized ->> 'leadSourceLabel', r.updated_at, r.id;
INSERT INTO import_source_labels (tenant_id, unlabeled_batch_id, first_seen_batch_id, first_seen_kind, first_seen_at)
SELECT r.tenant_id, st.batch_id, st.batch_id, b.source, min(r.updated_at)
  FROM import_records r
  JOIN import_stages st ON st.tenant_id = r.tenant_id AND st.id = r.stage_id
  JOIN import_batches b ON b.tenant_id = st.tenant_id AND b.id = st.batch_id
 WHERE r.target_table = 'contacts' AND r.outcome IN ('imported', 'merged') AND (r.normalized ->> 'category') = 'contacts'
   AND btrim(COALESCE(r.normalized ->> 'leadSourceLabel', '')) = ''
 GROUP BY r.tenant_id, st.batch_id, b.source;

-- Self-check: the table forces row-level security with the restrictive tenant policy, the support read-only trigger and
-- policies; app_user cannot delete from it; the guard is an invoker that pins its path and sits on its trigger; every
-- committed label and no-label group has its row.
DO $$
DECLARE p record;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid = 'public.import_source_labels'::regclass AND c.relrowsecurity AND c.relforcerowsecurity) THEN
    RAISE EXCEPTION '0102: import_source_labels must force row-level security';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'public.import_source_labels'::regclass AND polname = 'tenant_isolation' AND NOT polpermissive) THEN
    RAISE EXCEPTION '0102: import_source_labels needs the restrictive tenant policy';
  END IF;
  IF (SELECT count(*) FROM pg_policy WHERE polrelid = 'public.import_source_labels'::regclass AND polname LIKE 'support_read_only_%' AND NOT polpermissive) <> 3
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.import_source_labels'::regclass AND tgname = 'support_read_only' AND tgenabled <> 'D') THEN
    RAISE EXCEPTION '0102: import_source_labels needs the support read-only policies and trigger';
  END IF;
  IF has_table_privilege('app_user', 'public.import_source_labels', 'DELETE') OR has_table_privilege('app_user', 'public.import_source_labels', 'TRUNCATE') THEN
    RAISE EXCEPTION '0102: app_user must not delete import_source_labels rows';
  END IF;
  SELECT prosecdef AS definer, proconfig AS config INTO p FROM pg_proc WHERE oid = 'app.import_source_labels_guard()'::regprocedure;
  IF p.definer OR NOT ('search_path=pg_catalog, public' = ANY (p.config)) THEN RAISE EXCEPTION '0102: app.import_source_labels_guard must be an invoker that pins its search_path'; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgfoid = 'app.import_source_labels_guard()'::regprocedure AND NOT t.tgisinternal) THEN
    RAISE EXCEPTION '0102: app.import_source_labels_guard must be on its trigger';
  END IF;
  IF EXISTS (SELECT 1 FROM import_records r
              WHERE r.target_table = 'contacts' AND r.outcome IN ('imported', 'merged') AND (r.normalized ->> 'category') = 'contacts'
                AND btrim(COALESCE(r.normalized ->> 'leadSourceLabel', '')) <> ''
                AND NOT EXISTS (SELECT 1 FROM import_source_labels l WHERE l.tenant_id = r.tenant_id AND l.import_label = (r.normalized ->> 'leadSourceLabel'))) THEN
    RAISE EXCEPTION '0102: a committed label has no review row';
  END IF;
END $$;
