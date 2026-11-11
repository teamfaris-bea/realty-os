-- =============================================================================
-- Lane perf-misses-2: the RLS helpers keep their query plans, and the Owner's tag / custom-value reads
-- skip the per-row detail check they always pass. The file number is a placeholder: the orchestrator
-- renumbers at merge. Nothing in code or tests names it.
--
-- 1. Twelve RLS helpers move from LANGUAGE sql to LANGUAGE plpgsql with the SAME query, word for word.
--
--    Why. None of them is inlined (eight are SECURITY DEFINER with a SET clause; the four invokers have an
--    EXISTS sublink in their body, which inline_function refuses). A non-inlined SQL function's body is
--    parsed and planned again in every statement that calls it (its plan lives only for the calling
--    query). Each policy InitPlan (SELECT app.is_member()) therefore re-plans the helper and, inside it,
--    every helper it calls. Measured at 250k (pg_stat_statements, track = all, one tap at a time): an accept
--    ran app.is_member() 19 times at 0.19 ms, app.is_tenant_wide() 12 times, app.my_role() 47 times;
--    a claim app.my_pond_ids() 7 times at 0.36 ms and app.contact_visible() at 0.4-1.0 ms. A PL/pgSQL
--    function keeps the plans of its statements for the session (the plan cache), so a call costs only
--    the execution. Execution per tap: accept 23 -> 11 ms, claim 27 -> 13 ms (docs/PERFORMANCE.md).
--
--    Why the result is identical.
--      * Each body is the previous SQL body unchanged, as RETURN (<body>). Every body returns exactly one
--        row (an EXISTS, an aggregate, a boolean expression) except my_role, which reads at most one row
--        (memberships' primary key is (tenant_id, user_id)); a scalar sub-query of zero rows is NULL,
--        exactly what a SQL function returns for no row.
--      * Same signature, return type, volatility (STABLE: the caller's snapshot, no new one per call), same
--        SECURITY DEFINER / INVOKER, same pinned search_path; CREATE OR REPLACE keeps the owner
--        (app_definer or app_owner), the ACL (EXECUTE revoked from PUBLIC where it was) and the comments.
--      * The request context is read at EXECUTION time, never at plan time: every GUC is read by a function
--        call inside the query (app.tenant_id(), app.user_id(), app.actor_kind(), app.principal_type()),
--        and plpgsql passes the function's arguments as parameters. A cached plan is therefore valid for any
--        tenant, user or actor; it holds no data. Postgres re-plans a cached plan when the role, the
--        row_security setting or a referenced object changes (plancache), so a cached invoker plan is never
--        reused with another role's policies.
--      * Proof: apps/api/src/load/helper_plan_equivalence.test.ts calls every helper under every request
--        context (each role, the system actor, support with and without a grant, a client principal, a
--        caller moving a contact in its ownership command), interleaved on ONE connection past the plan
--        cache's switch to generic plans, and compares each result with the previous SQL body run as a
--        temporary SQL function in the same transaction; the rls / deal-visibility / search equivalence
--        tests still pass unchanged.
--
-- 2. contact_tags_select and contact_field_values_select (SELECT only) gain a leading
--    (SELECT app.is_tenant_wide()) OR ... .
--
--    Why. The Owner's smart-list counts over a broad tag or custom value read every matching row of the
--    tenant, and each row paid the EXISTS over app.contact_detail_row (a contacts probe under RLS); value
--    comparisons (numeric, arrays, EXTRACT, LIKE) are not leakproof, so they cannot run before the policy.
--    The parity lane measured this exact form on a scratch database (docs/PERFORMANCE.md, Smart lists).
--
--    Why the rows are identical. For a tenant-wide caller (app.is_tenant_wide(): the system actor, an
--    Owner or Admin, support with a live grant; staff principal, tenant set), the old USING is true for
--    every row of the table that the tenant policy admits:
--      * the RESTRICTIVE tenant_isolation policy admits only rows with tenant_id = app.tenant_id();
--      * each row's (tenant_id, contact_id) references contacts (tenant_id, id) (FOREIGN KEY, ON DELETE
--        CASCADE, not deferrable), so the contact row exists in the same tenant and the same snapshot;
--      * that contact passes contacts_select through its (SELECT app.is_tenant_wide()) branch (no
--        deleted_at condition) and the tenant policy; and contact_detail_row's detail test passes through
--        (SELECT app.sees_all_detail()) = is_tenant_wide() OR team_lead, which is true.
--    So EXISTS (... contact_detail_row ...) is true exactly when is_tenant_wide() is, row by row; for every
--    other caller the new OR's first operand is false and the policy is the old one. Proof:
--    apps/api/src/load/deal_visibility_equivalence.test.ts (old and new USING, row by row, every context
--    named above, parity rows on pond / offered / deleted / merged / deal contacts and in another tenant).
--    WITH CHECK, INSERT, UPDATE and DELETE policies are unchanged.
--
-- 3. Two indexes for smart lists: the name sort, and value-driven counts (no policy or visibility change).
--
-- No LEAKPROOF, no BYPASSRLS, no USING (true), no new definer, no grant change.
-- =============================================================================

-- ---- 1. helpers: same query, PL/pgSQL --------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app.my_role() RETURNS text
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN (
  SELECT m.role FROM public.memberships m
   WHERE m.tenant_id = app.tenant_id() AND m.user_id = app.user_id()
     AND m.status = 'active' AND app.actor_kind() = 'user'
     AND app.principal_type() = 'staff');
END $$;

CREATE OR REPLACE FUNCTION app.is_tenant_wide() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN (
  SELECT COALESCE(
    app.principal_type() = 'staff' AND app.tenant_id() IS NOT NULL AND (
         app.actor_kind() = 'system'
      OR app.my_role() IN ('owner','admin')
      OR (app.actor_kind() = 'support' AND EXISTS (
            SELECT 1 FROM public.support_access_grants g
             WHERE g.tenant_id = app.tenant_id() AND g.support_user_id = app.user_id()
               AND g.revoked_at IS NULL AND g.expires_at > now()))),
    false));
END $$;

CREATE OR REPLACE FUNCTION app.is_member() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN (
  SELECT app.my_role() IS NOT NULL OR app.is_tenant_wide());
END $$;

CREATE OR REPLACE FUNCTION app.sees_all_detail() RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN (
  SELECT app.is_tenant_wide() OR COALESCE(app.my_role() = 'team_lead', false));
END $$;

CREATE OR REPLACE FUNCTION app.my_team_member_ids() RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN (
  SELECT COALESCE(array_agg(DISTINCT tm.user_id), '{}')
    FROM public.team_members lead
    JOIN public.team_members tm ON tm.tenant_id = lead.tenant_id AND tm.team_id = lead.team_id
   WHERE lead.tenant_id = app.tenant_id() AND lead.user_id = app.user_id() AND lead.is_lead
     AND app.my_role() = 'team_lead');
END $$;

CREATE OR REPLACE FUNCTION app.my_pond_ids() RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN (
  SELECT COALESCE(array_agg(p.id), '{}') FROM public.ponds p
   WHERE p.tenant_id = app.tenant_id() AND p.archived_at IS NULL
     AND app.my_role() = ANY (p.eligible_roles)
     AND (p.open_to_all OR EXISTS (SELECT 1 FROM public.pond_members pm
           WHERE pm.tenant_id = p.tenant_id AND pm.pond_id = p.id AND pm.user_id = app.user_id())));
END $$;

CREATE OR REPLACE FUNCTION app.my_deal_contact_ids() RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN (
  SELECT COALESCE(array_agg(DISTINCT x.contact_id), '{}') FROM (
    SELECT dc.contact_id FROM public.deal_contacts dc
      JOIN public.deal_members dm ON dm.tenant_id = dc.tenant_id AND dm.deal_id = dc.deal_id
     WHERE dc.tenant_id = app.tenant_id() AND dm.user_id = app.user_id()
    UNION ALL
    SELECT d.primary_contact_id FROM public.deals d
      JOIN public.deal_members dm ON dm.tenant_id = d.tenant_id AND dm.deal_id = d.id
     WHERE d.tenant_id = app.tenant_id() AND dm.user_id = app.user_id()) x
   WHERE app.my_role() IS NOT NULL);
END $$;

CREATE OR REPLACE FUNCTION app.my_collab_contact_ids() RETURNS uuid[]
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN (
  SELECT COALESCE(array_agg(k.contact_id), '{}') FROM public.contact_collaborators k
   WHERE k.tenant_id = app.tenant_id() AND k.user_id = app.user_id()
     AND k.removed_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now())
     AND app.my_role() IS NOT NULL);
END $$;

CREATE OR REPLACE FUNCTION app.contact_exists(p_tenant uuid, p_contact uuid) RETURNS boolean
LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  RETURN (
  SELECT EXISTS (SELECT 1 FROM public.contacts c
                  WHERE c.tenant_id = p_tenant AND c.id = p_contact AND p_tenant = app.tenant_id()));
END $$;

-- the four invokers (no SET clause, as before: they run as the caller, under the caller's RLS)
CREATE OR REPLACE FUNCTION app.contact_visible(p_tenant uuid, p_contact uuid) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN (
  SELECT EXISTS (SELECT 1 FROM public.contacts c WHERE c.tenant_id = p_tenant AND c.id = p_contact));
END $$;

CREATE OR REPLACE FUNCTION app.contact_detail_visible(p_tenant uuid, p_contact uuid) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN (
  SELECT EXISTS (
    SELECT 1 FROM public.contacts c
     WHERE c.tenant_id = p_tenant AND c.id = p_contact
       AND (c.ownership_state NOT IN ('in_pond','offered')
            OR app.sees_all_detail()
            OR c.id = ANY (app.my_collab_contact_ids())
            OR c.id = ANY (app.my_deal_contact_ids()))));
END $$;

CREATE OR REPLACE FUNCTION app.deal_visible(p_tenant uuid, p_deal uuid) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN (
  SELECT EXISTS (SELECT 1 FROM public.deals d WHERE d.tenant_id = p_tenant AND d.id = p_deal));
END $$;

CREATE OR REPLACE FUNCTION app.contact_owned_by_my_team(p_tenant uuid, p_contact uuid) RETURNS boolean
LANGUAGE plpgsql STABLE AS $$
BEGIN
  RETURN (
  SELECT EXISTS (SELECT 1 FROM public.contacts c
                  WHERE c.tenant_id = p_tenant AND c.id = p_contact
                    AND c.owner_user_id = ANY (app.my_team_member_ids())));
END $$;

-- ---- 2. tag and custom-value SELECT: tenant-wide callers first --------------------------------------------

ALTER POLICY contact_tags_select ON public.contact_tags USING (
  (SELECT app.is_tenant_wide())
  OR EXISTS (SELECT 1 FROM app.contact_detail_row(contact_tags.tenant_id, contact_tags.contact_id)));
ALTER POLICY contact_field_values_select ON public.contact_field_values USING (
  (SELECT app.is_tenant_wide())
  OR EXISTS (SELECT 1 FROM app.contact_detail_row(contact_field_values.tenant_id, contact_field_values.contact_id)));

-- ---- 3. smart lists sorted by name (R-PAR-29) -------------------------------------------------------------
-- The "name A-Z" sort (lists/repos/people.ts: ORDER BY lower(display_name), id) had no index: an Owner's first
-- page sorted every live person of the tenant (564 ms p95 at 250k). Same partial predicate as 0021's list indexes.
CREATE INDEX contacts_list_name_idx ON contacts (tenant_id, lower(display_name), id)
  WHERE deleted_at IS NULL AND merged_into_contact_id IS NULL;
-- Value-driven counts (lists/repos/people.ts driverRows) read one field's values for the tenant and intersect
-- the people of several fields: (field, person) order with the compared columns, so a field's rows are read from
-- the index (index-only once vacuumed) instead of a bitmap over the primary key (features + timeline: 888 -> 619 ms
-- p95 at 250k). value_text is left out (long values; text conditions keep contact_field_values_text_idx).
CREATE INDEX contact_field_values_field_contact_idx ON contact_field_values (tenant_id, field_id, contact_id)
  INCLUDE (value_options, value_number, value_date);

-- ---- self-checks -------------------------------------------------------------------------------------------
DO $$
DECLARE bad text := '';
BEGIN
  -- 1. the twelve helpers: plpgsql, STABLE, definer exactly where they were, search_path pinned on the definers,
  --    owners and PUBLIC EXECUTE as before (owner app_definer for the definers; no PUBLIC EXECUTE on them)
  SELECT string_agg(p.proname, ',') INTO bad
    FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'app'
     AND p.proname IN ('my_role','is_tenant_wide','is_member','sees_all_detail','my_team_member_ids','my_pond_ids',
                       'my_deal_contact_ids','my_collab_contact_ids','contact_exists','contact_visible',
                       'contact_detail_visible','deal_visible','contact_owned_by_my_team')
     AND (p.prolang <> (SELECT oid FROM pg_language WHERE lanname = 'plpgsql') OR p.provolatile <> 's'
          OR p.prosecdef <> (p.proname IN ('my_role','is_tenant_wide','is_member','sees_all_detail','my_team_member_ids',
                                           'my_pond_ids','my_deal_contact_ids','my_collab_contact_ids','contact_exists'))
          OR (p.prosecdef AND (p.proconfig IS DISTINCT FROM ARRAY['search_path=pg_catalog, public']
                               OR pg_get_userbyid(p.proowner) <> 'app_definer'
                               OR has_function_privilege('public', p.oid, 'EXECUTE')))
          OR (NOT p.prosecdef AND p.proconfig IS NOT NULL));
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0038 self-check: helpers not as expected: %', bad; END IF;
  -- 2. contact_detail_row is still inlined (it must stay invoker without SET: unchanged here)
  IF (SELECT prolang FROM pg_proc WHERE oid = 'app.contact_detail_row(uuid,uuid)'::regprocedure) <> (SELECT oid FROM pg_language WHERE lanname = 'sql') THEN
    RAISE EXCEPTION '0038 self-check: contact_detail_row must stay LANGUAGE sql';
  END IF;
  -- 3. the two SELECT policies; their write policies untouched (no tenant-wide shortcut there)
  SELECT string_agg(x.tablename || '.' || x.policyname, ',') INTO bad
    FROM pg_policies x
   WHERE x.schemaname = 'public' AND x.tablename IN ('contact_tags','contact_field_values')
     AND ((x.cmd = 'SELECT' AND x.policyname LIKE '%_select'
           AND NOT (x.qual LIKE '(( SELECT app.is_tenant_wide() AS is_tenant_wide) OR (EXISTS%app.contact_detail_row(%'
                    AND x.qual NOT LIKE '%contact_detail_visible%'))
          OR (x.cmd IN ('INSERT','UPDATE','DELETE') AND COALESCE(x.qual, '') || COALESCE(x.with_check, '') LIKE '%contact_detail_row%'));
  IF bad IS NOT NULL THEN RAISE EXCEPTION '0038 self-check: policies not as expected: %', bad; END IF;
END $$;
