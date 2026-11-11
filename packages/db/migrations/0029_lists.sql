-- 0029_lists.sql: PARITY_PLAN module 60 (api/lists). Numbered at merge (the lane wrote it as a placeholder 0025);
-- nothing in code or tests names this file.
--
-- One SECURITY DEFINER function (security review item, ARCHITECTURE §20 "api/lists security note"):
--
--   app.smart_lists_retarget_tag(p_source, p_target) -> integer
--     R-PAR-9: a tag merge "rewrites smart lists that reference the source". Personal lists are readable
--     and writable only by their owner (smart_lists RLS), so the Owner/Admin running the merge cannot
--     reach them under their own RLS. This definer rewrites, in the CALLER'S tenant only, every list
--     definition that mentions the source tag id to name the target instead, and returns the count.
--     It refuses unless the caller is a user actor whose role is owner or admin, and both ids are live
--     tags of the caller's tenant (it runs inside the merge transaction, before the source is deleted).
--     It changes only `definition` (column grant), reads and returns no list content, and cannot widen
--     any list: a tag id is replaced by another tag id of the same tenant.
--
-- No table, column, index or policy changes.

CREATE FUNCTION app.smart_lists_retarget_tag(p_source uuid, p_target uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
DECLARE
  t uuid := app.tenant_id();
  n integer;
BEGIN
  IF t IS NULL OR app.actor_kind() IS DISTINCT FROM 'user' OR app.my_role() IS NULL OR app.my_role() NOT IN ('owner','admin') THEN
    RAISE EXCEPTION 'TAG_MANAGE_REQUIRED: only an Owner or Admin merges tags' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF p_source IS NULL OR p_target IS NULL OR p_source = p_target
     OR NOT EXISTS (SELECT 1 FROM public.tags x WHERE x.tenant_id = t AND x.id = p_source)
     OR NOT EXISTS (SELECT 1 FROM public.tags x WHERE x.tenant_id = t AND x.id = p_target) THEN
    RAISE EXCEPTION 'TAG_MERGE_INVALID: both tags must exist and differ' USING ERRCODE = 'check_violation';
  END IF;
  -- uuids are stored lower-case (core lower-cases every id in a definition), and a uuid's text cannot
  -- occur inside another uuid, so a textual replace changes exactly the references to the source tag.
  UPDATE public.smart_lists s
     SET definition = replace(s.definition::text, p_source::text, p_target::text)::jsonb
   WHERE s.tenant_id = t AND strpos(s.definition::text, p_source::text) > 0;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END $$;
ALTER FUNCTION app.smart_lists_retarget_tag(uuid, uuid) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.smart_lists_retarget_tag(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.smart_lists_retarget_tag(uuid, uuid) TO app_user;
GRANT UPDATE (definition, updated_at) ON smart_lists TO app_definer;
