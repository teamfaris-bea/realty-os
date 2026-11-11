-- =============================================================================
-- api/import-parity (PARITY_PLAN module 65): import revert of catalog tags, and the retirement of
-- contacts.tags (R-PAR-10).
--
-- The file number is a placeholder: the orchestrator renumbers at merge (it must run after the parity schema
-- and after module 60's reader move, see below). Nothing in code or tests names it.
--
-- 1. app.import_revert_tags(batch): the import revert runs as the system actor, which may not delete catalog
--    tags (tags_delete is Owner/Admin). This definer deletes ONLY tags that (a) this batch's own bookkeeping
--    lists as created by it (import_batches.options.parityCreated.tagIds), (b) are of import origin,
--    (c) no person carries any more, and (d) no smart list names; and only for a batch of the caller's
--    tenant that is being (or has been) reverted. A tag a human has since used stays.
-- 2. contacts.tags is retired: any value written since the parity schema's backfill is backfilled again into
--    tags + contact_tags ('migrated', first spelling wins), then the column (and its GIN index) is dropped.
--    Readers and writers moved before this file (module 65 report, "readers moved"): the import commit and
--    fill (now contact_tags), the ownership engine's contact insert, the import fingerprints and existing-
--    contact index, the leads contact read (GET /contacts/:id, flagged for module 60), the load generator.
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4):
--   * new SECURITY DEFINER function app.import_revert_tags(uuid) (owner app_definer, pinned search_path,
--     EXECUTE to app_user only; refuses support and non-system, non-Owner/Admin callers);
--   * GRANT DELETE ON tags TO app_definer (for that function only).
-- =============================================================================

CREATE FUNCTION app.import_revert_tags(p_batch uuid) RETURNS integer LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, public AS $$
DECLARE t uuid := app.tenant_id(); ids uuid[]; n integer;
BEGIN
  IF t IS NULL OR app.actor_kind() = 'support'
     OR NOT (app.actor_kind() = 'system' OR app.my_role() IN ('owner','admin')) THEN
    RAISE EXCEPTION 'IMPORT_REVERT_FORBIDDEN' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT ARRAY(SELECT jsonb_array_elements_text(COALESCE(b.options #> '{parityCreated,tagIds}', '[]'::jsonb))::uuid)
    INTO ids FROM public.import_batches b
   WHERE b.tenant_id = t AND b.id = p_batch AND b.status IN ('reverting','reverted','partially_committed');
  IF ids IS NULL OR cardinality(ids) = 0 THEN RETURN 0; END IF;
  DELETE FROM public.tags g
   WHERE g.tenant_id = t AND g.id = ANY (ids) AND g.created_by_kind = 'import'
     AND NOT EXISTS (SELECT 1 FROM public.contact_tags ct WHERE ct.tenant_id = t AND ct.tag_id = g.id)
     AND NOT EXISTS (SELECT 1 FROM public.smart_lists s WHERE s.tenant_id = t AND position(g.id::text IN s.definition::text) > 0);
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
ALTER FUNCTION app.import_revert_tags(uuid) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.import_revert_tags(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.import_revert_tags(uuid) TO app_user;
GRANT SELECT ON import_batches, tags, contact_tags, smart_lists TO app_definer;
GRANT DELETE ON tags TO app_definer;

-- R-PAR-10: the last backfill (values written since the parity schema), then the column goes.
INSERT INTO tags (tenant_id, id, name, created_by_kind)
SELECT DISTINCT ON (x.tenant_id, lower(normalize(left(btrim(x.name), 64), NFKC)))
       x.tenant_id, gen_random_uuid(), btrim(left(btrim(x.name), 64)), 'import'
  FROM (SELECT c.tenant_id, unnest(c.tags) AS name, c.created_at FROM contacts c WHERE cardinality(c.tags) > 0) x
 WHERE length(btrim(x.name)) > 0 AND btrim(x.name) !~ '[[:cntrl:]]'
 ORDER BY x.tenant_id, lower(normalize(left(btrim(x.name), 64), NFKC)), x.created_at
ON CONFLICT DO NOTHING;
INSERT INTO contact_tags (tenant_id, contact_id, tag_id, added_by_kind, import_batch_id)
SELECT DISTINCT c.tenant_id, c.id, t.id, 'migrated', NULL::uuid
  FROM contacts c CROSS JOIN LATERAL unnest(c.tags) AS u(name)
  JOIN tags t ON t.tenant_id = c.tenant_id AND t.name_key = lower(normalize(btrim(left(btrim(u.name), 64)), NFKC))
 WHERE cardinality(c.tags) > 0
ON CONFLICT DO NOTHING;
ALTER TABLE contacts DROP COLUMN tags;
