-- =============================================================================
-- 0077_b11_review_documents_cma: batch 11 review fix for module 71 api/cma, the CMA half of finding ownership-data/F1
-- (R-CMA-6, R-CMA-8, R-DATA-7, R-OWN-24). Why schema and not code: the gap is in a policy.
--
-- A merge moves no CMA (R-CMA-8: a CMA stays on the record it was made for), and the survivor lists the CMAs of every
-- record merged into it. But contacts RLS hides a merged-away record (closed, no owner) from the survivor's agent and
-- Team Lead, so before this migration cma_reports_select's contact branch, app.contact_detail_row(loser), was empty for
-- them and only tenant-wide roles and the CMA's creator (created_by_user_id) still read it: the survivor's Team Lead,
-- and an agent who now owns the survivor but did not make the CMA, lost the person's CMAs (GET /contacts/:survivor/cmas
-- empty; GET /cma/:id 404). The same gap 0075 closed for contact documents (ARCHITECTURE §21.35).
--
-- The change: a CMA on a contact is also visible to whoever sees the ROOT SURVIVOR of its record in detail (the record
-- the merge chain ends at, 0075's app.contact_merge_root). Visibility is still decided under the caller's RLS, through
-- the same inlinable app.contact_detail_row (0031) the branch already used; the helper only answers where a merge chain
-- goes. For a record that was never merged the root is the record itself, so the new branch admits nothing new.
--
-- SECURITY REVIEW ITEMS (CONVENTIONS §4):
--   * No new function, table, column, trigger or grant. app.contact_merge_root (0075; SECURITY DEFINER, owner
--     app_definer, pinned search_path, EXECUTE app_user only) is reused unchanged; it reads contacts only, never
--     cma_reports (rls_smoke_cma.sql still proves no definer names cma_reports or platform:cma).
--   * cma_reports_select (0061) is replaced with ALTER POLICY: the tenant-wide and creator branches are verbatim; the
--     contact branch also admits a CMA whose record's root survivor the caller sees in detail. Nothing else changes:
--     cma_reports_insert still needs the contact's own detail (a merged-away record takes no new CMA), cma_reports_update
--     stays the creator or a tenant-wide role, the RESTRICTIVE tenant/staff and support policies are unchanged, and
--     the cma_reports_guard trigger is untouched. A larger set of readers only for CMAs of a person the reader already
--     sees, as for documents (0075).
--   * platform:cma stays dark; nothing here clears it or shares a CMA with a client.
-- =============================================================================

ALTER POLICY cma_reports_select ON cma_reports USING (
  (SELECT app.is_tenant_wide())
  OR (created_by_user_id = (SELECT app.user_id()) AND (SELECT app.my_role()) IS NOT NULL)
  OR (contact_id IS NOT NULL AND (
        EXISTS (SELECT 1 FROM app.contact_detail_row(cma_reports.tenant_id, cma_reports.contact_id))
     OR EXISTS (SELECT 1 FROM app.contact_detail_row(cma_reports.tenant_id, app.contact_merge_root(cma_reports.tenant_id, cma_reports.contact_id))))));

-- Self-check: the policy has the root-survivor branch, keeps the creator branch, and no definer names cma_reports.
DO $$
DECLARE q text;
BEGIN
  SELECT pg_get_expr(p.polqual, p.polrelid) INTO q FROM pg_policy p
   WHERE p.polrelid = 'public.cma_reports'::regclass AND p.polname = 'cma_reports_select';
  IF q IS NULL OR q NOT LIKE '%contact_merge_root%' OR q NOT LIKE '%created_by_user_id%' OR q LIKE '%contact_detail_visible%' THEN
    RAISE EXCEPTION '0077 self-check failed: cma_reports_select is %', q;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
              WHERE n.nspname IN ('app','auth','portal','public') AND p.prosecdef AND p.prosrc ~* 'cma_reports|platform:cma') THEN
    RAISE EXCEPTION '0077 self-check failed: a SECURITY DEFINER function names cma_reports or platform:cma';
  END IF;
END $$;
