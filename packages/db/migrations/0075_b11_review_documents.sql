-- =============================================================================
-- 0075_b11_review_documents: batch 11 review fix for module 42 api/documents (finding ownership-data/F1;
-- R-DOC-1, R-DATA-7, R-OWN-24). Why schema and not code: the gap is in a policy.
--
-- Documents never move on a merge (DATA_MODEL R-DOC-1: a contact document stays on the record it was uploaded to),
-- and the survivor lists the documents of every record merged into it. But contacts RLS hides a merged-away record
-- (closed, no owner) from the survivor's agent and Team Lead, so before this migration:
--   * documents_select's contact branch, app.contact_detail_visible(loser), was false for them, and
--   * the listing's app.contact_merge_tree(survivor) (invoker) stopped at the survivor,
-- and the merged-away record's contact documents vanished for everyone but the Owner and Admins, the agent who
-- uploaded them included (GET /contacts/:survivor/documents empty; GET /documents/:id 404).
--
-- The change: a contact document is also visible to whoever sees the ROOT SURVIVOR of its record in detail (the
-- record the merge chain ends at). Visibility itself is still decided under the caller's RLS
-- (app.contact_detail_visible on the root, in the policy); the two new helpers only answer where a merge chain goes.
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4):
--   * new function app.contact_merge_root(uuid, uuid) RETURNS uuid: SECURITY DEFINER (owner app_definer, BYPASSRLS),
--     STABLE, pinned search_path, schema-qualified, writes nothing. Follows merged_into_contact_id up from p_contact
--     inside the CALLER's tenant (app.tenant_id(); another tenant's id returns p_contact unchanged) and returns the
--     record the chain ends at, or p_contact itself when it was never merged away, the chain is longer than 64 hops
--     or it is corrupt (a CYCLE clause stops it). Output: one id of the caller's own tenant; it reveals only which
--     record a merged-away record was merged into, never a name or a column. EXECUTE: app_user only.
--   * new function app.contact_merge_tree_ids(uuid, uuid) RETURNS uuid[]: the same properties; p_contact and every
--     record merged into it, directly or along a chain (at most 64 hops), sorted; empty for an id outside the caller's
--     tenant. The definer twin of the invoker app.contact_merge_tree (0037), which stops at what the caller sees; the
--     documents listing reads its ids and documents_select still decides each row. EXECUTE: app_user only.
--   * documents_select (0018) is replaced: the deal and listing branches are verbatim; the contact branch also admits a
--     document whose record's root survivor the caller sees in detail. Nothing else changes: documents_clean_only
--     (RESTRICTIVE: unclean only to the uploader and tenant-wide roles) still applies, documents_write and
--     documents_update are unchanged (a merged-away record takes no upload or new version: the API refuses
--     CONTACT_MERGED), and a document's object stays readable only through a clean document the caller can read
--     (0018 objects_documents). A larger set of readers only for documents of a person the reader already sees.
-- No table, column, trigger or grant on a table changes. The CMA reports (0061) have the same gap; they are not
-- changed here (module 71, platform:cma dark; recorded in ARCHITECTURE §21.35).
-- =============================================================================

CREATE FUNCTION app.contact_merge_root(p_tenant uuid, p_contact uuid) RETURNS uuid
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH RECURSIVE up(id, next, depth) AS (
    SELECT c.id, c.merged_into_contact_id, 0 FROM public.contacts c
     WHERE c.tenant_id = app.tenant_id() AND c.tenant_id = p_tenant AND c.id = p_contact
    UNION ALL
    SELECT c.id, c.merged_into_contact_id, up.depth + 1
      FROM up JOIN public.contacts c ON c.tenant_id = p_tenant AND c.id = up.next
     WHERE up.depth < 64
  ) CYCLE id SET up_cycle USING up_path
  SELECT COALESCE((SELECT up.id FROM up WHERE NOT up.up_cycle AND up.next IS NULL ORDER BY up.depth DESC LIMIT 1), p_contact)
$$;
ALTER FUNCTION app.contact_merge_root(uuid, uuid) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.contact_merge_root(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contact_merge_root(uuid, uuid) TO app_user;

CREATE FUNCTION app.contact_merge_tree_ids(p_tenant uuid, p_contact uuid) RETURNS uuid[]
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  WITH RECURSIVE tree(id, depth) AS (
    SELECT c.id, 0 FROM public.contacts c
     WHERE c.tenant_id = app.tenant_id() AND c.tenant_id = p_tenant AND c.id = p_contact
    UNION ALL
    SELECT l.id, t.depth + 1 FROM tree t
      JOIN public.contacts l ON l.tenant_id = p_tenant AND l.merged_into_contact_id = t.id
     WHERE t.depth < 64
  ) CYCLE id SET is_cycle USING path
  SELECT ARRAY(SELECT DISTINCT tree.id FROM tree WHERE NOT tree.is_cycle ORDER BY tree.id)
$$;
ALTER FUNCTION app.contact_merge_tree_ids(uuid, uuid) OWNER TO app_definer;
REVOKE ALL ON FUNCTION app.contact_merge_tree_ids(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION app.contact_merge_tree_ids(uuid, uuid) TO app_user;

-- documents_select (0018): deal and listing branches verbatim; the contact branch follows the merge to the survivor.
ALTER POLICY documents_select ON documents USING (
  (deal_id IS NOT NULL AND app.deal_visible(tenant_id, deal_id))
  OR (listing_id IS NOT NULL AND (app.listing_writable(tenant_id, listing_id)
       OR EXISTS (SELECT 1 FROM deals d WHERE d.tenant_id = documents.tenant_id AND d.listing_id = documents.listing_id
                    AND d.side IN ('sell','dual'))))
  OR (contact_id IS NOT NULL AND (app.contact_detail_visible(tenant_id, contact_id)
       OR app.contact_detail_visible(tenant_id, app.contact_merge_root(tenant_id, contact_id)))));

-- Self-check: both helpers are definers owned by app_definer with a pinned search_path, EXECUTE only for app_user.
DO $$
DECLARE bad text := '';
  r record;
BEGIN
  FOR r IN SELECT p.oid::regprocedure::text AS fn, p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig
             FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
            WHERE n.nspname = 'app' AND p.proname IN ('contact_merge_root', 'contact_merge_tree_ids') LOOP
    IF NOT r.prosecdef OR r.owner <> 'app_definer'
       OR NOT EXISTS (SELECT 1 FROM unnest(r.proconfig) cfg WHERE cfg LIKE 'search_path=%')
       OR has_function_privilege('public', r.fn, 'EXECUTE')
       OR NOT has_function_privilege('app_user', r.fn, 'EXECUTE') THEN
      bad := bad || ' ' || r.fn;
    END IF;
  END LOOP;
  IF bad <> '' THEN RAISE EXCEPTION '0075 self-check failed:%', bad; END IF;
END $$;
